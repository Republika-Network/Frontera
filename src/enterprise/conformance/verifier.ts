import { canonicalizeConformance, conformanceDigest } from './canonical.js';
import { HUMAN_DECISION_FORMAT, SYNTHETIC_DESIGNATION, toMs, type CredentialState, type TransitionCode, type TransitionRecord } from './contracts.js';
import { evaluateConformance } from './engine.js';
import { verifyTwoPersonAuthority, type SyntheticHumanDirectory } from './human-authority.js';
import { HUMAN_REINSTATEMENT_REASONS, loadEngineInput } from './lifecycle.js';
import type { EvaluationRecord } from './contracts.js';
import type { ConformanceProfileRegistry } from './profile.js';
import type { ConformanceStore } from './sqlite-conformance-store.js';
import { verifyConformanceSignature } from './signing.js';

/**
 * RN-CONFORM-02 / WP-11 — the minimal in-process verifier.
 *
 * Answers, from committed storage only and failing closed on every doubt:
 * does the credential exist (in this organization), does it bind the exact
 * integration and profile expected, is its full transition history valid
 * (digests, signatures, chain, state versions, lifecycle edges, human
 * approvals), is its committed state ACTIVE, is its critical evidence fresh
 * right now, and is the operation in scope.
 *
 * Not implemented here (RN-CONFORM-03): signed status assertions, the online
 * nonce protocol, stapled offline assertions, external key distribution, an
 * HTTP endpoint, anchoring. `createHighWaterMark` is the local seed of the
 * verifier-side rollback detection those will need.
 */

const ALLOWED: ReadonlyArray<readonly [CredentialState, CredentialState, TransitionCode]> = Object.freeze([
  ['CANDIDATE', 'ACTIVE', 'T2'],
  ['CANDIDATE', 'EXPIRED', 'T3'],
  ['ACTIVE', 'SUSPENDED', 'T4'],
  ['SUSPENDED', 'ACTIVE', 'T5'],
  ['SUSPENDED', 'REVOKED', 'T6'],
  ['ACTIVE', 'REVOKED', 'T7'],
  ['ACTIVE', 'EXPIRED', 'T8'],
  ['SUSPENDED', 'EXPIRED', 'T8'],
]);

export type HistoryFailure =
  | 'NO_HISTORY'
  | 'RECORD_NOT_CANONICAL'
  | 'TRANSITION_DIGEST_MISMATCH'
  | 'COLUMN_RECORD_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'STATE_VERSION_GAP'
  | 'PREVIOUS_DIGEST_MISMATCH'
  | 'FROM_STATE_MISMATCH'
  | 'GENESIS_INVALID'
  | 'TRANSITION_NOT_ALLOWED'
  | 'SUBJECT_MISMATCH'
  | 'EVALUATION_MISSING'
  | 'EVALUATION_DIGEST_MISMATCH'
  | 'HUMAN_APPROVAL_MISSING'
  | 'HUMAN_APPROVAL_INVALID'
  | 'HEAD_MISMATCH';

export type HistoryVerification =
  | { readonly valid: true; readonly stateVersion: number; readonly state: CredentialState; readonly headTransitionDigest: string; readonly transitions: readonly TransitionRecord[] }
  | { readonly valid: false; readonly failure: HistoryFailure; readonly atStateVersion: number | null };

function humanRequired(record: TransitionRecord, previous: TransitionRecord | undefined, evaluations: readonly EvaluationRecord[]): 'credential.issue' | 'credential.reinstate' | 'credential.revoke' | null {
  if (record.transitionCode === 'T2') return 'credential.issue';
  if (record.transitionCode === 'T5' && previous !== undefined) {
    const since = toMs(previous.effectiveAt);
    const until = toMs(record.effectiveAt);
    const failedWhileSuspended = evaluations.some((e) => e.criticalFailureConfirmed && toMs(e.evaluatedAt) >= since && toMs(e.evaluatedAt) <= until);
    if ((HUMAN_REINSTATEMENT_REASONS as readonly string[]).includes(previous.reasonCode) || failedWhileSuspended) return 'credential.reinstate';
  }
  if (record.to === 'REVOKED' && record.reasonCode !== 'SUSPENSION_TIMEOUT') return 'credential.revoke';
  return null;
}

