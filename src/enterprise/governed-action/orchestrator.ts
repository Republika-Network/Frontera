import { GRANT_REASON_CODES, grantCorrelationMatches, type GrantCorrelation, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import type { ExecutionOutcome, GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { EnterpriseEventPublisher } from '../events/enterprise-events.js';
import { isExecutionGovernanceError, type AuthorityControlledExecutionService } from '../execution-governance/index.js';
import type { AuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import type { GovernanceEnterpriseContext, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  GOVERNED_ACTION_REASON_CODES as R,
  type GovernedActionDecisionRef,
  type GovernedActionGrantPolicy,
  type GovernedActionGrantTerms,
  type GovernedActionResult,
  type GovernedActionWithheldBy,
} from './contracts.js';
import { createDecisionCommitter, type VerifiedDecision } from './decision-commit.js';
import { createExecutionLedger, type PriorExecution } from './execution-ledger.js';
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
 *   -> execution_record write-ahead claim         durable, at most once per execution id
 *   -> ACE exercise -> ExecutionAdapter           ValidatedExecutionAction only
 *   -> execution outcome reference
 * ```
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
  if (prior.outcome === 'withheld') return result({ status: 'withheld', withheldBy: 'exercise', ...context, reasonCodes: [] });
  const failure = prior.outcome?.startsWith('execution-failed:') === true ? prior.outcome.slice('execution-failed:'.length) : undefined;
  if (failure === 'PROVIDER_REJECTED' || failure === 'PROVIDER_UNAVAILABLE' || failure === 'PROVIDER_RESPONSE_INVALID' || failure === 'ADAPTER_ERROR') {
    return result({ status: 'execution_failed', ...context, failure, reasonCodes: [failure], replayed: true, outcomeRecorded: true });
  }
  return result({ status: 'execution_unconfirmed', ...context, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
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
  const { organizationId: servedOrganizationId, issuance, execution, governanceStore: store, grantPolicy, now } = options;
  const hostRevalidateSource = options.revalidateSource;
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

  return Object.freeze({
    organizationId: servedOrganizationId,

    async govern(identity: BoundCustomerIdentity, rawIntent: unknown): Promise<GovernedActionResult> {
      // Identity: trusted, read, never widened. Intent: untrusted, validated closed.
      const scope = boundScopeOf(identity, servedOrganizationId);
      if (scope === undefined) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_IDENTITY_INVALID] });
      const validation = validateGovernedActionIntent(rawIntent);
      if (!validation.valid) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_INTENT_INVALID] });
      const intent = validation.intent;

      // Server-derived request identity, and the tenant scope every Store call
      // runs under — the bound organization and its actor, never a system context.
      const requestId = deriveGovernedActionRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, idempotencyKey: intent.idempotencyKey });
      const accessContext: GovernanceStoreAccessContext = { system: false, organizationId: scope.organizationId, actorId: scope.actorId };
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
      const decided: ResultContext = {
        ...base,
        decision: { decisionId: persisted.decisionId, evaluationId: record.evaluation.evaluationId, status: persisted.status, reasonCodes: persisted.reasonCodes },
      };

      // The Kernel's status, restated — never reinterpreted.
      if (persisted.status === 'denied') return result({ status: 'denied', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'indeterminate') return result({ status: 'indeterminate', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'approval_required') return result({ status: 'withheld', withheldBy: 'approval', ...decided, reasonCodes: persisted.reasonCodes });

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
      if (authorization.outcome === 'grant-withheld') {
        const withheldBy: GovernedActionWithheldBy = authorization.reasonCodes.includes(GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED) ? 'obligations' : 'grant';
        return result({ status: 'withheld', withheldBy, ...decided, reasonCodes: authorization.reasonCodes });
      }
      const { grant } = authorization;
      if (grant.subject !== scope.actorId || grant.correlation.requestId !== requestId || grant.correlation.decisionId !== persisted.decisionId) {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH] });
      }

      // Phase: evidence + claim, then exercise.
      const ledger = createExecutionLedger(store, accessContext, now);
      const evaluationId = record.evaluation.evaluationId;
      try {
        await ledger.recordAuthorization(evaluationId, grant);
      } catch {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED] });
      }

      const executionId = deriveGovernedActionExecutionId({ requestId, decisionId: persisted.decisionId });
      const executed: ResultContext = { ...decided, executionId };
      const exercise = exerciseFor(verified, scope, grant, executionId);

      const known = ledger.prior(record, executionId);
      if (known.attempted) return replayResult(executed, known, persisted.reasonCodes);

      // Pre-assessment through ACE. A pure read: no provider is contacted.
      const assessment = await execution.assessExercise(exercise);
      if (!assessment.usable) return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: assessment.reasonCodes });

      // Write-ahead claim, BEFORE the adapter. It can only prevent an invocation.
      let claim;
      try {
        claim = await ledger.claim(evaluationId, executionId);
      } catch {
        return result({ status: 'system_error', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED] });
      }
      if (claim.kind === 'already-claimed') return replayResult(executed, claim.prior, persisted.reasonCodes);

      // Exercise through ACE: the grant is re-read from the authoritative store
      // and the adapter receives a ValidatedExecutionAction only.
      let outcome: ExecutionOutcome;
      try {
        outcome = await execution.exercise(exercise);
      } catch {
        // Whether the adapter ran is unknown. It is not retried.
        return result({ status: 'execution_unconfirmed', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
      }

      // Outcome evidence. A failure to record it never rewrites what happened.
      const outcomeRecorded = await ledger.recordOutcome(evaluationId, executionId, outcome);
      const unrecorded = outcomeRecorded ? [] : [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED];
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
        return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: [...outcome.assessment.reasonCodes, ...unrecorded] });
      }
      return result({ status: 'execution_failed', ...executed, failure: outcome.reason, reasonCodes: [outcome.reason, ...unrecorded], replayed: false, outcomeRecorded });
    },
  });
}
