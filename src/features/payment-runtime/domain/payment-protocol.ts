import { isPositiveMonetaryAmount, parseMonetaryAmount, type MonetaryAmount, type MonetaryAssetRegistry } from '../../monetary-runtime/index.js';
import { isPaymentBusinessReference, isPaymentDestinationKind, isPaymentEnvelopeIdentifier, isPaymentRailId, isPaymentReference, isPlainRecord, isSecretShapedPropertyName } from './payment-grammar.js';
import { validatePaymentIntent, type PaymentDestination, type PaymentIntentValidation, type PaymentPurpose, type PaymentSourceRef } from './payment-intent.js';

/**
 * The payment protocol adapter boundary (PAY-04).
 *
 * > **A payment protocol challenge is a merchant's proposal. It is normalized
 * > into the canonical `PaymentIntent` and governed on the unchanged path; it
 * > is never authority.**
 *
 * ```
 * external payment protocol challenge          untrusted protocol data
 *   + trusted protected request                the host's network layer
 *   + trusted protocol interpretation          the adapter's own composition
 *        │
 *        ▼  PaymentProtocolAdapter.interpret   pure, synchronous, total
 * PaymentProtocolTerms + challenge evidence    or a closed refusal
 *        │
 *        ▼  paymentIntentOfProtocolTerms       the PAY-01 validator, unchanged
 * PaymentIntent                                the canonical intent — no second model
 *        │
 *        ▼  compilePaymentIntent               the PAY-01 compiler, unchanged
 * GovernedActionIntent → the governed path → (grant) → PaymentRail
 * ```
 *
 * An adapter normalizes and binds; it never authorizes, decides policy,
 * selects authority, executes, signs, submits, holds a credential, calls a
 * rail, resolves settlement or retries. What it may produce is exactly
 * `PaymentProtocolTerms` — a destination, an exact amount, an optional business
 * reference and an optional rail preference — and evidence of the one
 * challenge it chose. Everything else a payment needs is not the protocol's
 * to say: the source account, the purpose, the idempotency key, the action,
 * the actor and the organization come from trusted Frontera composition and
 * the bound identity.
 *
 * This file names no protocol. A protocol adapter lives under `protocols/`,
 * below this contract, and the contract never imports one.
 */

// ─── the trusted protected request ───────────────────────────────────────────

/**
 * The trusted description of the external request a payment protocol asked to
 * be paid for — supplied by the host's network layer, never by the merchant.
 * Canonical and sanitized: no URL, query string, cookie, header or body.
 */
export interface PaymentProtectedRequest {
  /** A trusted, opaque identifier of the protected resource being purchased (the host's mapping of the external request). Never a URL. */
  readonly target: string;
  /** The external request's HTTP method, upper case. */
  readonly method: string;
  /** When the network layer knows it: the protection space the merchant must challenge with. */
  readonly expectedRealm?: string;
  /** RFC 9530 `Content-Digest` of the exact body the protected request carries, computed by the trusted network layer. Required for a body-bearing request. */
  readonly contentDigest?: string;
}

/** A parsed RFC 9530 digest: its canonical spelling and the recognized algorithms. */
export interface PaymentContentDigest {
  /** Recognized algorithms only, sorted: `sha-256=:…:, sha-512=:…:`. What a business operation commits to. */
  readonly canonical: string;
  /** Recognized algorithm → canonical padded base64. A null-prototype frozen record. */
  readonly algorithms: Readonly<Record<string, string>>;
}

/** The protected request, validated closed and canonicalized. */
export interface PaymentProtectedRequestBinding {
  readonly target: string;
  readonly method: string;
  readonly expectedRealm?: string;
  /** `POST`, `PUT`, `PATCH`, or any request the network layer digested. A body-bearing request is bound only through its digest. */
  readonly bodyBearing: boolean;
  readonly contentDigest?: PaymentContentDigest;
}

