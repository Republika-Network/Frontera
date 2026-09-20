import {
  EmergencyControlWithheldError,
  emergencyControlPermits,
  readEmergencyControl,
  type EmergencyControlQuery,
  type EmergencyControlReaderPort,
} from '../../emergency-control-runtime/index.js';
import {
  EXECUTION_FAILURE_REASONS,
  type ExecutionAdapter,
  type ExecutionAdapterResult,
  type ValidatedExecutionAction,
} from '../domain/index.js';

/**
 * Server-side execution adapter routing — a **composite** `ExecutionAdapter`
 * that resolves which trusted provider adapter translates an already-authorized
 * action, and invokes exactly that one.
 *
 * ```
 * GrantExecutionService
 *   -> registry.execute(ValidatedExecutionAction)     the port, satisfied by the registry itself
 *   -> selectAdapter(action)                          trusted host routing, synchronous
 *   -> emergency-control check, with the selected adapterId
 *   -> exactly one registered child adapter
 *   -> provider
 * ```
 *
 * ## The caller never chooses
 *
 * There is no `adapterId`, `provider`, `destination`, `url`, `host`,
 * `endpoint`, `credential` or provider body on `GovernedActionIntent`, on
 * `KernelEvaluationRequest`, on `GrantExerciseRequest` or on
 * `ValidatedExecutionAction`, and this module deliberately did not add one.
 * Routing is decided by host configuration from fields that were **already
 * proven inside a bound** — action, resource, organization, subject,
 * counterparty, amount. A caller can therefore influence *which* provider runs
 * only by asking for a different action or resource, which is the same material
 * the Kernel decided on and the grant contained.
 *
 * ## Routing is not authorization
 *
 * The registry chooses **where** an already-authorized action is translated. It
 * never chooses **whether** it is authorized: there is no policy, no decision,
 * no grant, no store and no Kernel anywhere below, and the only input is the
 * validated action the exercise gate built. A routing failure is therefore an
 * infrastructure failure and is reported as one — never as a denial.
 *
 * ## It is a composite provider boundary, not a second gate
 *
 * `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §7.1 enumerates every holder of
 * the `ExecutionAdapter` port, and this is one: the child invocation below is
 * the second such call site in the repository, and it is reachable only from
 * `GrantExecutionService.exercise`, after the authoritative grant read and the
 * usable-assessment gate. `no-bypass-effect-paths.test.ts` pins both call sites
 * and pins that ordering.
 */

/**
 * Trusted host routing. **Synchronous**, so routing cannot introduce a network
 * hop, a cache with its own staleness, or an `await` between the assessment and
 * the provider call.
 *
 * It sees the validated action and nothing else: no caller object, no
 * credential, no grant, no Kernel result. It returns at most one adapter
 * identity, or `undefined` for "no route".
 */
export type ExecutionAdapterSelector = (action: ValidatedExecutionAction) => string | undefined;

export interface ExecutionAdapterRegistryOptions {
  /** The composite's own identity, reported on outcomes. Never a child's id. */
  readonly adapterId?: string;
  /** The trusted provider adapters this deployment composed. Frozen at construction; membership never changes afterwards. */
  readonly adapters: readonly ExecutionAdapter[];
  readonly selectAdapter: ExecutionAdapterSelector;
  /**
   * The operational interlock, when the deployment composed one.
   *
   * Consulted **after** routing resolves a child and **before** that child is
   * invoked, because the adapter-scoped control cannot be evaluated until the
   * adapter is known. Omitted, adapter-scoped stops are simply not enforced —
   * the same posture every other optional capability takes, stated rather than
   * implied.
   */
  readonly emergencyControl?: EmergencyControlReaderPort;
}

/** A composition defect: the registry could not be built as described. Thrown at construction, never mid-traffic. */
export type ExecutionAdapterRegistryErrorCode =
  | 'EXECUTION_ADAPTER_REGISTRY_EMPTY'
  | 'EXECUTION_ADAPTER_MALFORMED'
  | 'EXECUTION_ADAPTER_ID_DUPLICATE'
  | 'EXECUTION_ADAPTER_REGISTRY_RECURSIVE'
  | 'EXECUTION_ADAPTER_SELECTOR_INVALID';

export class ExecutionAdapterRegistryError extends Error {
  constructor(
    readonly code: ExecutionAdapterRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionAdapterRegistryError';
  }
}

export function isExecutionAdapterRegistryError(error: unknown): error is ExecutionAdapterRegistryError {
  return error instanceof ExecutionAdapterRegistryError;
}

/**
 * Every registry this factory has produced.
 *
 * A registry registered inside another registry would make one routing decision
 * able to reach a second routing decision, and a cycle would make it reach
 * itself — "at most one child adapter, invoked at most once" would stop being a
 * property anyone could check. Identity is tracked here rather than by a marker
 * property because a marker on the object is something a caller could also set.
 */
const COMPOSED_REGISTRIES = new WeakSet<object>();

