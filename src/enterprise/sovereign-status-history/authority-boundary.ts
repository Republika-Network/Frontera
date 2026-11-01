import { createBootstrapAuthorityReconciler } from './authority-settlement.js';
import type { BootstrapAuthorityReconcilerProgress, BootstrapAuthorityReconciliationEntry, BootstrapAuthoritySettlementPort } from './authority-settlement.js';
import type { BootstrapHumanDecisionPort } from './human-decision-authorizer.js';
import { bootstrapBindingDigest, bootstrapBindingOf } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapRequest } from './bootstrap-contract.js';
import { parseBootstrapHumanDecisionRequestId } from './human-decision-authorizer.js';
import type { HostHistoryInventory, TrackedBootstrapRefusal } from './host-inventory.js';
import { createBootstrapOperationRegistry } from './operation-registry.js';
import type { BootstrapOperationRecord, BootstrapOperationRefusal } from './operation-registry.js';
import type { SqliteStatusHighWaterMarkStore } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B3A — the Host's internal FV bootstrap-authority boundary (not composed, unreachable).
 *
 * It takes the pair AUTH-03's `createHumanIdentityServiceWithBootstrapSettlement` issues, and splits it
 * so that each subsystem holds only what it needs:
 *
 * | Holder | Receives | Never receives |
 * |---|---|---|
 * | the bootstrap path (authorizers) | `bootstrapDecisions`: bound `peek`, and a **gated** `authorize` of the bootstrap domain | the service, its store, the settlement capability |
 * | the bootstrap runner | `runBootstrap(request, (parsed, history) => coordinator)`: the in-flight registry, then the Host inventory's durable intent | the registry, the inventory |
 * | reconciliation | nothing: `reconcile()` runs inside, with the capability as its port | — |
 *
 * **Capability custody.**
 * - The settlement capability (F1 and R1: instance-bound, revocable, the bound port) is captured here,
 *   and no getter returns it.
 * - No method takes a capability or a store from a caller, so no impersonating object can be injected.
 * - The raw identity store is never an input: this module needs only the service's bootstrap methods.
 *   The composition must not hand the bootstrap subsystem the composed `store` (AUTH-04A keeps it
 *   internal today).
 * - At construction, `custody(capability, service)` must hold. That is AUTH-03's
 *   `isBootstrapSettlementCapabilityOf`: exact, by the module-private instance, and live (review M4,
 *   replacing a comparison of decision listings that passed whenever both were empty). Every run also
 *   reconciles only decisions the service knows.
 *
 * **Consumption only inside a registered run (re-review N1, R3 F1).** The exposed `authorize` copies
 * the response once into plain frozen data, peeks that copy, resolves the decision's signed namespace
 * and binding, and refuses unless a `runBootstrap`
 * for exactly that binding is running. Only then does it record that run's write-ahead intent,
 * durably, and only then does AUTH-03 consume that same copy. A decision can therefore never be consumed
 * outside the in-flight registry (F3) and the intent journal (H1). The service's own methods stay with
 * the composition, which must not hand them to the bootstrap path.
 *
 * **Disposal is explicit.** `dispose()` refuses every later call, and closes the registry to new runs.
 * Revoking the capability itself is AUTH-03's `revokeBootstrapSettlementCapability`. The Host
 * composition calls it at shutdown (B3B), because this module may not import the identity service.
 *
 * There is no test mode: no option weakens the inventory, the in-flight registry or the capability
 * checks, and the reconciler keeps every F1/R1–R5/F2 rule.
 */

/** Structurally, AUTH-03's bootstrap-domain service methods that this boundary uses. */
export interface BootstrapAuthorityServicePort extends BootstrapHumanDecisionPort {
  bootstrapAuthorityDecision(commitment: string): unknown;
  unsettledBootstrapAuthorityDecisions(): readonly unknown[];
}