const HTTP_METHOD = /^[A-Z]{1,16}$/;
const BODY_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH'];
const PROTECTED_REQUEST_KEYS: readonly string[] = ['target', 'method', 'expectedRealm', 'contentDigest'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
/** At most this many characters of realm text. */
export const PAYMENT_PROTECTED_REALM_MAXIMUM_LENGTH = 256;
/** At most this many characters of `Content-Digest` text. */
export const PAYMENT_CONTENT_DIGEST_MAXIMUM_LENGTH = 512;

/**
 * A plain record's own properties, each read once from its descriptor, or
 * `undefined` for anything else — a non-plain object, a symbol key, an
 * undeclared key, an accessor (never run). Total: never throws.
 */
function readDataRecord(raw: unknown, declared: readonly string[] | undefined): Map<string, unknown> | undefined {
  try {
    if (!isPlainRecord(raw)) return undefined;
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || (declared !== undefined && !declared.includes(key))) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      values.set(key, descriptor.value as unknown);
    }
    return values;
  } catch {
    return undefined;
  }
}

/** Bounded, trim-stable text with no control character. */
function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim() && !CONTROL.test(value);
}

// ─── RFC 9530 Content-Digest ─────────────────────────────────────────────────

/** Algorithms this boundary can compare, and their digest lengths in bytes. Others are ignored, as RFC 9530 asks. */
const DIGEST_ALGORITHMS: readonly (readonly [string, number])[] = [
  ['sha-256', 32],
  ['sha-512', 64],
];
/** An RFC 8941 dictionary key. */
const DIGEST_KEY = /^[a-z*][a-z0-9_.*-]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decoded length of canonical padded base64 — the alphabet, whole quanta, zero pad bits — or `undefined`. */
function canonicalBase64ByteLength(text: string): number | undefined {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return undefined;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  if (padding > 0) {
    // The last data character's unused low bits must be zero, or two spellings decode to one value.
    const last = BASE64_ALPHABET.indexOf(text.charAt(text.length - 1 - padding));
    if (last === -1 || (last & (padding === 2 ? 0x0f : 0x03)) !== 0) return undefined;
  }
  return (text.length / 4) * 3 - padding;
}

/**
 * An RFC 9530 `Content-Digest`-style value — an RFC 8941 dictionary whose
 * members are byte strings, `sha-256=:<base64>:` — parsed strictly: every
 * member in canonical padded base64 of its algorithm's exact length,
 * no member parameters, no duplicated key. Returns the recognized algorithms,
 * or `undefined` when the value is malformed or recognizes none.
 */
export function parsePaymentContentDigest(value: unknown): PaymentContentDigest | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > PAYMENT_CONTENT_DIGEST_MAXIMUM_LENGTH || CONTROL.test(value)) return undefined;
  const seen = new Set<string>();
  const recognized: [string, string][] = [];
  // A byte string cannot contain ',', so splitting the dictionary on it is exact.
  for (const rawMember of value.split(',')) {
    const member = rawMember.replace(/^[ \t]+|[ \t]+$/g, '');
    const separator = member.indexOf('=');
    if (separator <= 0) return undefined;
    const key = member.slice(0, separator);
    const item = member.slice(separator + 1);
    if (!DIGEST_KEY.test(key) || seen.has(key)) return undefined;
    seen.add(key);
    if (item.length < 2 || !item.startsWith(':') || !item.endsWith(':')) return undefined;
    const encoded = item.slice(1, -1);
    const length = canonicalBase64ByteLength(encoded);
    if (length === undefined) return undefined;
    const algorithm = DIGEST_ALGORITHMS.find(([name]) => name === key);
    if (algorithm !== undefined) {
      if (length !== algorithm[1]) return undefined;
      recognized.push([key, encoded]);
    }
  }
  if (recognized.length === 0) return undefined;
  recognized.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const algorithms: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, encoded] of recognized) algorithms[key] = encoded;
  return Object.freeze({ canonical: recognized.map(([key, encoded]) => `${key}=:${encoded}:`).join(', '), algorithms: Object.freeze(algorithms) });
}

/**
 * Whether two digests describe the same body: they share at least one
 * recognized algorithm, and every shared algorithm agrees. A digest with no
 * algorithm in common binds nothing.
 */
export function paymentContentDigestsAgree(left: PaymentContentDigest, right: PaymentContentDigest): boolean {
  let shared = 0;
  for (const algorithm of Object.keys(left.algorithms)) {
    const other = right.algorithms[algorithm];
    if (other === undefined) continue;
    if (other !== left.algorithms[algorithm]) return false;
    shared += 1;
  }
  return shared > 0;
}

