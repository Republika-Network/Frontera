/**
 * The one validated read this module needs, structurally: the shared
 * transport's `XrplValidatedLedgerReader.ledgerEntry` (network-bound,
 * validated, freshness-bounded). The composition that may import the shared
 * transport builds it (`host-composition.ts`); this module imports neither the
 * transport nor the TRADE-02 rail.
 */
export interface TradeSequenceEntryReader {
  ledgerEntry(selector: { readonly account_root: string }): Promise<
    | { readonly outcome: 'read'; readonly value: { readonly ledgerIndex: number; readonly ledgerHash: string; readonly entry: { readonly state: 'absent' } | { readonly state: 'present'; readonly node: unknown } } }
    | { readonly outcome: 'unavailable'; readonly failure: string }
  >;
}

/**
 * The owner's `Sequence` from a validated `AccountRoot` node — the same rule
 * as TRADE-02's `readXrplOwnerSequence` (pinned equal by test): the entry type,
 * the owner, and a positive uint32 `Sequence`, or `undefined`.
 */
export function readTradeOwnerSequence(node: unknown, owner: string): number | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const field = (name: string): unknown => Object.getOwnPropertyDescriptor(node, name)?.value;
  if (field('LedgerEntryType') !== 'AccountRoot' || field('Account') !== owner) return undefined;
  const sequence = field('Sequence');
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0 && sequence <= 0xffff_ffff ? sequence : undefined;
}

/**
 * TRADE-04D D-1 — **owner-`Sequence` evidence** for an intent whose
 * transaction hash Frontera never learned (the signer was contacted; no
 * reservation followed). Read-only, over the shared validated reader (network
 * bound, validated ledger only, freshness bounded).
 *
 * The one ledger fact it can prove without the hash:
 *
 * > At a validated ledger `L ≥ LastLedgerSequence`, the owner's `AccountRoot`
 * > `Sequence` still equals the intent's `Sequence`.
 *
 * Every transaction that consumes a `Sequence` — `tesSUCCESS` or `tec…` —
 * advances it by one, and it never moves back (an account deleted and
 * re-created starts at the ledger index of its re-creation, which is past
 * this one). The intent's transaction carries exactly that `Sequence` and
 * that `LastLedgerSequence`, so it was included in no ledger up to `L`, and
 * can be included in none after `LastLedgerSequence`: **proven not
 * included**, whatever its hash or signature.
 *
 * | validated owner `Sequence` at `L` | answer |
 * | --- | --- |
 * | `= Sequence`, `L ≥ LastLedgerSequence` | `not-included` (proof `owner-sequence-unconsumed`) |
 * | `= Sequence`, `L < LastLedgerSequence` | `unresolved window-open` |
 * | `> Sequence` | `sequence-consumed` — consumed by **some** transaction; whether it was this intent's is not provable without the hash. Never a closure |
 * | `< Sequence` | `unresolved sequence-regressed` (contradicts the protocol) |
 * | entry absent (`entryNotFound`) | `unresolved entry-absent` — never proof of anything |
 * | any read failure | `unresolved` with the reader's reason |
 *
 * An XRPL server is trusted to report what it validated
 * (ADR-XRPL-SHARED-TRANSPORT); this binds and orders the answer, it does not
 * verify ledger proofs.
 */
export interface TradeSequenceWindow {
  readonly account: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
}

export type TradeSequenceEvidenceReason = 'window-open' | 'entry-absent' | 'entry-malformed' | 'sequence-regressed' | 'ledger-unavailable';

export type TradeSequenceEvidence =
  | { readonly status: 'not-included'; readonly proof: 'owner-sequence-unconsumed'; readonly window: TradeSequenceWindow; readonly ledgerIndex: number; readonly ledgerHash: string; readonly accountSequence: number }
  | { readonly status: 'sequence-consumed'; readonly ledgerIndex: number; readonly ledgerHash: string; readonly accountSequence: number }
  | { readonly status: 'unresolved'; readonly reason: TradeSequenceEvidenceReason; readonly failure?: string; readonly ledgerIndex?: number; readonly ledgerHash?: string };

/**
 * Proofs this module produced — and only those. An intent is released on the
 * ledger only with one (`isQualifiedTradeSequenceProof`): a caller cannot
 * forge one from an execution id or a plain object asserting finality.
 */
const QUALIFIED_PROOFS = new WeakSet<object>();

