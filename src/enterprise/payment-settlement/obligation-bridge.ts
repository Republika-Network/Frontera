import { isObligationType, type ObligationCorrelation } from '../../features/obligation-runtime/index.js';
import { isWellFormedMonetaryAmount, type MonetaryAmount } from '../../features/monetary-runtime/index.js';
import { isPaymentDestinationKind, isPaymentReference, type PaymentDestination, type PaymentSourceRef } from '../../features/payment-runtime/index.js';
import { computeDigest } from '../governance-store/digest.js';
import type { ObligationDischargeRecorder } from '../obligation-discharge/recorder.js';
import type { ObligationDischargeCorrelation, ObligationDischargeWriterContext, StoredObligationDischarge } from '../obligation-discharge/contracts.js';
import type { PaymentSettlementService } from './service.js';

/**
 * PAY-05 — settlement-verified payment obligations, through CORE-04.
 *
 * ```
 * a governed decision stands under a blocking obligation, e.g. `payment.settled`   (CORE-04: required — grant withheld)
 *   the payer makes the exact payment, its business reference DERIVED from that obligation instance
 *   → PAY-01 / governed path / rail / P11 (/ P12) → PAY-05 settlement (funds finality, evidence) → receipt
 * dischargeObligation(obligation, executionId)
 *   → trusted registry: is this a payment obligation, and what payment does it expect?   (PAY's, not CORE's)
 *   → the canonical settlement of that execution (verified, local — no network)
 *   → EXACT match: organization, amount, asset, destination, source (when expected),
 *                  the derived obligation reference, not itself a refund
 *   → CORE-04's own trusted recorder, citing a CONFIGURED discharge source           (CORE-04 classifies it)
 *   → the obligation runtime derives the state; the same committed decision resumes
 * ```
 *
 * ## CORE-04 owns the lifecycle
 *
 * PAY-05 writes one CORE-04 *observation* — "source S reports `discharged` for
 * obligation K of correlation C, reference = the receipt" — through the existing
 * `ObligationDischargeRecorder`, and nothing else. It never names a state,
 * never classifies a source, never verifies or waives anything: whether the
 * report verifies the obligation is decided by CORE-04's trusted source
 * registry (an `independent` source of kind `provider_adapter` or
 * `signed_attestation` verifies; a `self_reported` one leaves it
 * `discharged`). There is no second payment-obligation lifecycle and no
 * `PaymentIntent` in CORE state.
 *
 * ## Exact correlation
 *
 * The payment reference that satisfies an obligation is **derived** from the
 * obligation instance (`paymentObligationReference`): the payer must make the
 * payment under exactly that reference, which the governed path binds exactly
 * into the grant and P11. So payment X can satisfy obligation Y only if X was
 * made *for* Y — never because amount and asset happen to match, never by time
 * window, never by a caller's word. One receipt therefore discharges at most
 * one obligation; presented again for the same one it is idempotent, for any
 * other it is a mismatch. A receipt is evidence, not a bearer authorization.
 */

const OBLIGATION_REFERENCE_DOMAIN = 'aoc.payment-obligation.reference.v1';

/**
 * The business reference a payment must carry to satisfy one obligation
 * instance — a PAY-01 business reference token, derived from the obligation's
 * correlation and kind. Deterministic, not configurable, not chosen by anyone.
 */
export function paymentObligationReference(correlation: ObligationCorrelation, obligationType: string): string {
  const digest = computeDigest({
    domain: OBLIGATION_REFERENCE_DOMAIN,
    requestId: correlation.requestId,
    action: correlation.action,
    resourceScope: correlation.resourceScope,
    obligationType,
  });
  return `payobl-${digest.slice('sha256:'.length)}`;
}

/** What one payment obligation expects — trusted, payment-specific configuration (never CORE state). */
export interface PaymentObligationExpectation {
  readonly amount: MonetaryAmount;
  /** The beneficiary the payment must reach. */
  readonly destination: PaymentDestination;
  /** The account the payment must come from, when the obligation names the payer. */
  readonly source?: PaymentSourceRef;
}

export interface PaymentObligationQuery {
  readonly organizationId: string;
  readonly correlation: ObligationCorrelation;
  readonly obligationType: string;
}

