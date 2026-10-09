/**
 * Payment Runtime — the governed-payment vertical (PAY-01).
 *
 * > **A payment is a governed action. It compiles down to the envelope, is
 * > decided on the unchanged governed path, and reaches a rail only as a
 * > granted, normalized instruction.**
 *
 * The canonical payment intent and its fail-closed validation, its
 * compilation onto the generic governed-action envelope, the rail-neutral
 * execution request prepared from a validated action, the payment rail
 * contract, and the bridge that composes a rail as an ordinary
 * `ExecutionAdapter`. No rail is implemented here, no key is held, nothing is
 * signed, and nothing in Frontera's core imports this module. See `README.md`
 * and `docs/payments/PAYMENT_ARCHITECTURE.md`.
 */
export * from './domain/index.js';
export * from './services/index.js';