/** Recomputes everything; trusts no stored digest, column or head. Never throws. */
export function verifyCredentialHistory(
  store: ConformanceStore,
  organizationId: string,
  credentialId: string,
  options: { readonly registryPublicKeyPem: string; readonly humans?: SyntheticHumanDirectory },
): HistoryVerification {
  const fail = (failure: HistoryFailure, atStateVersion: number | null = null): HistoryVerification => ({ valid: false, failure, atStateVersion });
  try {
    const credential = store.getCredential(organizationId, credentialId);
    const rows = store.listTransitions(organizationId, credentialId);
    if (credential === undefined || rows.length === 0) return fail('NO_HISTORY');
    const evaluations = new Map(store.listEvaluations(organizationId, credentialId).map((e) => [e.record.evaluationId, e]));
    const records: TransitionRecord[] = [];
    for (const [index, row] of rows.entries()) {
      const sv = index + 1;
      let record: TransitionRecord;
      let signature: unknown;
      try {
        record = JSON.parse(row.recordJson) as TransitionRecord;
        signature = JSON.parse(row.signatureJson);
        if (canonicalizeConformance(record) !== row.recordJson) return fail('RECORD_NOT_CANONICAL', sv);
      } catch {
        return fail('RECORD_NOT_CANONICAL', sv);
      }
      if (conformanceDigest(record) !== row.transitionDigest) return fail('TRANSITION_DIGEST_MISMATCH', sv);
      if (
        row.stateVersion !== record.stateVersion || row.columns.transitionId !== record.transitionId || row.columns.from !== record.from || row.columns.to !== record.to ||
        row.columns.previousTransitionDigest !== record.previousTransitionDigest || row.columns.reasonCode !== record.reasonCode || row.credentialId !== record.credentialId
      ) {
        return fail('COLUMN_RECORD_MISMATCH', sv);
      }
      if (!verifyConformanceSignature('transition', { record, transitionDigest: row.transitionDigest }, signature, options.registryPublicKeyPem).ok) return fail('SIGNATURE_INVALID', sv);
      if (record.stateVersion !== sv) return fail('STATE_VERSION_GAP', sv);
      if (
        record.credentialId !== credential.credentialId || record.organizationId !== credential.organizationId || record.integrationDigest !== credential.integrationDigest ||
        record.profileId !== credential.profileId || record.profileVersion !== credential.profileVersion || record.synthetic !== true
      ) {
        return fail('SUBJECT_MISMATCH', sv);
      }
      const previous = records[index - 1];
      if (previous === undefined) {
        if (record.from !== null || record.to !== 'CANDIDATE' || record.transitionCode !== 'T1' || record.previousTransitionDigest !== null) return fail('GENESIS_INVALID', sv);
      } else {
        if (record.previousTransitionDigest !== rows[index - 1]!.transitionDigest) return fail('PREVIOUS_DIGEST_MISMATCH', sv);
        if (record.from !== previous.to) return fail('FROM_STATE_MISMATCH', sv);
        if (!ALLOWED.some(([from, to, code]) => from === record.from && to === record.to && code === record.transitionCode)) return fail('TRANSITION_NOT_ALLOWED', sv);
        if (toMs(record.effectiveAt) < toMs(previous.effectiveAt)) return fail('TRANSITION_NOT_ALLOWED', sv);
      }
      if (record.evaluationId !== null) {
        const evaluation = evaluations.get(record.evaluationId);
        if (evaluation === undefined) return fail('EVALUATION_MISSING', sv);
        if (conformanceDigest(evaluation.record) !== evaluation.evaluationDigest || evaluation.evaluationDigest !== record.evaluationDigest) return fail('EVALUATION_DIGEST_MISMATCH', sv);
        const kind = evaluation.record.proposal.kind;
        if ((record.to === 'ACTIVE' && kind !== 'ELIGIBLE_FOR_ACTIVE') || (record.to === 'SUSPENDED' && kind !== 'SUSPEND')) return fail('EVALUATION_DIGEST_MISMATCH', sv);
      } else if (record.to === 'ACTIVE' || record.to === 'SUSPENDED') {
        return fail('EVALUATION_MISSING', sv);
      }
      const action = humanRequired(record, previous, [...evaluations.values()].map((e) => e.record));
      if (action !== null) {
        const refs = record.humanDecisions;
        if (
          refs.length !== 2 || new Set(refs.map((r) => r.principalId)).size !== 2 || new Set(refs.map((r) => r.role)).size !== 2 ||
          record.actionBindingDigest === null || refs.some((r) => r.format !== HUMAN_DECISION_FORMAT || r.actionBindingDigest !== record.actionBindingDigest)
        ) {
          return fail('HUMAN_APPROVAL_MISSING', sv);
        }
        if (options.humans !== undefined) {
          // Re-verify the stored, signed decisions themselves, as of the transition's effective time.
          const stored = store.listConsumedDecisions(record.transitionId);
          const signed = stored.map((d) => JSON.parse(d.decisionJson) as unknown);
          const check = verifyTwoPersonAuthority(options.humans, signed, { action, organizationId: record.organizationId, subjectRef: record.credentialId, actionBindingDigest: record.actionBindingDigest, now: record.effectiveAt }, () => false);
          if (!check.authorized) return fail('HUMAN_APPROVAL_INVALID', sv);
          const expected = [...refs].map((r) => r.decisionDigest).sort();
          if (JSON.stringify(check.refs.map((r) => r.decisionDigest).sort()) !== JSON.stringify(expected)) return fail('HUMAN_APPROVAL_INVALID', sv);
        }
      } else if (record.humanDecisions.length !== 0 && record.transitionCode !== 'T5') {
        return fail('HUMAN_APPROVAL_INVALID', sv);
      }
      records.push(Object.freeze(record));
    }
    const last = records[records.length - 1]!;
    const head = store.getHead(organizationId, credentialId);
    if (head === undefined || head.stateVersion !== last.stateVersion || head.state !== last.to || head.headTransitionDigest !== rows[rows.length - 1]!.transitionDigest) return fail('HEAD_MISMATCH', last.stateVersion);
    return { valid: true, stateVersion: last.stateVersion, state: last.to, headTransitionDigest: head.headTransitionDigest, transitions: Object.freeze(records) };
  } catch {
    return fail('NO_HISTORY');
  }
}

