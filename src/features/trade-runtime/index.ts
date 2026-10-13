/**
 * Trade Runtime — the governed delegated trading vertical (TRADE-01).
 *
 * > **Frontera is not a trading engine.** A trading proposal is applicant
 * > intent; it compiles down to the generic governed-action envelope and is
 * > decided on the unchanged governed path.
 *
 * TRADE-01 is the canonical contract only: the closed OfferCreate proposal,
 * exact assets, amounts and limit price, the canonical digest, and the pure
 * compiler onto the envelope. Nothing here signs, submits, reads a ledger,
 * holds a key or executes; nothing in Frontera's core imports this module.
 * See `docs/integrations/trade/TRADE-01-CANONICAL-OFFERCREATE-CONTRACTS.md`.
 *
 * TRADE-03 adds `policy/`: the trusted trading-risk profile, exact risk
 * arithmetic, trusted snapshot contracts and the sealed risk assessment — a
 * prerequisite the Governance Core consumes as admitted context, never a
 * decision of its own. See `docs/integrations/trade/TRADE-03-GRANULAR-TRADING-GOVERNANCE.md`.
 */
export * from './domain/index.js';
export * from './policy/index.js';
