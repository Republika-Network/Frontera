import { XrplConfigurationError, type XrplPaymentSubmission } from './contracts.js';
import { isXrplNetworkLabel } from './configuration.js';
import { isXrplClassicAddress, isXrplNonStandardCurrencyCode, isXrplStandardCurrencyCode } from './xrpl-codec.js';

/**
 * The transport side of configuration drift (ANDREW-P0-07).
 *
 * The adapter states *what* to pay — destination, token, value — and labels
 * the network it was configured for. A transport knows *where* it is
 * connected and which tokens its deployment settles. Before it signs or sends
 * anything, a transport runs `checkXrplSettlement`: a submission for another
 * network, with no network, or in a token this deployment does not settle is
 * refused, and the transport answers `not-submitted`. So an adapter pointed at
 * one network and a transport connected to another fail closed instead of
 * settling, and an issuer or currency that drifted in one place but not the
 * other cannot reach a ledger.
 *
 * Pure: no I/O, no clock, no key. P0-07's recording transport uses it; P0-08's
 * real transport must call it first.
 */

/** One issued token a deployment settles: its 160-bit or standard currency code and its issuer, exactly. */
export interface XrplSettledToken {
  readonly currency: string;
  readonly issuer: string;
}

export interface XrplSettlementProfile {
  /** The network label the transport is connected to. Must equal every submission's `network`. */
  readonly network: string;
  /** Every issued token this deployment may deliver. Native XRP is not settled by a profile. */
  readonly tokens: readonly XrplSettledToken[];
}

export type XrplSettlementRefusal =
  /** The submission states no network, so nothing proves it was meant for this one. */
  | 'network-missing'
  /** The submission was configured for another network. */
  | 'network-mismatch'
  /** The amount is not one of this deployment's settled tokens (another issuer, another currency, or XRP). */
  | 'token-not-settled';

export type XrplSettlementCheck = { readonly ok: true } | { readonly ok: false; readonly refusal: XrplSettlementRefusal };

/** Validate and freeze a profile at construction; a defect is a startup failure, never a payment-time surprise. */
export function createXrplSettlementProfile(profile: XrplSettlementProfile): XrplSettlementProfile {
  if (!isXrplNetworkLabel(profile.network)) throw new XrplConfigurationError('XRPL_NETWORK_INVALID', 'A settlement profile needs a lowercase network label.');
  if (!Array.isArray(profile.tokens) || profile.tokens.length === 0) throw new XrplConfigurationError('XRPL_OPTIONS_INVALID', 'A settlement profile needs at least one settled token.');
  const seen = new Set<string>();
  const tokens = profile.tokens.map((token) => {
    if (!isXrplStandardCurrencyCode(token.currency) && !isXrplNonStandardCurrencyCode(token.currency)) throw new XrplConfigurationError('XRPL_CURRENCY_INVALID', 'A settled token needs a canonical XRPL currency code other than XRP.');
    if (!isXrplClassicAddress(token.issuer)) throw new XrplConfigurationError('XRPL_ISSUER_INVALID', 'A settled token needs an issuer that is a valid XRPL classic address.');
    const key = `${token.currency}/${token.issuer}`;
    if (seen.has(key)) throw new XrplConfigurationError('XRPL_OPTIONS_INVALID', 'A settlement profile lists one token twice.');
    seen.add(key);
    return Object.freeze({ currency: token.currency, issuer: token.issuer });
  });
  return Object.freeze({ network: profile.network, tokens: Object.freeze(tokens) });
}

export function checkXrplSettlement(profile: XrplSettlementProfile, submission: XrplPaymentSubmission): XrplSettlementCheck {
  if (submission.network === undefined) return { ok: false, refusal: 'network-missing' };
  if (submission.network !== profile.network) return { ok: false, refusal: 'network-mismatch' };
  const amount = submission.instruction.Amount;
  if (typeof amount === 'string') return { ok: false, refusal: 'token-not-settled' };
  const settled = profile.tokens.some((token) => token.currency === amount.currency && token.issuer === amount.issuer);
  return settled ? { ok: true } : { ok: false, refusal: 'token-not-settled' };
}
