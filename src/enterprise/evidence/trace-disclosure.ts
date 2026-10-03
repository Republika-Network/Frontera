import { computeDigest } from '../governance-store/digest.js';
import { redactSensitiveValues } from '../governance-store/redaction.js';
import { EVIDENCE_FIELD_KEYS, type DisclosureLevel, type EvidenceFieldKey } from './contracts.js';
import { EvidenceError } from './errors.js';
import { AUTHORITY_TRACE_STAGE_NAMES, type AuthorityTraceVerification, type AuthorityTrace, type AuthorityTraceFinalState, type AuthorityTracePresence, type AuthorityTraceStageName, type AuthorityTraceDecisionPath } from './trace-contracts.js';

/**
 * ASSURE-01 — disclosure for the unified trace (`Truth ≠ Disclosure`).
 *
 * A trace is richer than a v1 bundle, so it gets a v2 field vocabulary: the
 * ten v1 fields, unchanged in meaning, plus one field per trace stage. The v1
 * policies (`disclosure-policies.ts`) are not touched — their field lists are
 * embedded in every historical v1 bundle and re-checked on verification, so
 * widening them would silently fail every bundle ever built. Five **new** v2
 * policies classify the wider vocabulary, each validated as a true partition at
 * module load exactly like v1.
 *
 * Every stage is already a bounded projection (identities, digests, statuses,
 * reason codes, timestamps); no stage carries a request or result payload, an
 * approval subject text, evidence bodies, a revocation note, an obligation
 * reference, a credential, a signer identity or a provider response.
 */

export const TRACE_FIELD_KEYS = [
  'trace.summary',
  'trace.request',
  'trace.decision',
  'trace.approval',
  'trace.obligations',
  'trace.authority',
  'trace.execution',
  'trace.parameters',
  'trace.reservation',
  'trace.outcome',
  'trace.resolution',
  'trace.events',
] as const;

export type TraceFieldKey = (typeof TRACE_FIELD_KEYS)[number];

/** The v2 vocabulary: every v1 field plus every trace field. */
export const EVIDENCE_FIELD_KEYS_V2 = [...EVIDENCE_FIELD_KEYS, ...TRACE_FIELD_KEYS] as const;

export type EvidenceFieldKeyV2 = EvidenceFieldKey | TraceFieldKey;

export interface DisclosurePolicyV2 {
  readonly policyId: string;
  readonly level: DisclosureLevel;
  readonly version: string;
  readonly visibleFields: readonly EvidenceFieldKeyV2[];
  readonly hiddenFields: readonly EvidenceFieldKeyV2[];
  readonly redactedFields: readonly EvidenceFieldKeyV2[];
  readonly requiredFields: readonly EvidenceFieldKeyV2[];
  readonly optionalFields: readonly EvidenceFieldKeyV2[];
}

const STAGE_OF_FIELD: Readonly<Record<Exclude<TraceFieldKey, 'trace.summary'>, AuthorityTraceStageName>> = {
  'trace.request': 'request',
  'trace.decision': 'decision',
  'trace.approval': 'approval',
  'trace.obligations': 'obligations',
  'trace.authority': 'authority',
  'trace.execution': 'execution',
  'trace.parameters': 'parameters',
  'trace.reservation': 'reservation',
  'trace.outcome': 'outcome',
  'trace.resolution': 'resolution',
  'trace.events': 'events',
};

