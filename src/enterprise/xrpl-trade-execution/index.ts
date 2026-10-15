/**
 * TRADE-04C — the governed XRPL delegated OfferCreate executor edge (gates G2
 * and G4): the execution adapter, its durable trade sequence interlock
 * (CORE-07 slot `trade-sequence-reservations`), the read-only P12 trade
 * resolution authority, the trade evidence projection, and the Host
 * configuration and composition that put them below the bounded grant.
 *
 * Reached only by the Enterprise Host's boot (dynamically, when the
 * governed-action file configures `xrplTradeExecution`). Not re-exported
 * from any package entrypoint.
 */
export { XRPL_TRADE_EXECUTOR_ID, XrplTradeHostConfigurationProblem, parseXrplTradeExecutionSection, tradeExecutionNetworkId, xrplTradeKeyMaterialVariables } from './host-configuration.js';
export type { EnterpriseHostXrplTradeExecutionConfiguration } from './host-configuration.js';
export { XRPL_TRADE_EXECUTOR_MODULE_ID, XRPL_TRADE_INTERLOCK_MODULE_ID, XrplTradeCompositionError, composeXrplTradeExecution, xrplTradeSequenceDomain } from './host-composition.js';
export type { ComposeXrplTradeExecutionOptions, ComposedXrplTradeExecution, XrplTradeCompositionFailure, XrplTradeLedgerClientFactory } from './host-composition.js';
export {
  TRADE_INTERLOCK_SETTLEMENTS,
  TRADE_INTERLOCK_STORE_SCHEMA_VERSION,
  TRADE_INTERLOCK_TRANSACTION_TYPE,
  TRADE_RESERVATIONS_STATE_KIND,
  TRADE_SUBMISSION_STATES,
  TradeInterlockStoreError,
  createSqliteTradeSequenceInterlock,
} from './sqlite-trade-sequence-interlock.js';
export type { DurableTradeSequenceInterlock, TradeInterlockSettlement, TradeReservation, TradeReservationEvidence, TradeReservationInput, TradeSubmissionRecord, TradeSubmissionState } from './sqlite-trade-sequence-interlock.js';
export { TRADE_EXECUTION_DETAILS } from './trade-execution-details.js';
export type { TradeExecutionDetail } from './trade-execution-details.js';
export { TRADE_EXECUTION_EVIDENCE_SCHEMA, tradeExecutionEvidenceOf } from './trade-execution-evidence.js';
export type { TradeExecutionEvidenceRecord, TradeExecutionEvidenceStatus } from './trade-execution-evidence.js';
export { TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT, TRADE_EXECUTOR_LIMITS, TradeExecutorConfigurationError, createTradeOfferExecutionAdapter } from './trade-offer-executor.js';
export type { TradeExecutionInterlock, TradeExecutionLedger, TradeExecutionPair, TradeExecutionTrace, TradeOfferExecutionAdapter, TradeOfferExecutorConfiguration, TradeOfferExecutorOptions } from './trade-offer-executor.js';
export { TRADE_RESOLUTION_AUTHORITY_ID, createTradeResolutionAuthority, readOnlyTradeLedger } from './trade-resolution-authority.js';
export type { TradeLedgerReader, TradeResolutionAuthorityOptions } from './trade-resolution-authority.js';
