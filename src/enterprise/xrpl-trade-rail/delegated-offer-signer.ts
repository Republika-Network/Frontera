import { randomBytes } from 'node:crypto';

import { isTradeNetwork, validateTradeProposal, type TradeProposal } from '../../features/trade-runtime/index.js';
import { parseDelegatedOfferCapability } from '../authority-authenticity/delegated-offer-capability.js';
import { delegatedOfferCapabilityBindingFailure } from './delegated-offer-authorization.js';
import {
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  delegatedOfferPairKey,
  isDelegatedOfferRequestId,
  isDelegatedOfferSignerId,
  parseDelegatedOfferAuthorization,
  parseDelegatedOfferSignerIdentity,
  parseDelegatedOfferSignerPair,
  parseDelegatedOfferSigningResponse,
  parsePreparedDelegatedOffer,
  type DelegatedOfferAuthorization,
  type DelegatedOfferNetwork,
  type DelegatedOfferSignerAuthorization,
  type DelegatedOfferSignerPair,
  type PreparedDelegatedOffer,
} from './delegated-offer-protocol.js';
import { DelegatedOfferSignerConfigurationError, DelegatedOfferSignerError, type DelegatedOfferSignerFailureReason, type DelegatedOfferSignerTransport } from './delegated-offer-signer-transport.js';
import { verifySignedDelegatedOffer } from './delegated-offer-verification.js';

/**
 * TRADE-04B — the Host-side client of an external delegated OfferCreate
 * signer. It holds an endpoint (through its transport), a credential (inside
 * the transport) and **public** pins. It never holds, reads or derives a key,
 * and it never submits anything: it has no ledger access at all.
 *
 * ```
 * future executor (TRADE-04C)                                  delegate custody (customer or reference)
 * ───────────────────────────                                  ───────────────────────────────────────
 * signer.signDelegatedOffer({ transaction, proposal, authorization, validatedLedgerIndex })
 *   ├─ closed transaction, pinned pair, fee ceiling, LLS horizon   (refused locally, nothing sent)
 *   ├─ capability bound to this transaction, pair, network, proposal (refused locally, nothing sent)
 *   ├─ identity proven against the pin before the first signature  (no TOFU)
 *   ├─ fresh requestId ── POST /v1/sign/xrpl-delegated-offer ──▶   signs exactly that OfferCreate as the delegate
 *   ├─ response bound to the requestId, capability, signer, owner and delegate
 *   └─ blob verified: canonical, exact field set, same signing bytes, PINNED key, valid signature, own hash
 *        → VerifiedDelegatedOfferSignature { status: 'signed-not-submitted' }
 * ```
 *
 * ## State
 *
 * | state | meaning | signing |
 * | --- | --- | --- |
 * | `UNVERIFIED` | never proven since construction | a forced handshake first |
 * | `VERIFIED` | the last handshake proved the pinned identity and nothing since contradicted it | allowed; every answer still verified |
 * | `UNAVAILABLE` | the last contact failed (unreachable, timeout, 5xx/429, credential refused, malformed answer) | a forced handshake first — a once-proven identity is never assumed across an outage |
 * | `MISMATCH` | the signer contradicted its pin: another identity, or an answer for another request, signer or pair, or a blob that does not verify | refused for the life of this client; rotation is configuration + a new client |
 *
 * A request the signer refuses (4xx other than 401/403, e.g. its own fee
 * ceiling) leaves the state as it was: the signer behaved as pinned.
 *
 * ## Pinning
 *
 * The identity answer must be exactly the pin: the protocol, the signer id,
 * the one operation, the network and the **same set** of owner/delegate pairs
 * with the same delegate keys — no pair missing and none extra. Nothing
 * advertised is ever adopted.
 */
export type DelegatedOfferSignerState = 'UNVERIFIED' | 'VERIFIED' | 'UNAVAILABLE' | 'MISMATCH';

