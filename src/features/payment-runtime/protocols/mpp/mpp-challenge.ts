import { MPP_CHALLENGE_LIMITS, decodeCanonicalJsonObject, rfc3339EpochMilliseconds, type MppJsonValue, type RawAuthChallenge } from './mpp-grammar.js';
import { parsePaymentContentDigest } from '../../domain/index.js';

/**
 * PAY-04 — one MPP `Payment` HTTP authentication challenge, validated on the
 * **client** side against `draft-httpauth-payment-01` (pinned, see
 * `mpp-grammar.ts`).
 *
 * ## What "valid" means here — and what it cannot mean
 *
 * A challenge that passes is **well formed**: its required parameters are
 * present exactly once, its encodings are canonical, its decoded JSON is
 * bounded, and its optional parameters are in their declared syntax. It is
 * **not authentic**. The challenge `id` is bound by the issuing server — by an
 * HMAC, authenticated encryption or a stateful table — under a secret a
 * client never holds. No client can verify it, and nothing here claims to.
 * Binding a challenge to the protected request is not authenticating it.
 *
 * ## Strictness beyond the draft, fail-closed
 *
 * - A **duplicated** known parameter makes that challenge invalid. The draft
 *   states no rule; first-wins and last-wins are both refused.
 * - `request` and `opaque` must be **JCS-canonical** (RFC 8785).
 * - `__proto__`, `constructor` and `prototype` are refused as JSON member
 *   names anywhere in `request` and `opaque`.
 * - `header`, when present, must be exactly `Payment-Authorization`; any other
 *   value is an unrecognized challenge, as the draft requires.
 *
 * Unknown parameters are ignored, as the draft requires: they are never
 * retained, persisted or passed on, so an unknown parameter can never change
 * what a challenge means. `description` is display-only by the draft: it is
 * bounded and checked, then dropped — it never reaches interpretation,
 * selection, evidence or durable state.
 */

export const MPP_PAYMENT_AUTHORIZATION_HEADER = 'Payment-Authorization';

/** The draft's `payment-method-id = 1*LOWERALPHA`. */
const METHOD = /^[a-z]+$/;
/** The draft's `intent = 1*( ALPHA / DIGIT / "-" )`. */
const INTENT = /^[A-Za-z0-9-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** The known parameters. Everything else is ignored, unread. */
export const MPP_CHALLENGE_KNOWN_PARAMS: readonly string[] = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'description', 'opaque', 'header'];
const REQUIRED_PARAMS: readonly string[] = ['id', 'realm', 'method', 'intent', 'request'];

/** The exact accepted protocol strings of one challenge — what is kept as evidence, unchanged. */
export interface MppChallengeFields {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  /** The exact base64url text the server sent. Never re-encoded. */
  readonly request: string;
  readonly expires?: string;
  readonly digest?: string;
  readonly opaque?: string;
  readonly header?: typeof MPP_PAYMENT_AUTHORIZATION_HEADER;
}

/** A validated challenge: the exact fields, plus decoded views for validation and trusted normalization only. Frozen. */
export interface MppPaymentChallenge extends MppChallengeFields {
  readonly decodedRequest: { readonly [key: string]: MppJsonValue };
  readonly decodedOpaque?: Readonly<Record<string, string>>;
  /** `expires` as milliseconds since the epoch, when stated. */
  readonly expiresAtEpochMilliseconds?: number;
}

export type MppChallengeParse = { readonly valid: true; readonly challenge: MppPaymentChallenge } | { readonly valid: false; readonly violation: string };

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}

