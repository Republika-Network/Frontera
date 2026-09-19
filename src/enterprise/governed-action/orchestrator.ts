import {
  GRANT_REASON_CODES,
  grantCorrelationMatches,
  grantSourceDigest,
  type BoundedGrant,
  type GrantCorrelation,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import type { ExecutionOutcome, GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import { KernelValidationError, type KernelEvaluationRequest, type KernelEvaluationResult } from '../../kernel/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import type { EnterpriseEvent, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent } from '../events/enterprise-events.js';
import { isExecutionGovernanceError, type AuthorityControlledExecutionService } from '../execution-governance/index.js';
import type { AuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import type {
  AppendGovernanceEvaluationResult,
  GovernanceEnterpriseContext,
  GovernanceIdempotencyContext,
  GovernanceIdempotencyResolution,
  GovernanceRecord,
  GovernanceReferenceInput,
  GovernanceStoreAccessContext,
} from '../governance-store/contracts.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { deepFreeze, toKernelEvaluationResult } from '../governance-store/store-common.js';
import { buildGovernanceEvaluationOutcomeEvent } from '../orchestration/governance-evaluation-events.js';
import {
  GOVERNED_ACTION_REASON_CODES,
  type GovernedActionDecisionRef,
  type GovernedActionGrantPolicy,
  type GovernedActionGrantTerms,
  type GovernedActionIntent,
  type GovernedActionResult,
  type GovernedActionWithheldBy,
} from './contracts.js';
import {
  authorizationReferenceId,
  deriveGovernedActionExecutionId,
  deriveGovernedActionRequestId,
  executionAttemptReferenceId,
  executionOutcomeReferenceId,
  governedActionIdempotencyScope,
} from './identifiers.js';
import { validateGovernedActionIntent } from './intent.js';

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
   * On this path the committed record *is* the source, so it is not consulted
   * for a source — but it keeps its veto: answering `undefined` refuses.
   */
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
}

export interface GovernedActionOrchestrator {
  readonly organizationId: string;
  /** Govern one intended action on behalf of a bound customer identity. Never throws for a governance outcome; every outcome is a result. */
  govern(identity: BoundCustomerIdentity, intent: unknown): Promise<GovernedActionResult>;
}

interface BoundActorScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly actorId: string;
}

/** Why the committed-decision step stopped short, in result form. */
type CommitOutcome =
  | { readonly kind: 'committed'; readonly request: KernelEvaluationRequest; readonly evaluationId: string; readonly aggregateDigest: string; readonly transient?: KernelEvaluationResult }
  | { readonly kind: 'stopped'; readonly result: GovernedActionResult };

const R = GOVERNED_ACTION_REASON_CODES;

/**
 * Reads only the fields the orchestrator needs, and only if they are what a
 * bound customer identity must be. Nothing else on the object is read — a
 * `system: true` or `actorId` attached anywhere else is invisible here.
 */
function boundScopeOf(identity: BoundCustomerIdentity, servedOrganizationId: string): BoundActorScope | undefined {
  const principal = (identity as { readonly principal?: unknown } | null | undefined)?.principal as Record<string, unknown> | undefined;
  const actor = (identity as { readonly actor?: unknown } | null | undefined)?.actor as Record<string, unknown> | undefined;
  if (principal === undefined || principal === null || typeof principal !== 'object') return undefined;
  if (actor === undefined || actor === null || typeof actor !== 'object') return undefined;
  const { plane, principalId, organizationId } = principal;
  const { actorId } = actor;
  if (plane !== 'customer') return undefined;
  if (!isCanonicalCustomerIdentifier(principalId) || !isCanonicalCustomerIdentifier(organizationId) || !isCanonicalCustomerIdentifier(actorId)) return undefined;
  if (organizationId !== servedOrganizationId) return undefined;
  return { organizationId, principalId, actorId };
}

export function createGovernedActionOrchestrator(options: GovernedActionOrchestratorOptions): GovernedActionOrchestrator {
  const { organizationId: servedOrganizationId, trustDomainId, issuance, execution, governanceStore: store, grantPolicy, now, enterpriseContext, events, traceLevel } = options;
  const hostRevalidateSource = options.revalidateSource;

  /**
   * The Kernel request, built on the server. Actor and organization come from
   * the bound identity and from nowhere else; the intent contributes only the
   * axes it declares.
   */
  function buildKernelRequest(scope: BoundActorScope, intent: GovernedActionIntent, requestId: string, requestedAt: string): KernelEvaluationRequest {
    return {
      requestId,
      actor: { id: scope.actorId, trustDomainId },
      organization: { id: scope.organizationId },
      action: {
        type: intent.action,
        resourceScope: intent.resource,
        ...(intent.counterparty !== undefined ? { counterpartyId: intent.counterparty } : {}),
        ...(intent.amount !== undefined ? { amount: intent.amount.value, currency: intent.amount.currency } : {}),
      },
      ...(intent.assertedContext !== undefined ? { context: intent.assertedContext } : {}),
      requestedAt,
      ...(intent.correlationId !== undefined ? { correlationId: intent.correlationId } : {}),
    };
  }

  /** Every result is a fresh, frozen object: nothing a consumer holds can reach back into orchestration state. */
  function result(value: GovernedActionResult): GovernedActionResult {
    return deepFreeze({ ...value });
  }

  /**
   * Resolves idempotency through the Store's own machinery, before the Kernel.
   *
   * `requestedAt` is part of the persisted request, so a retry must rebuild
   * the request with the *original* instant to compare like with like: the
   * existing record for this server-derived request id, when there is one,
   * supplies it. The comparison itself is the Store's — payload digest against
   * the tenant-scoped idempotency claim and the request-id row.
   */
  async function resolve(
    scope: BoundActorScope,
    intent: GovernedActionIntent,
    requestId: string,
    accessContext: GovernanceStoreAccessContext,
    idempotency: GovernanceIdempotencyContext,
  ): Promise<{ readonly request: KernelEvaluationRequest; readonly resolution: GovernanceIdempotencyResolution }> {
    const existing = await store.getByRequestId(accessContext, requestId);
    const request = buildKernelRequest(scope, intent, requestId, existing?.request.requestedAt ?? now());
    const resolution = await store.resolveIdempotency(accessContext, { requestId, payloadDigest: computeGovernanceRequestPayloadDigest(request), idempotency });
    return { request, resolution };
  }

  async function publishBestEffort(event: EnterpriseEvent): Promise<void> {
    try {
      await events.publisher.publish(event);
    } catch {
      // Operational signal only; the durable copy of every evaluation event is in the committed aggregate.
    }
  }

  /**
   * Steps 5-7: idempotency, Kernel, commit. Returns the committed record's
   * identity — never a decision that was not durably recorded.
   */
  async function commitDecision(
    scope: BoundActorScope,
    intent: GovernedActionIntent,
    requestId: string,
    accessContext: GovernanceStoreAccessContext,
    idempotency: GovernanceIdempotencyContext,
  ): Promise<CommitOutcome> {
    const correlationId = intent.correlationId;
    const stopped = (status: 'rejected' | 'system_error', code: string): CommitOutcome => ({
      kind: 'stopped',
      result: result({ status, requestId, ...(correlationId !== undefined ? { correlationId } : {}), reasonCodes: [code] }),
    });

    let resolved;
    try {
      resolved = await resolve(scope, intent, requestId, accessContext, idempotency);
    } catch {
      return stopped('system_error', R.GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED);
    }
    if (resolved.resolution.kind === 'conflict') return stopped('rejected', R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT);
    if (resolved.resolution.kind === 'replay') {
      // The original committed decision is the answer. The Kernel is not re-run.
      const record = resolved.resolution.record;
      return { kind: 'committed', request: resolved.request, evaluationId: record.evaluation.evaluationId, aggregateDigest: record.integrity.aggregateDigest };
    }

    const { request } = resolved;
    const receivedAt = now();

    let requestedEvent: GovernanceEvaluationRequestedEvent | undefined;
    if (events.enabled) {
      requestedEvent = {
        eventId: events.nextId('enterprise-event'),
        type: 'GovernanceEvaluationRequested',
        occurredAt: receivedAt,
        requestId,
        ...(correlationId !== undefined ? { correlationId } : {}),
      };
      await publishBestEffort(requestedEvent);
    }

    let transient: KernelEvaluationResult;
    try {
      transient = await issuance.evaluate(request, { traceLevel });
    } catch (error) {
      // No decision exists, so there is nothing to persist.
      return error instanceof KernelValidationError ? stopped('rejected', R.GOVERNED_ACTION_INTENT_INVALID) : stopped('system_error', R.GOVERNED_ACTION_KERNEL_FAILED);
    }

    const completionEvent = events.enabled ? buildGovernanceEvaluationOutcomeEvent(transient, events.nextId('enterprise-event')) : undefined;
    const aggregateEvents: EnterpriseEvent[] = [];
    if (requestedEvent !== undefined) aggregateEvents.push(requestedEvent);
    if (completionEvent !== undefined) aggregateEvents.push(completionEvent);

    let appended: AppendGovernanceEvaluationResult;
    try {
      appended = await store.appendEvaluation({
        request,
        result: transient,
        receivedAt,
        enterpriseContext: enterpriseContext(),
        events: aggregateEvents,
        idempotency,
        accessContext,
      });
    } catch (error) {
      if (isGovernanceStoreError(error) && error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT') {
        // A concurrent call for the same logical request committed first, with
        // its own `requestedAt`. Resolve once more against what it committed:
        // an equivalent request replays that decision, and this call's
        // transient decision is discarded — it was never recorded, so it can
        // never be a grant source.
        try {
          const raced = await resolve(scope, intent, requestId, accessContext, idempotency);
          if (raced.resolution.kind === 'replay') {
            const record = raced.resolution.record;
            return { kind: 'committed', request: raced.request, evaluationId: record.evaluation.evaluationId, aggregateDigest: record.integrity.aggregateDigest };
          }
        } catch {
          return stopped('system_error', R.GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED);
        }
        return stopped('rejected', R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT);
      }
      if (events.enabled) {
        await publishBestEffort({
          eventId: events.nextId('enterprise-event'),
          type: 'GovernanceRecordCommitFailed',
          occurredAt: now(),
          requestId,
          errorCode: isGovernanceStoreError(error) ? error.code : 'GOVERNANCE_STORE_TRANSACTION_FAILED',
          ...(correlationId !== undefined ? { correlationId } : {}),
        });
      }
      return stopped('system_error', R.GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED);
    }

    if (appended.idempotentReplay) {
      // An equivalent aggregate already stood. It is the decision; this call's is not.
      return { kind: 'committed', request, evaluationId: appended.evaluationId, aggregateDigest: appended.aggregateDigest };
    }

    // Post-commit only: nothing named "committed" is published before it is.
    if (events.enabled) {
      if (completionEvent !== undefined) await publishBestEffort(completionEvent);
      await publishBestEffort({
        eventId: events.nextId('enterprise-event'),
        type: 'GovernanceRecordCommitted',
        occurredAt: appended.persistedAt,
        requestId,
        decisionId: appended.decisionId,
        evaluationId: appended.evaluationId,
        aggregateDigest: appended.aggregateDigest,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    }

    return { kind: 'committed', request, evaluationId: appended.evaluationId, aggregateDigest: appended.aggregateDigest, transient };
  }

  /**
   * Appends an evidence reference exactly once. A second append of the same
   * deterministic id is refused by the Store; that refusal is read back and
   * reported as `existing` only when the row really is there — a lost race for
   * a chain position is not mistaken for success.
   */
  async function appendReferenceOnce(accessContext: GovernanceStoreAccessContext, reference: GovernanceReferenceInput): Promise<'appended' | 'existing'> {
    try {
      await store.appendReference(accessContext, reference);
      return 'appended';
    } catch (error) {
      const record = await store.getByEvaluationId(accessContext, reference.evaluationId);
      const existing = record?.references.find((entry) => entry.referenceId === reference.referenceId);
      if (existing !== undefined && existing.referenceType === reference.referenceType && existing.externalId === reference.externalId) return 'existing';
      throw error;
    }
  }

  /** What the Governance Record already says about an execution identity. References are read only to *refuse* a repeat; their presence never permits anything. */
  function priorExecution(record: GovernanceRecord, executionId: string): { readonly attempted: boolean; readonly outcome?: string } {
    const attempted = record.references.some((entry) => entry.referenceId === executionAttemptReferenceId(executionId) && entry.externalId === executionId);
    const outcome = record.references.find((entry) => entry.referenceId === executionOutcomeReferenceId(executionId) && entry.externalId === executionId);
    return { attempted, ...(outcome?.externalVersion !== undefined ? { outcome: outcome.externalVersion } : {}) };
  }

  return Object.freeze({
    organizationId: servedOrganizationId,

    async govern(identity: BoundCustomerIdentity, rawIntent: unknown): Promise<GovernedActionResult> {
      // 1. Trusted identity: read, never widened.
      const scope = boundScopeOf(identity, servedOrganizationId);
      if (scope === undefined) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_IDENTITY_INVALID] });

      // 2. Untrusted intent: validated closed.
      const validation = validateGovernedActionIntent(rawIntent);
      if (!validation.valid) return result({ status: 'rejected', reasonCodes: [R.GOVERNED_ACTION_INTENT_INVALID] });
      const intent = validation.intent;
      const correlationId = intent.correlationId;

      // 3-4. Server-derived identity for this logical request, and the tenant
      // scope every Store call runs under. Not a system context: the bound
      // organization, and its actor, only.
      const requestId = deriveGovernedActionRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, idempotencyKey: intent.idempotencyKey });
      const accessContext: GovernanceStoreAccessContext = { system: false, organizationId: scope.organizationId, actorId: scope.actorId };
      const idempotency: GovernanceIdempotencyContext = {
        idempotencyKey: intent.idempotencyKey,
        scope: governedActionIdempotencyScope({ organizationId: scope.organizationId, principalId: scope.principalId }),
      };
      const common = { requestId, ...(correlationId !== undefined ? { correlationId } : {}) };

      // 5-7. Idempotency, Kernel, commit.
      const committed = await commitDecision(scope, intent, requestId, accessContext, idempotency);
      if (committed.kind === 'stopped') return committed.result;
      const { request } = committed;

      // 8. Read the committed record back and verify it. What is issued from
      // below is what the Store holds — re-read, digest-verified, and bound to
      // this request — not what the Kernel returned in memory.
      let record: GovernanceRecord | null;
      try {
        record = await store.getByEvaluationId(accessContext, committed.evaluationId);
        const verification = record === null ? undefined : await store.verify(accessContext, committed.evaluationId);
        if (verification === undefined || !verification.valid) record = null;
      } catch {
        record = null;
      }
      if (record === null || record.integrity.aggregateDigest !== committed.aggregateDigest) {
        return result({ status: 'system_error', ...common, reasonCodes: [R.GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE] });
      }

      const persisted = toKernelEvaluationResult(record);
      const persistedMatchesRequest =
        record.evaluation.requestId === requestId &&
        record.request.payloadDigest === computeGovernanceRequestPayloadDigest(request) &&
        record.request.organizationId === scope.organizationId &&
        record.request.actorId === scope.actorId &&
        persisted.requestId === requestId &&
        persisted.decisionId === record.evaluation.decisionId &&
        persisted.status === record.evaluation.status;
      // GRANT ⊆ PERSISTED AUTHORIZATION: when this call did run the Kernel,
      // the transient and persisted decisions must project to the *same*
      // grant source, byte for byte. Any divergence fails closed — the
      // transient result never wins, and neither is issued from.
      const transientAgrees =
        committed.transient === undefined ||
        (committed.transient.decisionId === persisted.decisionId &&
          committed.transient.status === persisted.status &&
          grantSourceDigest(issuance.deriveSource(request, committed.transient)) === grantSourceDigest(issuance.deriveSource(request, persisted)));
      if (!persistedMatchesRequest || !transientAgrees) {
        return result({ status: 'system_error', ...common, reasonCodes: [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH] });
      }

      const decision: GovernedActionDecisionRef = {
        decisionId: persisted.decisionId,
        evaluationId: record.evaluation.evaluationId,
        status: persisted.status,
        reasonCodes: persisted.reasonCodes,
      };
      const decided = { ...common, decision };

      // 9. The Kernel's status, restated — never reinterpreted.
      if (persisted.status === 'denied') return result({ status: 'denied', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'indeterminate') return result({ status: 'indeterminate', ...decided, reasonCodes: persisted.reasonCodes });
      if (persisted.status === 'approval_required') return result({ status: 'withheld', withheldBy: 'approval', ...decided, reasonCodes: persisted.reasonCodes });

      // Trusted grant terms. No expiry, no grant.
      let terms: GovernedActionGrantTerms | undefined;
      try {
        terms = grantPolicy({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          action: request.action.type,
          resource: request.action.resourceScope,
          requestId,
          decisionId: persisted.decisionId,
          evaluatedAt: persisted.evaluatedAt,
          now: now(),
        });
      } catch {
        terms = undefined;
      }
      if (terms === undefined || typeof terms.grantExpiresAt !== 'string' || terms.grantExpiresAt.length === 0) {
        return result({ status: 'withheld', withheldBy: 'grant-terms', ...decided, reasonCodes: [R.GOVERNED_ACTION_GRANT_TERMS_UNAVAILABLE] });
      }

      // The immutable source snapshot the commit boundary is checked against.
      // Built from the committed record, frozen, and closed over — so the
      // synchronous commit guard needs no I/O, and nothing but this snapshot
      // can answer for the source. Sound because the Governance Store is
      // append-only: no API updates a committed evaluation in place.
      const persistedSource: GrantSourceAuthorization = deepFreeze(issuance.deriveSource(request, persisted));
      const revalidateSource = (correlation: GrantCorrelation): GrantSourceAuthorization | undefined => {
        if (!grantCorrelationMatches(correlation, persistedSource.correlation)) return undefined;
        if (hostRevalidateSource !== undefined && hostRevalidateSource(correlation) === undefined) return undefined;
        return persistedSource;
      };

      // 10-11. Authority binding and issuance — ACE's, unchanged, from the persisted decision.
      let authorization;
      try {
        authorization = await issuance.issueFromDecision({
          request,
          decision: persisted,
          grantExpiresAt: terms.grantExpiresAt,
          ...(terms.requestedBounds !== undefined ? { requestedBounds: terms.requestedBounds } : {}),
          revalidateSource,
        });
      } catch (error) {
        return result({
          status: 'system_error',
          ...decided,
          reasonCodes: [isExecutionGovernanceError(error) ? R.GOVERNED_ACTION_COMPOSITION_INVALID : R.GOVERNED_ACTION_GRANT_ISSUANCE_FAILED],
        });
      }
      if (authorization.outcome === 'authority-binding-unresolved') {
        return result({ status: 'withheld', withheldBy: 'authority-binding', ...decided, reasonCodes: authorization.reasonCodes });
      }
      if (authorization.outcome === 'grant-withheld') {
        const withheldBy: GovernedActionWithheldBy = authorization.reasonCodes.includes(GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED) ? 'obligations' : 'grant';
        return result({ status: 'withheld', withheldBy, ...decided, reasonCodes: authorization.reasonCodes });
      }
      const grant: BoundedGrant = authorization.grant;
      if (grant.subject !== scope.actorId || grant.correlation.requestId !== requestId || grant.correlation.decisionId !== persisted.decisionId) {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH] });
      }

      // Evidence: which authorization artifact this decision produced.
      try {
        await appendReferenceOnce(accessContext, {
          referenceId: authorizationReferenceId({ evaluationId: decision.evaluationId, grantId: grant.id }),
          evaluationId: decision.evaluationId,
          referenceType: 'authorization_artifact',
          externalId: grant.id,
          digest: grant.digest,
          createdAt: now(),
        });
      } catch {
        return result({ status: 'system_error', ...decided, reasonCodes: [R.GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED] });
      }

      // 12. Server-derived execution identity, and the exercise built from
      // the persisted request and the grant — never from the caller's object.
      const executionId = deriveGovernedActionExecutionId({ requestId, decisionId: persisted.decisionId });
      const executed = { ...decided, executionId };
      const exercise: GrantExerciseRequest = {
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

      const replay = (prior: { readonly attempted: boolean; readonly outcome?: string }): GovernedActionResult => {
        if (prior.outcome === 'executed') return result({ status: 'executed', ...executed, reasonCodes: persisted.reasonCodes, replayed: true, outcomeRecorded: true });
        if (prior.outcome === 'withheld') return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: [] });
        const failure = prior.outcome?.startsWith('execution-failed:') === true ? prior.outcome.slice('execution-failed:'.length) : undefined;
        if (failure === 'PROVIDER_REJECTED' || failure === 'PROVIDER_UNAVAILABLE' || failure === 'PROVIDER_RESPONSE_INVALID' || failure === 'ADAPTER_ERROR') {
          return result({ status: 'execution_failed', ...executed, failure, reasonCodes: [failure], replayed: true, outcomeRecorded: true });
        }
        return result({ status: 'execution_unconfirmed', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
      };

      const known = priorExecution(record, executionId);
      if (known.attempted) return replay(known);

      // 13a. Pre-assessment through ACE. A pure read: no provider is contacted.
      const assessment = await execution.assessExercise(exercise);
      if (!assessment.usable) return result({ status: 'withheld', withheldBy: 'exercise', ...executed, reasonCodes: assessment.reasonCodes });

      // 13b. Write-ahead: durable evidence that this execution id is being
      // attempted, BEFORE the adapter. A second claim of the same id is
      // refused by the Store, so this is also the at-most-once gate. It can
      // only ever *prevent* an invocation; it never permits one.
      let claim: 'appended' | 'existing';
      try {
        claim = await appendReferenceOnce(accessContext, {
          referenceId: executionAttemptReferenceId(executionId),
          evaluationId: decision.evaluationId,
          referenceType: 'execution_record',
          externalId: executionId,
          externalVersion: 'attempt',
          createdAt: now(),
        });
      } catch {
        return result({ status: 'system_error', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED] });
      }
      if (claim === 'existing') {
        // Another call claimed it first. Report what it recorded, if anything.
        let latest: GovernanceRecord | null = null;
        try {
          latest = await store.getByEvaluationId(accessContext, decision.evaluationId);
        } catch {
          latest = null;
        }
        return replay(latest === null ? { attempted: true } : priorExecution(latest, executionId));
      }

      // 13c. Exercise through ACE: the grant is re-read from the authoritative
      // store and the adapter receives a ValidatedExecutionAction only.
      let outcome: ExecutionOutcome;
      try {
        outcome = await execution.exercise(exercise);
      } catch {
        // Whether the adapter ran is unknown. It is not retried.
        return result({ status: 'execution_unconfirmed', ...executed, reasonCodes: [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED] });
      }

      // 14. Outcome evidence. A failure to record it never rewrites what happened.
      const recordedAs = outcome.status === 'executed' ? 'executed' : outcome.status === 'withheld' ? 'withheld' : `execution-failed:${outcome.reason}`;
      let outcomeRecorded = true;
      try {
        await appendReferenceOnce(accessContext, {
          referenceId: executionOutcomeReferenceId(executionId),
          evaluationId: decision.evaluationId,
          referenceType: 'execution_record',
          externalId: executionId,
          externalVersion: recordedAs,
          createdAt: now(),
        });
      } catch {
        outcomeRecorded = false;
      }
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
