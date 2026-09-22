import type { ExerciseReservationObservation } from '../../features/exercise-control-runtime/index.js';
import { isRecordableExecutionAdapterId, type ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { BoundedGrant, BoundedGrantReaderPort, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import type { AppendAuthorityEventInput, AuthorityEventBody, AuthorityEventReferences, ExecutionOutcomeObservedPayload } from './contracts.js';
import { isAuthorityEventStreamError, type AuthorityEventStreamErrorCode } from './errors.js';
import { authorityEventSourceId } from './event-chain.js';
import { deriveAuthorityEventId, deriveAuthorityEventStreamId } from './identifiers.js';
import type { AuthorityEventRecorder } from './recorder.js';
import type { AuthorityEventStreamWriter } from './stream-store.js';
import { isSafeEvidenceString } from './validation.js';

/**
 * The projector: turns facts lifecycle modules report through the write-only
 * `AuthorityEventRecorder` into canonical events, and appends them.
 *
 * ## Path-local, tenant-bound
 *
 * One projector serves the one organization the Governed Action Orchestrator
 * serves, and projects only governed-action lifecycles — request ids the
 * orchestrator derived (`aoc.gar:`). A reservation, a revocation or an outcome
 * produced by some other caller of Authority-Controlled Execution is out of
 * Stage A's scope and is not projected (counted, not failed).
 *
 * ## It never throws, and it decides nothing
 *
 * Every method catches every failure — an invalid fact, a conflict, a corrupt
 * stream, a closed or unopenable store — counts it in `health()`, and resolves.
 * That health is an operator signal surfaced through the module registry; no
 * authorization path reads it, and no method returns anything a caller could
 * branch on.
 *
 * ## What is copied, and what never is
 *
 * Only opaque server-derived identities, digests, closed reason vocabularies,
 * canonical instants, adapter identities and a bounded `providerRef`. Never a
 * Governance Record, a grant, a reservation record, a request body, an
 * `assertedContext`, a header, a URL, a credential, an adapter `detail` or a
 * provider response. A `providerRef` shaped like a credential or a destination
 * is omitted rather than recorded.
 */

/** Only governed-action request identities have a canonical lifecycle stream in Stage A. */
const GOVERNED_ACTION_REQUEST_PREFIX = 'aoc.gar:';

export interface AuthorityEventProjectionHealth {
  /** `degraded` once any projection has failed. Never read by any authorization path. */
  readonly status: 'healthy' | 'degraded';
  readonly appended: number;
  readonly existing: number;
  readonly failed: number;
  /** Facts outside Stage A's governed-action scope, deliberately not projected. */
  readonly outOfScope: number;
  readonly lastFailureCode?: AuthorityEventStreamErrorCode | 'AUTHORITY_EVENT_PROJECTION_FAILED';
}

export interface AuthorityEventProjector extends AuthorityEventRecorder {
  health(): AuthorityEventProjectionHealth;
}

export interface AuthorityEventProjectorOptions {
  /** The one organization whose governed-action lifecycles this projector records. */
  readonly organizationId: string;
  /** The append-only store half. `undefined` when the configured store could not be opened: every projection then fails, visibly, and nothing else changes. */
  readonly store: AuthorityEventStreamWriter | undefined;
  /** Read-only grant access, used only to attribute a revocation to its lifecycle. Evidence reads authority; it never writes or decides it. */
  readonly grants: BoundedGrantReaderPort;
}

type Body = AuthorityEventBody;

export function createAuthorityEventProjector(options: AuthorityEventProjectorOptions): AuthorityEventProjector {
  const { organizationId, store, grants } = options;
  let appended = 0;
  let existing = 0;
  let failed = 0;
  let outOfScope = 0;
  let lastFailureCode: AuthorityEventProjectionHealth['lastFailureCode'];

  function fail(code: AuthorityEventProjectionHealth['lastFailureCode']): void {
    failed += 1;
    lastFailureCode = code;
  }

  /** Builds the envelope from the body's own identities and appends it. Resolves in every case. */
  async function project(body: Body, occurredAt: string): Promise<void> {
    try {
      const requestId = body.references.requestId;
      if (typeof requestId !== 'string' || !requestId.startsWith(GOVERNED_ACTION_REQUEST_PREFIX)) {
        outOfScope += 1;
        return;
      }
      if (store === undefined) {
        fail('AUTHORITY_EVENT_STREAM_UNAVAILABLE');
        return;
      }
      const sourceId = authorityEventSourceId(body);
      if (sourceId === undefined) {
        fail('AUTHORITY_EVENT_INPUT_INVALID');
        return;
      }
      const streamId = deriveAuthorityEventStreamId({ organizationId, requestId });
      const input = { ...body, eventId: deriveAuthorityEventId({ streamId, eventType: body.eventType, sourceId }), streamId, organizationId, occurredAt } as AppendAuthorityEventInput;
      const result = await store.append({ organizationId }, input);
      if (result.outcome === 'appended') appended += 1;
      else existing += 1;
    } catch (error) {
      fail(isAuthorityEventStreamError(error) ? error.code : 'AUTHORITY_EVENT_PROJECTION_FAILED');
    }
  }

  function grantReferences(grant: BoundedGrant): AuthorityEventReferences {
    return { requestId: grant.correlation.requestId, decisionId: grant.correlation.decisionId, boundedGrantId: grant.id };
  }

  function executionReferences(fact: { readonly evaluationId: string; readonly executionId: string; readonly grant: BoundedGrant }): AuthorityEventReferences {
    return { ...grantReferences(fact.grant), evaluationId: fact.evaluationId, executionId: fact.executionId };
  }

  /** The adapter attribution the runtime already established, when it is a recordable identity. */
  function attribution(outcome: { readonly adapterId: string; readonly routedBy?: string }): Pick<ExecutionOutcomeObservedPayload, 'adapterId' | 'routedBy'> {
    return {
      ...(isRecordableExecutionAdapterId(outcome.adapterId) ? { adapterId: outcome.adapterId } : {}),
      ...(outcome.routedBy !== undefined && isRecordableExecutionAdapterId(outcome.routedBy) ? { routedBy: outcome.routedBy } : {}),
    };
  }

  /** The `ExecutionOutcome`, restated with its certainty intact: four statuses, never a boolean, and no provider body, detail or header. */
  function outcomePayload(outcome: ExecutionOutcome, outcomeRecorded: boolean): ExecutionOutcomeObservedPayload {
    switch (outcome.status) {
      case 'executed':
        return {
          status: 'executed',
          reasonCodes: [],
          ...attribution(outcome),
          ...(outcome.providerRef !== undefined && isSafeEvidenceString(outcome.providerRef) ? { providerRef: outcome.providerRef } : {}),
          outcomeRecorded,
        };
      case 'execution-failed':
        return { status: 'execution-failed', failure: outcome.reason, reasonCodes: [outcome.reason], ...attribution(outcome), outcomeRecorded };
      case 'execution-unconfirmed':
        return { status: 'execution-unconfirmed', reasonCodes: [], ...attribution(outcome), outcomeRecorded };
      case 'withheld':
        switch (outcome.withheldBy) {
          case 'grant-exercise':
            return { status: 'withheld', withheldBy: 'grant-exercise', reasonCodes: [...outcome.assessment.reasonCodes], outcomeRecorded };
          case 'emergency-control':
            return { status: 'withheld', withheldBy: 'emergency-control', reasonCodes: [...outcome.emergencyControl.reasonCodes], outcomeRecorded };
          case 'exercise-control':
            return { status: 'withheld', withheldBy: 'exercise-control', reasonCodes: [...outcome.exerciseControl.reasonCodes], outcomeRecorded };
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  }

  return {
    async decisionCommitted(record: GovernanceRecord): Promise<void> {
      try {
        // A record of another tenant is never projected into this one's stream.
        if (record.request.organizationId !== organizationId) {
          fail('AUTHORITY_EVENT_TENANT_VIOLATION');
          return;
        }
        const { evaluation, integrity } = record;
        await project(
          {
            eventType: 'governance.decision.committed',
            references: { requestId: evaluation.requestId, evaluationId: evaluation.evaluationId, decisionId: evaluation.decisionId },
            payload: { status: evaluation.status, reasonCodes: [...evaluation.reasonCodes], evaluatedAt: evaluation.evaluatedAt, aggregateDigest: integrity.aggregateDigest },
          },
          // The store's commit instant for the evaluation: when the decision became a committed fact.
          evaluation.persistedAt,
        );
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async grantIssued(grant: BoundedGrant): Promise<void> {
      try {
        await project(
          {
            eventType: 'grant.issued',
            references: grantReferences(grant),
            payload: { grantDigest: grant.digest, expiresAt: grant.expiresAt, ...(grant.authorityBindingDigest !== undefined ? { authorityBindingDigest: grant.authorityBindingDigest } : {}) },
          },
          grant.issuedAt,
        );
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async grantRevoked(revocation: GrantRevocation): Promise<void> {
      try {
        // Attribution only: which lifecycle does this grant belong to? A read of
        // the authoritative store, never a write, and never a decision.
        const read = await grants.read(revocation.grantId);
        const grant = read.grant;
        if (grant === undefined || grant.id !== revocation.grantId) {
          fail('AUTHORITY_EVENT_INPUT_INVALID');
          return;
        }
        await project({ eventType: 'grant.revoked', references: grantReferences(grant), payload: { reason: revocation.reason } }, revocation.revokedAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async grantExpiryObserved(grant: BoundedGrant): Promise<void> {
      try {
        // occurredAt is the grant's own expiry instant: expiry is a condition of
        // the clock, and that is the instant it took effect. Every later
        // observation of it is the same fact, so it resolves to one event.
        await project({ eventType: 'grant.expiry.observed', references: grantReferences(grant), payload: { expiresAt: grant.expiresAt } }, grant.expiresAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async executionClaimed(fact): Promise<void> {
      try {
        await project({ eventType: 'execution.attempt.claimed', references: executionReferences(fact), payload: {} }, fact.claimedAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async executionOutcomeObserved(fact): Promise<void> {
      try {
        if (fact.outcome.correlation.executionId !== fact.executionId) {
          fail('AUTHORITY_EVENT_INPUT_INVALID');
          return;
        }
        // The one trusted instant the outcome carries: when the assessment that
        // guarded the provider crossing was made. No provider-completion time
        // exists, and none is invented.
        await project({ eventType: 'execution.outcome.observed', references: executionReferences(fact), payload: outcomePayload(fact.outcome, fact.outcomeRecorded) }, fact.outcome.exercisedAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    async reservationObserved(observation: ExerciseReservationObservation): Promise<void> {
      try {
        const references: AuthorityEventReferences = {
          requestId: observation.requestId,
          decisionId: observation.decisionId,
          boundedGrantId: observation.boundedGrantId,
          executionId: observation.executionId,
          reservationId: observation.reservationId,
        };
        if (observation.kind === 'reserved') {
          await project(
            { eventType: 'exercise.reservation.reserved', references, payload: { policyDigest: observation.policyDigest, authorityBindingDigest: observation.authorityBindingDigest } },
            observation.admittedAt,
          );
        } else if (observation.kind === 'settled') {
          await project({ eventType: 'exercise.reservation.settled', references, payload: { reason: observation.reason } }, observation.recordedAt);
        } else {
          await project({ eventType: 'exercise.reservation.released', references, payload: { reason: observation.reason } }, observation.recordedAt);
        }
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    health(): AuthorityEventProjectionHealth {
      return {
        status: failed === 0 ? 'healthy' : 'degraded',
        appended,
        existing,
        failed,
        outOfScope,
        ...(lastFailureCode !== undefined ? { lastFailureCode } : {}),
      };
    },
  };
}
