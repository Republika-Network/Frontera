/**
 * PROD-03-01 — what the orchestrator tells an operational observer, after each
 * governed-path fact is established. Write-only and closed: every method takes
 * identities, closed statuses and reason codes, and returns nothing. The
 * orchestrator calls it inside a guard, so an observer that throws can never
 * change a result, and nothing ever reads it back to decide anything.
 *
 * Never an amount, a governed parameter, a grant, an adapter or provider
 * reference, a credential, a header or a request body.
 */
export interface GovernedPathRef {
  readonly requestId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
}

export interface GovernedPathExecutionRef extends GovernedPathRef {
  readonly executionId: string;
}

/** The initial answer an execution returned, as P11 certainty plus the withholding case. */
export type GovernedPathOutcome = 'confirmed-completed' | 'confirmed-not-completed' | 'unconfirmed' | 'withheld';

export interface GovernedPathObserver {
  /** The decision was committed (or re-read on a replay of the same request) and verified. */
  decision(ref: GovernedPathRef & { readonly status: string; readonly reasonCodes: readonly string[] }): void;
  /** The Kernel allowed the action and issuance withheld it (LAND-02). */
  issuanceWithheld(ref: GovernedPathRef & { readonly withheldBy: string; readonly reasonCodes: readonly string[] }): void;
  /** The write-ahead claim is durable: the execution identity is about to cross to the adapter. */
  executionClaimed(ref: GovernedPathExecutionRef): void;
  /** The runtime returned an outcome; `outcomeRecorded` says whether its P11 observation is durable. */
  executionOutcome(ref: GovernedPathExecutionRef & { readonly outcome: GovernedPathOutcome; readonly outcomeRecorded: boolean; readonly reasonCodes: readonly string[]; readonly withheldBy?: string }): void;
  /** A claimed execution has no confirmed outcome: unconfirmed by the provider, unrecorded, or unknown after the adapter boundary. */
  unconfirmedExecution(ref: GovernedPathExecutionRef & { readonly reasonCodes: readonly string[] }): void;
}
