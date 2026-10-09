import { canonicalDecimalOfLedgerValue } from './xrpl-amount.js';

/**
 * Reading XRPL server answers (PAY-02) — pure, total, and conservative.
 *
 * ## What establishes finality
 *
 * The `submit` answer is **provisional**. Its `engine_result` is the result
 * of applying the transaction to the server's *open* ledger; even
 * `tesSUCCESS` there means only "tentatively applied" and can still end in a
 * different result, or no inclusion at all. So a submit answer can prove only
 * one thing definitively: a `tem…` result — the transaction is malformed and
 * can never be applied. Everything else waits for a validated ledger.
 *
 * Final answers come only from a `tx` lookup:
 *
 * - `validated: true` **and** `meta.TransactionResult` — the transaction is in
 *   a validated ledger with that result, which is immutable. `tesSUCCESS`
 *   there, with `meta.delivered_amount` equal to the granted amount in the
 *   configured currency and issuer, is a completed payment. A `tec…` result
 *   there is a definitive failure (the fee was consumed; no value moved).
 * - `txnNotFound` with `searched_all: true` over `[minLedger, LastLedgerSequence]`
 *   — read once the validated ledger index has **reached**
 *   `LastLedgerSequence` (that ledger itself validated) — proves the
 *   transaction was never included and,
 *   because the protocol forbids inclusion after `LastLedgerSequence`, never
 *   can be.
 *
 * Anything else — not validated yet, not found without a complete search,
 * a shape this file cannot read — is not final.
 */

const ENGINE_RESULT = /^(?:tes|tec|tef|tel|tem|ter)[A-Z_]{1,48}$/;

export type XrplSubmissionReading =
  /** `tem…`: malformed, never applied, never can be. */
  | { readonly kind: 'malformed'; readonly engineResult: string }
  /** Anything else readable: provisional. Wait for a validated result. */
  | { readonly kind: 'provisional'; readonly engineResult: string }
  | { readonly kind: 'unreadable' };

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/** Reads a raw `submit` result for the transaction with `hash`. */
export function readSubmission(raw: unknown, hash: string): XrplSubmissionReading {
  const result = recordOf(raw);
  const engineResult = result?.['engine_result'];
  if (result === undefined || typeof engineResult !== 'string' || !ENGINE_RESULT.test(engineResult)) return { kind: 'unreadable' };
  const echoed = recordOf(result['tx_json'])?.['hash'];
  if (echoed !== undefined && echoed !== hash) return { kind: 'unreadable' };
  return engineResult.startsWith('tem') ? { kind: 'malformed', engineResult } : { kind: 'provisional', engineResult };
}

export interface XrplExpectedPayment {
  readonly hash: string;
  readonly currency: string;
  readonly issuer: string;
  /** The granted amount, P9 canonical decimal. */
  readonly value: string;
}

export type XrplLookupReading =
  | { readonly kind: 'validated-success' }
  /** Validated `tesSUCCESS`, but what was delivered is not exactly what was granted. Never reported as completed. */
  | { readonly kind: 'validated-delivered-mismatch' }
  | { readonly kind: 'validated-failure'; readonly engineResult: string }
  | { readonly kind: 'validated-unrecognized' }
  /** Not found, and the server holds every ledger in the searched range. */
  | { readonly kind: 'not-found-complete' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unreadable' };

function deliveredMatches(delivered: unknown, expected: XrplExpectedPayment): boolean {
  const amount = recordOf(delivered);
  if (amount === undefined) return false;
  return amount['currency'] === expected.currency && amount['issuer'] === expected.issuer && canonicalDecimalOfLedgerValue(amount['value']) === expected.value;
}

/** Reads a raw `tx` lookup answer (a result, or a server error object). */
export function readLookup(raw: unknown, expected: XrplExpectedPayment): XrplLookupReading {
  const result = recordOf(raw);
  if (result === undefined) return { kind: 'unreadable' };
  const error = result['error'];
  if (error !== undefined) {
    if (error === 'txnNotFound') return result['searched_all'] === true ? { kind: 'not-found-complete' } : { kind: 'pending' };
    return { kind: 'unreadable' };
  }
  if (result['hash'] !== expected.hash) return { kind: 'unreadable' };
  if (result['validated'] !== true) return result['validated'] === false || result['validated'] === undefined ? { kind: 'pending' } : { kind: 'unreadable' };
  const meta = recordOf(result['meta']);
  const engineResult = meta?.['TransactionResult'];
  if (meta === undefined || typeof engineResult !== 'string' || !ENGINE_RESULT.test(engineResult)) return { kind: 'unreadable' };
  if (engineResult === 'tesSUCCESS') return deliveredMatches(meta['delivered_amount'], expected) ? { kind: 'validated-success' } : { kind: 'validated-delivered-mismatch' };
  if (engineResult.startsWith('tec')) return { kind: 'validated-failure', engineResult };
  return { kind: 'validated-unrecognized' };
}

/** The validated ledger index a client answered, or `undefined`. */
export function readLedgerIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/** The `network_id` a raw `server_info` result reports, or `undefined` when absent or malformed. */
export function readNetworkId(raw: unknown): number | undefined {
  const networkId = recordOf(recordOf(raw)?.['info'])?.['network_id'];
  return typeof networkId === 'number' && Number.isSafeInteger(networkId) && networkId >= 0 ? networkId : undefined;
}

/**
 * The autofilled payment, checked: every field the rail set is unchanged, the
 * only additions are a positive `Sequence` and a whole-drops `Fee`, and
 * nothing else appeared. Answers just those two values — the rail rebuilds the
 * prepared payment from its own fields, never from the client's object.
 */
export function readAutofill(raw: unknown, built: Readonly<Record<string, unknown>>): { readonly Sequence: number; readonly Fee: string } | undefined {
  const filled = recordOf(raw);
  if (filled === undefined) return undefined;
  const allowed = new Set([...Object.keys(built), 'Sequence', 'Fee']);
  // A key whose value is `undefined` is absent on the wire: the SDK assigns `NetworkID = undefined` on networks ≤ 1024.
  for (const [key, value] of Object.entries(filled)) if (value !== undefined && !allowed.has(key)) return undefined;
  for (const [key, value] of Object.entries(built)) {
    if (key === 'Amount') {
      const amount = recordOf(filled['Amount']);
      const expected = value as Readonly<Record<string, unknown>>;
      if (amount === undefined || Object.keys(amount).length !== 3 || amount['currency'] !== expected['currency'] || amount['issuer'] !== expected['issuer'] || amount['value'] !== expected['value']) return undefined;
    } else if (filled[key] !== value) {
      return undefined;
    }
  }
  const sequence = filled['Sequence'];
  const fee = filled['Fee'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) return undefined;
  if (typeof fee !== 'string' || !/^[1-9][0-9]{0,15}$/.test(fee)) return undefined;
  return { Sequence: sequence, Fee: fee };
}
