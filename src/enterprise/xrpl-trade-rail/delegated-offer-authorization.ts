import { createHash } from 'node:crypto';

import { validateTradeProposal, type TradeAmount, type TradeProposal } from '../../features/trade-runtime/index.js';
import { xrplSingleSigningEncoding } from '../../features/xrpl-transport/xrpl-signature.js';
import { DELEGATED_OFFER_CAPABILITY_LIMITS, DELEGATED_OFFER_CAPABILITY_OPERATION, parseDelegatedOfferCapability, type DelegatedOfferCapability } from '../authority-authenticity/delegated-offer-capability.js';
import type { AuthoritySignatureVerification } from '../authority-authenticity/verifier.js';
import { parsePreparedDelegatedOffer, type DelegatedOfferAmount, type DelegatedOfferAuthorization, type DelegatedOfferNetwork, type DelegatedOfferSignerPair, type PreparedDelegatedOffer } from './delegated-offer-protocol.js';

/**
 * TRADE-04C-S1 — what a delegated signer checks before it may touch a key:
 * that the request carries a CORE-02 **delegated-offer signing capability**,
 * signed by an authority key it pins, for exactly this transaction.
 *
 * The chain it verifies, link by link, each with one closed failure:
 *
 * ```
 * capability text  ── parses canonically ───────────────────────────── CAPABILITY_MISSING / _MALFORMED
 * signature        ── verifies under a pinned key, domain-separated ── CAPABILITY_SIGNATURE_INVALID
 * issuer           ── that key is pinned and is the one named inside ─ CAPABILITY_ISSUER_UNTRUSTED
 * time             ── issued ≤ now + skew, now < expires ──────────── CAPABILITY_NOT_YET_VALID / _EXPIRED
 * scope            ── operation, trust domain, organization ────────── CAPABILITY_SCOPE_MISMATCH
 * network          ── the signer's network ───────────────────────── CAPABILITY_NETWORK_MISMATCH
 * pair             ── the transaction's owner and delegate ────────── CAPABILITY_PAIR_MISMATCH
 * transaction      ── exact single-signing preimage digest, and
 *                     Sequence, Fee, LastLedgerSequence ──────────── CAPABILITY_TRANSACTION_MISMATCH
 * proposal         ── its digest is the one the grant names ──────── CAPABILITY_PROPOSAL_MISMATCH
 * terms            ── the transaction is that proposal's order ────── CAPABILITY_TERMS_MISMATCH
 * ```
 *
 * The capability itself proves the grant link: the authority signs one only
 * after verifying, inside its custody boundary, that the bounded grant it
 * names was signed by that same key and pins that proposal digest, network,
 * delegate, owner resource and organization (`assessDelegatedOfferCapabilityIssuance`).
 *
 * What this cannot do — and does not claim: single use (the signer's durable
 * consumption ledger), revocation after issuance (bounded only by the
 * capability's lifetime), or anything at all against a compromised signer
 * process or delegate key, which can sign without asking.
 */

export const DELEGATED_OFFER_AUTHORIZATION_FAILURES = [
  'CAPABILITY_MISSING',
  'CAPABILITY_MALFORMED',
  'CAPABILITY_SIGNATURE_INVALID',
  'CAPABILITY_ISSUER_UNTRUSTED',
  'CAPABILITY_SCOPE_MISMATCH',
  'CAPABILITY_NOT_YET_VALID',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_NETWORK_MISMATCH',
  'CAPABILITY_PAIR_MISMATCH',
  'CAPABILITY_TRANSACTION_MISMATCH',
  'CAPABILITY_PROPOSAL_MISMATCH',
  'CAPABILITY_TERMS_MISMATCH',
] as const;
export type DelegatedOfferAuthorizationFailure = (typeof DELEGATED_OFFER_AUTHORIZATION_FAILURES)[number];

/** What a signer pins (or the Host knows) about the authorization it accepts, beside its network and pair. */
export interface DelegatedOfferAuthorizationPin {
  readonly network: DelegatedOfferNetwork;
  readonly pair: DelegatedOfferSignerPair;
  readonly trustDomain: string;
  readonly organizationId: string;
}

