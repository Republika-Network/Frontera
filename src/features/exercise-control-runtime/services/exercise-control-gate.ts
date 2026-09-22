import {
  EXERCISE_CONTROL_REASON_CODES,
  exerciseControlPolicyDigest,
  exerciseDecimalFromNumber,
  exerciseReservationId,
  exerciseReservationRequestDigest,
  isExerciseControlReasonCode,
  snapshotExerciseControlLimits,
  verifyExerciseAuthorityBinding,
  type ExerciseAuthorityBindingDigestResolver,
  type ExerciseControlLedgerPort,
  type ExerciseControlLimit,
  type ExerciseControlObserver,
  type ExerciseControlPolicy,
  type ExerciseControlQuery,
  type ExerciseControlReasonCode,
  type ExerciseControlRuleUsage,
  type ExerciseReservationObservation,
  type ExerciseReservationReleaseReason,
  type ExerciseReservationRequest,
  type ExerciseReservationSettleReason,
  type ExerciseReservationTerminalOutcome,
} from '../domain/index.js';

/**
 * The exercise-control gate: aggregate / velocity limits and exercise-time
 * authority-binding revalidation, for one exercise that the bounded grant has
 * **already** been proven to cover.
 *
 * ```
 * authoritative grant read #1 -> containment #1 -> emergency #1   (the execution service)
 *   -> authority-binding revalidation #1                           admit()
 *   -> trusted policy snapshot                                     admit()
 *   -> ATOMIC reservation across every applicable limit            admit()
 *   -> authoritative grant read #2 -> containment #2 (fresh instant) (the execution service)
 *   -> authority-binding revalidation #2                           revalidate()
 *   -> emergency control re-check                                  (the execution service)
 *   -> adapter                                                     (the execution service)
 *   -> settle or release                                           finalize()
 * ```
 *
 * The reservation can wait on a write lock, so everything that authorizes the
 * effect is re-established after it: the grant is read again and re-assessed
 * at a fresh instant, the binding is revalidated against **that** read, and
 * the emergency control is re-read. `revalidate` is synchronous — the resolver
 * is — so no awaited P7 step sits between the last revalidation and the
 * adapter. A failure at any of them is finalized by the caller as a release:
 * nothing was sent, so nothing was consumed.
 *
 * ## It narrows, and it decides nothing
 *
 * Every answer is "reserved, proceed" or "withheld, with these reason codes".
 * Nothing here can make an unusable exercise usable, extend a grant, or change
 * a decision, and the only state it writes is the reservation ledger's.
 *
 * ## Everything a caller could influence is already gone
 *
 * The query the policy and the binding resolver see is built from the trusted
 * grant and from attempt fields the grant-exercise assessment already proved
 * inside the grant. The reservation identity is derived from the grant and the
 * execution identity; the policy, the buckets, the maxima and the windows are
 * the host's. There is no parameter through which a limit, a bucket, a
 * reservation id or a binding digest could arrive from a request.
 */
export interface ExerciseControlGateOptions {
  /** Trusted host policy. Synchronous, no I/O. Its answer is re-validated on every exercise. */
  readonly policy: ExerciseControlPolicy;
  /** Trusted exercise-time binding resolver, as a canonical digest. Synchronous, read-only. */
  readonly authorityBinding: ExerciseAuthorityBindingDigestResolver;
  /** The authoritative consumption state. Held here and handed to nothing else — never to an adapter, a policy or a resolver. */
  readonly reservationLedger: ExerciseControlLedgerPort;
  /** The injected clock. Used for terminal-event instants; never `Date.now()`. The reservation instant is the ledger's, sampled inside its own critical section. */
  readonly now: () => string;
  /**
   * P8 — a write-only observer told, **after** the ledger proved it, that a
   * reservation was admitted, settled or released. Evidence only: its answer is
   * never read and its failure is swallowed, so omitting it, or composing one
   * that throws, changes no admission, no finalization and no outcome.
   */
  readonly observer?: ExerciseControlObserver;
}

