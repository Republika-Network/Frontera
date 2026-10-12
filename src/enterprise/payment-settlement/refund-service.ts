import type { MonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  compilePaymentIntent,
  paymentRefundRefusal,
  validatePaymentIntent,
  type PaymentDestination,
  type PaymentEnvelopeOptions,
  type PaymentGovernanceBinding,
  type PaymentSourceRef,
} from '../../features/payment-runtime/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import { isOpaqueExecutionIdentifier } from './validation.js';
import type { ExecutionOutcomeReader } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionReader } from '../execution-resolution-store/resolution-store.js';
import type { GovernanceRecord, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernedActionResult } from '../governed-action/contracts.js';
import { deriveGovernedActionExecutionId, deriveGovernedActionRequestId } from '../governed-action/identifiers.js';
import { boundScopeOf } from '../governed-action/kernel-request.js';
import type { PaymentReceipt, PaymentSettlementRecord } from './contracts.js';
import {
  paymentRefundGovernedKey,
  paymentRefundOperationId,
  type PaymentRefundBalance,
  type PaymentRefundLedger,
  type PaymentRefundReleaseBasis,
  type PaymentRefundReservation,
} from './refund-ledger.js';
import type { PaymentSettlementService } from './service.js';

/**
 * PAY-05 — refunds: a **new governed payment**, explicitly linked to a
 * settled original, within that original's refundable balance.
 *
 * ```
 * requestRefund(identity, { originalExecutionId, refundKey, amount })
 *   → the ORIGINAL's canonical settlement (verified; never a caller's reference)   none → original-not-settled
 *   → refund money rules: same asset, positive, exact P9                              (the ledger decides the balance)
 *   → trusted counterparty mapping: who refunds, to whom                               none → counterparty-unresolved
 *   → refund accounting: reserve (CORE-07-anchored, atomic per original)               over → refused
 *   → PaymentIntent { purpose: 'refund', key + reference DERIVED from the refund operation }
 *   → the EXISTING governed path, as the requester: authority, policy, P10, approval, grant, P7, claim, rail, P11
 * reconcileRefund(refundOperationId)
 *   → the refund's canonical outcome: denied · confirmed-not-completed · withheld · P12 not completed → release
 *                                     anything else (completed, unconfirmed, pending, unknown)        → stays counted
 * ```
 *
 * ## What it is not
 *
 * - **Not authority.** A settled original authorizes nothing: the refund's
 *   requester needs authority over the refund like over any payment, decided
 *   by the unchanged governed path. No settlement record can mint a grant.
 * - **Not a reversal.** The original's settlement, receipt, P11 record and P7
 *   capacity are never touched. The refund has its own of each.
 * - **Not a retry.** The refund's governed key is derived from the refund
 *   operation — never the original's key or business operation — so it can
 *   never replay or repeat the original payment, and a refund operation is
 *   governed under exactly one request identity, ever.
 * - **Not FX.** Same asset only.
 *
 * Refund direction is **not** assumed to be address reversal: who pays the
 * refund (a governed source account) and who receives it (the original payer's
 * refund beneficiary) is a trusted mapping the deployment composes. When it
 * cannot name both, the refund is refused.
 */

export interface PaymentRefundCounterparty {
  readonly source: PaymentSourceRef;
  readonly destination: PaymentDestination;
}

/** Trusted mapping from a settled original to its refund's source and beneficiary. `undefined` refuses the refund. */
export type PaymentRefundCounterpartyResolver = (query: { readonly organizationId: string; readonly original: PaymentSettlementRecord }) => PaymentRefundCounterparty | undefined;