/**
 * The trusted payment-obligation registry: for one obligation instance, the
 * payment it expects, or `undefined` when it is not a payment obligation this
 * deployment knows. Host composition (an order system, a contract register);
 * never reachable from a requester, and never a CORE-04 concept.
 */
export type PaymentObligationRegistry = (query: PaymentObligationQuery) => PaymentObligationExpectation | undefined | Promise<PaymentObligationExpectation | undefined>;

/** The CORE-04 discharge reads the bridge needs: the verified rows of one decision correlation (`ObligationDischargeStore.read`). */
export interface PaymentObligationDischargeReader {
  read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]>;
}

export interface PaymentObligationDischargerOptions {
  readonly settlements: Pick<PaymentSettlementService, 'readSettlement'>;
  readonly registry: PaymentObligationRegistry;
  /** CORE-04's trusted in-process writer. */
  readonly recorder: ObligationDischargeRecorder;
  readonly discharges: PaymentObligationDischargeReader;
  /** The configured CORE-04 discharge source this bridge reports as. Its verification class is CORE-04's configuration, never set here. */
  readonly sourceId: string;
  /** Who records — a service identity. Recorded by CORE-04, never interpreted. */
  readonly writer: ObligationDischargeWriterContext;
  /** The bridge's clock: the instant this source observes the settlement and reports it. */
  readonly now: () => string;
}

export interface PaymentObligationDischargeRequest {
  readonly organizationId: string;
  readonly obligation: { readonly correlation: ObligationCorrelation; readonly obligationType: string };
  /** The payment execution offered as satisfying it. */
  readonly executionId: string;
}

export type PaymentObligationMismatch = 'amount' | 'asset' | 'destination' | 'source' | 'reference' | 'purpose';

/** Closed; every domain condition a result. */
export type PaymentObligationDischargeResult =
  /** The settlement-backed report is now in CORE-04. What it is worth is CORE-04's decision. */
  | { readonly outcome: 'recorded'; readonly receiptId: string; readonly discharge: StoredObligationDischarge }
  /** The same receipt was already reported for this obligation by this source. Nothing new was written. */
  | { readonly outcome: 'already-recorded'; readonly receiptId: string }
  /** The registry does not know this obligation as a payment obligation. Nothing written. */
  | { readonly outcome: 'not-a-payment-obligation' }
  /** No canonical settlement of the execution exists (execution completed only, uncertain, not completed, not found). Nothing written. */
  | { readonly outcome: 'not-settled' }
  /** The settled payment is not the payment this obligation expects. Nothing written. */
  | { readonly outcome: 'mismatch'; readonly field: PaymentObligationMismatch }
  /** The registry, settlement or CORE-04 state could not be consulted, believed or read. Nothing written; asking again is safe. */
  | { readonly outcome: 'basis-unavailable' }
  /** The report could not be recorded (CORE-04 refused or failed). Nothing is claimed. */
  | { readonly outcome: 'discharge-unrecorded' };

function expectationOf(raw: unknown): PaymentObligationExpectation | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Partial<PaymentObligationExpectation>;
  const destination = value.destination;
  const source = value.source;
  if (!isWellFormedMonetaryAmount(value.amount)) return undefined;
  if (destination === undefined || !isPaymentDestinationKind(destination.kind) || !isPaymentReference(destination.reference)) return undefined;
  if (source !== undefined && !isPaymentReference(source.accountId)) return undefined;
  return {
    amount: { value: value.amount.value, unit: value.amount.unit },
    destination: { kind: destination.kind, reference: destination.reference },
    ...(source !== undefined ? { source: { accountId: source.accountId } } : {}),
  };
}

export interface PaymentObligationDischarger {
  dischargeObligation(request: PaymentObligationDischargeRequest): Promise<PaymentObligationDischargeResult>;
}

