import { NANOS_PER_SECOND, canonicalInstant } from './canonical-time.js';
import { issuedDocumentUseDecisionEligibility } from './document-policy.js';
import { DOCUMENT_USE_ACTIONS } from './document-policy-types.js';
import type { DocumentUseAction, DocumentUsePolicyDecision, DocumentUsePolicyDecisionValue } from './document-policy-types.js';
import { issuedEligibilityManifestDigest } from './document-use.js';
import { DOCUMENT_USE_FRESHNESS_CEILINGS, DOCUMENT_USE_FRESHNESS_GATE } from './document-freshness-types.js';
import type {
  DocumentUseFreshnessHistoryEvidence,
  DocumentUseFreshnessResult,
  DocumentUseFreshnessStatusEvidence,
  DocumentUseFreshnessVerdict,
  StatusHighWaterMark,
  StatusHighWaterMarkEntry,
  StatusHighWaterMarkStore,
  StatusHistoryBootstrapReason,
  StatusHistoryBootstrapResult,
  StatusHistoryKey,
} from './document-freshness-types.js';
import { verifySovereignStatus } from './sovereign-status.js';
import type { SovereignStatusRejectionReason, SovereignStatusVerified } from './sovereign-status-types.js';
import { bindMethods, deepFreeze, isDigest, isIdentifier, readPlain } from './plain-data.js';
import type { ReceiverVerificationKeyResolver } from './types.js';

/**
 * FV-P4C-1 — receiver-side freshness and anti-replay gate for document use.
 *
 * Layer four, and only that one:
 *   artifact verification (RSDK-01) → eligibility (FV-P2) → policy (FV-P3) →
 *   **freshness against this receiver's trusted history** → authorization → execution.
 *
 * Input is an FV-P3 decision issued in this process (its eligibility is found
 * through FV-P3's private registry, never read from the object) and a signed
 * status, which the gate verifies itself with FV-P4B against the eligibility's
 * own asset, registrant and manifest. The status is then checked against the
 * receiver's high-water mark for `(asset, registrant)`, which advances only
 * through one atomic compare-and-set.
 *
 * What it can and cannot know: the high-water mark records only what this
 * receiver accepted. A replay of a status older than one it saw is detected;
 * a revocation that never reached it is not. With no history it refuses.
 *
 * Never escalates: a decision can only stay what it was (when `FRESH`) or
 * become `DENIED`. Never authorizes or executes. Reads no clock, environment,
 * network or storage other than the injected store and resolver. Never throws.
 */

const CONTEXT_KEYS = ['verificationKeyResolver', 'evaluationTime', 'operationId', 'maxStatusAgeSeconds', 'historyStore'] as const;
const BOOTSTRAP_KEYS = [
  'verificationKeyResolver',
  'historyStore',
  'expectedSovereignAssetId',
  'expectedRegistrant',
  'expectedManifestDigest',
  'evaluationTime',
  'reanchor',
] as const;
const MARK_KEYS = [
  'sovereignAssetId',
  'issuer',
  'sequence',
  'statusDigest',
  'issuedAt',
  'currentTermsDigest',
  'timeFloor',
  'withdrawn',
  'retiredTermsDigests',
  'continuity',
  'conflict',
  'anchoredAt',
] as const;
const ACTIONS: ReadonlySet<string> = new Set(DOCUMENT_USE_ACTIONS);
const MAX_OPERATION_ID_LENGTH = 256;
/** Compare-and-set attempts before a contended history is reported unavailable. */
const MAX_ATTEMPTS = 4;

interface Store {
  read(key: StatusHistoryKey): Promise<unknown>;
  compareAndSet(key: StatusHistoryKey, expectedRevision: number | null, next: StatusHighWaterMark): Promise<unknown>;
}

interface GateState {
  operationId: string | null;
  action: string | null;
  sovereignAssetId: string | null;
  policy: { claimId: string; claimDigest: string } | null;
  evaluationTime: string | null;
  before: DocumentUsePolicyDecisionValue | null;
  statusRejection: SovereignStatusRejectionReason | null;
  status: DocumentUseFreshnessStatusEvidence | null;
  history: DocumentUseFreshnessHistoryEvidence;
  maxStatusAgeSeconds: number | null;
}

