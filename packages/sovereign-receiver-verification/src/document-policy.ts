import { isIssuedDocumentUseEligibility } from './document-use.js';
import { DOCUMENT_USE_PROFILE } from './document-use-types.js';
import type { DocumentUseEligible } from './document-use-types.js';
import { DOCUMENT_USE_ACTIONS, DOCUMENT_USE_POLICY_EVALUATOR } from './document-policy-types.js';
import type {
  DocumentUsePolicyDecision,
  DocumentUsePolicyDecisionValue,
  DocumentUsePolicyReason,
  DocumentUsePolicyReference,
} from './document-policy-types.js';

/**
 * FV-P3 — deterministic policy evaluation for `soberania.document-use/1`
 * (profile §4, §4 Time, §2 audience).
 *
 * Layer 3 of five, and only that one:
 *   artifact verification (RSDK-01) → eligibility (FV-P2) → **policy evaluation** →
 *   authorization → enforcement.
 * A decision authorizes nothing, issues no capability, executes nothing and
 * says nothing about revocation or freshness. ALLOWED is an evaluated
 * permission under the eligible terms at the host-supplied instant, not a
 * permit to act.
 *
 * Pure and synchronous: no clock, environment, network, storage, credentials
 * or Protocol call. Its only non-argument input is the membership check that
 * the eligibility result was issued by `verifyDocumentUseEligibility` in this
 * process (see `isIssuedDocumentUseEligibility`). Never throws; any failure is
 * `DENIED`.
 */

const ACCESS = 'aoc.licensing:access';
const EXPORT = 'soberania.document:export';
const MODIFY = 'soberania.document:modify-protected-terms';
const OWNER_APPROVAL = 'soberania.document:owner-approval.modify-protected-terms';

/** The profile's concept table (§3): each concept's one namespace, and whether it is an action or the obligated action. */
const CONCEPTS: ReadonlyMap<string, { readonly namespace: string; readonly kind: 'action' | 'obligated-action' }> = new Map([
  [ACCESS, { namespace: 'aoc.licensing', kind: 'action' }],
  [EXPORT, { namespace: 'soberania.document', kind: 'action' }],
  [MODIFY, { namespace: 'soberania.document', kind: 'action' }],
  [OWNER_APPROVAL, { namespace: 'soberania.document', kind: 'obligated-action' }],
] as const);

/** The approval the profile's table links to an action. The link comes from this table, never from parsing a termRef. */
const APPROVAL_FOR: ReadonlyMap<string, string> = new Map([[MODIFY, OWNER_APPROVAL]]);

const EFFECTS: ReadonlySet<string> = new Set(['Permission', 'Restriction', 'Obligation']);
const ACTIONS: ReadonlySet<string> = new Set(DOCUMENT_USE_ACTIONS);

/** `aoc-canonical-json/1` timestamps, as Protocol's `isCanonicalTimestamp` accepts them. */
const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

interface Inputs {
  readonly eligibility: DocumentUseEligible;
  readonly action: string;
  readonly evaluationTime: string;
}

type Known = { action: string | null; sovereignAssetId: string | null; policy: DocumentUsePolicyReference | null; evaluationTime: string | null };

export function evaluateDocumentUsePolicy(eligibility: unknown, request: unknown, trustedContext: unknown): DocumentUsePolicyDecision {
  const known: Known = { action: null, sovereignAssetId: null, policy: null, evaluationTime: null };
  try {
    return evaluate(eligibility, request, trustedContext, known);
  } catch {
    return decision('DENIED', 'EVALUATION_ERROR', known, []);
  }
}

