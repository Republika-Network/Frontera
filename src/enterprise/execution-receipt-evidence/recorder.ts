import type { GenericHttpExchangeEvidence, GenericHttpResponseObserver } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { EXECUTION_CAPABILITY_LIMITS, type ExecutionCapability } from '../execution-capability/capability.js';
import { decodeExecutorReceiptTransport, executorReceiptDigest, parseExecutorReceipt, type ExecutorReceiptOutcome, type ExecutorReceiptVerifier } from '../executor-receipt/index.js';
import type { ExecutionReceiptAgreement, ExecutionReceiptEvidenceStore, ExecutionReceiptExchange, ExecutionReceiptHttpOutcome } from './evidence-store.js';

/**
 * G-02C1D — the Host's receipt evidence recorder: the response observer the
 * composition root gives one capability-gated Generic HTTP adapter.
 *
 * ```
 * adapter: one presented send, its result already fixed
 *   -> this recorder (once per exchange):
 *        1. issuance    the G-02B issuance ledger's row for this execution: issued, for this adapter's audience
 *        2. decode      exactly one frontera-execution-receipt value (none: missing; several: duplicated)
 *        3. verify      the G-02C1C verifier over operator-pinned executors: canonical form, pinned executor and key,
 *                       signature over the receipt domain, the executor's permitted scope
 *        4. correlate   issuer, capability, execution, audience, organization, trust domain and the exact action
 *                       binding of the issued capability; the claim inside the capability's validity window
 *        5. record      one observation; the receipt accepted as evidence, or preserved as a conflict (the store)
 * ```
 *
 * ## What it never does
 *
 * - **Change an outcome.** The adapter fixed its result before calling here;
 *   P11 records that result as before. Nothing here writes P11 or P12, and a
 *   receipt — however well signed — resolves nothing.
 * - **Trust a key it did not pin.** The verifier knows only the executors the
 *   operator configured; a key inside a receipt is never consulted.
 * - **Infer issuance from a signature.** A receipt is evidence only when it
 *   names exactly the capability this Host's issuance ledger issued for this
 *   execution, for this audience, over this binding.
 * - **Retry, re-present or ask again.** A missing receipt is recorded as
 *   missing — never as "nothing happened", never as "completed".
 * - **Log a receipt, a presentation or a key.** The observation row holds closed
 *   codes, digests and statuses only.
 */

export interface ExecutionReceiptEvidenceRecorderOptions {
  /** The capability-gated Generic HTTP adapter this recorder observes. */
  readonly adapterId: string;
  /** The audience that adapter's capabilities are issued for. */
  readonly audience: string;
  /** The Host's capability issuer, organization and trust domain. */
  readonly issuer: string;
  readonly organizationId: string;
  readonly trustDomain: string;
  /** The G-02C1C verifier over the operator-pinned executor registry. */
  readonly verifier: ExecutorReceiptVerifier;
}

/**
 * The one read the recorder makes of the G-02B issuance ledger, stated structurally: the ledger's own `read(executionId)`
 * satisfies it. Read only — nothing here can reserve, issue or mark anything.
 */
export interface ExecutionReceiptIssuanceView {
  read(executionId: string):
    | { readonly state: 'absent' }
    | { readonly state: string; readonly executionId: string; readonly capabilityId: string; readonly audience: string; readonly capability: ExecutionCapability };
}

/** What exists only once the composition has opened the issuance ledger and the evidence store. */
export interface ExecutionReceiptEvidenceRuntime {
  readonly issuance: ExecutionReceiptIssuanceView;
  readonly store: Pick<ExecutionReceiptEvidenceStore, 'record'>;
}

export interface ExecutionReceiptEvidenceRecorder {
  readonly adapterId: string;
  readonly audience: string;
  /** The hook the adapter calls. Records nothing until `bind` has run. */
  readonly observe: GenericHttpResponseObserver;
  /** Exactly once. */
  bind(runtime: ExecutionReceiptEvidenceRuntime): void;
  bound(): boolean;
}

export class ExecutionReceiptEvidenceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionReceiptEvidenceConfigurationError';
  }
}

/**
 * How the executor's statement relates to the Generic HTTP outcome. Only a
 * definite HTTP outcome can be compared; a contradiction is recorded as such,
 * never resolved in either direction.
 */
export function receiptAgreementOf(httpOutcome: ExecutionReceiptHttpOutcome, reported: ExecutorReceiptOutcome): ExecutionReceiptAgreement {
  if (httpOutcome === 'unconfirmed') return 'not-comparable';
  if (httpOutcome === 'completed') return reported === 'completed-observed' ? 'consistent' : 'contradicts';
  return reported === 'failed-observed' || reported === 'consumed-not-attempted' ? 'consistent' : 'contradicts';
}

