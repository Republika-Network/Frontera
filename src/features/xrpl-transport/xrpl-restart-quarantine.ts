import { isXrplLedgerIndex } from './xrpl-ledger-grammar.js';

/**
 * The restart quarantine (TRADE-04C), transaction-neutral.
 *
 * The same rule PAY-03's rail observes (`xrpl-submission-interlock.ts` in the
 * Payment rail states the proof; the Payment rail keeps its own copy,
 * unchanged): a transaction may be prepared at validated index `V` only when
 *
 * ```
 * (a) close_time(validated ledger V − window) ≥ start + slack      (this host's clock)
 * (b) V ≥ F + window, F = the first validated index observed         (the boot server)
 * ```
 *
 * so every transaction any earlier process signed — under any configuration
 * whose `LastLedgerSequence` offset never exceeded the historical maximum —
 * has provably left its window, even if its durable record was lost. Both
 * witnesses must hold; either alone can fail. Defense in depth beside the
 * CORE-07-anchored interlock, never instead of it.
 *
 * The window is the largest `LastLedgerSequence` offset **any** XRPL
 * submission domain on this Host has ever been allowed (Payment's
 * historical 200, which the trade executor's own bound is held to) plus a
 * margin: a domain's quarantine also covers an account another domain used
 * before a configuration change moved it.
 */

/** The largest `LastLedgerSequence` offset any XRPL domain may use, ever. Equal to PAY-03's historical bound; it may grow, never shrink. */
export const XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET = 200;
export const XRPL_SHARED_RESTART_QUARANTINE_LEDGERS = XRPL_SHARED_HISTORICAL_MAX_LAST_LEDGER_OFFSET + 4;
export const XRPL_SHARED_RESTART_ANCHOR_SLACK_SECONDS = 180;
const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800;

export interface XrplRestartQuarantine {
  /** Records a validated index this process observed (the progress floor is the first). */
  observe(validatedLedgerIndex: number): void;
  /**
   * Whether preparation is still quarantined at `validatedLedgerIndex`.
   * `closeTimeOf` reads a **validated** ledger header's close time (Ripple
   * seconds), or `undefined` when it cannot. Never throws: an unreadable
   * header holds the quarantine.
   */
  quarantined(validatedLedgerIndex: number, closeTimeOf: (index: number) => Promise<number | undefined>): Promise<boolean>;
}

/** `startedAtUnixMs`: this process's start, from its own clock. */
export function createXrplRestartQuarantine(startedAtUnixMs: number): XrplRestartQuarantine {
  if (typeof startedAtUnixMs !== 'number' || !Number.isSafeInteger(Math.floor(startedAtUnixMs)) || startedAtUnixMs <= 0) throw new TypeError('The restart quarantine needs a positive start time.');
  const window = XRPL_SHARED_RESTART_QUARANTINE_LEDGERS;
  const anchor = Math.floor(startedAtUnixMs / 1000) - RIPPLE_EPOCH_UNIX_SECONDS + XRPL_SHARED_RESTART_ANCHOR_SLACK_SECONDS;
  let firstObserved: number | undefined;
  let proven: number | undefined;
  return Object.freeze({
    observe(validatedLedgerIndex: number): void {
      if (firstObserved === undefined && isXrplLedgerIndex(validatedLedgerIndex)) firstObserved = validatedLedgerIndex;
    },
    async quarantined(validated: number, closeTimeOf: (index: number) => Promise<number | undefined>): Promise<boolean> {
      if (!isXrplLedgerIndex(validated) || firstObserved === undefined || validated < firstObserved + window) return true;
      if (proven !== undefined && validated >= proven + window) return false;
      const candidate = validated - window;
      if (candidate < 1) return true;
      let closeTime: number | undefined;
      try {
        closeTime = await closeTimeOf(candidate);
      } catch {
        return true;
      }
      if (typeof closeTime !== 'number' || !Number.isSafeInteger(closeTime) || closeTime < anchor) return true;
      proven = proven === undefined ? candidate : Math.min(proven, candidate);
      return false;
    },
  });
}