/** `sha256:` over the exact single-signing preimage (`STX\0` ‖ signing fields), with `SigningPubKey` = the delegate key. `undefined` when the codec refuses. */
export function delegatedOfferSigningPreimageDigest(transaction: PreparedDelegatedOffer, signingPublicKey: string): string | undefined {
  const closed = parsePreparedDelegatedOffer(transaction);
  if (closed === undefined) return undefined;
  const encoding = xrplSingleSigningEncoding({ ...closed, SigningPubKey: signingPublicKey });
  if (encoding === undefined || !/^(?:[0-9A-F]{2})+$/.test(encoding)) return undefined;
  return `sha256:${createHash('sha256').update(Buffer.from(encoding, 'hex')).digest('hex')}`;
}

function wireAmount(amount: TradeAmount): DelegatedOfferAmount {
  return 'drops' in amount ? amount.drops : Object.freeze({ currency: amount.currency, issuer: amount.issuer, value: amount.value });
}

/**
 * The delegated OfferCreate an accepted proposal **is**, with the operational
 * fields the executor fixed: `Account` = owner, `Delegate` = delegate,
 * `TakerGets` = what the owner gives, `TakerPays` = what it receives, `Flags`
 * = TRADE-01's flag sum, optional `Expiration`. The one derivation both the
 * executor (to build) and the signer (to check) use.
 */
export function preparedDelegatedOfferFromProposal(proposal: TradeProposal, flagsValue: number, operational: { readonly sequence: number; readonly fee: string; readonly lastLedgerSequence: number }): PreparedDelegatedOffer {
  return Object.freeze({
    TransactionType: 'OfferCreate' as const,
    Account: proposal.ownerAccount,
    Delegate: proposal.delegateAccount,
    TakerGets: wireAmount(proposal.takerGets),
    TakerPays: wireAmount(proposal.takerPays),
    Flags: flagsValue,
    Sequence: operational.sequence,
    Fee: operational.fee,
    LastLedgerSequence: operational.lastLedgerSequence,
    ...(proposal.expiration !== undefined ? { Expiration: proposal.expiration } : {}),
  });
}

function sameAmount(left: DelegatedOfferAmount, right: DelegatedOfferAmount): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.currency === right.currency && left.issuer === right.issuer && left.value === right.value;
}

/** Field-by-field equality of two closed prepared offers. */
export function sameDelegatedOffer(left: PreparedDelegatedOffer, right: PreparedDelegatedOffer): boolean {
  return (
    left.TransactionType === right.TransactionType &&
    left.Account === right.Account &&
    left.Delegate === right.Delegate &&
    sameAmount(left.TakerGets, right.TakerGets) &&
    sameAmount(left.TakerPays, right.TakerPays) &&
    left.Flags === right.Flags &&
    left.Sequence === right.Sequence &&
    left.Fee === right.Fee &&
    left.LastLedgerSequence === right.LastLedgerSequence &&
    left.Expiration === right.Expiration
  );
}

/**
 * The binding checks that need no key and no clock: the capability is for
 * this signer's scope, network and pair, for exactly this transaction, and for
 * the proposal whose order this transaction is. Used by the signer after the
 * signature and time checks, and by the Host-side client before it sends
 * anything (a mismatch there is the Host's own defect: nothing is sent).
 */
