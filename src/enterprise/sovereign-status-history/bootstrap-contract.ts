import { createHash } from 'node:crypto';

/**
 * FV-P4C-2B1 — the contracts of trusted bootstrap for a sovereign status history.
 *
 * A bootstrap anchors a receiver's history on one signed status. It is the
 * single point where trust enters the history, so it is never implied:
 *
 * - **A status alone is not enough.** A valid signed status is only the
 *   object of a bootstrap, never its authorization (S1).
 * - **Separate checks.** The request's form, the operator's authority, the
 *   status's authenticity, the source's currentness and the history
 *   transition are distinct checks, each with its own closed reason.
 * - **Authority comes from outside.** It comes only from an injected
 *   authorizer that returns a decision bound to the exact request (S7). Nothing
 *   in the request (an `approved` flag, a role, an e-mail, a signature over
 *   the request itself) is ever read as authority.
 * - **Evidence is atomic.** Every committed bootstrap leaves one evidence
 *   record, written in the same SQLite transaction as the history it anchors.
 *
 * These are proposed contracts (versioned, closed, fail-closed), not an
 * operational workflow: nothing here exposes an endpoint, a CLI or a reset.
 */

export const STATUS_HISTORY_BOOTSTRAP_REQUEST_SCHEMA = 'frontera.sovereign-status-bootstrap/1' as const;
export const STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA = 'frontera.sovereign-status-bootstrap-evidence/1' as const;
/** The binding an authorizer decides on; its digest is what the decision must echo. */
export const STATUS_HISTORY_BOOTSTRAP_BINDING_SCHEMA = 'frontera.sovereign-status-bootstrap-binding/1' as const;

/** A bootstrap request may live at most this long, so an authorization cannot be stockpiled. */
export const STATUS_HISTORY_BOOTSTRAP_MAX_REQUEST_LIFETIME_SECONDS = 900;

/** `establish` anchors an empty history; `reanchor` re-anchors one that exists (never one with a conflict). */
export const STATUS_HISTORY_BOOTSTRAP_OPERATIONS = Object.freeze(['establish', 'reanchor'] as const);
export type StatusHistoryBootstrapOperation = (typeof STATUS_HISTORY_BOOTSTRAP_OPERATIONS)[number];

/** Controlled purposes; free text is never accepted as a reason. */
export const STATUS_HISTORY_BOOTSTRAP_PURPOSES = Object.freeze(['initial-trust-anchor', 'continuity-restoration'] as const);
export type StatusHistoryBootstrapPurpose = (typeof STATUS_HISTORY_BOOTSTRAP_PURPOSES)[number];

/**
 * Where the host learned that the status is current. Each class proves
 * something different; the host's policy decides which it accepts, and the
 * evidence records which was used.
 */
export const STATUS_SOURCE_CLASSES = Object.freeze([
  /** The registrant's own status channel: authentic, but the registrant can withhold a newer status. */
  'issuer-status-channel',
  /** A registry this receiver trusts: currentness only as good as the registry's own freshness. */
  'receiver-trusted-registry',
  /** An independent current-state witness answering a fresh challenge (FV-P4D; none exists yet). */
  'current-state-witness',
  /** A checkpoint this receiver anchored earlier: proves no regression below it, not currentness. */
  'anchored-checkpoint',
  /** A person's out-of-band verification: the weakest class, accepted only when policy names it. */
  'manual-out-of-band',
] as const);
export type StatusSourceClass = (typeof STATUS_SOURCE_CLASSES)[number];

