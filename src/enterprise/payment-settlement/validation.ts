/**
 * PAY-05 reuses P11's identifier and instant primitives verbatim — the same
 * grammar every governed execution id and recorded instant already obeys — so
 * a settlement can never accept an id or instant P11 would refuse. Only the
 * pure predicates are reused; nothing here reaches P11's store.
 */
export { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from '../execution-outcome-store/validation.js';
