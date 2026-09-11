import type { ObligationCorrelation } from './obligation-correlation.js';
import type { ObligationDischargeSourceKind, ObligationDischargeVerificationClass } from './obligation-source.js';

/**
 * What a source reports about an obligation.
 *
 * ```
 * pending     the obligation has been raised and is outstanding
 * discharged  the condition was carried out
 * refused     the condition was put and answered negatively
 * waived      the deployment excused the obligation
 * ```
 *
 * Frontera does not *perform* any of these. ADR: "no automatic discharge of any
 * obligation type by Frontera itself — if the platform could discharge
 * `require-mfa` on its own, it would be performing the control rather than
 * governing it." These four are the vocabulary in which a deployment tells
 * Frontera what happened elsewhere.
 */
export type ObligationDischargeOutcome = 'pending' | 'discharged' | 'refused' | 'waived';

export const OBLIGATION_DISCHARGE_OUTCOMES: readonly ObligationDischargeOutcome[] = ['pending', 'discharged', 'refused', 'waived'];

/**
 * What a discharge provider returns: an observation, not a lifecycle state.
 *
 * The omissions are the security property, and there are two of them.
 *
 * There is **no** `verificationClass` field and no way to add one through the
 * port — a source reports what it saw and names itself, and the configured
 * `ObligationDischargeSource` registry decides what that is worth. A provider
 * cannot promote its own report, and neither can anything upstream of it,
 * including the requester.
 *
 * There is also **no** `state` field. An observation cannot name the lifecycle
 * state it wishes the obligation were in; the state is derived, by the closed
 * transition table, from what was observed and from how the citing source is
 * classified. A submitted `state: 'discharged'` has nowhere to land — which is
 * the type-level answer to the forged `{"obligation": {"state": "DISCHARGED"}}`
 * body.
 */
export interface ObligationDischargeObservation {
  /** Which obligation this is about. An observation naming an obligation the deployment did not declare for this decision is discarded. */
  readonly obligationType: string;
  /** Which authorization this is about. Anything but an exact match on all three fields is a discharge of something else. */
  readonly correlation: ObligationCorrelation;
  /** Must name a source the deployment has registered. An observation citing an unregistered source is discarded — an unknown origin is not a weak origin, it is no origin at all. */
  readonly sourceId: string;
  readonly outcome: ObligationDischargeOutcome;
  readonly observedAt: string;
  /** Who acted, when the source can say. An approver, a signer, a provider principal. Opaque to this layer. */
  readonly subjectId?: string;
  /** The source's own handle on the act — an approval id, an attestation reference, a proof id. Opaque to this layer, and never dereferenced here. */
  readonly reference?: string;
}

/**
 * The discharge an obligation actually came to rest on, with the provenance
 * that made it count.
 *
 * Distinct from the observation it derives from: `verificationClass` and
 * `sourceKind` appear here because the registry supplied them, not because
 * anyone reported them. This is the shape that travels onto the decision, and
 * it carries no payload, no free-form bag and no value — only who, where, when
 * and what.
 */
export interface ObligationDischargeRecord {
  readonly sourceId: string;
  readonly sourceKind: ObligationDischargeSourceKind;
  readonly verificationClass: ObligationDischargeVerificationClass;
  readonly outcome: ObligationDischargeOutcome;
  readonly observedAt: string;
  readonly subjectId?: string;
  readonly reference?: string;
}

/**
 * Why an observation was not applied.
 *
 * Reported rather than dropped silently, for the reason `ContextResolution`
 * reports `unresolved` rather than omitting a key: an operator debugging "why
 * is this still blocked" needs to see that a discharge arrived and was refused
 * admission, and which of the six reasons applied.
 */
export type ObligationObservationDisregardReason =
  | 'unregistered_source'
  | 'undeclared_obligation'
  | 'correlation_mismatch'
  | 'stale_observation'
  | 'waiver_not_independent'
  | 'illegal_transition';

export const OBLIGATION_OBSERVATION_DISREGARD_REASONS: readonly ObligationObservationDisregardReason[] = [
  'unregistered_source',
  'undeclared_obligation',
  'correlation_mismatch',
  'stale_observation',
  'waiver_not_independent',
  'illegal_transition',
];

/** One observation that arrived and did not count, with the reason it did not. */
export interface DisregardedObligationObservation {
  readonly obligationType: string;
  readonly sourceId: string;
  readonly outcome: ObligationDischargeOutcome;
  readonly observedAt: string;
  readonly reason: ObligationObservationDisregardReason;
}

/** Structural violations of an observation. Shape only: whether it *counts* is decided by the registry and the transition table, not here. */
export function validateObligationDischargeObservation(observation: ObligationDischargeObservation): readonly string[] {
  const violations: string[] = [];
  if (typeof observation.obligationType !== 'string' || observation.obligationType.trim().length === 0) {
    violations.push('ObligationDischargeObservation.obligationType is required and must be non-empty.');
  }
  if (typeof observation.sourceId !== 'string' || observation.sourceId.trim().length === 0) {
    violations.push(`ObligationDischargeObservation '${observation.obligationType}': sourceId is required — a discharge without an origin is not a discharge.`);
  }
  if (!OBLIGATION_DISCHARGE_OUTCOMES.includes(observation.outcome)) {
    violations.push(`ObligationDischargeObservation '${observation.obligationType}': outcome '${String(observation.outcome)}' is not a declared discharge outcome.`);
  }
  if (typeof observation.observedAt !== 'string' || Number.isNaN(Date.parse(observation.observedAt))) {
    violations.push(`ObligationDischargeObservation '${observation.obligationType}': observedAt is required and must be a valid ISO-8601 timestamp.`);
  }
  const correlation = observation.correlation;
  if (correlation === undefined || typeof correlation.requestId !== 'string' || typeof correlation.action !== 'string' || typeof correlation.resourceScope !== 'string') {
    violations.push(`ObligationDischargeObservation '${observation.obligationType}': correlation must name a requestId, an action and a resourceScope.`);
  }
  return violations;
}

/** Whether an observation is still within a declared discharge window at `at`. Total: an unparseable timestamp is not fresh, which is the safe direction. */
export function isDischargeFreshAt(observedAt: string, maxAgeSeconds: number, at: string): boolean {
  const observed = Date.parse(observedAt);
  const now = Date.parse(at);
  if (Number.isNaN(observed) || Number.isNaN(now)) return false;
  return now - observed < maxAgeSeconds * 1000;
}

/** `observedAt + maxAgeSeconds`, as an ISO-8601 instant. Returns `undefined` for an unparseable `observedAt` rather than inventing one. */
export function dischargeExpiresAt(observedAt: string, maxAgeSeconds: number): string | undefined {
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return undefined;
  return new Date(observed + maxAgeSeconds * 1000).toISOString();
}