export function createPaymentObligationDischarger(options: PaymentObligationDischargerOptions): PaymentObligationDischarger {
  const { settlements, registry, recorder, discharges, sourceId, writer, now } = options;
  if (typeof now !== 'function') throw new TypeError('The payment obligation bridge needs an injected clock.');
  if (typeof registry !== 'function') throw new TypeError('The payment obligation bridge needs a trusted registry.');
  if (typeof recorder?.record !== 'function' || typeof discharges?.read !== 'function') throw new TypeError('The payment obligation bridge needs CORE-04’s recorder and discharge reader.');
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('The payment obligation bridge needs a configured CORE-04 discharge source id.');

  // Reports for one obligation are recorded strictly in observation-time order by CORE-04; one at a time here too.
  let tail: Promise<unknown> = Promise.resolve();

  async function dischargeOnce(request: PaymentObligationDischargeRequest): Promise<PaymentObligationDischargeResult> {
    const { organizationId, executionId } = request;
    const correlation = request.obligation?.correlation;
    const obligationType = request.obligation?.obligationType;
    if (correlation === undefined || typeof obligationType !== 'string' || !isObligationType(obligationType)) return { outcome: 'not-a-payment-obligation' };
    const scope: ObligationCorrelation = { requestId: correlation.requestId, action: correlation.action, resourceScope: correlation.resourceScope };

    // Only the registry's successful answer "none" is the negative fact. A registry that throws, rejects or answers outside the
    // contract was not consulted: an availability failure, never "not a payment obligation" — nothing is written, and the
    // caller may ask again.
    let answer: unknown;
    try {
      answer = await registry(Object.freeze({ organizationId, correlation: Object.freeze({ ...scope }), obligationType }));
    } catch {
      return { outcome: 'basis-unavailable' };
    }
    if (answer === undefined) return { outcome: 'not-a-payment-obligation' };
    const expected = expectationOf(answer);
    if (expected === undefined) return { outcome: 'basis-unavailable' };

    // The canonical settlement, verified and re-checked against P11 / P12. Local: no authority is asked here.
    const status = await settlements.readSettlement({ organizationId, executionId });
    if (status.outcome === 'basis-unavailable') return { outcome: 'basis-unavailable' };
    if (status.outcome !== 'status' || status.state !== 'settled' || status.settlement === undefined || status.receipt === undefined) return { outcome: 'not-settled' };
    const { settlement, receipt } = status;

    const paid = settlement.payment;
    if (paid.purpose === 'refund') return { outcome: 'mismatch', field: 'purpose' };
    if (paid.amount.unit !== expected.amount.unit) return { outcome: 'mismatch', field: 'asset' };
    if (paid.amount.value !== expected.amount.value) return { outcome: 'mismatch', field: 'amount' };
    if (paid.destination.kind !== expected.destination.kind || paid.destination.reference !== expected.destination.reference) return { outcome: 'mismatch', field: 'destination' };
    if (expected.source !== undefined && paid.source.accountId !== expected.source.accountId) return { outcome: 'mismatch', field: 'source' };
    if (paid.reference !== paymentObligationReference(scope, obligationType)) return { outcome: 'mismatch', field: 'reference' };

    let earlier: readonly StoredObligationDischarge[];
    try {
      earlier = await discharges.read(organizationId, scope);
    } catch {
      return { outcome: 'basis-unavailable' };
    }
    if (earlier.some((row) => row.obligationType === obligationType && row.sourceId === sourceId && row.outcome === 'discharged' && row.reference === receipt.receiptId)) {
      return { outcome: 'already-recorded', receiptId: receipt.receiptId };
    }
    try {
      const discharge = await recorder.record(writer, {
        correlation: scope,
        obligationType,
        sourceId,
        outcome: 'discharged',
        // When this source observed the settled payment: now. Not the settlement's own instant — CORE-04 orders reports
        // per obligation strictly by observation time, so a fixed earlier instant would let any later report (a payer's
        // self-report, say) block this independent one forever. Replays are idempotent by the receipt, never by time.
        observedAt: now(),
        reference: receipt.receiptId,
        subjectId: settlement.finality.authorityId,
      });
      return { outcome: 'recorded', receiptId: receipt.receiptId, discharge };
    } catch {
      return { outcome: 'discharge-unrecorded' };
    }
  }

  return Object.freeze({
    dischargeObligation(request: PaymentObligationDischargeRequest): Promise<PaymentObligationDischargeResult> {
      const result = tail.then(() => dischargeOnce(request));
      tail = result.catch(() => undefined);
      return result;
    },
  });
}
