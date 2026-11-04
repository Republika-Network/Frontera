import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { decodeAuthoritySignatureBytes, isWellFormedAuthoritySignature } from '../authority-authenticity/signature-envelope.js';
import { canonicalizeConformance, conformanceDigest, snapshotPlainJson } from './canonical.js';
import { CREDENTIAL_STATES, MAX_COVERED_OPERATIONS, MAX_DECLARED_EXCLUSIONS, SYNTHETIC_DESIGNATION, isDigest, isIdentifier, isSemver, isTimestamp, readClosed, toMs, type CredentialState } from './contracts.js';

/**
 * RN-CONFORM-03 / WP-01 — the signed credential status assertion
 * (`ConformanceStatusAssertionV1`, INTEGRATION_CONTRACTS.md §5) and the signed
 * refusal returned for a recognized request that cannot be answered with the
 * credential's state (subject or profile mismatch, unknown credential, reused
 * nonce).
 *
 * Both are closed schemas over `aoc-canonical-json/1` (CC-D-01). The signed
 * payload is the artifact **without** its `signature` member; signing bytes are
 * `frontera:conformance-status:v1\n ‖ canonical(payload)` (refusals:
 * `frontera:conformance-status-refusal:v1\n`). The CORE-02 envelope is reused:
 * `ed25519-v1`, `aoc.authority-artifact.v1`, `keyId = sha256(SPKI DER)`. There
 * is no field for a public key: a key carried in an assertion is an unknown
 * field, never a trust root.
 *
 * SYNTHETIC: every artifact carries `designation: SYNTHETIC-NON-PRODUCTION`.
 * Deviations from the RN-CONFORM-01 sketch are recorded in
 * RN_CONFORM_03_IMPLEMENTATION.md §3.
 */

export const STATUS_ASSERTION_SCHEMA = 'rn.conformance.status/1' as const;
export const STATUS_ASSERTION_PURPOSE = 'rn.conformance.status.assertion' as const;
export const STATUS_REFUSAL_SCHEMA = 'rn.conformance.status-refusal/1' as const;
export const STATUS_REFUSAL_PURPOSE = 'rn.conformance.status.refusal' as const;

/** CC-D-05 (provisional, synthetic only): no status artifact is valid for longer than 15 minutes. */
export const MAX_STATUS_ASSERTION_LIFETIME_MS = 15 * 60 * 1000;
/** Supported clock tolerance (STATUS_VERIFICATION.md §4: ± 5 s). It only tolerates an early `issuedAt`; it never extends `validUntil`. */
export const STATUS_CLOCK_SKEW_MS = 5_000;
/** A serialized status artifact is at most this many bytes. */
export const MAX_STATUS_ARTIFACT_BYTES = 32 * 1024;
/** Online nonces: base64url, 22–86 characters (≥ 128 bits, ≤ 512 bits). */
export const STATUS_NONCE = /^[A-Za-z0-9_-]{22,86}$/;

export const EVIDENCE_FRESHNESS_STATUSES = Object.freeze(['FRESH', 'STALE', 'INCOMPLETE', 'UNDER_INVESTIGATION', 'PROTECTIVE_ACTION_PENDING', 'EVIDENCE_TAMPERED'] as const);
export type EvidenceFreshnessStatus = (typeof EVIDENCE_FRESHNESS_STATUSES)[number];

export const STATUS_REFUSAL_RESULTS = Object.freeze(['UNKNOWN_CREDENTIAL', 'SUBJECT_MISMATCH', 'PROFILE_MISMATCH', 'NONCE_REUSED'] as const);
export type StatusRefusalResult = (typeof STATUS_REFUSAL_RESULTS)[number];

