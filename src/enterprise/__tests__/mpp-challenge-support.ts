import { canonicalSerialize } from '../governance-store/canonical-json.js';
import type { MppBusinessOperationInput, MppChallengeInstanceInput, RecordMppChallengeInput } from '../mpp-business-operation-store/contracts.js';
import { computeMppBusinessSemanticDigest, computeMppChallengeDigest, deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from '../mpp-challenge/business-identity.js';
import type { MppChallengeMethodNormalizer, MppChallengeSelector, MppCounterpartyResolver, MppNormalizedCharge } from '../mpp-challenge/contracts.js';
import type { MppChallengeFields, ParsedMppPaymentChallenge } from '../mpp-challenge/protocol.js';

/**
 * TEST-ONLY MPP fixtures. Nothing here is production support for any payment
 * method: `fakepay` and `altpay` are invented methods whose request shapes
 * exist only in this file, so that P13 can be exercised end to end without
 * beginning P14 (Stripe) or any real rail. No production module imports this
 * file (`mpp-challenge-boundaries.test.ts` pins that).
 */

export const MPP_TEST_REALM = 'merchant-a.example';
export const MPP_TEST_NOW = '2026-09-24T12:00:00.000Z';
export const MPP_TEST_EXPIRES = '2026-09-24T12:05:00Z';

/** base64url, no padding, of the JCS serialization — exactly how a conforming server encodes `request` and `opaque`. */
export function encodeJcs(value: unknown): string {
  return Buffer.from(canonicalSerialize(value), 'utf8').toString('base64url');
}

export interface ChallengeSpec {
  readonly id?: string;
  readonly realm?: string;
  readonly method?: string;
  readonly intent?: string;
  readonly request?: unknown;
  /** Raw `request` text, bypassing encoding. */
  readonly rawRequest?: string;
  readonly expires?: string;
  readonly digest?: string;
  readonly opaque?: unknown;
  readonly rawOpaque?: string;
  readonly header?: string;
  readonly description?: string;
  readonly extra?: string;
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"`;
}

/** One `Payment` challenge as a `WWW-Authenticate` field value. */
export function paymentChallenge(spec: ChallengeSpec = {}): string {
  const params: string[] = [];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined) params.push(`${name}=${quote(value)}`);
  };
  add('id', spec.id ?? 'ch-1');
  add('realm', spec.realm ?? MPP_TEST_REALM);
  add('method', spec.method ?? 'fakepay');
  add('intent', spec.intent ?? 'charge');
  add('request', spec.rawRequest ?? encodeJcs(spec.request ?? chargeRequest()));
  add('expires', spec.expires ?? MPP_TEST_EXPIRES);
  add('digest', spec.digest);
  add('opaque', spec.rawOpaque ?? (spec.opaque === undefined ? undefined : encodeJcs(spec.opaque)));
  add('header', spec.header);
  add('description', spec.description);
  if (spec.extra !== undefined) params.push(spec.extra);
  return `Payment ${params.join(', ')}`;
}

/** The charge intent's shared request fields, in base units and a method currency — as a server would send them. */
export function chargeRequest(overrides: { readonly amount?: string; readonly currency?: string; readonly recipient?: string; readonly externalId?: string } = {}): Record<string, string> {
  return {
    amount: overrides.amount ?? '1000',
    currency: overrides.currency ?? 'usd',
    recipient: overrides.recipient ?? 'acct_merchant_a',
    ...(overrides.externalId !== undefined ? { externalId: overrides.externalId } : {}),
  };
}

/**
 * The trusted mapping a real method normalizer must own: method currency →
 * P9 asset and the method's base-unit decimals. Never inferred from the
 * currency's spelling.
 */
const TRUSTED_CURRENCIES: Readonly<Record<string, { readonly unit: string; readonly decimals: number }>> = {
  usd: { unit: 'USD', decimals: 2 },
  usdc: { unit: 'USDC', decimals: 6 },
};

