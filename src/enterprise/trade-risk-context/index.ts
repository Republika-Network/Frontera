/**
 * The TRADE composition edge (TRADE-03 K1): a CORE-04 trusted context
 * provider over the trading-risk assessment, its in-process ingress, and the
 * deployment data (policy rules, source declarations) it needs. Composes
 * nothing that decides, grants, signs, submits or executes.
 */
export {
  TRADE_RISK_ADMISSION_REFUSALS,
  TRADE_RISK_MAXIMUM_ATTESTATIONS,
  TRADE_RISK_MAXIMUM_ATTESTATION_SECONDS,
  TRADE_RISK_MATERIAL_FACTS,
  TRADE_RISK_MAXIMUM_BINDING_SECONDS,
  TRADE_RISK_MAXIMUM_PENDING_BINDINGS,
  TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT,
  TradeRiskContextConfigurationError,
  createTradeRiskContext,
} from './trade-risk-context.js';
export type {
  TradeActiveOrderReadRequest,
  TradeExposureReadRequest,
  TradeMarketReadRequest,
  TradeRiskAdmission,
  TradeRiskAdmissionRefusal,
  TradeRiskContext,
  TradeRiskContextOptions,
  TradeRiskSourcePorts,
  TradeAttestedProposal,
  TradeAttestedProposalSource,
} from './trade-risk-context.js';
export { TRADE_RISK_ABSENCE_SENSITIVE_RULES, tradeRiskPolicyRules, tradeRiskTrustedContextSources } from './trade-risk-policy.js';
export type { TradeRiskPolicyOptions, TradeRiskSourceDeclarationOptions } from './trade-risk-policy.js';