export interface DelegatedOfferSignerPin {
  readonly signerId: string;
  readonly network: DelegatedOfferNetwork;
  readonly pairs: readonly DelegatedOfferSignerPair[];
}

export interface DelegatedOfferSignerStatus {
  readonly signerId: string;
  readonly state: DelegatedOfferSignerState;
  /** The last failure, as a closed reason. Never a body, status text, address or credential. */
  readonly reason?: DelegatedOfferSignerFailureReason;
  readonly pairs: number;
  /** TRADE-04C-S1: the authorization the signer last advertised it pins (public identifiers). Diagnostic: a signer pinning another authority refuses every capability — it can never sign more because of it. */
  readonly authorization?: DelegatedOfferSignerAuthorization;
}

/** What the executor hands the signing capability. Every term was fixed before this call, from the grant. */
export interface DelegatedOfferSigningInput {
  readonly transaction: PreparedDelegatedOffer;
  /** The canonical TRADE-01 proposal the grant names. */
  readonly proposal: TradeProposal;
  /** TRADE-04C-S1: the CORE-02 capability (canonical text) and its authority signature, issued for exactly this transaction. */
  readonly authorization: DelegatedOfferAuthorization;
  /** A **validated** ledger index the caller read through the shared transport's validated reader. Bounds `LastLedgerSequence`. */
  readonly validatedLedgerIndex: number;
}

/**
 * A verified delegated signature: the pinned delegate key signed exactly the
 * prepared OfferCreate. **Signed, not submitted** — not an authorization, not
 * an execution, not a fill. It proves nothing about governance: only the
 * grant-bound executor that obtained it can (TRADE-04C).
 */
export interface VerifiedDelegatedOfferSignature {
  readonly kind: 'xrpl-delegated-offer-signature';
  readonly status: 'signed-not-submitted';
  readonly signerId: string;
  readonly requestId: string;
  readonly network: DelegatedOfferNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly signingPublicKey: string;
  readonly transaction: PreparedDelegatedOffer;
  readonly signedTransaction: string;
  readonly hash: string;
  /** The capability the signer consumed for this signature, and the execution and grant it names. */
  readonly capabilityId: string;
  readonly executionId: string;
  readonly boundedGrantId: string;
}

/** The typed port a future TRADE-04C executor composes. The only method; there is no "sign arbitrary transaction". */
export interface DelegatedOfferSigningPort {
  signDelegatedOffer(input: DelegatedOfferSigningInput): Promise<VerifiedDelegatedOfferSignature>;
}

export interface DelegatedOfferSigner extends DelegatedOfferSigningPort {
  /** One identity handshake (single-flight, rate-limited by `probeIntervalMs`). Never signs. */
  probe(): Promise<DelegatedOfferSignerStatus>;
  status(): DelegatedOfferSignerStatus;
}

export interface DelegatedOfferSignerOptions {
  readonly transport: DelegatedOfferSignerTransport;
  readonly pin: DelegatedOfferSignerPin;
  readonly timeoutMs: number;
  /** The Host's own fee ceiling, in drops — defence in depth beside the signer's; never a substitute for the authority's monetary controls. */
  readonly maximumFeeDrops: string;
  /** `LastLedgerSequence` must be in `(validatedLedgerIndex, validatedLedgerIndex + maximumLedgerHorizon]`. */
  readonly maximumLedgerHorizon: number;
  readonly probeIntervalMs?: number;
  /** Signing requests in flight at once; one more is refused (`OFFER_SIGNER_BUSY`), never queued. */
  readonly maximumConcurrentSignatures?: number;
  /** Injected for qualification; default `randomBytes(32)` as hex. */
  readonly requestId?: () => string;
  readonly now?: () => number;
}

