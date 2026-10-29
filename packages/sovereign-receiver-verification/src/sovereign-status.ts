import { isValidSovereignAssetId } from '@aoc/protocol/identity';
import { deriveSovereignKeyId, verifySovereignSignature } from '@aoc/protocol/manifest';
import type { SovereignProof } from '@aoc/protocol/manifest';

import type { ReceiverVerificationKeyResolver } from './types.js';
import {
  SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS,
  SOVEREIGN_STATUS_PROFILE,
  SOVEREIGN_STATUS_PURPOSE,
  SOVEREIGN_STATUS_VERIFIER,
} from './sovereign-status-types.js';
import type {
  SovereignStatusPayloadV1,
  SovereignStatusRejected,
  SovereignStatusRejectionReason,
  SovereignStatusTermsReference,
  SovereignStatusVerificationResult,
  SovereignStatusVerified,
} from './sovereign-status-types.js';

/**
 * FV-P4B — strict verification of one `soberania.sovereign-status/1` artifact.
 *
 * A status is a registrant-signed statement about an asset: whether it is
 * `active` or `withdrawn`, which manifest and which terms the registrant
 * declares current, and where the statement sits in the registrant's sequence.
 * This verifier checks that the presented statement is authentic, signed by
 * the expected registrant's trusted key, well formed, bound to what the host
 * expects and inside its own validity window. It cannot tell whether a newer
 * statement exists: a correctly signed status that a later one revoked still
 * verifies here until its `validUntil`. History, replay and freshness belong
 * to FV-P4C.
 *
 * Signatures are Protocol's own (`signSovereignPayload` / `verifySovereignSignature`
 * from rc.3). That proof signs the canonical payload with no external domain
 * prefix, so domain separation rests on the payload: the exact `schemaVersion`
 * and `purpose`, and an exact-keys schema that no manifest or claim satisfies.
 *
 * Deterministic: no clock, environment, network, storage or credentials. Its
 * only call out is the host's key resolver, at most once. Never throws; every
 * failure is one closed reason.
 */

/** A generous bound for one status (its PEM key dominates); larger input is refused before parsing. */
const MAX_SIGNED_STATUS_LENGTH = 16_384;

const ENVELOPE_KEYS = ['proof', 'status'] as const;
const STATUS_KEYS = [
  'assetStatus',
  'currentTerms',
  'issuedAt',
  'issuer',
  'manifestDigest',
  'previousStatusDigest',
  'purpose',
  'schemaVersion',
  'sequence',
  'sovereignAssetId',
  'validUntil',
] as const;
const TERMS_KEYS = ['claimDigest', 'claimId'] as const;
const PROOF_KEYS = ['algorithm', 'canonicalizationProfile', 'keyId', 'payloadHash', 'publicKey', 'signature', 'signedAt'] as const;
const CONTEXT_KEYS = ['verificationKeyResolver', 'expectedSovereignAssetId', 'expectedRegistrant', 'expectedManifestDigest', 'expectedTerms', 'evaluationTime'] as const;
const REQUIRED_CONTEXT_KEYS = CONTEXT_KEYS.filter((key) => key !== 'expectedTerms');

/** Lowercase hex SHA-256, unprefixed: Protocol's manifest digest, claim digest, payload hash and key id. */
const DIGEST = /^[0-9a-f]{64}$/;
/**
 * An Ed25519 signature as Node renders it: 64 bytes, unpadded base64url. The
 * last character carries two bits, so only A, Q, g or w are canonical; any
 * other spelling of the same bytes is refused rather than silently accepted.
 */
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
/** `aoc-canonical-json/1` timestamps, as Protocol's `isCanonicalTimestamp` accepts them. */
const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const NANOS_PER_SECOND = 1_000_000_000n;
const MAX_VALIDITY_NANOS = BigInt(SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS) * NANOS_PER_SECOND;

interface Context {
  readonly resolver: ReceiverVerificationKeyResolver;
  readonly expectedSovereignAssetId: string;
  readonly expectedRegistrant: string;
  readonly expectedManifestDigest: string;
  readonly expectedTerms: SovereignStatusTermsReference | undefined;
  readonly evaluationTime: string;
  readonly now: bigint;
}

interface Parsed {
  readonly status: SovereignStatusPayloadV1;
  readonly proof: SovereignProof;
  readonly issuedAt: bigint;
  readonly validUntil: bigint;
}

type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: SovereignStatusRejectionReason };

export async function verifySovereignStatus(signedStatusText: unknown, trustedContext: unknown): Promise<SovereignStatusVerificationResult> {
  try {
    return await verify(signedStatusText, trustedContext);
  } catch {
    return rejected('STATUS_INTERNAL_ERROR');
  }
}

