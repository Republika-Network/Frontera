/**
 * The XRPL Execution Adapter (ANDREW-P0-06) — XRPL Payment translation behind
 * the existing `ExecutionAdapter` port, composed as a child of the trusted
 * execution adapter registry. See `docs/demo/andrew/ANDREW-P0-06-XRPL-ADAPTER.md`.
 *
 * Module barrel only: not re-exported from the Enterprise barrel and not wired
 * into the Host's boot. An embedder composes it through
 * `BootEnterpriseHostOptions.executionAdapters` and a governed-action route,
 * with a transport it supplies. This module ships no transport, no signer and
 * no network configuration.
 */
export {
  XRPL_DESTINATION_NAMESPACE,
  XrplConfigurationError,
  isXrplConfigurationError,
  type XrplAssetMapping,
  type XrplAssetRepresentation,
  type XrplConfigurationErrorCode,
  type XrplExecutionAdapterOptions,
  type XrplIssuedCurrencyAmount,
  type XrplLedgerEvidence,
  type XrplPaymentInstruction,
  type XrplPaymentSubmission,
  type XrplPaymentTransport,
  type XrplSubmissionObservation,
} from './contracts.js';
export { XRPL_MAXIMUM_ASSET_MAPPINGS, isXrplNetworkLabel } from './configuration.js';
export {
  checkXrplSettlement,
  createXrplSettlementProfile,
  type XrplSettledToken,
  type XrplSettlementCheck,
  type XrplSettlementProfile,
  type XrplSettlementRefusal,
} from './settlement.js';
export {
  XRPL_DROPS_SCALE,
  XRPL_ISSUED_MAXIMUM_EXPONENT,
  XRPL_ISSUED_MAXIMUM_SIGNIFICANT_DIGITS,
  XRPL_ISSUED_MINIMUM_EXPONENT,
  XRPL_MAXIMUM_DROPS,
  isXrplClassicAddress,
  isXrplNonStandardCurrencyCode,
  isXrplStandardCurrencyCode,
  xrplDropsFromXrp,
  xrplIssuedCurrencyValue,
} from './xrpl-codec.js';
export { createXrplExecutionAdapter } from './xrpl-execution-adapter.js';
