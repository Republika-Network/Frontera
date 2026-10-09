import { isCanonicalMonetaryAssetId } from '../../../monetary-runtime/index.js';
import { isPaymentRailId, isPaymentReference } from '../../domain/index.js';
import { isXrplClassicAddress } from './xrpl-address.js';

/**
 * Trusted configuration of the XRPL / RLUSD payment rail (PAY-02).
 *
 * Every value here is host composition — never request data. A payment names
 * a governed account id, a destination and a P9 amount; which ledger, which
 * issuer, which currency code and which XRPL account act for that governed
 * account are decided here, once, at composition, and validated before the
 * rail can be built. Nothing a `PaymentExecutionRequest` carries can widen or
 * override any of it.
 *
 * | field | class | meaning |
 * | --- | --- | --- |
 * | `network` | REQUIRED | `testnet`, `devnet` or `mainnet`. No default. |
 * | `allowMainnet` | REQUIRED for mainnet | Must be `true` exactly when `network` is `mainnet`; refused otherwise. |
 * | `endpoint` | REQUIRED | `wss://` URL of the XRPL server. No credentials, query or fragment. |
 * | `asset.paymentAsset` | REQUIRED | The P9 asset id a payment must be denominated in. Compared exactly. |
 * | `asset.currency` | REQUIRED | The XRPL currency code: 3 characters, or 40 hex digits (RLUSD's is the latter). |
 * | `asset.issuer` | REQUIRED | The issuing account's classic address for the selected network. |
 * | `sourceAccounts` | REQUIRED | `{ accountId, address }` — governed account id → XRPL account. 1 … 64 entries. |
 * | `lastLedgerOffset` | OPTIONAL (20) | Ledgers after the current validated ledger in which the transaction may be included. |
 * | `maxFeeDrops` | OPTIONAL (`'1000'`) | Ceiling on the network fee the rail will sign, in drops. |
 * | `requestTimeoutMs` | OPTIONAL (10 000) | Per-request timeout of the SDK client. |
 * | `finalityTimeoutMs` | OPTIONAL (120 000) | How long the rail waits for a validated result before reporting `unconfirmed`. |
 * | `pollIntervalMs` | OPTIONAL (4 000) | Delay between validated-result lookups. |
 * | `networkId` | DERIVED | 0 / 1 / 2 — what the server must report before anything is prepared. |
 *
 * There is no SECRET field. Signing capability is composed separately as an
 * `XrplTransactionSigner` (`xrpl-client-port.ts`); no seed, key or token is
 * ever configuration here, and nothing below echoes a configured value in an
 * error message.
 */
