import {
  X402_HTTP_HEADERS,
  X402_PROTOCOL_ID,
  encodeX402PaymentSignatureHeader,
  isX402JsonObject,
  parseX402Json,
  readX402Requirements,
  type X402JsonObject,
  type X402PaymentRequirements,
} from '../../features/payment-runtime/protocols/x402/index.js';
import { parseLightningDestination, preimageMatchesPaymentHash, readLightningPaymentObservation, type LightningNodeReader } from '../../features/payment-runtime/rails/lightning/index.js';
import type { PaymentProtocolContextReader, VerifiedPaymentProtocolContext } from '../payment-protocol-ingress/index.js';
import type { PaymentSettlementService } from '../payment-settlement/index.js';
import { X402_LNBTC_NETWORKS, x402LightningBindingId } from './x402-lightning-binding.js';

/**
 * PAY-08 — the second request's `PAYMENT-SIGNATURE`, built only **after** the
 * governed payment executed and PAY-05 verified its funds final.
 *
 * ```
 * governed request id (trusted)          → PAY-04 context reader: the exact accepted requirement,
 *                                          its instrument, the server's extensions — never re-read from a merchant
 * execution id                           → PAY-05 readSettlement: state settled, for THIS request,
 *                                          THIS destination and THIS amount — HTTP 200 is not finality
 * payment hash (the governed destination) → the trusted proof source (the payer node, read-only):
 *                                          the preimage, checked SHA-256 → payment hash
 *   → PaymentPayload { x402Version 2, accepted = the governed requirement, payload { preimage },
 *                      extensions = the server's, unchanged (+ new client names only) }
 *   → base64 → an X402PaymentSignature (redacted everywhere but `reveal()`)
 * ```
 *
 * Nothing here pays, signs, submits, retries, calls a facilitator or makes a
 * network request: the builder reads three trusted sources and encodes. The
 * preimage is a bearer proof (scheme_exact_lnbtc.md, "Mandatory Cryptographic
 * Proof"): it is held only inside the returned object, never stored, logged,
 * put in an error, evidence or a receipt. Building twice yields the same value
 * for the same settled payment — a deterministic proof, not a second payment.
 */

export const X402_PAYMENT_SIGNATURE_REFUSALS = [
  /** No business operation is recorded for this governed request. */
  'context-not-found',
  /** The governed request was not presented through x402, or not through a binding this builder can prove. */
  'not-x402',
  /** The recorded requirement or extensions do not re-read. */
  'requirement-invalid',
  /** PAY-05 has not recorded this payment as settled (funds final). */
  'not-settled',
  /** The settlement on record is for another request, destination or amount. */
  'settlement-mismatch',
  /** The proof source has no proof (yet) for the payment. */
  'proof-unavailable',
  /** The proof does not verify against the governed payment hash. */
  'proof-invalid',
  /** A client extension would overwrite one the server sent. */
  'extension-overwrite',
  /** The payload could not be encoded within bounds. */
  'encoding-failed',
] as const;
export type X402PaymentSignatureRefusal = (typeof X402_PAYMENT_SIGNATURE_REFUSALS)[number];

const REDACTED = '[x402 PAYMENT-SIGNATURE: redacted]';

