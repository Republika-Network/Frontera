import {
  toMs,
  toTimestamp,
  type AcceptedObservation,
  type CredentialState,
  type EvaluationProposal,
  type ExpectedOutcome,
  type ObservedOutcome,
  type OutcomeClass,
  type RequirementResult,
  type ResultCategory,
} from './contracts.js';
import { sdkSupported, type ConformanceProfileDefinition, type ConformanceRequirementDefinition } from './profile.js';

/**
 * RN-CONFORM-02 / WP-09 — the deterministic conformance evaluator.
 *
 * Pure: no clock, no store, no randomness, no I/O. The same inputs always give
 * the same output, and the output never contains a conclusion supplied by a
 * validator — validators submit outcomes, this module classifies them.
 *
 * ## Corroboration (CC-D-03)
 *
 * Counted per **operator**, never per validator or per submission. With
 * `k = minDistinctOperators` (2), `W = windowSeconds` (30 min):
 *
 * - **Confirmed violation**: violations from ≥ k distinct operators whose
 *   observation times all fall within one window of length W.
 * - **Verified success**: conformant observations from ≥ k distinct operators
 *   within one window of length W, the latest of which is still inside the
 *   requirement's freshness window, and no unresolved violation.
 * - **Unconfirmed violation** (SR-3): fewer than k violating operators.
 *   Opens an investigation with deadline `t(v) + T_confirm`. It never
 *   suspends by itself and never revokes; if the deadline passes unresolved,
 *   SR-4 suspends (fail closed, reason `CORROBORATION_UNAVAILABLE`).
 * - **Conflicting**: an unconfirmed violation and a conformant observation
 *   from another operator, contemporaneous (|Δt| ≤ W) or later. Never a clean
 *   pass. **Resolved** only when conformant observations from at least
 *   `disputeResolutionOperators − 1` (2) operators other than the violating
 *   one follow the violation — i.e. ≥ 3 distinct operators took part. If the
 *   additional operator also observes the violation, the k-operator rule
 *   confirms it instead. Unresolved past the deadline, SR-4 suspends with
 *   `CONFLICTING_EVIDENCE`. Recency never decides a dispute.
 *
 * A confirmed violation stands until a full success window lies **entirely
 * after** it. When a credential is SUSPENDED, conformant evidence observed
 * before the suspension (`revalidationSince`) does not count at all, so
 * reinstatement requires fresh revalidation of every critical requirement,
 * not only the one that failed.
 */

export function classifyOutcome(expected: ExpectedOutcome, observed: ObservedOutcome, observedDeploymentDigest: string | null, credentialedDeploymentDigest: string): OutcomeClass {
  if (expected === 'deployment_digest_match') {
    if (observed !== 'digest_reported' || observedDeploymentDigest === null) return 'inconclusive';
    return observedDeploymentDigest === credentialedDeploymentDigest ? 'conformant' : 'violation';
  }
  // A digest report answers no enforcement challenge.
  if (observed === 'digest_reported') return 'inconclusive';
  if (observed === 'denied') return 'conformant';
  if (observed === 'allowed') return 'violation';
  // error / timeout / unreachable: neither proof of enforcement nor proof of bypass.
  return 'inconclusive';
}

export interface EngineInput {
  readonly profile: ConformanceProfileDefinition;
  readonly integration: { readonly integrationDigest: string; readonly sdk: { readonly package: string; readonly version: string } };
  /** Accepted observations for exactly this integration digest and profile. Others are ignored defensively. */
  readonly observations: readonly AcceptedObservation[];
  /** Validators whose observations no longer count (revoked or quarantined). */
  readonly excludedValidatorIds: readonly string[];
  readonly evaluatedAt: string;
  readonly credentialState: CredentialState;
  readonly revalidationSince: string | null;
}

export interface EngineOutput {
  readonly requirementResults: readonly RequirementResult[];
  readonly proposal: EvaluationProposal;
  readonly criticalFailureConfirmed: boolean;
  readonly evidenceIds: readonly string[];
}

interface Obs {
  readonly id: string;
  readonly op: string;
  readonly t: number;
  readonly cls: OutcomeClass;
}