export interface XrplRlusdRailConfigurationInput {
  readonly railId?: string;
  readonly network: string;
  readonly allowMainnet?: boolean;
  readonly endpoint: string;
  readonly asset: { readonly paymentAsset: string; readonly currency: string; readonly issuer: string };
  readonly sourceAccounts: readonly { readonly accountId: string; readonly address: string }[];
  readonly lastLedgerOffset?: number;
  readonly maxFeeDrops?: string;
  readonly requestTimeoutMs?: number;
  readonly finalityTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export type XrplNetwork = 'testnet' | 'devnet' | 'mainnet';

export interface XrplRlusdRailConfiguration {
  readonly railId: string;
  readonly network: XrplNetwork;
  /** The `network_id` the connected server must report (`server_info`). */
  readonly networkId: number;
  readonly endpoint: string;
  readonly asset: { readonly paymentAsset: string; readonly currency: string; readonly issuer: string };
  /** Governed account id → classic address. Unique on both sides; frozen. */
  readonly sourceAccounts: readonly { readonly accountId: string; readonly address: string }[];
  readonly lastLedgerOffset: number;
  readonly maxFeeDrops: string;
  readonly requestTimeoutMs: number;
  readonly finalityTimeoutMs: number;
  readonly pollIntervalMs: number;
}

/** The one canonical rail id. A payment's `rail` preference names it; trusted routing selects it. */
export const XRPL_RLUSD_RAIL_ID = 'xrpl-rlusd';

/**
 * The networks this rail knows, with the `network_id` each one's servers
 * report. There is no default: a configuration that does not name its
 * network is refused, so nothing can fall through to mainnet.
 */
export const XRPL_NETWORK_IDS: Readonly<Record<XrplNetwork, number>> = Object.freeze({ mainnet: 0, testnet: 1, devnet: 2 });

/**
 * Public hostnames whose network is known. **Not defaults** — the rail ships
 * no endpoint. They exist only to refuse a contradiction (a `testnet`
 * configuration pointed at a mainnet host); the server's own `network_id` is
 * the authoritative check at connection time.
 */
const KNOWN_HOSTS: Readonly<Record<XrplNetwork, readonly string[]>> = Object.freeze({
  mainnet: Object.freeze(['xrplcluster.com', 'xrpl.ws', 's1.ripple.com', 's2.ripple.com']),
  testnet: Object.freeze(['s.altnet.rippletest.net', 'testnet.xrpl-labs.com']),
  devnet: Object.freeze(['s.devnet.rippletest.net']),
});

export const XRPL_RAIL_LIMITS = Object.freeze({
  maximumSourceAccounts: 64,
  maximumEndpointLength: 256,
  lastLedgerOffset: Object.freeze({ minimum: 4, maximum: 200, default: 20 }),
  maxFeeDrops: Object.freeze({ maximum: 1_000_000n, default: '1000' }),
  requestTimeoutMs: Object.freeze({ minimum: 1_000, maximum: 60_000, default: 10_000 }),
  finalityTimeoutMs: Object.freeze({ minimum: 5_000, maximum: 900_000, default: 120_000 }),
  pollIntervalMs: Object.freeze({ minimum: 250, maximum: 30_000, default: 4_000 }),
});

/**
 * Every configuration `createXrplRlusdRailConfiguration` produced — and only
 * those. Module-private and unforgeable: a structurally identical object an
 * embedder built (and froze) by hand is not in it, so it cannot skip the
 * factory's checks — `allowMainnet` above all (review P1).
 */
const VALIDATED_CONFIGURATIONS = new WeakSet<object>();

/** Whether a value is a configuration this module's factory validated. The rail and the SDK client accept nothing else. */
export function isXrplRlusdRailConfiguration(value: unknown): value is XrplRlusdRailConfiguration {
  return value !== null && typeof value === 'object' && VALIDATED_CONFIGURATIONS.has(value);
}

export class XrplRailConfigurationError extends Error {
  readonly code: 'XRPL_RAIL_CONFIGURATION_INVALID';
  /** The configuration path refused. Never the value. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`XRPL rail configuration '${field}': ${message}`);
    this.name = 'XrplRailConfigurationError';
    this.code = 'XRPL_RAIL_CONFIGURATION_INVALID';
    this.field = field;
  }
}

const refuse = (field: string, message: string): never => {
  throw new XrplRailConfigurationError(field, message);
};

/** A 3-character standard code other than `XRP`, or a 160-bit non-standard code in uppercase hex that does not begin with a zero byte (which would read as a standard code). */
const STANDARD_CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CURRENCY = /^(?!00)[0-9A-F]{40}$/;

export function isXrplCurrencyCode(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (HEX_CURRENCY.test(value)) return true;
  return STANDARD_CURRENCY.test(value) && value.toUpperCase() !== 'XRP';
}

function isNetwork(value: unknown): value is XrplNetwork {
  return value === 'testnet' || value === 'devnet' || value === 'mainnet';
}

function readEndpoint(value: unknown, network: XrplNetwork): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > XRPL_RAIL_LIMITS.maximumEndpointLength || value !== value.trim()) {
    return refuse('endpoint', 'must be a non-empty wss:// URL of bounded length');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('endpoint', 'must be a wss:// URL');
  }
  if (url.protocol !== 'wss:') refuse('endpoint', 'must use wss://');
  if (url.username !== '' || url.password !== '') refuse('endpoint', 'must not carry credentials');
  if (url.search !== '' || url.hash !== '') refuse('endpoint', 'must not carry a query or fragment');
  if (url.hostname === '') refuse('endpoint', 'must name a host');
  const host = url.hostname.toLowerCase();
  for (const other of Object.keys(KNOWN_HOSTS) as XrplNetwork[]) {
    if (other !== network && KNOWN_HOSTS[other].includes(host)) refuse('endpoint', `is a known ${other} host, which contradicts the configured network`);
  }
  return value;
}

function readInteger(value: unknown, field: string, bounds: { readonly minimum: number; readonly maximum: number; readonly default: number }): number {
  if (value === undefined) return bounds.default;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    return refuse(field, `must be an integer between ${bounds.minimum} and ${bounds.maximum}`);
  }
  return value;
}

function readFeeCeiling(value: unknown): string {
  if (value === undefined) return XRPL_RAIL_LIMITS.maxFeeDrops.default;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,6}$/.test(value) || BigInt(value) > XRPL_RAIL_LIMITS.maxFeeDrops.maximum) {
    return refuse('maxFeeDrops', `must be a whole number of drops between 1 and ${XRPL_RAIL_LIMITS.maxFeeDrops.maximum}, as text`);
  }
  return value;
}

function readRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse(field, 'must be an object');
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Validates and freezes the rail configuration, or throws
 * `XrplRailConfigurationError`. Composition-time and pure: it opens no
 * connection — the server's network identity is checked when the rail
 * connects (`readiness`, and before every preparation).
 */
