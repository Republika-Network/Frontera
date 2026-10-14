/**
 * Trading-risk policy (TRADE-03): the trusted risk profile, exact price,
 * deviation, notional and exposure arithmetic, trusted market and exposure
 * snapshot contracts, the sealed risk assessment, its reliance check and its
 * projection onto CORE-04 fact readings. Pure domain code: it decides,
 * grants, signs and submits nothing.
 */
export {
  TRADE_RISK_BASIS_POINTS,
  ZERO_RATIONAL,
  addRationals,
  compareRationals,
  deviationBasisPoints,
  formatTradeRational,
  multiplyRationals,
  parsePositiveRiskDecimal,
  parseRiskAsset,
  parseRiskPrice,
  rationalOfDecimal,
  rationalOfQuantity,
} from './trade-risk-exact.js';
export type { TradeRational } from './trade-risk-exact.js';

export {
  TRADE_REFERENCE_CONVENTIONS,
  TRADING_RISK_MAXIMUM_ASSESSMENT_AGE_SECONDS,
  TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS,
  TRADING_RISK_PROFILE_DIGEST_DOMAIN,
  TRADING_RISK_PROFILE_MAXIMUM_HORIZON_SECONDS,
  TRADING_RISK_PROFILE_SCHEMA,
  TRADING_RISK_PROFILE_VIOLATIONS,
  parseTradingRiskProfile,
  tradingRiskProfileData,
  tradingRiskProfileReference,
} from './trade-risk-profile.js';
export type {
  TradeActiveOrderPolicy,
  TradeActiveOrderScope,
  TradeDeviationPolicy,
  TradeDeviationRule,
  TradeExposurePolicy,
  TradeFactProvenancePolicy,
  TradeMarketReferencePolicy,
  TradeNotionalPolicy,
  TradePairApprovalTriggers,
  TradePriceBand,
  TradeReferenceConvention,
  TradeRiskControlDisabled,
  TradeRiskProfileStatus,
  TradingPairRiskPolicy,
  TradingRiskProfile,
  TradingRiskProfileParse,
  TradingRiskProfileViolationCode,
} from './trade-risk-profile.js';

export {
  TRADE_MARKET_SNAPSHOT_DIGEST_DOMAIN,
  TRADE_MARKET_SNAPSHOT_SCHEMA,
  TRADE_REFERENCE_REASONS,
  parseTradeFactProvenance,
  parseTrustedMarketPriceSnapshot,
  provenanceAdmitted,
  sealTrustedMarketPriceSnapshot,
  selectTradeReference,
  trustedMarketPriceSnapshotData,
} from './trade-market-reference.js';
export type {
  TradeFactProvenance,
  TradeFactProvenanceKind,
  TradeReferenceReason,
  TradeReferenceRequirement,
  TradeReferenceSelection,
  TrustedMarketPriceReading,
  TrustedMarketPriceSnapshot,
} from './trade-market-reference.js';

export {
  TRADE_ACTIVE_ORDER_SNAPSHOT_DIGEST_DOMAIN,
  TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA,
  TRADE_EXPOSURE_SNAPSHOT_DIGEST_DOMAIN,
  TRADE_EXPOSURE_SNAPSHOT_SCHEMA,
  parseTradeActiveOrderSnapshot,
  parseTradeExposureSnapshot,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  summarizeTradeOrderInventory,
  tradeActiveOrderCount,
  tradeActiveOrderScopeKey,
  tradeActiveOrderSnapshotData,
  tradeExposureCommitted,
  tradeExposureSnapshotData,
} from './trade-exposure.js';
export type {
  TradeActiveOrderReading,
  TradeActiveOrderSnapshot,
  TradeExposureReading,
  TradeExposureSnapshot,
  TradeOrderInventoryEntry,
  TradeOrderInventoryResult,
  TradeOrderInventorySummary,
  TradeOrderLifecycleState,
} from './trade-exposure.js';

export {
  TRADING_RISK_ASSESSMENT_DIGEST_DOMAIN,
  TRADING_RISK_ASSESSMENT_REFUSALS,
  TRADING_RISK_ASSESSMENT_SCHEMA,
  TRADING_RISK_CONTROLS,
  TRADING_RISK_DISABLEABLE_CONTROLS,
  assessTradingRisk,
  tradingPairPolicyFor,
  tradingRiskDisabledControls,
} from './trade-risk-assessment.js';
export type {
  TradingRiskAssessmentEvidence,
  TradingRiskAssessmentInput,
  TradingRiskAssessmentRefusal,
  TradingRiskAssessmentResult,
  TradingRiskControlId,
  TradingRiskControlOutcome,
  TradingRiskControlResult,
  TradingRiskDisposition,
  TradingRiskFreshnessEntry,
  TradingRiskOutcome,
  TradingRiskSourceEvidence,
} from './trade-risk-assessment.js';

export {
  TRADE_INTENT_BINDING_FACTS,
  TRADE_RISK_FACT_CLASSES,
  TRADING_RISK_RELIANCE_REFUSALS,
  checkTradingRiskReliance,
  tradeDelegationContextReading,
  tradingRiskContextReadings,
} from './trade-risk-reliance.js';
export type { TradeContextProjection, TradeContextQueryBinding, TradeContextReading, TradingRiskReliance, TradingRiskRelianceExpectation, TradingRiskRelianceRefusal } from './trade-risk-reliance.js';
