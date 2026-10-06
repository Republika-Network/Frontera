import { isValidClassicAddress } from 'xrpl';

import { XrplTransportConfigurationError } from './contracts.js';

/**
 * The transport's trusted configuration, validated once at construction.
 *
 * Verified 2026-10-04 against xrpl.org: Testnet WebSocket
 * `wss://s.altnet.rippletest.net:51233/`, JSON-RPC
 * `https://s.altnet.rippletest.net:51234/`, network ID 1 (Mainnet 0, Devnet 2).
 * The endpoint itself always comes from runtime configuration; the documented
 * value is a default a deployment may confirm, never a fallback.
 *
 * Testnet only. A Mainnet endpoint is refused by host, and — the binding check
 * — every connection must report `network_id` 1 or nothing is prepared.
 */

export const XRPL_TESTNET_NETWORK_ID = 1;
export const XRPL_TESTNET_DOCUMENTED_ENDPOINT = 'wss://s.altnet.rippletest.net:51233/';
export const XRPL_TESTNET_NETWORK_LABEL = 'xrpl-testnet';
/** XRPL reliable-submission guidance: automated processes use the last validated ledger + 4. */
export const DEFAULT_LEDGER_HORIZON = 4;
/** Refuse to sign unless the grant has at least this long left: ~4 ledgers close in well under a minute, plus margin. */
export const DEFAULT_MINIMUM_GRANT_REMAINING_MS = 120_000;
/** Refuse a prepared fee above this many drops (Testnet base fee is 10). */
export const DEFAULT_MAXIMUM_FEE_DROPS = 5_000n;
/** How long to wait for a validated outcome before reporting `unconfirmed`. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 120_000;

/** Hosts of the XRPL Mainnet public servers. A Testnet transport refuses them outright. */
const MAINNET_HOSTS = ['s1.ripple.com', 's2.ripple.com', 'xrplcluster.com', 'xrpl.ws', 'xrpl.link'];

export interface XrplTestnetTransportConfiguration {
  /** `wss://…` from runtime configuration. */
  readonly endpoint: string;
  /** Must equal the adapter's network label on every submission. */
  readonly networkLabel: string;
  readonly expectedNetworkId: number;
  /** The treasury: the only account this transport prepares transactions for. Must be the signer's account. */
  readonly sourceAccount: string;
  /** Issuers the source account must never be (the RLUSD issuer). */
  readonly forbiddenSourceAccounts: readonly string[];
  readonly ledgerHorizon: number;
  readonly minimumGrantRemainingMs: number;
  readonly maximumFeeDrops: bigint;
  readonly validationTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export type XrplTestnetTransportConfigurationInput = Pick<XrplTestnetTransportConfiguration, 'endpoint' | 'sourceAccount'> &
  Partial<Omit<XrplTestnetTransportConfiguration, 'endpoint' | 'sourceAccount'>>;

function refuse(message: string): never {
  throw new XrplTransportConfigurationError(message);
}

export function isMainnetEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return MAINNET_HOSTS.some((mainnet) => host === mainnet || host.endsWith(`.${mainnet}`));
  } catch {
    return false;
  }
}

export function resolveXrplTestnetConfiguration(input: XrplTestnetTransportConfigurationInput): XrplTestnetTransportConfiguration {
  const endpoint = input.endpoint;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return refuse('The XRPL endpoint is not a URL.');
  }
  if (parsed.protocol !== 'wss:') refuse('The XRPL endpoint must be a wss:// WebSocket endpoint.');
  if (parsed.username !== '' || parsed.password !== '') refuse('The XRPL endpoint must not carry credentials.');
  if (isMainnetEndpoint(endpoint)) refuse('The XRPL endpoint is a Mainnet server; this transport is Testnet-only.');
  const networkLabel = input.networkLabel ?? XRPL_TESTNET_NETWORK_LABEL;
  if (networkLabel !== XRPL_TESTNET_NETWORK_LABEL) refuse('This transport settles on XRPL Testnet only.');
  const expectedNetworkId = input.expectedNetworkId ?? XRPL_TESTNET_NETWORK_ID;
  if (expectedNetworkId !== XRPL_TESTNET_NETWORK_ID) refuse('This transport requires the XRPL Testnet network id.');
  if (!isValidClassicAddress(input.sourceAccount)) refuse('The source account is not a valid XRPL classic address.');
  const forbiddenSourceAccounts = input.forbiddenSourceAccounts ?? [];
  if (forbiddenSourceAccounts.includes(input.sourceAccount)) refuse('The source account is an issuer; paying from the issuer is not part of this design.');
  const ledgerHorizon = input.ledgerHorizon ?? DEFAULT_LEDGER_HORIZON;
  if (!Number.isInteger(ledgerHorizon) || ledgerHorizon < 1 || ledgerHorizon > 20) refuse('The ledger horizon must be 1 to 20 ledgers.');
  const minimumGrantRemainingMs = input.minimumGrantRemainingMs ?? DEFAULT_MINIMUM_GRANT_REMAINING_MS;
  if (!Number.isInteger(minimumGrantRemainingMs) || minimumGrantRemainingMs < 30_000) refuse('The minimum remaining grant lifetime must be at least 30 seconds.');
  const maximumFeeDrops = input.maximumFeeDrops ?? DEFAULT_MAXIMUM_FEE_DROPS;
  if (maximumFeeDrops <= 0n) refuse('The maximum fee must be positive.');
  const validationTimeoutMs = input.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  return Object.freeze({
    endpoint,
    networkLabel,
    expectedNetworkId,
    sourceAccount: input.sourceAccount,
    forbiddenSourceAccounts: Object.freeze([...forbiddenSourceAccounts]),
    ledgerHorizon,
    minimumGrantRemainingMs,
    maximumFeeDrops,
    validationTimeoutMs,
    pollIntervalMs,
  });
}
