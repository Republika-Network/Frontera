import { isCanonicalMonetaryAssetId } from '../../../monetary-runtime/index.js';
import { isPaymentRailId, isPaymentReference } from '../../domain/index.js';
import { STRIPE_MAXIMUM_AMOUNT_CENTS, STRIPE_USD_SCALE, centsOfDecimalText } from './stripe-amount.js';
import { isStripeAccountId, isStripeCustomerId, isStripePaymentMethodId } from './stripe-identifiers.js';

/**
 * The trusted configuration of the Stripe rail (PAY-09). Every value is
 * deployment composition — none comes from a payment request, a Stripe
 * response or a webhook. It holds **no secret**: the API key lives only in the
 * enterprise HTTPS adapter's closure (`src/enterprise/stripe-payment-rail/`).
 *
 * ## The one qualified model
 *
 * A **destination charge** on a trusted platform account: one Stripe
 * `PaymentIntent`, `capture_method=automatic`, card only, confirmed
 * off-session with a customer's saved PaymentMethod, the full governed amount
 * transferred to a trusted Stripe Connect connected account
 * (`transfer_data[destination]`, no `transfer_data[amount]`, no
 * `application_fee_amount`, no `on_behalf_of`). No transfers, payouts, refunds,
 * captures or other charge types: those are different financial effects, and
 * a later rail mode can add one deliberately.
 *
 * ## Test mode only
 *
 * `mode` is required and has no default; `'test'` is the only value accepted.
 * There is no live-mode flag in PAY-09 — a live deployment is a future,
 * separately qualified milestone. Live keys are refused again by the HTTPS
 * adapter (`sk_live_` / `rk_live_`), and every Stripe object read is refused
 * unless it says `livemode: false`.
 *
 * ## One currency, scale from configuration
 *
 * `currency` must be `'usd'` and the P9 asset's scale must be 2 — the ISO
 * minor-unit exponent, stated here, never inferred from Stripe. Zero-decimal
 * and three-decimal currencies are not modelled.
 *
 * ## Source and destination are execution configuration, not authority
 *
 * `fundingSources` maps a governed account (`source.accountId`) to the opaque
 * Stripe Customer and PaymentMethod ids the platform charges — never card
 * data. `connectedAccounts` is the allowlist of destinations. Neither grants
 * anything: authority is identity, policy, the P10 ceiling, the grant and the
 * exercise checkpoint, all settled before the rail is reached. Configuration
 * can refuse a governed payment; it can never change its amount or redirect it.
 */

export const STRIPE_RAIL_ID = 'stripe-usd';

/**
 * The Stripe API version every request names in `Stripe-Version` — explicit,
 * never the account default. `2026-09-30.endive`: the current version when
 * PAY-09 was written, and the one `stripe-node` 23.0.0 pins. Its breaking
 * changes were audited for this model (`docs/payments/PAY-09-STRIPE-FIAT-RAIL.md`
 * §4): the one that touches it — `payment_method_types` removed from
 * PaymentIntents — is why the rail sends `allowed_payment_method_types`.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive';

export const STRIPE_MODES = ['test'] as const;
export type StripeMode = (typeof STRIPE_MODES)[number];

export const STRIPE_CURRENCIES = ['usd'] as const;
export type StripeCurrency = (typeof STRIPE_CURRENCIES)[number];

export const STRIPE_CAPTURE_METHODS = ['automatic'] as const;
export type StripeCaptureMethod = (typeof STRIPE_CAPTURE_METHODS)[number];

export const STRIPE_RAIL_LIMITS = Object.freeze({
  /** Per read (account, PaymentIntent) and per create, in milliseconds. */
  requestTimeoutMs: { minimum: 500, maximum: 60_000 },
  /** How long the rail waits for the one confirmation's answer before reporting `unconfirmed`. */
  confirmTimeoutMs: { minimum: 1_000, maximum: 120_000 },
});

