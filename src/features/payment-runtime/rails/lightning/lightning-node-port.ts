import { LIGHTNING_NETWORKS, type LightningNetwork } from './lightning-bolt11.js';
import { msatOfDecimalText } from './lightning-amount.js';
import { isLightningPaymentHash } from './lightning-destination.js';
import { isLightningNodePublicKey } from './lightning-signature.js';

/**
 * The Lightning node capability boundary (PAY-06) — the domain facts the rail
 * needs from a node, and nothing of any node's SDK.
 *
 * Split by authority:
 *
 * - `LightningNodeReader` — reads only: which network and identity the node
 *   is, the node's **own** decoding of an invoice, and one logical payment's
 *   state by payment hash. The P12 resolution authority and the PAY-05
 *   finality authority are composed with a reader built by
 *   `readOnlyLightningNode` — a fresh frozen object with exactly these
 *   methods — and so cannot reach a send even by accident (structurally
 *   tested). A reference node adapter can also give the reader its own,
 *   node-enforced read-only credential.
 * - `LightningNodePort` — the reader plus `sendPayment`, the one money-moving
 *   operation. Only the rail holds it.
 *
 * ## One logical payment
 *
 * `sendPayment` initiates **one** logical payment for one payment hash. A node
 * may try several routes and HTLCs (and split into parts) inside that one
 * operation — that is the node's routing, bounded by the fee cap and timeout
 * the call carries, and it is **not** Frontera retrying. Frontera never calls
 * `sendPayment` a second time for an execution.
 *
 * ## Answers are facts, not vendor vocabulary
 *
 * Every answer is normalized here, closed, before the rail believes it: no
 * vendor enum, error string or transport detail crosses into P11, P12 or a
 * settlement. A node adapter that cannot classify an answer reports it as an
 * unreadable value (or throws), which every caller treats as unknown.
 */

/** Why a definitive failure happened, in neutral words. Each is a node's terminal verdict on the logical payment — no part of it is in flight. */
export const LIGHTNING_PAYMENT_FAILURES = ['no-route', 'timeout', 'incorrect-payment-details', 'insufficient-balance', 'canceled', 'error'] as const;
export type LightningPaymentFailure = (typeof LIGHTNING_PAYMENT_FAILURES)[number];

/**
 * One logical payment's state as a node reports it:
 *
 * - `succeeded` — settled, with the preimage the payee released;
 * - `failed` — terminal: the node gave up **and** no part is in flight, so it can never settle (absent a new send, which Frontera never makes);
 * - `in-flight` — initiated, not terminal (HTLCs pending, or still routing);
 * - `not-found` — the node holds no payment for this hash (status queries only). Never evidence that nothing was sent.
 */
export type LightningPaymentObservation =
  | { readonly state: 'succeeded'; readonly paymentHash: string; readonly preimage: string; readonly amountMsat: bigint; readonly feeMsat: bigint }
  | { readonly state: 'failed'; readonly paymentHash: string; readonly failure: LightningPaymentFailure }
  | { readonly state: 'in-flight'; readonly paymentHash: string }
  | { readonly state: 'not-found' };

export interface LightningNodeInfo {
  readonly network: LightningNetwork;
  /** The node's own identity key. */
  readonly identity: string;
}

/** The node's own reading of an invoice — compared exactly with Frontera's independent decoding before anything is sent. */
export interface LightningNodeInvoiceView {
  readonly payee: string;
  readonly paymentHash: string;
  /** Absent for an amountless invoice. */
  readonly amountMsat?: bigint;
}

/** What the rail hands the node for the one send. Every value is Frontera's: the invoice from the trusted source, the cap from configuration. */
export interface LightningPaymentInstruction {
  /** The verified BOLT11 invoice, as decoded (lowercase). */
  readonly invoice: string;
  readonly paymentHash: string;
  /** The exact amount the invoice states (amountless invoices are never sent). */
  readonly amountMsat: bigint;
  /** The routing-fee cap the node must enforce while it routes. */
  readonly feeLimitMsat: bigint;
  /** The node's own routing deadline. */
  readonly timeoutSeconds: number;
  /** How long the caller waits for the node's final answer before it stops listening (and reports `unconfirmed`). */
  readonly deadlineMs: number;
}

/**
 * Thrown by `sendPayment` **only** when the node provably never received the
 * request — the connection was never established, so not one byte of it left
 * this process. Any other failure means the request may have reached the node.
 */
export class LightningSendNotAttemptedError extends Error {
  constructor() {
    super('The Lightning payment request never left this process.');
    this.name = 'LightningSendNotAttemptedError';
  }
}

