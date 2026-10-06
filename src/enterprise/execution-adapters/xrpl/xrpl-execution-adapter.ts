import { EXECUTION_FAILURE_REASONS, isRecordableProviderRef, type ExecutionAdapter, type ExecutionAdapterResult, type ValidatedExecutionAction } from '../../../features/execution-runtime/index.js';
import { XrplConfigurationError, type XrplExecutionAdapterOptions, type XrplPaymentSubmission, type XrplPaymentTransport } from './contracts.js';
import { snapshotXrplOptions, type XrplPlan } from './configuration.js';
import { translateXrplPayment, type XrplTranslationRefusal } from './payment-translation.js';
import { xrplIssuedValuesEqual } from './xrpl-codec.js';

/**
 * The XRPL Execution Adapter (ANDREW-P0-06) — a deterministic translator from
 * one `ValidatedExecutionAction` plus trusted configuration to **at most one**
 * XRPL Payment submission through an injected transport.
 *
 * ```
 * ExecutionAdapterRegistry (trusted routing, adapter-scoped emergency check)
 *   -> execute(action)
 *   -> translate   action + plan -> canonical Payment instruction, or ADAPTER_ERROR (no I/O)
 *   -> submit      transport.submitPayment(...) exactly once; no retry, no loop
 *   -> classify    observation -> completed / failed / unconfirmed
 * ```
 *
 * It is not an authorization layer. It holds no Kernel, policy, grant store,
 * destination registry, approval store or trusted-context reader, and it decides
 * nothing: it is reached only through the grant-exercise gate, after the
 * registry selected it. It holds no key, seed or endpoint either — those belong
 * to the transport a later task supplies.
 *
 * ## Failure semantics never turn uncertainty into a definite answer
 *
 * | Observation | Result |
 * |---|---|
 * | the action cannot be translated (namespace, address, asset, amount) | `failed` / `ADAPTER_ERROR`, transport not called |
 * | `not-submitted` — proven not to have reached the network | `failed` / `PROVIDER_UNAVAILABLE` |
 * | `rejected` — definitively refused, cannot apply | `failed` / `PROVIDER_REJECTED` |
 * | `validated` — applied in a validated ledger | `completed` |
 * | `unconfirmed`, a transport throw, or an unreadable observation | `unconfirmed` |
 *
 * A transaction hash becomes the result's `providerRef` only when the
 * transport supplied one, it is 64 hexadecimal characters, and the outcome had
 * an answer from the network; the adapter never computes or invents one. Every
 * `detail` is a fixed phrase: no transport error text, no address, no amount.
 */

const DETAIL: Readonly<Record<XrplTranslationRefusal | 'notSubmitted' | 'rejected' | 'unconfirmed', string>> = Object.freeze({
  'destination-missing': 'XRPL payment has no destination.',
  'destination-malformed': 'XRPL payment destination is not a canonical destination key.',
  'namespace-unsupported': 'XRPL payment destination is not in the namespace this adapter serves.',
  'address-invalid': 'XRPL payment destination is not a valid XRPL classic address.',
  'amount-missing': 'XRPL payment has no amount.',
  'asset-unmapped': 'XRPL payment asset has no configured XRPL representation.',
  'amount-unrepresentable': 'XRPL payment amount cannot be stated exactly on XRPL.',
  notSubmitted: 'XRPL payment was not submitted.',
  rejected: 'XRPL network rejected the payment.',
  unconfirmed: 'XRPL payment outcome could not be confirmed.',
});

const TRANSACTION_HASH = /^[0-9A-Fa-f]{64}$/;

/** The transport's hash, verbatim, when it is one — otherwise nothing. Never derived, never reformatted. */
function transactionHashFrom(value: unknown): { readonly providerRef?: string } {
  return typeof value === 'string' && TRANSACTION_HASH.test(value) && isRecordableProviderRef(value) ? { providerRef: value } : {};
}

