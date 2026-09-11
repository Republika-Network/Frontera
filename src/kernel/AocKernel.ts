import { randomUUID } from 'crypto';

import type { EnforcementAdapter } from '../features/action-enforcement/domain/enforcement-adapter.js';
import type { EnforcementDecision } from '../features/action-enforcement/domain/enforcement-decision.js';
import type { EnforcementPolicy } from '../features/action-enforcement/domain/enforcement-verification.js';
import {
  createActionEnforcementRuntime,
  type ActionEnforcementRuntime,
  type ActionEnforcementRuntimeOptions,
} from '../features/action-enforcement/runtime/action-enforcement-runtime.js';
import type { EnforcementRuntimeContext } from '../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { PostExecutionRecordMissingError } from '../features/action-enforcement/runtime/enforcement-runtime-errors.js';
import { AocGuard, createAocGuard } from '../features/action-enforcement/sdk/aoc-guard.js';
import type { KernelEnforcementResult } from './contracts/kernel-enforcement-result.js';
import type { KernelEvaluationOptions } from './contracts/kernel-options.js';
import type {
  GovernedAuthorityProvider,
  GovernedConstraintProvider,
  GovernedRepresentationProvider,
  KernelClock,
  KernelIdGenerator,
  PolicyPackProvider,
  RecognitionProvider,
} from './contracts/ports.js';
import type { KernelEvaluationRequest } from './contracts/kernel-request.js';
import type { KernelEvaluationResult } from './contracts/kernel-result.js';
import { KernelConfigurationError, KernelDependencyError, KernelExecutionError } from './errors/kernel-errors.js';
import { resolveGovernedConstraintContext } from './orchestration/governed-constraint-adapter.js';
import {
  KernelContextCapability,
  applyContextStep,
  resolveKernelContext,
  resolveKernelContextFacts,
  type KernelContextFacts,
  type KernelContextResolutionOptions,
} from './orchestration/context-adapter.js';
import { KernelGrantCapability, applyGrantStep, type KernelGrantOptions } from './orchestration/grant-adapter.js';
import {
  KernelObligationCapability,
  applyObligationStep,
  isExecutableStatus,
  resolveKernelObligationFacts,
  resolveKernelObligations,
  type KernelObligationFacts,
  type KernelObligationOptions,
} from './orchestration/obligation-adapter.js';
import { applyGovernedAuthorityStep, resolveGovernedAuthorityFacts, type GovernedAuthorityFacts } from './orchestration/governed-authority-adapter.js';
import { assertKernelInvariants, cloneKernelEvaluationRequest } from './orchestration/kernel-invariants.js';
import { toGuardActionRequestInput, validateKernelEvaluationRequest } from './orchestration/request-adapter.js';
import { toKernelEnforcementResult, toKernelEvaluationResult } from './orchestration/result-adapter.js';
import { AOC_KERNEL_REASON_CODES } from './reason-codes/reason-codes.js';
import { AOC_KERNEL_VERSION } from './versioning.js';

