import {
  btcDecimalOfMsat,
  concludeLightningPayment,
  isLightningRailConfiguration,
  msatOfBtcDecimal,
  parseLightningDestination,
  preimageCommitment,
  readLightningNodeInfo,
  readLightningPaymentObservation,
  type LightningNodeReader,
  type LightningRailConfiguration,
} from '../../features/payment-runtime/rails/lightning/index.js';
import type { PaymentFinalityAnswer, PaymentFinalityAuthority, PaymentFinalityFact, PaymentFinalityQuery } from '../../features/payment-runtime/index.js';
import type { LightningPaymentReservationRecord } from './sqlite-lightning-payment-interlock.js';

/** The PAY-05 finality authority id for Lightning payments. */
export const LIGHTNING_FINALITY_AUTHORITY_ID = 'frontera.lightning-btc-finality';

/** How finality is established: the payee released the preimage of the governed payment hash (SHA-256 verified). Versioned. */
export const LIGHTNING_FINALITY_METHOD = 'lightning.preimage.v1';

/** What the authority reads from the local interlock: one reservation, by execution. It never writes the interlock. */
export interface LightningFinalityInterlockAccess {
  read(executionId: string): Promise<LightningPaymentReservationRecord | undefined>;
}

export interface LightningFinalityAuthorityOptions {
  readonly configuration: LightningRailConfiguration;
  /** Reads only — build it with `readOnlyLightningNode`. */
  readonly node: LightningNodeReader;
  readonly interlock: LightningFinalityInterlockAccess;
}

const NOT_FINAL: PaymentFinalityAnswer = Object.freeze({ outcome: 'not-final' });

/** The settled-payment checks that contradict a completed execution, as PAY-05 contradiction reasons. */
const CONTRADICTIONS: Readonly<Record<string, string>> = Object.freeze({
  'lightning-preimage-mismatch': 'lightning.preimage-mismatch',
  'lightning-delivered-amount-mismatch': 'lightning.amount-mismatch',
  'lightning-fee-bound-violated': 'lightning.fee-bound-exceeded',
});

/**
 * PAY-06 — the Lightning rail's PAY-05 `PaymentFinalityAuthority`, implementing
 * the rail-neutral port **unchanged**: no preimage, payment hash or invoice
 * field was added to the generic contract; Lightning's proof travels as
 * normalized facts under the `lightning.` prefix.
 *
 * ## What final means on Lightning
 *
 * An HTLC is settled when the payee releases the payment preimage, and the
 * payment is final when the payer's node holds a preimage whose SHA-256 is the
 * invoice's payment hash: no party can reverse a settled HTLC. So, asked about
 * one completed governed payment, the authority:
 *
 * 1. reads the interlock reservation of that execution (written before the
 *    send) and requires it to equal the canonical payment — payee and payment
 *    hash (the governed destination), amount (exact millisatoshis), network,
 *    and the P11 / P12 handle;
 * 2. asks the configured node for **that** logical payment by payment hash,
 *    on the configured network;
 * 3. requires a settled payment whose preimage **decodes to 32 bytes and
 *    hashes to the payment hash** (never a string compare), whose delivered
 *    amount is exactly the governed amount and whose fee is within the
 *    reserved cap.
 *
 * | node fact | answer |
 * | --- | --- |
 * | all of the above | `final`, with deterministic evidence |
 * | succeeded but the preimage does not hash to the payment hash, or another amount, or a fee above the cap | `contradicted` (nothing recorded; P11 / P12 never rewritten) |
 * | terminally failed although P11 / P12 say completed | `contradicted` |
 * | in flight, not found, unreachable, another network, unreadable; no reservation, or one that disagrees | `not-final` |
 *
 * ## Deterministic evidence
 *
 * Facts come only from the reservation, the governed payment and the settled
 * payment's immutable proof: network, payment hash, payee, invoice digest,
 * amount, fee, fee cap and a **commitment** to the preimage — never a route,
 * an HTLC attempt, an attempt order, a node timestamp or a debug string. No
 * `finalizedAt`: a payer node's settle time is its own local clock, not an
 * instant the network established, so it is left out (PAY-05 does not require
 * it). The same payment yields the same evidence on every read, after a
 * restart or the settlement store's loss.
 *
 * ## Disclosure
 *
 * The preimage itself is never returned or recorded: the fact is
 * `preimageCommitment(preimage)`, a domain-separated digest (the plain SHA-256
 * of the preimage is the payment hash, already in the evidence).
 *
 * Read-only: it holds a `LightningNodeReader` (no send) and the interlock's
 * `read`; it never sends, retries, builds a route or writes anything, and is
 * asked only from an explicit settlement verification.
 */