/** The end times of every window of length `w` holding observations from ≥ `k` distinct operators. */
function windowEnds(list: readonly Obs[], k: number, w: number): number[] {
  const sorted = [...list].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const ends: number[] = [];
  for (const end of sorted) {
    const ops = new Set(sorted.filter((o) => o.t <= end.t && o.t >= end.t - w).map((o) => o.op));
    if (ops.size >= k) ends.push(end.t);
  }
  return ends;
}

function evaluateCorroborated(requirement: ConformanceRequirementDefinition, profile: ConformanceProfileDefinition, all: readonly Obs[], nowMs: number, revalidationSinceMs: number | null): RequirementResult {
  const k = profile.corroboration.minDistinctOperators;
  const w = profile.corroboration.windowSeconds * 1000;
  const tConfirm = profile.corroboration.investigationTimeoutSeconds * 1000;
  const disputeOthers = profile.corroboration.disputeResolutionOperators - 1;
  const reasons: string[] = [];
  const usable = all.filter((o) => o.cls !== 'inconclusive');
  if (usable.length !== all.length) reasons.push('INCONCLUSIVE_OBSERVATIONS_IGNORED');
  const violations = usable.filter((o) => o.cls === 'violation');
  const conformant = usable.filter((o) => o.cls === 'conformant' && (revalidationSinceMs === null || o.t >= revalidationSinceMs));
  if (revalidationSinceMs !== null && conformant.length !== usable.filter((o) => o.cls === 'conformant').length) reasons.push('PRE_SUSPENSION_EVIDENCE_NOT_COUNTED');

  const base = {
    requirementId: requirement.requirementId,
    severity: requirement.severity,
    evidenceIds: Object.freeze(usable.map((o) => o.id).sort()),
  };
  const result = (category: ResultCategory, extra: Partial<Omit<RequirementResult, 'requirementId' | 'severity' | 'category' | 'evidenceIds'>> = {}): RequirementResult =>
    Object.freeze({
      ...base,
      category,
      reasonCodes: Object.freeze([...reasons, ...(extra.reasonCodes ?? [])]),
      conformantOperators: Object.freeze([...new Set(conformant.map((o) => o.op))].sort()),
      violationOperators: Object.freeze([...new Set(violations.map((o) => o.op))].sort()),
      latestSuccessAt: extra.latestSuccessAt ?? null,
      freshUntil: extra.freshUntil ?? null,
      confirmedFailureAt: extra.confirmedFailureAt ?? null,
      investigationDeadline: extra.investigationDeadline ?? null,
    });

  // 1. The latest confirmed violation, if one exists.
  const confirmedEnds = windowEnds(violations, k, w);
  const lastConfirmed = confirmedEnds.length === 0 ? null : Math.max(...confirmedEnds);
  const after = (o: Obs) => lastConfirmed === null || o.t > lastConfirmed;
  const postConformant = conformant.filter(after);
  const postViolations = violations.filter(after);
  const successEnds = windowEnds(postConformant, k, w);
  if (lastConfirmed !== null && successEnds.length === 0) {
    return result('VERIFIED_FAILURE', { reasonCodes: ['CORROBORATED_VIOLATION'], confirmedFailureAt: toTimestamp(lastConfirmed) });
  }

  // 2. Unconfirmed violations after the last confirmed one: resolved only by ≥ 2 other operators observing conformance afterwards.
  const resolved = (v: Obs) => new Set(postConformant.filter((c) => c.op !== v.op && c.t > v.t).map((c) => c.op)).size >= disputeOthers;
  const unresolved = postViolations.filter((v) => !resolved(v)).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  if (postViolations.length > unresolved.length) reasons.push('DISPUTE_RESOLVED_BY_ADDITIONAL_OPERATORS');
  if (lastConfirmed !== null) reasons.push('REMEDIATED_AFTER_CONFIRMED_VIOLATION');
  const first = unresolved[0];
  if (first !== undefined) {
    const deadline = first.t + tConfirm;
    const expired = nowMs > deadline;
    const conflicting = postConformant.some((c) => c.op !== first.op && (c.t > first.t || first.t - c.t <= w));
    return result(conflicting ? 'CONFLICTING' : 'UNCONFIRMED_VIOLATION', {
      reasonCodes: [conflicting ? 'OPERATORS_DISAGREE' : 'SINGLE_OPERATOR_VIOLATION', ...(expired ? ['INVESTIGATION_EXPIRED'] : ['INVESTIGATION_OPEN'])],
      investigationDeadline: toTimestamp(deadline),
    });
  }

  // 3. Success, staleness or absence.
  if (successEnds.length === 0) return result('INSUFFICIENT_EVIDENCE', { reasonCodes: ['NO_CORROBORATED_SUCCESS'] });
  const latest = Math.max(...successEnds);
  const freshUntil = latest + (requirement.freshnessSeconds ?? 0) * 1000;
  if (nowMs > freshUntil) return result('STALE_EVIDENCE', { reasonCodes: ['FRESHNESS_WINDOW_LAPSED'], latestSuccessAt: toTimestamp(latest), freshUntil: toTimestamp(freshUntil) });
  return result('VERIFIED_SUCCESS', { reasonCodes: ['CORROBORATED_SUCCESS'], latestSuccessAt: toTimestamp(latest), freshUntil: toTimestamp(freshUntil) });
}