export interface AocKernelOptions {
  /** Real, required dependency: bridges the kernel onto a concrete recognition engine (in every real wiring today, Recognition Runtime composed with Authority Graph, Approval Runtime, and External Agent Handshake -- see `bridgeRecognitionRuntime` in action-enforcement's fixtures). */
  readonly recognitionProvider: RecognitionProvider;
  /** Optional Domain Policy Pack Runtime integration. Omitted -> behavior is identical to no policy pack existing at all. */
  readonly policyPackProvider?: PolicyPackProvider;
  /**
   * Optional governed-authority state provider. Omitted -> behavior is
   * identical to right-scoped authority not existing, which is exactly what a
   * deployment holding no governed authority positions needs.
   *
   * Present, it answers "does this holder control this much of this right?"
   * for every right a request declares in `action.governedRights`, and can
   * only narrow an already-viable outcome into a denial. It never grants
   * anything: this class remains the only component in Soberanía Enterprise that
   * produces a decision.
   */
  readonly governedAuthorityProvider?: GovernedAuthorityProvider;
  /**
   * Optional holder-bound representation provider, consulted alongside
   * `governedAuthorityProvider` whenever a request's requester is not the
   * holder whose authority it draws on.
   *
   * Configuring it is how a deployment adopts holder-bound representation, in
   * exactly the sense configuring `governedAuthorityProvider` is how it adopts
   * right-scoped authority. Omitted, kernel behaviour is identical to this
   * layer not existing. Present, it can only narrow: it is consulted only for
   * resources the authority provider reports as enrolled, and it never rescues
   * a denial.
   */
  readonly governedRepresentationProvider?: GovernedRepresentationProvider;
  /**
   * Optional persistent-constraint fact provider, resolved before the wrapped
   * engine runs so the typed constraint facts reach the Domain Policy Pack
   * preflight.
   *
   * Configuring it is how a deployment lets its own policy turn on persistent
   * constraints — "require approval to tokenize an asset whose economic
   * interest is collateralized", say. Soberanía ships no such rule and this provider
   * introduces none: it carries facts, and only the deployment's policy pack
   * decides anything with them. Omitted, or with no `policyPackProvider`
   * configured, kernel behaviour is identical to this layer not existing.
   *
   * It cannot widen an outcome. Capacity conservation and structural
   * holder/constraint coverage are enforced afterwards inside the Governed
   * Authority Store's own transaction, so neither an absent provider nor a
   * permissive policy can commit authority a constraint already accounts for.
   */
  readonly governedConstraintProvider?: GovernedConstraintProvider;
  /**
   * Optional trusted-context capability: a resolver, the sources it may cite,
   * and the keys this deployment declares it needs.
   *
   * Configuring it is how a deployment stops letting the requester supply the
   * facts its own rules decide on. Resolved facts reach the Domain Policy Pack
   * preflight under `aoc.context`, a namespace no request body can write to,
   * *alongside* the caller-supplied `ActionDescriptor` fields rather than
   * instead of them: `action.amount` keeps exactly the meaning it has today,
   * and a pack chooses which of the two it reads.
   *
   * Omitted — or configured with an empty declaration — kernel behaviour is
   * byte-identical to this layer not existing: no resolution is attempted, no
   * metadata key appears, no field is added to the result, and the Governance
   * Record is unchanged. Present, it can only ever narrow: a requirement the
   * deployment marked `required: true` and that did not resolve turns a viable
   * outcome into a denial, and nothing here can make anything allowed that was
   * not already allowed.
   *
   * It cannot decide. The resolver's return type carries observations and no
   * verdict, so an unreadable ERP produces `resolved: false` for a policy to
   * react to, never an authorization outcome an ERP chose.
   */
  readonly contextResolution?: KernelContextResolutionOptions;
  /**
   * Optional obligation capability: a discharge provider, the sources it may
   * cite, and the obligations this deployment declares stand over an action.
   *
   * Configuring it is how a deployment stops `require-approval` being, in the
   * ADR's words, "a statement the platform makes and never keeps". A declared
   * obligation gains a closed seven-node lifecycle, a discharge gains
   * provenance, and an action this Kernel authorized *conditionally* does not
   * execute until the condition is met.
   *
   * **It cannot change an authorization.** This is the one thing to know about
   * the capability. `status`, `reasonCodes` and `summary` are produced by the
   * authority and policy layers and are never read or written by the obligation
   * step: an undischarged blocking obligation on an allowed action leaves
   * `status: 'allowed'` exactly as it was and withholds the *executor*, so the
   * record shows a decision that authorized the action and an execution that
   * was withheld because a condition was unmet. Rewriting that into a denial
   * would erase the distinction an auditor most needs —
   * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3.
   *
   * Nor can it authorize. There is no discharge state, and no configuration of
   * one, that makes a denied action proceed.
   *
   * Omitted — or configured with no declared obligations — kernel behaviour is
   * byte-identical to this layer not existing: no resolution is attempted, no
   * field is added to the result, and the Governance Record is unchanged.
   *
   * It is not an approval workflow. Frontera records that a valid trusted
   * approval has or has not been discharged; obtaining one is the deployment's
   * business, and there is nothing here that asks, routes, notifies, reminds,
   * escalates or schedules.
   */
  readonly obligations?: KernelObligationOptions;
  /**
   * Optional bounded-grant capability: the operator-declared horizon within
   * which a grant derived from an authorization this Kernel produced may live.
   *
   * Configuring it makes `evaluate()` report, alongside the decision, whether
   * that decision is one a bounded grant could be derived from and what such a
   * grant would be bounded by. It does **not** issue one: issuance is stateful
   * and transactional, so it is a separate operation through
   * `createGrantIssuanceService`, and `evaluate()` stays pure. See
   * `src/features/grant-runtime/README.md`, "Evaluation is not issuance".
   *
   * **It cannot change an authorization, and it cannot produce one.**
   * `status`, `reasonCodes` and `summary` are produced by the authority and
   * policy layers and are never read or written by the grant step. An
   * authorization that permits exercise with a blocking obligation still
   * outstanding reports `status: 'allowed'` with
   * `grants.eligibility: 'ineligible'` — the decision stands, and no grant may
   * be derived from it yet. A denied authorization reports `status: 'denied'`
   * with `grants.eligibility: 'ineligible'`, and no grant state of any kind
   * makes it proceed.
   *
   * Nor can it broaden anything. A grant is equal to or narrower than the
   * authority it derives from on every axis, proven by
   * `grantScopeIsWithin` of the artifact rather than of the process that made
   * it, and refused otherwise.
   *
   * Omitted, kernel behaviour is byte-identical to this layer not existing: no
   * eligibility is assessed, no field is added to the result, and the
   * Governance Record is unchanged.
   */
  readonly grants?: KernelGrantOptions;
  /** Defaults to a real-time clock. Tests should supply a deterministic one (see `AOC_KERNEL_INTEGRATION_GUIDE.md`). */
  readonly clock?: KernelClock;
  /** Defaults to `crypto.randomUUID()`-backed ids. Tests should supply a deterministic sequential generator. */
  readonly idGenerator?: KernelIdGenerator;
  readonly emergencyDeny?: boolean;
  readonly allowIdempotencyRetryAfterFailure?: boolean;
  /** Overrides the wrapped engine's default 13-policy enforcement chain. Only pass this when you have a specific, tested replacement chain -- see `createDefaultEnforcementPolicyChain`. */
  readonly policies?: readonly EnforcementPolicy[];
  /** Adapters registered up front so `AdapterPermissionPolicy` can enforce their allow/deny lists -- without this, a request naming `target.adapterId` would find no registered adapter and pass with `NO_ADAPTER_REGISTERED`, which is more permissive than a directly-configured `ActionEnforcementRuntime`. Use `registerAdapter()` to add more after construction. */
  readonly adapters?: readonly EnforcementAdapter[];
}