export class StripeRailConfigurationError extends Error {
  readonly code = 'STRIPE_RAIL_CONFIGURATION_INVALID';
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Stripe rail configuration '${field}' ${problem}.`);
    this.name = 'StripeRailConfigurationError';
    this.field = field;
  }
}

/** One governed account and the saved Stripe instrument the platform charges for it. Opaque ids only. */
export interface StripeFundingSourceInput {
  /** The governed account (PAY-01 `source.accountId`). */
  readonly accountId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
}

export interface StripeRailConfigurationInput {
  readonly railId?: string;
  readonly mode: StripeMode;
  readonly apiVersion: string;
  /** The platform Stripe account the API key belongs to — verified against the account itself before every reservation. */
  readonly platformAccountId: string;
  readonly currency: StripeCurrency;
  /** The P9 asset id of USD in this deployment's registry, and its scale (2). */
  readonly asset: { readonly paymentAsset: string; readonly scale: number };
  readonly captureMethod: StripeCaptureMethod;
  readonly fundingSources: readonly StripeFundingSourceInput[];
  /** The connected accounts a destination charge may transfer to. */
  readonly connectedAccounts: readonly string[];
  /** Smallest amount the rail sends, in cents (decimal text). Default `'50'` — Stripe's documented USD minimum ($0.50). */
  readonly minimumChargeCents?: string;
  /** Largest amount the rail sends, in cents (decimal text). Default and ceiling: Stripe's eight-digit `amount` (99 999 999). */
  readonly maximumChargeCents?: string;
  readonly requestTimeoutMs?: number;
  readonly confirmTimeoutMs?: number;
}

export interface StripeFundingSource {
  readonly accountId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
}

export interface StripeRailConfiguration {
  readonly railId: string;
  readonly mode: StripeMode;
  readonly apiVersion: string;
  readonly platformAccountId: string;
  readonly currency: StripeCurrency;
  readonly asset: { readonly paymentAsset: string; readonly scale: number };
  readonly captureMethod: StripeCaptureMethod;
  readonly fundingSources: readonly StripeFundingSource[];
  readonly connectedAccounts: readonly string[];
  readonly minimumChargeCents: bigint;
  readonly maximumChargeCents: bigint;
  readonly requestTimeoutMs: number;
  readonly confirmTimeoutMs: number;
}

const BRAND = new WeakSet<object>();

function integerIn(field: string, value: unknown, limits: { readonly minimum: number; readonly maximum: number }, fallback: number): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < limits.minimum || chosen > limits.maximum) {
    throw new StripeRailConfigurationError(field, `must be an integer from ${limits.minimum} to ${limits.maximum}`);
  }
  return chosen;
}

function centsIn(field: string, value: unknown, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  const cents = centsOfDecimalText(value);
  if (cents === undefined || cents <= 0n || cents > STRIPE_MAXIMUM_AMOUNT_CENTS) throw new StripeRailConfigurationError(field, `must be a positive integer cent count as decimal text, at most ${STRIPE_MAXIMUM_AMOUNT_CENTS.toString()}`);
  return cents;
}

/** Validates and freezes the trusted configuration. Throws `StripeRailConfigurationError`, naming the field, never a value. */
export function createStripeRailConfiguration(input: StripeRailConfigurationInput): StripeRailConfiguration {
  if (input === null || typeof input !== 'object') throw new StripeRailConfigurationError('configuration', 'must be an object');
  const railId = input.railId ?? STRIPE_RAIL_ID;
  if (!isPaymentRailId(railId)) throw new StripeRailConfigurationError('railId', 'must be a semantic identifier');
  if (!(STRIPE_MODES as readonly unknown[]).includes(input.mode)) throw new StripeRailConfigurationError('mode', "must be 'test' — there is no default, and live mode is not qualified by PAY-09");
  if (input.apiVersion !== STRIPE_API_VERSION) throw new StripeRailConfigurationError('apiVersion', `must state the pinned Stripe API version '${STRIPE_API_VERSION}' explicitly`);
  if (!isStripeAccountId(input.platformAccountId)) throw new StripeRailConfigurationError('platformAccountId', 'must be the platform Stripe account id (acct_…)');
  if (!(STRIPE_CURRENCIES as readonly unknown[]).includes(input.currency)) throw new StripeRailConfigurationError('currency', "must be 'usd' — the only currency PAY-09 qualifies");
  const asset = input.asset;
  if (asset === null || typeof asset !== 'object' || !isCanonicalMonetaryAssetId(asset.paymentAsset)) throw new StripeRailConfigurationError('asset.paymentAsset', 'must be a canonical P9 asset id');
  if (asset.scale !== STRIPE_USD_SCALE) throw new StripeRailConfigurationError('asset.scale', `must be the registry scale of USD, ${STRIPE_USD_SCALE} (cents)`);
  if (!(STRIPE_CAPTURE_METHODS as readonly unknown[]).includes(input.captureMethod)) throw new StripeRailConfigurationError('captureMethod', "must be 'automatic' — manual capture is not supported");

  const sources: unknown = input.fundingSources;
  if (!Array.isArray(sources) || sources.length === 0) throw new StripeRailConfigurationError('fundingSources', 'must map at least one governed account');
  const fundingSources: StripeFundingSource[] = [];
  for (const [index, raw] of (sources as unknown[]).entries()) {
    const field = `fundingSources[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StripeRailConfigurationError(field, 'must be an object');
    const keys = Object.keys(raw).sort().join(',');
    // Opaque Stripe ids only: anything else — a card number, an expiry, a CVC, a name — is refused by shape, never read.
    if (keys !== 'accountId,customerId,paymentMethodId') throw new StripeRailConfigurationError(field, 'must hold exactly accountId, customerId and paymentMethodId — never card data');
    const source = raw as StripeFundingSourceInput;
    if (!isPaymentReference(source.accountId)) throw new StripeRailConfigurationError(`${field}.accountId`, 'must be a governed account reference');
    if (!isStripeCustomerId(source.customerId)) throw new StripeRailConfigurationError(`${field}.customerId`, 'must be a Stripe Customer id (cus_…)');
    if (!isStripePaymentMethodId(source.paymentMethodId)) throw new StripeRailConfigurationError(`${field}.paymentMethodId`, 'must be a Stripe PaymentMethod id (pm_…)');
    if (fundingSources.some((existing) => existing.accountId === source.accountId)) throw new StripeRailConfigurationError(`${field}.accountId`, 'duplicates another funding source');
    if (fundingSources.some((existing) => existing.paymentMethodId === source.paymentMethodId)) throw new StripeRailConfigurationError(`${field}.paymentMethodId`, 'is already mapped to another governed account');
    fundingSources.push(Object.freeze({ accountId: source.accountId, customerId: source.customerId, paymentMethodId: source.paymentMethodId }));
  }

