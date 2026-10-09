import { EXECUTION_FAILURE_REASON_VALUES, isRecordableProviderRef, type ExecutionAdapterResult, type ExecutionFailureReason } from '../../execution-runtime/index.js';
import { isGovernedParameterToken } from '../../governed-parameter-runtime/index.js';
import type { PaymentExecutionRequest } from './payment-execution.js';

/**
 * The payment rail contract (PAY-01): the one thing a future rail implements.
 *
 * A rail is the provider-specific translation **below** the execution port.
 * It is composed by the host as a trusted in-process component and is reached
 * only through `createPaymentRailExecutionAdapter`, which is an ordinary
 * `ExecutionAdapter` — so it sits behind the same gate, the same trusted
 * routing, the same emergency interlock and the same P7 reservation as every
 * other provider, and there is no other way to call it.
 *
 * ## What a rail may not do
 *
 * Decide anything. Whether the amount is allowed, whether approval is
 * required, whether the destination is trusted, whether authority exists,
 * whether an emergency stop applies — every one of those was settled before a
 * `PaymentExecutionRequest` could exist, and the request carries nothing a
 * rail could re-decide them *with*. A rail translates one governed instruction
 * into one provider effect and reports what happened.
 *
 * ## No retry
 *
 * `execute` is invoked at most once per execution identity by the governed
 * path. A rail must not resubmit on its own initiative; an effect whose result
 * is unknown is reported `unconfirmed`, and P12 resolves it.
 */
export interface PaymentRail {
  /** The rail's identity, recorded as the adapter that performed the effect. A semantic identifier. */
  readonly railId: string;
  execute(request: PaymentExecutionRequest): Promise<PaymentRailResult>;
}

/**
 * What a rail reports — three outcomes, because a payment has three.
 *
 * - `completed` — the provider confirmed the payment instruction completed.
 *   **Not** a claim of final settlement: it is P11's `confirmed-completed`,
 *   no more.
 * - `not-completed` — the provider provably did not perform it. `reason` is
 *   the execution runtime's existing closed vocabulary; payment specifics
 *   (insufficient funds, a destination the provider refused) are the rail's
 *   bounded `detail`, not new core codes.
 * - `unconfirmed` — the provider was, or may have been, contacted and nobody
 *   can say whether funds moved. Never reported as `not-completed`: a caller
 *   who believed that would pay twice.
 *
 * `externalReference` is the provider's own opaque handle — a payment id, a
 * job id — when it supplied one. It is a correlation handle and never proof;
 * nothing assumes it is any particular kind of identifier.
 */
export type PaymentRailResult =
  | { readonly status: 'completed'; readonly externalReference?: string; readonly detail?: string }
  | { readonly status: 'not-completed'; readonly reason: ExecutionFailureReason; readonly externalReference?: string; readonly detail?: string }
  | { readonly status: 'unconfirmed'; readonly externalReference?: string; readonly detail?: string };

/** Static details the bridge itself reports. Bounded tokens; never a provider body. */
export const PAYMENT_RAIL_DETAILS = {
  /** The rail threw, or answered with something that is not a `PaymentRailResult`. It *was* invoked, so whether funds moved is unknown. */
  PAYMENT_RAIL_RESULT_UNREADABLE: 'payment-rail-result-unreadable',
  /** The validated action was not a payment this rail's binding can prepare. The rail was not invoked. */
  PAYMENT_EXECUTION_NOT_PREPARED: 'payment-execution-not-prepared',
  /** The granted payment prefers another rail. The rail was not invoked. */
  PAYMENT_RAIL_NOT_PREFERRED: 'payment-rail-not-preferred',
} as const;

/** A rail-chosen detail is carried only when it is a bounded token: a code such as `insufficient-funds`, never prose, a body or a secret. Anything else is dropped. */
function detailOf(value: unknown): { readonly detail?: string } {
  return isGovernedParameterToken(value) && isRecordableProviderRef(value) ? { detail: value } : {};
}

/** A provider handle is carried only when the execution runtime's one rule would record it. Anything else is dropped, never repaired. */
function referenceOf(value: unknown): { readonly providerRef?: string } {
  return isRecordableProviderRef(value) ? { providerRef: value } : {};
}

/**
 * A rail's returned value, mapped onto the execution port's own result —
 * total, and reading each field **exactly once**, because the value is
 * rail-controlled and observing it may run rail code (a getter, a Proxy).
 *
 * ```
 * PaymentRailResult   ExecutionAdapterResult   ExecutionOutcome         P11 certainty
 * completed        →  completed             →  executed              →  confirmed-completed
 * not-completed    →  failed(reason)        →  execution-failed      →  confirmed-not-completed
 * unconfirmed      →  unconfirmed           →  execution-unconfirmed →  unconfirmed (P12)
 * anything else    →  unconfirmed           →  execution-unconfirmed →  unconfirmed (P12)
 * ```
 *
 * The last row is the payment-specific choice, and it is deliberately
 * conservative: the rail **was** invoked, so a result that cannot be read is
 * not evidence that nothing was sent. Reporting it as a failure would release
 * P7 capacity and invite a retry of a payment that may already have moved;
 * reporting it unconfirmed holds the capacity and hands it to the existing
 * P12 resolution flow. A rail that knows it sent nothing says `not-completed`.
 *
 * May throw — reading the value is running the rail's code — so the caller
 * runs it inside the same `try` that catches `execute`.
 */
export function executionResultOfPaymentRail(value: unknown): ExecutionAdapterResult {
  const unreadable: ExecutionAdapterResult = Object.freeze({ outcome: 'unconfirmed', detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_RESULT_UNREADABLE });
  if (typeof value !== 'object' || value === null) return unreadable;
  const source = value as Record<string, unknown>;
  const status = source['status'];
  const reference = referenceOf(source['externalReference']);
  const detail = detailOf(source['detail']);
  if (status === 'completed') return Object.freeze({ outcome: 'completed', ...reference });
  if (status === 'unconfirmed') return Object.freeze({ outcome: 'unconfirmed', ...reference, ...detail });
  if (status === 'not-completed') {
    const reason = source['reason'];
    if (!EXECUTION_FAILURE_REASON_VALUES.includes(reason as ExecutionFailureReason)) return Object.freeze({ ...unreadable, ...reference });
    return Object.freeze({ outcome: 'failed', reason: reason as ExecutionFailureReason, ...reference, ...detail });
  }
  return Object.freeze({ ...unreadable, ...reference });
}