export function createLightningFinalityAuthority(options: LightningFinalityAuthorityOptions): PaymentFinalityAuthority {
  const configuration = options?.configuration;
  if (!isLightningRailConfiguration(configuration)) throw new TypeError('The Lightning finality authority needs a validated rail configuration.');
  const node = options.node;
  for (const method of ['nodeInfo', 'paymentStatus'] as const) {
    if (typeof node?.[method] !== 'function') throw new TypeError(`The Lightning finality authority's node reader must implement ${method}.`);
  }
  const interlock = options.interlock;
  if (typeof interlock?.read !== 'function') throw new TypeError('The Lightning finality authority needs read access to the interlock.');
  const timeout = configuration.requestTimeoutMs;

  async function verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer> {
    const payment = query.payment;
    // Only this rail's payments, in its configured asset, from a mapped account, to a Lightning destination.
    if (query.railId !== undefined && query.railId !== configuration.railId) return NOT_FINAL;
    if (payment.amount.unit !== configuration.asset.paymentAsset) return NOT_FINAL;
    if (!configuration.sourceAccounts.includes(payment.source.accountId)) return NOT_FINAL;
    const destination = parseLightningDestination(payment.destination);
    const amountMsat = msatOfBtcDecimal(payment.amount.value);
    if (destination === undefined || amountMsat === undefined) return NOT_FINAL;

    let record: LightningPaymentReservationRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return NOT_FINAL;
    }
    // The reservation, the P11 / P12 handle and the canonical payment must describe the same logical payment.
    if (record === undefined || record.executionId !== query.executionId || record.network !== configuration.network) return NOT_FINAL;
    if (record.paymentHash !== destination.paymentHash || record.payee !== destination.payee || record.amountMsat !== amountMsat) return NOT_FINAL;
    if (query.providerRef !== undefined && query.providerRef !== record.paymentHash) return NOT_FINAL;

    try {
      const info = readLightningNodeInfo(await node.nodeInfo(timeout));
      if (info === undefined || info.network !== configuration.network) return NOT_FINAL;
      const observation = readLightningPaymentObservation(await node.paymentStatus(record.paymentHash, timeout));
      const conclusion = concludeLightningPayment(observation, record);
      switch (conclusion.kind) {
        case 'failed':
          return Object.freeze({ outcome: 'contradicted', reason: 'lightning.payment-failed' });
        case 'inconsistent': {
          // Only a settled payment for THIS hash can contradict; an answer about another hash proves nothing about this one.
          const reason = CONTRADICTIONS[conclusion.detail];
          return reason === undefined ? NOT_FINAL : Object.freeze({ outcome: 'contradicted', reason });
        }
        case 'pending':
        case 'unknown':
          return NOT_FINAL;
        case 'completed':
          break;
      }
      const facts: PaymentFinalityFact[] = [
        { name: 'lightning.amount-msat', value: record.amountMsat.toString() },
        { name: 'lightning.fee-limit-msat', value: record.feeLimitMsat.toString() },
        { name: 'lightning.fee-msat', value: conclusion.feeMsat.toString() },
        { name: 'lightning.invoice-digest', value: record.invoiceDigest },
        { name: 'lightning.network', value: record.network },
        { name: 'lightning.payee-node', value: record.payee },
        { name: 'lightning.payment-hash', value: record.paymentHash },
        { name: 'lightning.preimage-commitment', value: preimageCommitment(conclusion.preimage) },
      ];
      // The amount restated from the reservation, exactly as governed (it equals the payment's by the check above).
      const value = btcDecimalOfMsat(record.amountMsat);
      if (value !== payment.amount.value) return NOT_FINAL;
      return Object.freeze({
        outcome: 'final',
        evidence: {
          executionId: query.executionId,
          method: LIGHTNING_FINALITY_METHOD,
          providerRef: record.paymentHash,
          amount: { value, unit: payment.amount.unit },
          source: { accountId: payment.source.accountId },
          destination: { kind: payment.destination.kind, reference: payment.destination.reference },
          facts,
        },
      });
    } catch {
      return NOT_FINAL;
    }
  }

  return Object.freeze({ authorityId: LIGHTNING_FINALITY_AUTHORITY_ID, verifyFinality });
}
