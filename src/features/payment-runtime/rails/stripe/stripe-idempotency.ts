import { createHash } from 'node:crypto';

/**
 * Stripe idempotency keys for one governed execution (PAY-09).
 *
 * ```
 * frontera:<rail id>:<execution id>:create
 * frontera:<rail id>:<execution id>:confirm
 * ```
 *
 * Deterministic: derived from the server-derived execution identity, so every
 * attempt for the same execution — a second process, a restart — sends the
 * same key and Stripe answers it with the same saved response while it keeps
 * one. Non-sensitive: a rail id and an opaque execution id, never an email, a
 * name, card metadata, a secret or policy data (Stripe: "Avoid using
 * sensitive data … as idempotency keys"). Bounded: Stripe accepts up to 255
 * characters; an execution id that would not fit is replaced by its SHA-256,
 * still deterministic.
 *
 * ## Defence in depth — not the safety mechanism
 *
 * Stripe keeps a v1 key for "at least 24 hours" and may prune it after that,
 * and saves no result for a request that failed validation or collided with a
 * concurrent one. Frontera's guarantee — one governed execution, at most one
 * confirmation — must survive a restart, a long outage, a restore and any
 * retention window, so it is the durable interlock's
 * (`stripe-payment-interlock.ts`), and these keys only make a duplicate that
 * somehow reached Stripe inside the window collapse onto the first.
 */

export const STRIPE_IDEMPOTENCY_KEY_MAXIMUM_LENGTH = 255;

export type StripeIdempotentOperation = 'create' | 'confirm';

export function stripeIdempotencyKey(railId: string, executionId: string, operation: StripeIdempotentOperation): string {
  const plain = `frontera:${railId}:${executionId}:${operation}`;
  if (plain.length <= STRIPE_IDEMPOTENCY_KEY_MAXIMUM_LENGTH) return plain;
  const digest = createHash('sha256').update(`frontera.stripe-idempotency.v1\u0000${executionId}`, 'utf8').digest('hex');
  return `frontera:${railId}:sha256-${digest}:${operation}`;
}
