import { EXECUTION_FAILURE_REASONS, isRecordableExecutionAdapterId, type ExecutionAdapter, type ExecutionAdapterResult, type ValidatedExecutionAction } from '../../execution-runtime/index.js';
import { isPaymentEnvelopeIdentifier, isPaymentRailId } from '../domain/payment-grammar.js';
import { PaymentConfigurationError, type PaymentGovernanceBinding } from '../domain/payment-governance.js';
import { preparePaymentExecution } from '../domain/payment-execution.js';
import { PAYMENT_RAIL_DETAILS, executionResultOfPaymentRail, type PaymentRail, type PaymentRailResult } from '../domain/payment-rail.js';
import type { PaymentExecutionRequest } from '../domain/payment-execution.js';

export interface PaymentRailExecutionAdapterOptions {
  readonly rail: PaymentRail;
  readonly binding: PaymentGovernanceBinding;
}

/**
 * Composes a payment rail as an ordinary `ExecutionAdapter` (PAY-01).
 *
 * This is the whole payment execution boundary, and it adds no path: the
 * result is a provider adapter like any other, handed by the host to
 * `authorityControlledExecution.executionAdapter` or registered as a child of
 * `executionAdapterRouting` — where trusted server-side routing (the existing
 * `selectAdapter`) is the rail selection boundary. It is invoked only by the
 * execution runtime's gate, after a usable grant exercise, and it invokes
 * nothing but the one rail it was built with.
 *
 * Per execution, in order:
 *
 * 1. **prepare** — `preparePaymentExecution` derives the normalized
 *    `PaymentExecutionRequest` from the validated action alone. Not a payment
 *    under this binding → `failed: ADAPTER_ERROR`, and the rail is **not**
 *    invoked: nothing was sent, so the definitive answer is honest.
 * 2. **rail preference** — the granted payment prefers a different rail →
 *    `failed: ADAPTER_ERROR`, rail **not** invoked.
 * 3. **execute** — the rail is invoked exactly once. Its answer is mapped by
 *    `executionResultOfPaymentRail`; a throw or an unreadable answer is
 *    `unconfirmed`, because the rail *was* invoked (see that function).
 *
 * The rail's identity and its `execute` are snapshotted at construction, so a
 * rail object mutated later cannot change which code runs or what is recorded.
 */
export function createPaymentRailExecutionAdapter(options: PaymentRailExecutionAdapterOptions): ExecutionAdapter {
  const rail: unknown = options?.rail;
  if (rail === null || typeof rail !== 'object') throw new PaymentConfigurationError('A payment rail is required.');
  const railId: unknown = (rail as { readonly railId?: unknown }).railId;
  const execute: unknown = (rail as { readonly execute?: unknown }).execute;
  if (!isPaymentRailId(railId) || !isRecordableExecutionAdapterId(railId)) throw new PaymentConfigurationError('A payment rail id must be a semantic identifier.');
  if (typeof execute !== 'function') throw new PaymentConfigurationError(`Payment rail '${railId}' has no execute function.`);
  // Read once and validated with the binding factory's own grammar, so a
  // mis-wired binding fails at composition — never after a decision was
  // committed and a grant issued for a payment no execution could prepare.
  const binding: unknown = options.binding;
  const action: unknown = binding !== null && typeof binding === 'object' ? (binding as { readonly action?: unknown }).action : undefined;
  if (!isPaymentEnvelopeIdentifier(action)) throw new PaymentConfigurationError('A payment governance binding with a canonical action is required.');
  const boundAction: PaymentGovernanceBinding = Object.freeze({ action });
  const invoke = (request: PaymentExecutionRequest): Promise<PaymentRailResult> => (execute as PaymentRail['execute']).call(rail, request);

  return Object.freeze({
    adapterId: railId,
    async execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
      const preparation = preparePaymentExecution(action, boundAction);
      if (!preparation.prepared) {
        return Object.freeze({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: PAYMENT_RAIL_DETAILS.PAYMENT_EXECUTION_NOT_PREPARED });
      }
      if (preparation.request.rail !== undefined && preparation.request.rail !== railId) {
        return Object.freeze({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_NOT_PREFERRED });
      }
      try {
        return executionResultOfPaymentRail(await invoke(preparation.request));
      } catch {
        return Object.freeze({ outcome: 'unconfirmed', detail: PAYMENT_RAIL_DETAILS.PAYMENT_RAIL_RESULT_UNREADABLE });
      }
    },
  });
}