/**
 * The trusted protected request, validated closed and canonicalized, or
 * `undefined`. A body-bearing request the network layer did not digest cannot
 * be bound to anything, and is refused.
 */
export function readPaymentProtectedRequest(raw: unknown): PaymentProtectedRequestBinding | undefined {
  const values = readDataRecord(raw, PROTECTED_REQUEST_KEYS);
  if (values === undefined) return undefined;
  const target = values.get('target');
  const method = values.get('method');
  const expectedRealm = values.get('expectedRealm');
  const rawDigest = values.get('contentDigest');
  if (!isPaymentEnvelopeIdentifier(target) || typeof method !== 'string' || !HTTP_METHOD.test(method)) return undefined;
  if (expectedRealm !== undefined && !isBoundedText(expectedRealm, PAYMENT_PROTECTED_REALM_MAXIMUM_LENGTH)) return undefined;
  let contentDigest: PaymentContentDigest | undefined;
  if (rawDigest !== undefined) {
    contentDigest = parsePaymentContentDigest(rawDigest);
    if (contentDigest === undefined) return undefined;
  }
  const bodyBearing = BODY_METHODS.includes(method) || contentDigest !== undefined;
  if (bodyBearing && contentDigest === undefined) return undefined;
  return Object.freeze({
    target,
    method,
    ...(expectedRealm !== undefined ? { expectedRealm: expectedRealm as string } : {}),
    bodyBearing,
    ...(contentDigest !== undefined ? { contentDigest } : {}),
  });
}

// ─── the adapter port ────────────────────────────────────────────────────────

/** Why an adapter could not turn the presented challenges into one payment. Closed; never a Kernel denial; never on a public wire. */
export const PAYMENT_PROTOCOL_REFUSALS = [
  /** No well-formed challenge of the protocol was presented, or its carrier is malformed. */
  'challenge-invalid',
  /** Every otherwise usable challenge has expired at the trusted clock instant. */
  'challenge-expired',
  /** Well-formed challenges exist, but trusted interpretation composes none of them. */
  'challenge-unsupported',
  /** Trusted selection did not choose exactly one usable challenge. */
  'challenge-ambiguous',
  /** A challenge does not bind the trusted protected request (protection space, body digest). */
  'request-binding-mismatch',
  /** Trusted interpretation could not produce exact payment terms. */
  'normalization-failed',
  /** Trusted counterparty resolution did not produce a Frontera destination. */
  'counterparty-unresolved',
] as const;

export type PaymentProtocolRefusal = (typeof PAYMENT_PROTOCOL_REFUSALS)[number];

export function isPaymentProtocolRefusal(value: unknown): value is PaymentProtocolRefusal {
  return typeof value === 'string' && (PAYMENT_PROTOCOL_REFUSALS as readonly string[]).includes(value);
}

/**
 * What a protocol challenge may say about a payment — and nothing else.
 *
 * The destination is the trusted counterparty resolver's answer, never a
 * merchant string copied; the amount is exact P9 money from trusted
 * interpretation; `reference` and `rail` are PAY-01's own optional fields.
 */
export interface PaymentProtocolTerms {
  readonly destination: PaymentDestination;
  readonly amount: MonetaryAmount;
  readonly reference?: string;
  readonly rail?: string;
}

/**
 * Evidence of the one challenge the terms were read from: its stable
 * identity within the protocol (`key`), and its exact, accepted protocol
 * strings (`fields`). Public challenge data only — never a credential.
 */
export interface PaymentProtocolChallengeEvidence {
  readonly key: string;
  readonly fields: Readonly<Record<string, string>>;
}

export type PaymentProtocolInterpretation =
  | { readonly interpreted: true; readonly terms: PaymentProtocolTerms; readonly challenge: PaymentProtocolChallengeEvidence }
  | { readonly interpreted: false; readonly refusal: PaymentProtocolRefusal };

/** What an adapter is told: trusted values only. */
export interface PaymentProtocolInterpretationContext {
  readonly organizationId: string;
  readonly businessOperationId: string;
  readonly protectedRequest: PaymentProtectedRequestBinding;
  /** The trusted clock's instant, as milliseconds since the epoch. An adapter reads no clock. */
  readonly observedAtEpochMilliseconds: number;
}

