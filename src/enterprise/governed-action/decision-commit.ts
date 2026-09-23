import { grantSourceDigest, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import { KernelValidationError, type KernelEvaluationRequest, type KernelEvaluationResult } from '../../kernel/index.js';
import type { EnterpriseEvent, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent } from '../events/enterprise-events.js';
import type { AuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import type {
  AppendGovernanceEvaluationResult,
  GovernanceEnterpriseContext,
  GovernanceIdempotencyContext,
  GovernanceIdempotencyResolution,
  GovernanceRecord,
  GovernanceStoreAccessContext,
} from '../governance-store/contracts.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { deepFreeze, toKernelEvaluationResult } from '../governance-store/store-common.js';
import { buildGovernanceEvaluationOutcomeEvent } from '../orchestration/governance-evaluation-events.js';
import { GOVERNED_ACTION_REASON_CODES as R, type ClassifiedGovernedActionIntent, type GovernedActionReasonCode } from './contracts.js';
import { buildGovernedActionKernelRequest, type BoundActorScope } from './kernel-request.js';

/**
 * The persist-before-grant boundary.
 *
 * ```
 * idempotency resolution -> Kernel.evaluate() -> appendEvaluation()
 *   -> getByEvaluationId() + verify() -> reconstruct -> bind to this request
 *   -> VerifiedDecision
 * ```
 *
 * `VerifiedDecision` is the only thing the orchestrator can issue a grant
 * from, and this module is the only producer of one. It deliberately carries
 * **no transient Kernel result**: the transient decision is used inside this
 * module for one thing — a byte-for-byte agreement check against the
 * committed record — and then dropped. Issuing from an unpersisted decision is
 * therefore not a discipline the caller must keep; it is not expressible.
 */
export interface VerifiedDecision {
  /** The request the committed record was proven to hold (payload digest equal). */
  readonly request: KernelEvaluationRequest;
  /** The committed, digest-verified Governance Record. */
  readonly record: GovernanceRecord;
  /** `toKernelEvaluationResult(record)` — the Store's canonical reconstruction. */
  readonly decision: KernelEvaluationResult;
  /** The grant source projected from `decision`, deep-frozen. What the synchronous commit guard closes over. */
  readonly source: GrantSourceAuthorization;
}

export type DecisionCommitOutcome =
  | { readonly kind: 'verified'; readonly verified: VerifiedDecision }
  | { readonly kind: 'stopped'; readonly status: 'rejected' | 'system_error'; readonly reasonCode: GovernedActionReasonCode };

export interface DecisionCommitterOptions {
  readonly store: GovernanceStore;
  readonly issuance: Pick<AuthorityControlledIssuanceCore, 'evaluate' | 'deriveSource'>;
  readonly trustDomainId: string;
  readonly now: () => string;
  readonly enterpriseContext: () => GovernanceEnterpriseContext;
  readonly events: { readonly enabled: boolean; readonly publisher: EnterpriseEventPublisher; readonly nextId: (prefix: string) => string };
  readonly traceLevel: 'basic' | 'full';
}

export interface DecisionCommitInput {
  readonly scope: BoundActorScope;
  readonly intent: ClassifiedGovernedActionIntent;
  readonly requestId: string;
  readonly accessContext: GovernanceStoreAccessContext;
  readonly idempotency: GovernanceIdempotencyContext;
}

export interface DecisionCommitter {
  commit(input: DecisionCommitInput): Promise<DecisionCommitOutcome>;
}

/** Which committed aggregate to verify, and — only when this call ran the Kernel — the transient decision it must agree with. */
interface Committed {
  readonly request: KernelEvaluationRequest;
  readonly evaluationId: string;
  readonly aggregateDigest: string;
  readonly transient?: KernelEvaluationResult;
}

const stopped = (status: 'rejected' | 'system_error', reasonCode: GovernedActionReasonCode): DecisionCommitOutcome => ({ kind: 'stopped', status, reasonCode });

export function createDecisionCommitter(options: DecisionCommitterOptions): DecisionCommitter {
  const { store, issuance, trustDomainId, now, enterpriseContext, events, traceLevel } = options;

  async function publishBestEffort(event: EnterpriseEvent): Promise<void> {
    try {
      await events.publisher.publish(event);
    } catch {
      // Operational signal only; the durable copy of every evaluation event is in the committed aggregate.
    }
  }

  /**
   * Idempotency through the Store's own machinery, before the Kernel.
   *
   * `requestedAt` is part of the persisted request, so a retry rebuilds the
   * request with the *original* instant, read from the existing record for
   * this server-derived request id, to compare like with like. The comparison
   * itself is the Store's: payload digest against the tenant-scoped claim and
   * the request-id row.
   */
  async function resolve(input: DecisionCommitInput): Promise<{ readonly request: KernelEvaluationRequest; readonly resolution: GovernanceIdempotencyResolution }> {
    const existing = await store.getByRequestId(input.accessContext, input.requestId);
    const request = buildGovernedActionKernelRequest({
      scope: input.scope,
      intent: input.intent,
      trustDomainId,
      requestId: input.requestId,
      requestedAt: existing?.request.requestedAt ?? now(),
    });
    const resolution = await store.resolveIdempotency(input.accessContext, {
      requestId: input.requestId,
      payloadDigest: computeGovernanceRequestPayloadDigest(request),
      idempotency: input.idempotency,
    });
    return { request, resolution };
  }

  function fromReplay(request: KernelEvaluationRequest, record: GovernanceRecord): Committed {
    return { request, evaluationId: record.evaluation.evaluationId, aggregateDigest: record.integrity.aggregateDigest };
  }

  /** Idempotency, Kernel, commit. Returns a committed aggregate's identity, or why there is none. */
  async function evaluateAndAppend(input: DecisionCommitInput): Promise<Committed | DecisionCommitOutcome> {
    const { requestId, accessContext, idempotency } = input;
    const correlationId = input.intent.correlationId;

    let resolved;
    try {
      resolved = await resolve(input);
    } catch {
      return stopped('system_error', R.GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED);
    }
    if (resolved.resolution.kind === 'conflict') return stopped('rejected', R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT);
    // The original committed decision is the answer. The Kernel is not re-run.
    if (resolved.resolution.kind === 'replay') return fromReplay(resolved.request, resolved.resolution.record);

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
      appended = await store.appendEvaluation({ request, result: transient, receivedAt, enterpriseContext: enterpriseContext(), events: aggregateEvents, idempotency, accessContext });
    } catch (error) {
      if (isGovernanceStoreError(error) && error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT') {
        // A concurrent call for the same logical request committed first, with
        // its own `requestedAt`. Resolve once more against what it committed:
        // an equivalent request adopts that decision, and this call's transient
        // decision is discarded — it was never recorded.
        try {
          const raced = await resolve(input);
          if (raced.resolution.kind === 'replay') return fromReplay(raced.request, raced.resolution.record);
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

    // An equivalent aggregate already stood. It is the decision; this call's is not.
    if (appended.idempotentReplay) return { request, evaluationId: appended.evaluationId, aggregateDigest: appended.aggregateDigest };

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

    return { request, evaluationId: appended.evaluationId, aggregateDigest: appended.aggregateDigest, transient };
  }

  /**
   * Re-read the committed record, verify it, reconstruct it, and bind it to
   * this request. What leaves here is what the Store holds — not what the
   * Kernel returned in memory.
   */
  async function verify(input: DecisionCommitInput, committed: Committed): Promise<DecisionCommitOutcome> {
    const { accessContext, requestId, scope } = input;
    const { request } = committed;

    let record: GovernanceRecord | null;
    try {
      record = await store.getByEvaluationId(accessContext, committed.evaluationId);
      const verification = record === null ? undefined : await store.verify(accessContext, committed.evaluationId);
      if (verification === undefined || !verification.valid) record = null;
    } catch {
      record = null;
    }
    if (record === null || record.integrity.aggregateDigest !== committed.aggregateDigest) {
      return stopped('system_error', R.GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE);
    }

    const decision = toKernelEvaluationResult(record);
    const source = issuance.deriveSource(request, decision);
    const boundToRequest =
      record.evaluation.requestId === requestId &&
      record.request.payloadDigest === computeGovernanceRequestPayloadDigest(request) &&
      record.request.organizationId === scope.organizationId &&
      record.request.actorId === scope.actorId &&
      decision.requestId === requestId &&
      decision.decisionId === record.evaluation.decisionId &&
      decision.status === record.evaluation.status;
    // GRANT ⊆ PERSISTED AUTHORIZATION: when this call ran the Kernel, the
    // transient and persisted decisions must project to the *same* grant
    // source, byte for byte. Any divergence fails closed — the transient result
    // never wins, and neither is issued from.
    const transient = committed.transient;
    const transientAgrees =
      transient === undefined ||
      (transient.decisionId === decision.decisionId &&
        transient.status === decision.status &&
        grantSourceDigest(issuance.deriveSource(request, transient)) === grantSourceDigest(source));
    if (!boundToRequest || !transientAgrees) return stopped('system_error', R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH);

    return { kind: 'verified', verified: { request, record, decision, source: deepFreeze(source) } };
  }

  return {
    async commit(input: DecisionCommitInput): Promise<DecisionCommitOutcome> {
      const committed = await evaluateAndAppend(input);
      if ('kind' in committed) return committed;
      return verify(input, committed);
    },
  };
}