export function delegatedOfferCapabilityBindingFailure(
  capability: DelegatedOfferCapability,
  input: { readonly transaction: PreparedDelegatedOffer; readonly proposal: TradeProposal; readonly pin: DelegatedOfferAuthorizationPin },
): DelegatedOfferAuthorizationFailure | undefined {
  const { pin } = input;
  if (capability.operation !== DELEGATED_OFFER_CAPABILITY_OPERATION || capability.trustDomain !== pin.trustDomain || capability.organizationId !== pin.organizationId) return 'CAPABILITY_SCOPE_MISMATCH';
  if (capability.network !== pin.network) return 'CAPABILITY_NETWORK_MISMATCH';
  const transaction = parsePreparedDelegatedOffer(input.transaction);
  if (transaction === undefined) return 'CAPABILITY_TRANSACTION_MISMATCH';
  if (
    capability.ownerAccount !== pin.pair.ownerAccount ||
    capability.delegateAccount !== pin.pair.delegateAccount ||
    transaction.Account !== capability.ownerAccount ||
    transaction.Delegate !== capability.delegateAccount
  ) {
    return 'CAPABILITY_PAIR_MISMATCH';
  }
  if (
    delegatedOfferSigningPreimageDigest(transaction, pin.pair.signingPublicKey) !== capability.signingPreimageDigest ||
    transaction.Sequence !== capability.sequence ||
    transaction.Fee !== capability.fee ||
    transaction.LastLedgerSequence !== capability.lastLedgerSequence
  ) {
    return 'CAPABILITY_TRANSACTION_MISMATCH';
  }
  const validation = validateTradeProposal(input.proposal);
  if (!validation.valid || validation.accepted.digest !== capability.proposalDigest || validation.accepted.proposal.network !== capability.network) return 'CAPABILITY_PROPOSAL_MISMATCH';
  const granted = preparedDelegatedOfferFromProposal(validation.accepted.proposal, validation.accepted.terms.flagsValue, { sequence: transaction.Sequence, fee: transaction.Fee, lastLedgerSequence: transaction.LastLedgerSequence });
  if (!sameDelegatedOffer(granted, transaction)) return 'CAPABILITY_TERMS_MISMATCH';
  return undefined;
}

export interface DelegatedOfferAuthorizationInput {
  readonly transaction: PreparedDelegatedOffer;
  readonly proposal: TradeProposal;
  readonly authorization: DelegatedOfferAuthorization | undefined;
  readonly pin: DelegatedOfferAuthorizationPin;
  /** The key ids pinned as capability issuers. */
  readonly issuerKeyIds: readonly string[];
  /** Verifies under the pinned keys only (`createAuthorityArtifactVerifier` over the signer's pinned issuer keys). */
  readonly verifier: { verifyDelegatedOfferCapability(capability: DelegatedOfferCapability, signature: unknown): AuthoritySignatureVerification };
  /** The signer's clock, ms since the epoch. */
  readonly now: number;
}

export type DelegatedOfferAuthorizationResult = { readonly authorized: true; readonly capability: DelegatedOfferCapability } | { readonly authorized: false; readonly failure: DelegatedOfferAuthorizationFailure };

/** The whole chain, in order. Pure apart from the injected verifier; refuses with the first failing link. */
export function authorizeDelegatedOffer(input: DelegatedOfferAuthorizationInput): DelegatedOfferAuthorizationResult {
  const refuse = (failure: DelegatedOfferAuthorizationFailure): DelegatedOfferAuthorizationResult => ({ authorized: false, failure });
  if (input.authorization === undefined) return refuse('CAPABILITY_MISSING');
  const capability = parseDelegatedOfferCapability(input.authorization.capability);
  if (capability === undefined) return refuse('CAPABILITY_MALFORMED');
  const verification = input.verifier.verifyDelegatedOfferCapability(capability, input.authorization.signature);
  if (!verification.verified) return refuse('CAPABILITY_SIGNATURE_INVALID');
  if (!input.issuerKeyIds.includes(verification.keyId) || verification.keyId !== capability.issuerKeyId) return refuse('CAPABILITY_ISSUER_UNTRUSTED');
  if (Date.parse(capability.issuedAt) > input.now + DELEGATED_OFFER_CAPABILITY_LIMITS.maximumClockSkewMs) return refuse('CAPABILITY_NOT_YET_VALID');
  if (!(input.now < Date.parse(capability.expiresAt))) return refuse('CAPABILITY_EXPIRED');
  const binding = delegatedOfferCapabilityBindingFailure(capability, { transaction: input.transaction, proposal: input.proposal, pin: input.pin });
  if (binding !== undefined) return refuse(binding);
  return { authorized: true, capability };
}