export interface ConformanceExpectation {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly platformId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly operation: string;
}

export type ConformanceVerdictReason =
  | 'CONFORMANT'
  | 'CREDENTIAL_NOT_FOUND'
  | 'HISTORY_INVALID'
  | 'SUBJECT_MISMATCH'
  | 'PROFILE_MISMATCH'
  | 'NOT_ACTIVE'
  | 'CREDENTIAL_EXPIRED'
  | 'OPERATION_EXCLUDED'
  | 'OPERATION_NOT_IN_SCOPE'
  | 'EVIDENCE_NOT_FRESH'
  | 'PROTECTIVE_ACTION_PENDING'
  | 'UNDER_INVESTIGATION'
  | 'EVIDENCE_TAMPERED'
  | 'ROLLBACK_DETECTED'
  | 'VERIFIER_ERROR';

export interface ConformanceVerdict {
  /** True only when every check passed. Every other outcome is a refusal. */
  readonly conformant: boolean;
  readonly reason: ConformanceVerdictReason;
  readonly detail: string | null;
  readonly state: CredentialState | null;
  readonly stateVersion: number | null;
  readonly headTransitionDigest: string | null;
  readonly evidenceFreshUntil: string | null;
  readonly designation: typeof SYNTHETIC_DESIGNATION;
}

/** Per-verifier memory of the highest committed head seen for each credential. In-memory and local: the seed of RN-CONFORM-03's verifier-side high-water mark. */
export interface HighWaterMark {
  observe(credentialId: string, stateVersion: number, headDigest: string): 'ok' | 'ROLLBACK' | 'CONFLICT';
}

export function createHighWaterMark(): HighWaterMark {
  const seen = new Map<string, { stateVersion: number; headDigest: string }>();
  return Object.freeze({
    observe(credentialId: string, stateVersion: number, headDigest: string) {
      const prior = seen.get(credentialId);
      if (prior !== undefined) {
        if (stateVersion < prior.stateVersion) return 'ROLLBACK';
        if (stateVersion === prior.stateVersion && headDigest !== prior.headDigest) return 'CONFLICT';
      }
      if (prior === undefined || stateVersion > prior.stateVersion) seen.set(credentialId, { stateVersion, headDigest });
      return 'ok';
    },
  });
}

