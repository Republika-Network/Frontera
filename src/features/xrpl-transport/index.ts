/**
 * Shared XRPL transport (TRADE-04A) — the transaction-neutral foundation both
 * XRPL verticals stand on.
 *
 * > The Payment rail and the Trading rail may share XRPL transport
 * > infrastructure; they never share transaction-authoring authority.
 *
 * Pure contracts and readers only: the closed protocol grammar, network
 * identity, validated-ledger evidence and the read-only validated reader,
 * transaction-neutral submission and inclusion reading, and owner-account
 * `Sequence` safety (the blocking rule and the one-domain-per-account rule).
 *
 * It builds no transaction, signs nothing, submits nothing, opens no
 * connection, imports no SDK and holds no key. It knows no payment intent, no
 * trading strategy, no policy, approval or grant. The one XRPL client and the
 * one `submit` request stay where PAY-02 put them. Not re-exported from any
 * package entrypoint. See `docs/architecture/ADR-XRPL-SHARED-TRANSPORT.md`.
 */
export { XRPL_LEDGER_INDEX_MAXIMUM, isXrplEngineResult, isXrplLedgerHash, isXrplLedgerIndex, isXrplSigningPublicKey, isXrplTransactionHash } from './xrpl-ledger-grammar.js';
export { XRPL_MAINNET_NETWORK_ID, XRPL_NETWORK_IDENTITIES, checkXrplNetworkIdentity, isPermittedXrplNetworkId, readXrplNetworkId } from './xrpl-network-identity.js';
export type { XrplNetworkIdentityCheck, XrplNetworkName } from './xrpl-network-identity.js';
export {
  XRPL_VALIDATED_READ_FAILURES,
  bindXrplValidatedAnswer,
  isXrplNodePublicKey,
  readXrplLedgerHeader,
  readXrplLedgerIndex,
  readXrplServerValidatedLedger,
  readXrplValidatedLedgerHeader,
} from './xrpl-validated-ledger.js';
export type { XrplValidatedLedger, XrplValidatedLedgerHeader, XrplValidatedReadFailure } from './xrpl-validated-ledger.js';
export { XRPL_VALIDATED_READER_LIMITS, XrplValidatedReaderConfigurationError, createXrplValidatedLedgerReader } from './xrpl-validated-ledger-reader.js';
export type {
  XrplLedgerEntrySelector,
  XrplReadTimer,
  XrplValidatedLedgerEntry,
  XrplValidatedLedgerEntryRequest,
  XrplValidatedLedgerReadPort,
  XrplValidatedLedgerReader,
  XrplValidatedLedgerReaderOptions,
  XrplValidatedRead,
} from './xrpl-validated-ledger-reader.js';
export { readXrplInclusion, readXrplSubmission, xrplNonInclusionProven, xrplWindowClosed } from './xrpl-submission-reading.js';
export type { XrplInclusionReading, XrplSubmissionReading } from './xrpl-submission-reading.js';
export { XrplSequenceOwnershipError, assertXrplSequenceOwnership, xrplSequenceWindowBlocks } from './xrpl-sequence-safety.js';
export type { XrplSequenceDomain, XrplSequenceOwnership, XrplSequenceOwnershipProblem, XrplSequenceWindow } from './xrpl-sequence-safety.js';
export {
  XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET,
  XRPL_SHARED_RESTART_ANCHOR_SLACK_SECONDS,
  XRPL_SHARED_RESTART_QUARANTINE_LEDGERS,
  createXrplRestartQuarantine,
} from './xrpl-restart-quarantine.js';
export type { XrplRestartQuarantine } from './xrpl-restart-quarantine.js';