function deterministic(requirement: ConformanceRequirementDefinition, category: ResultCategory, reason: string, extra: { latestSuccessAt?: string | null; freshUntil?: string | null } = {}): RequirementResult {
  return Object.freeze({
    requirementId: requirement.requirementId,
    severity: requirement.severity,
    category,
    reasonCodes: Object.freeze([reason]),
    conformantOperators: Object.freeze([]),
    violationOperators: Object.freeze([]),
    evidenceIds: Object.freeze([]),
    latestSuccessAt: extra.latestSuccessAt ?? null,
    freshUntil: extra.freshUntil ?? null,
    confirmedFailureAt: null,
    investigationDeadline: null,
  });
}

export function evaluateConformance(input: EngineInput): EngineOutput {
  const { profile } = input;
  const nowMs = toMs(input.evaluatedAt);
  if (!Number.isFinite(nowMs)) throw new TypeError('evaluatedAt must be a timestamp.');
  const revalidationSinceMs = input.revalidationSince === null ? null : toMs(input.revalidationSince);
  const excluded = new Set(input.excludedValidatorIds);
  const relevant = input.observations.filter(
    (o) =>
      o.integrationDigest === input.integration.integrationDigest &&
      o.profileId === profile.profileId &&
      o.profileVersion === profile.profileVersion &&
      !excluded.has(o.validatorId) &&
      toMs(o.observedAt) <= nowMs,
  );

  const corroborated: RequirementResult[] = [];
  const byId = new Map<string, RequirementResult>();
  for (const requirement of profile.requirements) {
    if (requirement.evaluation !== 'validator-corroborated') continue;
    const observations = relevant
      .filter((o) => o.controlId === requirement.requirementId)
      .map((o): Obs => ({ id: o.eventId, op: o.operatorId, t: toMs(o.observedAt), cls: o.outcomeClass }));
    const result = evaluateCorroborated(requirement, profile, observations, nowMs, revalidationSinceMs);
    corroborated.push(result);
    byId.set(requirement.requirementId, result);
  }
  const criticalCorroborated = corroborated.filter((r) => r.severity === 'critical');

  for (const requirement of profile.requirements) {
    if (byId.has(requirement.requirementId)) continue;
    let result: RequirementResult;
    switch (requirement.evaluation) {
      case 'deterministic-freshness': {
        // Freshness only: a requirement under dispute or confirmed failing is judged by its own result, not again here.
        const stale = criticalCorroborated.some((r) => r.category === 'STALE_EVIDENCE');
        const allFresh = criticalCorroborated.length > 0 && !criticalCorroborated.some((r) => r.category === 'INSUFFICIENT_EVIDENCE');
        const freshUntils = criticalCorroborated.map((r) => r.freshUntil).filter((v): v is string => v !== null).sort();
        result = stale
          ? deterministic(requirement, 'STALE_EVIDENCE', 'CRITICAL_EVIDENCE_STALE')
          : allFresh
            ? deterministic(requirement, 'VERIFIED_SUCCESS', 'ALL_CRITICAL_EVIDENCE_FRESH', { freshUntil: freshUntils[0] ?? null })
            : deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'CRITICAL_EVIDENCE_INCOMPLETE');
        break;
      }
      case 'deterministic-sdk':
        result =
          profile.supportedSdk === null
            ? deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'SDK_UNDEFINED_CC_D_10')
            : sdkSupported(profile, input.integration.sdk.package, input.integration.sdk.version)
              ? deterministic(requirement, 'VERIFIED_SUCCESS', 'SDK_IN_SUPPORTED_RANGE')
              : deterministic(requirement, 'VERIFIED_FAILURE', 'SDK_OUTSIDE_SUPPORTED_RANGE');
        break;
      case 'deterministic-dispute':
        result = corroborated.some((r) => r.category === 'CONFLICTING')
          ? deterministic(requirement, 'CONFLICTING', 'OPERATORS_DISAGREE')
          : deterministic(requirement, 'VERIFIED_SUCCESS', 'NO_UNRESOLVED_DISPUTE');
        break;
      case 'human-review':
        result = deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'HUMAN_REVIEW_NOT_IMPLEMENTED');
        break;
      case 'unimplemented-challenge':
        result = deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'CHALLENGE_NOT_IMPLEMENTED');
        break;
      default:
        result = deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED_EVALUATION');
    }
    byId.set(requirement.requirementId, result);
  }

  const requirementResults = Object.freeze(profile.requirements.map((r) => byId.get(r.requirementId)!));
  const critical = requirementResults.filter((r) => r.severity === 'critical');
  const criticalFailureConfirmed = critical.some((r) => r.category === 'VERIFIED_FAILURE');
  const evidenceIds = Object.freeze([...new Set(requirementResults.flatMap((r) => r.evidenceIds))].sort());
  const graceMs = profile.freshnessGraceSeconds * 1000;
  const openInvestigations = critical.filter((r) => r.category === 'UNCONFIRMED_VIOLATION' || r.category === 'CONFLICTING');

  let proposal: EvaluationProposal;
  if (input.credentialState === 'ACTIVE') {
    const expired = openInvestigations.filter((r) => r.investigationDeadline !== null && nowMs > toMs(r.investigationDeadline));
    const lapsed = critical.filter(
      (r) => r.category === 'INSUFFICIENT_EVIDENCE' || (r.category === 'STALE_EVIDENCE' && r.freshUntil !== null && nowMs > toMs(r.freshUntil) + graceMs),
    );
    const inGrace = critical.some((r) => r.category === 'STALE_EVIDENCE');
    if (criticalFailureConfirmed) proposal = { kind: 'SUSPEND', ruleId: 'SR-1', reasonCode: 'CRITICAL_VIOLATION_CONFIRMED' };
    else if (expired.length > 0)
      proposal = { kind: 'SUSPEND', ruleId: 'SR-4', reasonCode: expired.some((r) => r.category === 'CONFLICTING') ? 'CONFLICTING_EVIDENCE' : 'CORROBORATION_UNAVAILABLE' };
    else if (lapsed.length > 0) proposal = { kind: 'SUSPEND', ruleId: 'SR-2', reasonCode: 'EVIDENCE_STALE' };
    else if (openInvestigations.length > 0) proposal = { kind: 'NONE', reasonCode: 'UNDER_INVESTIGATION' };
    else if (inGrace) proposal = { kind: 'NONE', reasonCode: 'EVIDENCE_IN_GRACE' };
    else proposal = { kind: 'NONE', reasonCode: 'CONFORMANT' };
  } else if (input.credentialState === 'CANDIDATE' || input.credentialState === 'SUSPENDED') {
    const eligible = critical.length > 0 && critical.every((r) => r.category === 'VERIFIED_SUCCESS');
    proposal = eligible ? { kind: 'ELIGIBLE_FOR_ACTIVE', reasonCode: 'ALL_CRITICAL_VERIFIED' } : { kind: 'NONE', reasonCode: 'NOT_ELIGIBLE' };
  } else {
    proposal = { kind: 'NONE', reasonCode: 'NOT_ACTIVE' };
  }

  return Object.freeze({ requirementResults, proposal: Object.freeze(proposal), criticalFailureConfirmed, evidenceIds });
}