export interface StatusAssertionPayload {
  readonly schema: typeof STATUS_ASSERTION_SCHEMA;
  readonly purpose: typeof STATUS_ASSERTION_PURPOSE;
  readonly issuer: string;
  readonly credentialId: string;
  readonly subject: { readonly platformId: string; readonly organizationId: string; readonly integrationId: string; readonly integrationVersion: number; readonly integrationDigest: string };
  readonly scope: { readonly coveredOperations: readonly string[]; readonly declaredExclusions: readonly string[] };
  readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
  readonly sdk: { readonly package: string; readonly version: string };
  readonly adapter: { readonly name: string; readonly version: string };
  readonly state: CredentialState;
  readonly stateVersion: number;
  readonly reasonCode: string | null;
  readonly effectiveAt: string;
  readonly lastSuccessfulVerificationAt: string | null;
  readonly evidenceFreshness: { readonly status: EvidenceFreshnessStatus; readonly oldestRequiredEvidenceAt: string | null; readonly freshUntil: string | null };
  readonly credentialValidUntil: string;
  readonly historyRef: { readonly latestTransitionDigest: string; readonly transitionsUrlPath: string };
  /** Confirmed ledger anchors only. Empty in RN-CONFORM-03: a *prepared* anchor intent is never an anchor (WP-11). */
  readonly anchors: readonly never[];
  readonly sequence: number;
  readonly previousAssertionDigest: string | null;
  /** The verifier's nonce, echoed in online mode; `null` for a stapled assertion. */
  readonly requestNonce: string | null;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly designation: typeof SYNTHETIC_DESIGNATION;
}

export interface StatusAssertion extends StatusAssertionPayload {
  readonly signature: AuthoritySignature;
}

export interface StatusRefusalPayload {
  readonly schema: typeof STATUS_REFUSAL_SCHEMA;
  readonly purpose: typeof STATUS_REFUSAL_PURPOSE;
  readonly issuer: string;
  /** What the request named — never anything about another organization's credential. */
  readonly requestedCredentialId: string;
  readonly requestNonce: string;
  readonly result: StatusRefusalResult;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly designation: typeof SYNTHETIC_DESIGNATION;
}

export interface StatusRefusal extends StatusRefusalPayload {
  readonly signature: AuthoritySignature;
}

const OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;
const TRANSITIONS_PATH = /^\/conformance\/v1\/credentials\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/transitions$/;

export function transitionsUrlPath(credentialId: string): string {
  return `/conformance/v1/credentials/${credentialId}/transitions`;
}

const isNullableTimestamp = (v: unknown) => v === null || isTimestamp(v);
/** A sorted, duplicate-free list of operation names of at most `max` entries. The bounds are the admission bounds (`contracts.ts`). */
const isOperationList = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((o) => typeof o === 'string' && OPERATION.test(o)) && new Set(v).size === v.length && [...v].sort().every((o, i) => o === v[i]);
const sub = (value: unknown, keys: readonly string[]) => {
  const read = readClosed(value, keys);
  return read.ok ? read.record : undefined;
};

export type StatusParseFailure = 'TOO_LARGE' | 'MALFORMED_JSON' | 'NOT_CANONICAL' | 'UNKNOWN_SCHEMA' | 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'MALFORMED_FIELD' | 'WRONG_PURPOSE' | 'SIGNATURE_MISSING';

export type ParsedStatusArtifact =
  | { readonly ok: true; readonly kind: 'assertion'; readonly artifact: StatusAssertion; readonly payload: StatusAssertionPayload }
  | { readonly ok: true; readonly kind: 'refusal'; readonly artifact: StatusRefusal; readonly payload: StatusRefusalPayload }
  | { readonly ok: false; readonly reason: StatusParseFailure; readonly field?: string };

const ASSERTION_FIELDS = [
  'schema', 'purpose', 'issuer', 'credentialId', 'subject', 'scope', 'profile', 'sdk', 'adapter', 'state', 'stateVersion', 'reasonCode', 'effectiveAt',
  'lastSuccessfulVerificationAt', 'evidenceFreshness', 'credentialValidUntil', 'historyRef', 'anchors', 'sequence', 'previousAssertionDigest', 'requestNonce',
  'issuedAt', 'validUntil', 'designation', 'signature',
] as const;
const REFUSAL_FIELDS = ['schema', 'purpose', 'issuer', 'requestedCredentialId', 'requestNonce', 'result', 'issuedAt', 'validUntil', 'designation', 'signature'] as const;