/** Exact base units → decimal text by string manipulation. No number ever holds the amount. */
export function baseUnitsToDecimal(baseUnits: string, decimals: number): string | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(baseUnits)) return undefined;
  if (decimals === 0) return baseUnits;
  const padded = baseUnits.padStart(decimals + 1, '0');
  return `${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
}

function textField(request: ParsedMppPaymentChallenge['decodedRequest'], key: string): string | undefined {
  const value = request[key];
  return typeof value === 'string' ? value : undefined;
}

/** TEST-ONLY `fakepay/charge`: `{ amount, currency, recipient, externalId? }`. */
export function fakepayNormalizer(options: { readonly calls?: { count: number } } = {}): MppChallengeMethodNormalizer {
  return {
    methodId: 'fakepay',
    intent: 'charge',
    normalize(challenge): MppNormalizedCharge | undefined {
      if (options.calls !== undefined) options.calls.count += 1;
      const request = challenge.decodedRequest;
      const currency = TRUSTED_CURRENCIES[textField(request, 'currency') ?? ''];
      const amount = textField(request, 'amount');
      if (currency === undefined || amount === undefined) return undefined;
      const value = baseUnitsToDecimal(amount, currency.decimals);
      const recipient = textField(request, 'recipient');
      const externalId = textField(request, 'externalId');
      if (value === undefined) return undefined;
      return { amount: { value, unit: currency.unit }, ...(recipient !== undefined ? { merchantReference: recipient } : {}), ...(externalId !== undefined ? { externalId } : {}) };
    },
  };
}

/** TEST-ONLY `altpay/charge`: a different request shape — `{ price: { minor, asset }, payee }` — for method-alternative tests. */
export function altpayNormalizer(): MppChallengeMethodNormalizer {
  return {
    methodId: 'altpay',
    intent: 'charge',
    normalize(challenge): MppNormalizedCharge | undefined {
      const price = challenge.decodedRequest['price'];
      if (price === null || typeof price !== 'object' || Array.isArray(price)) return undefined;
      const minor = (price as Record<string, unknown>)['minor'];
      const asset = TRUSTED_CURRENCIES[String((price as Record<string, unknown>)['asset'])];
      const payee = textField(challenge.decodedRequest, 'payee');
      if (typeof minor !== 'string' || asset === undefined) return undefined;
      const value = baseUnitsToDecimal(minor, asset.decimals);
      if (value === undefined) return undefined;
      return { amount: { value, unit: asset.unit }, ...(payee !== undefined ? { merchantReference: payee } : {}) };
    },
  };
}

/** TEST-ONLY trusted counterparty mapping: rail-specific merchant references → the Frontera counterparty the authority knows. */
export const TEST_MERCHANTS: Readonly<Record<string, string>> = {
  acct_merchant_a: 'merchant-a',
  wallet_merchant_a: 'merchant-a',
  acct_merchant_b: 'merchant-b',
};

export const testCounterpartyResolver: MppCounterpartyResolver = (context) => (context.merchantReference === undefined ? undefined : TEST_MERCHANTS[context.merchantReference]);

/** TEST-ONLY trusted selector: `fakepay` preferred over `altpay`; two candidates of the preferred method are ambiguous. */
export const testSelector: MppChallengeSelector = (candidates) => {
  for (const method of ['fakepay', 'altpay']) {
    const matching = candidates.filter((candidate) => candidate.method === method);
    if (matching.length === 1) return matching[0]?.id;
    if (matching.length > 1) return undefined;
  }
  return undefined;
};

// ─── store inputs, built exactly as the service builds them ─────────────────

export interface StoreTerms {
  readonly organizationId?: string;
  readonly principalId?: string;
  readonly businessOperationId?: string;
  readonly action?: string;
  readonly resource?: string;
  readonly counterparty?: string;
  readonly value?: string;
  readonly unit?: string;
  readonly contentDigest?: string;
  readonly externalId?: string;
  readonly httpMethod?: string;
}

export function storeOperationInput(terms: StoreTerms = {}): MppBusinessOperationInput {
  const scope = { organizationId: terms.organizationId ?? 'org-a', principalId: terms.principalId ?? 'principal-a', businessOperationId: terms.businessOperationId ?? 'op-1' };
  const semantics = {
    ...scope,
    action: terms.action ?? 'payment.send',
    resource: terms.resource ?? 'resource-report-1',
    counterparty: terms.counterparty ?? 'merchant-a',
    amount: { value: terms.value ?? '10', unit: terms.unit ?? 'USD' },
    intent: 'charge' as const,
    httpMethod: terms.httpMethod ?? 'GET',
    ...(terms.contentDigest !== undefined ? { contentDigest: terms.contentDigest } : {}),
    ...(terms.externalId !== undefined ? { externalId: terms.externalId } : {}),
  };
  return {
    ...semantics,
    businessSemanticDigest: computeMppBusinessSemanticDigest(semantics),
    governedIdempotencyKey: deriveMppGovernedIdempotencyKey(scope),
    governedRequestId: deriveMppGovernedRequestId(scope),
    createdAt: '2026-09-24T12:00:00.000Z',
  };
}

export function storeChallengeInput(operation: MppBusinessOperationInput, fields: Partial<MppChallengeFields> = {}): MppChallengeInstanceInput {
  const exact: MppChallengeFields = {
    id: fields.id ?? 'ch-1',
    realm: fields.realm ?? 'merchant-a.example',
    method: fields.method ?? 'fakepay',
    intent: fields.intent ?? 'charge',
    request: fields.request ?? encodeJcs(chargeRequest()),
    ...(fields.expires !== undefined ? { expires: fields.expires } : { expires: '2026-09-24T12:05:00Z' }),
    ...(fields.digest !== undefined ? { digest: fields.digest } : {}),
    ...(fields.opaque !== undefined ? { opaque: fields.opaque } : {}),
    ...(fields.header !== undefined ? { header: fields.header } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
  };
  return {
    organizationId: operation.organizationId,
    principalId: operation.principalId,
    businessOperationId: operation.businessOperationId,
    businessSemanticDigest: operation.businessSemanticDigest,
    challengeDigest: computeMppChallengeDigest(exact),
    ...exact,
    observedAt: '2026-09-24T12:00:00.000Z',
  };
}

export function storeEntry(terms: StoreTerms = {}, fields: Partial<MppChallengeFields> = {}): RecordMppChallengeInput {
  const operation = storeOperationInput(terms);
  return { operation, challenge: storeChallengeInput(operation, fields) };
}
