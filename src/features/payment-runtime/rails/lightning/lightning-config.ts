import { isCanonicalMonetaryAssetId } from '../../../monetary-runtime/index.js';
import { isPaymentRailId, isPaymentReference } from '../../domain/index.js';
import { BOLT11_ABSOLUTE_MAXIMUM_LENGTH, LIGHTNING_NETWORKS, type LightningNetwork } from './lightning-bolt11.js';
import { LIGHTNING_MAXIMUM_MSAT, msatOfDecimalText } from './lightning-amount.js';

/**
 * The trusted configuration of the Lightning rail (PAY-06). Every value is
 * deployment composition — none comes from a payment request, an invoice or a
 * node answer.
 *
 * ## Network (fail closed)
 *
 * `network` is required and has no default. `mainnet` is refused unless
 * `allowMainnet: true` is stated beside it (PAY-02's posture); the
 * qualification networks are `regtest`, `signet` and `testnet`.
 *
 * ## One asset
 *
 * Lightning moves BTC. `asset` is the deployment's P9 asset id for BTC, whose
 * registry scale must be at most 11 (one millisatoshi) — a payment in any
 * other asset is refused by the rail before anything is contacted. No FX, no
 * conversion, no exchange rate.
 *
 * ## Routing-fee policy (trusted, exact)
 *
 * The amount a governed payment states is what the **payee receives**. The
 * routing fee is a separate execution cost, capped before the payment by
 *
 * ```
 * feeLimitMsat = min(maximumFeeMsat, ⌊amountMsat × maximumFeePpm / 1 000 000⌋)
 * ```
 *
 * (either bound may be omitted; at least one is required) — integer
 * arithmetic only. The cap is handed to the node as its hard limit **before**
 * the send and checked again on every answer after it. An invoice can never
 * raise it.
 */

export const LIGHTNING_RAIL_ID = 'lightning-btc';

export const LIGHTNING_RAIL_LIMITS = Object.freeze({
  /** LND's own pathfinding timeout for the one payment (`timeout_seconds`). */
  paymentTimeoutSeconds: { minimum: 5, maximum: 600 },
  /** Per node request (reads), in milliseconds. */
  requestTimeoutMs: { minimum: 500, maximum: 60_000 },
  /** How much longer than `paymentTimeoutSeconds` the rail waits for the node's final answer before reporting `unconfirmed`. */
  finalityGraceMs: { minimum: 1_000, maximum: 120_000 },
  /** An invoice must still be valid this long after the check, so it cannot expire in the node's hands during routing. */
  minimumExpiryMarginSeconds: { minimum: 0, maximum: 3_600 },
  /** How far an invoice's timestamp may sit in the future of this host's clock. */
  maximumClockSkewSeconds: { minimum: 0, maximum: 3_600 },
  /** The largest `min_final_cltv_expiry_delta` accepted (blocks). Anything above is an absurd lock-up of funds. */
  maximumFinalCltvExpiryDelta: { minimum: 18, maximum: 2_016 },
  maximumInvoiceLength: { minimum: 128, maximum: BOLT11_ABSOLUTE_MAXIMUM_LENGTH },
  maximumFeePpm: { minimum: 0, maximum: 1_000_000 },
});