function checkAssertion(o: { readonly [key: string]: unknown }): string | null {
  const subject = sub(o['subject'], ['platformId', 'organizationId', 'integrationId', 'integrationVersion', 'integrationDigest']);
  if (subject === undefined || !isIdentifier(subject['platformId']) || !isIdentifier(subject['organizationId']) || !isIdentifier(subject['integrationId'])) return 'subject';
  if (!Number.isSafeInteger(subject['integrationVersion']) || (subject['integrationVersion'] as number) < 1 || !isDigest(subject['integrationDigest'])) return 'subject';
  const scope = sub(o['scope'], ['coveredOperations', 'declaredExclusions']);
  if (scope === undefined || !isOperationList(scope['coveredOperations'], MAX_COVERED_OPERATIONS) || (scope['coveredOperations'] as unknown[]).length === 0 || !isOperationList(scope['declaredExclusions'], MAX_DECLARED_EXCLUSIONS)) {
    return 'scope';
  }
  const profile = sub(o['profile'], ['id', 'version', 'digest']);
  if (profile === undefined || !isIdentifier(profile['id']) || !isSemver(profile['version']) || !isDigest(profile['digest'])) return 'profile';
  const sdk = sub(o['sdk'], ['package', 'version']);
  if (sdk === undefined || typeof sdk['package'] !== 'string' || sdk['package'].length === 0 || sdk['package'].length > 214 || !isSemver(sdk['version'])) return 'sdk';
  const adapter = sub(o['adapter'], ['name', 'version']);
  if (adapter === undefined || !isIdentifier(adapter['name']) || !isSemver(adapter['version'])) return 'adapter';
  if (typeof o['state'] !== 'string' || !(CREDENTIAL_STATES as readonly string[]).includes(o['state'])) return 'state';
  if (!Number.isSafeInteger(o['stateVersion']) || (o['stateVersion'] as number) < 1) return 'stateVersion';
  if (!(o['reasonCode'] === null || isIdentifier(o['reasonCode']))) return 'reasonCode';
  if (!isTimestamp(o['effectiveAt'])) return 'effectiveAt';
  if (!isNullableTimestamp(o['lastSuccessfulVerificationAt'])) return 'lastSuccessfulVerificationAt';
  const fresh = sub(o['evidenceFreshness'], ['status', 'oldestRequiredEvidenceAt', 'freshUntil']);
  if (fresh === undefined || typeof fresh['status'] !== 'string' || !(EVIDENCE_FRESHNESS_STATUSES as readonly string[]).includes(fresh['status'])) return 'evidenceFreshness';
  if (!isNullableTimestamp(fresh['oldestRequiredEvidenceAt']) || !isNullableTimestamp(fresh['freshUntil'])) return 'evidenceFreshness';
  if (fresh['status'] === 'FRESH' && (fresh['freshUntil'] === null || fresh['oldestRequiredEvidenceAt'] === null)) return 'evidenceFreshness';
  if (!isTimestamp(o['credentialValidUntil'])) return 'credentialValidUntil';
  const history = sub(o['historyRef'], ['latestTransitionDigest', 'transitionsUrlPath']);
  if (history === undefined || !isDigest(history['latestTransitionDigest']) || typeof history['transitionsUrlPath'] !== 'string' || !TRANSITIONS_PATH.test(history['transitionsUrlPath'])) return 'historyRef';
  if (history['transitionsUrlPath'] !== transitionsUrlPath(String(o['credentialId']))) return 'historyRef';
  if (!Array.isArray(o['anchors']) || o['anchors'].length !== 0) return 'anchors';
  if (!Number.isSafeInteger(o['sequence']) || (o['sequence'] as number) < 1) return 'sequence';
  const previous = o['previousAssertionDigest'];
  if ((o['sequence'] === 1) !== (previous === null) || !(previous === null || isDigest(previous))) return 'previousAssertionDigest';
  if (!(o['requestNonce'] === null || (typeof o['requestNonce'] === 'string' && STATUS_NONCE.test(o['requestNonce'])))) return 'requestNonce';
  return null;
}

/**
 * Parses one serialized status artifact. Input is the exact text (bounded); it must be the canonical
 * serialization of what it parses to, so there is exactly one byte representation of each artifact.
 * Never throws.
 */