/** What the gate is told about one exercise. Every field was read from the authoritative grant or proven inside it. */
export interface ExerciseControlAdmissionInput {
  readonly grant: {
    readonly id: string;
    readonly subject: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly correlation: ExerciseControlQuery['correlation'];
    /** The grant's own binding provenance, when it has one. A grant without it cannot be revalidated and is withheld. */
    readonly authorityBindingDigest?: string;
  };
  readonly attempt: {
    readonly action: string;
    readonly resource: string;
    readonly counterparty?: string;
    readonly organization?: string;
    readonly amount?: { readonly value: number; readonly unit: string };
  };
  readonly executionId: string;
  /**
   * The exercise instant: the one the grant was assessed at. The policy and the
   * binding resolver are asked at it. It is **not** the reservation instant —
   * the ledger assigns that itself, inside its critical section, after any
   * lock wait.
   */
  readonly at: string;
}

/** An admitted reservation, as the execution service holds it between reservation and finalization. Opaque; never handed to an adapter or returned to a caller. */
export interface ExerciseReservationHandle {
  readonly reservationId: string;
  /** The binding provenance the reservation was admitted under. The post-reservation revalidation requires the re-read grant to carry exactly this. */
  readonly authorityBindingDigest: string;
}

export type ExerciseControlAdmission =
  | { readonly kind: 'admitted'; readonly reservation: ExerciseReservationHandle }
  | { readonly kind: 'withheld'; readonly reasonCodes: readonly ExerciseControlReasonCode[] };

/** The post-reservation authority-binding revalidation. `withheld` is finalized by the caller as a release with reason `exercise-control`. */
export type ExerciseControlRevalidation =
  | { readonly kind: 'verified' }
  | { readonly kind: 'withheld'; readonly reasonCodes: readonly ExerciseControlReasonCode[] };

/**
 * What happens to a reservation once the effect is known.
 *
 * Closed, and chosen by the caller from the outcome it actually observed:
 * `settle` for an effect that happened or may have happened, `release` for an
 * effect the port contract says did not complete or that was withheld before
 * any provider was reached.
 */
export type ExerciseReservationDisposition =
  | { readonly kind: 'settle'; readonly reason: ExerciseReservationSettleReason }
  | { readonly kind: 'release'; readonly reason: ExerciseReservationReleaseReason };

/**
 * What finalization achieved. `retained` means the terminal event could not be
 * recorded — the ledger threw, or a different event already stands — and the
 * reservation therefore still consumes capacity. That is a safe loss of
 * availability, never a widening, and it never rewrites the outcome the
 * provider produced.
 */
export type ExerciseReservationFinalization = 'settled' | 'released' | 'retained';

export interface ExerciseControlGate {
  /** Binding revalidation #1, the policy snapshot and the atomic reservation. */
  admit(input: ExerciseControlAdmissionInput): Promise<ExerciseControlAdmission>;
  /**
   * Binding revalidation #2, after the reservation **and** after the caller's
   * second authoritative grant read and assessment. `input` is built from that
   * second read, at that assessment's fresh instant. Synchronous, so nothing
   * awaited can sit between it and the adapter. Releases nothing itself.
   */
  revalidate(reservation: ExerciseReservationHandle, input: ExerciseControlAdmissionInput): ExerciseControlRevalidation;
  finalize(reservation: ExerciseReservationHandle, disposition: ExerciseReservationDisposition): Promise<ExerciseReservationFinalization>;
}

const R = EXERCISE_CONTROL_REASON_CODES;

function withheld(...reasonCodes: readonly ExerciseControlReasonCode[]): { readonly kind: 'withheld'; readonly reasonCodes: readonly ExerciseControlReasonCode[] } {
  return { kind: 'withheld', reasonCodes: Object.freeze([...reasonCodes]) };
}

