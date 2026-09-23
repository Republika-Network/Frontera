/**
 * Monetary Runtime — canonical monetary semantics (P9).
 *
 * > **Money is exact data with an explicit asset, and whether an action moves
 * > money is the host's call.**
 *
 * The one canonical decimal form and its exact arithmetic, the trusted asset
 * registry that says what a unit is and how many fractional digits it can
 * state, the single ingress that turns untrusted text into a `MonetaryAmount`,
 * and the host-trusted financial action classifier. Pure data and logic: no
 * number conversion of an amount, no rounding, no FX, no I/O, and no import from
 * outside this module. See `README.md` and
 * `docs/architecture/ADR-CANONICAL-MONETARY-SEMANTICS.md`.
 */
export * from './domain/index.js';
