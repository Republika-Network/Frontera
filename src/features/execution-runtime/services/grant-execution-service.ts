import type { BoundedGrantStorePort, ReadBoundedGrantResult } from '../../grant-runtime/index.js';
import {
  EXECUTION_FAILURE_REASONS,
  GRANT_EXERCISE_REASON_CODES,
  assessBoundedGrantExercise,
  type BoundedGrantExerciseAssessment,
  type ExecutionAdapter,
  type ExecutionOutcome,
  type GrantExerciseRequest,
  type ValidatedExecutionAction,
  type ValidatedExecutionCorrelation,
} from '../domain/index.js';

/**
 * The gate. Nothing external runs through this service unless a bounded grant
 * held by the authoritative store covers the exact action being attempted, at
 * the instant it is attempted.
 *
 * ```
 * no grant        → adapter NOT called
 * unknown grant   → adapter NOT called
 * expired grant   → adapter NOT called
 * revoked grant   → adapter NOT called
 * tampered grant  → adapter NOT called
 * wrong subject   → adapter NOT called
 * wrong action    → adapter NOT called
 * wrong resource  → adapter NOT called
 * wrong counterparty / tenant → adapter NOT called
 * amount above the ceiling    → adapter NOT called
 * correlation mismatch        → adapter NOT called
 * usable exercise             → adapter called exactly once
 * ```
 *
 * `tests/execution-exercise.test.ts` counts the adapter's invocations for every
 * one of those rows.
 *
 * ## The grant is read, never received
 *
 * `GrantExerciseRequest` carries an id and nothing else about the grant, and
 * this service resolves it through `BoundedGrantStorePort.read` on every
 * attempt. There is no cached grant, no caller-supplied grant and no
 * fast path that skips the read, so a revocation committed a millisecond ago is
 * visible to the very next exercise — the store contract's guarantee 4,
 * "revocation visibility", relied on rather than restated.
 *
 * Re-reading on every attempt is also what makes expiry and revocation need no
 * sweeper: both are derived, at read time, from the record the store holds now
 * and the instant passed in now.
 *
 * ## It decides nothing
 *
 * There is no allow, no deny and no policy anywhere in this file. The
 * authorization that produced the grant happened earlier and elsewhere, and a
 * refusal here leaves it exactly as it was. What this service produces is an
 * `ExecutionOutcome`, whose three cases are "ran", "was withheld" and "the
 * provider failed" — none of which is a decision status, and none of which can
 * be turned into one.
 */
export interface GrantExecutionServiceOptions {
  /** The authoritative home of issued grants. Read on every exercise; never written by this service. */
  readonly store: BoundedGrantStorePort;
  /** The provider-neutral execution boundary. Invoked only after a usable assessment. */
  readonly adapter: ExecutionAdapter;
  /** The injected clock. Expiry is derived from what this returns, never from `Date.now()` — a structural test fails the build if an ambient clock appears in this module. */
  readonly now: () => string;
}

