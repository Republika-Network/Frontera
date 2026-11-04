import {
  requiredOperations,
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
 * Every rule above is applied per **(requirement, operation)** (finding 4):
 * an enforcement challenge's evidence counts only for the exact covered
 * operation it exercised, every covered operation needs its own corroborated
 * success, and a requirement is only as good as its weakest operation. The
 * G08 deployment-digest comparison is operation-independent.
 *
 * Results are **bounded** (finding 2): each cites only the supporting
 * observations of its decisive window, never the whole history; and when the
 * caller's bounded read hit capacity (`evidenceTruncated`), no success can be
 * established, while violations among the newest observations still count.
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
  /** The credential's covered operations. Every enforcement requirement must be verified for each of them (finding 4). */
  readonly coveredOperations: readonly string[];
  /** Accepted observations for exactly this integration digest and profile. Others are ignored defensively. */
  readonly observations: readonly AcceptedObservation[];
  /** Validators whose observations no longer count (revoked or quarantined). */
  readonly excludedValidatorIds: readonly string[];
  readonly evaluatedAt: string;
  readonly credentialState: CredentialState;
  readonly revalidationSince: string | null;
  /**
   * True when the bounded evidence read hit its capacity (finding 2). The engine then fails closed:
   * conformance cannot be established (no success, no dispute resolution), while violations in the
   * newest observations it did read are still classified, so a fresh corroborated violation still
   * suspends under SR-1.
   */
  readonly evidenceTruncated?: boolean;
  /**
   * Confirmed critical violations recorded durably at acceptance (`cc_confirmed_violations`) since the
   * credential last became ACTIVE. For an ACTIVE credential each one is a standing VERIFIED_FAILURE of its
   * requirement even if later successes would clear it in the window rules: a confirmed critical bypass
   * always suspends (SR-1) and is lifted only by the two-person path (review finding P1-A). Ignored in
   * other states, where reinstatement already requires humans for them.
   */
  readonly recordedConfirmedViolations?: readonly { readonly eventId: string; readonly controlId: string; readonly operation: string; readonly observedAt: string }[];
  /**
   * RN-CONFORM-07A (SR-6): conformant observations that are NOT positively eligible now (their own testing authorization
   * was revoked or has ended), and why. Used only for an ACTIVE credential; absent means none.
   */
  readonly positivelyIneligible?: { readonly eventIds: readonly string[]; readonly revoked: boolean };
}

export interface EngineOutput {
  readonly requirementResults: readonly RequirementResult[];
  readonly proposal: EvaluationProposal;
  readonly criticalFailureConfirmed: boolean;
  readonly evidenceIds: readonly string[];
}

/**
 * Evaluation records are bounded independently of history (finding 2): a result cites at most this many
 * supporting observations per operation (the latest per operator in the decisive window), and at most
 * `MAX_LISTED_OPERATORS` operators. With `MAX_COVERED_OPERATIONS` = 16 and 8 requirements the record stays
 * well inside the canonicalization budget (4 096 nodes): roughly 1.3 k nodes at that worst case (estimate).
 */
export const MAX_SUPPORTING_OBSERVATIONS = 4;
export const MAX_LISTED_OPERATORS = 16;

interface Obs {
  readonly id: string;
  readonly op: string;
  readonly t: number;
  readonly cls: OutcomeClass;
}

const byTime = (a: Obs, b: Obs) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The end times of every window of length `w` holding observations from ≥ `k` distinct operators.
 * A sliding window over the time-sorted list: O(n log n), not O(n²).
 */
function windowEnds(list: readonly Obs[], k: number, w: number): number[] {
  const sorted = [...list].sort(byTime);
  const ends: number[] = [];
  const counts = new Map<string, number>();
  let start = 0;
  for (const end of sorted) {
    counts.set(end.op, (counts.get(end.op) ?? 0) + 1);
    while (sorted[start]!.t < end.t - w) {
      const leaving = sorted[start]!.op;
      const left = (counts.get(leaving) ?? 1) - 1;
      if (left === 0) counts.delete(leaving);
      else counts.set(leaving, left);
      start += 1;
    }
    if (counts.size >= k) ends.push(end.t);
  }
  return ends;
}

const latest = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a)));

/** The supporting set of one window: the latest observation of each operator, newest first, capped; ids in sorted order. */
function supporting(list: readonly Obs[]): string[] {
  const perOperator = new Map<string, Obs>();
  for (const o of [...list].sort(byTime).reverse()) if (!perOperator.has(o.op)) perOperator.set(o.op, o);
  return [...perOperator.values()].slice(0, MAX_SUPPORTING_OBSERVATIONS).map((o) => o.id).sort();
}