function evaluate(rawEligibility: unknown, rawRequest: unknown, rawContext: unknown, known: Known): DocumentUsePolicyDecision {
  // 1. Only an eligible result issued by FV-P2 in this process is trusted. It is
  //    deeply frozen, so its asset, issuer and terms are exactly what was verified.
  if (!isIssuedDocumentUseEligibility(rawEligibility)) return decision('DENIED', 'ELIGIBILITY_UNVERIFIED', known, []);
  const eligibility = rawEligibility;
  known.sovereignAssetId = eligibility.sovereignAssetId;
  known.policy = { claimId: eligibility.terms.claimId, claimDigest: eligibility.terms.claimDigest };

  // 2. The requester names an action and nothing else.
  const request = readPlain(rawRequest, ['action'], ['action']);
  if (request === undefined) return decision('DENIED', 'REQUEST_INVALID', known, []);
  const action = request.get('action');
  if (typeof action !== 'string') return decision('DENIED', 'REQUEST_INVALID', known, []);
  known.action = action;

  // 3. The host's trusted context: every field required, nothing else accepted.
  const contextKeys = ['receiverPrincipal', 'evaluationTime', 'expectedSovereignAssetId', 'policyReference'];
  const context = readPlain(rawContext, contextKeys, contextKeys);
  if (context === undefined) return decision('DENIED', 'CONTEXT_INVALID', known, []);
  const reference = readPlain(context.get('policyReference'), ['claimId', 'claimDigest'], ['claimId', 'claimDigest']);
  const expectedAsset = context.get('expectedSovereignAssetId');
  if (reference === undefined || typeof expectedAsset !== 'string') return decision('DENIED', 'CONTEXT_INVALID', known, []);

  const evaluationTime = context.get('evaluationTime');
  if (timestampKey(evaluationTime) === undefined) return decision('DENIED', 'EVALUATION_TIME_INVALID', known, []);
  known.evaluationTime = evaluationTime as string;

  const receiver = context.get('receiverPrincipal');
  if (typeof receiver !== 'string' || receiver === '' || receiver.trim() !== receiver) {
    return decision('DENIED', 'RECEIVER_IDENTITY_INVALID', known, []);
  }

  // 4. What was verified must be what the host was asked about.
  if (expectedAsset !== eligibility.sovereignAssetId) return decision('DENIED', 'ASSET_MISMATCH', known, []);
  if (reference.get('claimId') !== eligibility.terms.claimId || reference.get('claimDigest') !== eligibility.terms.claimDigest) {
    return decision('DENIED', 'POLICY_REFERENCE_MISMATCH', known, []);
  }

  if (!ACTIONS.has(action)) return decision('DENIED', 'ACTION_UNKNOWN', known, []);

  return applyTerms({ eligibility, action, evaluationTime: evaluationTime as string }, receiver, known);
}

function applyTerms(inputs: Inputs, receiver: string, known: Known): DocumentUsePolicyDecision {
  const { terms } = inputs.eligibility;

  // §4 Time: in effect from effectiveAt (inclusive) until expiresAt (exclusive).
  // Absent bounds are absent, never defaulted. Compared exactly, without a clock.
  const now = timestampKey(inputs.evaluationTime)!;
  const effectiveAt = terms.effectiveAt === null ? null : timestampKey(terms.effectiveAt);
  const expiresAt = terms.expiresAt === null ? null : timestampKey(terms.expiresAt);
  if (effectiveAt === undefined || expiresAt === undefined) return decision('DENIED', 'TERMS_TIME_INVALID', known, []);
  if (effectiveAt !== null && now < effectiveAt) return decision('DENIED', 'TERMS_NOT_YET_EFFECTIVE', known, []);
  if (expiresAt !== null && now >= expiresAt) return decision('DENIED', 'TERMS_EXPIRED', known, []);

  // §2 audience: exactly this receiver, or everyone. Any other audience kind is not interpreted.
  const audience = audienceMatch(terms.audience, receiver);
  if (audience !== 'match') return decision('DENIED', audience, known, []);

  // §4 steps 1–2: every rule must name a profile concept with an effect that has a meaning there.
  for (const rule of terms.rules) {
    const concept = CONCEPTS.get(rule.action.termRef);
    if (concept === undefined || concept.namespace !== rule.action.namespace) return decision('DENIED', 'CONCEPT_UNSUPPORTED', known, [rule.id]);
    if (!EFFECTS.has(rule.effect)) return decision('DENIED', 'EFFECT_UNSUPPORTED', known, [rule.id]);
    const isObligation = rule.effect === 'Obligation';
    if (isObligation !== (concept.kind === 'obligated-action')) return decision('DENIED', 'EFFECT_MISPLACED', known, [rule.id]);
  }

  const on = (effect: string, termRef: string) => terms.rules.filter((rule) => rule.effect === effect && rule.action.termRef === termRef).map((rule) => rule.id);

  // §4 step 3: a Restriction over the action wins, whatever else the terms say.
  const restrictions = on('Restriction', inputs.action);
  if (restrictions.length > 0) return decision('DENIED', 'RESTRICTED', known, restrictions);

  // §4 step 4: nothing is permitted by default.
  const permissions = on('Permission', inputs.action);
  if (permissions.length === 0) return decision('DENIED', 'NOT_PERMITTED', known, []);

  // §4 step 5: an approval obligation linked to this action is never satisfied
  // here, because no approval evidence format exists yet.
  const approval = APPROVAL_FOR.get(inputs.action);
  const obligations = approval === undefined ? [] : on('Obligation', approval);
  if (obligations.length > 0) return decision('WITHHELD', 'OWNER_APPROVAL_REQUIRED', known, [...permissions, ...obligations]);

  // §4 step 6.
  return decision('ALLOWED', 'PERMITTED', known, permissions);
}