export interface PaymentRefundServiceOptions {
  /** The one organization this service serves. */
  readonly organizationId: string;
  readonly settlements: Pick<PaymentSettlementService, 'readSettlement'>;
  readonly ledger: PaymentRefundLedger;
  readonly counterparties: PaymentRefundCounterpartyResolver;
  /** The payment binding refunds are governed under. */
  readonly binding: PaymentGovernanceBinding;
  readonly assets: MonetaryAssetRegistry;
  /** The existing governed-action entry. The refund is governed here, as the requester, exactly like any payment. */
  readonly orchestrator: { govern(identity: BoundCustomerIdentity, intent: unknown): Promise<GovernedActionResult> };
  /** Canonical reads for `reconcileRefund`: the refund's committed decision, P11 and P12. */
  readonly governance: { getByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<GovernanceRecord | null> };
  readonly outcomes: ExecutionOutcomeReader;
  readonly resolutions: ExecutionResolutionReader;
  /**
   * Volatile refund accounting loses reservations on restart, which would
   * recreate refundable balance. It is refused unless the composer states, on
   * purpose, that this is a test or development composition.
   */
  readonly allowVolatileLedger?: true;
}

export interface PaymentRefundRequest {
  readonly originalExecutionId: string;
  /** The requester's own name for this refund. With the principal and the original it derives the refund operation. */
  readonly refundKey: string;
  readonly amount: { readonly value: string; readonly unit: string };
  readonly rail?: string;
  readonly correlationId?: string;
  /** Envelope evidence the deployment's Kernel needs (asserted context), passed through unchanged. */
  readonly envelope?: PaymentEnvelopeOptions;
}

export type PaymentRefundRequestResult =
  /** Reserved (now or before) and handed to the governed path; the governed result is the refund payment's. */
  | { readonly outcome: 'governed'; readonly refundOperationId: string; readonly reservation: 'reserved' | 'existing'; readonly balance: PaymentRefundBalance; readonly result: GovernedActionResult }
  | { readonly outcome: 'identity-refused' }
  | { readonly outcome: 'original-not-settled' }
  /** The original is itself a refund; a refund of a refund is not offered. */
  | { readonly outcome: 'original-is-refund' }
  | { readonly outcome: 'counterparty-unresolved' }
  | { readonly outcome: 'refused'; readonly refusal: string; readonly balance?: PaymentRefundBalance }
  /** The same refund key names a different refund. The first stands; nothing governed. */
  | { readonly outcome: 'conflict' }
  /** This refund operation was released (its payment provably moved nothing). It is closed; use a new refund key. */
  | { readonly outcome: 'closed'; readonly refundOperationId: string }
  /** The refund accounting could not be read, written or proven fresh. Nothing reserved, nothing governed. */
  | { readonly outcome: 'accounting-unavailable' };

export type PaymentRefundReconciliation =
  | { readonly outcome: 'released'; readonly basis: PaymentRefundReleaseBasis; readonly reservation: PaymentRefundReservation }
  | { readonly outcome: 'already-released'; readonly reservation: PaymentRefundReservation }
  /** The refund payment completed: its reservation stays counted (its money left). Its own settlement is verified like any payment. */
  | { readonly outcome: 'refund-completed'; readonly refundExecutionId: string }
  /** Not provably not-completed: decision pending, approval outstanding, unconfirmed, unresolved. The reservation stays counted. */
  | { readonly outcome: 'refund-pending' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'basis-unavailable' };

export interface PaymentRefundService {
  requestRefund(identity: BoundCustomerIdentity, request: PaymentRefundRequest): Promise<PaymentRefundRequestResult>;
  reconcileRefund(refundOperationId: string): Promise<PaymentRefundReconciliation>;
  /** The original's refundable balance and every refund against it. Local; no network. */
  refundBalance(originalExecutionId: string): Promise<{ readonly original: PaymentReceipt; readonly balance: PaymentRefundBalance } | undefined>;
}