  const destinations: unknown = input.connectedAccounts;
  if (!Array.isArray(destinations) || destinations.length === 0) throw new StripeRailConfigurationError('connectedAccounts', 'must name at least one connected account');
  const connectedAccounts: string[] = [];
  for (const [index, account] of (destinations as unknown[]).entries()) {
    if (!isStripeAccountId(account)) throw new StripeRailConfigurationError(`connectedAccounts[${index}]`, 'must be a connected account id (acct_…)');
    if (account === input.platformAccountId) throw new StripeRailConfigurationError(`connectedAccounts[${index}]`, 'is the platform account itself — a destination charge pays a connected account');
    if (connectedAccounts.includes(account)) throw new StripeRailConfigurationError(`connectedAccounts[${index}]`, 'duplicates another connected account');
    connectedAccounts.push(account);
  }

  const minimumChargeCents = centsIn('minimumChargeCents', input.minimumChargeCents, 50n);
  const maximumChargeCents = centsIn('maximumChargeCents', input.maximumChargeCents, STRIPE_MAXIMUM_AMOUNT_CENTS);
  if (minimumChargeCents > maximumChargeCents) throw new StripeRailConfigurationError('minimumChargeCents', 'must not exceed maximumChargeCents');
  const L = STRIPE_RAIL_LIMITS;
  const configuration: StripeRailConfiguration = Object.freeze({
    railId,
    mode: input.mode,
    apiVersion: input.apiVersion,
    platformAccountId: input.platformAccountId,
    currency: input.currency,
    asset: Object.freeze({ paymentAsset: asset.paymentAsset, scale: asset.scale }),
    captureMethod: input.captureMethod,
    fundingSources: Object.freeze(fundingSources),
    connectedAccounts: Object.freeze(connectedAccounts),
    minimumChargeCents,
    maximumChargeCents,
    requestTimeoutMs: integerIn('requestTimeoutMs', input.requestTimeoutMs, L.requestTimeoutMs, 10_000),
    confirmTimeoutMs: integerIn('confirmTimeoutMs', input.confirmTimeoutMs, L.confirmTimeoutMs, 30_000),
  });
  BRAND.add(configuration);
  return configuration;
}

/** Whether a value came from `createStripeRailConfiguration` (not merely shaped like it). */
export function isStripeRailConfiguration(value: unknown): value is StripeRailConfiguration {
  return value !== null && typeof value === 'object' && BRAND.has(value);
}

/** The trusted funding source of a governed account, or `undefined` when the account is not mapped. */
export function stripeFundingSourceOf(configuration: StripeRailConfiguration, accountId: string): StripeFundingSource | undefined {
  return configuration.fundingSources.find((source) => source.accountId === accountId);
}
