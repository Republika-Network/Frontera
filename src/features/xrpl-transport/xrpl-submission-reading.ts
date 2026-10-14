import { isXrplEngineResult, isXrplLedgerIndex } from './xrpl-ledger-grammar.js';

/**
 * Reading what the network says about one submitted transaction (TRADE-04A) —
 * pure, total and conservative, and indifferent to the transaction's type.
 *
 * ## Provisional versus final
 *
 * A `submit` answer is **provisional**: its `engine_result` is the result of
 * applying the transaction to the server's open ledger, and even `tesSUCCESS`
 * there can still end differently, or not at all. It proves one thing
 * definitively: a `tem…` result — malformed, never applied, never can be.
 *
 * Inclusion is final only from a `tx` lookup that says `validated: true`, with
 * a `meta.TransactionResult`. Non-inclusion is final only from `txnNotFound`
 * with `searched_all: true` over `[minLedger, LastLedgerSequence]`, read once
 * the validated index has **reached** `LastLedgerSequence` (the protocol
 * forbids inclusion after it). Anything else is not final, and elapsed time
 * alone never makes it so.
 *
 * What a validated result **means** for the governed action — a payment that
 * delivered exactly the granted amount, an offer that rested or filled — is
 * the owning vertical's reading, never this file's: a validated `tesSUCCESS`
 * is not, by itself, a completed payment or a trading fill.
 */

export type XrplSubmissionReading =
  /** `tem…`: malformed, never applied, never can be. */
  | { readonly kind: 'malformed'; readonly engineResult: string }
  /** Anything else readable: provisional. Wait for a validated result. */
  | { readonly kind: 'provisional'; readonly engineResult: string }
  | { readonly kind: 'unreadable' };

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/** Reads a raw `submit` result for the transaction with `hash`. The PAY-02 rail's `readSubmission`, unchanged. */
export function readXrplSubmission(raw: unknown, hash: string): XrplSubmissionReading {
  const result = recordOf(raw);
  const engineResult = result?.['engine_result'];
  if (result === undefined || !isXrplEngineResult(engineResult)) return { kind: 'unreadable' };
  const echoed = recordOf(result['tx_json'])?.['hash'];
  if (echoed !== undefined && echoed !== hash) return { kind: 'unreadable' };
  return engineResult.startsWith('tem') ? { kind: 'malformed', engineResult } : { kind: 'provisional', engineResult };
}

export type XrplInclusionReading =
  /** In a validated ledger with this result: immutable. What it means for the governed action is the vertical's reading. */
  | { readonly kind: 'validated'; readonly engineResult: string; readonly ledgerIndex: number }
  /** Not found, and the server holds every ledger in the searched range. Final only once the window is closed (`xrplNonInclusionProven`). */
  | { readonly kind: 'not-found-complete' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unreadable' };

/** Reads a raw `tx` lookup answer (a result, or a server error object) for `hash`, transaction-neutrally. */
export function readXrplInclusion(raw: unknown, hash: string): XrplInclusionReading {
  const result = recordOf(raw);
  if (result === undefined) return { kind: 'unreadable' };
  const error = result['error'];
  if (error !== undefined) {
    if (error === 'txnNotFound') return result['searched_all'] === true ? { kind: 'not-found-complete' } : { kind: 'pending' };
    return { kind: 'unreadable' };
  }
  if (result['hash'] !== hash) return { kind: 'unreadable' };
  if (result['validated'] !== true) return result['validated'] === false || result['validated'] === undefined ? { kind: 'pending' } : { kind: 'unreadable' };
  const engineResult = recordOf(result['meta'])?.['TransactionResult'];
  const ledgerIndex = result['ledger_index'];
  if (!isXrplEngineResult(engineResult) || !isXrplLedgerIndex(ledgerIndex)) return { kind: 'unreadable' };
  return { kind: 'validated', engineResult, ledgerIndex };
}

/** Whether the validated ledger has reached `LastLedgerSequence`: from then on the transaction can never be included. */
export function xrplWindowClosed(validatedLedgerIndex: number, lastLedgerSequence: number): boolean {
  return isXrplLedgerIndex(validatedLedgerIndex) && isXrplLedgerIndex(lastLedgerSequence) && validatedLedgerIndex >= lastLedgerSequence;
}

/**
 * Non-inclusion, proven: a complete search found nothing **and** the validated
 * index — read *before* the lookup — had already reached the window's end.
 * Neither alone suffices, and no amount of elapsed time substitutes for either.
 */
export function xrplNonInclusionProven(reading: XrplInclusionReading, validatedIndexBeforeLookup: number | undefined, lastLedgerSequence: number): boolean {
  return reading.kind === 'not-found-complete' && validatedIndexBeforeLookup !== undefined && xrplWindowClosed(validatedIndexBeforeLookup, lastLedgerSequence);
}
