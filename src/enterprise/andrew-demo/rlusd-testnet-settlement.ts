import {
  createXrplSettlementProfile,
  isXrplClassicAddress,
  isXrplNonStandardCurrencyCode,
  type XrplExecutionAdapterOptions,
  type XrplSettlementProfile,
} from '../execution-adapters/xrpl/index.js';

/**
 * ANDREW-P0-07 — how the Andrew demo settles governed USD on XRPL Testnet.
 *
 * Frontera governs `{ value: "75000", unit: "USD" }`: authority, policy and
 * the USD 100,000 ceiling are all in USD and stay in USD. On XRPL Testnet that
 * governed USD is carried by Ripple's RLUSD token — an **operator-pinned rail
 * representation** with the identical decimal value. There is no rate, no
 * oracle, no arithmetic, and no request field that can choose or change any of
 * it: issuer, currency, destination namespace and network come from here only.
 *
 * Verified 2026-10-04 against Ripple's official RLUSD documentation
 * (docs.ripple.com, "RLUSD on the XRP Ledger"), and independently against
 * xrpl.org's payments guide and Ripple's `xrpl-mpp-sdk` constants:
 *
 * | | value |
 * |---|---|
 * | currency (160-bit) | `524C555344000000000000000000000000000000` — "RLUSD", zero-padded |
 * | Testnet issuer | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |
 * | Mainnet issuer | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` — named here **only so it can be refused** |
 *
 * An XRPL trust line to this issuer is a fact about the ledger, never a
 * Frontera destination approval: a recipient that already trusts RLUSD is
 * still `never-approved` until destination governance approves it, and
 * nothing here or anywhere in the demo derives approval from XRPL state.
 */

export const RLUSD_CURRENCY_CODE = '524C555344000000000000000000000000000000';
export const RLUSD_XRPL_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
/** Mainnet RLUSD. Never configured by this demo; held only so a drifted configuration naming it is refused by name. */
export const RLUSD_XRPL_MAINNET_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

/** The operator's label for XRPL Testnet: the network every submission must be settled on. */
export const ANDREW_XRPL_NETWORK = 'xrpl-testnet';
/**
 * The destination namespace for XRPL Testnet accounts (ANDREW-P0-01: a test
 * network that shares an address space with production is its own
 * namespace). A destination registered and approved as `xrpl.testnet:r…` is
 * a different destination from `xrpl:r…` or `xrpl.mainnet:r…`, so a Testnet
 * approval can never authorize either.
 */
export const ANDREW_XRPL_DESTINATION_NAMESPACE = 'xrpl.testnet';
/** The governed asset. Authority, policy and ceilings are denominated in it. */
export const ANDREW_GOVERNED_ASSET = 'USD';

export interface AndrewSettlementConfiguration {
  readonly network: string;
  readonly destinationNamespace: string;
  readonly governedAsset: string;
  readonly currency: string;
  readonly issuer: string;
}

/** The one settlement this demo supports: governed USD as RLUSD on XRPL Testnet. */
export const ANDREW_TESTNET_RLUSD_SETTLEMENT: AndrewSettlementConfiguration = Object.freeze({
  network: ANDREW_XRPL_NETWORK,
  destinationNamespace: ANDREW_XRPL_DESTINATION_NAMESPACE,
  governedAsset: ANDREW_GOVERNED_ASSET,
  currency: RLUSD_CURRENCY_CODE,
  issuer: RLUSD_XRPL_TESTNET_ISSUER,
});

export class AndrewSettlementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AndrewSettlementConfigurationError';
  }
}

function refuse(message: string): never {
  throw new AndrewSettlementConfigurationError(message);
}

/**
 * Validate a settlement configuration against the one the demo supports and
 * return a frozen copy. Every field must be exactly the Testnet RLUSD value:
 * a Mainnet issuer, another network or namespace, another currency or another
 * governed asset is configuration drift and refuses startup — the demo never
 * runs half on one network and half on another. Messages name the defect and
 * never echo a value.
 */
export function assertAndrewSettlement(configuration: AndrewSettlementConfiguration = ANDREW_TESTNET_RLUSD_SETTLEMENT): AndrewSettlementConfiguration {
  const { network, destinationNamespace, governedAsset, currency, issuer } = configuration;
  if (network !== ANDREW_XRPL_NETWORK) refuse('The Andrew demo settles on XRPL Testnet only; the configured network is another one.');
  if (destinationNamespace !== ANDREW_XRPL_DESTINATION_NAMESPACE) refuse('XRPL Testnet destinations must use the Testnet destination namespace; the configured namespace would let one network approve another.');
  if (governedAsset !== ANDREW_GOVERNED_ASSET) refuse('The Andrew demo governs USD; another governed asset cannot use the RLUSD representation.');
  if (!isXrplNonStandardCurrencyCode(currency) || currency !== RLUSD_CURRENCY_CODE) refuse('The configured currency is not the RLUSD 160-bit currency code.');
  if (issuer === RLUSD_XRPL_MAINNET_ISSUER) refuse('The configured issuer is the XRPL Mainnet RLUSD issuer; a Testnet deployment must not name it.');
  if (!isXrplClassicAddress(issuer) || issuer !== RLUSD_XRPL_TESTNET_ISSUER) refuse('The configured issuer is not the XRPL Testnet RLUSD issuer.');
  return Object.freeze({ network, destinationNamespace, governedAsset, currency, issuer });
}

/** The XRPL adapter options for a validated settlement: one pinned mapping, the Testnet namespace, the network label. */
export function andrewXrplAdapterOptions(adapterId: string, configuration: AndrewSettlementConfiguration = ANDREW_TESTNET_RLUSD_SETTLEMENT): XrplExecutionAdapterOptions {
  const settlement = assertAndrewSettlement(configuration);
  return {
    adapterId,
    namespace: settlement.destinationNamespace,
    network: settlement.network,
    assets: [{ assetId: settlement.governedAsset, representation: { kind: 'pinned', denominates: settlement.governedAsset, currency: settlement.currency, issuer: settlement.issuer } }],
  };
}

/** The transport-side profile for the same settlement: what a transport connected to XRPL Testnet may deliver. */
export function andrewSettlementProfile(configuration: AndrewSettlementConfiguration = ANDREW_TESTNET_RLUSD_SETTLEMENT): XrplSettlementProfile {
  const settlement = assertAndrewSettlement(configuration);
  return createXrplSettlementProfile({ network: settlement.network, tokens: [{ currency: settlement.currency, issuer: settlement.issuer }] });
}
