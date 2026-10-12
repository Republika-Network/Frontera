import { EXECUTION_FAILURE_REASONS, type ExecutionFailureReason } from '../../../execution-runtime/index.js';
import type { PaymentExecutionRequest, PaymentRail, PaymentRailResult } from '../../domain/index.js';
import { msatOfBtcDecimal } from './lightning-amount.js';
import { bolt11ExpiresAt, decodeBolt11Invoice, type Bolt11Invoice } from './lightning-bolt11.js';
import { concludeLightningPayment } from './lightning-classification.js';
import { LightningRailConfigurationError, isLightningRailConfiguration, lightningFeeLimitMsat, type LightningRailConfiguration } from './lightning-config.js';
import { parseLightningDestination, type LightningDestination } from './lightning-destination.js';
import type { LightningInvoiceSource } from './lightning-invoice-source.js';
import { LightningSendNotAttemptedError, readLightningNodeInfo, readLightningNodeInvoiceView, readLightningPaymentObservation, type LightningNodePort } from './lightning-node-port.js';
import type { LightningPaymentInterlock, LightningPaymentReservationInput } from './lightning-payment-interlock.js';
import { invoiceDigest } from './lightning-preimage.js';
import { LIGHTNING_FAILURE_DETAILS, LIGHTNING_RAIL_DETAILS, type LightningRailDetail } from './lightning-rail-details.js';

/**
 * A logger the host bridges to its own. Only bounded, non-secret fields are
 * logged: the rail id, the execution id, the payment hash and a detail token —
 * never an invoice, a preimage, a route, an amount or anything a node
 * credential is made of.
 */
export interface LightningRailLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface LightningRailOptions {
  readonly configuration: LightningRailConfiguration;
  /** The node capability, including the one money-moving operation. Credentials live inside it (trusted composition), never here. */
  readonly node: LightningNodePort;
  /** The trusted source of invoice text for a governed payee and payment hash. */
  readonly invoices: LightningInvoiceSource;
  /** The durable interlock, written before every send. Required: there is no Lightning rail without it. */
  readonly interlock: LightningPaymentInterlock;
  readonly logger?: LightningRailLogger;
  /** Injected for deterministic qualification; default the process clock (milliseconds). */
  readonly now?: () => number;
}

export type LightningRailReadiness = { readonly status: 'ready'; readonly network: string } | { readonly status: 'unavailable'; readonly detail: LightningRailDetail };

/** A `PaymentRail`, plus readiness (node reachable, on the configured network). Readiness never initiates a payment. */
export interface LightningRail extends PaymentRail {
  readiness(): Promise<LightningRailReadiness>;
}

const F = EXECUTION_FAILURE_REASONS;
const D = LIGHTNING_RAIL_DETAILS;

/** Thrown before the send to leave with a definitive refusal. Never escapes the rail. */
class Refusal {
  constructor(
    readonly reason: ExecutionFailureReason,
    readonly detail: LightningRailDetail,
  ) {}
}

interface Prepared {
  readonly destination: LightningDestination;
  readonly amountMsat: bigint;
}

/**
 * The Lightning payment rail (PAY-06) — Frontera's second, structurally
 * different rail, implementing PAY-01's `PaymentRail` unchanged.
 *
 * Composed by the embedder through `createPaymentRailExecutionAdapter` and
 * reachable no other way: it receives a `PaymentExecutionRequest` only after
 * the governed path decided, granted, reserved P7 capacity and claimed the
 * execution. It decides nothing and translates one granted payment into at
 * most one logical Lightning payment.
 *
 * ## Per execution
 *
 * ```
 * prepare    asset = the trusted BTC asset; amount → exact msat; source mapped; destination = payee + payment hash   refusal → not-completed
 * interlock  an execution already reserved is NEVER sent again                                                        → unconfirmed (its payment hash)
 * invoice    trusted source → strict BOLT11 decode + signature → network, payee, payment hash, amount, expiry, CLTV  refusal → not-completed
 * node       network and identity (no self-payment); the node's OWN decoding must equal Frontera's                      refusal → not-completed
 * reserve    durable, atomic: one record per execution and per payment hash                                           refusal → not-completed
 * send       node.sendPayment ONCE, with the trusted fee cap and timeout                                              see below
 * ```
 *
 * ## Outcome (P11)
 *
 * | what the node proved | `PaymentRailResult` |
 * | --- | --- |
 * | succeeded, preimage hashes to the payment hash, amount exact, fee ≤ cap | `completed`, ref = payment hash |
 * | terminal failure, nothing in flight | `not-completed` `PROVIDER_REJECTED`, detail = the neutral failure |
 * | request provably never left the process | `not-completed` `PROVIDER_UNAVAILABLE` |
 * | in flight; RPC timeout; disconnect after the request may have been read; unreadable or inconsistent answer | `unconfirmed`, ref = payment hash |
 *
 * ## No retry
 *
 * `node.sendPayment` is called from exactly one place, at most once per
 * `execute`, and never for an execution the interlock already holds. The
 * node's internal route-finding (several HTLC attempts, multi-part) is one
 * logical payment under one payment hash, bounded by the cap and timeout the
 * call carries — never a second send.
 */
