/**
 * P11 — what a provider's answer establishes about its effect, in one
 * provider-neutral vocabulary.
 *
 * ```
 * ExecutionAdapterResult   ExecutionOutcome.status    ProviderEffectCertainty
 * completed             -> executed               -> confirmed-completed
 * failed                -> execution-failed       -> confirmed-not-completed
 * unconfirmed           -> execution-unconfirmed  -> unconfirmed
 * ```
 *
 * Three values, because a network effect has three: the provider did it, it
 * provably did not, or nobody can say. There is no fourth value for "probably",
 * "likely" or "assumed", no confidence score, and nothing here is inferred —
 * the certainty is a pure function of the status the execution runtime
 * already produced from the adapter's normalized result, so the two can never
 * be stored as independent facts that disagree.
 *
 * ## What it is not
 *
 * - **Not authorization.** A confirmed completion authorizes nothing further.
 * - **Not financial settlement.** `confirmed-completed` means the execution
 *   provider confirmed the effect it was asked to perform completed. It says
 *   nothing about whether funds settled irrevocably, a bank settled, a ledger
 *   reached finality, a receipt verified or an obligation was discharged.
 * - **Not a withholding.** A withheld execution never crossed the provider
 *   boundary, so it has no provider certainty at all — it is never
 *   `confirmed-not-completed`, which would claim a provider spoke.
 */
export const PROVIDER_EFFECT_CERTAINTIES = ['confirmed-completed', 'confirmed-not-completed', 'unconfirmed'] as const;

export type ProviderEffectCertainty = (typeof PROVIDER_EFFECT_CERTAINTIES)[number];

/** The `ExecutionOutcome` statuses that crossed the provider boundary. `withheld` is deliberately absent. */
export type ProviderObservedExecutionStatus = 'executed' | 'execution-failed' | 'execution-unconfirmed';

export function isProviderEffectCertainty(value: unknown): value is ProviderEffectCertainty {
  return typeof value === 'string' && (PROVIDER_EFFECT_CERTAINTIES as readonly string[]).includes(value);
}

/** The one mapping, as a type: each effect-bearing status to exactly one certainty. */
export interface ProviderEffectCertaintyByStatus {
  readonly executed: 'confirmed-completed';
  readonly 'execution-failed': 'confirmed-not-completed';
  readonly 'execution-unconfirmed': 'unconfirmed';
}

const CERTAINTY_BY_STATUS: ProviderEffectCertaintyByStatus = Object.freeze({
  executed: 'confirmed-completed',
  'execution-failed': 'confirmed-not-completed',
  'execution-unconfirmed': 'unconfirmed',
});

/** The certainty an effect-bearing status establishes. Exhaustive: a new status is a compile error in the mapping above. */
export function providerEffectCertaintyOf<S extends ProviderObservedExecutionStatus>(status: S): ProviderEffectCertaintyByStatus[S] {
  return CERTAINTY_BY_STATUS[status];
}

/** The inverse: the status a recorded certainty replays as. */
export function executionStatusOfCertainty(certainty: ProviderEffectCertainty): ProviderObservedExecutionStatus {
  switch (certainty) {
    case 'confirmed-completed':
      return 'executed';
    case 'confirmed-not-completed':
      return 'execution-failed';
    case 'unconfirmed':
      return 'execution-unconfirmed';
    default: {
      const unreachable: never = certainty;
      return unreachable;
    }
  }
}