function createRealClock(): KernelClock {
  return { now: () => new Date().toISOString() };
}

function createRealIdGenerator(): KernelIdGenerator {
  return { nextId: (prefix: string) => `${prefix}-${randomUUID()}` };
}

/**
 * Canonical Soberanía Enterprise Kernel entry point. Wraps the existing, unmodified
 * `ActionEnforcementRuntime`/`AocGuard` engine (recognition, authority,
 * approval, evidence, external handshake, and domain policy pack are all
 * reached transitively through the injected `RecognitionProvider`) and
 * exposes it through a stable, versioned contract.
 *
 * `evaluate()` is the canonical operation: it only ever evaluates, mapping
 * onto `AocGuard.preflight()`, and never invokes anything. `enforce()` is a
 * documented higher-level operation that also invokes a caller-supplied
 * adapter as a real side effect when (and only when) evaluation allows it --
 * see `docs/kernel/AOC_KERNEL_CURRENT_EXECUTION_MODEL.md` sec. 19 for why
 * these are kept distinct rather than collapsed under one name.
 */
export class AocKernel {
  static readonly version = AOC_KERNEL_VERSION;

  private readonly runtime: ActionEnforcementRuntime;
  private readonly guard: AocGuard;
  private readonly ctx: EnforcementRuntimeContext;
  private readonly governedAuthorityProvider: GovernedAuthorityProvider | undefined;
  private readonly governedRepresentationProvider: GovernedRepresentationProvider | undefined;
  private readonly governedConstraintProvider: GovernedConstraintProvider | undefined;
  private readonly contextCapability: KernelContextCapability | undefined;
  private readonly obligationCapability: KernelObligationCapability | undefined;
  private readonly grantCapability: KernelGrantCapability | undefined;

