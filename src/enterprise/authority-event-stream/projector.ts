import type { ExerciseReservationObservation } from '../../features/exercise-control-runtime/index.js';
import { isRecordableExecutionAdapterId, type ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { BoundedGrant, BoundedGrantReaderPort, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import type { AppendAuthorityEventInput, AuthorityEventBody, AuthorityEventReferences, ExecutionOutcomeObservedPayload, ExecutionOutcomeResolvedPayload } from './contracts.js';
import { isAuthorityEventStreamError, type AuthorityEventStreamErrorCode } from './errors.js';
import { authorityEventSourceId } from './event-chain.js';
import { deriveAuthorityEventId, deriveAuthorityEventStreamId } from './identifiers.js';
import type { AuthorityEventRecorder, ExecutionResolutionEvidenceRecorder } from './recorder.js';
import type { AuthorityEventStreamWriter } from './stream-store.js';
import { isSafeEvidenceString } from './validation.js';

/**
 * The projector: turns facts lifecycle modules report through the write-only
 * `AuthorityEventRecorder` into canonical events, **enqueues** them, and appends
 * them afterwards — never while the caller waits.
 *
 * ## Enqueue now, append later
 *
 * ```
 * authority path:   fact established -> recorder.x(fact)  [builds, enqueues, returns]
 *                                        |
 * projector:                             +-> per-stream serial queue -> store.append(...)
 * ```
 *
 * Every recorder method is synchronous and returns `void`. It validates and
 * builds a bounded event input — pure, no I/O — hands it to the queue, and
 * returns. Durable projection happens after the caller has moved on, so an
 * **asynchronous** append that is slow, unreachable, closed or permanently
 * stuck cannot hold a decision, a grant issuance, an execution claim, an
 * adapter crossing, a P7 reservation or a revocation. That is the property the
 * earlier awaited-with-a-`catch` shape did not have: a rejected projection was
 * caught, but a projection that never settled would have held the path.
 *
 * This is control flow, not latency: the queue runs in this process on this
 * event loop, and a synchronous store — `better-sqlite3`, whose append includes
 * a lock wait and an `fsync` — still occupies it. A slow store can add latency
 * to whatever runs next; it cannot make an authority path wait for projection
 * to complete. Worker isolation is not part of Stage A.
 *
 * ## Order is the queue's, durability is the store's
 *
 * Two serial stages, and the order a lifecycle was reported in survives both:
 *
 * ```
 * report(fact)  ->  INTAKE chain, per grant   ->  APPEND chain, per stream  ->  store.append
 *                   (resolves what a fact          (one at a time; N+1 is
 *                    needs before it can be         not invoked until N has
 *                    placed in its stream)          settled)
 * ```
 *
 * **Why intake exists.** A revocation is the one fact whose stream is not known
 * when it is reported: the lifecycle comes from the authoritative grant, which
 * has to be read. If that read happened off to one side, a later fact for the
 * same grant — an execution outcome, say — could be placed in the stream first,
 * and the stream would claim an effect was recorded before the revocation that
 * caused it. So every fact carrying a `boundedGrantId` passes through that
 * grant's **intake chain** in report order, and a step only *places* its event
 * in the stream (it never waits for the append). A revocation whose attribution
 * is slow therefore holds the rest of its own grant's evidence behind it — a
 * projector-side barrier, invisible to every authority path — and holds nothing
 * else.
 *
 * The committed decision carries no grant and is the first fact of a lifecycle,
 * so it goes straight to its stream's append chain.
 *
 * **Why the append chain exists.** One serial chain per stream: the append for
 * event N+1 is not invoked until event N's append has settled, so an async
 * host-supplied store cannot reorder or interleave a stream's events however it
 * schedules. Chains are per key, so a stuck stream or a stuck grant holds only
 * its own queue — another lifecycle keeps projecting. The queue chooses
 * **nothing** about an event: sequence, previous digest, `recordedAt` and the
 * digest remain the store's, assigned inside its own critical section.
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
 * Every failure — an invalid fact, a conflict, a corrupt stream, a closed or
 * unopenable store, a queued append that rejects — is counted in `health()` and
 * swallowed. That health is an operator signal surfaced through the module
 * registry; no authorization path reads it, and no method returns anything a
 * caller could branch on. Stage A does not retry or reconcile a failed
 * projection: the stream can be shorter than what happened, never different.
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
  /**
   * Facts enqueued whose append has not settled yet. A queue that stops
   * draining shows up here as a number that stops falling — the operator signal
   * for a slow or stuck store. It is never a back-pressure signal to any
   * authority path, which does not read it and never waits on it.
   */
  readonly pending: number;
  readonly lastFailureCode?: AuthorityEventStreamErrorCode | 'AUTHORITY_EVENT_PROJECTION_FAILED';
}

export interface AuthorityEventProjector extends AuthorityEventRecorder, ExecutionResolutionEvidenceRecorder {
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
  let pending = 0;
  let lastFailureCode: AuthorityEventProjectionHealth['lastFailureCode'];

  function fail(code: AuthorityEventProjectionHealth['lastFailureCode']): void {
    failed += 1;
    lastFailureCode = code;
  }

  /**
   * The tail of each serial chain, keyed by stream (and, for a revocation's
   * attribution read, by grant). A key is dropped once its chain is idle, so a
   * long-lived process holds one entry per in-flight lifecycle, not per
   * lifecycle ever seen.
   */
  const tails = new Map<string, Promise<void>>();

  /**
   * Appends `task` to `key`'s chain and returns immediately.
   *
   * An idle chain starts from an already-resolved promise rather than calling
   * `task()` inline, so **no store code ever runs on the reporting caller's
   * stack** — not even the first append of a stream, and not even with a
   * synchronous driver like `better-sqlite3`, whose whole transaction would
   * otherwise execute inside the authority path's call. That deferral is the
   * only scheduling mechanism here: one microtask hop, no timer, no interval,
   * no worker and no background sweeper.
   *
   * `then(run, run)` on purpose: a chain continues whether the step before it
   * settled or failed, so one bad append cannot silently strand the rest of a
   * stream. A step that never settles holds **only** this key's chain, which is
   * the point — no caller is waiting on it.
   */
  function chain(key: string, task: () => Promise<void>): void {
    pending += 1;
    const run = async (): Promise<void> => {
      try {
        await task();
      } finally {
        pending -= 1;
      }
    };
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    tails.set(key, next);
    void next.then(
      () => {
        if (tails.get(key) === next) tails.delete(key);
      },
      () => {
        if (tails.get(key) === next) tails.delete(key);
      },
    );
  }

  /** The one append, run from a stream's chain. Never rejects: every failure is counted and swallowed. */
  async function append(input: AppendAuthorityEventInput): Promise<void> {
    if (store === undefined) {
      fail('AUTHORITY_EVENT_STREAM_UNAVAILABLE');
      return;
    }
    try {
      const result = await store.append({ organizationId }, input);
      if (result.outcome === 'appended') appended += 1;
      else existing += 1;
    } catch (error) {
      fail(isAuthorityEventStreamError(error) ? error.code : 'AUTHORITY_EVENT_PROJECTION_FAILED');
    }
  }

  /** One grant's intake chain. A distinct key space from the stream chains it feeds. */
  function grantIntakeKey(boundedGrantId: string): string {
    return `intake:grant:${boundedGrantId}`;
  }

  /**
   * Builds the envelope from the body's own identities. Pure: no I/O, no
   * enqueue. Returns `undefined` — having counted why — for a fact outside
   * Stage A's scope or outside the contract.
   */
  function buildInput(body: Body, occurredAt: string): AppendAuthorityEventInput | undefined {
    const requestId = body.references.requestId;
    if (typeof requestId !== 'string' || !requestId.startsWith(GOVERNED_ACTION_REQUEST_PREFIX)) {
      outOfScope += 1;
      return undefined;
    }
    const sourceId = authorityEventSourceId(body);
    if (sourceId === undefined) {
      fail('AUTHORITY_EVENT_INPUT_INVALID');
      return undefined;
    }
    const streamId = deriveAuthorityEventStreamId({ organizationId, requestId });
    return { ...body, eventId: deriveAuthorityEventId({ streamId, eventType: body.eventType, sourceId }), streamId, organizationId, occurredAt } as AppendAuthorityEventInput;
  }

  /** Places a built event in its stream's append chain. Never waits for the append. */
  function placeInStream(input: AppendAuthorityEventInput): void {
    chain(input.streamId, () => append(input));
  }

  /**
   * Builds the envelope and **enqueues** it: straight into the stream's append
   * chain for a fact that carries no grant, and otherwise through that grant's
   * intake chain, which is what keeps a revocation's asynchronous attribution
   * from being overtaken by a later fact of the same lifecycle. Synchronous and
   * total: it returns after enqueueing, and every failure before that point is
   * counted rather than raised.
   */
  function project(body: Body, occurredAt: string): void {
    try {
      const input = buildInput(body, occurredAt);
      if (input === undefined) return;
      const boundedGrantId = input.references.boundedGrantId;
      if (boundedGrantId === undefined) {
        placeInStream(input);
        return;
      }
      chain(grantIntakeKey(boundedGrantId), async () => {
        placeInStream(input);
      });
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
    decisionCommitted(record: GovernanceRecord): void {
      try {
        // A record of another tenant is never projected into this one's stream.
        if (record.request.organizationId !== organizationId) {
          fail('AUTHORITY_EVENT_TENANT_VIOLATION');
          return;
        }
        const { evaluation, integrity } = record;
        project(
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

    grantIssued(grant: BoundedGrant): void {
      try {
        project(
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

    grantRevoked(revocation: GrantRevocation): void {
      try {
        const grantId = revocation.grantId;
        const reason = revocation.reason;
        const revokedAt = revocation.revokedAt;
        // The one fact whose stream is not known when it is reported: the
        // lifecycle comes from the authoritative grant. The read runs as a step
        // of **this grant's intake chain**, so every later fact for the same
        // grant queues behind it and cannot be placed in the stream first — and
        // no caller, no other grant and no other stream waits for it. The event
        // is placed directly once the correlation is known; re-entering intake
        // here would put it behind the facts it must precede.
        chain(grantIntakeKey(grantId), async () => {
          try {
            // Attribution only: which lifecycle does this grant belong to? A read
            // of the authoritative store, never a write, and never a decision.
            const read = await grants.read(grantId);
            const grant = read.grant;
            if (grant === undefined || grant.id !== grantId) {
              fail('AUTHORITY_EVENT_INPUT_INVALID');
              return;
            }
            const input = buildInput({ eventType: 'grant.revoked', references: grantReferences(grant), payload: { reason } }, revokedAt);
            if (input !== undefined) placeInStream(input);
          } catch (error) {
            fail(isAuthorityEventStreamError(error) ? error.code : 'AUTHORITY_EVENT_PROJECTION_FAILED');
          }
        });
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    grantExpiryObserved(grant: BoundedGrant): void {
      try {
        // occurredAt is the grant's own expiry instant: expiry is a condition of
        // the clock, and that is the instant it took effect. Every later
        // observation of it is the same fact, so it resolves to one event.
        project({ eventType: 'grant.expiry.observed', references: grantReferences(grant), payload: { expiresAt: grant.expiresAt } }, grant.expiresAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    executionClaimed(fact): void {
      try {
        project({ eventType: 'execution.attempt.claimed', references: executionReferences(fact), payload: {} }, fact.claimedAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    executionOutcomeObserved(fact): void {
      try {
        if (fact.outcome.correlation.executionId !== fact.executionId) {
          fail('AUTHORITY_EVENT_INPUT_INVALID');
          return;
        }
        // The one trusted instant the outcome carries: when the assessment that
        // guarded the provider crossing was made. No provider-completion time
        // exists, and none is invented.
        project({ eventType: 'execution.outcome.observed', references: executionReferences(fact), payload: outcomePayload(fact.outcome, fact.outcomeRecorded) }, fact.outcome.exercisedAt);
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    reservationObserved(observation: ExerciseReservationObservation): void {
      try {
        const references: AuthorityEventReferences = {
          requestId: observation.requestId,
          decisionId: observation.decisionId,
          boundedGrantId: observation.boundedGrantId,
          executionId: observation.executionId,
          reservationId: observation.reservationId,
        };
        if (observation.kind === 'reserved') {
          project(
            { eventType: 'exercise.reservation.reserved', references, payload: { policyDigest: observation.policyDigest, authorityBindingDigest: observation.authorityBindingDigest } },
            observation.admittedAt,
          );
        } else if (observation.kind === 'settled') {
          project({ eventType: 'exercise.reservation.settled', references, payload: { reason: observation.reason } }, observation.recordedAt);
        } else {
          project({ eventType: 'exercise.reservation.released', references, payload: { reason: observation.reason } }, observation.recordedAt);
        }
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    executionOutcomeResolved(fact): void {
      try {
        project(
          {
            eventType: 'execution.outcome.resolved',
            references: { requestId: fact.requestId, evaluationId: fact.evaluationId, decisionId: fact.decisionId, boundedGrantId: fact.boundedGrantId, executionId: fact.executionId },
            payload: {
              certainty: fact.certainty,
              ...(fact.certainty === 'confirmed-not-completed' && fact.failure !== undefined ? { failure: fact.failure as NonNullable<ExecutionOutcomeResolvedPayload['failure']> } : {}),
              authorityId: fact.authorityId,
              ...(fact.providerRef !== undefined && isSafeEvidenceString(fact.providerRef) ? { providerRef: fact.providerRef } : {}),
              resolutionDigest: fact.resolutionDigest,
            },
          },
          // When the resolution became a durable fact.
          fact.recordedAt,
        );
      } catch {
        fail('AUTHORITY_EVENT_PROJECTION_FAILED');
      }
    },

    reservationReconciled(fact): void {
      try {
        project(
          {
            eventType: 'exercise.reservation.reconciled',
            references: { requestId: fact.requestId, decisionId: fact.decisionId, boundedGrantId: fact.boundedGrantId, executionId: fact.executionId, reservationId: fact.reservationId },
            payload: { resolution: fact.resolution, resolutionDigest: fact.resolutionDigest },
          },
          fact.recordedAt,
        );
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
        pending,
        ...(lastFailureCode !== undefined ? { lastFailureCode } : {}),
      };
    },
  };
}