/** The frozen query both trusted callbacks receive. Built field by field, so nothing an input object carries beyond these fields can travel with it. */
function queryFor(input: ExerciseControlAdmissionInput, at: string): ExerciseControlQuery {
  const { grant, attempt } = input;
  return Object.freeze({
    boundedGrantId: grant.id,
    subject: grant.subject,
    action: attempt.action,
    resource: attempt.resource,
    ...(attempt.counterparty !== undefined ? { counterparty: attempt.counterparty } : {}),
    ...(attempt.organization !== undefined ? { organization: attempt.organization } : {}),
    ...(attempt.amount !== undefined ? { amount: Object.freeze({ value: attempt.amount.value, unit: attempt.amount.unit }) } : {}),
    correlation: Object.freeze({
      requestId: grant.correlation.requestId,
      decisionId: grant.correlation.decisionId,
      action: grant.correlation.action,
      resourceScope: grant.correlation.resourceScope,
    }),
    grantIssuedAt: grant.issuedAt,
    grantExpiresAt: grant.expiresAt,
    at,
  });
}

/** Whether a ledger's refusal names only codes a ledger may own. Anything else is a ledger outside its contract. */
function isLedgerRefusalCode(code: unknown): code is ExerciseControlReasonCode {
  return isExerciseControlReasonCode(code) && (code === R.EXERCISE_CONTROL_LIMIT_EXCEEDED || code === R.EXERCISE_CONTROL_UNIT_MISMATCH);
}