/** One raw `Payment` challenge → a validated, frozen one. Known parameters exactly once; unknown ones dropped unread. Total. */
export function parseMppPaymentChallenge(raw: RawAuthChallenge): MppChallengeParse {
  const invalid = (violation: string): MppChallengeParse => ({ valid: false, violation });
  if (raw.scheme.toLowerCase() !== 'payment') return invalid('not a Payment challenge');
  if (raw.token68 !== undefined) return invalid('a Payment challenge carries auth-params, not token68');
  const known = new Map<string, string>();
  for (const [name, value] of raw.params) {
    if (!MPP_CHALLENGE_KNOWN_PARAMS.includes(name)) continue;
    if (known.has(name)) return invalid(`duplicate parameter '${name}'`);
    known.set(name, value);
  }
  for (const required of REQUIRED_PARAMS) {
    if (!known.has(required)) return invalid(`missing required parameter '${required}'`);
  }
  const id = known.get('id');
  const realm = known.get('realm');
  const method = known.get('method');
  const intent = known.get('intent');
  const request = known.get('request');
  const expires = known.get('expires');
  const digest = known.get('digest');
  const opaque = known.get('opaque');
  const header = known.get('header');
  const description = known.get('description');

  if (!boundedText(id, MPP_CHALLENGE_LIMITS.maxIdLength)) return invalid('id is empty, too long or carries a control character');
  if (!boundedText(realm, MPP_CHALLENGE_LIMITS.maxRealmLength)) return invalid('realm is empty, too long or carries a control character');
  if (method === undefined || method.length > MPP_CHALLENGE_LIMITS.maxMethodLength || !METHOD.test(method)) return invalid('method is not a lowercase payment-method-id');
  if (intent === undefined || intent.length > MPP_CHALLENGE_LIMITS.maxIntentLength || !INTENT.test(intent)) return invalid('intent is not an intent token');
  if (request === undefined) return invalid("missing required parameter 'request'");
  const decodedRequest = decodeCanonicalJsonObject(request, MPP_CHALLENGE_LIMITS.maxRequestBytes);
  if (!decodedRequest.valid) return invalid(`request: ${decodedRequest.violation}`);
  let expiresAt: number | undefined;
  if (expires !== undefined) {
    expiresAt = rfc3339EpochMilliseconds(expires);
    if (expiresAt === undefined) return invalid('expires is not an RFC 3339 date-time');
  }
  if (digest !== undefined && (digest.length > MPP_CHALLENGE_LIMITS.maxDigestLength || parsePaymentContentDigest(digest) === undefined)) return invalid('digest is not an RFC 9530 digest with a recognized algorithm');
  if (header !== undefined && header !== MPP_PAYMENT_AUTHORIZATION_HEADER) return invalid('header names a field other than Payment-Authorization');
  if (description !== undefined && (description.length > MPP_CHALLENGE_LIMITS.maxDescriptionLength || CONTROL.test(description))) return invalid('description is too long or carries a control character');
  let decodedOpaque: Readonly<Record<string, string>> | undefined;
  if (opaque !== undefined) {
    const decoded = decodeCanonicalJsonObject(opaque, MPP_CHALLENGE_LIMITS.maxOpaqueBytes);
    if (!decoded.valid) return invalid(`opaque: ${decoded.violation}`);
    const entries = Object.entries(decoded.value);
    if (entries.length > MPP_CHALLENGE_LIMITS.maxOpaqueEntries || entries.some(([, value]) => typeof value !== 'string')) return invalid('opaque is not a flat string-to-string map');
    decodedOpaque = decoded.value as Readonly<Record<string, string>>;
  }
  return {
    valid: true,
    challenge: Object.freeze({
      id,
      realm,
      method,
      intent,
      request,
      ...(expires !== undefined ? { expires } : {}),
      ...(digest !== undefined ? { digest } : {}),
      ...(opaque !== undefined ? { opaque } : {}),
      ...(header !== undefined ? { header: MPP_PAYMENT_AUTHORIZATION_HEADER } : {}),
      decodedRequest: decodedRequest.value,
      ...(decodedOpaque !== undefined ? { decodedOpaque } : {}),
      ...(expiresAt !== undefined ? { expiresAtEpochMilliseconds: expiresAt } : {}),
    }),
  };
}

/**
 * Whether a challenge can still be used at `instant` (milliseconds since the
 * epoch, from a trusted clock). A challenge without `expires` states no expiry;
 * one whose `expires` is at or before the instant is not usable.
 */
export function isMppChallengeUsableAt(challenge: { readonly expiresAtEpochMilliseconds?: number }, instant: number): boolean {
  if (!Number.isSafeInteger(instant)) return false;
  return challenge.expiresAtEpochMilliseconds === undefined || challenge.expiresAtEpochMilliseconds > instant;
}

/** The exact fields only — no decoded view — as a fresh frozen record of strings. What is kept as challenge evidence. */
export function mppChallengeFieldsOf(challenge: MppChallengeFields): Readonly<Record<string, string>> {
  return Object.freeze({
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
    ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
    ...(challenge.digest !== undefined ? { digest: challenge.digest } : {}),
    ...(challenge.opaque !== undefined ? { opaque: challenge.opaque } : {}),
    ...(challenge.header !== undefined ? { header: challenge.header } : {}),
  });
}

/** The challenge's stable identity within the protocol: its protection space and its server-bound id. */
export function mppChallengeKeyOf(challenge: { readonly realm: string; readonly id: string }): string {
  return JSON.stringify([challenge.realm, challenge.id]);
}

/** Where a future credential for this challenge must go: the draft's default `Authorization`, or `Payment-Authorization` when the challenge selected it. The **merchant's** field on the **external** request — never Frontera's customer `Authorization`. */
export function mppCredentialHeaderField(challenge: { readonly header?: string }): 'Authorization' | typeof MPP_PAYMENT_AUTHORIZATION_HEADER {
  return challenge.header === MPP_PAYMENT_AUTHORIZATION_HEADER ? MPP_PAYMENT_AUTHORIZATION_HEADER : 'Authorization';
}