const operators = (list: readonly Obs[]) => [...new Set(list.map((o) => o.op))].sort().slice(0, MAX_LISTED_OPERATORS);

function evaluateCorroborated(
  requirement: ConformanceRequirementDefinition,
  profile: ConformanceProfileDefinition,
  all: readonly Obs[],
  nowMs: number,
  revalidationSinceMs: number | null,
  truncated: boolean,
): RequirementResult {
  const k = profile.corroboration.minDistinctOperators;
  const w = profile.corroboration.windowSeconds * 1000;
  const tConfirm = profile.corroboration.investigationTimeoutSeconds * 1000;
  const disputeOthers = profile.corroboration.disputeResolutionOperators - 1;
  const reasons: string[] = [];
  const usable = all.filter((o) => o.cls !== 'inconclusive');
  if (usable.length !== all.length) reasons.push('INCONCLUSIVE_OBSERVATIONS_IGNORED');
  const violations = usable.filter((o) => o.cls === 'violation');
  const allConformant = usable.filter((o) => o.cls === 'conformant');
  // Capacity exceeded: conformance cannot be established from a partial read (fail closed); violations still count.
  const conformant = truncated ? [] : allConformant.filter((o) => revalidationSinceMs === null || o.t >= revalidationSinceMs);
  if (truncated) reasons.push('EVALUATION_CAPACITY_EXCEEDED');
  else if (revalidationSinceMs !== null && conformant.length !== allConformant.length) reasons.push('PRE_SUSPENSION_EVIDENCE_NOT_COUNTED');

  const result = (category: ResultCategory, evidence: readonly string[], extra: Partial<Omit<RequirementResult, 'requirementId' | 'severity' | 'category' | 'evidenceIds'>> = {}): RequirementResult =>
    Object.freeze({
      requirementId: requirement.requirementId,
      severity: requirement.severity,
      category,
      reasonCodes: Object.freeze([...reasons, ...(extra.reasonCodes ?? [])]),
      conformantOperators: Object.freeze(operators(conformant)),
      violationOperators: Object.freeze(operators(violations)),
      evidenceIds: Object.freeze([...evidence]),
      latestSuccessAt: extra.latestSuccessAt ?? null,
      freshUntil: extra.freshUntil ?? null,
      confirmedFailureAt: extra.confirmedFailureAt ?? null,
      investigationDeadline: extra.investigationDeadline ?? null,
    });

  // 1. The latest confirmed violation, if one exists.
  const lastConfirmed = latest(windowEnds(violations, k, w));
  const after = (o: Obs) => lastConfirmed === null || o.t > lastConfirmed;
  const postConformant = conformant.filter(after);
  const postViolations = violations.filter(after);
  const successEnds = windowEnds(postConformant, k, w);
  if (lastConfirmed !== null && successEnds.length === 0) {
    const window = violations.filter((o) => o.t <= lastConfirmed && o.t >= lastConfirmed - w);
    return result('VERIFIED_FAILURE', supporting(window), { reasonCodes: ['CORROBORATED_VIOLATION'], confirmedFailureAt: toTimestamp(lastConfirmed) });
  }

  // 2. Unconfirmed violations after the last confirmed one: resolved only by ≥ 2 other operators observing conformance afterwards.
  const resolved = (v: Obs) => new Set(postConformant.filter((c) => c.op !== v.op && c.t > v.t).map((c) => c.op)).size >= disputeOthers;
  const unresolved = postViolations.filter((v) => !resolved(v)).sort(byTime);
  if (postViolations.length > unresolved.length) reasons.push('DISPUTE_RESOLVED_BY_ADDITIONAL_OPERATORS');
  if (lastConfirmed !== null) reasons.push('REMEDIATED_AFTER_CONFIRMED_VIOLATION');
  const first = unresolved[0];
  if (first !== undefined) {
    const deadline = first.t + tConfirm;
    const expired = nowMs > deadline;
    const disagreeing = postConformant.filter((c) => c.op !== first.op && (c.t > first.t || first.t - c.t <= w));
    const conflicting = disagreeing.length > 0;
    return result(conflicting ? 'CONFLICTING' : 'UNCONFIRMED_VIOLATION', [...new Set([first.id, ...supporting(disagreeing)])].sort(), {
      reasonCodes: [conflicting ? 'OPERATORS_DISAGREE' : 'SINGLE_OPERATOR_VIOLATION', ...(expired ? ['INVESTIGATION_EXPIRED'] : ['INVESTIGATION_OPEN'])],
      investigationDeadline: toTimestamp(deadline),
    });
  }

  // 3. Success, staleness or absence.
  const latestSuccess = latest(successEnds);
  if (latestSuccess === null) return result('INSUFFICIENT_EVIDENCE', [], { reasonCodes: ['NO_CORROBORATED_SUCCESS'] });
  const window = postConformant.filter((o) => o.t <= latestSuccess && o.t >= latestSuccess - w);
  const freshUntil = latestSuccess + (requirement.freshnessSeconds ?? 0) * 1000;
  if (nowMs > freshUntil) return result('STALE_EVIDENCE', supporting(window), { reasonCodes: ['FRESHNESS_WINDOW_LAPSED'], latestSuccessAt: toTimestamp(latestSuccess), freshUntil: toTimestamp(freshUntil) });
  return result('VERIFIED_SUCCESS', supporting(window), { reasonCodes: ['CORROBORATED_SUCCESS'], latestSuccessAt: toTimestamp(latestSuccess), freshUntil: toTimestamp(freshUntil) });
}