function validatePolicyV2(policy: DisclosurePolicyV2): DisclosurePolicyV2 {
  const all = new Set<string>(EVIDENCE_FIELD_KEYS_V2);
  const visible = new Set(policy.visibleFields);
  const hidden = new Set(policy.hiddenFields);
  for (const field of visible) if (hidden.has(field)) throw new Error(`Disclosure policy '${policy.policyId}': field '${field}' cannot be both visible and hidden.`);
  const union = new Set([...visible, ...hidden]);
  if (union.size !== all.size || [...all].some((field) => !union.has(field as EvidenceFieldKeyV2)) || policy.visibleFields.length + policy.hiddenFields.length !== all.size) {
    throw new Error(`Disclosure policy '${policy.policyId}': visibleFields + hiddenFields must exactly partition EVIDENCE_FIELD_KEYS_V2.`);
  }
  for (const field of policy.redactedFields) if (!visible.has(field)) throw new Error(`Disclosure policy '${policy.policyId}': redacted field '${field}' must also be a visible field.`);
  const required = new Set(policy.requiredFields);
  const optional = new Set(policy.optionalFields);
  for (const field of required) if (optional.has(field)) throw new Error(`Disclosure policy '${policy.policyId}': field '${field}' cannot be both required and optional.`);
  const requiredOptional = new Set([...required, ...optional]);
  if (requiredOptional.size !== visible.size || [...visible].some((field) => !requiredOptional.has(field))) {
    throw new Error(`Disclosure policy '${policy.policyId}': requiredFields + optionalFields must exactly partition visibleFields.`);
  }
  return Object.freeze({ ...policy });
}

function without<T extends string>(all: readonly T[], removed: readonly T[]): T[] {
  return all.filter((field) => !removed.includes(field));
}

const ALL_V2 = [...EVIDENCE_FIELD_KEYS_V2] as EvidenceFieldKeyV2[];

/** FULL v2: every field. Internal use only. */
export const FULL_DISCLOSURE_POLICY_V2 = validatePolicyV2({
  policyId: 'evidence.disclosure.full.v2',
  level: 'FULL',
  version: '2.0.0',
  visibleFields: ALL_V2,
  hiddenFields: [],
  redactedFields: [],
  requiredFields: ['evidence.status', 'evidence.summary', 'evidence.reasonCodes', 'trace.summary', 'trace.decision'],
  optionalFields: without(ALL_V2, ['evidence.status', 'evidence.summary', 'evidence.reasonCodes', 'trace.summary', 'trace.decision']),
});

const AUDITOR_HIDDEN: EvidenceFieldKeyV2[] = ['evidence.metadata'];
/** AUDITOR v2: the whole authority-to-outcome trace — who, what, which authority, which approvals and obligations, which execution, outcome, resolution and events — without internal runtime metadata. The third-party audit level. */
export const AUDITOR_DISCLOSURE_POLICY_V2 = validatePolicyV2({
  policyId: 'evidence.disclosure.auditor.v2',
  level: 'AUDITOR',
  version: '2.0.0',
  visibleFields: without(ALL_V2, AUDITOR_HIDDEN),
  hiddenFields: AUDITOR_HIDDEN,
  redactedFields: [],
  requiredFields: ['evidence.status', 'evidence.summary', 'evidence.reasonCodes', 'evidence.trace', ...TRACE_FIELD_KEYS],
  optionalFields: ['source.organizationId', 'subject.actionType', 'subject.resourceScope', 'subject.description', 'evidence.events'],
});

const PARTNER_HIDDEN: EvidenceFieldKeyV2[] = ['source.organizationId', 'evidence.trace', 'evidence.metadata', 'trace.request', 'trace.approval', 'trace.obligations', 'trace.parameters', 'trace.reservation', 'trace.events'];
/** PARTNER v2: the decision, the authority that covered it and what became of the execution — not who asked, approvals, obligations, amounts and parameters, ledger state or the event stream. */
export const PARTNER_DISCLOSURE_POLICY_V2 = validatePolicyV2({
  policyId: 'evidence.disclosure.partner.v2',
  level: 'PARTNER',
  version: '2.0.0',
  visibleFields: without(ALL_V2, PARTNER_HIDDEN),
  hiddenFields: PARTNER_HIDDEN,
  redactedFields: [],
  requiredFields: ['evidence.status', 'evidence.summary', 'trace.summary', 'trace.decision'],
  optionalFields: without(without(ALL_V2, PARTNER_HIDDEN), ['evidence.status', 'evidence.summary', 'trace.summary', 'trace.decision']),
});

