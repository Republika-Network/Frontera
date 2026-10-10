import type { PaymentExecutionRequest } from '../../domain/index.js';
import { parseXrplDestination } from './xrpl-address.js';
import { xrplIssuedValueOf } from './xrpl-amount.js';
import type { XrplRlusdRailConfiguration } from './xrpl-config.js';
import type { XrplPaymentTransaction } from './xrpl-client-port.js';
import { XRPL_RAIL_DETAILS, type XrplRailDetail } from './xrpl-rail-details.js';

export type XrplPaymentBuild = { readonly built: true; readonly transaction: Omit<XrplPaymentTransaction, 'LastLedgerSequence'> } | { readonly built: false; readonly detail: XrplRailDetail };

/**
 * Builds the XRPL Payment for a granted payment — pure, total, deterministic.
 *
 * Every field comes from exactly one place:
 *
 * | XRPL field | source |
 * | --- | --- |
 * | `TransactionType` | constant `Payment` |
 * | `Account` | trusted configuration: the source mapping for `request.source.accountId` |
 * | `Destination`, `DestinationTag` | the granted counterparty (`request.destination`), parsed |
 * | `Amount.value` | `request.amount.value`, unchanged, proven exactly representable |
 * | `Amount.currency`, `Amount.issuer` | trusted configuration — never the request |
 * | `Flags` | constant 0 |
 *
 * `LastLedgerSequence`, `Sequence` and `Fee` are added by the rail's trusted
 * preparation. No memo, path, `SendMax`, source tag, or caller-chosen field
 * exists: the request has nothing that could supply one.
 *
 * Refusals here happen before any contact with the ledger, so they are
 * definitive.
 */
export function buildXrplPayment(request: PaymentExecutionRequest, configuration: XrplRlusdRailConfiguration): XrplPaymentBuild {
  if (request.amount.unit !== configuration.asset.paymentAsset) return { built: false, detail: XRPL_RAIL_DETAILS.ASSET_NOT_CONFIGURED };
  const account = configuration.sourceAccounts.find((mapping) => mapping.accountId === request.source.accountId)?.address;
  if (account === undefined) return { built: false, detail: XRPL_RAIL_DETAILS.SOURCE_NOT_MAPPED };
  const destination = parseXrplDestination(request.destination);
  if (destination === undefined) return { built: false, detail: XRPL_RAIL_DETAILS.DESTINATION_INVALID };
  if (destination.address === account) return { built: false, detail: XRPL_RAIL_DETAILS.DESTINATION_IS_SOURCE };
  if (destination.address === configuration.asset.issuer) return { built: false, detail: XRPL_RAIL_DETAILS.DESTINATION_IS_ISSUER };
  const value = xrplIssuedValueOf(request.amount.value);
  if (value === undefined) return { built: false, detail: XRPL_RAIL_DETAILS.AMOUNT_NOT_REPRESENTABLE };
  return {
    built: true,
    transaction: Object.freeze({
      TransactionType: 'Payment',
      Account: account,
      Destination: destination.address,
      ...(destination.tag !== undefined ? { DestinationTag: destination.tag } : {}),
      Amount: Object.freeze({ currency: configuration.asset.currency, issuer: configuration.asset.issuer, value }),
      Flags: 0,
    }),
  };
}