const DEFAULT_REGISTRY_ADAPTER_ID = 'frontera.execution-adapter-registry';

function isUsableAdapter(candidate: unknown): candidate is ExecutionAdapter {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const adapter = candidate as Partial<ExecutionAdapter>;
  return typeof adapter.adapterId === 'string' && typeof adapter.execute === 'function';
}

/**
 * Construct, validate, freeze.
 *
 * There is deliberately **no `register`/`unregister` surface**: membership is
 * settled at composition and cannot change while traffic flows, so "which
 * adapter can run" is a property of the deployment rather than of whatever most
 * recently mutated a map. Every refusal below is a composition-time throw, so a
 * mis-composed deployment fails where it is wired rather than one action at a
 * time.
 */
export function createExecutionAdapterRegistry(options: ExecutionAdapterRegistryOptions): ExecutionAdapter {
  const adapterId = options.adapterId ?? DEFAULT_REGISTRY_ADAPTER_ID;
  if (typeof adapterId !== 'string' || adapterId.trim().length === 0) {
    throw new ExecutionAdapterRegistryError('EXECUTION_ADAPTER_MALFORMED', 'The execution adapter registry needs a non-blank identity of its own.');
  }
  if (typeof options.selectAdapter !== 'function') {
    throw new ExecutionAdapterRegistryError('EXECUTION_ADAPTER_SELECTOR_INVALID', 'The execution adapter registry needs a synchronous, trusted selectAdapter function.');
  }
  if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
    throw new ExecutionAdapterRegistryError(
      'EXECUTION_ADAPTER_REGISTRY_EMPTY',
      'An execution adapter registry with no adapters can route nothing, and composing one as the execution adapter would make every governed action fail at the provider boundary.',
    );
  }

  const resolved = new Map<string, ExecutionAdapter>();
  for (const candidate of options.adapters) {
    if (!isUsableAdapter(candidate)) {
      throw new ExecutionAdapterRegistryError('EXECUTION_ADAPTER_MALFORMED', 'Every registered execution adapter must declare an adapterId and an execute function.');
    }
    if (candidate.adapterId.trim().length === 0) {
      throw new ExecutionAdapterRegistryError('EXECUTION_ADAPTER_MALFORMED', 'A registered execution adapter may not carry a blank adapterId.');
    }
    if (candidate.adapterId === adapterId || COMPOSED_REGISTRIES.has(candidate)) {
      throw new ExecutionAdapterRegistryError(
        'EXECUTION_ADAPTER_REGISTRY_RECURSIVE',
        'An execution adapter registry may not be registered inside a registry: one routing decision must resolve to one provider adapter.',
      );
    }
    if (resolved.has(candidate.adapterId)) {
      throw new ExecutionAdapterRegistryError(
        'EXECUTION_ADAPTER_ID_DUPLICATE',
        `Two registered execution adapters declare the identity '${candidate.adapterId}'; routing would resolve to whichever was registered last.`,
      );
    }
    resolved.set(candidate.adapterId, candidate);
  }

  const emergencyControl = options.emergencyControl;
  const selectAdapter = options.selectAdapter;

  const registry: ExecutionAdapter = Object.freeze({
    adapterId,

    async execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
      // 1. Trusted routing, from the validated action alone.
      let selected: string | undefined;
      try {
        selected = selectAdapter(action);
      } catch {
        selected = undefined;
      }
      const childAdapter = typeof selected === 'string' ? resolved.get(selected) : undefined;
      if (childAdapter === undefined) {
        // No route. Reported as an infrastructure failure in the vocabulary the
        // execution boundary already owns — never as a denial, and never by
        // falling through to some arbitrary adapter, because "whichever one was
        // registered first" is not a routing decision anybody made.
        return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: 'No execution adapter is configured for this action.' };
      }

      // 2. The adapter-scoped interlock, which only became answerable once the
      //    adapter was known. Blocked or unreadable stops the child from being
      //    called at all, and is reported through the one typed signal the
      //    execution service maps onto `withheldBy: 'emergency-control'`.
      const query: EmergencyControlQuery = {
        ...(action.organization !== undefined ? { organizationId: action.organization } : {}),
        actorId: action.subject,
        adapterId: childAdapter.adapterId,
        resource: action.resource,
      };
      const assessment = readEmergencyControl(emergencyControl, query);
      if (!emergencyControlPermits(assessment)) throw new EmergencyControlWithheldError(assessment);

      // 3. Exactly one child, called exactly once, with the assessed action
      //    unchanged. Nothing here widens or substitutes a field: the object
      //    handed down is the object handed in.
      //
      //    The local is named `childAdapter` deliberately: the repository-wide
      //    scanner in `no-bypass-effect-paths.test.ts` matches an invocation on
      //    an identifier ending in `adapter`, and a call site it cannot see is a
      //    call site the effect-path inventory would silently lose.
      return childAdapter.execute(action);
    },
  });

  COMPOSED_REGISTRIES.add(registry);
  return registry;
}