export class LightningRailConfigurationError extends Error {
  readonly code = 'LIGHTNING_RAIL_CONFIGURATION_INVALID';
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Lightning rail configuration '${field}' ${problem}.`);
    this.name = 'LightningRailConfigurationError';
    this.field = field;
  }
}

export interface LightningRailConfigurationInput {
  readonly railId?: string;
  readonly network: LightningNetwork;
  readonly allowMainnet?: boolean;
  /** The P9 asset id of BTC in this deployment's registry, and its scale. */
  readonly asset: { readonly paymentAsset: string; readonly scale: number };
  /** The governed accounts (PAY-01 `source.accountId`) this node pays from. */
  readonly sourceAccounts: readonly string[];
  readonly fees: { readonly maximumFeeMsat?: string; readonly maximumFeePpm?: number };
  readonly paymentTimeoutSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly finalityGraceMs?: number;
  readonly minimumExpiryMarginSeconds?: number;
  readonly maximumClockSkewSeconds?: number;
  readonly maximumFinalCltvExpiryDelta?: number;
  readonly maximumInvoiceLength?: number;
}

export interface LightningRailConfiguration {
  readonly railId: string;
  readonly network: LightningNetwork;
  readonly asset: { readonly paymentAsset: string; readonly scale: number };
  readonly sourceAccounts: readonly string[];
  readonly fees: { readonly maximumFeeMsat?: bigint; readonly maximumFeePpm?: number };
  readonly paymentTimeoutSeconds: number;
  readonly requestTimeoutMs: number;
  readonly finalityGraceMs: number;
  readonly minimumExpiryMarginSeconds: number;
  readonly maximumClockSkewSeconds: number;
  readonly maximumFinalCltvExpiryDelta: number;
  readonly maximumInvoiceLength: number;
}

const BRAND = new WeakSet<object>();

function integerIn(field: string, value: unknown, limits: { readonly minimum: number; readonly maximum: number }, fallback: number): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < limits.minimum || chosen > limits.maximum) {
    throw new LightningRailConfigurationError(field, `must be an integer from ${limits.minimum} to ${limits.maximum}`);
  }
  return chosen;
}

/** Validates and freezes the trusted configuration. Throws `LightningRailConfigurationError`, naming the field, never a value. */
export function createLightningRailConfiguration(input: LightningRailConfigurationInput): LightningRailConfiguration {
  if (input === null || typeof input !== 'object') throw new LightningRailConfigurationError('configuration', 'must be an object');
  const railId = input.railId ?? LIGHTNING_RAIL_ID;
  if (!isPaymentRailId(railId)) throw new LightningRailConfigurationError('railId', 'must be a semantic identifier');
  if (!LIGHTNING_NETWORKS.includes(input.network)) throw new LightningRailConfigurationError('network', `must be one of ${LIGHTNING_NETWORKS.join(', ')} — there is no default`);
  if (input.allowMainnet !== undefined && typeof input.allowMainnet !== 'boolean') throw new LightningRailConfigurationError('allowMainnet', 'must be a boolean');
  if (input.network === 'mainnet' && input.allowMainnet !== true) throw new LightningRailConfigurationError('network', "is 'mainnet', which needs allowMainnet: true stated explicitly");
  const asset = input.asset;
  if (asset === null || typeof asset !== 'object' || !isCanonicalMonetaryAssetId(asset.paymentAsset)) throw new LightningRailConfigurationError('asset.paymentAsset', 'must be a canonical P9 asset id');
  if (!Number.isSafeInteger(asset.scale) || asset.scale < 0 || asset.scale > 11) throw new LightningRailConfigurationError('asset.scale', 'must be the registry scale of BTC, at most 11 (one millisatoshi)');
  const accounts: unknown = input.sourceAccounts;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new LightningRailConfigurationError('sourceAccounts', 'must name at least one governed account');
  const sourceAccounts: string[] = [];
  for (const [index, account] of (accounts as unknown[]).entries()) {
    if (!isPaymentReference(account)) throw new LightningRailConfigurationError(`sourceAccounts[${index}]`, 'must be a governed account reference');
    if (sourceAccounts.includes(account)) throw new LightningRailConfigurationError(`sourceAccounts[${index}]`, 'duplicates another account');
    sourceAccounts.push(account);
  }
  const fees = input.fees;
  if (fees === null || typeof fees !== 'object') throw new LightningRailConfigurationError('fees', 'must state a routing-fee bound');
  let maximumFeeMsat: bigint | undefined;
  if (fees.maximumFeeMsat !== undefined) {
    maximumFeeMsat = msatOfDecimalText(fees.maximumFeeMsat);
    if (maximumFeeMsat === undefined || maximumFeeMsat > LIGHTNING_MAXIMUM_MSAT) throw new LightningRailConfigurationError('fees.maximumFeeMsat', 'must be a non-negative integer millisatoshi count as decimal text');
  }
  let maximumFeePpm: number | undefined;
  if (fees.maximumFeePpm !== undefined) maximumFeePpm = integerIn('fees.maximumFeePpm', fees.maximumFeePpm, LIGHTNING_RAIL_LIMITS.maximumFeePpm, 0);
  if (maximumFeeMsat === undefined && maximumFeePpm === undefined) throw new LightningRailConfigurationError('fees', 'must state maximumFeeMsat, maximumFeePpm or both — there is no unbounded fee');
  const L = LIGHTNING_RAIL_LIMITS;
  const configuration: LightningRailConfiguration = Object.freeze({
    railId,
    network: input.network,
    asset: Object.freeze({ paymentAsset: asset.paymentAsset, scale: asset.scale }),
    sourceAccounts: Object.freeze(sourceAccounts),
    fees: Object.freeze({ ...(maximumFeeMsat !== undefined ? { maximumFeeMsat } : {}), ...(maximumFeePpm !== undefined ? { maximumFeePpm } : {}) }),
    paymentTimeoutSeconds: integerIn('paymentTimeoutSeconds', input.paymentTimeoutSeconds, L.paymentTimeoutSeconds, 60),
    requestTimeoutMs: integerIn('requestTimeoutMs', input.requestTimeoutMs, L.requestTimeoutMs, 10_000),
    finalityGraceMs: integerIn('finalityGraceMs', input.finalityGraceMs, L.finalityGraceMs, 15_000),
    minimumExpiryMarginSeconds: integerIn('minimumExpiryMarginSeconds', input.minimumExpiryMarginSeconds, L.minimumExpiryMarginSeconds, 60),
    maximumClockSkewSeconds: integerIn('maximumClockSkewSeconds', input.maximumClockSkewSeconds, L.maximumClockSkewSeconds, 600),
    maximumFinalCltvExpiryDelta: integerIn('maximumFinalCltvExpiryDelta', input.maximumFinalCltvExpiryDelta, L.maximumFinalCltvExpiryDelta, 1_008),
    maximumInvoiceLength: integerIn('maximumInvoiceLength', input.maximumInvoiceLength, L.maximumInvoiceLength, 2_048),
  });
  BRAND.add(configuration);
  return configuration;
}

/** Whether a value came from `createLightningRailConfiguration` (not merely shaped like it). */
export function isLightningRailConfiguration(value: unknown): value is LightningRailConfiguration {
  return value !== null && typeof value === 'object' && BRAND.has(value);
}

/**
 * The trusted routing-fee cap for one payment, in millisatoshis — exact,
 * integer, from configuration and the governed amount only. Never from an
 * invoice.
 */
export function lightningFeeLimitMsat(configuration: LightningRailConfiguration, amountMsat: bigint): bigint {
  const absolute = configuration.fees.maximumFeeMsat;
  const ppm = configuration.fees.maximumFeePpm;
  const proportional = ppm === undefined ? undefined : (amountMsat * BigInt(ppm)) / 1_000_000n;
  if (absolute === undefined) return proportional ?? 0n;
  if (proportional === undefined) return absolute;
  return absolute < proportional ? absolute : proportional;
}