export function createExerciseControlGate(options: ExerciseControlGateOptions): ExerciseControlGate {
  const { policy, authorityBinding, reservationLedger: ledger, now } = options;
  const observer = options.observer;

  /**
   * What the admission proved about each live reservation, for the terminal
   * observation. Keyed by the opaque handle, so nothing about a reservation is
   * added to the handle the execution service holds.
   */
  const admitted = new WeakMap<ExerciseReservationHandle, { readonly executionId: string; readonly boundedGrantId: string; readonly requestId: string; readonly decisionId: string }>();

  /**
   * Evidence only, and never awaited: the observer enqueues and returns `void`,
   * so an observation whose durable projection is slow, stuck or never settles
   * cannot hold an admission between a committed reservation and the provider
   * crossing, or a finalization between a recorded terminal event and the
   * caller. Any synchronous throw is discarded, and nothing here is ever read
   * back.
   */
  function observe(observation: () => ExerciseReservationObservation | undefined): void {
    if (observer === undefined) return;
    try {
      const built = observation();
      if (built !== undefined) observer.reservationObserved(built);
    } catch {
      // An observer can never change an admission, a finalization or an outcome.
    }
  }

  /** The terminal event the ledger actually recorded — the first one, on an identical repeat. Anything else was not recorded, so it is not observed. */
  function terminalObservation(reservation: ExerciseReservationHandle, result: ExerciseReservationTerminalOutcome): ExerciseReservationObservation | undefined {
    const facts = admitted.get(reservation);
    if (facts === undefined || result.outcome === 'conflict' || result.outcome === 'not-found') return undefined;
    const terminal = result.terminal;
    if (terminal.reservationId !== reservation.reservationId) return undefined;
    if (terminal.kind === 'settled' && (terminal.reason === 'executed' || terminal.reason === 'execution-unconfirmed')) {
      return { kind: 'settled', reservationId: terminal.reservationId, ...facts, reason: terminal.reason, recordedAt: terminal.recordedAt };
    }
    if (terminal.kind === 'released' && terminal.reason !== 'executed' && terminal.reason !== 'execution-unconfirmed') {
      return { kind: 'released', reservationId: terminal.reservationId, ...facts, reason: terminal.reason, recordedAt: terminal.recordedAt };
    }
    return undefined;
  }

  async function release(reservation: ExerciseReservationHandle, reason: ExerciseReservationReleaseReason): Promise<ExerciseReservationFinalization> {
    let released: ExerciseReservationTerminalOutcome;
    try {
      released = await ledger.release({ reservationId: reservation.reservationId, reason, recordedAt: now() });
    } catch {
      // A release that cannot be recorded is not pretended. The reservation
      // stays `reserved`, which still consumes: safe availability loss.
      return 'retained';
    }
    const finalization = released.outcome === 'released' || released.outcome === 'already-released' ? 'released' : 'retained';
    // Decided above, from the ledger alone; the observation cannot move it.
    if (finalization === 'released') observe(() => terminalObservation(reservation, released));
    return finalization;
  }

  return Object.freeze({
    async admit(input: ExerciseControlAdmissionInput): Promise<ExerciseControlAdmission> {
      const query = queryFor(input, input.at);

      // 1. Exercise-time authority-binding revalidation #1. Before the policy,
      //    before the ledger: an authority that no longer stands exactly as it
      //    did at issuance consumes nothing and reaches nothing.
      const first = verifyExerciseAuthorityBinding(input.grant.authorityBindingDigest, authorityBinding, query);
      if (!first.verified) return withheld(first.reasonCode);
      const authorityBindingDigest = input.grant.authorityBindingDigest as string;

      // 2. The trusted policy, read once into a validated snapshot. A throw, a
      //    promise, a getter, a Proxy that misbehaves or any limit outside the
      //    closed contract is an unbelievable policy, and withholds.
      let limits: readonly ExerciseControlLimit[] | undefined;
      try {
        limits = snapshotExerciseControlLimits(policy(query));
      } catch {
        limits = undefined;
      }
      if (limits === undefined) return withheld(R.EXERCISE_CONTROL_POLICY_INVALID);

      // 3. What this execution consumes of each limit. Converted from the
      //    attempt's number to canonical decimal text exactly once; from here
      //    on only exact arithmetic touches it.
      const amount = input.attempt.amount;
      const decimal = amount === undefined ? undefined : exerciseDecimalFromNumber(amount.value);
      if (amount !== undefined && decimal === undefined) return withheld(R.EXERCISE_CONTROL_AMOUNT_REQUIRED);
      let amountRequired = false;
      let unitMismatch = false;
      const rules: ExerciseControlRuleUsage[] = [];
      for (const limit of limits) {
        if (limit.metric === 'count') {
          rules.push(Object.freeze({ limit, usage: '1' }));
          continue;
        }
        if (amount === undefined || decimal === undefined) {
          amountRequired = true;
          continue;
        }
        if (amount.unit !== limit.unit) {
          unitMismatch = true;
          continue;
        }
        rules.push(Object.freeze({ limit, usage: decimal }));
      }
      if (amountRequired || unitMismatch) {
        return withheld(...(amountRequired ? [R.EXERCISE_CONTROL_AMOUNT_REQUIRED] : []), ...(unitMismatch ? [R.EXERCISE_CONTROL_UNIT_MISMATCH] : []));
      }

      // 4. The reservation: derived identity, canonical fingerprints, and one
      //    atomic admission across every applicable limit. No instant travels
      //    with it: the ledger assigns the reservation instant inside its own
      //    critical section, after any write-lock wait.
      const reservationId = exerciseReservationId({ boundedGrantId: input.grant.id, executionId: input.executionId });
      const request: ExerciseReservationRequest = Object.freeze({
        reservationId,
        executionId: input.executionId,
        boundedGrantId: input.grant.id,
        requestDigest: exerciseReservationRequestDigest({
          boundedGrantId: input.grant.id,
          executionId: input.executionId,
          subject: query.subject,
          action: query.action,
          resource: query.resource,
          ...(query.counterparty !== undefined ? { counterparty: query.counterparty } : {}),
          ...(query.organization !== undefined ? { organization: query.organization } : {}),
          ...(amount !== undefined && decimal !== undefined ? { amount: { value: decimal, unit: amount.unit } } : {}),
          correlation: query.correlation,
        }),
        policyDigest: exerciseControlPolicyDigest(limits),
        authorityBindingDigest,
        rules: Object.freeze(rules),
      });

      let outcome: unknown;
      let kind: unknown;
      try {
        outcome = await ledger.reserve(request);
        kind = (outcome as { readonly outcome?: unknown }).outcome;
      } catch {
        return withheld(R.EXERCISE_CONTROL_LEDGER_UNAVAILABLE);
      }
      if (kind === 'already-reserved') return withheld(R.EXERCISE_CONTROL_EXECUTION_ALREADY_RESERVED);
      if (kind === 'conflict') return withheld(R.EXERCISE_CONTROL_RESERVATION_CONFLICT);
      if (kind === 'refused') {
        let codes: readonly ExerciseControlReasonCode[] = [];
        try {
          const reported = (outcome as { readonly reasonCodes?: unknown }).reasonCodes;
          codes = Array.isArray(reported) && reported.length > 0 && reported.every(isLedgerRefusalCode) ? [...new Set(reported as ExerciseControlReasonCode[])] : [];
        } catch {
          codes = [];
        }
        return codes.length > 0 ? withheld(...codes) : withheld(R.EXERCISE_CONTROL_LEDGER_UNAVAILABLE);
      }
      if (kind !== 'reserved') return withheld(R.EXERCISE_CONTROL_LEDGER_UNAVAILABLE);
      const handle: ExerciseReservationHandle = Object.freeze({ reservationId, authorityBindingDigest });
      const facts = { executionId: input.executionId, boundedGrantId: input.grant.id, requestId: query.correlation.requestId, decisionId: query.correlation.decisionId };
      admitted.set(handle, facts);
      // Evidence of the admission the ledger just committed, from the record it
      // returned. Downstream of the decision above; it cannot change it.
      observe(() => {
        const recorded = (outcome as { readonly reservation?: { readonly reservationId?: unknown; readonly policyDigest?: unknown; readonly authorityBindingDigest?: unknown; readonly reservedAt?: unknown } }).reservation;
        if (recorded?.reservationId !== reservationId || typeof recorded.reservedAt !== 'string' || typeof recorded.policyDigest !== 'string' || typeof recorded.authorityBindingDigest !== 'string') return undefined;
        return { kind: 'reserved', reservationId, ...facts, policyDigest: recorded.policyDigest, authorityBindingDigest: recorded.authorityBindingDigest, admittedAt: recorded.reservedAt };
      });
      return { kind: 'admitted', reservation: handle };
    },

    revalidate(reservation: ExerciseReservationHandle, input: ExerciseControlAdmissionInput): ExerciseControlRevalidation {
      // The re-read grant must still be the one the reservation was made for:
      // same derived identity, same binding provenance. Anything else is a
      // reservation that no longer describes this attempt.
      if (exerciseReservationId({ boundedGrantId: input.grant.id, executionId: input.executionId }) !== reservation.reservationId) {
        return withheld(R.EXERCISE_CONTROL_RESERVATION_CONFLICT);
      }
      // 5. Exercise-time authority-binding revalidation #2, against the second
      //    authoritative grant read and at its fresh instant. The reservation
      //    may have waited on a write lock; a binding that changed meanwhile
      //    must not reach the provider.
      const second = verifyExerciseAuthorityBinding(input.grant.authorityBindingDigest, authorityBinding, queryFor(input, input.at));
      if (!second.verified) return withheld(second.reasonCode);
      if (input.grant.authorityBindingDigest !== reservation.authorityBindingDigest) {
        return withheld(R.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED);
      }
      return { kind: 'verified' };
    },

    async finalize(reservation: ExerciseReservationHandle, disposition: ExerciseReservationDisposition): Promise<ExerciseReservationFinalization> {
      if (disposition.kind === 'release') return release(reservation, disposition.reason);
      let settled: ExerciseReservationTerminalOutcome;
      try {
        settled = await ledger.settle({ reservationId: reservation.reservationId, reason: disposition.reason, recordedAt: now() });
      } catch {
        // A settlement that cannot be recorded leaves the reservation
        // `reserved` — still consuming — and never rewrites what the provider did.
        return 'retained';
      }
      const finalization = settled.outcome === 'settled' || settled.outcome === 'already-settled' ? 'settled' : 'retained';
      if (finalization === 'settled') observe(() => terminalObservation(reservation, settled));
      return finalization;
    },
  });
}
