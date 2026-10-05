import { issuedValuesEqual, canonicalIssuedValue } from './decimal.js';

/**
 * The read-only Testnet preflight (ANDREW-P0-08): non-secret facts about the
 * connected network and the two demo accounts, and a verdict. It signs and
 * submits nothing, and takes no seed.
 *
 * An RLUSD trust line is a ledger fact. It is reported here and never read as
 * a Frontera destination approval.
 */

export interface XrplPreflightReader {
  serverInfo(): Promise<{ readonly networkId?: number; readonly validatedLedgerIndex?: number }>;
  /** XRP balance in drops, or undefined when the account does not exist. */
  xrpBalanceDrops(account: string): Promise<bigint | undefined>;
  /** The account's trust line to `issuer` for `currency`, if any. */
  trustLine(account: string, issuer: string, currency: string): Promise<{ readonly balance: string; readonly limit: string } | undefined>;
}

export interface XrplPreflightInput {
  readonly expectedNetworkId: number;
  readonly treasury: string;
  readonly recipient: string;
  readonly currency: string;
  readonly issuer: string;
  /** The governed amount the treasury must hold in the token, as canonical decimal text. */
  readonly requiredValue: string;
  /** Drops each account needs beyond its reserves to be considered ready (fees). */
  readonly minimumXrpDrops: bigint;
}

export interface XrplPreflightReport {
  readonly connectedNetworkId: number | undefined;
  readonly networkOk: boolean;
  readonly validatedLedgerIndex: number | undefined;
  readonly treasury: { readonly address: string; readonly xrpDrops: string | undefined; readonly xrpReady: boolean; readonly trustLine: boolean; readonly tokenBalance: string | undefined; readonly tokenSufficient: boolean };
  readonly recipient: { readonly address: string; readonly xrpDrops: string | undefined; readonly xrpReady: boolean; readonly trustLine: boolean; readonly trustLimitSufficient: boolean };
  /** Exactly what is still missing, in plain words. Empty when ready. */
  readonly blockers: readonly string[];
  readonly ready: boolean;
}

/** a ≥ b for canonical issued values, compared as exact decimals (no floats). */
function atLeast(a: string, b: string): boolean {
  const left = canonicalIssuedValue(a);
  const right = canonicalIssuedValue(b);
  if (left === undefined || right === undefined) return false;
  if (issuedValuesEqual(a, b)) return true;
  if (left.negative !== right.negative) return right.negative;
  const scale = Math.min(left.exponent, right.exponent);
  const leftInteger = BigInt(left.digits) * 10n ** BigInt(left.exponent - scale);
  const rightInteger = BigInt(right.digits) * 10n ** BigInt(right.exponent - scale);
  return left.negative ? leftInteger <= rightInteger : leftInteger >= rightInteger;
}

export async function runXrplPreflight(reader: XrplPreflightReader, input: XrplPreflightInput): Promise<XrplPreflightReport> {
  const info = await reader.serverInfo();
  const networkOk = info.networkId === input.expectedNetworkId;
  const blockers: string[] = [];
  if (!networkOk) blockers.push(`the connected server does not report network_id ${input.expectedNetworkId}`);

  const treasuryXrp = await reader.xrpBalanceDrops(input.treasury);
  const recipientXrp = await reader.xrpBalanceDrops(input.recipient);
  const treasuryLine = await reader.trustLine(input.treasury, input.issuer, input.currency);
  const recipientLine = await reader.trustLine(input.recipient, input.issuer, input.currency);

  const treasuryXrpReady = treasuryXrp !== undefined && treasuryXrp >= input.minimumXrpDrops;
  const recipientXrpReady = recipientXrp !== undefined && recipientXrp >= input.minimumXrpDrops;
  const tokenBalance = treasuryLine?.balance;
  const tokenSufficient = tokenBalance !== undefined && atLeast(tokenBalance, input.requiredValue);
  const trustLimitSufficient = recipientLine !== undefined && atLeast(recipientLine.limit, input.requiredValue);

  if (!treasuryXrpReady) blockers.push(treasuryXrp === undefined ? 'the treasury account does not exist on the ledger' : 'the treasury needs more XRP for reserves and fees');
  if (!recipientXrpReady) blockers.push(recipientXrp === undefined ? 'the recipient account does not exist on the ledger' : 'the recipient needs more XRP for reserves');
  if (treasuryLine === undefined) blockers.push('the treasury has no RLUSD trust line to the Testnet issuer');
  if (recipientLine === undefined) blockers.push('the recipient has no RLUSD trust line to the Testnet issuer');
  else if (!trustLimitSufficient) blockers.push(`the recipient's RLUSD trust line limit is below ${input.requiredValue}`);
  if (treasuryLine !== undefined && !tokenSufficient) blockers.push(`the treasury holds ${tokenBalance ?? '0'} RLUSD; ${input.requiredValue} is required — fund it from the Testnet RLUSD faucet`);

  return {
    connectedNetworkId: info.networkId,
    networkOk,
    validatedLedgerIndex: info.validatedLedgerIndex,
    treasury: { address: input.treasury, xrpDrops: treasuryXrp?.toString(), xrpReady: treasuryXrpReady, trustLine: treasuryLine !== undefined, tokenBalance, tokenSufficient },
    recipient: { address: input.recipient, xrpDrops: recipientXrp?.toString(), xrpReady: recipientXrpReady, trustLine: recipientLine !== undefined, trustLimitSufficient },
    blockers,
    ready: blockers.length === 0,
  };
}