/**
 * A payment protocol adapter: one protocol's challenge grammar and its
 * trusted interpretation into `PaymentProtocolTerms`.
 *
 * `interpret` is **synchronous and pure**: a promise is not an answer, and a
 * throw is a refusal. Its answer is untrusted executable output — it is read
 * once, closed, and held to PAY-01's grammars and P9 by
 * `readPaymentProtocolInterpretation` before anything uses it.
 *
 * `reservedContextKeys` names the protocol's own words a governed request's
 * asserted context may never carry; a host registers them in its Governance
 * Profile registry's `reservedContextKeys` (CORE-03, L-7) beside
 * `PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS`.
 */
export interface PaymentProtocolAdapter {
  readonly protocolId: string;
  readonly reservedContextKeys: readonly string[];
  interpret(challenges: unknown, context: PaymentProtocolInterpretationContext): PaymentProtocolInterpretation;
}

/**
 * Protocol-neutral words a governed request's asserted context may never
 * carry: a caller of the governed path cannot spell a business operation, a
 * challenge, a credential or a protected request there. Registered by the host
 * through the CORE-03 registry (`reservedContextKeys`, L-7) — never added to
 * the core's built-in list.
 */
export const PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS: readonly string[] = Object.freeze([
  'businessOperation',
  'businessOperationId',
  'challenge',
  'challengeId',
  'merchantRealm',
  'paymentChallenge',
  'paymentChallenges',
  'paymentCredential',
  'paymentProtocol',
  'protectedRequest',
]);

/** A reserved context key, in the CORE-03 registry's own grammar. */
const RESERVED_CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function isPaymentProtocolReservedContextKey(value: unknown): value is string {
  return typeof value === 'string' && RESERVED_CONTEXT_KEY.test(value);
}

/** A protocol identity: a semantic identifier, never credential-shaped — the rail id's grammar. */
export function isPaymentProtocolId(value: unknown): value is string {
  return isPaymentRailId(value);
}

/** Bounds on challenge evidence. */
export const PAYMENT_PROTOCOL_EVIDENCE_LIMITS = Object.freeze({
  maxKeyLength: 2_048,
  maxFields: 16,
  maxFieldValueLength: 8_192,
  maxTotalLength: 24_576,
});

const EVIDENCE_FIELD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const INTERPRETATION_KEYS: readonly string[] = ['interpreted', 'terms', 'challenge', 'refusal'];
const TERMS_KEYS: readonly string[] = ['destination', 'amount', 'reference', 'rail'];
const DESTINATION_KEYS: readonly string[] = ['kind', 'reference'];
const AMOUNT_KEYS: readonly string[] = ['value', 'unit'];
const CHALLENGE_KEYS: readonly string[] = ['key', 'fields'];

/** Exactly `{ value, unit }`, through the single P9 ingress, strictly positive. */
function readAmount(raw: unknown, assets: MonetaryAssetRegistry): MonetaryAmount | undefined {
  const values = readDataRecord(raw, AMOUNT_KEYS);
  if (values === undefined || values.size !== 2) return undefined;
  const parsed = parseMonetaryAmount({ value: values.get('value'), unit: values.get('unit') }, assets);
  if (!parsed.valid || !isPositiveMonetaryAmount(parsed.amount)) return undefined;
  return parsed.amount;
}

function readDestination(raw: unknown): PaymentDestination | undefined {
  const values = readDataRecord(raw, DESTINATION_KEYS);
  if (values === undefined || values.size !== 2) return undefined;
  const kind = values.get('kind');
  const reference = values.get('reference');
  if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) return undefined;
  return Object.freeze({ kind, reference });
}

function readTerms(raw: unknown, assets: MonetaryAssetRegistry): PaymentProtocolTerms | undefined {
  const values = readDataRecord(raw, TERMS_KEYS);
  if (values === undefined) return undefined;
  const destination = readDestination(values.get('destination'));
  const amount = readAmount(values.get('amount'), assets);
  const reference = values.get('reference');
  const rail = values.get('rail');
  if (destination === undefined || amount === undefined) return undefined;
  if (reference !== undefined && !isPaymentBusinessReference(reference)) return undefined;
  if (rail !== undefined && !isPaymentRailId(rail)) return undefined;
  return Object.freeze({
    destination,
    amount,
    ...(reference !== undefined ? { reference: reference as string } : {}),
    ...(rail !== undefined ? { rail: rail as string } : {}),
  });
}