export async function checkDocumentUseFreshness(policyDecision: unknown, signedStatusText: unknown, trustedContext: unknown): Promise<DocumentUseFreshnessResult> {
  const state: GateState = {
    operationId: null,
    action: null,
    sovereignAssetId: null,
    policy: null,
    evaluationTime: null,
    before: null,
    statusRejection: null,
    status: null,
    history: { initialization: 'UNKNOWN', before: null, after: null, transition: 'not_attempted' },
    maxStatusAgeSeconds: null,
  };
  try {
    return await check(policyDecision, signedStatusText, trustedContext, state);
  } catch {
    return result('GATE_ERROR', state);
  }
}

async function check(rawDecision: unknown, signedStatusText: unknown, rawContext: unknown, state: GateState): Promise<DocumentUseFreshnessResult> {
  // 1. Provenance. Only a decision FV-P3 issued in this process is trusted, and
  //    what it was evaluated over comes from FV-P3's registry, not from the object.
  const eligibility = issuedDocumentUseDecisionEligibility(rawDecision);
  if (eligibility === undefined) return result('POLICY_PROVENANCE_INVALID', state);
  const decision = rawDecision as DocumentUsePolicyDecision;
  state.before = decision.decision;
  state.action = decision.action;
  state.sovereignAssetId = eligibility.sovereignAssetId;
  const policy = { claimId: eligibility.terms.claimId, claimDigest: eligibility.terms.claimDigest };
  state.policy = policy;
  state.evaluationTime = decision.evaluationTime;
  const manifestDigest = issuedEligibilityManifestDigest(eligibility);
  if (manifestDigest === undefined) return result('POLICY_PROVENANCE_INVALID', state);

  // 2. The host's context, read once. One trusted instant serves policy and freshness.
  const context = readContext(rawContext);
  if (context === undefined) return result('CONTEXT_INVALID', state);
  state.operationId = context.operationId;
  const now = canonicalInstant(context.evaluationTime);
  if (now === undefined || decision.evaluationTime === null || context.evaluationTime !== decision.evaluationTime) return result('CONTEXT_INVALID', state);

  if (decision.action === null || !ACTIONS.has(decision.action)) return result('UNSUPPORTED_ACTION', state);
  const maxAgeSeconds = context.maxStatusAgeSeconds[decision.action as DocumentUseAction];
  state.maxStatusAgeSeconds = maxAgeSeconds;

  // 3. The status, verified here against what FV-P2 verified, never taken on trust.
  if (signedStatusText === null || signedStatusText === undefined) return result('UNKNOWN', state);
  const verified = await verifySovereignStatus(signedStatusText, {
    verificationKeyResolver: context.resolver,
    expectedSovereignAssetId: eligibility.sovereignAssetId,
    expectedRegistrant: eligibility.registrant,
    expectedManifestDigest: manifestDigest,
    evaluationTime: context.evaluationTime,
  });
  if (verified.outcome !== 'authentic_authorized') {
    state.statusRejection = verified.reason;
    return result(statusVerdict(verified.reason), state);
  }
  state.status = statusEvidence(verified);
  const issuedAt = canonicalInstant(verified.issuedAt)!;

  // 4. History. The mark advances only by compare-and-set against the revision
  //    it was computed from; a lost race recomputes from the new state.
  const key: StatusHistoryKey = { sovereignAssetId: verified.sovereignAssetId, issuer: verified.issuer };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const read = await readEntry(context.store, key);
    if (read === 'unavailable') return result('HISTORY_STORE_UNAVAILABLE', state);
    if (read === 'invalid') return result('HISTORY_STORE_INVALID', state);
    if (read === undefined) {
      state.history = { initialization: 'UNINITIALIZED', before: null, after: null, transition: 'not_attempted' };
      return result('HISTORY_UNINITIALIZED', state);
    }
    const { revision, mark } = read;
    const before = { sequence: mark.sequence, statusDigest: mark.statusDigest };
    state.history = { initialization: 'ESTABLISHED', before, after: before, transition: 'not_attempted' };

    // A trusted clock behind a status this receiver already accepted has gone back.
    if (now < canonicalInstant(mark.timeFloor)!) return result('CLOCK_ROLLBACK_DETECTED', state);
    if (mark.conflict) return result('CONFLICT_DETECTED', state);

    const step = transition(mark, verified, issuedAt);
    if (step.kind === 'rollback') {
      state.history = { ...state.history, transition: 'refused' };
      return result('ROLLBACK_DETECTED', state);
    }
    if (step.kind !== 'unchanged') {
      let written: unknown;
      try {
        written = await context.store.compareAndSet(key, revision, step.next);
      } catch {
        return result('HISTORY_STORE_UNAVAILABLE', state);
      }
      if (written !== true) continue;
    }
    const head = step.kind === 'unchanged' ? mark : step.next;
    state.history = {
      initialization: 'ESTABLISHED',
      before,
      after: { sequence: head.sequence, statusDigest: head.statusDigest },
      transition: step.kind === 'conflict' ? 'conflict_recorded' : step.kind === 'advance' ? (step.gap ? 'advanced_with_gap' : 'advanced') : 'unchanged',
    };
    if (step.kind === 'conflict') return result('CONFLICT_DETECTED', state);
    if (head.continuity !== 'verified') return result('CONTINUITY_UNPROVEN', state);

    // 5. The presented status is now this receiver's latest known one. What it says:
    if (verified.assetStatus === 'withdrawn') return result('WITHDRAWN', state);
    if (verified.currentTerms === null) return result('REVOKED', state);
    if (verified.currentTerms.claimId !== policy.claimId || verified.currentTerms.claimDigest !== policy.claimDigest) {
      return result('SUPERSEDED', state);
    }
    // 6. Operational age, exactly: an age equal to the limit is still fresh.
    if (now - issuedAt > BigInt(maxAgeSeconds) * NANOS_PER_SECOND) return result('STALE', state);
    return result('FRESH', state);
  }
  return result('HISTORY_STORE_UNAVAILABLE', state);
}