export interface LightningNodeReader {
  nodeInfo(timeoutMs: number): Promise<unknown>;
  decodeInvoice(invoice: string, timeoutMs: number): Promise<unknown>;
  paymentStatus(paymentHash: string, timeoutMs: number): Promise<unknown>;
}

export interface LightningNodePort extends LightningNodeReader {
  /** The one money-moving operation. At most once per execution, ever. */
  sendPayment(instruction: LightningPaymentInstruction): Promise<unknown>;
}

/** The reader capability, alone: a fresh frozen object with no path to `sendPayment`. */
export function readOnlyLightningNode(node: LightningNodeReader): LightningNodeReader {
  const nodeInfo = node.nodeInfo;
  const decodeInvoice = node.decodeInvoice;
  const paymentStatus = node.paymentStatus;
  if (typeof nodeInfo !== 'function' || typeof decodeInvoice !== 'function' || typeof paymentStatus !== 'function') throw new TypeError('A Lightning node reader needs nodeInfo, decodeInvoice and paymentStatus.');
  return Object.freeze({
    nodeInfo: (timeoutMs: number) => nodeInfo.call(node, timeoutMs),
    decodeInvoice: (invoice: string, timeoutMs: number) => decodeInvoice.call(node, invoice, timeoutMs),
    paymentStatus: (paymentHash: string, timeoutMs: number) => paymentStatus.call(node, paymentHash, timeoutMs),
  });
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Reads own data properties only — an accessor is refused unread, no Proxy trap consulted. */
function fields(raw: unknown, allowed: readonly string[]): Map<string, unknown> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  return values;
}

function msat(value: unknown): bigint | undefined {
  return typeof value === 'bigint' ? (value >= 0n ? value : undefined) : msatOfDecimalText(value);
}

/** A node adapter's payment answer, read closed — or `undefined` (unknown). A 32-byte preimage, lowercase hex, when succeeded. */
export function readLightningPaymentObservation(raw: unknown): LightningPaymentObservation | undefined {
  try {
    const values = fields(raw, ['state', 'paymentHash', 'preimage', 'amountMsat', 'feeMsat', 'failure']);
    if (values === undefined) return undefined;
    const state = values.get('state');
    if (state === 'not-found') return values.size === 1 ? Object.freeze({ state }) : undefined;
    const paymentHash = values.get('paymentHash');
    if (!isLightningPaymentHash(paymentHash)) return undefined;
    if (state === 'in-flight') return values.size === 2 ? Object.freeze({ state, paymentHash }) : undefined;
    if (state === 'failed') {
      const failure = values.get('failure');
      return values.size === 3 && LIGHTNING_PAYMENT_FAILURES.includes(failure as LightningPaymentFailure) ? Object.freeze({ state, paymentHash, failure: failure as LightningPaymentFailure }) : undefined;
    }
    if (state !== 'succeeded' || values.size !== 5) return undefined;
    const preimage = values.get('preimage');
    const amountMsat = msat(values.get('amountMsat'));
    const feeMsat = msat(values.get('feeMsat'));
    if (!isLightningPaymentHash(preimage) || amountMsat === undefined || amountMsat <= 0n || feeMsat === undefined) return undefined;
    return Object.freeze({ state, paymentHash, preimage, amountMsat, feeMsat });
  } catch {
    return undefined;
  }
}

export function readLightningNodeInfo(raw: unknown): LightningNodeInfo | undefined {
  try {
    const values = fields(raw, ['network', 'identity']);
    const network = values?.get('network');
    const identity = values?.get('identity');
    return values?.size === 2 && LIGHTNING_NETWORKS.includes(network as LightningNetwork) && isLightningNodePublicKey(identity) ? Object.freeze({ network: network as LightningNetwork, identity }) : undefined;
  } catch {
    return undefined;
  }
}

export function readLightningNodeInvoiceView(raw: unknown): LightningNodeInvoiceView | undefined {
  try {
    const values = fields(raw, ['payee', 'paymentHash', 'amountMsat']);
    if (values === undefined) return undefined;
    const payee = values.get('payee');
    const paymentHash = values.get('paymentHash');
    if (!isLightningNodePublicKey(payee) || !isLightningPaymentHash(paymentHash)) return undefined;
    if (!values.has('amountMsat')) return values.size === 2 ? Object.freeze({ payee, paymentHash }) : undefined;
    const amountMsat = msat(values.get('amountMsat'));
    return amountMsat === undefined ? undefined : Object.freeze({ payee, paymentHash, amountMsat });
  } catch {
    return undefined;
  }
}