export const STATUS_HISTORY_BOOTSTRAP_REASONS = Object.freeze([
  'ESTABLISHED',
  'REESTABLISHED',
  // The request
  'REQUEST_INVALID',
  'REQUEST_NOT_YET_VALID',
  'REQUEST_EXPIRED',
  'REQUEST_REPLAYED',
  'CONTEXT_INVALID',
  'NAMESPACE_MISMATCH',
  'SUBJECT_MISMATCH',
  // Authority
  'OPERATOR_UNAUTHORIZED',
  'AUTHORITY_BINDING_INVALID',
  'AUTHORITY_UNAVAILABLE',
  // The status
  'STATUS_REJECTED',
  'STATUS_MISMATCH',
  // The source
  'SOURCE_UNAVAILABLE',
  'SOURCE_UNTRUSTED',
  'SOURCE_STALE',
  'SOURCE_MISMATCH',
  'SOURCE_REPORTS_NEWER',
  'SOURCE_CONFLICT',
  // The history
  'HISTORY_REFUSED',
  'HISTORY_STORE_UNAVAILABLE',
  /** The receiver or the store reported a commit the store's own state does not confirm. */
  'COMMIT_UNVERIFIED',
  // Anything unexpected
  'BOOTSTRAP_ERROR',
] as const);
export type StatusHistoryBootstrapReason = (typeof STATUS_HISTORY_BOOTSTRAP_REASONS)[number];

export interface StatusReference {
  readonly sequence: number;
  readonly statusDigest: string;
}

export interface TermsReference {
  readonly claimId: string;
  readonly claimDigest: string;
}

/**
 * A request to anchor a history. It is a claim, not an authorization: every
 * field is checked against what the host itself verified, and its operator
 * reference names who asks, not who may.
 */