export const DELEGATED_OFFER_SIGNER_LIMITS = Object.freeze({
  timeoutMs: Object.freeze({ minimum: 1, maximum: 60_000 }),
  probeIntervalMs: Object.freeze({ minimum: 0, maximum: 60_000, default: 5_000 }),
  maximumLedgerHorizon: Object.freeze({ minimum: 1, maximum: 1_000 }),
  maximumConcurrentSignatures: Object.freeze({ minimum: 1, maximum: 64, default: 8 }),
  /** Fee ceilings above this many drops (1 XRP) are refused as configuration. */
  maximumFeeDrops: 1_000_000n,
  /** Request ids remembered to refuse a repeated one from a faulty generator. */
  rememberedRequestIds: 4_096,
});

const FEE_DROPS = /^[1-9][0-9]{0,15}$/;

/** Validates one signer pin. Throws a configuration error naming the rule, never a value. */
export function validateDelegatedOfferSignerPin(pin: unknown): DelegatedOfferSignerPin {
  const value = pin as Partial<DelegatedOfferSignerPin> | undefined;
  if (!isDelegatedOfferSignerId(value?.signerId)) throw new DelegatedOfferSignerConfigurationError('The delegated offer signer pin needs a recordable signer id.');
  if (!isTradeNetwork(value.network)) throw new DelegatedOfferSignerConfigurationError('The delegated offer signer pin needs an XRPL Testnet or Devnet network.');
  if (!Array.isArray(value.pairs) || value.pairs.length === 0) throw new DelegatedOfferSignerConfigurationError('The delegated offer signer pin needs at least one owner/delegate pair.');
  const seen = new Set<string>();
  const pairs = value.pairs.map((raw: unknown, index) => {
    const entry = raw as Partial<DelegatedOfferSignerPair> | undefined;
    const pair = parseDelegatedOfferSignerPair(entry !== null && typeof entry === 'object' ? { ownerAccount: entry.ownerAccount, delegateAccount: entry.delegateAccount, signingPublicKey: entry.signingPublicKey } : undefined);
    if (pair === undefined) throw new DelegatedOfferSignerConfigurationError(`The delegated offer signer pin's pair ${index} needs two different valid accounts and a 33-byte uppercase-hex delegate signing key.`);
    if (seen.has(delegatedOfferPairKey(pair))) throw new DelegatedOfferSignerConfigurationError(`The delegated offer signer pin names pair ${index} twice.`);
    seen.add(delegatedOfferPairKey(pair));
    return pair;
  });
  return Object.freeze({ signerId: value.signerId, network: value.network, pairs: Object.freeze(pairs) });
}

/**
 * Validates every signer pin a deployment configures, together: no signer id
 * twice, and no owner/delegate pair under two signers — one relationship has
 * one custodian, so a pin can never be reused across signers (or customers)
 * without an explicit, separate configuration.
 */
