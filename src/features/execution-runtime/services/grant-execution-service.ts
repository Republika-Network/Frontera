import {
  emergencyControlPermits,
  isEmergencyControlWithheldError,
  readEmergencyControl,
  type EmergencyControlQuery,
  type EmergencyControlReaderPort,
} from '../../emergency-control-runtime/index.js';
import type { BoundedGrantReaderPort, ReadBoundedGrantResult } from '../../grant-runtime/index.js';
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
import { isExecutionAdapterRegistry } from './execution-adapter-registry.js';

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
 * emergency control active    → adapter NOT called
 * emergency control unreadable→ adapter NOT called
 * usable exercise, stop clear → adapter called exactly once
 * ```
 *
 * `tests/execution-exercise.test.ts` and
 * `tests/execution-emergency-control.test.ts` count the adapter's invocations
 * for every one of those rows.
 *
 * ## The grant is read, never received
 *
 * `GrantExerciseRequest` carries an id and nothing else about the grant, and
 * this service resolves it through `BoundedGrantReaderPort.read` on every
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
 * `ExecutionOutcome`, whose cases are "ran", "was withheld" and "the provider
 * failed" — none of which is a decision status, and none of which can be
 * turned into one. That includes the emergency-control case: an operational
 * stop withholds an effect, and leaves the authorization, the grant and the
 * containment assessment exactly as they were.
 */
export interface GrantExecutionServiceOptions {
  /**
   * The authoritative home of issued grants. Read on every exercise; never
   * written by this service.
   *
   * Typed as the **read-only** port rather than the full store, so "this
   * service never writes a grant" is enforced by the compiler as well as by
   * `tests/execution-layer-boundaries.test.ts`. A host still injects its whole
   * store — `BoundedGrantStorePort` extends `BoundedGrantReaderPort`, so
   * nothing about composition changes; what changes is that `issue` and
   * `revoke` are not reachable from here even by accident.
   */
  readonly store: BoundedGrantReaderPort;
  /**
   * The provider-neutral execution boundary. Invoked only after a usable
   * assessment **and** a clear emergency control.
   *
   * It may be one provider adapter, or the composite
   * `createExecutionAdapterRegistry(...)` — this service cannot tell the
   * difference and must not: which provider translates an authorized action is
   * a trusted host-routing question, decided below this port.
   */
  readonly adapter: ExecutionAdapter;
  /**
   * The operational safety interlock, when the deployment composed one.
   *
   * Read **after** the authoritative grant read and the containment assessment,
   * and **before** the adapter — so a grant that is still perfectly valid
   * cannot reach a provider while a stop is active. Omitting it preserves this
   * service's previous behaviour exactly: no reader, no check, and no
   * permissive stand-in invented in its place.
   *
   * The `adapter` scope is deliberately **not** queried here, because the
   * adapter this service holds may be a composite and the child is not yet
   * known. That check belongs to the registry, after routing.
   */
  readonly emergencyControl?: EmergencyControlReaderPort;
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
  const emergencyControl = options.emergencyControl;

  /**
   * Whether the composed adapter is an actual `createExecutionAdapterRegistry`
   * product, decided **once, at composition**, from a `WeakSet` no other module
   * can add to.
   *
   * Two things this service would otherwise take on an adapter's word depend on
   * it, and both are claims a directly composed adapter has no standing to
   * make: that some *other* adapter performed the effect, and that an
   * *emergency control* — not the adapter itself — stopped it. Only a registry
   * has the facts behind either: it resolved the child from a membership frozen
   * at construction, and it read the `EmergencyControlReaderPort` before
   * reaching that child. Nothing a direct adapter returns or throws can put it
   * in that position, so nothing it returns or throws is read that way.
   *
   * Resolved here rather than per-exercise because `adapter` is fixed at
   * composition: the answer cannot change while traffic flows, and a decision
   * made once cannot be raced.
   */
  const adapterIsTrustedRegistry = isExecutionAdapterRegistry(adapter);

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

      // The effect-time interlock. It runs **after** the authoritative grant
      // read and the containment assessment, so what it decides about is an
      // action that is genuinely covered by a genuinely valid grant, and
      // **before** anything is handed across the provider boundary. A stop that
      // turned on while the grant was being read is therefore still honoured.
      //
      // Every value in the query is trusted: the holder and the horizon came
      // from the store, the organization and the resource were proven inside
      // the grant's bounds. Nothing a caller described reaches it.
      const exerciseControl = readEmergencyControl(emergencyControl, {
        ...(request.organization !== undefined ? { organizationId: request.organization } : {}),
        actorId: grantSubject,
        resource: request.resource,
      } satisfies EmergencyControlQuery);
      if (!emergencyControlPermits(exerciseControl)) {
        return {
          status: 'withheld',
          withheldBy: 'emergency-control',
          assessment,
          emergencyControl: {
            reasonCodes: exerciseControl.reasonCodes,
            matchedScopes: exerciseControl.state === 'blocked' ? exerciseControl.matchedScopes : [],
          },
          correlation,
          exercisedAt,
        };
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

      // The adapter that actually performed the effect, and the composite that
      // selected it when one did. A plain adapter names itself; the registry
      // names the child trusted routing chose, so "which provider did this" is
      // answerable from the outcome and from the durable record built on it.
      //
      // `result.adapterId` is read **only** from a trusted registry. It is a
      // field on `ExecutionAdapterResult`, which means every adapter
      // implementation in existence can set it, including ones a host wrote and
      // ones it merely installed — and an effect performed by adapter A that
      // persists as adapter B's is a durable record that names the wrong party.
      // A directly composed adapter therefore cannot override its own identity:
      // whatever it returns, the outcome names the adapter this service was
      // handed. Only the registry's answer came from routing rather than from
      // the routed party's own claim about itself.
      const performedBy = (result: { readonly adapterId?: string }): { readonly adapterId: string; readonly routedBy?: string } =>
        !adapterIsTrustedRegistry || result.adapterId === undefined || result.adapterId === adapter.adapterId
          ? { adapterId: adapter.adapterId }
          : { adapterId: result.adapterId, routedBy: adapter.adapterId };

      let result;
      try {
        result = await adapter.execute(action);
      } catch (error) {
        // One typed signal, from one trusted source, and no other. A composite
        // adapter that resolved a child and found an adapter-scoped stop active
        // reports it this way, because no provider was contacted and calling
        // that a provider rejection would record a refusal nobody made.
        //
        // The **type is not the authentication** — `EmergencyControlWithheldError`
        // is an ordinary class whose constructor takes an assessment object, so
        // a directly composed adapter could construct a genuine instance and
        // throw it, turning its own provider failure into `withheldBy:
        // 'emergency-control'` when no `EmergencyControlReaderPort` withheld
        // anything. Registry membership is what authenticates it: only a
        // registry actually consults a reader before reaching a child, so only a
        // registry's throw is evidence that a reader spoke. Every other throw —
        // a plain `Error`, a lookalike, or a real instance from a direct
        // adapter — stays `ADAPTER_ERROR`.
        if (adapterIsTrustedRegistry && isEmergencyControlWithheldError(error)) {
          return {
            status: 'withheld',
            withheldBy: 'emergency-control',
            assessment,
            emergencyControl: { reasonCodes: error.reasonCodes, matchedScopes: error.matchedScopes },
            correlation,
            exercisedAt,
          };
        }
        // An adapter that raises has failed to execute. It has emphatically not
        // produced an authorization outcome, and nothing here lets it: the
        // throw becomes a provider failure with the authorization untouched.
        // A throw carries no attribution, so the adapter this service holds is
        // the most that can honestly be said. The registry converts a child's
        // throw itself, precisely so the routed case keeps its attribution.
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
          ...performedBy(result),
          reason: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          exercisedAt,
        };
      }

      return {
        status: 'executed',
        assessment,
        correlation,
        ...performedBy(result),
        ...(result.providerRef !== undefined ? { providerRef: result.providerRef } : {}),
        exercisedAt,
      };
    },
  };
}