type Step =
  | { readonly kind: 'rollback' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict'; readonly next: StatusHighWaterMark }
  | { readonly kind: 'advance'; readonly next: StatusHighWaterMark; readonly gap: boolean };

/**
 * The high-water-mark transition for a verified status, as a pure function of
 * the stored mark. Lower sequence: rollback, nothing written. Same sequence:
 * the same status is idempotent, a different one is equivocation. Higher
 * sequence: advances, unless it contradicts what this history already holds
 * (reopens a withdrawal, makes retired terms current, goes back in time, or
 * does not link to the head it directly follows), which latches a conflict.
 * A gap advances but marks continuity unproven for good: an unseen status in
 * between might have retired terms or withdrawn the asset.
 */
function transition(mark: StatusHighWaterMark, status: SovereignStatusVerified, issuedAt: bigint): Step {
  if (status.sequence < mark.sequence) return { kind: 'rollback' };
  const latch = (): Step => ({ kind: 'conflict', next: { ...mark, conflict: true } });
  if (status.sequence === mark.sequence) return status.statusDigest === mark.statusDigest ? { kind: 'unchanged' } : latch();

  const termsDigest = status.currentTerms === null ? null : status.currentTerms.claimDigest;
  if (mark.withdrawn && status.assetStatus !== 'withdrawn') return latch();
  if (termsDigest !== null && mark.retiredTermsDigests.includes(termsDigest)) return latch();
  if (issuedAt < canonicalInstant(mark.issuedAt)!) return latch();
  const gap = status.sequence > mark.sequence + 1;
  if (!gap && status.previousStatusDigest !== mark.statusDigest) return latch();

  return { kind: 'advance', gap, next: nextMark(mark, status, termsDigest, gap) };
}

function nextMark(mark: StatusHighWaterMark, status: SovereignStatusVerified, termsDigest: string | null, gap: boolean): StatusHighWaterMark {
  const retired = new Set(mark.retiredTermsDigests);
  if (mark.currentTermsDigest !== null && mark.currentTermsDigest !== termsDigest) retired.add(mark.currentTermsDigest);
  return {
    sovereignAssetId: mark.sovereignAssetId,
    issuer: mark.issuer,
    sequence: status.sequence,
    statusDigest: status.statusDigest,
    issuedAt: status.issuedAt,
    currentTermsDigest: termsDigest,
    timeFloor: later(mark.timeFloor, status.issuedAt),
    withdrawn: mark.withdrawn || status.assetStatus === 'withdrawn',
    retiredTermsDigests: [...retired].sort(),
    continuity: gap ? 'unproven' : mark.continuity,
    // Never cleared by advancing. The gate refuses a latched history before it gets here.
    conflict: mark.conflict,
    anchoredAt: mark.anchoredAt,
  };
}

/**
 * Trusted, out-of-band anchoring of one receiver history. Never reached from
 * a request, and never run implicitly by the gate. The host supplies a status
 * it obtained through a channel it trusts to be current; the status is still
 * fully verified. Without `reanchor` an existing history is never touched.
 * With it, a history is re-anchored (for example to restore continuity after a
 * sequence gap) but never moved backwards: the sequence cannot decrease, a
 * withdrawal is never reopened and retired terms never become current.
 *
 * A history with a latched conflict is never re-anchored: the registrant
 * signed incompatible statuses, and the host's trust in one of them is not
 * evidence enough to clear that. Conflict recovery is not implemented here;
 * a latched history stays refused. The check is repeated on every attempt
 * against the revision about to be replaced, so a conflict latched
 * concurrently makes the re-anchor's compare-and-set fail and the retry refuse.
 */
export async function establishStatusHistory(signedStatusText: unknown, bootstrapContext: unknown): Promise<StatusHistoryBootstrapResult> {
  try {
    return await bootstrap(signedStatusText, bootstrapContext);
  } catch {
    return bootstrapResult('BOOTSTRAP_ERROR');
  }
}

async function bootstrap(signedStatusText: unknown, rawContext: unknown): Promise<StatusHistoryBootstrapResult> {
  const fields = readPlain(rawContext, BOOTSTRAP_KEYS, BOOTSTRAP_KEYS.filter((key) => key !== 'reanchor'));
  if (fields === undefined) return bootstrapResult('CONTEXT_INVALID');
  const reanchor = fields.get('reanchor');
  if (fields.has('reanchor') && reanchor !== true) return bootstrapResult('CONTEXT_INVALID');
  const store = bindStore(fields.get('historyStore'));
  const resolver = bindResolver(fields.get('verificationKeyResolver'));
  const evaluationTime = fields.get('evaluationTime');
  const now = canonicalInstant(evaluationTime);
  if (store === undefined || resolver === undefined || now === undefined) return bootstrapResult('CONTEXT_INVALID');

  const verified = await verifySovereignStatus(signedStatusText, {
    verificationKeyResolver: resolver,
    expectedSovereignAssetId: fields.get('expectedSovereignAssetId'),
    expectedRegistrant: fields.get('expectedRegistrant'),
    expectedManifestDigest: fields.get('expectedManifestDigest'),
    evaluationTime,
  });
  if (verified.outcome !== 'authentic_authorized') {
    return verified.reason === 'CONTEXT_INVALID' || verified.reason === 'EVALUATION_TIME_INVALID'
      ? bootstrapResult('CONTEXT_INVALID')
      : bootstrapResult('STATUS_REJECTED', verified.reason);
  }

  const key: StatusHistoryKey = { sovereignAssetId: verified.sovereignAssetId, issuer: verified.issuer };
  const termsDigest = verified.currentTerms === null ? null : verified.currentTerms.claimDigest;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const read = await readEntry(store, key);
    if (read === 'unavailable') return bootstrapResult('HISTORY_STORE_UNAVAILABLE');
    if (read === 'invalid') return bootstrapResult('HISTORY_STORE_INVALID');
    let next: StatusHighWaterMark;
    if (read === undefined) {
      next = {
        sovereignAssetId: verified.sovereignAssetId,
        issuer: verified.issuer,
        sequence: verified.sequence,
        statusDigest: verified.statusDigest,
        issuedAt: verified.issuedAt,
        currentTermsDigest: termsDigest,
        timeFloor: verified.issuedAt,
        withdrawn: verified.assetStatus === 'withdrawn',
        retiredTermsDigests: [],
        continuity: 'verified',
        conflict: false,
        anchoredAt: evaluationTime as string,
      };
    } else {
      const { mark } = read;
      if (mark.conflict) return bootstrapResult('CONFLICT_DETECTED');
      if (reanchor !== true) return bootstrapResult('ALREADY_ESTABLISHED');
      if (verified.sequence < mark.sequence) return bootstrapResult('REANCHOR_ROLLBACK');
      if (mark.withdrawn && verified.assetStatus !== 'withdrawn') return bootstrapResult('REANCHOR_REACTIVATES_WITHDRAWN');
      if (termsDigest !== null && mark.retiredTermsDigests.includes(termsDigest)) return bootstrapResult('REANCHOR_REINTRODUCES_RETIRED_TERMS');
      if (now < canonicalInstant(mark.timeFloor)!) return bootstrapResult('CLOCK_ROLLBACK_DETECTED');
      next = {
        ...nextMark(mark, verified, termsDigest, false),
        continuity: 'verified',
        anchoredAt: evaluationTime as string,
      };
    }
    let written: unknown;
    try {
      written = await store.compareAndSet(key, read === undefined ? null : read.revision, next);
    } catch {
      return bootstrapResult('HISTORY_STORE_UNAVAILABLE');
    }
    if (written === true) return bootstrapResult(read === undefined ? 'ESTABLISHED' : 'REESTABLISHED', null, next);
  }
  return bootstrapResult('HISTORY_STORE_UNAVAILABLE');
}