export interface StatusHistoryBootstrapRequest {
  readonly schemaVersion: typeof STATUS_HISTORY_BOOTSTRAP_REQUEST_SCHEMA;
  /** Unique per request; a request id is accepted at most once per history store. */
  readonly requestId: string;
  readonly operation: StatusHistoryBootstrapOperation;
  readonly purpose: StatusHistoryBootstrapPurpose;
  readonly namespace: string;
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly manifestDigest: string;
  readonly status: StatusReference;
  /** The terms the status names as current, or `null` when it names none. */
  readonly terms: TermsReference | null;
  /** Who asks. An identifier for the authorizer to authenticate, never a credential. */
  readonly operatorRef: string;
  /** Where the requester obtained the status. Informational; currentness comes from the source verifier. */
  readonly sourceRef: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Exactly what the authorizer decides on. Its canonical digest is what an
 * authorization must name, so a decision about any other request, history,
 * status or operator is worthless here.
 */
export interface StatusHistoryBootstrapBinding {
  readonly schemaVersion: typeof STATUS_HISTORY_BOOTSTRAP_BINDING_SCHEMA;
  readonly requestId: string;
  readonly operation: StatusHistoryBootstrapOperation;
  readonly purpose: StatusHistoryBootstrapPurpose;
  readonly namespace: string;
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly manifestDigest: string;
  readonly status: StatusReference;
  readonly terms: TermsReference | null;
  readonly operatorRef: string;
  readonly expiresAt: string;
}

/**
 * The host's authority over bootstraps. It must authenticate the operator
 * named in the binding and decide whether that operator may perform exactly
 * this operation. Any credential check, revocation or separation of duties
 * lives behind it. The only accepted answer is
 * `{ outcome: 'authorized', bindingDigest, authorityRef }` naming this
 * binding's digest; anything else, a throw included, refuses.
 */
export interface StatusHistoryBootstrapAuthorizer {
  authorizeStatusHistoryBootstrap(binding: StatusHistoryBootstrapBinding, bindingDigest: string): Promise<unknown>;
}

/** One source's statement about the status that is current for a history. */
export interface StatusSourceAttestation {
  readonly sourceClass: StatusSourceClass;
  /** An identifier of the source and its statement; never a URL with credentials or a key fragment. */
  readonly sourceRef: string;
  /** When the source observed the state, by the host's trusted clock. */
  readonly observedAt: string;
  /** The latest status the source knows for the history. */
  readonly status: StatusReference;
}

export interface StatusSourceQuery {
  readonly namespace: string;
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly status: StatusReference;
}

/**
 * The host's view of currentness. It returns one or more attestations; all
 * must be acceptable to the policy and must agree. A throw is "source
 * unavailable", never "no newer status".
 */
export interface StatusSourceVerifier {
  attestStatusSource(query: StatusSourceQuery): Promise<unknown>;
}

export interface StatusSourcePolicy {
  /** The source classes this receiver accepts for a bootstrap. `manual-out-of-band` only if named. */
  readonly acceptedSourceClasses: readonly StatusSourceClass[];
  /** How old an attestation may be at the bootstrap instant. 1–86 400 seconds. */
  readonly maxSourceAgeSeconds: number;
}

/**
 * The record a committed bootstrap leaves, in the same transaction as the
 * history it anchors. Unsigned: it is evidence the host recorded, not an
 * independent attestation, and its authority is only as good as the
 * authorizer that produced `authorityRef`.
 */
export interface StatusHistoryBootstrapEvidence {
  readonly schemaVersion: typeof STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA;
  readonly operationId: string;
  readonly requestId: string;
  readonly namespace: string;
  readonly sovereignAssetId: string;
  readonly issuer: string;
  readonly operation: StatusHistoryBootstrapOperation;
  readonly purpose: StatusHistoryBootstrapPurpose;
  readonly bindingDigest: string;
  readonly operatorRef: string;
  readonly authorityRef: string;
  readonly sources: readonly { readonly sourceClass: StatusSourceClass; readonly sourceRef: string; readonly observedAt: string }[];
  readonly status: StatusReference;
  readonly previous: { readonly revision: number; readonly sequence: number; readonly statusDigest: string } | null;
  readonly next: { readonly revision: number; readonly sequence: number; readonly statusDigest: string };
  readonly evaluationTime: string;
  readonly result: 'committed';
  readonly reason: 'ESTABLISHED' | 'REESTABLISHED';
  readonly classification: 'host-recorded-unsigned';
}

/** What the coordinator hands the store: the evidence before the store fills in `previous` and `next`. */
export type StatusHistoryBootstrapEvidenceDraft = Omit<StatusHistoryBootstrapEvidence, 'previous' | 'next' | 'reason'>;

const REQUEST_KEYS = [
  'schemaVersion',
  'requestId',
  'operation',
  'purpose',
  'namespace',
  'sovereignAssetId',
  'issuer',
  'manifestDigest',
  'status',
  'terms',
  'operatorRef',
  'sourceRef',
  'createdAt',
  'expiresAt',
] as const;

/** Parses an untrusted request: plain own data only, every field required, nothing else accepted. */
export function parseStatusHistoryBootstrapRequest(value: unknown): StatusHistoryBootstrapRequest | undefined {
  const fields = readPlain(value, REQUEST_KEYS, REQUEST_KEYS);
  if (fields === undefined) return undefined;
  const get = (key: (typeof REQUEST_KEYS)[number]) => fields.get(key);
  if (get('schemaVersion') !== STATUS_HISTORY_BOOTSTRAP_REQUEST_SCHEMA) return undefined;
  const operation = get('operation');
  const purpose = get('purpose');
  if (!STATUS_HISTORY_BOOTSTRAP_OPERATIONS.includes(operation as StatusHistoryBootstrapOperation)) return undefined;
  if (!STATUS_HISTORY_BOOTSTRAP_PURPOSES.includes(purpose as StatusHistoryBootstrapPurpose)) return undefined;
  // The purpose must fit the operation: no "initial trust" re-anchor, no "restoration" of nothing.
  if ((operation === 'establish') !== (purpose === 'initial-trust-anchor')) return undefined;
  for (const key of ['requestId', 'namespace', 'sovereignAssetId', 'issuer', 'operatorRef', 'sourceRef'] as const) {
    if (!isIdentifier(get(key), 512)) return undefined;
  }
  if (containsSecretMarker(get('sourceRef')) || containsSecretMarker(get('operatorRef'))) return undefined;
  if (!isDigest(get('manifestDigest'))) return undefined;
  const status = readStatusReference(get('status'));
  const terms = get('terms') === null ? null : readTermsReference(get('terms'));
  if (status === undefined || terms === undefined) return undefined;
  if (canonicalInstant(get('createdAt')) === undefined || canonicalInstant(get('expiresAt')) === undefined) return undefined;
  return {
    schemaVersion: STATUS_HISTORY_BOOTSTRAP_REQUEST_SCHEMA,
    requestId: get('requestId') as string,
    operation: operation as StatusHistoryBootstrapOperation,
    purpose: purpose as StatusHistoryBootstrapPurpose,
    namespace: get('namespace') as string,
    sovereignAssetId: get('sovereignAssetId') as string,
    issuer: get('issuer') as string,
    manifestDigest: get('manifestDigest') as string,
    status,
    terms,
    operatorRef: get('operatorRef') as string,
    sourceRef: get('sourceRef') as string,
    createdAt: get('createdAt') as string,
    expiresAt: get('expiresAt') as string,
  };
}

export function bootstrapBindingOf(request: StatusHistoryBootstrapRequest): StatusHistoryBootstrapBinding {
  return {
    schemaVersion: STATUS_HISTORY_BOOTSTRAP_BINDING_SCHEMA,
    requestId: request.requestId,
    operation: request.operation,
    purpose: request.purpose,
    namespace: request.namespace,
    sovereignAssetId: request.sovereignAssetId,
    issuer: request.issuer,
    manifestDigest: request.manifestDigest,
    status: { ...request.status },
    terms: request.terms === null ? null : { ...request.terms },
    operatorRef: request.operatorRef,
    expiresAt: request.expiresAt,
  };
}

/** Lowercase hex SHA-256 of the binding's sorted-key JSON (`aoc-canonical-json/1` rules for these value types). */
export function bootstrapBindingDigest(binding: StatusHistoryBootstrapBinding): string {
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

const EVIDENCE_KEYS = [
  'schemaVersion',
  'operationId',
  'requestId',
  'namespace',
  'sovereignAssetId',
  'issuer',
  'operation',
  'purpose',
  'bindingDigest',
  'operatorRef',
  'authorityRef',
  'sources',
  'status',
  'previous',
  'next',
  'evaluationTime',
  'result',
  'reason',
  'classification',
] as const;

/** Validates a stored evidence record completely; a record that does not validate is corruption. */
export function parseStatusHistoryBootstrapEvidence(value: unknown): StatusHistoryBootstrapEvidence | undefined {
  const fields = readPlain(value, EVIDENCE_KEYS, EVIDENCE_KEYS);
  if (fields === undefined) return undefined;
  const get = (key: (typeof EVIDENCE_KEYS)[number]) => fields.get(key);
  if (get('schemaVersion') !== STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA || get('result') !== 'committed' || get('classification') !== 'host-recorded-unsigned') return undefined;
  for (const key of ['operationId', 'requestId', 'namespace', 'sovereignAssetId', 'issuer', 'operatorRef', 'authorityRef'] as const) if (!isIdentifier(get(key), 512)) return undefined;
  const operation = get('operation');
  const reason = get('reason');
  if (!STATUS_HISTORY_BOOTSTRAP_OPERATIONS.includes(operation as StatusHistoryBootstrapOperation)) return undefined;
  if (!STATUS_HISTORY_BOOTSTRAP_PURPOSES.includes(get('purpose') as StatusHistoryBootstrapPurpose)) return undefined;
  if (reason !== (operation === 'establish' ? 'ESTABLISHED' : 'REESTABLISHED')) return undefined;
  if (!isDigest(get('bindingDigest')) || canonicalInstant(get('evaluationTime')) === undefined) return undefined;
  const sources = readSources(get('sources'));
  const status = readStatusReference(get('status'));
  const next = readRevisionReference(get('next'));
  const previous = get('previous') === null ? null : readRevisionReference(get('previous'));
  if (sources === undefined || status === undefined || next === undefined || previous === undefined) return undefined;
  if ((operation === 'establish') !== (previous === null)) return undefined;
  if (next.sequence !== status.sequence || next.statusDigest !== status.statusDigest) return undefined;
  if (previous !== null && (next.revision !== previous.revision + 1 || next.sequence < previous.sequence)) return undefined;
  if (previous === null && next.revision !== 1) return undefined;
  return {
    schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
    operationId: get('operationId') as string,
    requestId: get('requestId') as string,
    namespace: get('namespace') as string,
    sovereignAssetId: get('sovereignAssetId') as string,
    issuer: get('issuer') as string,
    operation: operation as StatusHistoryBootstrapOperation,
    purpose: get('purpose') as StatusHistoryBootstrapPurpose,
    bindingDigest: get('bindingDigest') as string,
    operatorRef: get('operatorRef') as string,
    authorityRef: get('authorityRef') as string,
    sources,
    status,
    previous,
    next,
    evaluationTime: get('evaluationTime') as string,
    result: 'committed',
    reason: reason as 'ESTABLISHED' | 'REESTABLISHED',
    classification: 'host-recorded-unsigned',
  };
}

export function serializeStatusHistoryBootstrapEvidence(evidence: StatusHistoryBootstrapEvidence): string {
  return canonicalJson(evidence);
}

// --------------------------------------------------------------------------
// Shared, module-internal readers (exported for the coordinator and the store only).

export function readSources(value: unknown): StatusHistoryBootstrapEvidence['sources'] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8 || Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
  const sources: Array<{ sourceClass: StatusSourceClass; sourceRef: string; observedAt: string }> = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    const fields = readPlain(descriptor.value, ['sourceClass', 'sourceRef', 'observedAt'], ['sourceClass', 'sourceRef', 'observedAt']);
    if (fields === undefined) return undefined;
    const sourceClass = fields.get('sourceClass');
    if (!STATUS_SOURCE_CLASSES.includes(sourceClass as StatusSourceClass) || !isIdentifier(fields.get('sourceRef'), 512) || containsSecretMarker(fields.get('sourceRef'))) return undefined;
    if (canonicalInstant(fields.get('observedAt')) === undefined) return undefined;
    sources.push({ sourceClass: sourceClass as StatusSourceClass, sourceRef: fields.get('sourceRef') as string, observedAt: fields.get('observedAt') as string });
  }
  return sources;
}

