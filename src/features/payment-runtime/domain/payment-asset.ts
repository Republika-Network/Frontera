import { isCanonicalMonetaryAssetId } from '../../monetary-runtime/index.js';

/**
 * A descriptive reading of a P9 asset identifier (PAY-01, master-plan L-8).
 *
 * The asset a payment is denominated in **is** a P9 asset identifier — the
 * trusted registry's, opaque, compared exactly — and this module adds no
 * second asset model beside it. P9's grammar admits an optional namespace and
 * an optional disambiguating segment so that assets sharing a code never
 * share an identity:
 *
 * ```
 * USD                      { code: 'USD' }                                   a deployment's fiat currency
 * stable:USDX              { namespace: 'stable', code: 'USDX' }             a stablecoin
 * net:COIN                 { namespace: 'net', code: 'COIN' }                a network's native asset
 * net:USDX/acme-bank       { namespace: 'net', code: 'USDX', qualifier: 'acme-bank' }
 * ```
 *
 * The third segment is called a **qualifier** rather than any rail's word for
 * it: what distinguishes two same-coded assets — an issuing institution, a
 * contract, a program — is the rail's business, and PAY-01 only needs to know
 * that it distinguishes them. No meaning is given to any namespace.
 *
 * Descriptive only. Nothing reads this view to decide anything: authority,
 * comparison and scale stay on the identifier and its registry definition,
 * and two assets are the same asset exactly when their identifiers are equal.
 */
export interface PaymentAssetDescription {
  readonly namespace?: string;
  readonly code: string;
  readonly qualifier?: string;
}

/** The parts of a canonical asset identifier, or `undefined` when it is not one or a segment is empty. */
export function describePaymentAsset(assetId: unknown): PaymentAssetDescription | undefined {
  if (!isCanonicalMonetaryAssetId(assetId)) return undefined;
  const colon = assetId.indexOf(':');
  const namespace = colon === -1 ? undefined : assetId.slice(0, colon);
  const rest = colon === -1 ? assetId : assetId.slice(colon + 1);
  const slash = rest.indexOf('/');
  const code = slash === -1 ? rest : rest.slice(0, slash);
  const qualifier = slash === -1 ? undefined : rest.slice(slash + 1);
  for (const segment of [namespace, code, qualifier]) {
    if (segment !== undefined && (segment.length === 0 || segment.includes(':') || segment.includes('/'))) return undefined;
  }
  return Object.freeze({ ...(namespace !== undefined ? { namespace } : {}), code, ...(qualifier !== undefined ? { qualifier } : {}) });
}