interface Context {
  readonly resolver: ReceiverVerificationKeyResolver;
  readonly evaluationTime: string;
  readonly operationId: string;
  readonly maxStatusAgeSeconds: Readonly<Record<DocumentUseAction, number>>;
  readonly store: Store;
}

function readContext(raw: unknown): Context | undefined {
  const fields = readPlain(raw, CONTEXT_KEYS, CONTEXT_KEYS);
  if (fields === undefined) return undefined;
  const resolver = bindResolver(fields.get('verificationKeyResolver'));
  const store = bindStore(fields.get('historyStore'));
  const evaluationTime = fields.get('evaluationTime');
  const operationId = fields.get('operationId');
  if (resolver === undefined || store === undefined || typeof evaluationTime !== 'string') return undefined;
  if (!isIdentifier(operationId) || operationId.length > MAX_OPERATION_ID_LENGTH) return undefined;

  // Every action needs its own limit, from 1 second up to its ceiling: a host may
  // be stricter than the ceilings, never looser, and nothing is defaulted.
  const limits = readPlain(fields.get('maxStatusAgeSeconds'), DOCUMENT_USE_ACTIONS, DOCUMENT_USE_ACTIONS);
  if (limits === undefined) return undefined;
  const maxStatusAgeSeconds = Object.create(null) as Record<DocumentUseAction, number>;
  for (const action of DOCUMENT_USE_ACTIONS) {
    const limit = limits.get(action);
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_USE_FRESHNESS_CEILINGS[action]) return undefined;
    maxStatusAgeSeconds[action] = limit;
  }
  return { resolver, evaluationTime, operationId, maxStatusAgeSeconds, store };
}