export function createPaymentRefundService(options: PaymentRefundServiceOptions): PaymentRefundService {
  const { organizationId, settlements, ledger, counterparties, binding, assets, orchestrator, governance, outcomes, resolutions } = options;
  if (ledger?.providerKind === 'memory' && options.allowVolatileLedger !== true) {
    throw new TypeError('A volatile refund accounting loses reservations on restart and would recreate refundable balance; compose the durable, CORE-07-anchored one.');
  }
  if (typeof counterparties !== 'function') throw new TypeError('The refund service needs a trusted counterparty mapping.');
  if (typeof orchestrator?.govern !== 'function') throw new TypeError('The refund service governs refunds through the existing governed-action orchestrator.');

  /** The original's canonical settlement and its receipt — verified, re-checked against P11 / P12, local. */
  async function settledOriginal(executionId: unknown): Promise<{ readonly settlement: PaymentSettlementRecord; readonly receipt: PaymentReceipt } | undefined> {
    if (!isOpaqueExecutionIdentifier(executionId)) return undefined;
    const status = await settlements.readSettlement({ organizationId, executionId });
    return status.outcome === 'status' && status.state === 'settled' && status.settlement !== undefined && status.receipt !== undefined ? { settlement: status.settlement, receipt: status.receipt } : undefined;
  }

  async function requestRefund(identity: BoundCustomerIdentity, request: PaymentRefundRequest): Promise<PaymentRefundRequestResult> {
    const scope = boundScopeOf(identity, organizationId);
    if (scope === undefined) return { outcome: 'identity-refused' };
    const settled = await settledOriginal(request?.originalExecutionId);
    if (settled === undefined) return { outcome: 'original-not-settled' };
    const original = settled.settlement;
    if (original.payment.purpose === 'refund') return { outcome: 'original-is-refund' };
    const refundKey = request.refundKey;
    if (!isOpaqueExecutionIdentifier(refundKey)) return { outcome: 'refused', refusal: 'PAYMENT_REFUND_KEY_INVALID' };

    let counterparty: PaymentRefundCounterparty | undefined;
    try {
      counterparty = counterparties(Object.freeze({ organizationId, original }));
    } catch {
      counterparty = undefined;
    }
    if (counterparty === undefined) return { outcome: 'counterparty-unresolved' };

    const refundOperationId = paymentRefundOperationId({ organizationId, principalId: scope.principalId, originalSettlementId: original.settlementId, refundKey });
    const governedKey = paymentRefundGovernedKey(refundOperationId);
    const validation = validatePaymentIntent(
      {
        source: counterparty.source,
        destination: counterparty.destination,
        amount: request.amount,
        purpose: 'refund',
        reference: governedKey,
        ...(request.rail !== undefined ? { rail: request.rail } : {}),
        idempotencyKey: governedKey,
        ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      },
      { assets },
    );
    if (!validation.valid) return { outcome: 'refused', refusal: validation.violations[0]?.code ?? 'PAYMENT_INTENT_INVALID' };
    const intent = validation.intent;
    // The money rules the service can state before touching the accounting: same asset, strictly positive, exact.
    const moneyRefusal = paymentRefundRefusal(original.payment.amount, '0', intent.amount);
    if (moneyRefusal !== undefined) return { outcome: 'refused', refusal: moneyRefusal };
    const refundRequestId = deriveGovernedActionRequestId({ organizationId, principalId: scope.principalId, idempotencyKey: intent.idempotencyKey });

    let reserved;
    try {
      reserved = await ledger.reserve({
        organizationId,
        principalId: scope.principalId,
        refundKey,
        originalSettlementId: original.settlementId,
        originalExecutionId: original.executionId,
        originalReceiptId: settled.receipt.receiptId,
        originalAmount: original.payment.amount,
        amount: intent.amount,
        refundRequestId,
      });
    } catch {
      return { outcome: 'accounting-unavailable' };
    }
    if (reserved.outcome === 'conflict') return { outcome: 'conflict' };
    if (reserved.outcome === 'closed') return { outcome: 'closed', refundOperationId };
    if (reserved.outcome === 'refused') return { outcome: 'refused', refusal: reserved.refusal, ...(reserved.balance !== undefined ? { balance: reserved.balance } : {}) };

    // Durable and witnessed before anything is governed. A crash from here on leaves the reservation counted; calling again with
    // the same refund key finds it and governs the same request identity — the governed path replays or executes it once.
    const result = await orchestrator.govern(identity, compilePaymentIntent(intent, binding, request.envelope));
    return { outcome: 'governed', refundOperationId, reservation: reserved.outcome, balance: reserved.balance, result };
  }

  /** The refund's canonical outcome, from its committed decision, P11 and P12 only. */
  async function releaseBasis(refundRequestId: string): Promise<{ readonly kind: 'release'; readonly basis: PaymentRefundReleaseBasis; readonly reference: string } | { readonly kind: 'completed'; readonly executionId: string } | { readonly kind: 'pending' } | { readonly kind: 'unavailable' }> {
    let record: GovernanceRecord | null;
    try {
      record = await governance.getByRequestId({ system: false, organizationId }, refundRequestId);
    } catch {
      return { kind: 'unavailable' };
    }
    // Never decided (a crash before governance, or a refusal before the Kernel): it could still be governed. Stays counted.
    if (record === null) return { kind: 'pending' };
    const evaluation = record.evaluation;
    if (evaluation.status === 'denied') return { kind: 'release', basis: 'decision-denied', reference: evaluation.evaluationId };
    if (evaluation.status !== 'allowed') return { kind: 'pending' };
    const executionId = deriveGovernedActionExecutionId({ requestId: refundRequestId, decisionId: evaluation.decisionId });
    let outcome;
    try {
      outcome = await outcomes.read({ organizationId }, executionId);
    } catch {
      return { kind: 'unavailable' };
    }
    if (outcome === undefined) return { kind: 'pending' };
    const observation = outcome.terminal?.observation;
    if (observation?.kind === 'withheld') return { kind: 'release', basis: 'execution-withheld', reference: outcome.terminal!.observationDigest };
    if (observation?.kind === 'provider' && observation.certainty === 'confirmed-not-completed') return { kind: 'release', basis: 'provider-confirmed-not-completed', reference: outcome.terminal!.observationDigest };
    if (observation?.kind === 'provider' && observation.certainty === 'confirmed-completed') return { kind: 'completed', executionId };
    let state;
    try {
      state = await resolutions.read({ organizationId }, executionId);
    } catch {
      return { kind: 'unavailable' };
    }
    const resolution = state?.resolution;
    if (resolution === undefined || resolution.attemptDigest !== outcome.attempt.attemptDigest) return { kind: 'pending' };
    if (resolution.certainty === 'confirmed-not-completed') return { kind: 'release', basis: 'resolution-confirmed-not-completed', reference: resolution.resolutionDigest };
    return { kind: 'completed', executionId };
  }

  return Object.freeze({
    requestRefund,

    async reconcileRefund(refundOperationId: string): Promise<PaymentRefundReconciliation> {
      let reservation: PaymentRefundReservation | undefined;
      try {
        reservation = await ledger.readOperation(organizationId, refundOperationId);
      } catch {
        return { outcome: 'basis-unavailable' };
      }
      if (reservation === undefined) return { outcome: 'not-found' };
      if (reservation.release !== undefined) return { outcome: 'already-released', reservation };
      const basis = await releaseBasis(reservation.reserve.refundRequestId);
      if (basis.kind === 'unavailable') return { outcome: 'basis-unavailable' };
      if (basis.kind === 'pending') return { outcome: 'refund-pending' };
      if (basis.kind === 'completed') return { outcome: 'refund-completed', refundExecutionId: basis.executionId };
      try {
        const released = await ledger.release({ organizationId, refundOperationId, basis: basis.basis, basisReference: basis.reference });
        if (released.outcome === 'not-found') return { outcome: 'not-found' };
        return released.outcome === 'released' ? { outcome: 'released', basis: basis.basis, reservation: released.reservation } : { outcome: 'already-released', reservation: released.reservation };
      } catch {
        return { outcome: 'basis-unavailable' };
      }
    },

    async refundBalance(originalExecutionId: string) {
      const status = await settlements.readSettlement({ organizationId, executionId: originalExecutionId });
      if (status.outcome !== 'status' || status.state !== 'settled' || status.settlement === undefined || status.receipt === undefined) return undefined;
      const balance = await ledger.readBalance(organizationId, status.settlement.settlementId, status.settlement.payment.amount);
      return { original: status.receipt, balance };
    },
  });
}