export function parseStatusArtifact(text: unknown): ParsedStatusArtifact {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STATUS_ARTIFACT_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    let value: unknown;
    try {
      value = snapshotPlainJson(JSON.parse(text));
    } catch {
      return { ok: false, reason: 'MALFORMED_JSON' };
    }
    if (canonicalizeConformance(value) !== text) return { ok: false, reason: 'NOT_CANONICAL' };
    const schema = typeof value === 'object' && value !== null ? (value as { schema?: unknown }).schema : undefined;
    const isAssertion = schema === STATUS_ASSERTION_SCHEMA;
    if (!isAssertion && schema !== STATUS_REFUSAL_SCHEMA) return { ok: false, reason: 'UNKNOWN_SCHEMA' };
    if (typeof value === 'object' && value !== null && !Object.prototype.hasOwnProperty.call(value, 'signature')) return { ok: false, reason: 'SIGNATURE_MISSING' };
    const read = readClosed(value, isAssertion ? ASSERTION_FIELDS : REFUSAL_FIELDS);
    if (!read.ok) return { ok: false, reason: read.reason, field: read.field };
    const o = read.record;
    if (o['purpose'] !== (isAssertion ? STATUS_ASSERTION_PURPOSE : STATUS_REFUSAL_PURPOSE)) return { ok: false, reason: 'WRONG_PURPOSE' };
    if (!isIdentifier(o['issuer']) || o['designation'] !== SYNTHETIC_DESIGNATION || !isTimestamp(o['issuedAt']) || !isTimestamp(o['validUntil'])) return { ok: false, reason: 'MALFORMED_FIELD', field: 'header' };
    // A closed envelope: exactly these four members, a derived key id, and a signature of exactly the algorithm's width.
    const envelope = readClosed(o['signature'], ['algorithm', 'keyId', 'signature', 'artifactVersion']);
    if (!envelope.ok || !isWellFormedAuthoritySignature(o['signature']) || !isDigest(envelope.record['keyId']) || decodeAuthoritySignatureBytes(String(envelope.record['signature']), 'ed25519-v1') === undefined || envelope.record['algorithm'] !== 'ed25519-v1') {
      return { ok: false, reason: 'MALFORMED_FIELD', field: 'signature' };
    }
    const { signature: _signature, ...payload } = o;
    if (isAssertion) {
      if (!isIdentifier(o['credentialId'])) return { ok: false, reason: 'MALFORMED_FIELD', field: 'credentialId' };
      const bad = checkAssertion(o);
      if (bad !== null) return { ok: false, reason: 'MALFORMED_FIELD', field: bad };
      return { ok: true, kind: 'assertion', artifact: o as unknown as StatusAssertion, payload: payload as unknown as StatusAssertionPayload };
    }
    if (!isIdentifier(o['requestedCredentialId']) || typeof o['requestNonce'] !== 'string' || !STATUS_NONCE.test(o['requestNonce'])) return { ok: false, reason: 'MALFORMED_FIELD', field: 'request' };
    if (typeof o['result'] !== 'string' || !(STATUS_REFUSAL_RESULTS as readonly string[]).includes(o['result'])) return { ok: false, reason: 'MALFORMED_FIELD', field: 'result' };
    return { ok: true, kind: 'refusal', artifact: o as unknown as StatusRefusal, payload: payload as unknown as StatusRefusalPayload };
  } catch {
    return { ok: false, reason: 'MALFORMED_JSON' };
  }
}

/** The validity interval rule shared by issuer and verifier: `0 < validUntil − issuedAt ≤ 15 min`. */
export function hasValidLifetime(issuedAt: string, validUntil: string): boolean {
  const lifetime = toMs(validUntil) - toMs(issuedAt);
  return Number.isFinite(lifetime) && lifetime > 0 && lifetime <= MAX_STATUS_ASSERTION_LIFETIME_MS;
}

/** The digest that links assertions: over the complete signed artifact (payload and signature). */
export function statusArtifactDigest(artifact: StatusAssertion | StatusRefusal): string {
  return conformanceDigest(artifact);
}

/** The canonical serialization a status artifact is transmitted and stored as. */
export function serializeStatusArtifact(artifact: StatusAssertion | StatusRefusal): string {
  return canonicalizeConformance(artifact);
}