const INVESTIGATING: readonly ResultCategory[] = ['CONFLICTING', 'UNCONFIRMED_VIOLATION'];
/** Code-unit order: deterministic and locale-independent. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmp = (a: string | null, b: string | null) => order(a ?? '', b ?? '');

/**
 * Combines one requirement's per-operation results (finding 4). The requirement is only as good as its
 * weakest operation: a confirmed failure of any operation fails it; otherwise the investigation that
 * expires first decides; otherwise a missing operation makes it INSUFFICIENT_EVIDENCE; otherwise the
 * stalest operation decides freshness. Success needs every required operation verified. Deterministic.
 */
function combineOperations(perOperation: readonly { readonly operation: string; readonly result: RequirementResult }[]): RequirementResult {
  if (perOperation.length === 1) return perOperation[0]!.result;
  const pick = (category: ResultCategory, by: (a: RequirementResult, b: RequirementResult) => number) =>
    perOperation.filter((p) => p.result.category === category).sort((a, b) => by(a.result, b.result) || cmp(a.operation, b.operation))[0];
  const failure = pick('VERIFIED_FAILURE', (a, b) => cmp(b.confirmedFailureAt, a.confirmedFailureAt));
  // Investigations: the earliest deadline decides when SR-4 fires; a dispute on any operation makes the whole
  // requirement CONFLICTING, so an expiring single report cannot mask it (review finding P2-E).
  const open = perOperation
    .filter((p) => INVESTIGATING.includes(p.result.category))
    .sort((a, b) => cmp(a.result.investigationDeadline, b.result.investigationDeadline) || (a.result.category === b.result.category ? 0 : a.result.category === 'CONFLICTING' ? -1 : 1) || cmp(a.operation, b.operation));
  const earliest = open[0];
  const disputed = open.find((p) => p.result.category === 'CONFLICTING');
  const investigating = earliest === undefined ? undefined : { operation: earliest.operation, result: Object.freeze({ ...earliest.result, category: disputed?.result.category ?? earliest.result.category }) };
  const chosen =
    failure ?? investigating ?? pick('INSUFFICIENT_EVIDENCE', () => 0) ?? pick('STALE_EVIDENCE', (a, b) => cmp(a.freshUntil, b.freshUntil)) ?? pick('VERIFIED_SUCCESS', (a, b) => cmp(a.freshUntil, b.freshUntil))!;
  const unverified = perOperation.filter((p) => p.result.category !== 'VERIFIED_SUCCESS').map((p) => `OPERATION_${p.result.category}:${p.operation}`);
  const extraReasons = [...new Set(perOperation.flatMap((p) => p.result.reasonCodes))].filter((r) => !chosen.result.reasonCodes.includes(r)).sort();
  const union = (pickList: (r: RequirementResult) => readonly string[], cap: number) => Object.freeze([...new Set(perOperation.flatMap((p) => pickList(p.result)))].sort().slice(0, cap));
  return Object.freeze({
    ...chosen.result,
    reasonCodes: Object.freeze([...chosen.result.reasonCodes, ...extraReasons, ...unverified]),
    conformantOperators: union((r) => r.conformantOperators, MAX_LISTED_OPERATORS),
    violationOperators: union((r) => r.violationOperators, MAX_LISTED_OPERATORS),
    evidenceIds: union((r) => r.evidenceIds, Number.MAX_SAFE_INTEGER),
  });
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

/**
 * RN-CONFORM-07A — SR-6. For an ACTIVE credential the existing rules run first on all authenticated evidence (the
 * protective view): SR-1, SR-4 and SR-2 keep absolute precedence. If none of them suspends, the same rules run again
 * without the positively ineligible conformant observations (the positive view). If any critical requirement is weaker
 * there — its success or grace rested on evidence from a revoked or ended authorization — current authorized
 * conformance can no longer be established: SUSPEND under SR-6, reason AUTHORIZATION_WITHDRAWN (any revoked) or
 * AUTHORIZATION_EXPIRED. The recorded requirement results stay the protective view's: no failure is invented.
 */
export function evaluateConformance(input: EngineInput): EngineOutput {
  const protective = evaluateConformanceRules(input);
  const withheld = input.positivelyIneligible;
  if (input.credentialState !== 'ACTIVE' || withheld === undefined || withheld.eventIds.length === 0 || protective.proposal.kind === 'SUSPEND') return protective;
  const ineligible = new Set(withheld.eventIds);
  const positive = evaluateConformanceRules({ ...input, observations: input.observations.filter((o) => !ineligible.has(o.eventId)) });
  const strength = (category: string) => (category === 'VERIFIED_SUCCESS' ? 2 : category === 'STALE_EVIDENCE' ? 1 : 0);
  const positiveById = new Map(positive.requirementResults.map((r) => [r.requirementId, r]));
  const weaker = protective.requirementResults.some((r) => r.severity === 'critical' && strength(positiveById.get(r.requirementId)?.category ?? '') < strength(r.category));
  if (!weaker) return protective;
  return Object.freeze({
    ...protective,
    proposal: Object.freeze({ kind: 'SUSPEND' as const, ruleId: 'SR-6' as const, reasonCode: withheld.revoked ? ('AUTHORIZATION_WITHDRAWN' as const) : ('AUTHORIZATION_EXPIRED' as const) }),
  });
}

function evaluateConformanceRules(input: EngineInput): EngineOutput {
  const { profile } = input;
  const nowMs = toMs(input.evaluatedAt);
  if (!Number.isFinite(nowMs)) throw new TypeError('evaluatedAt must be a timestamp.');
  const revalidationSinceMs = input.revalidationSince === null ? null : toMs(input.revalidationSince);
  const truncated = input.evidenceTruncated === true;
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
    // One evaluation per required operation: evidence is bound to the exact control and operation it exercised.
    const perOperation = requiredOperations(requirement.challengeType, input.coveredOperations).map((operation) => {
      const observations = relevant
        .filter((o) => o.controlId === requirement.requirementId && o.operation === operation)
        .map((o): Obs => ({ id: o.eventId, op: o.operatorId, t: toMs(o.observedAt), cls: o.outcomeClass }));
      return { operation, result: evaluateCorroborated(requirement, profile, observations, nowMs, revalidationSinceMs, truncated) };
    });
    // No required operation at all (an integration with no covered operation cannot exist; defensive) is no evidence.
    const result = perOperation.length === 0 ? deterministic(requirement, 'INSUFFICIENT_EVIDENCE', 'NO_REQUIRED_OPERATION') : combineOperations(perOperation);
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

  // P1-A: on an ACTIVE credential a durably recorded confirmed critical violation stands until the two-person path lifts it.
  if (input.credentialState === 'ACTIVE') {
    for (const requirement of profile.requirements) {
      if (requirement.evaluation !== 'validator-corroborated' || requirement.severity !== 'critical') continue;
      const operations = requiredOperations(requirement.challengeType, input.coveredOperations);
      const recorded = (input.recordedConfirmedViolations ?? []).filter((v) => v.controlId === requirement.requirementId && operations.includes(v.operation));
      const current = byId.get(requirement.requirementId);
      if (recorded.length === 0 || current === undefined || current.category === 'VERIFIED_FAILURE') continue;
      const latestRecord = [...recorded].sort((a, b) => cmp(a.observedAt, b.observedAt) || cmp(a.eventId, b.eventId)).at(-1)!;
      const standing: RequirementResult = Object.freeze({
        ...current,
        category: 'VERIFIED_FAILURE',
        reasonCodes: Object.freeze(['RECORDED_CONFIRMED_VIOLATION', ...[...new Set(recorded.map((v) => `RECORDED_CONFIRMED_VIOLATION:${v.operation}`))].sort(), ...current.reasonCodes]),
        evidenceIds: Object.freeze([...new Set([...current.evidenceIds, latestRecord.eventId])].sort()),
        confirmedFailureAt: latestRecord.observedAt,
        investigationDeadline: null,
      });
      byId.set(requirement.requirementId, standing);
      const index = corroborated.findIndex((r) => r.requirementId === requirement.requirementId);
      if (index >= 0) corroborated[index] = standing;
    }
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