const CUSTOMER_VISIBLE: EvidenceFieldKeyV2[] = ['subject.description', 'evidence.status', 'evidence.summary', 'evidence.reasonCodes', 'trace.summary', 'trace.decision', 'trace.outcome', 'trace.resolution'];
/** CUSTOMER v2: the outcome and why, and what became of the execution — nothing about how authority was held or exercised. */
export const CUSTOMER_DISCLOSURE_POLICY_V2 = validatePolicyV2({
  policyId: 'evidence.disclosure.customer.v2',
  level: 'CUSTOMER',
  version: '2.0.0',
  visibleFields: CUSTOMER_VISIBLE,
  hiddenFields: without(ALL_V2, CUSTOMER_VISIBLE),
  redactedFields: [],
  requiredFields: ['evidence.status', 'trace.summary'],
  optionalFields: without(CUSTOMER_VISIBLE, ['evidence.status', 'trace.summary']),
});

const PUBLIC_VISIBLE: EvidenceFieldKeyV2[] = ['subject.description', 'evidence.status', 'trace.summary'];
/** PUBLIC v2: that a decision was made, its outcome, and where the request ended. */
export const PUBLIC_DISCLOSURE_POLICY_V2 = validatePolicyV2({
  policyId: 'evidence.disclosure.public.v2',
  level: 'PUBLIC',
  version: '2.0.0',
  visibleFields: PUBLIC_VISIBLE,
  hiddenFields: without(ALL_V2, PUBLIC_VISIBLE),
  redactedFields: ['subject.description'],
  requiredFields: ['evidence.status', 'trace.summary'],
  optionalFields: ['subject.description'],
});

const POLICIES_V2: Readonly<Record<DisclosureLevel, DisclosurePolicyV2>> = {
  FULL: FULL_DISCLOSURE_POLICY_V2,
  AUDITOR: AUDITOR_DISCLOSURE_POLICY_V2,
  PARTNER: PARTNER_DISCLOSURE_POLICY_V2,
  CUSTOMER: CUSTOMER_DISCLOSURE_POLICY_V2,
  PUBLIC: PUBLIC_DISCLOSURE_POLICY_V2,
};

/** Closed: an unknown level is refused, never defaulted to a more permissive one. */
export function getDisclosurePolicyV2(level: string): DisclosurePolicyV2 {
  const policy = (POLICIES_V2 as Record<string, DisclosurePolicyV2 | undefined>)[level];
  if (policy === undefined) {
    throw new EvidenceError('EVIDENCE_DISCLOSURE_POLICY_UNKNOWN', `Unknown disclosure level '${level}'. Supported levels: ${Object.keys(POLICIES_V2).join(', ')}.`);
  }
  return policy;
}

export function findDisclosurePolicyV2ById(policyId: string): DisclosurePolicyV2 | undefined {
  return Object.values(POLICIES_V2).find((policy) => policy.policyId === policyId);
}

export function listDisclosurePoliciesV2(): readonly DisclosurePolicyV2[] {
  return Object.values(POLICIES_V2);
}

// ---------------------------------------------------------------------------
// The disclosed trace
// ---------------------------------------------------------------------------

export const TRACE_DISCLOSURE_REDACTED_VALUE = '[REDACTED-BY-DISCLOSURE-POLICY]' as const;

export interface DisclosedAuthorityTraceSummary {
  readonly path: AuthorityTraceDecisionPath;
  readonly finalState: AuthorityTraceFinalState;
  readonly presence: Readonly<Record<AuthorityTraceStageName, AuthorityTracePresence>>;
}

/**
 * What a third party receives: the trace's identities (always — they are the
 * lookup key and its exact derivations, already in every bundle's `source`),
 * the organization only when the policy discloses it, and each stage only as
 * the policy classifies it. A hidden stage is absent; a redacted one keeps its
 * key with the placeholder.
 */
export interface DisclosedAuthorityTrace {
  readonly traceVersion: string;
  readonly requestId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly executionId?: string;
  readonly organizationId?: string;
  readonly summary?: DisclosedAuthorityTraceSummary | typeof TRACE_DISCLOSURE_REDACTED_VALUE;
  readonly stages: Readonly<Partial<Record<AuthorityTraceStageName, unknown>>>;
}

