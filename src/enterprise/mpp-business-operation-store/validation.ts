import { isPositiveMonetaryAmount, isWellFormedMonetaryAmount } from '../../features/monetary-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { isWellFormedDigest } from '../governance-store/digest.js';
import { canonicalContentDigest, parseContentDigest, validateMppChallengeFields } from '../mpp-challenge/protocol.js';

/**
 * The closed contract every business operation and every challenge instance
 * must satisfy — checked before anything is written, and again on every read
 * of a persisted row, in memory and in SQLite alike.
 *
 * Exactly the declared keys; money as canonical decimal text in a well-formed
 * asset identifier (never a number); a challenge held to the same protocol
 * validation it passed on ingestion.
 */

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A canonical UTC instant as the injected clocks produce it (`toISOString()`), and nothing that merely parses. */
export function isCanonicalMppInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

const HTTP_METHOD = /^[A-Z]{1,16}$/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function undeclared(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

export function isMppHttpMethod(value: unknown): value is string {
  return typeof value === 'string' && HTTP_METHOD.test(value);
}

/** A canonical RFC 9530 digest spelling: parseable, recognized, and already in canonical form. */
export function isCanonicalMppContentDigest(value: unknown): value is string {
  const parsed = parseContentDigest(value);
  return parsed !== undefined && canonicalContentDigest(parsed) === value;
}

const OPERATION_KEYS = [
  'organizationId',
  'principalId',
  'businessOperationId',
  'businessSemanticDigest',
  'action',
  'resource',
  'counterparty',
  'amount',
  'intent',
  'httpMethod',
  'contentDigest',
  'externalId',
  'governedIdempotencyKey',
  'governedRequestId',
  'createdAt',
] as const;

/** Why an operation is outside the contract, or `undefined` when it is inside it. */
export function mppBusinessOperationViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the operation is not a plain object';
  const extra = undeclared(input, OPERATION_KEYS);
  if (extra !== undefined) return `undeclared key '${extra}'`;
  for (const key of ['organizationId', 'principalId', 'businessOperationId', 'action', 'resource', 'counterparty'] as const) {
    if (!isCanonicalCustomerIdentifier(input[key])) return `${key} is not a canonical identifier`;
  }
  if (typeof input['businessSemanticDigest'] !== 'string' || !isWellFormedDigest(input['businessSemanticDigest'])) return 'businessSemanticDigest is not a digest';
  const amount = input['amount'];
  if (!isPlainRecord(amount) || undeclared(amount, ['value', 'unit']) !== undefined || !isWellFormedMonetaryAmount(amount) || !isPositiveMonetaryAmount(amount)) {
    return 'amount is not positive canonical money';
  }
  if (input['intent'] !== 'charge') return 'intent is not charge';
  if (!isMppHttpMethod(input['httpMethod'])) return 'httpMethod is not an upper-case method token';
  if (input['contentDigest'] !== undefined && !isCanonicalMppContentDigest(input['contentDigest'])) return 'contentDigest is not a canonical RFC 9530 digest';
  if (input['externalId'] !== undefined && !isCanonicalCustomerIdentifier(input['externalId'])) return 'externalId is not a canonical identifier';
  for (const key of ['governedIdempotencyKey', 'governedRequestId'] as const) {
    if (!isCanonicalCustomerIdentifier(input[key])) return `${key} is not a canonical identifier`;
  }
  if (!isCanonicalMppInstant(input['createdAt'])) return 'createdAt is not a canonical instant';
  return undefined;
}

const CHALLENGE_KEYS = [
  'organizationId',
  'principalId',
  'businessOperationId',
  'businessSemanticDigest',
  'challengeDigest',
  'id',
  'realm',
  'method',
  'intent',
  'request',
  'expires',
  'digest',
  'opaque',
  'header',
  'description',
  'observedAt',
] as const;

/** Why a challenge instance is outside the contract, or `undefined` when it is inside it. */
export function mppChallengeInstanceViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the challenge is not a plain object';
  const extra = undeclared(input, CHALLENGE_KEYS);
  if (extra !== undefined) return `undeclared key '${extra}'`;
  for (const key of ['organizationId', 'principalId', 'businessOperationId'] as const) {
    if (!isCanonicalCustomerIdentifier(input[key])) return `${key} is not a canonical identifier`;
  }
  for (const key of ['businessSemanticDigest', 'challengeDigest'] as const) {
    if (typeof input[key] !== 'string' || !isWellFormedDigest(input[key])) return `${key} is not a digest`;
  }
  const protocol = validateMppChallengeFields({
    id: input['id'],
    realm: input['realm'],
    method: input['method'],
    intent: input['intent'],
    request: input['request'],
    expires: input['expires'],
    digest: input['digest'],
    opaque: input['opaque'],
    header: input['header'],
    description: input['description'],
  });
  if (!protocol.valid) return `the challenge is outside the protocol contract (${protocol.violation})`;
  if (!isCanonicalMppInstant(input['observedAt'])) return 'observedAt is not a canonical instant';
  return undefined;
}