/** Closed, bounded, public evidence. A secret-shaped field name refuses the whole answer, its value unread. */
export function readPaymentProtocolChallengeEvidence(raw: unknown): PaymentProtocolChallengeEvidence | undefined {
  const values = readDataRecord(raw, CHALLENGE_KEYS);
  if (values === undefined || values.size !== 2) return undefined;
  const key = values.get('key');
  if (typeof key !== 'string' || key.length === 0 || key.length > PAYMENT_PROTOCOL_EVIDENCE_LIMITS.maxKeyLength || CONTROL.test(key)) return undefined;
  const fields = readDataRecord(values.get('fields'), undefined);
  if (fields === undefined || fields.size === 0 || fields.size > PAYMENT_PROTOCOL_EVIDENCE_LIMITS.maxFields) return undefined;
  let total = key.length;
  const names = [...fields.keys()].sort();
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of names) {
    if (!EVIDENCE_FIELD_NAME.test(name) || isSecretShapedPropertyName(name)) return undefined;
    const value = fields.get(name);
    if (typeof value !== 'string' || value.length === 0 || value.length > PAYMENT_PROTOCOL_EVIDENCE_LIMITS.maxFieldValueLength || CONTROL.test(value)) return undefined;
    total += name.length + value.length;
    if (total > PAYMENT_PROTOCOL_EVIDENCE_LIMITS.maxTotalLength) return undefined;
    out[name] = value;
  }
  return Object.freeze({ key, fields: Object.freeze(out) });
}

/**
 * An adapter's answer, read **once** as untrusted executable output, or
 * `undefined` when it is not exactly an interpretation: an accessor, a Proxy
 * that throws, a promise, a number amount, an undeclared key (`authorized`,
 * `ceiling`, `grant`, `source`, `idempotencyKey`, …), a destination or amount
 * outside PAY-01's grammars and P9 — none of these is an answer.
 */
export function readPaymentProtocolInterpretation(raw: unknown, trust: { readonly assets: MonetaryAssetRegistry }): PaymentProtocolInterpretation | undefined {
  const values = readDataRecord(raw, INTERPRETATION_KEYS);
  if (values === undefined) return undefined;
  const interpreted = values.get('interpreted');
  if (interpreted === false) {
    const refusal = values.get('refusal');
    if (values.size !== 2 || !isPaymentProtocolRefusal(refusal)) return undefined;
    return Object.freeze({ interpreted: false, refusal });
  }
  if (interpreted !== true || values.size !== 3 || values.has('refusal')) return undefined;
  const terms = readTerms(values.get('terms'), trust.assets);
  const challenge = readPaymentProtocolChallengeEvidence(values.get('challenge'));
  if (terms === undefined || challenge === undefined) return undefined;
  return Object.freeze({ interpreted: true, terms, challenge });
}

/**
 * The canonical `PaymentIntent` for normalized protocol terms — built by the
 * PAY-01 validator itself, so a protocol-derived payment is held to exactly
 * the rules a direct one is. The trusted half (`source`, `purpose`,
 * `idempotencyKey`, `correlationId`) is never the protocol's.
 */
export function paymentIntentOfProtocolTerms(
  terms: PaymentProtocolTerms,
  trusted: { readonly source: PaymentSourceRef; readonly purpose: PaymentPurpose; readonly idempotencyKey: string; readonly correlationId?: string },
  trust: { readonly assets: MonetaryAssetRegistry },
): PaymentIntentValidation {
  return validatePaymentIntent(
    {
      source: { accountId: trusted.source.accountId },
      destination: { kind: terms.destination.kind, reference: terms.destination.reference },
      amount: { value: terms.amount.value, unit: terms.amount.unit },
      purpose: trusted.purpose,
      ...(terms.reference !== undefined ? { reference: terms.reference } : {}),
      ...(terms.rail !== undefined ? { rail: terms.rail } : {}),
      idempotencyKey: trusted.idempotencyKey,
      ...(trusted.correlationId !== undefined ? { correlationId: trusted.correlationId } : {}),
    },
    trust,
  );
}