/** A built header value. Its text is bearer proof: only `reveal()` returns it; every other rendering is redacted. */
export class X402PaymentSignature {
  readonly header = X402_HTTP_HEADERS.paymentSignature;
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  /** The `PAYMENT-SIGNATURE` field value, for the HTTP layer that sends the paid request — and nothing else. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export type X402PaymentSignatureResult = { readonly outcome: 'built'; readonly signature: X402PaymentSignature } | { readonly outcome: 'refused'; readonly refusal: X402PaymentSignatureRefusal };

/** Where the proof of a completed Lightning payment is read — trusted, read-only. */
export interface X402LightningProofSource {
  /** The preimage for this payment hash when the payer node reports the payment succeeded, else `undefined`. May throw (refused). */
  preimageFor(paymentHash: string): Promise<string | undefined>;
}

/** The proof source over PAY-06's read-only node reader: `paymentStatus` only, bounded. It has no path to `sendPayment`. */
export function lightningNodeProofSource(reader: LightningNodeReader, options: { readonly timeoutMs?: number } = {}): X402LightningProofSource {
  if (reader === null || typeof reader !== 'object' || typeof reader.paymentStatus !== 'function') throw new TypeError('A read-only Lightning node reader is required.');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be between 1 and 60000.');
  const paymentStatus = reader.paymentStatus;
  return Object.freeze({
    async preimageFor(paymentHash: string): Promise<string | undefined> {
      const observation = readLightningPaymentObservation(await paymentStatus.call(reader, paymentHash, timeoutMs));
      return observation?.state === 'succeeded' && observation.paymentHash === paymentHash ? observation.preimage : undefined;
    },
  });
}

export interface X402PaymentSignatureBuilderOptions {
  readonly contexts: PaymentProtocolContextReader;
  readonly settlements: Pick<PaymentSettlementService, 'readSettlement'>;
  readonly proofs: X402LightningProofSource;
}

export interface X402PaymentSignatureRequest {
  readonly organizationId: string;
  /** The governed request id the ingress returned. */
  readonly requestId: string;
  /** The governed execution id the governed result carried. */
  readonly executionId: string;
  /** Client extension additions — new names only. */
  readonly clientExtensions?: X402JsonObject;
}

interface ProvableRequirement {
  readonly requirement: X402PaymentRequirements;
  readonly paymentHash: string;
  readonly extensions?: X402JsonObject;
}

const LIGHTNING_BINDINGS = new Map<string, string>(
  (Object.keys(X402_LNBTC_NETWORKS) as (keyof typeof X402_LNBTC_NETWORKS)[]).map((network) => [x402LightningBindingId(network), X402_LNBTC_NETWORKS[network].network]),
);

/** The recorded requirement, re-read and re-bound to the governed destination — never trusted as stored text alone. */
function provable(context: VerifiedPaymentProtocolContext): ProvableRequirement | X402PaymentSignatureRefusal {
  if (context.challenge.protocolId !== X402_PROTOCOL_ID) return 'not-x402';
  const fields = context.challenge.fields;
  const network = LIGHTNING_BINDINGS.get(fields['binding'] ?? '');
  if (network === undefined) return 'not-x402';
  const parsed = parseX402Json(fields['requirement'] ?? '');
  if (!parsed.valid) return 'requirement-invalid';
  let requirement: X402PaymentRequirements;
  try {
    requirement = readX402Requirements(parsed.value);
  } catch {
    return 'requirement-invalid';
  }
  let extensions: X402JsonObject | undefined;
  if (fields['extensions'] !== undefined) {
    const decoded = parseX402Json(fields['extensions']);
    if (!decoded.valid || !isX402JsonObject(decoded.value)) return 'requirement-invalid';
    extensions = decoded.value;
  }
  const destination = parseLightningDestination(context.terms.destination);
  if (destination === undefined || requirement.network !== network || requirement.payTo !== destination.payee) return 'requirement-invalid';
  if (fields['instrument'] !== `${network}:${destination.paymentHash}` || context.challenge.key !== `${X402_PROTOCOL_ID}:2:${network}:${destination.paymentHash}`) return 'requirement-invalid';
  return { requirement, paymentHash: destination.paymentHash, ...(extensions !== undefined ? { extensions } : {}) };
}

export function createX402PaymentSignatureBuilder(options: X402PaymentSignatureBuilderOptions): { build(request: X402PaymentSignatureRequest): Promise<X402PaymentSignatureResult> } {
  const { contexts, settlements, proofs } = options ?? ({} as X402PaymentSignatureBuilderOptions);
  if (contexts === null || typeof contexts !== 'object' || typeof contexts.readByGovernedRequestId !== 'function') throw new TypeError('The PAY-04 context reader is required.');
  if (settlements === null || typeof settlements !== 'object' || typeof settlements.readSettlement !== 'function') throw new TypeError('The PAY-05 settlement reader is required.');
  if (proofs === null || typeof proofs !== 'object' || typeof proofs.preimageFor !== 'function') throw new TypeError('A proof source is required.');
  const refuse = (refusal: X402PaymentSignatureRefusal): X402PaymentSignatureResult => Object.freeze({ outcome: 'refused', refusal });

  return Object.freeze({
    async build(request: X402PaymentSignatureRequest): Promise<X402PaymentSignatureResult> {
      const { organizationId, requestId, executionId } = request;
      let context: VerifiedPaymentProtocolContext | undefined;
      try {
        context = await contexts.readByGovernedRequestId(organizationId, requestId);
      } catch {
        context = undefined;
      }
      if (context === undefined || context.requestId !== requestId) return refuse('context-not-found');
      const reading = provable(context);
      if (typeof reading === 'string') return refuse(reading);

      // PAY-05 is the authority on funds finality. Nothing protocol-shaped substitutes for it.
      let status: Awaited<ReturnType<PaymentSettlementService['readSettlement']>>;
      try {
        status = await settlements.readSettlement({ organizationId, executionId });
      } catch {
        return refuse('not-settled');
      }
      if (status.outcome !== 'status' || status.state !== 'settled' || status.settlement === undefined) return refuse('not-settled');
      const settled = status.settlement;
      const governed = context.terms;
      if (
        settled.requestId !== requestId ||
        settled.executionId !== executionId ||
        settled.payment.destination.kind !== governed.destination.kind ||
        settled.payment.destination.reference !== governed.destination.reference ||
        settled.payment.amount.value !== governed.amount.value ||
        settled.payment.amount.unit !== governed.amount.unit
      ) {
        return refuse('settlement-mismatch');
      }

      let preimage: string | undefined;
      try {
        preimage = await proofs.preimageFor(reading.paymentHash);
      } catch {
        preimage = undefined;
      }
      if (preimage === undefined) return refuse('proof-unavailable');
      if (!preimageMatchesPaymentHash(preimage, reading.paymentHash)) return refuse('proof-invalid');

      const encoded = encodeX402PaymentSignatureHeader({
        accepted: reading.requirement,
        payload: Object.freeze({ preimage }),
        ...(reading.extensions !== undefined ? { serverExtensions: reading.extensions } : {}),
        ...(request.clientExtensions !== undefined ? { clientExtensions: request.clientExtensions } : {}),
      });
      if (!encoded.valid) return refuse(encoded.violation === 'extension-overwrite' ? 'extension-overwrite' : 'encoding-failed');
      return Object.freeze({ outcome: 'built', signature: new X402PaymentSignature(encoded.value) });
    },
  });
}