export function createExecutionReceiptEvidenceRecorder(options: ExecutionReceiptEvidenceRecorderOptions): ExecutionReceiptEvidenceRecorder {
  const { adapterId, audience, issuer, organizationId, trustDomain, verifier } = options;
  for (const value of [adapterId, audience, issuer, organizationId, trustDomain]) {
    if (typeof value !== 'string' || value.length === 0) throw new ExecutionReceiptEvidenceConfigurationError('A receipt evidence recorder needs its adapter, audience, issuer, organization and trust domain.');
  }
  if (typeof verifier?.verify !== 'function') throw new ExecutionReceiptEvidenceConfigurationError('A receipt evidence recorder needs the executor receipt verifier.');

  let runtime: ExecutionReceiptEvidenceRuntime | undefined;

  /** The classified exchange: never throws, and quotes nothing of the response. */
  function classify(evidence: GenericHttpExchangeEvidence, bound: ExecutionReceiptEvidenceRuntime): ExecutionReceiptExchange {
    const executionId = evidence.action.correlation.executionId;
    const httpOutcome: ExecutionReceiptHttpOutcome = evidence.result.outcome;
    const base = { executionId, adapterId, transmission: evidence.transmission, httpStatus: evidence.status, httpOutcome };
    const without = (capabilityId: string | null, disposition: Exclude<ExecutionReceiptExchange['disposition'], null>, failure: string, receiptDigest: string | null = null): ExecutionReceiptExchange =>
      Object.freeze({ ...base, capabilityId, candidate: null, disposition, failure, receiptDigest, agreement: 'not-comparable' as const });

    // 1. This Host's issuance for this execution, for this adapter's audience — or none.
    let issued: { readonly capabilityId: string; readonly capability: ExecutionCapability } | undefined = undefined;
    try {
      const record = bound.issuance.read(executionId);
      if (record.state === 'issued' && 'capability' in record) {
        const ours = record.executionId === executionId && record.audience === audience && record.capability.audience === audience && record.capability.issuer === issuer;
        issued = ours ? { capabilityId: record.capabilityId, capability: record.capability } : undefined;
      }
    } catch {
      issued = undefined;
    }
    const capabilityId = issued?.capabilityId ?? null;

    // 2. Exactly one receipt value.
    const decoded = decodeExecutorReceiptTransport(evidence.receiptValues);
    if (!decoded.ok) {
      if (decoded.failure === 'RECEIPT_MISSING') return without(capabilityId, 'receipt-missing', decoded.failure);
      if (decoded.failure === 'RECEIPT_DUPLICATED') return without(capabilityId, 'receipt-duplicated', decoded.failure);
      return without(capabilityId, 'receipt-invalid', decoded.failure);
    }
    const presented = decoded.presented;
    const digest = executorReceiptDigest(presented.receipt);

    // 3. Who said it: a pinned executor, a pinned key, a valid signature, within the executor's pinned scope.
    const authenticated = verifier.verify(presented);
    const receipt = authenticated.receipt;
    if (receipt === null || authenticated.signature !== 'valid' || authenticated.executorTrust !== 'trusted') return without(capabilityId, 'receipt-invalid', authenticated.failure ?? 'VERIFIER_FAILURE', digest);
    if (authenticated.scope !== 'permitted') return without(capabilityId, 'receipt-invalid', 'SCOPE_NOT_PERMITTED', digest);

    // 4. What it is about: exactly the capability this Host issued for this execution.
    if (issued === undefined) return without(null, 'receipt-uncorrelated', 'ISSUANCE_NOT_FOUND', digest);
    const capability = issued.capability;
    const correlated = verifier.verify(presented, {
      expected: { issuer, capabilityId: issued.capabilityId, executionId, audience, organizationId, trustDomain, actionBinding: { format: capability.actionBinding.format, digest: capability.actionBinding.digest } },
    });
    if (correlated.identityMatch !== 'yes' || correlated.bindingMatch !== 'yes' || correlated.failure !== null) return without(capabilityId, 'receipt-uncorrelated', correlated.failure ?? 'IDENTITY_MISMATCH', digest);
    // The executor claimed while the capability was valid: not before it was issued (beyond the G-02A skew), never after expiry.
    const claimedAt = Date.parse(receipt.consumption.claimedAt);
    const inWindow = claimedAt >= Date.parse(capability.issuedAt) - EXECUTION_CAPABILITY_LIMITS.maximumClockSkewMs && claimedAt < Date.parse(capability.expiresAt);
    if (!inWindow) return without(capabilityId, 'receipt-uncorrelated', 'TEMPORALLY_INCONSISTENT', digest);

    // 5. A candidate: the store accepts it, or preserves it as a conflict with the chain it already holds.
    const reparsed = parseExecutorReceipt(presented.receipt);
    if (!reparsed.ok) return without(capabilityId, 'receipt-invalid', reparsed.failure, digest);
    return Object.freeze({
      ...base,
      capabilityId,
      candidate: Object.freeze({ receipt: reparsed.receipt, canonical: presented.receipt, signature: presented.signature as Readonly<Record<string, string>> }),
      disposition: null,
      failure: null,
      receiptDigest: digest,
      agreement: receiptAgreementOf(httpOutcome, reparsed.receipt.outcome),
    });
  }

  async function observe(evidence: GenericHttpExchangeEvidence): Promise<void> {
    const bound = runtime;
    if (bound === undefined) return;
    try {
      bound.store.record(classify(evidence, bound));
    } catch {
      // The evidence path never changes the result: a store that cannot record leaves the exchange unrecorded, which is
      // read as "no evidence" — never as "nothing happened".
    }
  }

  return Object.freeze({
    adapterId,
    audience,
    observe,
    bind(next: ExecutionReceiptEvidenceRuntime): void {
      if (runtime !== undefined) throw new ExecutionReceiptEvidenceConfigurationError('A receipt evidence recorder is bound exactly once.');
      if (typeof next?.issuance?.read !== 'function' || typeof next.store?.record !== 'function') throw new ExecutionReceiptEvidenceConfigurationError('A receipt evidence recorder needs the issuance ledger and the evidence store.');
      runtime = Object.freeze({ issuance: next.issuance, store: next.store });
    },
    bound: () => runtime !== undefined,
  });
}