  constructor(options: AocKernelOptions) {
    if (options.recognitionProvider === undefined) {
      throw new KernelConfigurationError('AocKernel requires a recognitionProvider.');
    }

    this.ctx = {
      clock: options.clock ?? createRealClock(),
      ids: options.idGenerator ?? createRealIdGenerator(),
    };

    const runtimeOptions: ActionEnforcementRuntimeOptions = {
      ...(options.emergencyDeny !== undefined ? { emergencyDeny: options.emergencyDeny } : {}),
      ...(options.allowIdempotencyRetryAfterFailure !== undefined ? { allowIdempotencyRetryAfterFailure: options.allowIdempotencyRetryAfterFailure } : {}),
      ...(options.policies !== undefined ? { policies: options.policies } : {}),
      ...(options.policyPackProvider !== undefined ? { policyPackIntegration: options.policyPackProvider } : {}),
    };

    this.runtime = createActionEnforcementRuntime(this.ctx, options.recognitionProvider, runtimeOptions);
    this.guard = createAocGuard(this.runtime);
    this.governedAuthorityProvider = options.governedAuthorityProvider;
    this.governedRepresentationProvider = options.governedRepresentationProvider;
    this.governedConstraintProvider = options.governedConstraintProvider;
    // Composed here rather than per request, so a mis-declared source or
    // requirement is a wiring-time failure instead of one discovered in the
    // middle of an evaluation.
    this.contextCapability = options.contextResolution === undefined ? undefined : new KernelContextCapability(options.contextResolution);
    // Composed here for the same reason, and with the same consequence: a
    // deployment that registers its own request bag as an independent discharge
    // source is rejected when it wires the Kernel, not when a payment is
    // evaluated.
    this.obligationCapability = options.obligations === undefined ? undefined : new KernelObligationCapability(options.obligations);
    // Composed here for the same reason, and with the same consequence: a
    // deployment that declares a grant horizon of zero seconds is rejected when
    // it wires the Kernel, not when a payment is evaluated.
    this.grantCapability = options.grants === undefined ? undefined : new KernelGrantCapability(options.grants);

    for (const adapter of options.adapters ?? []) {
      this.runtime.registerAdapter(adapter);
    }
  }

  /** Registers an adapter after construction -- mirrors `ActionEnforcementRuntime.registerAdapter`, for callers that discover adapters dynamically rather than up front via `AocKernelOptions.adapters`. */
  registerAdapter(adapter: EnforcementAdapter): EnforcementAdapter {
    return this.runtime.registerAdapter(adapter);
  }

  private buildIndeterminateResult(request: KernelEvaluationRequest, error: unknown): KernelEvaluationResult {
    const message = error instanceof Error ? error.message : String(error);
    const decisionId = this.ctx.ids.nextId('kernel-indeterminate');
    return {
      requestId: request.requestId,
      decisionId,
      status: 'indeterminate',
      reasonCodes: [AOC_KERNEL_REASON_CODES.KERNEL_INDETERMINATE],
      summary: `Kernel evaluation could not complete: ${message}`,
      recognition: { performed: false },
      authority: { performed: false },
      policies: [],
      approval: { performed: false, status: 'not_applicable' },
      evidence: [],
      trace: { steps: [], decisionId, kernelVersion: AOC_KERNEL_VERSION },
      evaluatedAt: this.ctx.clock.now(),
      kernelVersion: AOC_KERNEL_VERSION,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    };
  }