export function validateDelegatedOfferSignerPins(pins: readonly unknown[]): readonly DelegatedOfferSignerPin[] {
  if (!Array.isArray(pins)) throw new DelegatedOfferSignerConfigurationError('The delegated offer signer pins must be a list.');
  const signerIds = new Set<string>();
  const pairs = new Set<string>();
  return Object.freeze(
    pins.map((raw, index) => {
      const pin = validateDelegatedOfferSignerPin(raw);
      if (signerIds.has(pin.signerId)) throw new DelegatedOfferSignerConfigurationError(`Delegated offer signer pin ${index} repeats a signer id.`);
      signerIds.add(pin.signerId);
      for (const pair of pin.pairs) {
        if (pairs.has(delegatedOfferPairKey(pair))) throw new DelegatedOfferSignerConfigurationError(`Delegated offer signer pin ${index} pins an owner/delegate pair another signer already serves.`);
        pairs.add(delegatedOfferPairKey(pair));
      }
      return pin;
    }),
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DelegatedOfferSignerConfigurationError(message);
  return value;
}

export function createDelegatedOfferSigner(options: DelegatedOfferSignerOptions): DelegatedOfferSigner {
  const transport = options?.transport;
  if (typeof transport?.identity !== 'function' || typeof transport.signDelegatedOffer !== 'function') throw new DelegatedOfferSignerConfigurationError('The delegated offer signer needs a transport.');
  const pin = validateDelegatedOfferSignerPin(options.pin);
  const limits = DELEGATED_OFFER_SIGNER_LIMITS;
  const timeoutMs = boundedInteger(options.timeoutMs, limits.timeoutMs.minimum, limits.timeoutMs.maximum, `The delegated offer signer timeout must be an integer from ${limits.timeoutMs.minimum} to ${limits.timeoutMs.maximum} ms.`);
  const probeIntervalMs = boundedInteger(options.probeIntervalMs ?? limits.probeIntervalMs.default, limits.probeIntervalMs.minimum, limits.probeIntervalMs.maximum, 'The delegated offer signer probe interval is out of bounds.');
  const maximumLedgerHorizon = boundedInteger(options.maximumLedgerHorizon, limits.maximumLedgerHorizon.minimum, limits.maximumLedgerHorizon.maximum, 'The delegated offer signer ledger horizon is out of bounds.');
  const maximumConcurrent = boundedInteger(options.maximumConcurrentSignatures ?? limits.maximumConcurrentSignatures.default, limits.maximumConcurrentSignatures.minimum, limits.maximumConcurrentSignatures.maximum, 'The delegated offer signer concurrency bound is out of bounds.');
  if (typeof options.maximumFeeDrops !== 'string' || !FEE_DROPS.test(options.maximumFeeDrops) || BigInt(options.maximumFeeDrops) > limits.maximumFeeDrops) throw new DelegatedOfferSignerConfigurationError('The delegated offer signer fee ceiling must be a positive whole number of drops, at most 1 XRP.');
  const maximumFeeDrops = BigInt(options.maximumFeeDrops);
  const nextRequestId = options.requestId ?? (() => randomBytes(32).toString('hex'));
  const now = options.now ?? (() => Date.now());
  const pinnedPairs = new Map(pin.pairs.map((pair) => [delegatedOfferPairKey(pair), pair]));

  let state: DelegatedOfferSignerState = 'UNVERIFIED';
  let reason: DelegatedOfferSignerFailureReason | undefined;
  let inFlightProbe: Promise<void> | undefined;
  let lastProbeAt: number | undefined;
  let inFlightSignatures = 0;
  let advertisedAuthorization: DelegatedOfferSignerAuthorization | undefined;
  const usedRequestIds = new Set<string>();

  const status = (): DelegatedOfferSignerStatus =>
    Object.freeze({ signerId: pin.signerId, state, ...(reason !== undefined ? { reason } : {}), pairs: pin.pairs.length, ...(advertisedAuthorization !== undefined ? { authorization: advertisedAuthorization } : {}) });
  const mismatch = (why: DelegatedOfferSignerFailureReason): void => {
    state = 'MISMATCH';
    reason = why;
  };
  const unavailable = (why: DelegatedOfferSignerFailureReason): void => {
    if (state === 'MISMATCH') return;
    state = 'UNAVAILABLE';
    reason = why;
  };
  const failure = (error: unknown): DelegatedOfferSignerFailureReason => (error instanceof DelegatedOfferSignerError ? error.reason : 'OFFER_SIGNER_UNREACHABLE');

  /** One identity handshake. A mismatch is permanent for this client; unavailability is not. */
  async function handshake(): Promise<void> {
    if (state === 'MISMATCH') return;
    let raw: unknown;
    try {
      raw = await transport.identity({ timeoutMs });
    } catch (error) {
      unavailable(failure(error));
      return;
    }
    const identity = parseDelegatedOfferSignerIdentity(raw);
    if (identity === undefined) {
      unavailable('OFFER_SIGNER_MALFORMED_RESPONSE');
      return;
    }
    const advertised = new Map(identity.pairs.map((pair) => [delegatedOfferPairKey(pair), pair.signingPublicKey]));
    const exact =
      identity.signerId === pin.signerId &&
      identity.network === pin.network &&
      advertised.size === pinnedPairs.size &&
      pin.pairs.every((pair) => advertised.get(delegatedOfferPairKey(pair)) === pair.signingPublicKey);
    if (!exact) {
      mismatch('OFFER_SIGNER_IDENTITY_MISMATCH');
      return;
    }
    state = 'VERIFIED';
    reason = undefined;
    advertisedAuthorization = identity.authorization;
  }

  function probe(force: boolean): Promise<void> {
    if (inFlightProbe !== undefined) return inFlightProbe;
    const at = now();
    if (!force && lastProbeAt !== undefined && at >= lastProbeAt && at - lastProbeAt < probeIntervalMs) return Promise.resolve();
    lastProbeAt = at;
    inFlightProbe = handshake().finally(() => {
      inFlightProbe = undefined;
    });
    return inFlightProbe;
  }

  const refuse = (why: DelegatedOfferSignerFailureReason, message: string): never => {
    throw new DelegatedOfferSignerError(why, message);
  };

  /** Everything checked before the signer is contacted. Nothing is sent for a request that fails here. */
  function admit(input: DelegatedOfferSigningInput): {
    readonly transaction: PreparedDelegatedOffer;
    readonly pair: DelegatedOfferSignerPair;
    readonly proposal: TradeProposal;
    readonly authorization: DelegatedOfferAuthorization;
    readonly capability: { readonly capabilityId: string; readonly executionId: string; readonly boundedGrantId: string };
  } {
    const transaction = parsePreparedDelegatedOffer(input?.transaction);
    if (transaction === undefined) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The prepared transaction is not a closed delegated OfferCreate; nothing is signed.');
    const pair = pinnedPairs.get(delegatedOfferPairKey({ ownerAccount: transaction.Account, delegateAccount: transaction.Delegate }));
    if (pair === undefined) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The prepared transaction is not for a pinned owner/delegate pair; nothing is signed.');
    const proposal = validateTradeProposal(input.proposal);
    if (!proposal.valid) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The proposal is not an accepted canonical trade proposal; nothing is signed.');
    const authorization = parseDelegatedOfferAuthorization(input.authorization);
    const capability = authorization === undefined ? undefined : parseDelegatedOfferCapability(authorization.capability);
    if (authorization === undefined || capability === undefined) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'No well-formed delegated-offer capability authorizes this request; nothing is signed.');
    // The Host's own defect if this fails — the signer would refuse it anyway — so it is never sent.
    if (delegatedOfferCapabilityBindingFailure(capability, { transaction, proposal: proposal.accepted.proposal, pin: { network: pin.network, pair, trustDomain: capability.trustDomain, organizationId: capability.organizationId } }) !== undefined) {
      return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The capability is not bound to this transaction, pair, network and proposal; nothing is signed.');
    }
    if (BigInt(transaction.Fee) > maximumFeeDrops) return refuse('OFFER_SIGNER_REQUEST_INVALID', "The prepared fee exceeds the Host's fee ceiling; nothing is signed.");
    const validated = input.validatedLedgerIndex;
    if (typeof validated !== 'number' || !Number.isSafeInteger(validated) || validated < 1) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'No validated ledger index bounds the request; nothing is signed.');
    if (transaction.LastLedgerSequence <= validated || transaction.LastLedgerSequence > validated + maximumLedgerHorizon) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The prepared LastLedgerSequence is outside the horizon above the validated ledger; nothing is signed.');
    return { transaction, pair, proposal: proposal.accepted.proposal, authorization, capability: { capabilityId: capability.capabilityId, executionId: capability.executionId, boundedGrantId: capability.boundedGrantId } };
  }

  function freshRequestId(): string {
    const requestId = nextRequestId();
    if (!isDelegatedOfferRequestId(requestId) || usedRequestIds.has(requestId)) return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The request correlation id is not a fresh 32-byte value; nothing is signed.');
    usedRequestIds.add(requestId);
    if (usedRequestIds.size > limits.rememberedRequestIds) usedRequestIds.delete(usedRequestIds.values().next().value as string);
    return requestId;
  }

  async function signDelegatedOffer(input: DelegatedOfferSigningInput): Promise<VerifiedDelegatedOfferSignature> {
    const { transaction, pair, proposal, authorization, capability } = admit(input);
    if (state !== 'VERIFIED') await probe(true);
    if (state !== 'VERIFIED') return refuse(state === 'MISMATCH' ? (reason ?? 'OFFER_SIGNER_IDENTITY_MISMATCH') : 'OFFER_SIGNER_NOT_VERIFIED', 'The delegated offer signer identity is not proven; nothing is signed.');
    if (inFlightSignatures >= maximumConcurrent) return refuse('OFFER_SIGNER_BUSY', 'The delegated offer signer concurrency bound is reached; nothing is signed.');
    const requestId = freshRequestId();
    inFlightSignatures += 1;
    let raw: unknown;
    try {
      raw = await transport.signDelegatedOffer(
        { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: pin.signerId, requestId, network: pin.network, ownerAccount: pair.ownerAccount, delegateAccount: pair.delegateAccount, transaction, proposal, authorization },
        { timeoutMs },
      );
    } catch (error) {
      const why = failure(error);
      if (why !== 'OFFER_SIGNER_REFUSED' && why !== 'OFFER_SIGNER_REQUEST_INVALID') unavailable(why);
      return refuse(why, 'The delegated offer signer did not sign; nothing is signed for this request.');
    } finally {
      inFlightSignatures -= 1;
    }
    const response = parseDelegatedOfferSigningResponse(raw);
    if (response === undefined) {
      unavailable('OFFER_SIGNER_MALFORMED_RESPONSE');
      return refuse('OFFER_SIGNER_MALFORMED_RESPONSE', 'The delegated offer signer answered outside the protocol; the answer is discarded.');
    }
    // Bound to this request, this capability, this signer and this pair — a replayed or crossed answer is a contradiction of the pin.
    if (response.requestId !== requestId || response.capabilityId !== capability.capabilityId || response.signerId !== pin.signerId || response.ownerAccount !== pair.ownerAccount || response.delegateAccount !== pair.delegateAccount) {
      mismatch('OFFER_SIGNER_RESPONSE_MISMATCH');
      return refuse('OFFER_SIGNER_RESPONSE_MISMATCH', 'The delegated offer signer answered for another request, signer or pair; the answer is discarded.');
    }
    const verification = verifySignedDelegatedOffer({ prepared: transaction, pair, signedTransaction: response.signedTransaction, hash: response.hash });
    if (!verification.verified) {
      mismatch('OFFER_SIGNER_SIGNATURE_INVALID');
      return refuse('OFFER_SIGNER_SIGNATURE_INVALID', `The delegated offer signer's blob failed verification (${verification.failure}); the answer is discarded.`);
    }
    return Object.freeze({
      kind: 'xrpl-delegated-offer-signature',
      status: 'signed-not-submitted',
      signerId: pin.signerId,
      requestId,
      network: pin.network,
      ownerAccount: pair.ownerAccount,
      delegateAccount: pair.delegateAccount,
      signingPublicKey: pair.signingPublicKey,
      transaction,
      signedTransaction: verification.blob.signedTransaction,
      hash: verification.blob.hash,
      capabilityId: capability.capabilityId,
      executionId: capability.executionId,
      boundedGrantId: capability.boundedGrantId,
    });
  }

  return Object.freeze({
    signDelegatedOffer,
    async probe() {
      await probe(false);
      return status();
    },
    status,
  });
}
