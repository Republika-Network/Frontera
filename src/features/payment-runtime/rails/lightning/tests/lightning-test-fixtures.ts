import { createHash } from 'node:crypto';

import { bytesToWords, encodeBech32, wordsToPaddedBytes } from '../lightning-bech32.js';
import {
  LIGHTNING_INVOICE_PREFIXES,
  btcDecimalOfMsat,
  createLightningRailConfiguration,
  type LightningNetwork,
  type LightningNodePort,
  type LightningPaymentInstruction,
  type LightningPaymentInterlock,
  type LightningPaymentReservation,
  type LightningPaymentReservationInput,
  type LightningRailConfiguration,
  type LightningRailConfigurationInput,
} from '../index.js';

/**
 * PAY-06 test fixtures — test-only, never production sources.
 *
 * - **Invoices** are built word by word and signed here, with keys derived at
 *   runtime from a label (no key literal in source; none is funded anywhere).
 *   Signing is test-only: no production source creates or signs an invoice
 *   (`lightning-rail-boundaries.test.ts`).
 * - **`createSimulatedLightningNode`** is a deterministic, in-memory node with
 *   LND's payment semantics: one logical payment per payment hash; routing
 *   bounded by the fee cap (a route dearer than the cap is a terminal
 *   `no-route`); `FAILED` only once nothing is in flight; hold invoices that
 *   keep a payment in flight until the payee settles or cancels; a duplicate
 *   send for an in-flight or succeeded hash refused (as LND does — defence in
 *   depth, never Frontera's guarantee). Every call is counted, so a test can
 *   prove how many sends happened.
 * - **`createInMemoryLightningInterlock`** has the port's two uniqueness rules,
 *   in memory (the durable, witness-anchored one is enterprise code).
 */

export const BTC_ASSET = 'net:BTC';
export const GOVERNED_ACCOUNT = 'treasury-lightning';
/** A fixed "now" inside every fixture invoice's validity: 2026-10-12T00:00:00Z. */
export const TEST_NOW_MS = Date.UTC(2026, 9, 12, 0, 0, 0);
export const TEST_NOW_SECONDS = Math.floor(TEST_NOW_MS / 1000);

interface Curve {
  getPublicKey(secret: Uint8Array, compressed?: boolean): Uint8Array;
  sign(message: Uint8Array, secret: Uint8Array, options: { readonly prehash: false; readonly format: 'recovered'; readonly lowS?: boolean }): Uint8Array;
}

let curve: Promise<Curve> | undefined;
function secp(): Promise<Curve> {
  curve ??= import('@noble/curves/secp256k1.js').then((module) => module.secp256k1 as unknown as Curve);
  return curve;
}

/** A test key: 32 bytes derived from a label. Valid for secp256k1 with overwhelming probability (checked by the curve on use). */
export function testSecretKey(label: string): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(`frontera-pay06-test-key:${label}`).digest());
}

export async function testNodeKey(label: string): Promise<string> {
  return Buffer.from((await secp()).getPublicKey(testSecretKey(label), true)).toString('hex');
}

/** A test preimage and its payment hash, derived from a label. */
export function testPreimage(label: string): { readonly preimage: string; readonly paymentHash: string } {
  const preimage = createHash('sha256').update(`frontera-pay06-test-preimage:${label}`).digest();
  return { preimage: preimage.toString('hex'), paymentHash: createHash('sha256').update(preimage).digest('hex') };
}

function integerWords(value: number): number[] {
  if (value === 0) return [0];
  const words: number[] = [];
  let rest = value;
  while (rest > 0) {
    words.unshift(rest % 32);
    rest = Math.floor(rest / 32);
  }
  return words;
}

function tagged(tag: number, words: readonly number[]): number[] {
  return [tag, Math.floor(words.length / 32), words.length % 32, ...words];
}