/**
 * The observation is transport-controlled code as much as data: each field is
 * read exactly once, inside the caller's try. Whatever cannot be read as one of
 * the four kinds is `unconfirmed`, because the transport was called and may
 * have submitted.
 */
/**
 * ANDREW-P0-08 defence in depth: a transport that reports what the ledger
 * delivered must report exactly the instruction's amount. A mismatch may
 * already have moved value, so it is never a completion and never a
 * retryable failure — it is `unconfirmed`, for reconciliation.
 */
function deliveredMatches(delivered: unknown, instructed: XrplPaymentSubmission['instruction']['Amount']): boolean {
  if (delivered === undefined) return true;
  if (typeof instructed === 'string') return typeof delivered === 'string' && delivered === instructed;
  if (typeof delivered !== 'object' || delivered === null) return false;
  const amount = delivered as Record<string, unknown>;
  return amount['currency'] === instructed.currency && amount['issuer'] === instructed.issuer && xrplIssuedValuesEqual(amount['value'], instructed.value);
}

function classify(observation: unknown, instruction: XrplPaymentSubmission['instruction']): ExecutionAdapterResult {
  if (typeof observation !== 'object' || observation === null) return { outcome: 'unconfirmed', detail: DETAIL.unconfirmed };
  const source = observation as Record<string, unknown>;
  const kind = source['kind'];
  if (kind === 'not-submitted') return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.notSubmitted };
  const reference = transactionHashFrom(source['transactionHash']);
  if (kind === 'validated') return deliveredMatches(source['deliveredAmount'], instruction.Amount) ? { outcome: 'completed', ...reference } : { outcome: 'unconfirmed', ...reference, detail: DETAIL.unconfirmed };
  if (kind === 'rejected') return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference, detail: DETAIL.rejected };
  return { outcome: 'unconfirmed', ...reference, detail: DETAIL.unconfirmed };
}

function createXrplExecutionAdapterCore(plan: XrplPlan, transport: XrplPaymentTransport, submitPayment: XrplPaymentTransport['submitPayment']): ExecutionAdapter {
  async function execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
    // 1. The complete instruction, before any I/O. Untranslatable means nothing is sent.
    let submission: XrplPaymentSubmission;
    try {
      const translation = translateXrplPayment(plan, action);
      if (!translation.ok) return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL[translation.refusal] };
      const { executionId, requestId, decisionId } = action.correlation;
      submission = Object.freeze({ instruction: translation.instruction, executionId, requestId, decisionId, notAfter: action.notAfter, ...(plan.network !== undefined ? { network: plan.network } : {}) });
    } catch {
      return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.unconfirmed };
    }

    // 2. The one submission. There is no second call anywhere in this
    //    function, and no loop around this one. A transport that throws may
    //    have submitted, so a throw is unconfirmed, never a failure.
    try {
      return classify(await submitPayment.call(transport, submission), submission.instruction);
    } catch {
      return { outcome: 'unconfirmed', detail: DETAIL.unconfirmed };
    }
  }

  return Object.freeze({ adapterId: plan.adapterId, execute });
}

/**
 * Snapshot the trusted options, bind the injected transport. Throws
 * `XrplConfigurationError` on a malformed option — an invalid issuer, an
 * unmapped or mismatched currency, a missing transport — before any traffic.
 */
export function createXrplExecutionAdapter(options: XrplExecutionAdapterOptions, transport: XrplPaymentTransport): ExecutionAdapter {
  const plan = snapshotXrplOptions(options);
  let submitPayment: unknown;
  try {
    submitPayment = typeof transport === 'object' && transport !== null ? transport.submitPayment : undefined;
  } catch {
    submitPayment = undefined;
  }
  if (typeof submitPayment !== 'function') throw new XrplConfigurationError('XRPL_TRANSPORT_INVALID', 'The XRPL adapter needs a transport with a submitPayment function.');
  return createXrplExecutionAdapterCore(plan, transport, submitPayment as XrplPaymentTransport['submitPayment']);
}