export interface FvBootstrapAuthorityBoundaryOptions {
  readonly service: BootstrapAuthorityServicePort;
  readonly settlement: BootstrapAuthoritySettlementPort;
  /** AUTH-03's `isBootstrapSettlementCapabilityOf`. */
  readonly custody: (capability: unknown, service: unknown) => boolean;
  /** The Host inventory: its snapshots for the reconciler, its write-ahead intents for each bootstrap. */
  readonly histories: Pick<HostHistoryInventory, 'inventory' | 'trackBootstrap'>;
  readonly organizationId: string;
  readonly now: () => string;
  readonly graceSeconds: number;
  readonly maxDecisions?: number;
  readonly progress?: BootstrapAuthorityReconcilerProgress;
}

export interface FvBootstrapAuthorityBoundary {
  /** For authorizers: AUTH-03's bootstrap-domain peek and consume, bound; nothing else of the service. */
  readonly bootstrapDecisions: BootstrapHumanDecisionPort;
  /** Runs one coordinator call while its binding is registered in flight and its intent is durably recorded. */
  runBootstrap<T>(request: unknown, operation: (parsed: StatusHistoryBootstrapRequest, history: SqliteStatusHighWaterMarkStore) => Promise<T>): Promise<{ readonly outcome: 'ran'; readonly value: T } | { readonly outcome: 'refused'; readonly reason: BootstrapOperationRefusal | TrackedBootstrapRefusal }>;
  /** One reconciliation run, with the capability, the in-flight registry and the Host inventory. */
  reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]>;
  inFlightOperations(): readonly BootstrapOperationRecord[];
  dispose(): void;
}