/** The authoritative in-process question: is this exact subject currently conformant for this operation? Fails closed; never throws. */
export function verifyCurrentConformance(
  deps: {
    readonly store: ConformanceStore;
    readonly profiles: ConformanceProfileRegistry;
    readonly registryPublicKeyPem: string;
    /** Every stored observation is re-authenticated against the coordinator's signed challenges. */
    readonly coordinatorPublicKeyPem: string;
    readonly humans?: SyntheticHumanDirectory;
    readonly highWaterMark?: HighWaterMark;
  },
  expect: ConformanceExpectation,
  now: string,
): ConformanceVerdict {
  const verdict = (reason: ConformanceVerdictReason, extra: Partial<Omit<ConformanceVerdict, 'reason' | 'designation' | 'conformant'>> = {}): ConformanceVerdict =>
    Object.freeze({
      conformant: reason === 'CONFORMANT',
      reason,
      detail: extra.detail ?? null,
      state: extra.state ?? null,
      stateVersion: extra.stateVersion ?? null,
      headTransitionDigest: extra.headTransitionDigest ?? null,
      evidenceFreshUntil: extra.evidenceFreshUntil ?? null,
      designation: SYNTHETIC_DESIGNATION,
    });
  try {
    const credential = deps.store.getCredential(expect.organizationId, expect.credentialId);
    if (credential === undefined) return verdict('CREDENTIAL_NOT_FOUND');
    const history = verifyCredentialHistory(deps.store, expect.organizationId, expect.credentialId, {
      registryPublicKeyPem: deps.registryPublicKeyPem,
      ...(deps.humans === undefined ? {} : { humans: deps.humans }),
    });
    if (!history.valid) return verdict('HISTORY_INVALID', { detail: `${history.failure}@${history.atStateVersion ?? '-'}` });
    const at = { state: history.state, stateVersion: history.stateVersion, headTransitionDigest: history.headTransitionDigest };
    if (deps.highWaterMark !== undefined) {
      const seen = deps.highWaterMark.observe(expect.credentialId, history.stateVersion, history.headTransitionDigest);
      if (seen !== 'ok') return verdict('ROLLBACK_DETECTED', { ...at, detail: seen });
    }
    if (
      credential.platformId !== expect.platformId || credential.integrationId !== expect.integrationId || credential.integrationVersion !== expect.integrationVersion ||
      credential.integrationDigest !== expect.integrationDigest
    ) {
      return verdict('SUBJECT_MISMATCH', at);
    }
    if (credential.profileId !== expect.profileId || credential.profileVersion !== expect.profileVersion || credential.profileDigest !== expect.profileDigest) return verdict('PROFILE_MISMATCH', at);
    if (history.state !== 'ACTIVE') return verdict('NOT_ACTIVE', at);
    if (toMs(now) >= toMs(credential.validUntil)) return verdict('CREDENTIAL_EXPIRED', at);
    if (credential.declaredExclusions.includes(expect.operation)) return verdict('OPERATION_EXCLUDED', at);
    if (!credential.coveredOperations.includes(expect.operation)) return verdict('OPERATION_NOT_IN_SCOPE', at);
    const loaded = loadEngineInput(deps.store, deps.profiles, expect.organizationId, expect.credentialId, now, deps.coordinatorPublicKeyPem);
    if (loaded === undefined) return verdict('VERIFIER_ERROR', at);
    // A stored observation that does not re-authenticate means the evidence store was written outside the acceptance boundary.
    if (loaded.unauthenticated.length > 0) return verdict('EVIDENCE_TAMPERED', { ...at, detail: loaded.unauthenticated.join(',') });
    const engine = evaluateConformance(loaded.input);
    const critical = engine.requirementResults.filter((r) => r.severity === 'critical');
    const freshUntil = critical.map((r) => r.freshUntil).filter((v): v is string => v !== null).sort()[0] ?? null;
    if (engine.proposal.kind === 'SUSPEND') return verdict('PROTECTIVE_ACTION_PENDING', { ...at, detail: engine.proposal.reasonCode, evidenceFreshUntil: freshUntil });
    // SR-3: the committed state stays ACTIVE during an investigation, but this fail-closed verifier does not assert current conformance while it is open.
    if (engine.proposal.kind === 'NONE' && engine.proposal.reasonCode === 'UNDER_INVESTIGATION') return verdict('UNDER_INVESTIGATION', { ...at, evidenceFreshUntil: freshUntil });
    if (!critical.every((r) => r.category === 'VERIFIED_SUCCESS')) {
      return verdict('EVIDENCE_NOT_FRESH', { ...at, detail: critical.filter((r) => r.category !== 'VERIFIED_SUCCESS').map((r) => `${r.requirementId}:${r.category}`).join(','), evidenceFreshUntil: freshUntil });
    }
    return verdict('CONFORMANT', { ...at, evidenceFreshUntil: freshUntil });
  } catch {
    return verdict('VERIFIER_ERROR');
  }
}