  /**
   * Evaluates whether an action may proceed. Never invokes anything, and
   * never throws for a governance outcome -- an unexpected failure in the
   * configured `RecognitionProvider` (a real gap in the wrapped engine
   * itself, see `AOC_KERNEL_CURRENT_EXECUTION_MODEL.md` sec. 14) is caught
   * here and surfaced as `status: 'indeterminate'` instead.
   */
  async evaluate(request: KernelEvaluationRequest, options?: KernelEvaluationOptions): Promise<KernelEvaluationResult> {
    validateKernelEvaluationRequest(request);
    const requestSnapshot = cloneKernelEvaluationRequest(request);

    // Resolved before the wrapped engine runs, because the policy pack preflight
    // happens synchronously inside it and an asynchronous store read has no
    // point to occur at once it has started. Facts only: nothing here can deny,
    // and a provider that fails reports `resolved: false` rather than an empty
    // constraint set, so a deployment's rule can tell "none stand" from "none
    // were read".
    const constraintContext = await resolveGovernedConstraintContext(this.governedConstraintProvider, request, this.ctx.clock.now());

    // Resolved in the same window and for the same reason: the policy pack
    // preflight runs synchronously inside the wrapped engine, so an
    // asynchronous read of a system of record has no point to occur at once it
    // has started. Facts only -- nothing here denies, and a resolver that
    // fails reports `resolved: false` rather than an empty fact set, so a
    // deployment's rule can tell "the vendor has no status" from "the ERP
    // could not be read".
    const contextResolution = await resolveKernelContext(this.contextCapability, request, this.ctx.clock.now());

    // Resolved before the wrapped engine runs so that `evaluate()` and
    // `enforce()` observe the same world in the same order, and so an
    // asynchronous read of an approval system happens at a point one can
    // occur. Nothing it returns reaches the policy input: obligations are read
    // *from* the decision's layers, never *into* them, which is the one-way
    // dependency rule (`D reads B`) that keeps a discharge from becoming an
    // input a policy rule could turn on.
    const obligationResolution = await resolveKernelObligations(this.obligationCapability, request, this.ctx.clock.now());

    let decision: EnforcementDecision;
    try {
      decision = this.guard.preflight(toGuardActionRequestInput(request, options, constraintContext, contextResolution));
    } catch (error) {
      return this.buildIndeterminateResult(request, new KernelDependencyError('recognitionProvider failed during evaluation', error));
    }

    const engineResult = toKernelEvaluationResult(request.requestId, decision, options, request.correlationId);

    // The governed-right authority step runs after the wrapped engine's own
    // chain, and only ever narrows what that chain concluded. Placing it here
    // rather than inside the chain keeps two properties that matter: the
    // engine's 13 policies stay exactly as they were, and this step reads the
    // engine's *outcome* rather than participating in it, so it cannot make
    // anything allowed that was not already allowed.
    const authorityResult =
      this.governedAuthorityProvider === undefined
        ? engineResult
        : await applyGovernedAuthorityStep(this.governedAuthorityProvider, this.governedRepresentationProvider, request, engineResult);

    // Last, and after the authority step, so the two narrowing steps compose in
    // one direction only. A result the chain or the authority step already
    // denied is annotated with what context was resolved and is otherwise left
    // exactly as it was: a denial has one reason, and re-labelling it with a
    // second would misreport why the request actually stopped.
    const contextResult = applyContextStep(this.contextCapability, contextResolution, authorityResult);

    // Last of all, and the only step in this pipeline that cannot change the
    // outcome it is handed. `applyObligationStep` adds a field and reads
    // nothing: `status`, `reasonCodes` and `summary` arrive from the authority
    // and policy layers and leave untouched, whatever any obligation's state
    // is. `evaluate()` therefore *reports* that exercise is withheld and never
    // enacts it — enacting is `enforce()`'s business, because only `enforce()`
    // has an executor to withhold.
    const obligationResult = applyObligationStep(obligationResolution, contextResult);

    // Last of all, and after the obligation step, because grant eligibility is
    // a function of what the decision concluded *and* of whether every blocking
    // obligation on it is satisfied — the aggregate ADR §3 makes issuance turn
    // on. Like `applyObligationStep` and unlike the two narrowing steps before
    // it, this one cannot change the outcome it is handed: it adds a field and
    // reads no `status`, no `reasonCodes` and no `summary`.
    //
    // It issues nothing. `evaluate()` touches no store and creates no artifact,
    // so two evaluations of the same world still produce the same result.
    const result = applyGrantStep(this.grantCapability, request, obligationResult);

    assertKernelInvariants(request, requestSnapshot, result);
    return result;
  }