export function createFvBootstrapAuthorityBoundary(options: FvBootstrapAuthorityBoundaryOptions): FvBootstrapAuthorityBoundary {
  const { service, settlement, custody, histories, organizationId, now, graceSeconds, maxDecisions, progress } = options ?? ({} as never);
  for (const method of ['peekBootstrapAuthorityDecision', 'authorizeBootstrapAuthorityDecision', 'bootstrapAuthorityDecision', 'unsettledBootstrapAuthorityDecisions'] as const) {
    if (typeof (service as unknown as Record<string, unknown> | undefined)?.[method] !== 'function') throw new TypeError('service is AUTH-03’s identity service (its bootstrap-domain methods).');
  }
  if (typeof settlement?.recordBootstrapAuthoritySettlement !== 'function' || typeof settlement.unsettledBootstrapAuthorityDecisions !== 'function') throw new TypeError('settlement is AUTH-03’s settlement capability.');
  if (typeof histories?.inventory !== 'function' || typeof histories.trackBootstrap !== 'function') throw new TypeError('histories is the Host history inventory.');
  if (typeof custody !== 'function') throw new TypeError('custody is AUTH-03’s isBootstrapSettlementCapabilityOf.');
  if (typeof now !== 'function') throw new TypeError('now is the Host’s trusted clock.');

  const peek = service.peekBootstrapAuthorityDecision.bind(service);
  const authorize = service.authorizeBootstrapAuthorityDecision.bind(service);
  const lookup = service.bootstrapAuthorityDecision.bind(service);
  // Exact custody: the live capability issued with exactly this service.
  if (custody(settlement, service) !== true) throw new TypeError('The settlement capability is not this identity service’s.');
  const track = histories.trackBootstrap.bind(histories);

  const registry = createBootstrapOperationRegistry({ now });
  // Only decisions this service also knows are reconciled, written through the capability itself (its bound port).
  const unsettled = settlement.unsettledBootstrapAuthorityDecisions.bind(settlement);
  const recordSettlement = settlement.recordBootstrapAuthoritySettlement.bind(settlement);
  const port: BootstrapAuthoritySettlementPort = Object.freeze({
    unsettledBootstrapAuthorityDecisions: () =>
      unsettled().filter((record) => {
        const commitment = (record as { commitment?: unknown } | null)?.commitment;
        return typeof commitment === 'string' && lookup(commitment) !== undefined;
      }),
    recordBootstrapAuthoritySettlement: recordSettlement,
  });
  const reconciler = createBootstrapAuthorityReconciler({
    settlement: port,
    inventory: histories.inventory,
    organizationId,
    now,
    graceSeconds,
    inFlight: registry.inFlightByCommitment(lookup),
    ...(maxDecisions !== undefined ? { maxDecisions } : {}),
    ...(progress !== undefined ? { progress } : {}),
  });

  /** The running bootstraps, by `(namespace, binding digest)`: the only context in which a decision may be consumed. */
  const running = new Map<string, () => void>();
  const keyOf = (namespace: string, bindingDigest: string) => JSON.stringify([namespace, bindingDigest]);
  const gatedAuthorize = async (response: unknown) => {
    if (disposed) throw new TypeError('The FV bootstrap authority boundary is disposed.');
    // R3 F1: the caller's object is read exactly once, into plain frozen data. The gate peeks and AUTH-03
    // consumes that same copy, so a getter or proxy cannot show the gate one decision and AUTH-03 another.
    let snapshot: unknown;
    try {
      snapshot = deepFreeze(JSON.parse(JSON.stringify(response)) as unknown);
    } catch {
      throw new TypeError('A bootstrap decision response is plain WebAuthn JSON.');
    }
    const peeked = peek(snapshot) as { contract?: { approvalRequestId?: unknown } } | undefined;
    const target = parseBootstrapHumanDecisionRequestId(peeked?.contract?.approvalRequestId);
    const key = target === undefined ? undefined : keyOf(target.namespace, target.bindingDigest);
    const ensureIntent = key === undefined ? undefined : running.get(key);
    if (key === undefined || ensureIntent === undefined) throw new TypeError('A bootstrap decision is consumed only inside a registered bootstrap of its own binding.');
    ensureIntent();
    const consumed = await authorize(snapshot);
    // Defence in depth: the decision consumed is the one gated (unreachable with the snapshot above).
    const consumedTarget = parseBootstrapHumanDecisionRequestId((consumed as { contract?: { approvalRequestId?: unknown } } | undefined)?.contract?.approvalRequestId);
    if (consumedTarget === undefined || keyOf(consumedTarget.namespace, consumedTarget.bindingDigest) !== key) throw new TypeError('The consumed bootstrap decision is not the one gated; the run fails and its intent stays pending.');
    return consumed;
  };
  let disposed = false;
  const refuse = (): never => {
    throw new TypeError('The FV bootstrap authority boundary is disposed.');
  };

  return Object.freeze({
    bootstrapDecisions: Object.freeze({
      peekBootstrapAuthorityDecision: (response: unknown) => (disposed ? refuse() : peek(response)),
      authorizeBootstrapAuthorityDecision: (response: unknown) => gatedAuthorize(response),
    }),
    async runBootstrap<T>(request: unknown, operation: (parsed: StatusHistoryBootstrapRequest, history: SqliteStatusHighWaterMarkStore) => Promise<T>) {
      if (disposed) return Object.freeze({ outcome: 'refused' as const, reason: 'CLOSED' as const });
      // In flight first (F3), then the durable intent (H1), then the coordinator on the admitted history.
      const ran = await registry.run(request, (parsed) => {
        const bindingDigest = bootstrapBindingDigest(bootstrapBindingOf(parsed));
        const key = keyOf(parsed.namespace, bindingDigest);
        return track(parsed.namespace, { requestId: parsed.requestId, bindingDigest }, async (history, ensureIntent) => {
          running.set(key, ensureIntent);
          try {
            return await operation(parsed, history);
          } finally {
            running.delete(key);
          }
        });
      });
      if (ran.outcome === 'refused') return ran;
      return ran.value;
    },
    reconcile: () => (disposed ? Promise.reject(new TypeError('The FV bootstrap authority boundary is disposed.')) : reconciler.reconcile()),
    inFlightOperations: () => registry.inFlightOperations(),
    dispose(): void {
      disposed = true;
      registry.close();
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