export function summarizeTrace(trace: AuthorityTrace): DisclosedAuthorityTraceSummary {
  const presence = Object.fromEntries(AUTHORITY_TRACE_STAGE_NAMES.map((name) => [name, trace.stages[name].presence])) as Record<AuthorityTraceStageName, AuthorityTracePresence>;
  return { path: trace.path, finalState: trace.finalState, presence };
}

/** Projects the canonical trace under a v2 policy. Pure and deterministic, so the same trace and policy always disclose identical bytes. */
export function discloseAuthorityTrace(trace: AuthorityTrace, policy: DisclosurePolicyV2): DisclosedAuthorityTrace {
  const hidden = new Set(policy.hiddenFields);
  const redacted = new Set(policy.redactedFields);
  const stages: Partial<Record<AuthorityTraceStageName, unknown>> = {};
  for (const [field, stage] of Object.entries(STAGE_OF_FIELD) as [TraceFieldKey, AuthorityTraceStageName][]) {
    if (hidden.has(field)) continue;
    stages[stage] = redacted.has(field) ? TRACE_DISCLOSURE_REDACTED_VALUE : withinPolicy(stage, trace.stages[stage], hidden);
  }
  const summary = hidden.has('trace.summary') ? undefined : redacted.has('trace.summary') ? TRACE_DISCLOSURE_REDACTED_VALUE : summarizeTrace(trace);
  const disclosed: DisclosedAuthorityTrace = {
    traceVersion: trace.traceVersion,
    requestId: trace.requestId,
    evaluationId: trace.evaluationId,
    decisionId: trace.decisionId,
    ...(trace.executionId !== undefined ? { executionId: trace.executionId } : {}),
    ...(!hidden.has('source.organizationId') ? { organizationId: redacted.has('source.organizationId') ? TRACE_DISCLOSURE_REDACTED_VALUE : trace.organizationId } : {}),
    ...(summary !== undefined ? { summary } : {}),
    stages,
  };
  // Defence in depth, as for v1: a secret-shaped key can never reach a third party.
  return redactSensitiveValues(disclosed);
}

/** Identifiers of people and mechanisms that a visible stage may carry, and the field whose visibility each depends on. */
const PEOPLE_FIELDS = ['issuerRef'] as const;
const MECHANISM_FIELDS = ['adapterId', 'routedBy', 'providerRef', 'authorityId', 'binding'] as const;

function strip(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, keys));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)).map(([key, inner]) => [key, strip(inner, keys)]));
}

/**
 * Sub-fields a visible stage carries that another field's policy governs: who
 * acted (a revocation's issuer — hidden wherever approvals, the other human
 * identities, are), and which mechanism ran (adapter, router, provider handle,
 * resolution authority — hidden wherever the authority that reached it is).
 */
function withinPolicy(stage: AuthorityTraceStageName, value: unknown, hidden: ReadonlySet<EvidenceFieldKeyV2>): unknown {
  let out = value;
  if (hidden.has('trace.approval')) out = strip(out, PEOPLE_FIELDS);
  if (hidden.has('trace.authority') && (stage === 'outcome' || stage === 'resolution')) {
    out = strip(out, MECHANISM_FIELDS);
    // The Governance summary names the adapter after `@` (`executed@<adapter>`): keep the outcome, drop the mechanism.
    if (typeof out === 'object' && out !== null && typeof (out as Record<string, unknown>)['governanceSummary'] === 'string') {
      const summary = (out as Record<string, string>)['governanceSummary'] ?? '';
      out = { ...(out as Record<string, unknown>), governanceSummary: summary.split('@')[0] };
    }
  }
  return out;
}

/**
 * The verification a caller at this level may see. FULL and AUDITOR (every
 * stage visible) see every check. Below them, the result is reduced to what
 * cannot disclose a hidden stage: the verdict, the categories, the final state
 * (always visible through the summary) and the names of failing checks with
 * any embedded identity removed — no details, no canonical digest.
 */