export function createLightningRail(options: LightningRailOptions): LightningRail {
  const configuration = options?.configuration;
  if (!isLightningRailConfiguration(configuration)) throw new LightningRailConfigurationError('configuration', 'must come from createLightningRailConfiguration');
  const node = options.node;
  for (const method of ['nodeInfo', 'decodeInvoice', 'paymentStatus', 'sendPayment'] as const) {
    if (typeof node?.[method] !== 'function') throw new LightningRailConfigurationError('node', `must implement ${method}`);
  }
  const invoices = options.invoices;
  if (typeof invoices?.invoiceFor !== 'function') throw new LightningRailConfigurationError('invoices', 'must implement invoiceFor');
  const interlock = options.interlock;
  if (typeof interlock?.recorded !== 'function' || typeof interlock.reserve !== 'function') throw new LightningRailConfigurationError('interlock', 'must implement recorded and reserve — the rail never sends without a durable reservation');
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;
  const railId = configuration.railId;
  const timeout = configuration.requestTimeoutMs;

  const log = (level: 'info' | 'warn', event: string, fields: Readonly<Record<string, unknown>>): void => {
    try {
      logger?.[level](event, { railId, ...fields });
    } catch {
      // A logger defect never changes a payment outcome.
    }
  };

  /** Pure: what the governed request alone determines. */
  function prepare(request: PaymentExecutionRequest): Prepared {
    if (request.amount.unit !== configuration.asset.paymentAsset) throw new Refusal(F.ADAPTER_ERROR, D.ASSET_UNSUPPORTED);
    const amountMsat = msatOfBtcDecimal(request.amount.value);
    if (amountMsat === undefined) throw new Refusal(F.ADAPTER_ERROR, D.AMOUNT_UNREPRESENTABLE);
    if (!configuration.sourceAccounts.includes(request.source.accountId)) throw new Refusal(F.ADAPTER_ERROR, D.SOURCE_UNMAPPED);
    const destination = parseLightningDestination(request.destination);
    if (destination === undefined) throw new Refusal(F.ADAPTER_ERROR, D.DESTINATION_INVALID);
    return { destination, amountMsat };
  }

  /** The invoice from the trusted source, decoded and held to every governed fact. */
  async function verifiedInvoice(request: PaymentExecutionRequest, prepared: Prepared): Promise<Bolt11Invoice> {
    let text: unknown;
    try {
      text = await invoices.invoiceFor({ ...prepared.destination, executionId: request.executionId });
    } catch {
      throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_UNAVAILABLE);
    }
    if (typeof text !== 'string') throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_UNAVAILABLE);
    const decoded = await decodeBolt11Invoice(text, configuration.maximumInvoiceLength);
    if (!decoded.valid) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_INVALID);
    const invoice = decoded.invoice;
    if (invoice.network !== configuration.network) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_NETWORK_MISMATCH);
    if (invoice.payee !== prepared.destination.payee) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_PAYEE_MISMATCH);
    if (invoice.paymentHash !== prepared.destination.paymentHash) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_PAYMENT_HASH_MISMATCH);
    if (invoice.amountMsat === undefined) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_AMOUNTLESS);
    if (invoice.amountMsat !== prepared.amountMsat) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_AMOUNT_MISMATCH);
    if (invoice.minFinalCltvExpiryDelta > configuration.maximumFinalCltvExpiryDelta) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_CLTV_UNSUPPORTED);
    checkTime(invoice);
    return invoice;
  }

  /** Not yet issued, and not expired with the safety margin to spare — checked before the node is consulted and again just before the send. */
  function checkTime(invoice: Bolt11Invoice): void {
    const seconds = Math.floor(now() / 1000);
    if (invoice.timestamp > seconds + configuration.maximumClockSkewSeconds) throw new Refusal(F.ADAPTER_ERROR, D.INVOICE_TIMESTAMP_IN_FUTURE);
    if (bolt11ExpiresAt(invoice) - configuration.minimumExpiryMarginSeconds <= seconds) throw new Refusal(F.PROVIDER_REJECTED, D.INVOICE_EXPIRED);
  }

  /** The node is the configured network's, is not the payee, and reads the invoice exactly as Frontera does. Reads only. */
  async function checkNode(invoice: Bolt11Invoice): Promise<void> {
    let info: ReturnType<typeof readLightningNodeInfo>;
    try {
      info = readLightningNodeInfo(await node.nodeInfo(timeout));
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.NODE_UNAVAILABLE);
    }
    if (info === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.NODE_UNAVAILABLE);
    if (info.network !== configuration.network) throw new Refusal(F.ADAPTER_ERROR, D.NODE_NETWORK_MISMATCH);
    if (info.identity === invoice.payee) throw new Refusal(F.ADAPTER_ERROR, D.NODE_SELF_PAYMENT);
    let view: ReturnType<typeof readLightningNodeInvoiceView>;
    try {
      view = readLightningNodeInvoiceView(await node.decodeInvoice(invoice.canonical, timeout));
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.NODE_UNAVAILABLE);
    }
    // A parser differential is a refusal: the node pays what IT decodes.
    if (view === undefined || view.payee !== invoice.payee || view.paymentHash !== invoice.paymentHash || view.amountMsat !== invoice.amountMsat) throw new Refusal(F.ADAPTER_ERROR, D.NODE_INVOICE_DISAGREEMENT);
  }

  function unconfirmed(request: PaymentExecutionRequest, paymentHash: string, detail: LightningRailDetail): PaymentRailResult {
    log('warn', 'lightning.payment.unconfirmed', { executionId: request.executionId, paymentHash, detail });
    return { status: 'unconfirmed', externalReference: paymentHash, detail };
  }

  /** An execution the interlock already holds: never sent again; `unconfirmed` with the payment hash it is bound to. */
  function previously(request: PaymentExecutionRequest, record: LightningPaymentReservationInput, prepared: Prepared): PaymentRailResult {
    const same = record.paymentHash === prepared.destination.paymentHash && record.payee === prepared.destination.payee && record.amountMsat === prepared.amountMsat;
    return unconfirmed(request, record.paymentHash, same ? D.EXECUTION_PREVIOUSLY_INITIATED : D.EXECUTION_INVOICE_CONFLICT);
  }

  /** The one send, and what the node's answer proves. Never throws. */
  async function sendOnce(request: PaymentExecutionRequest, record: LightningPaymentReservationInput, invoice: Bolt11Invoice): Promise<PaymentRailResult> {
    const deadlineMs = configuration.paymentTimeoutSeconds * 1000 + configuration.finalityGraceMs;
    let answer: unknown;
    try {
      answer = await withDeadline(
        node.sendPayment(
          Object.freeze({
            invoice: invoice.canonical,
            paymentHash: record.paymentHash,
            amountMsat: record.amountMsat,
            feeLimitMsat: record.feeLimitMsat,
            timeoutSeconds: configuration.paymentTimeoutSeconds,
            deadlineMs,
          }),
        ),
        deadlineMs + configuration.requestTimeoutMs,
      );
    } catch (error) {
      if (error instanceof LightningSendNotAttemptedError) {
        log('warn', 'lightning.payment.failed', { executionId: request.executionId, paymentHash: record.paymentHash, detail: D.SEND_NOT_ATTEMPTED });
        return { status: 'not-completed', reason: F.PROVIDER_UNAVAILABLE, externalReference: record.paymentHash, detail: D.SEND_NOT_ATTEMPTED };
      }
      return unconfirmed(request, record.paymentHash, D.SEND_OUTCOME_UNKNOWN);
    }
    const observation = readLightningPaymentObservation(answer);
    if (observation === undefined) return unconfirmed(request, record.paymentHash, D.NODE_ANSWER_UNREADABLE);
    const conclusion = concludeLightningPayment(observation, record);
    switch (conclusion.kind) {
      case 'completed':
        log('info', 'lightning.payment.completed', { executionId: request.executionId, paymentHash: record.paymentHash });
        return { status: 'completed', externalReference: record.paymentHash };
      case 'failed': {
        const detail = LIGHTNING_FAILURE_DETAILS[conclusion.failure];
        log('warn', 'lightning.payment.failed', { executionId: request.executionId, paymentHash: record.paymentHash, detail });
        return { status: 'not-completed', reason: F.PROVIDER_REJECTED, externalReference: record.paymentHash, detail };
      }
      case 'pending':
        return unconfirmed(request, record.paymentHash, D.PAYMENT_IN_FLIGHT);
      case 'inconsistent':
        return unconfirmed(request, record.paymentHash, conclusion.detail);
      case 'unknown':
        return unconfirmed(request, record.paymentHash, D.NODE_ANSWER_INCONSISTENT);
    }
  }

  async function execute(request: PaymentExecutionRequest): Promise<PaymentRailResult> {
    let record: LightningPaymentReservationInput;
    let invoice: Bolt11Invoice;
    try {
      const prepared = prepare(request);
      // ─── an execution the interlock already holds is never prepared or sent again ───
      let earlier: LightningPaymentReservationInput | undefined;
      try {
        earlier = await interlock.recorded(request.executionId);
      } catch {
        throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      }
      if (earlier !== undefined) return previously(request, earlier, prepared);
      invoice = await verifiedInvoice(request, prepared);
      await checkNode(invoice);
      record = Object.freeze({
        executionId: request.executionId,
        paymentHash: invoice.paymentHash,
        payee: invoice.payee,
        network: invoice.network,
        invoiceDigest: invoiceDigest(invoice.canonical),
        amountMsat: prepared.amountMsat,
        feeLimitMsat: lightningFeeLimitMsat(configuration, prepared.amountMsat),
        expiresAt: bolt11ExpiresAt(invoice),
      });
      // ─── durable before the send, or no send ───
      let reservation: Awaited<ReturnType<LightningPaymentInterlock['reserve']>>;
      try {
        reservation = await interlock.reserve(record);
      } catch {
        throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      }
      if (reservation?.outcome === 'execution-recorded') return previously(request, reservation.record, prepared);
      if (reservation?.outcome === 'payment-hash-reserved') throw new Refusal(F.ADAPTER_ERROR, D.PAYMENT_HASH_RESERVED);
      if (reservation?.outcome !== 'reserved') throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      log('info', 'lightning.payment.reserved', { executionId: request.executionId, paymentHash: record.paymentHash });
      // The invoice may have aged while the node was read: an expired invoice is never sent.
      checkTime(invoice);
    } catch (error) {
      // Reached only before the send: nothing left this process toward the node's payment engine.
      const refusal = error instanceof Refusal ? error : new Refusal(F.ADAPTER_ERROR, D.RAIL_ERROR_BEFORE_SEND);
      log('warn', 'lightning.payment.failed', { executionId: request.executionId, detail: refusal.detail });
      return { status: 'not-completed', reason: refusal.reason, detail: refusal.detail };
    }
    // ─── the one send ───
    return sendOnce(request, record, invoice);
  }

  async function readiness(): Promise<LightningRailReadiness> {
    try {
      const info = readLightningNodeInfo(await node.nodeInfo(timeout));
      if (info === undefined) return { status: 'unavailable', detail: D.NODE_UNAVAILABLE };
      if (info.network !== configuration.network) return { status: 'unavailable', detail: D.NODE_NETWORK_MISMATCH };
      return { status: 'ready', network: info.network };
    } catch {
      return { status: 'unavailable', detail: D.NODE_UNAVAILABLE };
    }
  }

  return Object.freeze({ railId, execute, readiness });
}

/** Stops waiting — never stops the node. A node adapter that does not honour its own deadline still cannot hold the execution forever. */
function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Not unref'd: this deadline decides a payment's recorded outcome, so it holds the process until it fires.
    const timer = setTimeout(() => reject(new Error('deadline')), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