async function verify(signedStatusText: unknown, rawContext: unknown): Promise<SovereignStatusVerificationResult> {
  // 1. The host's context, read once. Nothing expected comes from the status.
  const context = readContext(rawContext);
  if (!context.ok) return rejected(context.reason);
  const { resolver, expectedRegistrant, now } = context.value;

  // 2. Form: exact schema, purpose and keys, well-formed values, one byte representation.
  const parsed = parseSignedStatus(signedStatusText);
  if (!parsed.ok) return rejected(parsed.reason);
  const { status, proof } = parsed.value;

  // 3. Integrity: Protocol recomputes the payload hash and checks the Ed25519 signature over it.
  if (!verifySovereignSignature(status, proof)) return rejected('STATUS_SIGNATURE_INVALID');

  // 4. Authority. Only the verified registrant may sign its asset's status, and
  //    no other principal is ever looked up: a key that is trusted for someone
  //    else, or that the status merely carries, is never enough.
  if (status.issuer !== expectedRegistrant) return rejected('STATUS_ISSUER_UNAUTHORIZED');
  let descriptor: unknown;
  try {
    descriptor = await resolver.resolveVerificationKey(expectedRegistrant);
  } catch {
    return rejected('KEY_RESOLVER_FAILED');
  }
  const binding = bindKey(proof, expectedRegistrant, descriptor);
  if (binding !== undefined) return rejected(binding);

  // 5. Binding to what the host verified. A different reference means only that
  //    this status is not about the evaluated asset, manifest or terms; without
  //    a trusted history it does not show which of them is globally current.
  if (status.sovereignAssetId !== context.value.expectedSovereignAssetId) return rejected('STATUS_SUBJECT_MISMATCH');
  if (status.manifestDigest !== context.value.expectedManifestDigest) return rejected('MANIFEST_BINDING_MISMATCH');
  const { expectedTerms } = context.value;
  if (expectedTerms !== undefined) {
    const current = status.currentTerms;
    if (current === null || current.claimId !== expectedTerms.claimId || current.claimDigest !== expectedTerms.claimDigest) {
      return rejected('TERMS_BINDING_MISMATCH');
    }
  }

  // 6. The status's own window: issuedAt <= now < validUntil, exactly, with no grace.
  if (now < parsed.value.issuedAt) return rejected('STATUS_FROM_FUTURE');
  if (now >= parsed.value.validUntil) return rejected('STATUS_EXPIRED');

  const verified: SovereignStatusVerified = {
    outcome: 'authentic_authorized',
    verifier: SOVEREIGN_STATUS_VERIFIER,
    statusProfile: SOVEREIGN_STATUS_PROFILE,
    sovereignAssetId: status.sovereignAssetId,
    issuer: status.issuer,
    keyId: proof.keyId,
    manifestDigest: status.manifestDigest,
    assetStatus: status.assetStatus,
    currentTerms: status.currentTerms === null ? null : { claimId: status.currentTerms.claimId, claimDigest: status.currentTerms.claimDigest },
    termsBinding: expectedTerms === undefined ? 'not_requested' : 'matches_expected',
    sequence: status.sequence,
    previousStatusDigest: status.previousStatusDigest,
    statusDigest: proof.payloadHash,
    issuedAt: status.issuedAt,
    validUntil: status.validUntil,
    evaluationTime: context.value.evaluationTime,
    temporalValidity: 'within_validity_window',
    freshness: 'not_evaluated',
    revocationCurrentness: 'not_evaluated',
    authorization: 'not_evaluated',
    execution: 'not_performed',
  };
  return deepFreeze(verified);
}

/**
 * Issuer-key binding with the same invariants, in the same order, as
 * Protocol's private `bindIssuerKey` (SOBE-SEC-01), built from public rc.3
 * APIs only. One deliberate difference: a descriptor carrying `publicKeyJwk`
 * is refused, because Protocol's JWK comparison is not exported and this
 * package may not import `node:crypto`; skipping that comparison would
 * weaken the binding. Descriptor `validFrom`/`validUntil` are not evaluated,
 * exactly as in Protocol.
 */
function bindKey(proof: SovereignProof, issuer: string, descriptor: unknown): SovereignStatusRejectionReason | undefined {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) return 'STATUS_KEY_UNTRUSTED';
  // Each descriptor field is read once, like Protocol's.
  const keyId = readOnce(descriptor, 'keyId');
  const descriptorIssuer = readOnce(descriptor, 'issuer');
  const algorithm = readOnce(descriptor, 'algorithm');
  const jwk = readOnce(descriptor, 'publicKeyJwk');
  if (typeof keyId !== 'string' || keyId.trim() === '') return 'STATUS_KEY_UNTRUSTED';
  if (descriptorIssuer !== issuer) return 'STATUS_KEY_UNTRUSTED';
  if (algorithm !== undefined && (typeof algorithm !== 'string' || algorithm.toLowerCase() !== 'ed25519')) return 'STATUS_KEY_BINDING_INVALID';
  if (proof.keyId !== deriveSovereignKeyId(proof.publicKey)) return 'STATUS_KEY_BINDING_INVALID';
  if (keyId !== proof.keyId) return 'STATUS_KEY_UNTRUSTED';
  if (jwk !== undefined) return 'STATUS_KEY_BINDING_INVALID';
  return undefined;
}