function featureWords(bits: readonly number[]): number[] {
  if (bits.length === 0) return [];
  const highest = Math.max(...bits);
  const count = Math.floor(highest / 5) + 1;
  const words = new Array<number>(count).fill(0);
  for (const bit of bits) words[count - 1 - Math.floor(bit / 5)] = (words[count - 1 - Math.floor(bit / 5)] ?? 0) | (1 << (bit % 5));
  return words;
}

export interface InvoiceSpec {
  readonly network?: LightningNetwork;
  /** The hrp amount (`2500u`, `20m`, `10n`, `100p`) or '' for amountless. Default from `amountMsat`. */
  readonly hrpAmount?: string;
  readonly amountMsat?: bigint;
  readonly timestamp?: number;
  readonly paymentHash: string;
  readonly payeeKeyLabel: string;
  readonly description?: string;
  readonly descriptionHash?: boolean;
  readonly expirySeconds?: number;
  readonly minFinalCltvExpiryDelta?: number;
  readonly features?: readonly number[];
  /** Include the payee's `n` field. */
  readonly nField?: boolean;
  /** Raw extra fields appended (word-level), for malformed-field cases. */
  readonly extraFields?: readonly { readonly tag: number; readonly words: readonly number[] }[];
  /** Fields to leave out. */
  readonly omit?: readonly ('p' | 's' | 'd')[];
  readonly routeHints?: readonly Uint8Array[];
  /** Sign with this key label instead of the payee's (a forged invoice). */
  readonly signWithLabel?: string;
  /** Flip the recovery id (the signature stays valid, but recovers another key). */
  readonly flipRecovery?: boolean;
  /** Emit the signature in high-S form (recovery id adjusted, so recovery is unchanged). */
  readonly highS?: boolean;
}

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The shortest BOLT11 hrp amount for an exact msat value. */
export function hrpAmountOf(msat: bigint): string {
  if (msat % 100_000_000_000n === 0n) return (msat / 100_000_000_000n).toString();
  if (msat % 100_000_000n === 0n) return `${msat / 100_000_000n}m`;
  if (msat % 100_000n === 0n) return `${msat / 100_000n}u`;
  if (msat % 100n === 0n) return `${msat / 100n}n`;
  return `${msat * 10n}p`;
}

/** Builds and signs one BOLT11 invoice. */
export async function buildInvoice(spec: InvoiceSpec): Promise<string> {
  const network = spec.network ?? 'regtest';
  const amount = spec.hrpAmount ?? (spec.amountMsat !== undefined ? hrpAmountOf(spec.amountMsat) : '');
  const prefix = `${LIGHTNING_INVOICE_PREFIXES[network]}${amount}`;
  const timestamp = spec.timestamp ?? TEST_NOW_SECONDS - 60;
  const omit = new Set(spec.omit ?? []);
  const words: number[] = [];
  const ts = integerWords(timestamp);
  words.push(...new Array<number>(7 - ts.length).fill(0), ...ts);
  if (!omit.has('p')) words.push(...tagged(1, bytesToWords(Buffer.from(spec.paymentHash, 'hex'))));
  if (!omit.has('s')) words.push(...tagged(16, bytesToWords(createHash('sha256').update(`secret:${spec.paymentHash}`).digest())));
  if (!omit.has('d')) {
    if (spec.descriptionHash === true) words.push(...tagged(23, bytesToWords(createHash('sha256').update(spec.description ?? 'goods').digest())));
    else words.push(...tagged(13, bytesToWords(Buffer.from(spec.description ?? 'pay06 test goods', 'utf8'))));
  }
  if (spec.expirySeconds !== undefined) words.push(...tagged(6, integerWords(spec.expirySeconds)));
  words.push(...tagged(24, integerWords(spec.minFinalCltvExpiryDelta ?? 40)));
  const features = spec.features ?? [8, 14];
  if (features.length > 0) words.push(...tagged(5, featureWords(features)));
  for (const hint of spec.routeHints ?? []) words.push(...tagged(3, bytesToWords(hint)));
  const payeeSecret = testSecretKey(spec.payeeKeyLabel);
  const secp256k1 = await secp();
  if (spec.nField === true) words.push(...tagged(19, bytesToWords(secp256k1.getPublicKey(payeeSecret, true))));
  for (const field of spec.extraFields ?? []) words.push(...tagged(field.tag, field.words));
  const message = Uint8Array.from([...Buffer.from(prefix, 'utf8'), ...wordsToPaddedBytes(words)]);
  const digest = createHash('sha256').update(message).digest();
  const signed = secp256k1.sign(digest, testSecretKey(spec.signWithLabel ?? spec.payeeKeyLabel), { prehash: false, format: 'recovered' });
  let recovery = signed[0] ?? 0;
  const r = signed.subarray(1, 33);
  let s = signed.subarray(33, 65);
  if (spec.highS === true) {
    const value = BigInt(`0x${Buffer.from(s).toString('hex')}`);
    s = Buffer.from((CURVE_ORDER - value).toString(16).padStart(64, '0'), 'hex');
    recovery ^= 1;
  }
  if (spec.flipRecovery === true) recovery ^= 1;
  const signature = Uint8Array.from([...r, ...s, recovery]);
  return encodeBech32(prefix, [...words, ...bytesToWords(signature)]);
}

