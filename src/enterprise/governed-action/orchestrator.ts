import {
  emergencyControlPermits,
  readEmergencyControl,
  type EmergencyControlReaderPort,
} from '../../features/emergency-control-runtime/index.js';
import { GRANT_REASON_CODES, grantCorrelationMatches, type GrantCorrelation, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import {
  GRANT_EXERCISE_REASON_CODES,
  isRecordableExecutionAdapterId,
  providerEffectCertaintyOf,
  type BoundedGrantExerciseAssessment,
  type ExecutionOutcome,
  type GrantExerciseRequest,
} from '../../features/execution-runtime/index.js';
import type { AuthorityEventRecorder } from '../authority-event-stream/recorder.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { EnterpriseEventPublisher } from '../events/enterprise-events.js';
import { isExecutionGovernanceError, type AuthorityControlledExecutionService } from '../execution-governance/index.js';
import type { ExecutionOutcomeAccessContext, ExecutionTerminalObservation, ExecutionTerminalRecord } from '../execution-outcome-store/contracts.js';
import type { ExecutionOutcomePort } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionRecord } from '../execution-resolution-store/contracts.js';
import type { ExecutionResolutionReader } from '../execution-resolution-store/resolution-store.js';
import type { ExecutionResolutionBinder } from '../execution-reconciliation/binder.js';
import type { AuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import type { GovernanceEnterpriseContext, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  GOVERNED_ACTION_REASON_CODES as R,
  type GovernedActionDecisionRef,
  type GovernedActionGrantPolicy,
  type GovernedActionGrantTerms,
  type GovernedActionMonetaryTrust,
  type GovernedActionResult,
  type GovernedActionWithheldBy,
} from './contracts.js';
import { createDecisionCommitter, type VerifiedDecision } from './decision-commit.js';
import { GovernedActionConfigurationError } from './errors.js';
import { EXECUTION_UNCONFIRMED_OUTCOME, createExecutionLedger, type PriorExecution } from './execution-ledger.js';
import { deriveGovernedActionExecutionId, deriveGovernedActionRequestId, governedActionIdempotencyScope } from './identifiers.js';
import { validateGovernedActionIntent } from './intent.js';
import { boundScopeOf, type BoundActorScope } from './kernel-request.js';

/**
 * The Governed Action Orchestrator — the first canonical internal path from a
 * trusted customer identity to an external effect.
 *
 * ```
 * BoundCustomerIdentity + intent
 *   -> server-derived KernelEvaluationRequest     actor/org from identity only
 *   -> idempotency resolution                     Governance Store, before the Kernel
 *   -> Kernel.evaluate()                          the only decision producer
 *   -> Governance Store appendEvaluation()        COMMITTED BEFORE ANY GRANT
 *   -> re-read + verify the committed record
 *   -> grant source from the PERSISTED decision   never the transient one
 *   -> bounded grant (ACE issuance core)          binding re-resolved at commit
 *   -> authorization_artifact reference           evidence, never authority
 *   -> exercise pre-assessment (ACE)
 *   -> P11 attempt preparation                    the exact execution context, durable, BEFORE the claim
 *   -> P12 resolution-authority binding           when reconciliation is enabled: durable, BEFORE the claim
 *   -> execution_record write-ahead claim         durable, at most once per execution id
 *   -> ACE exercise -> ExecutionAdapter           ValidatedExecutionAction only; P7 finalized inside
 *   -> P11 terminal observation                   the initial provider certainty, immutable
 *   -> execution outcome reference                compact summary of the P11 observation, by digest
 * ```
 *
 * ## Durable outcomes (P11)
 *
 * No adapter is invoked unless the exact execution context — tenant,
 * correlation, action and the exact amount and asset the adapter will receive —
 * was first durably prepared in the execution outcome store. Preparation comes
 * **before** the write-ahead claim, and is idempotent, so a crash between the
 * two leaves a request that is still safe to retry: "prepared" says nothing
 * about a provider, and the claim remains the only fact that an attempt became
 * load-bearing. After the adapter, the runtime's outcome is recorded as one
 * immutable initial observation: `confirmed-completed`,
 * `confirmed-not-completed` or `unconfirmed` for the provider, or the layer
 * that withheld it. Replay of a claimed execution reads that observation —
 * never P8, never process memory, never the provider — and falls back to the
 * pre-P11 outcome reference only for executions that have no P11 record.
 *
 * No local commit is atomic with an external effect. A claim with no
 * observation stays "attempted, outcome not on record", is never retried, and
 * belongs to reconciliation (P12), which nothing here performs.
 *
 * ## Resolved replay (P12)
 *
 * When reconciliation is enabled, a new execution is bound to its trusted
 * resolution authority after preparation and before the claim; a binding that
 * cannot be made durable stops the request exactly as a failed preparation
 * does. Replay of an execution P11 left uncertain (no observation, or
 * `unconfirmed`) first reads the P12 store: a verified definitive resolution
 * replays as `executed` or `execution_failed`. Replay **reads**; it never asks
 * a resolution authority, never contacts a provider, and a P12 store that
 * cannot prove its answer leaves the replay exactly as P11 alone would answer
 * it — still unconfirmed, never optimistic. A definitive P11 observation is
 * never consulted against P12 at all.
 *
 * ## Evidence, after each fact — reported, never waited for
 *
 * When a deployment composes the canonical authority event stream (P8), each
 * established fact above is also *reported* — after it is established, through
 * the write-only `AuthorityEventRecorder` — and never consulted. `report()` is
 * **synchronous**: it enqueues and returns. Nothing on this path awaits durable
 * projection, so an asynchronous append that is slow, unreachable or
 * permanently stuck cannot hold a grant issuance, sit between the write-ahead
 * claim and the adapter, or hold a result. (Control flow only: the projector
 * shares this event loop, so a synchronous store can still add latency.) A
 * missing, failed or corrupt stream leaves every result below exactly as it
 * would be without one.
 *
 * ## Where the operational interlock sits
 *
 * When a deployment composes emergency control, four checkpoints are consulted
 * on this path, and only one of them is here:
 *
 * ```
 * committed decision -> replay -> [ADMISSION: this file] -> grant terms
 *   -> issuance      -> [COMMIT BOUNDARY: issuance-core, synchronous]
 *   -> exercise      -> [AFTER AUTHORITATIVE GRANT REREAD: grant-execution-service]
 *   -> routing       -> [ADAPTER-SCOPED: execution-adapter-registry]
 *   -> provider
 * ```
 *
 * None of them produces a decision, none revokes a grant, and none rewrites a
 * recorded historical outcome. See `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
 *
 * ## Nothing here decides
 *
 * Statuses and reason codes are the Kernel's, read from the committed record.
 * Grant eligibility is the Kernel's projection and the grant runtime's
 * assessment. Exercise is ACE's. The only thing this file adds is **order**:
 * the decision is durably committed before any bounded authority exists, and
 * an execution identity is durably claimed before any adapter runs.
 *
 * ## Trust inputs
 *
 * `identity` is trusted — it is what Prompt 2's admission produced, and this
 * file never authenticates anything. `intent` is not: it is validated closed
 * (`intent.ts`), and it can name an action, never an actor, organization,
 * grant, expiry, adapter or execution id. Grant terms come from the host's
 * `grantPolicy`, and the Governance Store is written under the bound
 * organization's tenant scope — never under a system context.
 */
export interface GovernedActionOrchestratorOptions {
  /** The one authority organization this instance serves — the same value customer admission enforces. */
  readonly organizationId: string;
  /** The trust domain governed-action requests are evaluated in. Host configuration, never caller input. */
  readonly trustDomainId: string;
  /** ACE's authorization internals: `evaluate()` and `issueFromDecision()`, split so the commit happens between them. */
  readonly issuance: AuthorityControlledIssuanceCore;
  /** ACE's exercise gate. The only route to the adapter. */
  readonly execution: Pick<AuthorityControlledExecutionService, 'assessExercise' | 'exercise'>;
  readonly governanceStore: GovernanceStore;
  readonly grantPolicy: GovernedActionGrantPolicy;
  /**
   * P9 — the trusted asset registry and financial action classifier every
   * intent is validated against. **Required.** The same classifier instance is
   * handed to the exercise-control gate, so the class an intent is admitted
   * under and the class its exercise is controlled under are one answer.
   */
  readonly monetary: GovernedActionMonetaryTrust;
  readonly now: () => string;
  readonly enterpriseContext: () => GovernanceEnterpriseContext;
  readonly events: {
    readonly enabled: boolean;
    readonly publisher: EnterpriseEventPublisher;
    readonly nextId: (prefix: string) => string;
  };
  readonly traceLevel: 'basic' | 'full';
  /**
   * ACE's host-level source revalidation, when the deployment configured one.
   * The committed record remains the source the grant is *derived* from; this
   * supplies the *current* source the grant-store commit guard re-proves
   * eligibility, subject, scope and validity against. `undefined` refuses.
   */
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
  /**
   * The operational safety interlock, when the deployment composed one.
   *
   * This orchestrator owns the **admission** checkpoint: after the decision is
   * committed and after historical execution replay, and before grant terms,
   * authority binding and issuance. The other checkpoints are ACE's (the
   * commit boundary and the exercise) and the registry's (the adapter-scoped
   * stop). A deployment must hand the **same reader instance** to all of them,
   * which is what the composition root does.
   *
   * Read-only by type: this orchestrator cannot activate or release a control.
   */
  readonly emergencyControl?: EmergencyControlReaderPort;
  /**
   * P8 — the canonical authority event stream's **write-only** recorder, when
   * the deployment composed one.
   *
   * Called only after the fact it reports is established — the decision
   * committed and re-verified, the grant returned by issuance, the claim
   * appended, the outcome returned — and never read: every method returns
   * nothing, and every call is wrapped so that its failure cannot change a
   * result. Omitting it changes nothing.
   */
  readonly evidence?: AuthorityEventRecorder;
  /**
   * P11 — the durable execution outcome store's narrow port: prepare an
   * attempt, record its initial observation, read both back. **Required**: a
   * governed execution never runs without its exact context durably prepared,
   * and the composition root always composes one with this orchestrator.
   *
   * Read only to answer what an execution identity already did. Nothing read
   * from it can permit a new effect: its only behavioural use is replay of the
   * same execution identity, whose second invocation the write-ahead claim
   * already forbids.
   */
  readonly executionOutcomes: ExecutionOutcomePort;
  /**
   * P12 — present only when the deployment enabled execution reconciliation.
   *
   * `binder` durably binds a new execution to its trusted resolution authority
   * before the claim; `reader` lets replay of an uncertain execution find a
   * definitive resolution. Neither can resolve anything: the orchestrator holds
   * no resolution authority and no reconciliation service, so ordinary
   * customer replay can never query a provider.
   */
  readonly executionResolution?: {
    readonly binder: ExecutionResolutionBinder;
    readonly reader: ExecutionResolutionReader;
  };
}

export interface GovernedActionOrchestrator {
  readonly organizationId: string;
  /** Govern one intended action on behalf of a bound customer identity. Never throws for a governance outcome; every outcome is a result. */
  govern(identity: BoundCustomerIdentity, intent: unknown): Promise<GovernedActionResult>;
}

/** Correlation every result after the request id is known carries. */
interface ResultContext {
  readonly requestId: string;
  readonly correlationId?: string;
  readonly decision?: GovernedActionDecisionRef;
  readonly executionId?: string;
}

/** Every result is a fresh, frozen object: nothing a consumer holds can reach back into orchestration state. */
function result(value: GovernedActionResult): GovernedActionResult {
  return deepFreeze({ ...value });
}

/** An execution identity already on record is answered from the record; the adapter is not invoked again. */
function replayResult(context: ResultContext, prior: PriorExecution, decisionReasonCodes: readonly string[]): GovernedActionResult {
  if (prior.outcome === 'executed') return result({ status: 'executed', ...context, reasonCodes: decisionReasonCodes, replayed: true, outcomeRecorded: true });
  if (prior.outcome === 'withheld' && prior.withheldReasonCodes !== undefined && prior.withheldBy !== undefined) {
    // The layer that withheld it is replayed as the layer that withheld it. A
    // stop cleared since does not turn a recorded emergency withholding into a
    // grant problem, and a stop active now does not turn a recorded grant
    // refusal into an emergency one: the record is what happened.
    //
    // `exercise-control` (P7) replays under the public `exercise` value, exactly
    // as it was reported live, with its own recorded EXERCISE_CONTROL_* codes.
    const withheldBy: GovernedActionWithheldBy = prior.withheldBy === 'emergency-control' ? 'emergency-control' : 'exercise';
    return result({ status: 'withheld', withheldBy, ...context, reasonCodes: prior.withheldReasonCodes });
  }
  const failure = prior.outcome?.startsWith('execution-failed:') === true ? prior.outcome.slice('execution-failed:'.length) : undefined;
  if (failure === 'PROVIDER_REJECTED' || failure === 'PROVIDER_UNAVAILABLE' || failure === 'PROVIDER_RESPONSE_INVALID' || failure === 'ADAPTER_ERROR') {
    return result({ status: 'execution_failed', ...context, failure, reasonCodes: [failure], replayed: true, outcomeRecorded: true });
  }
  // The adapter's own recorded answer was "contacted, result unknown". It is
  // replayed as exactly that — never as a failure, which would invite a retry
  // of an effect that may have happened — and with its own reason code, so it
  // stays distinguishable from the no-outcome-on-record case below.
  if (prior.outcome === EXECUTION_UNCONFIRMED_OUTCOME) {
    return result({ status: 'execution_unconfirmed', ...context, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED] });
  }
  // An attempt with no decodable outcome: a crash between claim and outcome,
  // or a row this ledger did not write. Unconfirmed too, for a different reason.
  return result({ status: 'execution_unconfirmed', ...context, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
}

/**
 * A P11 initial observation, replayed as exactly what it recorded.
 *
 * Certainty first: `confirmed-completed` is `executed` (with the provider
 * reference it was recorded with), `confirmed-not-completed` is
 * `execution_failed` with its recorded reason, and `unconfirmed` stays
 * unconfirmed with its own reason code — never a failure. A withholding is the
 * layer that withheld it, in its own vocabulary, exactly as the legacy replay
 * reports one.
 */
function replayObservation(context: ResultContext, observation: ExecutionTerminalObservation, decisionReasonCodes: readonly string[]): GovernedActionResult {
  if (observation.kind === 'withheld') {
    const withheldBy: GovernedActionWithheldBy = observation.withheldBy === 'emergency-control' ? 'emergency-control' : 'exercise';
    return result({ status: 'withheld', withheldBy, ...context, reasonCodes: [...observation.reasonCodes] });
  }
  switch (observation.certainty) {
    case 'confirmed-completed':
      return result({
        status: 'executed',
        ...context,
        reasonCodes: decisionReasonCodes,
        ...(observation.providerRef !== undefined ? { providerRef: observation.providerRef } : {}),
        replayed: true,
        outcomeRecorded: true,
      });
    case 'confirmed-not-completed':
      return result({ status: 'execution_failed', ...context, failure: observation.failure, reasonCodes: [observation.failure], replayed: true, outcomeRecorded: true });
    case 'unconfirmed':
      return result({ status: 'execution_unconfirmed', ...context, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED] });
    default: {
      const unreachable: never = observation;
      return unreachable;
    }
  }
}

/**
 * A verified P12 definitive resolution, replayed through the existing v1
 * statuses. `providerRef`: the resolution's when it learned one, otherwise the
 * P11 observation's — both stay intact in their own immutable records.
 */
function replayResolution(context: ResultContext, resolution: ExecutionResolutionRecord, observedProviderRef: string | undefined, decisionReasonCodes: readonly string[]): GovernedActionResult {
  if (resolution.certainty === 'confirmed-completed') {
    const providerRef = resolution.providerRef ?? observedProviderRef;
    return result({ status: 'executed', ...context, reasonCodes: decisionReasonCodes, ...(providerRef !== undefined ? { providerRef } : {}), replayed: true, outcomeRecorded: true });
  }
  const failure = resolution.failure;
  if (failure === undefined) return unresolvedResult(context);
  return result({ status: 'execution_failed', ...context, failure, reasonCodes: [failure], replayed: true, outcomeRecorded: true });
}

/** Attempted, and no initial observation can be established: a crash between claim and observation, or a record that cannot be read or verified. Never retried. */
function unresolvedResult(context: ResultContext): GovernedActionResult {
  return result({ status: 'execution_unconfirmed', ...context, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
}

/**
 * The runtime's outcome as the one initial observation P11 records, or
 * `undefined` when it cannot be recorded exactly.
 *
 * Every value is the trusted runtime's: the certainty derived from the status
 * (never stored beside it), the attribution `GrantExecutionService`
 * authenticated, the reference it already filtered, the failure from the closed
 * vocabulary, the withholding layer's own codes. No `detail`, no amount, no
 * correlation — the amount and correlation are the prepared attempt's. An
 * attribution that is not a recordable identity (a directly composed adapter
 * with an exotic id) cannot be recorded exactly, and is not recorded
 * approximately either: the execution then stays "attempted, outcome not on
 * record". A routing boundary that is not recordable is omitted, as the
 * evidence stream omits it.
 */
function observationOf(outcome: ExecutionOutcome, observedAt: string): ExecutionTerminalObservation | undefined {
  if (outcome.status === 'withheld') {
    switch (outcome.withheldBy) {
      case 'emergency-control':
        return { kind: 'withheld', withheldBy: 'emergency-control', reasonCodes: [...outcome.emergencyControl.reasonCodes], observedAt };
      case 'exercise-control':
        return { kind: 'withheld', withheldBy: 'exercise-control', reasonCodes: [...outcome.exerciseControl.reasonCodes], observedAt };
      case 'grant-exercise':
        return { kind: 'withheld', withheldBy: 'grant-exercise', reasonCodes: [...outcome.assessment.reasonCodes], observedAt };
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  }
  if (!isRecordableExecutionAdapterId(outcome.adapterId)) return undefined;
  const attribution = { adapterId: outcome.adapterId, ...(outcome.routedBy !== undefined && isRecordableExecutionAdapterId(outcome.routedBy) ? { routedBy: outcome.routedBy } : {}) };
  const reference = outcome.providerRef !== undefined ? { providerRef: outcome.providerRef } : {};
  switch (outcome.status) {
    case 'executed':
      return { kind: 'provider', certainty: providerEffectCertaintyOf(outcome.status), ...attribution, ...reference, observedAt };
    case 'execution-failed':
      return { kind: 'provider', certainty: providerEffectCertaintyOf(outcome.status), ...attribution, ...reference, failure: outcome.reason, observedAt };
    case 'execution-unconfirmed':
      return { kind: 'provider', certainty: providerEffectCertaintyOf(outcome.status), ...attribution, ...reference, observedAt };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/** The exercise request, built from the verified request and the grant — never from the caller's object. */
function exerciseFor(verified: VerifiedDecision, scope: BoundActorScope, grant: { readonly id: string; readonly correlation: GrantCorrelation }, executionId: string): GrantExerciseRequest {
  const { request } = verified;
  return {
    boundedGrantId: grant.id,
    subject: scope.actorId,
    action: grant.correlation.action,
    resource: request.action.resourceScope,
    ...(request.action.counterpartyId !== undefined ? { counterparty: request.action.counterpartyId } : {}),
    ...(request.organization !== undefined ? { organization: request.organization.id } : {}),
    ...(request.action.amount !== undefined && request.action.currency !== undefined ? { amount: { value: request.action.amount, unit: request.action.currency } } : {}),
    correlation: grant.correlation,
    executionId,
  };
}

/**
 * The orchestrator sequences four phases, each owned elsewhere:
 *
 * - **identity → request**  `kernel-request.ts`
 * - **commit + verify**     `decision-commit.ts` — the only producer of a `VerifiedDecision`
 * - **issuance**            ACE's issuance core, from the `VerifiedDecision` only
 * - **evidence + claim**    `execution-ledger.ts`; exercise is ACE's
 *
 * What stays here is the order between them and the mapping of each phase's
 * outcome onto a `GovernedActionResult`.
 */
export function createGovernedActionOrchestrator(options: GovernedActionOrchestratorOptions): GovernedActionOrchestrator {
  const { organizationId: servedOrganizationId, issuance, execution, governanceStore: store, grantPolicy, monetary, now } = options;
  if (
    monetary === null ||
    typeof monetary !== 'object' ||
    typeof monetary.assets?.resolve !== 'function' ||
    typeof monetary.actionClassifier?.classify !== 'function'
  ) {
    throw new GovernedActionConfigurationError('GOVERNED_ACTION_CONFIGURATION_INVALID', 'Governed actions require the trusted monetary configuration: an asset registry and a financial action classifier.');
  }
  const executionOutcomes = options.executionOutcomes;
  if (
    executionOutcomes === null ||
    typeof executionOutcomes !== 'object' ||
    typeof executionOutcomes.prepareAttempt !== 'function' ||
    typeof executionOutcomes.recordTerminal !== 'function' ||
    typeof executionOutcomes.read !== 'function'
  ) {
    throw new GovernedActionConfigurationError('GOVERNED_ACTION_CONFIGURATION_INVALID', 'Governed actions require a durable execution outcome store: no execution runs without its exact context durably prepared.');
  }
  const executionResolution = options.executionResolution;
  if (
    executionResolution !== undefined &&
    (executionResolution === null ||
      typeof executionResolution !== 'object' ||
      typeof executionResolution.binder?.bindBeforeClaim !== 'function' ||
      typeof executionResolution.reader?.read !== 'function')
  ) {
    throw new GovernedActionConfigurationError('GOVERNED_ACTION_CONFIGURATION_INVALID', 'Execution reconciliation, when enabled, requires a resolution-authority binder and a resolution reader.');
  }
  const hostRevalidateSource = options.revalidateSource;
  const emergencyControl = options.emergencyControl;
  const evidence = options.evidence;
  const committer = createDecisionCommitter({
    store,
    issuance,
    trustDomainId: options.trustDomainId,
    now,
    enterpriseContext: options.enterpriseContext,
    events: options.events,
    traceLevel: options.traceLevel,
  });

  /** Trusted grant terms. A throwing or empty policy establishes no expiry, and no expiry means no grant. */
  function termsFor(scope: BoundActorScope, verified: VerifiedDecision): GovernedActionGrantTerms | undefined {
    let terms: GovernedActionGrantTerms | undefined;
    try {
      terms = grantPolicy({
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        action: verified.request.action.type,
        resource: verified.request.action.resourceScope,
        requestId: verified.request.requestId,
        decisionId: verified.decision.decisionId,
        evaluatedAt: verified.decision.evaluatedAt,
        now: now(),
      });
    } catch {
      return undefined;
    }
    return terms !== undefined && typeof terms.grantExpiresAt === 'string' && terms.grantExpiresAt.length > 0 ? terms : undefined;
  }

  /**
   * The synchronous commit-boundary source. A foreign correlation is refused.
   * Without a host revalidator it is the frozen snapshot projected from the
   * committed record — no I/O, every Store read finished before issuance began.
   * With one, it is whatever the host reports as the source *now*, unchanged:
   * the grant's identity and `sourceDigest` are still derived from the
   * committed record, but the commit guard re-proves the grant against the
   * current authorization, so a source that has narrowed since refuses the
   * issuance rather than being masked by the persisted snapshot.
   */
  function persistedSourceGuard(verified: VerifiedDecision): (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined {
    const source = verified.source;
    return (correlation) => {
      if (!grantCorrelationMatches(correlation, source.correlation)) return undefined;
      if (hostRevalidateSource === undefined) return source;
      return hostRevalidateSource(correlation);
    };
  }

  /**
   * Evidence, strictly downstream and strictly non-blocking. The recorder
   * enqueues and returns `void`, so there is nothing to await here and nothing
   * this path can be held by: order within a lifecycle is the projector's
   * per-stream queue, not this function's control flow. A recorder that throws
   * synchronously is discarded, and a projection that fails leaves the evidence
   * stream short — never the authority, the grant, the claim or the outcome
   * different.
   */
  function report(fact: (recorder: AuthorityEventRecorder) => void): void {
    if (evidence === undefined) return;
    try {
      fact(evidence);
    } catch {
      // Evidence never changes an outcome that was already reached.
    }
  }

  /**
   * Replay of a claimed execution identity. The canonical P11 record decides
   * whenever one exists; the pre-P11 outcome reference decides only for an
   * execution that has none. A record that cannot be read or verified is never
   * interpreted optimistically — and never falls back to anything else — it is
   * "attempted, outcome not on record". No adapter, no provider and no P8
   * event is consulted.
   */
  async function replayExecution(outcomeScope: ExecutionOutcomeAccessContext, context: ResultContext, executionId: string, prior: PriorExecution, decisionReasonCodes: readonly string[]): Promise<GovernedActionResult> {
    let durable;
    try {
      durable = await executionOutcomes.read(outcomeScope, executionId);
    } catch {
      return unresolvedResult(context);
    }
    if (durable === undefined) return replayResult(context, prior, decisionReasonCodes);
    const observation = durable.terminal?.observation;
    // P12 precedence, only for what P11 left uncertain. A definitive P11
    // observation or a withholding is answered by P11 alone, whatever the
    // optional resolution store would say or fail to say.
    const uncertain = observation === undefined || (observation.kind === 'provider' && observation.certainty === 'unconfirmed');
    if (uncertain && executionResolution !== undefined) {
      let resolution: ExecutionResolutionRecord | undefined;
      try {
        resolution = (await executionResolution.reader.read(outcomeScope, executionId))?.resolution;
      } catch {
        // Unreadable or corrupt: never an answer, never a fallback to anything
        // optimistic. P11's own uncertain answer below stands.
        resolution = undefined;
      }
      // Believed only when it resolves exactly this attempt and exactly this uncertainty.
      if (resolution !== undefined && resolution.attemptDigest === durable.attempt.attemptDigest && resolution.basisObservationDigest === durable.terminal?.observationDigest) {
        return replayResolution(context, resolution, observation?.kind === 'provider' ? observation.providerRef : undefined, decisionReasonCodes);
      }
    }
    if (observation === undefined) return unresolvedResult(context);
    return replayObservation(context, observation, decisionReasonCodes);
  }

  /** Expiry is observed, never scheduled: reported only when an assessment of this grant actually found it. */
  function observedExpiry(assessment: BoundedGrantExerciseAssessment): boolean {
    return assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED);
  }

  return Object.freeze({
    organizationId: servedOrganizationId,

    async govern(identity: BoundCustomerIdentity, rawIntent: unknown): Promise<GovernedActionResult> {
      // Identity: trusted, read, never widened. Intent: untrusted, validated closed.
      const scope = boundScopeOf(identity, servedOrganizationId);
      if (scope === undefined) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_IDENTITY_INVALID] });
      const validation = validateGovernedActionIntent(rawIntent, monetary);
      if (!validation.valid) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_INTENT_INVALID] });
      const intent = validation.intent;

      // Server-derived request identity, and the tenant scope every Store call
      // runs under — the bound organization and its actor, never a system context.
      const requestId = deriveGovernedActionRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, idempotencyKey: intent.idempotencyKey });
      const accessContext: GovernanceStoreAccessContext = { system: false, organizationId: scope.organizationId, actorId: scope.actorId };
      // The same tenant scope for the execution outcome store. It has no system escape at all.
      const outcomeScope: ExecutionOutcomeAccessContext = { organizationId: scope.organizationId };
      const base: ResultContext = { requestId, ...(intent.correlationId !== undefined ? { correlationId: intent.correlationId } : {}) };

      // Phase: commit + verify. Nothing below runs without a VerifiedDecision.
      const committed = await committer.commit({
        scope,
        intent,
        requestId,
        accessContext,
        idempotency: { idempotencyKey: intent.idempotencyKey, scope: governedActionIdempotencyScope({ organizationId: scope.organizationId, principalId: scope.principalId }) },
      });
      if (committed.kind === 'stopped') return result({ status: committed.status, ...base, reasonCodes: [committed.reasonCode] });
      const verified = committed.verified;
      const { decision: persisted, record } = verified;
      // The committed, re-read and verified record — every status, and every
      // replay of it, which the stream resolves to the event already recorded.
      report((recorder) => recorder.decisionCommitted(record));
      const decided: ResultContext = {
        ...base,
        decision: { decisionId: persisted.decisionId, evaluationId: record.evaluation.evaluationId, status: persisted.status, reasonCodes: persisted.reasonCodes },
      };

      // The Kernel's status, restated — never reinterpreted.
      if (persisted.status === 'denied') return result({ status: 'denied', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'indeterminate') return result({ status: 'indeterminate', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'approval_required') return result({ status: 'withheld', withheldBy: 'approval', ...decided, reasonCodes: persisted.reasonCodes });

      // Phase: replay. An execution identity already on the committed record is
      // answered from that record, before any mutable gate runs: grant terms,
      // authority binding, source revalidation and issuance describe what may
      // happen *now*, and none of them may rewrite what already happened. A
      // caller recovering from a lost response learns the recorded outcome, and
      // no new grant is minted to tell them.
      const ledger = createExecutionLedger(store, accessContext, now);
      const evaluationId = record.evaluation.evaluationId;
      const executionId = deriveGovernedActionExecutionId({ requestId, decisionId: persisted.decisionId });
      const executed: ResultContext = { ...decided, executionId };
      const known = ledger.prior(record, executionId);
      if (known.attempted) return replayExecution(outcomeScope, executed, executionId, known, persisted.reasonCodes);

      // Phase: emergency-control admission. Deliberately **after** replay and
      // **before** grantPolicy.
      //
      // After replay, because an administrative stop declared today must not
      // rewrite what an action did yesterday: a retry of an execution identity
      // already on the record is answered from the record, and current
      // operational state is not evidence about a past effect.
      //
      // Before grantPolicy, because the next thing that happens is the minting
      // of *new bounded authority*, and an action nobody has attempted must not
      // acquire authority while execution is stopped. Withholding here also
      // means no grant exists to have to reason about afterwards.
      //
      // The query is trusted server-side material only: the bound organization,
      // the bound actor, and the resource scope the committed decision was
      // evaluated for. No adapter (routing has not run, and inventing one would
      // apply an adapter-scoped stop to an adapter that may never be selected)
      // and no workflow (no canonical trusted source exists).
      const admission = readEmergencyControl(emergencyControl, {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        resource: verified.request.action.resourceScope,
      });
      if (!emergencyControlPermits(admission)) {
        return result({ status: 'withheld', withheldBy: 'emergency-control', ...decided, reasonCodes: admission.reasonCodes });
      }

      const terms = termsFor(scope, verified);
      if (terms === undefined) return result({ status: 'withheld', withheldBy: 'grant-terms', ...decided, reasonCodes: [R.GOVERNED_ACTION_GRANT_TERMS_UNAVAILABLE] });

      // Phase: issuance — ACE's, unchanged, from the persisted decision only.
      let authorization;
      try {
        authorization = await issuance.issueFromDecision({
          request: verified.request,
          decision: persisted,
          grantExpiresAt: terms.grantExpiresAt,
          ...(terms.requestedBounds !== undefined ? { requestedBounds: terms.requestedBounds } : {}),
          revalidateSource: persistedSourceGuard(verified),
        });
      } catch (error) {
        return result({ status: 'system_error', ...decided, reasonCodes: [isExecutionGovernanceError(error) ? R.GOVERNED_ACTION_COMPOSITION_INVALID : R.GOVERNED_ACTION_GRANT_ISSUANCE_FAILED] });
      }
      if (authorization.outcome === 'authority-binding-unresolved') {
        return result({ status: 'withheld', withheldBy: 'authority-binding', ...decided, reasonCodes: authorization.reasonCodes });
      }
      // The commit-boundary interlock fired: a stop turned on, or became
      // unreadable, between admission above and the store's critical section.
      // No grant was committed, so there is nothing to revoke and nothing to
      // exercise.
      if (authorization.outcome === 'emergency-control-withheld') {
        return result({ status: 'withheld', withheldBy: 'emergency-control', ...decided, reasonCodes: authorization.reasonCodes });
      }
      // P10: a financial action whose durable monetary authority could not be
      // established — or whose requested amount exceeds it. The Kernel decision
      // stands exactly as committed; no grant exists, so no reservation and no
      // adapter call can follow. Publicly it is an authority-binding
      // withholding (the wire union is unchanged), carrying the
      // FINANCIAL_AUTHORITY_* code that explains it.
      if (authorization.outcome === 'financial-authority-withheld') {
        return result({ status: 'withheld', withheldBy: 'authority-binding', ...decided, reasonCodes: authorization.reasonCodes });
      }
      if (authorization.outcome === 'grant-withheld') {
        const withheldBy: GovernedActionWithheldBy = authorization.reasonCodes.includes(GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED) ? 'obligations' : 'grant';
        return result({ status: 'withheld', withheldBy, ...decided, reasonCodes: authorization.reasonCodes });
      }
      const { grant } = authorization;
      if (grant.subject !== scope.actorId || grant.correlation.requestId !== requestId || grant.correlation.decisionId !== persisted.decisionId) {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH] });
      }
      report((recorder) => recorder.grantIssued(grant));

      // Phase: evidence + claim, then exercise.
      try {
        await ledger.recordAuthorization(evaluationId, grant);
      } catch {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED] });
      }

      const exercise = exerciseFor(verified, scope, grant, executionId);

      // Pre-assessment through ACE. A pure read: no provider is contacted.
      const assessment = await execution.assessExercise(exercise);
      if (!assessment.usable) {
        if (observedExpiry(assessment)) report((recorder) => recorder.grantExpiryObserved(grant));
        return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: assessment.reasonCodes });
      }

      // P11 preparation, BEFORE the claim and therefore before any adapter: the
      // exact context this execution will run under, from trusted values only —
      // the committed decision's identifiers, the issued grant's id, and the
      // exercise request's action and amount, which `GrantExecutionService`
      // hands to the adapter verbatim as `ValidatedExecutionAction.amount`.
      // Idempotent: a request that crashed after preparing and before claiming
      // finds its own attempt on retry. A preparation that cannot be proven
      // written stops here — no claim, no adapter, nothing stranded — and is
      // reported in the narrowest existing vocabulary: the write-ahead
      // execution record could not be established.
      let prepared;
      try {
        prepared = await executionOutcomes.prepareAttempt(outcomeScope, {
          organizationId: scope.organizationId,
          executionId,
          evaluationId,
          requestId,
          decisionId: persisted.decisionId,
          boundedGrantId: grant.id,
          action: exercise.action,
          ...(exercise.amount !== undefined ? { amount: { value: exercise.amount.value, unit: exercise.amount.unit } } : {}),
          preparedAt: now(),
        });
      } catch {
        return result({ status: 'system_error', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED] });
      }

      // P12, when enabled: the trusted resolution authority that may later
      // resolve this exact attempt, bound durably BEFORE the claim — so no
      // effect runs that reconciliation already knows it could not resolve,
      // and a crash after the claim never has to guess who may. Same posture
      // as a failed preparation: nothing claimed, no adapter, safe to retry.
      if (executionResolution !== undefined) {
        let bound = false;
        try {
          bound = await executionResolution.binder.bindBeforeClaim(prepared.attempt);
        } catch {
          bound = false;
        }
        if (!bound) return result({ status: 'system_error', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED] });
      }

      // Write-ahead claim, BEFORE the adapter. It can only prevent an invocation.
      let claim;
      try {
        claim = await ledger.claim(evaluationId, executionId);
      } catch {
        return result({ status: 'system_error', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED] });
      }
      if (claim.kind === 'already-claimed') return replayExecution(outcomeScope, executed, executionId, claim.prior, persisted.reasonCodes);
      // Enqueued, not awaited: no evidence write may sit between the durable
      // claim and the adapter crossing.
      report((recorder) => recorder.executionClaimed({ evaluationId, executionId, grant, claimedAt: claim.claimedAt }));

      // Exercise through ACE: the grant is re-read from the authoritative store
      // and the adapter receives a ValidatedExecutionAction only.
      let outcome: ExecutionOutcome;
      try {
        outcome = await execution.exercise(exercise);
      } catch {
        // Whether the adapter ran is unknown. It is not retried.
        return result({ status: 'execution_unconfirmed', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
      }

      // P11: the initial observation, sampled from the injected clock after the
      // runtime returned — after the adapter's result was normalized and P7
      // finalized — and recorded once, immutably. A failure to record it never
      // rewrites what happened: the result below is still built from `outcome`,
      // P7's settle or release already stands, and nothing is retried. It only
      // means a later replay cannot reconstruct this answer, and says so.
      let terminal: ExecutionTerminalRecord | undefined;
      const observation = observationOf(outcome, now());
      if (observation !== undefined) {
        try {
          terminal = (await executionOutcomes.recordTerminal(outcomeScope, { organizationId: scope.organizationId, executionId, observation })).terminal;
        } catch {
          terminal = undefined;
        }
      }
      // `outcomeRecorded` is the canonical fact: the initial observation is durable.
      const outcomeRecorded = terminal !== undefined;
      const unrecorded = outcomeRecorded ? [] : [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED];
      // The compact Governance summary, only after the canonical observation
      // exists, pointing at it by digest. Evidence: its failure leaves the
      // canonical record, the result and the replay exactly as they are.
      if (terminal !== undefined) await ledger.recordOutcome(evaluationId, executionId, outcome, terminal.observationDigest);
      // What the runtime returned, with its certainty intact. Reported after the
      // outcome exists; the result below is built from `outcome`, never from this.
      report((recorder) => recorder.executionOutcomeObserved({ evaluationId, executionId, grant, outcome, outcomeRecorded }));
      if (outcome.status === 'withheld' && outcome.withheldBy === 'grant-exercise' && observedExpiry(outcome.assessment)) {
        report((recorder) => recorder.grantExpiryObserved(grant));
      }
      if (outcome.status === 'executed') {
        return result({
          status: 'executed',
          ...executed,
          reasonCodes: [...persisted.reasonCodes, ...unrecorded],
          ...(outcome.providerRef !== undefined ? { providerRef: outcome.providerRef } : {}),
          replayed: false,
          outcomeRecorded,
        });
      }
      if (outcome.status === 'withheld') {
        // Two layers can withhold at effect time, and they are reported in
        // their own vocabularies. The emergency case carries no exercise reason
        // codes because there are none: the assessment was *usable*, and what
        // stopped the effect was the interlock.
        if (outcome.withheldBy === 'emergency-control') {
          return result({ status: 'withheld', withheldBy: 'emergency-control', ...executed, reasonCodes: [...outcome.emergencyControl.reasonCodes, ...unrecorded] });
        }
        // P7: an aggregate / velocity limit or exercise-time binding
        // revalidation withheld it. Internally its own layer; publicly the
        // existing `exercise` value — the wire union is unchanged — carrying the
        // EXERCISE_CONTROL_* codes that explain it. No limit, bucket,
        // reservation or remaining capacity is ever part of the result.
        if (outcome.withheldBy === 'exercise-control') {
          return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: [...outcome.exerciseControl.reasonCodes, ...unrecorded] });
        }
        return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: [...outcome.assessment.reasonCodes, ...unrecorded] });
      }
      if (outcome.status === 'execution-unconfirmed') {
        // The adapter ran and says it cannot know whether the provider acted.
        // Same public status as a lost outcome, its own reason code, and no
        // retry: the write-ahead claim already forbids a second invocation of
        // this execution identity.
        return result({ status: 'execution_unconfirmed', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED, ...unrecorded] });
      }
      return result({ status: 'execution_failed', ...executed, failure: outcome.reason, reasonCodes: [outcome.reason, ...unrecorded], replayed: false, outcomeRecorded });
    },
  });
}