export function createXrplRlusdRailConfiguration(input: XrplRlusdRailConfigurationInput): XrplRlusdRailConfiguration {
  const raw = readRecord(input, '');

  const railId = raw['railId'] ?? XRPL_RLUSD_RAIL_ID;
  if (!isPaymentRailId(railId)) refuse('railId', 'must be a semantic identifier');

  const network = raw['network'];
  if (!isNetwork(network)) return refuse('network', "must be exactly 'testnet', 'devnet' or 'mainnet'");
  const allowMainnet = raw['allowMainnet'];
  if (allowMainnet !== undefined && typeof allowMainnet !== 'boolean') refuse('allowMainnet', 'must be a boolean');
  if (network === 'mainnet' && allowMainnet !== true) refuse('allowMainnet', 'mainnet requires an explicit allowMainnet: true');
  if (network !== 'mainnet' && allowMainnet === true) refuse('allowMainnet', 'is set for a non-mainnet network, which is contradictory');

  const endpoint = readEndpoint(raw['endpoint'], network);

  const asset = readRecord(raw['asset'], 'asset');
  for (const key of Object.keys(asset)) if (key !== 'paymentAsset' && key !== 'currency' && key !== 'issuer') refuse(`asset.${key.slice(0, 32)}`, 'is not a declared field');
  const paymentAsset = asset['paymentAsset'];
  const currency = asset['currency'];
  const issuer = asset['issuer'];
  if (!isCanonicalMonetaryAssetId(paymentAsset)) refuse('asset.paymentAsset', 'must be a canonical P9 asset identifier');
  if (!isXrplCurrencyCode(currency)) refuse('asset.currency', 'must be a 3-character code other than XRP, or 40 uppercase hex digits');
  if (!isXrplClassicAddress(issuer)) refuse('asset.issuer', 'must be a valid XRPL classic address');

  const sources = raw['sourceAccounts'];
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > XRPL_RAIL_LIMITS.maximumSourceAccounts) {
    return refuse('sourceAccounts', `must list between 1 and ${XRPL_RAIL_LIMITS.maximumSourceAccounts} source account mappings`);
  }
  const sourceAccounts = new Map<string, string>();
  const addresses = new Set<string>();
  sources.forEach((entry: unknown, index: number) => {
    const field = `sourceAccounts[${index}]`;
    const mapping = readRecord(entry, field);
    for (const key of Object.keys(mapping)) if (key !== 'accountId' && key !== 'address') refuse(field, 'carries an undeclared field');
    const accountId = mapping['accountId'];
    const address = mapping['address'];
    if (!isPaymentReference(accountId)) refuse(`${field}.accountId`, 'must be a payment account reference');
    if (!isXrplClassicAddress(address)) refuse(`${field}.address`, 'must be a valid XRPL classic address');
    if (address === issuer) refuse(`${field}.address`, 'is the asset issuer; the issuer is never a payment source');
    if (sourceAccounts.has(accountId as string)) refuse(`${field}.accountId`, 'is mapped twice');
    if (addresses.has(address as string)) refuse(`${field}.address`, 'is mapped from two account ids');
    sourceAccounts.set(accountId as string, address as string);
    addresses.add(address as string);
  });

  const finalityTimeoutMs = readInteger(raw['finalityTimeoutMs'], 'finalityTimeoutMs', XRPL_RAIL_LIMITS.finalityTimeoutMs);
  const pollIntervalMs = readInteger(raw['pollIntervalMs'], 'pollIntervalMs', XRPL_RAIL_LIMITS.pollIntervalMs);
  if (pollIntervalMs >= finalityTimeoutMs) refuse('pollIntervalMs', 'must be shorter than finalityTimeoutMs');

  const configuration: XrplRlusdRailConfiguration = Object.freeze({
    railId: railId as string,
    network,
    networkId: XRPL_NETWORK_IDS[network],
    endpoint,
    asset: Object.freeze({ paymentAsset: paymentAsset as string, currency: currency as string, issuer: issuer as string }),
    sourceAccounts: Object.freeze([...sourceAccounts].map(([accountId, address]) => Object.freeze({ accountId, address }))),
    lastLedgerOffset: readInteger(raw['lastLedgerOffset'], 'lastLedgerOffset', XRPL_RAIL_LIMITS.lastLedgerOffset),
    maxFeeDrops: readFeeCeiling(raw['maxFeeDrops']),
    requestTimeoutMs: readInteger(raw['requestTimeoutMs'], 'requestTimeoutMs', XRPL_RAIL_LIMITS.requestTimeoutMs),
    finalityTimeoutMs,
    pollIntervalMs,
  });
  VALIDATED_CONFIGURATIONS.add(configuration);
  return configuration;
}