export function testRailConfigurationInput(overrides: Partial<LightningRailConfigurationInput> = {}): LightningRailConfigurationInput {
  return {
    network: 'regtest',
    asset: { paymentAsset: BTC_ASSET, scale: 11 },
    sourceAccounts: [GOVERNED_ACCOUNT],
    fees: { maximumFeeMsat: '50000', maximumFeePpm: 10_000 },
    paymentTimeoutSeconds: 30,
    requestTimeoutMs: 2_000,
    finalityGraceMs: 2_000,
    ...overrides,
  };
}

export function testRailConfiguration(overrides: Partial<LightningRailConfigurationInput> = {}): LightningRailConfiguration {
  return createLightningRailConfiguration(testRailConfigurationInput(overrides));
}

// ───────────────────────────── simulated node ─────────────────────────────

type SimulatedBehaviour = 'succeed' | 'fail' | 'hold' | 'hang' | 'disconnect-after-accept' | 'not-attempted' | 'garbage' | 'wrong-preimage' | 'overpay-fee' | 'other-amount';

export interface SimulatedInvoice {
  readonly invoice: string;
  readonly paymentHash: string;
  readonly preimage: string;
  readonly payee: string;
  readonly amountMsat: bigint;
  /** The fee the only route to this payee costs, in msat. */
  readonly routeFeeMsat: bigint;
}

interface SimulatedPayment {
  state: 'in-flight' | 'succeeded' | 'failed';
  readonly paymentHash: string;
  readonly amountMsat: bigint;
  readonly feeMsat: bigint;
  readonly preimage: string;
  failure?: string;
}

export interface SimulatedLightningNode extends LightningNodePort {
  readonly identity: string;
  network: LightningNetwork;
  /** What the next send does. */
  behaviour: SimulatedBehaviour;
  /** Every send instruction received, in order. */
  readonly sends: LightningPaymentInstruction[];
  readonly calls: { nodeInfo: number; decodeInvoice: number; paymentStatus: number; sendPayment: number };
  /** Makes reads fail (node unreachable). */
  unreachable: boolean;
  /** Overrides the node's own decoding (parser differential). */
  decodeOverride?: (invoice: string) => unknown;
  /** Overrides status answers (malformed / lying node). */
  statusOverride?: (paymentHash: string) => unknown;
  registerInvoice(input: { readonly label: string; readonly amountMsat: bigint; readonly payeeKeyLabel?: string; readonly routeFeeMsat?: bigint; readonly expirySeconds?: number; readonly timestamp?: number; readonly network?: LightningNetwork }): Promise<SimulatedInvoice>;
  settleHeld(paymentHash: string): void;
  cancelHeld(paymentHash: string): void;
  payment(paymentHash: string): Readonly<SimulatedPayment> | undefined;
}

