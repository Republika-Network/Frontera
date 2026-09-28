import type { MonetaryAmount } from '../../features/monetary-runtime/index.js';

/**
 * The one canonical mapping point between the two names money's asset has
 * (Master Plan §7 "Money", decided by CORE-03).
 *
 * | where | name | why it stays |
 * | --- | --- | --- |
 * | v1 wire (`POST /api/governed-actions`), SDK | `amount.currency` | frozen v1 API surface (`API_STABILITY_V1.md`) |
 * | Kernel request, policy input and policy predicates | `action.currency` / `currency` | the Kernel and policy-pack contracts, pinned by P9 suites |
 * | canonical money (`MonetaryAmount`), grants, exercise, adapters, P11 | `unit` | P9's canonical representation |
 *
 * Nothing is renamed; every translation between the names happens here and
 * nowhere else, so there is exactly one place where `currency` becomes `unit`
 * and back. `governed-action-neutrality-structure.test.ts` pins that.
 */

/** Wire → the input shape the P9 ingress (`parseMonetaryAmount`) takes. */
export function monetaryIngressFromWire(amount: { readonly value?: unknown; readonly currency?: unknown }): { readonly value: unknown; readonly unit: unknown } {
  return { value: amount.value, unit: amount.currency };
}

/** Canonical money → the Kernel request's `amount` / `currency` fields. */
export function kernelMonetaryFields(amount: MonetaryAmount): { readonly amount: string; readonly currency: string } {
  return { amount: amount.value, currency: amount.unit };
}

/** The Kernel request's `amount` / `currency` fields → canonical money, when both are present. */
export function monetaryAmountOfKernelAction(action: { readonly amount?: string; readonly currency?: string }): MonetaryAmount | undefined {
  return action.amount !== undefined && action.currency !== undefined ? { value: action.amount, unit: action.currency } : undefined;
}