/** Whether `value` is a non-inclusion proof this module produced for exactly `window` (owner, `Sequence`, `LastLedgerSequence`), at or past `LastLedgerSequence`. */
export function isQualifiedTradeSequenceProof(value: unknown, window: TradeSequenceWindow): boolean {
  if (value === null || typeof value !== 'object' || !QUALIFIED_PROOFS.has(value)) return false;
  const proof = value as Extract<TradeSequenceEvidence, { readonly status: 'not-included' }>;
  return (
    proof.status === 'not-included' &&
    proof.window.account === window.account &&
    proof.window.sequence === window.sequence &&
    proof.window.lastLedgerSequence === window.lastLedgerSequence &&
    proof.accountSequence === window.sequence &&
    proof.ledgerIndex >= window.lastLedgerSequence
  );
}

/** The validated ledger an `expired` intent's owner-`Sequence` proof was taken at, as the interlock recorded it. */
export interface TradeRecordedSequenceExpiry {
  readonly ledgerIndex: number;
  readonly ledgerHash: string;
}

/** `expireOnProof`'s transition detail (`sqlite-trade-sequence-interlock.ts`): `unconsumed.<validated index>.<validated ledger hash>`. */
const RECORDED_EXPIRY = /^unconsumed\.([1-9][0-9]{0,9})\.([0-9A-F]{64})$/;

/**
 * TRADE-04D P2 — the proof an `expired` intent already carries. The interlock
 * writes `expired` only on a qualified proof for exactly the intent's window,
 * and records that proof's validated ledger with the transition. From then on
 * the recorded fact is the evidence: the window closed with the `Sequence`
 * unconsumed, so the intent's transaction can never be included, and the
 * released `Sequence` is the owner's next one — a later transaction consuming
 * it says nothing about this intent.
 *
 * Answers the recorded ledger, or `undefined` when the intent is not
 * `expired`, has not exactly one `expired` transition, or that transition does
 * not carry a well-formed proof at or past `LastLedgerSequence`. An
 * `undefined` record is never trusted as a closure.
 */
export function recordedTradeSequenceExpiry(intent: {
  readonly state: string;
  readonly lastLedgerSequence: number;
  readonly transitions: readonly { readonly to: string; readonly detail?: string }[];
}): TradeRecordedSequenceExpiry | undefined {
  if (intent.state !== 'expired') return undefined;
  const expiries = intent.transitions.filter((transition) => transition.to === 'expired');
  if (expiries.length !== 1) return undefined;
  const match = RECORDED_EXPIRY.exec(expiries[0]!.detail ?? '');
  if (match === null) return undefined;
  const ledgerIndex = Number(match[1]);
  if (!Number.isSafeInteger(ledgerIndex) || ledgerIndex > 0xffff_ffff || ledgerIndex < intent.lastLedgerSequence) return undefined;
  return Object.freeze({ ledgerIndex, ledgerHash: match[2]! });
}

export async function readTradeSequenceEvidence(reader: TradeSequenceEntryReader, window: TradeSequenceWindow): Promise<TradeSequenceEvidence> {
  let read: Awaited<ReturnType<TradeSequenceEntryReader['ledgerEntry']>>;
  try {
    read = await reader.ledgerEntry({ account_root: window.account });
  } catch {
    return Object.freeze({ status: 'unresolved', reason: 'ledger-unavailable' });
  }
  if (read.outcome !== 'read') return Object.freeze({ status: 'unresolved', reason: 'ledger-unavailable', failure: read.failure });
  const { ledgerIndex, ledgerHash, entry } = read.value;
  const at = { ledgerIndex, ledgerHash };
  if (entry.state !== 'present') return Object.freeze({ status: 'unresolved', reason: 'entry-absent', ...at });
  const accountSequence = readTradeOwnerSequence(entry.node, window.account);
  if (accountSequence === undefined) return Object.freeze({ status: 'unresolved', reason: 'entry-malformed', ...at });
  if (accountSequence > window.sequence) return Object.freeze({ status: 'sequence-consumed', ...at, accountSequence });
  if (accountSequence < window.sequence) return Object.freeze({ status: 'unresolved', reason: 'sequence-regressed', ...at });
  if (ledgerIndex < window.lastLedgerSequence) return Object.freeze({ status: 'unresolved', reason: 'window-open', ...at });
  const proof = Object.freeze({ status: 'not-included' as const, proof: 'owner-sequence-unconsumed' as const, window: Object.freeze({ account: window.account, sequence: window.sequence, lastLedgerSequence: window.lastLedgerSequence }), ...at, accountSequence });
  QUALIFIED_PROOFS.add(proof);
  return proof;
}