function readOnce(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Parses the artifact text and validates it completely before any
 * cryptography. JSON text has no accessors or custom prototypes, and the text
 * must equal the `aoc-canonical-json/1` serialization of what it parses to:
 * duplicate keys, whitespace, escape variants and alternative number spellings
 * are refused, so the same status has exactly one byte representation.
 */
function parseSignedStatus(text: unknown): Step<Parsed> {
  const malformed = { ok: false, reason: 'STATUS_MALFORMED' } as const;
  if (typeof text !== 'string' || text.length > MAX_SIGNED_STATUS_LENGTH) return malformed;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return malformed;
  }

  const envelope = readPlain(value, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (envelope === undefined) return malformed;
  const rawStatus = envelope.get('status');
  if (!isPlainObject(rawStatus)) return malformed;
  // Schema and purpose first: a manifest or claim presented as a status is
  // refused as the wrong kind of artifact, before its shape is examined.
  if (ownValue(rawStatus, 'schemaVersion') !== SOVEREIGN_STATUS_PROFILE) return { ok: false, reason: 'STATUS_SCHEMA_UNSUPPORTED' };
  if (ownValue(rawStatus, 'purpose') !== SOVEREIGN_STATUS_PURPOSE) return { ok: false, reason: 'STATUS_PURPOSE_INVALID' };

  const fields = readPlain(rawStatus, STATUS_KEYS, STATUS_KEYS);
  if (fields === undefined) return malformed;
  const sovereignAssetId = fields.get('sovereignAssetId');
  const issuer = fields.get('issuer');
  const manifestDigest = fields.get('manifestDigest');
  const assetStatus = fields.get('assetStatus');
  const sequence = fields.get('sequence');
  const previousStatusDigest = fields.get('previousStatusDigest');
  if (!isValidSovereignAssetId(sovereignAssetId) || !isIdentifier(issuer) || !isDigest(manifestDigest)) return malformed;
  if (assetStatus !== 'active' && assetStatus !== 'withdrawn') return malformed;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return malformed;
  // The chain link is declarative: present exactly when there is a predecessor.
  if (sequence === 1 ? previousStatusDigest !== null : !isDigest(previousStatusDigest)) return malformed;

  const currentTerms = readTerms(fields.get('currentTerms'));
  if (currentTerms === undefined) return malformed;
  // A withdrawn asset has no terms in effect; a status saying otherwise is ambiguous.
  if (assetStatus === 'withdrawn' && currentTerms !== null) return malformed;

  const proof = readProof(envelope.get('proof'));
  if (proof === undefined) return malformed;

  const issuedAtText = fields.get('issuedAt');
  const validUntilText = fields.get('validUntil');
  const issuedAt = instant(issuedAtText);
  const validUntil = instant(validUntilText);
  if (issuedAt === undefined || validUntil === undefined || issuedAt >= validUntil) return { ok: false, reason: 'STATUS_TIME_INVALID' };
  if (validUntil - issuedAt > MAX_VALIDITY_NANOS) return { ok: false, reason: 'STATUS_VALIDITY_TOO_LONG' };

  if (canonicalJson(value) !== text) return { ok: false, reason: 'STATUS_NOT_CANONICAL' };

  const status: SovereignStatusPayloadV1 = {
    schemaVersion: SOVEREIGN_STATUS_PROFILE,
    purpose: SOVEREIGN_STATUS_PURPOSE,
    sovereignAssetId,
    issuer,
    manifestDigest,
    assetStatus,
    currentTerms,
    sequence,
    previousStatusDigest: previousStatusDigest as string | null,
    issuedAt: issuedAtText as string,
    validUntil: validUntilText as string,
  };
  return { ok: true, value: { status, proof, issuedAt, validUntil } };
}

function readTerms(value: unknown): SovereignStatusTermsReference | null | undefined {
  if (value === null) return null;
  const fields = readPlain(value, TERMS_KEYS, TERMS_KEYS);
  if (fields === undefined) return undefined;
  const claimId = fields.get('claimId');
  const claimDigest = fields.get('claimDigest');
  return isIdentifier(claimId) && isDigest(claimDigest) ? { claimId, claimDigest } : undefined;
}

/** Protocol's proof, field for field. `signedAt` is not covered by the signature and is never relied on. */
function readProof(value: unknown): SovereignProof | undefined {
  const fields = readPlain(value, PROOF_KEYS, PROOF_KEYS);
  if (fields === undefined) return undefined;
  for (const key of PROOF_KEYS) if (typeof fields.get(key) !== 'string') return undefined;
  const text = (key: (typeof PROOF_KEYS)[number]) => fields.get(key) as string;
  if (text('algorithm') !== 'ed25519' || text('canonicalizationProfile') !== 'aoc-canonical-json/1') return undefined;
  if (!isDigest(text('keyId')) || !isDigest(text('payloadHash')) || !SIGNATURE.test(text('signature'))) return undefined;
  if (instant(text('signedAt')) === undefined || text('publicKey') === '') return undefined;
  return {
    algorithm: 'ed25519',
    canonicalizationProfile: 'aoc-canonical-json/1',
    keyId: text('keyId'),
    publicKey: text('publicKey'),
    signature: text('signature'),
    signedAt: text('signedAt'),
    payloadHash: text('payloadHash'),
  };
}

/**
 * Reads the host's context once, as plain own data. Accessors, inherited
 * fields, unknown keys and missing required keys are refused, so a getter never
 * runs and no injected field is honoured. The resolver's function is read once
 * and bound.
 */
function readContext(raw: unknown): Step<Context> {
  const invalid = { ok: false, reason: 'CONTEXT_INVALID' } as const;
  const fields = readPlain(raw, CONTEXT_KEYS, REQUIRED_CONTEXT_KEYS);
  if (fields === undefined) return invalid;

  const resolverObject = fields.get('verificationKeyResolver');
  if (typeof resolverObject !== 'object' || resolverObject === null) return invalid;
  let resolve: unknown;
  try {
    resolve = Reflect.get(resolverObject, 'resolveVerificationKey');
  } catch {
    return invalid;
  }
  if (typeof resolve !== 'function') return invalid;
  const bound = resolve as ReceiverVerificationKeyResolver['resolveVerificationKey'];
  const resolver: ReceiverVerificationKeyResolver = {
    resolveVerificationKey: (issuer) => Reflect.apply(bound, resolverObject, [issuer]),
  };

  const expectedSovereignAssetId = fields.get('expectedSovereignAssetId');
  const expectedRegistrant = fields.get('expectedRegistrant');
  const expectedManifestDigest = fields.get('expectedManifestDigest');
  if (!isValidSovereignAssetId(expectedSovereignAssetId) || !isIdentifier(expectedRegistrant) || !isDigest(expectedManifestDigest)) return invalid;
  let expectedTerms: SovereignStatusTermsReference | undefined;
  if (fields.has('expectedTerms')) {
    const terms = readTerms(fields.get('expectedTerms'));
    // Present means a full reference: `null` is not a way to opt out.
    if (terms === undefined || terms === null) return invalid;
    expectedTerms = terms;
  }

  const evaluationTime = fields.get('evaluationTime');
  const now = instant(evaluationTime);
  if (now === undefined) return { ok: false, reason: 'EVALUATION_TIME_INVALID' };
  return {
    ok: true,
    value: { resolver, expectedSovereignAssetId, expectedRegistrant, expectedManifestDigest, expectedTerms, evaluationTime: evaluationTime as string, now },
  };
}

/**
 * A canonical UTC timestamp as nanoseconds since the epoch, or `undefined`
 * when the value is not one. Calendar arithmetic only: no Date, so no
 * millisecond rounding and no two-digit-year quirks.
 */
function instant(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  const seconds = BigInt(daysFromCivil(year, month, day)) * 86_400n + BigInt(hour * 3600 + minute * 60 + second);
  return seconds * NANOS_PER_SECOND + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * `aoc-canonical-json/1` for the values a validated status contains (plain
 * objects, strings, safe integers, null): sorted keys, `JSON.stringify` string
 * escaping, no whitespace. Protocol's canonicalizer is not in this package's
 * allowance; for these value types the rules coincide.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Reads a plain object's own data properties exactly once. Refuses non-plain
 * objects, accessors, symbol keys, unknown keys and missing required keys.
 */
function readPlain(value: unknown, allowed: readonly string[], required: readonly string[]): Map<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
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

/** A non-empty identifier with no surrounding whitespace, compared exactly. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function rejected(reason: SovereignStatusRejectionReason): SovereignStatusRejected {
  return deepFreeze({
    outcome: 'rejected',
    verifier: SOVEREIGN_STATUS_VERIFIER,
    statusProfile: SOVEREIGN_STATUS_PROFILE,
    reason,
    freshness: 'not_evaluated',
    revocationCurrentness: 'not_evaluated',
    authorization: 'not_evaluated',
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
