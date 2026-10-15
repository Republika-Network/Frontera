import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessTradeOfferState, compareTradeAmounts, readOfferCreateEffect, readTradeOfferSnapshot, type TradeLedgerEvidence, type TradeOfferSnapshot } from '../xrpl-trade-execution/index.js';
import { testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04D §6 — transaction versus offer-state semantics. A validated
 * `tesSUCCESS` is a fact about the transaction; what it did to the book is
 * read from its own validated metadata, and only as far as the metadata
 * proves. A later snapshot is an independent observation at an identified
 * validated ledger; absence is never read as a fill.
 */

const OWNER = testAccount();
const OTHER = testAccount();
const SEQ = 41;
const HASH = 'A'.repeat(64);
const LEDGER_HASH = 'B'.repeat(64);
const USD = (value: string) => ({ currency: 'USD', issuer: OTHER, value });
const TX = { Account: OWNER, TransactionType: 'OfferCreate', Sequence: SEQ, LastLedgerSequence: 120, TakerGets: '1000000', TakerPays: USD('5'), Flags: 0 };

type Included = Extract<TradeLedgerEvidence, { readonly status: 'included' }>;
const included = (nodes: unknown[], options: { readonly result?: string; readonly tx?: Record<string, unknown>; readonly ledgerHash?: string | null } = {}): Included => {
  const result = options.result ?? 'tesSUCCESS';
  return {
    status: 'included',
    networkId: 1,
    transactionHash: HASH,
    engineResult: result,
    resultClass: result === 'tesSUCCESS' ? 'tesSUCCESS' : 'tec',
    ledgerIndex: 110,
    ...(options.ledgerHash === null ? {} : { ledgerHash: options.ledgerHash ?? LEDGER_HASH }),
    validatedIndexBefore: 111,
    validatedIndexAfter: 111,
    transaction: { ...TX, ...options.tx },
    meta: { TransactionResult: result, AffectedNodes: nodes },
  };
};
const created = (fields: Record<string, unknown>) => ({ CreatedNode: { LedgerEntryType: 'Offer', LedgerIndex: 'C'.repeat(64), NewFields: { Account: OWNER, Sequence: SEQ, ...fields } } });
const consumedCounterOffer = { DeletedNode: { LedgerEntryType: 'Offer', LedgerIndex: 'D'.repeat(64), FinalFields: { Account: OTHER, Sequence: 3 } } };

describe('TRADE-04D §6 — the initial effect, from validated metadata only', () => {
  it('placed with the transaction’s own amounts: offer-resting, as of the including ledger and its hash', () => {
    const reading = readOfferCreateEffect(included([created({ TakerGets: '1000000', TakerPays: USD('5') })]), OWNER, SEQ);
    assert.equal(reading.effect, 'offer-resting');
    assert.equal(reading.ledgerIndex, 110);
    assert.equal(reading.ledgerHash, LEDGER_HASH);
    assert.equal(reading.basis, 'validated-transaction-metadata');
  });

  it('exponent notation and trailing zeros compare by exact value (never a float)', () => {
    assert.equal(readOfferCreateEffect(included([created({ TakerGets: '1000000', TakerPays: USD('5.000') })]), OWNER, SEQ).effect, 'offer-resting');
    assert.equal(readOfferCreateEffect(included([created({ TakerGets: '1000000', TakerPays: USD('5e0') })]), OWNER, SEQ).effect, 'offer-resting');
    assert.equal(compareTradeAmounts(USD('0.1'), USD('1e-1')), 0);
    assert.equal(compareTradeAmounts(USD('1'), { currency: 'USD', issuer: OWNER, value: '1' }), undefined, 'another issuer is another asset');
  });

  it('both remainder amounts no larger, one smaller: partially-executed-remainder-resting — the remainder as the ledger states it, no executed quantity computed', () => {
    const reading = readOfferCreateEffect(included([consumedCounterOffer, created({ TakerGets: '500000', TakerPays: USD('2.5') })]), OWNER, SEQ);
    assert.equal(reading.effect, 'partially-executed-remainder-resting');
    assert.deepEqual(reading.offer, { takerGets: '500000', takerPays: USD('2.5'), ledgerEntryIndex: 'C'.repeat(64) });
    assert.equal('executed' in reading || 'fillPrice' in reading, false);
  });

  it('no offer left, plain flags: applied-not-resting (full crossing, IOC remainder or unplaced remainder are not told apart)', () => {
    assert.equal(readOfferCreateEffect(included([consumedCounterOffer]), OWNER, SEQ).effect, 'applied-not-resting');
    assert.equal(readOfferCreateEffect(included([consumedCounterOffer], { tx: { Flags: 0x0002_0000 } }), OWNER, SEQ).effect, 'applied-not-resting', 'IOC: not provably full');
  });

  it('no offer left under Fill-or-Kill: executed-in-full (FoK succeeds only in full)', () => {
    assert.equal(readOfferCreateEffect(included([consumedCounterOffer], { tx: { Flags: 0x0004_0000 } }), OWNER, SEQ).effect, 'executed-in-full');
  });

  it('tecKILLED: killed — nothing placed, nothing crossed; any other tec: transaction-failed (fee consumed)', () => {
    assert.equal(readOfferCreateEffect(included([], { result: 'tecKILLED' }), OWNER, SEQ).effect, 'killed');
    assert.equal(readOfferCreateEffect(included([], { result: 'tecUNFUNDED_OFFER' }), OWNER, SEQ).effect, 'transaction-failed');
  });

  it('inconsistent metadata is unknown: two own offers; an IOC/FoK offer left on the book; amounts that grew; own offer modified; no ledger hash', () => {
    const cases: readonly [Included, string][] = [
      [included([created({ TakerGets: '1000000', TakerPays: USD('5') }), created({ TakerGets: '1', TakerPays: USD('1') })]), 'offer-created-twice'],
      [included([created({ TakerGets: '1000000', TakerPays: USD('5') })], { tx: { Flags: 0x0004_0000 } }), 'immediate-offer-left-on-book'],
      [included([created({ TakerGets: '2000000', TakerPays: USD('5') })]), 'offer-amounts-inconsistent'],
      [included([{ ModifiedNode: { LedgerEntryType: 'Offer', FinalFields: { Account: OWNER, Sequence: SEQ } } }]), 'own-offer-modified-in-creating-transaction'],
      [included([created({ TakerGets: '1000000', TakerPays: USD('5') })], { ledgerHash: null }), 'ledger-hash-unavailable'],
      [included([], { tx: { Flags: -1 } }), 'flags-unreadable'],
    ];
    for (const [evidence, reason] of cases) assert.deepEqual([readOfferCreateEffect(evidence, OWNER, SEQ).effect, readOfferCreateEffect(evidence, OWNER, SEQ).reason], ['unknown', reason], reason);
  });

  it('an offer created by another account or another Sequence is not this order’s offer', () => {
    const foreign = { CreatedNode: { LedgerEntryType: 'Offer', LedgerIndex: 'E'.repeat(64), NewFields: { Account: OTHER, Sequence: SEQ, TakerGets: '1', TakerPays: USD('1') } } };
    assert.equal(readOfferCreateEffect(included([foreign]), OWNER, SEQ).effect, 'applied-not-resting');
  });
});

describe('TRADE-04D §6 — a later validated snapshot is an independent observation', () => {
  const placed = readOfferCreateEffect(included([created({ TakerGets: '1000000', TakerPays: USD('5') })]), OWNER, SEQ);
  const present = (ledgerIndex: number, takerGets: unknown = '1000000'): TradeOfferSnapshot => ({ basis: 'validated-offer-snapshot', state: 'present', ledgerIndex, ledgerHash: LEDGER_HASH, offer: { takerGets, takerPays: USD('5') } });
  const gone = (ledgerIndex: number): TradeOfferSnapshot => ({ basis: 'validated-offer-snapshot', state: 'not-present', ledgerIndex, ledgerHash: LEDGER_HASH });

  it('no snapshot: placed as of inclusion only', () => {
    assert.equal(assessTradeOfferState(placed).interpretation, 'placed-as-of-inclusion');
  });

  it('present later: resting as of that ledger (smaller amounts are reported, never turned into a fill)', () => {
    assert.equal(assessTradeOfferState(placed, present(130)).interpretation, 'resting-as-of-snapshot');
    assert.equal(assessTradeOfferState(placed, present(130, '400000')).interpretation, 'resting-as-of-snapshot');
    assert.equal(assessTradeOfferState(placed, present(130, '9000000')).interpretation, 'state-unknown', 'an offer that grew is not this offer’s history');
  });

  it('not present later: no-longer-present as of that ledger — the cause (filled, cancelled, expired, unfunded) is not inferred', () => {
    const assessment = assessTradeOfferState(placed, gone(130));
    assert.equal(assessment.interpretation, 'no-longer-present-as-of-snapshot');
    assert.equal(/fill|cancel/.test(JSON.stringify(assessment)), false);
  });

  it('a snapshot older than the inclusion proves nothing; absence at the including ledger contradicts the metadata; a present offer for a non-placing transaction contradicts it', () => {
    assert.deepEqual([assessTradeOfferState(placed, gone(100)).interpretation, assessTradeOfferState(placed, gone(100)).reason], ['placed-as-of-inclusion', 'snapshot-precedes-inclusion']);
    assert.equal(assessTradeOfferState(placed, gone(110)).interpretation, 'state-unknown');
    const killed = readOfferCreateEffect(included([], { result: 'tecKILLED' }), OWNER, SEQ);
    assert.equal(assessTradeOfferState(killed, present(130)).interpretation, 'state-unknown');
    assert.equal(assessTradeOfferState(killed, gone(130)).interpretation, 'not-placed');
  });

  it('readTradeOfferSnapshot: bound to a validated ledger; another account’s node or an unavailable read is never "not present"', async () => {
    const bound = { validatedLedger: {} as never, ledgerIndex: 130, ledgerHash: LEDGER_HASH };
    const reader = (answer: unknown) => ({ ledgerEntry: async () => answer as never });
    assert.deepEqual(await readTradeOfferSnapshot(reader({ outcome: 'read', value: { ...bound, entry: { state: 'absent' } } }), OWNER, SEQ), gone(130));
    assert.equal((await readTradeOfferSnapshot(reader({ outcome: 'read', value: { ...bound, entry: { state: 'present', node: { LedgerEntryType: 'Offer', Account: OTHER, Sequence: SEQ } } } }), OWNER, SEQ)).state, 'unavailable');
    assert.deepEqual(await readTradeOfferSnapshot(reader({ outcome: 'unavailable', failure: 'XRPL_READ_NOT_VALIDATED' }), OWNER, SEQ), { basis: 'validated-offer-snapshot', state: 'unavailable', reason: 'XRPL_READ_NOT_VALIDATED' });
    assert.equal((await readTradeOfferSnapshot({ ledgerEntry: async () => Promise.reject(new Error('x')) }, OWNER, SEQ)).state, 'unavailable');
  });
});