function bindResolver(value: unknown): ReceiverVerificationKeyResolver | undefined {
  const methods = bindMethods(value, ['resolveVerificationKey'] as const);
  if (methods === undefined) return undefined;
  return { resolveVerificationKey: (issuer) => methods.resolveVerificationKey(issuer) as ReturnType<ReceiverVerificationKeyResolver['resolveVerificationKey']> };
}

function bindStore(value: unknown): Store | undefined {
  const methods = bindMethods(value, ['read', 'compareAndSet'] as const);
  if (methods === undefined) return undefined;
  return {
    read: async (key) => methods.read({ ...key }),
    compareAndSet: async (key, expectedRevision, next) => methods.compareAndSet({ ...key }, expectedRevision, next),
  };
}

/**
 * Reads and validates the stored entry. A store that throws is unavailable; one
 * that returns anything but a well-formed mark for exactly this key is invalid.
 * A well-formed but stale entry (a store rolled back as a whole) cannot be told
 * from a genuine one here; anchoring the store is FV-P4C-2.
 */
async function readEntry(store: Store, key: StatusHistoryKey): Promise<StatusHighWaterMarkEntry | undefined | 'unavailable' | 'invalid'> {
  let raw: unknown;
  try {
    raw = await store.read(key);
  } catch {
    return 'unavailable';
  }
  if (raw === undefined) return undefined;
  const entry = readPlain(raw, ['revision', 'mark'], ['revision', 'mark']);
  if (entry === undefined) return 'invalid';
  const revision = entry.get('revision');
  const mark = readMark(entry.get('mark'));
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || mark === undefined) return 'invalid';
  if (mark.sovereignAssetId !== key.sovereignAssetId || mark.issuer !== key.issuer) return 'invalid';
  return { revision, mark };
}

