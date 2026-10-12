import { createHash } from 'node:crypto';

import { createMonetaryAssetRegistry } from '../../../../monetary-runtime/index.js';
import type { PaymentDestination, PaymentProtectedRequestBinding } from '../../../domain/index.js';
import { createMppPaymentProtocolAdapter, type MppChallengeSelector, type MppCounterpartyResolver, type MppMethodNormalizer, type MppPaymentProtocolAdapterOptions } from '../index.js';

/**
 * Test-only builders for MPP challenges (PAY-04). The official specification
 * repository publishes no client parsing vectors; its server-side HMAC vectors'
 * `request` / `opaque` encodings (CC0) are reused as parse vectors, and every
 * other challenge is built from the draft's normative text.
 */

/** The draft's HMAC test-vector inputs (CC0): request {"amount":"1000000"} and opaque {"pi":"pi_123"}. */
export const VECTOR_REQUEST = 'eyJhbW91bnQiOiIxMDAwMDAwIn0';
export const VECTOR_OPAQUE = 'eyJwaSI6InBpXzEyMyJ9';
export const VECTOR_ID = 'X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4';

/** 2026-09-24T12:00:00.000Z — the instant every test interprets at unless it says otherwise. */
export const OBSERVED_AT = Date.parse('2026-09-24T12:00:00.000Z');

/** RFC 8785 for test data: sorted members, no whitespace. */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
    .join(',')}}`;
}

export function base64url(text: string | Uint8Array): string {
  return Buffer.from(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64url');
}

export function encodeJcs(value: unknown): string {
  return base64url(jcs(value));
}

/** RFC 9530 `sha-256` Content-Digest of exact body bytes. */
export function contentDigestOf(body: string): string {
  return `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`;
}

export interface ChallengeParts {
  readonly id?: string;
  readonly realm?: string;
  readonly method?: string;
  readonly intent?: string;
  readonly request?: unknown;
  readonly rawRequest?: string;
  readonly expires?: string | null;
  readonly digest?: string;
  readonly opaque?: unknown;
  readonly header?: string;
  readonly description?: string;
  /** Raw extra auth-params appended verbatim. */
  readonly extra?: string;
}

/** The default charge request a test merchant asks for: 10 USD in base units of cents, to merchant account `m-001`, order `ORD-1`. */
export const DEFAULT_CHARGE = Object.freeze({ amount: '1000', currency: 'usd', recipient: 'm-001', externalId: 'ORD-1' });

/** One `Payment` challenge as a header field value. */
export function paymentChallenge(parts: ChallengeParts = {}): string {
  const params: string[] = [
    `id="${parts.id ?? 'ch-1'}"`,
    `realm="${parts.realm ?? 'api.merchant.example'}"`,
    `method="${parts.method ?? 'testpay'}"`,
    `intent="${parts.intent ?? 'charge'}"`,
    `request="${parts.rawRequest ?? encodeJcs(parts.request ?? DEFAULT_CHARGE)}"`,
  ];
  if (parts.expires !== null) params.push(`expires="${parts.expires ?? '2026-09-24T12:05:00Z'}"`);
  if (parts.digest !== undefined) params.push(`digest="${parts.digest}"`);
  if (parts.opaque !== undefined) params.push(`opaque="${encodeJcs(parts.opaque)}"`);
  if (parts.header !== undefined) params.push(`header="${parts.header}"`);
  if (parts.description !== undefined) params.push(`description="${parts.description}"`);
  if (parts.extra !== undefined) params.push(parts.extra);
  return `Payment ${params.join(', ')}`;
}

export const TEST_ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: 'EUR', scale: 2 },
]);

/** A trusted test normalizer for method `testpay`: base units of a two-decimal currency → exact P9 text, by string arithmetic only. */
export function testpayNormalizer(overrides: Partial<MppMethodNormalizer> = {}): MppMethodNormalizer {
  return {
    methodId: 'testpay',
    intent: 'charge',
    normalize(challenge) {
      const request = challenge.decodedRequest;
      const amount = request['amount'];
      const currency = request['currency'];
      if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(amount)) return undefined;
      const unit = currency === 'usd' ? 'USD' : currency === 'eur' ? 'EUR' : undefined;
      if (unit === undefined) return undefined;
      const padded = amount.padStart(3, '0');
      const value = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
      const recipient = request['recipient'];
      const externalId = request['externalId'];
      return {
        amount: { value, unit },
        ...(typeof recipient === 'string' ? { merchantReference: recipient } : {}),
        ...(typeof externalId === 'string' ? { reference: externalId } : {}),
      };
    },
    ...overrides,
  };
}

/** The trusted merchant directory: merchant references this deployment pays, and where. */
export const MERCHANT_DIRECTORY: Readonly<Record<string, PaymentDestination>> = Object.freeze({
  'm-001': Object.freeze({ kind: 'account', reference: 'vendor-4471' }),
  'm-002': Object.freeze({ kind: 'account', reference: 'vendor-9999' }),
});

export const directoryResolver: MppCounterpartyResolver = (context) => (context.merchantReference === undefined ? undefined : MERCHANT_DIRECTORY[context.merchantReference]);

/** A trusted selector that picks the only candidate, and refuses to choose among several. */
export const onlyCandidate: MppChallengeSelector = (candidates) => (candidates.length === 1 ? candidates[0]?.id : undefined);

export function testAdapter(overrides: Partial<MppPaymentProtocolAdapterOptions> = {}) {
  return createMppPaymentProtocolAdapter({ methods: [testpayNormalizer()], resolveCounterparty: directoryResolver, selectChallenge: onlyCandidate, assets: TEST_ASSETS, ...overrides });
}

export const GET_REQUEST: PaymentProtectedRequestBinding = Object.freeze({ target: 'merchant:report-42', method: 'GET', bodyBearing: false });

export function context(overrides: { readonly protectedRequest?: PaymentProtectedRequestBinding; readonly observedAtEpochMilliseconds?: number } = {}) {
  return Object.freeze({ organizationId: 'org-a', businessOperationId: 'bop-1', protectedRequest: overrides.protectedRequest ?? GET_REQUEST, observedAtEpochMilliseconds: overrides.observedAtEpochMilliseconds ?? OBSERVED_AT });
}
