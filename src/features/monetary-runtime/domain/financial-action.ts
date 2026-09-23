import { MonetaryConfigurationError } from './monetary-asset.js';

/**
 * Host-trusted financial action classification.
 *
 * Whether an action moves money is a fact about the *action*, decided by the
 * deployment that defines it — never by the request that invokes it. So the
 * classification is a pure function of trusted host configuration and the
 * action identifier, and there is no input through which a caller could say
 * `financial: false` (or `true`): the classifier reads exactly one string, the
 * action type, and that string is itself proven against the Kernel decision and
 * the bounded grant downstream.
 *
 * Two classes and no third. An action the configuration does not list is
 * `non-financial`, and a non-financial governed action may carry **no** amount
 * at all — so an unlisted action cannot move money through the governed spine,
 * whichever way a caller spells its request. See
 * `docs/architecture/ADR-CANONICAL-MONETARY-SEMANTICS.md`.
 */

export const GOVERNED_ACTION_CLASSES = ['financial', 'non-financial'] as const;
export type GovernedActionClass = (typeof GOVERNED_ACTION_CLASSES)[number];

/** Read-only by type. Built once from host configuration and frozen. */
export interface FinancialActionClassifier {
  /** The trusted class of an action identifier. Total: anything not configured as financial — including a non-string — is `non-financial`. */
  classify(action: unknown): GovernedActionClass;
  /** Every action configured as financial, sorted. */
  readonly financialActions: readonly string[];
}

/** Non-empty, bounded, and free of surrounding whitespace and control characters, so two spellings never name one action. */
function isActionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * Builds the classifier, or throws `MonetaryConfigurationError` on configuration
 * that cannot be believed. Duplicates are harmless and collapsed; a malformed identifier is not.
 */
export function createFinancialActionClassifier(configuration: { readonly financialActions: readonly string[] }): FinancialActionClassifier {
  const listed: unknown = configuration?.financialActions;
  if (!Array.isArray(listed)) throw new MonetaryConfigurationError('financialActions must be an array of action identifiers.');
  const financial = new Set<string>();
  for (const action of listed as readonly unknown[]) {
    if (!isActionIdentifier(action)) throw new MonetaryConfigurationError('financialActions must contain only canonical action identifiers.');
    financial.add(action);
  }
  const financialActions = Object.freeze([...financial].sort());
  return Object.freeze({
    financialActions,
    classify(action: unknown): GovernedActionClass {
      return typeof action === 'string' && financial.has(action) ? 'financial' : 'non-financial';
    },
  });
}