export interface GrantExecutionService {
  /**
   * The assessment alone, with no execution and no side effect.
   *
   * The `preflight`/`enforce` and `resolveAvailability`/`acquireReservation`
   * separation the repository already keeps, applied here: a host that wants to
   * know whether an action would be exercisable asks this, and nothing runs.
   */
  assess(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment>;
  /** Assess, and execute through the adapter if — and only if — the assessment is usable. */
  exercise(request: GrantExerciseRequest): Promise<ExecutionOutcome>;
}

export function createGrantExecutionService(options: GrantExecutionServiceOptions): GrantExecutionService {
  const { store, adapter, now } = options;

  async function assess(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment> {
    const identity = { boundedGrantId: request.boundedGrantId, correlation: request.correlation, executionId: request.executionId };

    // The authoritative read. A store that cannot answer throws, and a throw is
    // turned into "no grant" by the caller below — the closed direction the
    // port's contract asks the layer above to take.
    const read = await store.read(request.boundedGrantId);

    // The clock is sampled **after** the awaited lookup, never before it.
    //
    // A durable store's read takes real time, and an instant sampled before it
    // is not the instant the grant is being judged at: a read that begins one
    // millisecond before `expiresAt` and completes at `expiresAt` would
    // otherwise be assessed against the pre-read instant and report an expired
    // grant as usable. Expiry is "derived at read time" only if the time is the
    // one the read finished at.
    const at = now();

    if (read.grant === undefined) {
      return { usable: false, reasonCodes: [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND], ...identity };
    }

    return assessBoundedGrantExercise({
      grant: read.grant,
      ...(read.revocation !== undefined ? { revocation: read.revocation } : {}),
      request,
      at,
    });
  }

  return {
    async assess(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment> {
      try {
        return await assess(request);
      } catch {
        // A store that fails is a store that cannot prove a grant covers this.
        // Reported as "not found" rather than raised, because the layer above
        // must not be able to mistake an outage for an authorization.
        return {
          usable: false,
          reasonCodes: [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND],
          boundedGrantId: request.boundedGrantId,
          correlation: request.correlation,
          executionId: request.executionId,
        };
      }
    },

    async exercise(request: GrantExerciseRequest): Promise<ExecutionOutcome> {
      const correlation: ValidatedExecutionCorrelation = {
        requestId: request.correlation.requestId,
        decisionId: request.correlation.decisionId,
        executionId: request.executionId,
      };

      const notFound = (): BoundedGrantExerciseAssessment => ({
        usable: false,
        reasonCodes: [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND],
        boundedGrantId: request.boundedGrantId,
        correlation: request.correlation,
        executionId: request.executionId,
      });

      // The awaited lookup happens first; the clock is read afterwards, and the
      // one instant it yields is what both the assessment and the outcome
      // carry. Sampling before the read would judge the grant at a moment that
      // had already passed by the time the record arrived — on a slow durable
      // store, long enough to let an expired grant reach the adapter.
      let read: ReadBoundedGrantResult | undefined;
      try {
        read = await store.read(request.boundedGrantId);
      } catch {
        read = undefined;
      }
      const exercisedAt = now();

      let assessment: BoundedGrantExerciseAssessment;
      let grantExpiresAt: string | undefined;
      let grantSubject: string | undefined;
      if (read?.grant === undefined) {
        assessment = notFound();
      } else {
        grantExpiresAt = read.grant.expiresAt;
        grantSubject = read.grant.subject;
        assessment = assessBoundedGrantExercise({
          grant: read.grant,
          ...(read.revocation !== undefined ? { revocation: read.revocation } : {}),
          request,
          at: exercisedAt,
        });
      }

      if (!assessment.usable || grantExpiresAt === undefined || grantSubject === undefined) {
        return { status: 'withheld', withheldBy: 'grant-exercise', assessment, correlation, exercisedAt };
      }

      // Every value handed across the boundary is either the attempt proven to
      // be inside a bound, or a value read from the trusted grant. The subject
      // and the horizon come from the store rather than from the request, so a
      // caller describing itself differently changes nothing an adapter sees.
      const action: ValidatedExecutionAction = {
        boundedGrantId: request.boundedGrantId,
        subject: grantSubject,
        action: request.action,
        resource: request.resource,
        ...(request.counterparty !== undefined ? { counterparty: request.counterparty } : {}),
        ...(request.organization !== undefined ? { organization: request.organization } : {}),
        ...(request.amount !== undefined ? { amount: request.amount } : {}),
        notAfter: grantExpiresAt,
        correlation,
      };

      let result;
      try {
        result = await adapter.execute(action);
      } catch (error) {
        // An adapter that raises has failed to execute. It has emphatically not
        // produced an authorization outcome, and nothing here lets it: the
        // throw becomes a provider failure with the authorization untouched.
        return {
          status: 'execution-failed',
          assessment,
          correlation,
          adapterId: adapter.adapterId,
          reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR,
          ...(error instanceof Error && error.message.length > 0 ? { detail: error.message } : {}),
          exercisedAt,
        };
      }

      if (result.outcome === 'failed') {
        return {
          status: 'execution-failed',
          assessment,
          correlation,
          adapterId: adapter.adapterId,
          reason: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          exercisedAt,
        };
      }

      return {
        status: 'executed',
        assessment,
        correlation,
        adapterId: adapter.adapterId,
        ...(result.providerRef !== undefined ? { providerRef: result.providerRef } : {}),
        exercisedAt,
      };
    },
  };
}