export function discloseTraceVerification(verification: AuthorityTraceVerification, policy: DisclosurePolicyV2): AuthorityTraceVerification {
  if (TRACE_FIELD_KEYS.every((field) => !policy.hiddenFields.includes(field) && !policy.redactedFields.includes(field))) return verification;
  const { traceDigest: _digest, ...rest } = verification;
  void _digest;
  return {
    ...rest,
    checks: verification.checks.filter((entry) => entry.status === 'fail').map((entry) => ({ check: entry.check.split(':')[0] ?? entry.check, category: entry.category, status: entry.status })),
  };
}

export function disclosedTraceDigest(disclosed: DisclosedAuthorityTrace): string {
  return computeDigest(disclosed);
}

// ---------------------------------------------------------------------------
// Historical vs current
// ---------------------------------------------------------------------------

/**
 * How a trace disclosed earlier stands against the canonical records now.
 *
 * - `matches` — byte-for-byte the same disclosure.
 * - `progressed` — every disclosed fact is still exactly true; the request has
 *   only moved on (an unresolved outcome resolved, an approval decided, a grant
 *   revoked, more events appended). Freshness, not integrity.
 * - `contradicted` — something the earlier disclosure stated is no longer what
 *   the canonical records say. A recorded fact never changes.
 */
export type TraceComparison = 'matches' | 'progressed' | 'contradicted';

export interface TraceComparisonResult {
  readonly result: TraceComparison;
  readonly stages: Readonly<Partial<Record<AuthorityTraceStageName | 'summary' | 'identity', TraceComparison>>>;
}

const canonical = (value: unknown): string => computeDigest(value ?? null);

