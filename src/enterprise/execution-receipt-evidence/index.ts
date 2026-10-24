import { ExecutorReceiptVerifierConfigurationError, createExecutorReceiptVerifier, type ExecutorReceiptVerifier, type TrustedExecutor } from '../executor-receipt/index.js';
import { ExecutionReceiptEvidenceConfigurationError } from './recorder.js';

/**
 * G-02C1D — the Host's receipt evidence: the recorder a capability-gated
 * Generic HTTP adapter reports each presented exchange to, the operator-pinned
 * executor registry it verifies with, and the additive evidence store (D8).
 *
 * Internal. Imported by the composition root (and the Host configuration, for
 * the registry's validation) alone; not exported from the enterprise entry
 * point, mounted on a route or offered as an option. It holds no executor key
 * and no signing capability, and it writes neither P11 nor P12.
 */
export {
  EXECUTION_RECEIPT_AGREEMENTS,
  EXECUTION_RECEIPT_CONFLICT_REASONS,
  EXECUTION_RECEIPT_DISPOSITIONS,
  EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION,
  EXECUTION_RECEIPT_HTTP_OUTCOMES,
  EXECUTION_RECEIPT_TRANSMISSIONS,
  openExecutionReceiptEvidenceStore,
} from './evidence-store.js';
export type {
  ExecutionReceiptAgreement,
  ExecutionReceiptCandidate,
  ExecutionReceiptConflictReason,
  ExecutionReceiptDisposition,
  ExecutionReceiptEvidenceStore,
  ExecutionReceiptEvidenceStoreOptions,
  ExecutionReceiptExchange,
  ExecutionReceiptExchangeRecord,
  ExecutionReceiptHttpOutcome,
  ExecutionReceiptTransmission,
  StoredExecutionReceiptConflict,
  StoredExecutionReceiptEvidence,
  StoredExecutionReceiptObservation,
} from './evidence-store.js';
export { ExecutionReceiptEvidenceConfigurationError, createExecutionReceiptEvidenceRecorder, receiptAgreementOf } from './recorder.js';
export type { ExecutionReceiptEvidenceRecorder, ExecutionReceiptEvidenceRecorderOptions, ExecutionReceiptEvidenceRuntime, ExecutionReceiptIssuanceView } from './recorder.js';
export type { TrustedExecutor };

/**
 * The operator-pinned executor registry, as a verifier. Closed: every executor
 * id, key id and key exact and unique; no executor without a key, audience,
 * organization and trust domain. A key is never taken from a receipt and
 * never fetched.
 */
export function createExecutionReceiptTrust(trustedExecutors: readonly TrustedExecutor[]): ExecutorReceiptVerifier {
  try {
    return createExecutorReceiptVerifier({ trustedExecutors });
  } catch (error) {
    if (error instanceof ExecutorReceiptVerifierConfigurationError) throw new ExecutionReceiptEvidenceConfigurationError(`The executor receipt trust registry is invalid: ${error.message}`);
    throw error;
  }
}