export async function createSimulatedLightningNode(options: { readonly network?: LightningNetwork; readonly identityLabel?: string } = {}): Promise<SimulatedLightningNode> {
  const identity = await testNodeKey(options.identityLabel ?? 'payer-node');
  const invoices = new Map<string, SimulatedInvoice>();
  const payments = new Map<string, SimulatedPayment>();
  const calls = { nodeInfo: 0, decodeInvoice: 0, paymentStatus: 0, sendPayment: 0 };
  const sends: LightningPaymentInstruction[] = [];
  const { decodeBolt11Invoice } = await import('../lightning-bolt11.js');

  const node: SimulatedLightningNode = {
    identity,
    network: options.network ?? 'regtest',
    behaviour: 'succeed',
    sends,
    calls,
    unreachable: false,
    async registerInvoice(input) {
      const { preimage, paymentHash } = testPreimage(input.label);
      const payeeKeyLabel = input.payeeKeyLabel ?? 'payee-node';
      const invoice = await buildInvoice({
        network: input.network ?? node.network,
        amountMsat: input.amountMsat,
        paymentHash,
        payeeKeyLabel,
        ...(input.expirySeconds !== undefined ? { expirySeconds: input.expirySeconds } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      });
      const entry: SimulatedInvoice = { invoice, paymentHash, preimage, payee: await testNodeKey(payeeKeyLabel), amountMsat: input.amountMsat, routeFeeMsat: input.routeFeeMsat ?? 1_000n };
      invoices.set(paymentHash, entry);
      return entry;
    },
    settleHeld(paymentHash) {
      const payment = payments.get(paymentHash);
      if (payment?.state === 'in-flight') payment.state = 'succeeded';
    },
    cancelHeld(paymentHash) {
      const payment = payments.get(paymentHash);
      if (payment?.state === 'in-flight') {
        payment.state = 'failed';
        payment.failure = 'incorrect-payment-details';
      }
    },
    payment: (paymentHash) => payments.get(paymentHash),
    async nodeInfo() {
      calls.nodeInfo += 1;
      if (node.unreachable) throw new Error('unreachable');
      return { network: node.network, identity };
    },
    async decodeInvoice(invoice) {
      calls.decodeInvoice += 1;
      if (node.unreachable) throw new Error('unreachable');
      if (node.decodeOverride !== undefined) return node.decodeOverride(invoice);
      const decoded = await decodeBolt11Invoice(invoice);
      if (!decoded.valid) throw new Error('invalid invoice');
      return { payee: decoded.invoice.payee, paymentHash: decoded.invoice.paymentHash, ...(decoded.invoice.amountMsat !== undefined ? { amountMsat: decoded.invoice.amountMsat } : {}) };
    },
    async paymentStatus(paymentHash) {
      calls.paymentStatus += 1;
      if (node.unreachable) throw new Error('unreachable');
      if (node.statusOverride !== undefined) return node.statusOverride(paymentHash);
      return statusOf(paymentHash);
    },
    async sendPayment(instruction) {
      calls.sendPayment += 1;
      sends.push(instruction);
      const behaviour = node.behaviour;
      if (behaviour === 'not-attempted') {
        const { LightningSendNotAttemptedError } = await import('../lightning-node-port.js');
        throw new LightningSendNotAttemptedError();
      }
      const existing = payments.get(instruction.paymentHash);
      // LND refuses a second payment for a hash that is in flight or paid (defence in depth only).
      if (existing !== undefined && existing.state !== 'failed') throw new Error('payment already in flight or paid');
      const invoice = invoices.get(instruction.paymentHash);
      if (invoice === undefined) return { state: 'failed', paymentHash: instruction.paymentHash, failure: 'incorrect-payment-details' };
      if (invoice.routeFeeMsat > instruction.feeLimitMsat) {
        // The node never spends above the cap: no route within it.
        payments.set(instruction.paymentHash, { state: 'failed', paymentHash: instruction.paymentHash, amountMsat: invoice.amountMsat, feeMsat: 0n, preimage: invoice.preimage, failure: 'no-route' });
        return statusOf(instruction.paymentHash);
      }
      const payment: SimulatedPayment = { state: 'in-flight', paymentHash: instruction.paymentHash, amountMsat: invoice.amountMsat, feeMsat: invoice.routeFeeMsat, preimage: invoice.preimage };
      payments.set(instruction.paymentHash, payment);
      switch (behaviour) {
        case 'succeed':
          payment.state = 'succeeded';
          return statusOf(instruction.paymentHash);
        case 'fail':
          payment.state = 'failed';
          payment.failure = 'incorrect-payment-details';
          return statusOf(instruction.paymentHash);
        case 'hold':
          return statusOf(instruction.paymentHash);
        case 'hang':
          return new Promise(() => undefined);
        case 'disconnect-after-accept':
          // The node accepted and will settle; the connection dropped before the answer.
          payment.state = 'succeeded';
          throw new Error('socket hang up');
        case 'garbage':
          payment.state = 'succeeded';
          return { status: 'SUCCEEDED', weird: true };
        case 'wrong-preimage':
          payment.state = 'succeeded';
          return { state: 'succeeded', paymentHash: instruction.paymentHash, preimage: testPreimage('someone-else').preimage, amountMsat: invoice.amountMsat, feeMsat: invoice.routeFeeMsat };
        case 'overpay-fee':
          payment.state = 'succeeded';
          return { state: 'succeeded', paymentHash: instruction.paymentHash, preimage: invoice.preimage, amountMsat: invoice.amountMsat, feeMsat: instruction.feeLimitMsat + 1n };
        case 'other-amount':
          payment.state = 'succeeded';
          return { state: 'succeeded', paymentHash: instruction.paymentHash, preimage: invoice.preimage, amountMsat: invoice.amountMsat + 1n, feeMsat: invoice.routeFeeMsat };
      }
    },
  };

  function statusOf(paymentHash: string): unknown {
    const payment = payments.get(paymentHash);
    if (payment === undefined) return { state: 'not-found' };
    if (payment.state === 'in-flight') return { state: 'in-flight', paymentHash };
    if (payment.state === 'failed') return { state: 'failed', paymentHash, failure: payment.failure ?? 'error' };
    return { state: 'succeeded', paymentHash, preimage: payment.preimage, amountMsat: payment.amountMsat, feeMsat: payment.feeMsat };
  }

  return node;
}

// ───────────────────────────── in-memory interlock ─────────────────────────────

export interface InMemoryLightningInterlock extends LightningPaymentInterlock {
  readonly records: readonly LightningPaymentReservationInput[];
  failNext?: 'recorded' | 'reserve';
}

export function createInMemoryLightningInterlock(): InMemoryLightningInterlock {
  const records: LightningPaymentReservationInput[] = [];
  const interlock: InMemoryLightningInterlock = {
    records,
    async recorded(executionId) {
      if (interlock.failNext === 'recorded') {
        delete interlock.failNext;
        throw new Error('interlock unavailable');
      }
      return records.find((record) => record.executionId === executionId);
    },
    async reserve(record): Promise<LightningPaymentReservation> {
      if (interlock.failNext === 'reserve') {
        delete interlock.failNext;
        throw new Error('interlock unavailable');
      }
      const existing = records.find((entry) => entry.executionId === record.executionId);
      if (existing !== undefined) return { outcome: 'execution-recorded', record: existing };
      if (records.some((entry) => entry.paymentHash === record.paymentHash)) return { outcome: 'payment-hash-reserved' };
      records.push(Object.freeze({ ...record }));
      return { outcome: 'reserved' };
    },
  };
  return interlock;
}

export function btc(msat: bigint): string {
  const value = btcDecimalOfMsat(msat);
  if (value === undefined) throw new RangeError('not a representable msat amount');
  return value;
}