function readMark(value: unknown): StatusHighWaterMark | undefined {
  const fields = readPlain(value, MARK_KEYS, MARK_KEYS);
  if (fields === undefined) return undefined;
  const get = (key: (typeof MARK_KEYS)[number]) => fields.get(key);
  const sequence = get('sequence');
  const currentTermsDigest = get('currentTermsDigest');
  const retired = get('retiredTermsDigests');
  const continuity = get('continuity');
  if (!isIdentifier(get('sovereignAssetId')) || !isIdentifier(get('issuer'))) return undefined;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  if (!isDigest(get('statusDigest')) || (currentTermsDigest !== null && !isDigest(currentTermsDigest))) return undefined;
  for (const key of ['issuedAt', 'timeFloor', 'anchoredAt'] as const) if (canonicalInstant(get(key)) === undefined) return undefined;
  if (canonicalInstant(get('timeFloor'))! < canonicalInstant(get('issuedAt'))!) return undefined;
  if (typeof get('withdrawn') !== 'boolean' || typeof get('conflict') !== 'boolean') return undefined;
  if (continuity !== 'verified' && continuity !== 'unproven') return undefined;
  if (!Array.isArray(retired) || !retired.every(isDigest)) return undefined;
  for (let index = 1; index < retired.length; index += 1) if (!(retired[index - 1]! < retired[index]!)) return undefined;
  return {
    sovereignAssetId: get('sovereignAssetId') as string,
    issuer: get('issuer') as string,
    sequence,
    statusDigest: get('statusDigest') as string,
    issuedAt: get('issuedAt') as string,
    currentTermsDigest: currentTermsDigest as string | null,
    timeFloor: get('timeFloor') as string,
    withdrawn: get('withdrawn') as boolean,
    retiredTermsDigests: [...(retired as string[])],
    continuity,
    conflict: get('conflict') as boolean,
    anchoredAt: get('anchoredAt') as string,
  };
}

function statusVerdict(reason: SovereignStatusRejectionReason): DocumentUseFreshnessVerdict {
  if (reason === 'STATUS_EXPIRED') return 'EXPIRED';
  if (reason === 'STATUS_SUBJECT_MISMATCH' || reason === 'MANIFEST_BINDING_MISMATCH' || reason === 'STATUS_ISSUER_UNAUTHORIZED') return 'STATUS_BINDING_MISMATCH';
  return 'STATUS_VERIFICATION_FAILED';
}

function statusEvidence(verified: SovereignStatusVerified): DocumentUseFreshnessStatusEvidence {
  return {
    sequence: verified.sequence,
    statusDigest: verified.statusDigest,
    assetStatus: verified.assetStatus,
    currentTermsDigest: verified.currentTerms === null ? null : verified.currentTerms.claimDigest,
    issuedAt: verified.issuedAt,
    validUntil: verified.validUntil,
  };
}

function later(a: string, b: string): string {
  return canonicalInstant(b)! > canonicalInstant(a)! ? b : a;
}

function result(verdict: DocumentUseFreshnessVerdict, state: GateState): DocumentUseFreshnessResult {
  // Non-escalation: only FRESH lets a decision stand, and nothing ever rises.
  const after: DocumentUsePolicyDecisionValue = verdict === 'FRESH' && (state.before === 'ALLOWED' || state.before === 'WITHHELD') ? state.before : 'DENIED';
  return deepFreeze({
    gate: DOCUMENT_USE_FRESHNESS_GATE,
    operationId: state.operationId,
    action: state.action,
    sovereignAssetId: state.sovereignAssetId,
    policy: state.policy === null ? null : { ...state.policy },
    evaluationTime: state.evaluationTime,
    policyDecisionBefore: state.before,
    policyDecisionAfterFreshness: after,
    freshnessVerdict: verdict,
    statusRejection: state.statusRejection,
    status: state.status === null ? null : { ...state.status },
    history: {
      ...state.history,
      before: state.history.before === null ? null : { ...state.history.before },
      after: state.history.after === null ? null : { ...state.history.after },
    },
    maxStatusAgeSeconds: state.maxStatusAgeSeconds,
    authorization: 'not_evaluated',
    execution: 'not_performed',
  });
}

function bootstrapResult(
  reason: StatusHistoryBootstrapReason,
  statusRejection: SovereignStatusRejectionReason | null = null,
  mark: StatusHighWaterMark | null = null,
): StatusHistoryBootstrapResult {
  return deepFreeze({
    outcome: reason === 'ESTABLISHED' || reason === 'REESTABLISHED' ? 'established' : 'refused',
    reason,
    statusRejection,
    mark: mark === null ? null : { ...mark, retiredTermsDigests: [...mark.retiredTermsDigests] },
  });
}