function audienceMatch(audience: unknown, receiver: string): 'match' | 'AUDIENCE_MISMATCH' | 'AUDIENCE_UNSUPPORTED' {
  const kind = typeof audience === 'object' && audience !== null ? (audience as Record<string, unknown>)['kind'] : undefined;
  // Public (founder decision, FV-P3.1): the terms are addressed to any receiver.
  // It does not make the content public and authorizes nothing: every rule,
  // the time bounds, the asset and eligibility still apply, and no audience can
  // turn a Restriction into a Permission. A receiver identity is still required.
  if (kind === 'Public') {
    return readPlain(audience, ['kind'], ['kind']) === undefined ? 'AUDIENCE_UNSUPPORTED' : 'match';
  }
  if (kind === 'Principal') {
    const fields = readPlain(audience, ['kind', 'principal'], ['kind', 'principal']);
    if (fields === undefined || typeof fields.get('principal') !== 'string') return 'AUDIENCE_UNSUPPORTED';
    // Exact identity: no case folding, trimming, prefix or pattern matching.
    return fields.get('principal') === receiver ? 'match' : 'AUDIENCE_MISMATCH';
  }
  return 'AUDIENCE_UNSUPPORTED';
}

/**
 * A totally ordered key for a canonical UTC timestamp, or `undefined` when the
 * value is not one. The fraction is padded to nine digits, so plain string
 * comparison is exact to the nanosecond (no millisecond rounding).
 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function timestampKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return `${value.slice(0, 19)}.${(match[7] ?? '').padEnd(9, '0')}`;
}

/**
 * Reads a plain object's own data properties exactly once. Refuses non-plain
 * objects, accessors, symbol keys, unknown keys and missing required keys, so a
 * getter can never run and an inherited or injected field is never honoured.
 */
function readPlain(value: unknown, allowed: readonly string[], required: readonly string[]): Map<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  for (const key of required) if (!values.has(key)) return undefined;
  return values;
}

function decision(
  value: DocumentUsePolicyDecisionValue,
  reason: DocumentUsePolicyReason,
  known: Known,
  matchedRuleIds: readonly string[],
): DocumentUsePolicyDecision {
  return deepFreeze({
    decision: value,
    reason,
    evaluator: DOCUMENT_USE_POLICY_EVALUATOR,
    documentProfile: DOCUMENT_USE_PROFILE,
    action: known.action,
    sovereignAssetId: known.sovereignAssetId,
    policy: known.policy === null ? null : { ...known.policy },
    evaluationTime: known.evaluationTime,
    matchedRuleIds: [...matchedRuleIds],
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    execution: 'not_performed',
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