export function readStatusReference(value: unknown): StatusReference | undefined {
  const fields = readPlain(value, ['sequence', 'statusDigest'], ['sequence', 'statusDigest']);
  if (fields === undefined) return undefined;
  const sequence = fields.get('sequence');
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || !isDigest(fields.get('statusDigest'))) return undefined;
  return { sequence, statusDigest: fields.get('statusDigest') as string };
}

function readRevisionReference(value: unknown): { revision: number; sequence: number; statusDigest: string } | undefined {
  const fields = readPlain(value, ['revision', 'sequence', 'statusDigest'], ['revision', 'sequence', 'statusDigest']);
  if (fields === undefined) return undefined;
  const revision = fields.get('revision');
  const status = readStatusReference({ sequence: fields.get('sequence'), statusDigest: fields.get('statusDigest') });
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || status === undefined) return undefined;
  return { revision, ...status };
}

function readTermsReference(value: unknown): TermsReference | undefined {
  const fields = readPlain(value, ['claimId', 'claimDigest'], ['claimId', 'claimDigest']);
  if (fields === undefined || !isIdentifier(fields.get('claimId'), 512) || !isDigest(fields.get('claimDigest'))) return undefined;
  return { claimId: fields.get('claimId') as string, claimDigest: fields.get('claimDigest') as string };
}

/**
 * Reads a plain object's own data properties once. Refuses non-plain objects,
 * accessors, symbol keys, unknown keys and missing required keys, so a getter
 * never runs and an injected or inherited field is never honoured.
 */
export function readPlain(value: unknown, allowed: readonly string[], required: readonly string[]): Map<string, unknown> | undefined {
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

export function isIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value && value.length <= maxLength && !/[\u0000-\u001f]/.test(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Refuses references that carry a decryption fragment or credentials: they must never become evidence. */
function containsSecretMarker(value: unknown): boolean {
  return typeof value === 'string' && /#key=|[?&](?:token|key|secret|signature|access_token)=|\/\/[^/\s]*:[^/\s]*@/i.test(value);
}

/** Sorted-key JSON for plain objects, arrays, strings, safe integers, booleans and null. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** A canonical UTC timestamp as nanoseconds since the epoch, or `undefined`. No Date, no millisecond rounding. */
export function canonicalInstant(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day < 1 || day > days) return undefined;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const civil = era * 146_097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719_468;
  return (BigInt(civil) * 86_400n + BigInt(hour * 3600 + minute * 60 + second)) * 1_000_000_000n + BigInt((match[7] ?? '').padEnd(9, '0'));
}