  /**
   * Preflights the request exactly as `evaluate()` does, then invokes
   * `executor` exactly once, and only when the evaluation allows it --
   * identical semantics to `AocGuard.enforce()`, which this wraps directly.
   *
   * `guard.enforce()` can throw from exactly two places (see
   * `AOC_KERNEL_CURRENT_EXECUTION_MODEL.md` sec. 14): an uncaught
   * `recognitionProvider` failure during preflight (before `executor` ever
   * runs -- safe to report as `not_executed`), or a
   * `PostExecutionRecordMissingError` raised *after* `executor` has already
   * run. Only the former is reported as `status: 'indeterminate'` /
   * `execution.executed: false`; the latter is rethrown as a
   * `KernelExecutionError` rather than risk telling a caller it is safe to
   * retry a side effect that may have already happened.
   */
  async enforce<T>(request: KernelEvaluationRequest, executor: () => Promise<T> | T, options?: KernelEvaluationOptions): Promise<KernelEnforcementResult<T>> {
    validateKernelEvaluationRequest(request);
    const requestSnapshot = cloneKernelEvaluationRequest(request);

    // Governed-right authority is resolved *before* the executor can run.
    // `guard.enforce()` preflights and invokes in one synchronous call, so
    // there is no point inside it at which an asynchronous authority store
    // could be consulted, and a check performed afterwards would be a check of
    // a side effect that has already happened. Re-running `evaluate()` here
    // was rejected for a concrete reason: it would consume the request's
    // idempotency key, and the real enforcement immediately after it would
    // come back `duplicate_suppressed`.
    let governedAuthorityFacts: GovernedAuthorityFacts | undefined;
    if (this.governedAuthorityProvider !== undefined) {
      const facts = await resolveGovernedAuthorityFacts(this.governedAuthorityProvider, this.governedRepresentationProvider, request, this.ctx.clock.now());
      governedAuthorityFacts = facts;
      if (facts.reasonCodes.length > 0) {
        const decisionId = this.ctx.ids.nextId('kernel-governed-authority-denied');
        const denied: KernelEvaluationResult = {
          requestId: request.requestId,
          decisionId,
          status: 'denied',
          reasonCodes: [...facts.reasonCodes],
          summary: facts.summary,
          recognition: { performed: false },
          authority: {
            performed: true,
            governedAuthority: facts.governedAuthority,
            ...(facts.representation !== undefined ? { representation: facts.representation } : {}),
          },
          policies: [],
          approval: { performed: false, status: 'not_applicable' },
          evidence: [],
          trace: { steps: [], decisionId, kernelVersion: AOC_KERNEL_VERSION },
          evaluatedAt: this.ctx.clock.now(),
          kernelVersion: AOC_KERNEL_VERSION,
          ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
        };
        assertKernelInvariants(request, requestSnapshot, denied);
        return { ...denied, execution: { status: 'not_executed', executed: false } };
      }
    }

    const constraintContext = await resolveGovernedConstraintContext(this.governedConstraintProvider, request, this.ctx.clock.now());

    // Resolved *before* the executor can run, for the same reason governed
    // authority is: `guard.enforce()` preflights and invokes in one
    // synchronous call, and a context requirement checked afterwards would be
    // a check of a side effect that has already happened.
    const contextResolution = await resolveKernelContext(this.contextCapability, request, this.ctx.clock.now());
    let contextFacts: KernelContextFacts | undefined;
    if (this.contextCapability !== undefined && contextResolution !== undefined) {
      contextFacts = resolveKernelContextFacts(this.contextCapability, contextResolution);
      if (contextFacts.reasonCodes.length > 0) {
        const decisionId = this.ctx.ids.nextId('kernel-context-denied');
        const denied: KernelEvaluationResult = {
          requestId: request.requestId,
          decisionId,
          status: 'denied',
          reasonCodes: [...contextFacts.reasonCodes],
          summary: contextFacts.summary,
          recognition: { performed: false },
          authority: { performed: false },
          policies: [],
          approval: { performed: false, status: 'not_applicable' },
          evidence: [],
          context: contextFacts.evaluation,
          trace: { steps: [], decisionId, kernelVersion: AOC_KERNEL_VERSION },
          evaluatedAt: this.ctx.clock.now(),
          kernelVersion: AOC_KERNEL_VERSION,
          ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
        };
        assertKernelInvariants(request, requestSnapshot, denied);
        return { ...denied, execution: { status: 'not_executed', executed: false } };
      }
    }

    // Resolved *before* the executor can run, for the reason governed authority
    // and context are: `guard.enforce()` preflights and invokes in one
    // synchronous call, and an obligation checked afterwards would be a check
    // of a side effect that has already happened.
    const obligationResolution = await resolveKernelObligations(this.obligationCapability, request, this.ctx.clock.now());
    const obligationFacts: KernelObligationFacts | undefined = obligationResolution === undefined ? undefined : resolveKernelObligationFacts(obligationResolution);

    if (obligationFacts !== undefined && !obligationFacts.eligible) {
      // The authorization is produced exactly as it always is, and the executor
      // is never reached.
      //
      // `preflight()` rather than `enforce()`, because `enforce()` is the one
      // operation that can invoke the executor and there is no point inside it
      // at which an already-known obligation state could stop it. The decision
      // this produces is the *real* decision — the same chain, the same
      // policies, the same reason codes — so what the caller receives is an
      // authorization that stands, alongside an execution that was withheld.
      //
      // It consumes the request's idempotency key exactly as the existing
      // non-executing paths through `enforce()` already do: `guard.enforce()`
      // preflights first on every path, so a denied or approval-required
      // enforcement claims the key today. This branch is therefore not a new
      // idempotency characteristic, and a caller re-submitting after the
      // obligation is discharged uses a fresh key for the same reason it
      // already must after an `approval_required`.
      let withheldDecision: EnforcementDecision;
      try {
        withheldDecision = this.guard.preflight(toGuardActionRequestInput(request, options, constraintContext, contextResolution));
      } catch (error) {
        const indeterminate = this.buildIndeterminateResult(request, new KernelDependencyError('recognitionProvider failed during enforcement', error));
        return { ...indeterminate, execution: { status: 'not_executed', executed: false } };
      }

      const evaluated = toKernelEvaluationResult(request.requestId, withheldDecision, options, request.correlationId);
      const withheldWithAuthority =
        governedAuthorityFacts === undefined
          ? evaluated
          : {
              ...evaluated,
              authority: {
                ...evaluated.authority,
                governedAuthority: governedAuthorityFacts.governedAuthority,
                ...(governedAuthorityFacts.representation !== undefined ? { representation: governedAuthorityFacts.representation } : {}),
              },
            };
      const withheldWithContext = contextFacts === undefined ? withheldWithAuthority : { ...withheldWithAuthority, context: contextFacts.evaluation };
      // The obligation evaluation is *added*. `status`, `reasonCodes` and
      // `summary` are carried through byte for byte from what the authority and
      // policy layers concluded — an unmet obligation withholds the action, it
      // does not reinterpret the authorization.
      const withheldWithObligations = { ...withheldWithContext, obligations: obligationFacts.evaluation };
      // Reported on the withheld path too, and reporting exactly what is true
      // there: the authorization stands, the obligation is outstanding, and no
      // grant may be derived from it yet. Omitting it here would have made the
      // one case the ADR spends §3 on the one case the field is absent for.
      const withheldResult = applyGrantStep(this.grantCapability, request, withheldWithObligations);
      assertKernelInvariants(request, requestSnapshot, withheldResult);
      return {
        ...withheldResult,
        execution: {
          status: 'not_executed' as const,
          executed: false,
          // Named only when the decision itself would have permitted execution.
          // On a denial the denial is the reason, and labelling it "withheld by
          // obligation" would give one outcome two causes.
          ...(isExecutableStatus(withheldResult.status) ? { withheldBy: 'obligation' as const } : {}),
        },
      };
    }

    let outcome;
    try {
      outcome = await this.guard.enforce(toGuardActionRequestInput(request, options, constraintContext, contextResolution), executor);
    } catch (error) {
      if (error instanceof PostExecutionRecordMissingError) {
        throw new KernelExecutionError(
          'A post-execution invariant was violated after the executor may have already run; the execution outcome cannot be safely reported as not executed.',
          error,
        );
      }
      const indeterminate = this.buildIndeterminateResult(request, new KernelDependencyError('recognitionProvider failed during enforcement', error));
      return { ...indeterminate, execution: { status: 'not_executed', executed: false } };
    }

    // Outside the try/catch above: outcome now definitely exists, so any error from here on
    // (adaptation or an invariant violation) must propagate rather than be reported as
    // 'indeterminate' / not_executed, which would misrepresent whether executor already ran.
    const enforced = toKernelEnforcementResult(request.requestId, outcome.decision, outcome.result, options, request.correlationId);
    // The facts resolved above are re-attached rather than re-resolved: the
    // authority state was read before the executor ran, and reporting a second
    // read taken afterwards would describe a world the decision was not made
    // in.
    const withAuthority =
      governedAuthorityFacts === undefined
        ? enforced
        : {
            ...enforced,
            authority: {
              ...enforced.authority,
              governedAuthority: governedAuthorityFacts.governedAuthority,
              ...(governedAuthorityFacts.representation !== undefined ? { representation: governedAuthorityFacts.representation } : {}),
            },
          };
    // Re-attached rather than re-resolved, for the same reason the authority
    // facts are: the context was read before the executor ran, and reporting a
    // second read taken afterwards would describe a world the decision was not
    // made in.
    const withContext = contextFacts === undefined ? withAuthority : { ...withAuthority, context: contextFacts.evaluation };
    // Re-attached rather than re-resolved, for the same reason: the obligations
    // were read before the executor ran, and a second read taken afterwards
    // would describe a world the execution was not permitted in. Nothing here
    // consumes or mutates a discharge — obligation state is derived, never
    // held — so a repeated `enforce()` over the same world produces the same
    // instances and cannot double-discharge anything.
    const withObligations = obligationFacts === undefined ? withContext : { ...withContext, obligations: obligationFacts.evaluation };
    // Derived from the same result the caller receives, after the executor has
    // run. It records what bounded permission this authorization would produce;
    // it does not gate the executor, and nothing here has issued a grant — see
    // the README's "Why `enforce()` is unchanged".
    const result = applyGrantStep(this.grantCapability, request, withObligations);
    assertKernelInvariants(request, requestSnapshot, result);
    return result;
  }
}

export function createAocKernel(options: AocKernelOptions): AocKernel {
  return new AocKernel(options);
}