const OPEN_PRESENCE: ReadonlySet<string> = new Set(['not-reached', 'unresolved', 'none-recorded']);
/** A broken presence never counts as progress. */
const BROKEN_PRESENCE: ReadonlySet<string> = new Set(['missing', 'unreadable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lists that only ever grow by appending (append-only logs and streams). */
const APPEND_ONLY_LISTS: ReadonlySet<string> = new Set(['records', 'discharges', 'events']);
/** Keys a recorded object may gain later without any earlier fact changing. */
const LATER_KEYS: ReadonlySet<string> = new Set(['revocation', 'resolution', 'terminalReason', 'governanceSummary', 'head']);

/**
 * True when every fact `before` states is still exactly stated by `after`.
 *
 * - A presence may move only from an open value (`not-reached`, `unresolved`,
 *   `none-recorded` — and, for the best-effort event stream only, `missing`) to
 *   anything but a broken one.
 * - Every other key `before` carries must still be there, compared the same way
 *   (recursively); a primitive must be identical — except a reservation that
 *   was `reserved`, which may since have settled or been released.
 * - An append-only list may only grow at its end; the grant list may gain
 *   grants, each earlier grant still matching.
 * - New keys may appear on an open object; on a recorded one only the few that
 *   are later facts by nature (a revocation, a resolution, a terminal reason, a
 *   summary, a newer stream head).
 */
function preserved(before: unknown, after: unknown, key: string, stage: AuthorityTraceStageName): boolean {
  if (canonical(before) === canonical(after)) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (APPEND_ONLY_LISTS.has(key)) return before.length <= after.length && before.every((item, index) => canonical(item) === canonical(after[index]));
    if (key === 'grants') {
      return before.every((grant) => {
        const id = isRecord(grant) ? grant['grantId'] : undefined;
        const now = after.find((candidate) => isRecord(candidate) && candidate['grantId'] === id);
        return now !== undefined && preserved(grant, now, 'grant', stage);
      });
    }
    return false;
  }
  if (isRecord(before) && isRecord(after)) {
    const was = before['presence'];
    const now = after['presence'];
    const open = typeof was === 'string' && (OPEN_PRESENCE.has(was) || (stage === 'events' && key === 'stage' && was === 'missing'));
    if (was !== now && (!open || BROKEN_PRESENCE.has(String(now)))) return false;
    for (const [field, value] of Object.entries(before)) {
      if (field === 'presence') continue;
      if (!(field in after)) return false;
      if (field === 'head' && stage === 'events') continue; // the head moves with appended events, checked through them
      if (field === 'state' && stage === 'reservation' && value === 'reserved' && ['settled', 'released'].includes(String(after[field]))) continue;
      if (!preserved(value, after[field], field, stage)) return false;
    }
    if (!open) for (const field of Object.keys(after)) if (!(field in before) && !LATER_KEYS.has(field)) return false;
    return true;
  }
  return false;
}

function stageProgressed(name: AuthorityTraceStageName, before: unknown, after: unknown): boolean {
  if (!isRecord(before) || !isRecord(after)) return false;
  return preserved(before, after, 'stage', name);
}

/**
 * Where a request may move on to. Every other final state is terminal: a
 * confirmed outcome, a denial or a resolution never becomes anything else.
 */
const FINAL_STATE_SUCCESSORS: Readonly<Partial<Record<AuthorityTraceFinalState, readonly AuthorityTraceFinalState[]>>> = {
  'approval-pending': ['not-executed', 'withheld-at-exercise', 'executed-confirmed-completed', 'executed-confirmed-not-completed', 'executed-unconfirmed', 'claimed-outcome-unrecorded', 'resolved-confirmed-completed', 'resolved-confirmed-not-completed'],
  'not-executed': ['withheld-at-exercise', 'executed-confirmed-completed', 'executed-confirmed-not-completed', 'executed-unconfirmed', 'claimed-outcome-unrecorded', 'resolved-confirmed-completed', 'resolved-confirmed-not-completed'],
  // The write-ahead claim is recorded before the observation: the window between them is normal.
  'claimed-outcome-unrecorded': ['withheld-at-exercise', 'executed-confirmed-completed', 'executed-confirmed-not-completed', 'executed-unconfirmed', 'resolved-confirmed-completed', 'resolved-confirmed-not-completed'],
  'executed-unconfirmed': ['resolved-confirmed-completed', 'resolved-confirmed-not-completed'],
};

function summaryProgressed(before: DisclosedAuthorityTraceSummary, after: DisclosedAuthorityTraceSummary): boolean {
  if (before.path !== after.path) return false;
  if (before.finalState !== after.finalState && !(FINAL_STATE_SUCCESSORS[before.finalState] ?? []).includes(after.finalState)) return false;
  return AUTHORITY_TRACE_STAGE_NAMES.every((name) => {
    const was = before.presence?.[name];
    const now = after.presence?.[name];
    // The event stream is a best-effort projection that may lag: its `missing` is open.
    const open = OPEN_PRESENCE.has(String(was)) || (name === 'events' && was === 'missing');
    return was === now || (open && !BROKEN_PRESENCE.has(String(now)));
  });
}

export function compareDisclosedTraces(before: DisclosedAuthorityTrace, after: DisclosedAuthorityTrace): TraceComparisonResult {
  const stages: Partial<Record<AuthorityTraceStageName | 'summary' | 'identity', TraceComparison>> = {};
  const identityKeys = ['traceVersion', 'requestId', 'evaluationId', 'decisionId', 'executionId', 'organizationId'] as const;
  stages.identity = identityKeys.every((key) => before[key] === after[key]) ? 'matches' : 'contradicted';
  const names = new Set([...Object.keys(before.stages), ...Object.keys(after.stages)]) as Set<AuthorityTraceStageName>;
  for (const name of names) {
    const was = before.stages[name];
    const now = after.stages[name];
    if (canonical(was) === canonical(now)) stages[name] = 'matches';
    else if (was !== undefined && now !== undefined && stageProgressed(name, was, now)) stages[name] = 'progressed';
    else stages[name] = 'contradicted';
  }
  if (canonical(before.summary) === canonical(after.summary)) stages.summary = 'matches';
  else if (isRecord(before.summary) && isRecord(after.summary) && summaryProgressed(before.summary as unknown as DisclosedAuthorityTraceSummary, after.summary as unknown as DisclosedAuthorityTraceSummary)) stages.summary = 'progressed';
  else stages.summary = 'contradicted';
  const values = Object.values(stages);
  const result: TraceComparison = values.includes('contradicted') ? 'contradicted' : values.includes('progressed') ? 'progressed' : 'matches';
  return { result, stages };
}
