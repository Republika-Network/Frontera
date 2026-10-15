import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readTradeInclusion, readTradeLedgerEvidence, type TradeLedgerReader, type TradeTransactionIdentity } from '../xrpl-trade-execution/index.js';
import { testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04D §5 — the validated-ledger evidence contract for one trade
 * transaction, over a scripted read-only ledger: every Phase 4 case. Wraps
 * the shared transport's qualified `readXrplInclusion` /
 * `xrplNonInclusionProven`; binds the answer to the interlock row; every
 * mismatch is unresolved, never a closure.
 */

const OWNER = testAccount();
const DELEGATE = testAccount();
const HASH = 'A'.repeat(64);
const LEDGER_HASH = 'B'.repeat(64);
const IDENTITY: TradeTransactionIdentity = { transactionHash: HASH, account: OWNER, delegateAccount: DELEGATE, sequence: 41, lastLedgerSequence: 120, minLedger: 101 };
const OPTIONS = { networkId: 1, requestTimeoutMs: 1_000 };

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ Account: OWNER, Delegate: DELEGATE, TransactionType: 'OfferCreate', Sequence: 41, LastLedgerSequence: 120, Fee: '12', TakerGets: '1000', TakerPays: { currency: 'USD', issuer: DELEGATE, value: '5' }, ...overrides });
const validated = (overrides: Record<string, unknown> = {}, tx: Record<string, unknown> = body()): Record<string, unknown> => ({ hash: HASH, validated: true, ledger_index: 110, ledger_hash: LEDGER_HASH, tx_json: tx, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }, ...overrides });

interface Script {
  readonly network?: number | readonly number[];
  readonly indices?: readonly unknown[];
  readonly lookup?: unknown;
  readonly lookupThrows?: Error;
  readonly connectThrows?: boolean;
}

function ledger(script: Script): TradeLedgerReader & { readonly calls: string[] } {
  const calls: string[] = [];
  const networks = Array.isArray(script.network) ? [...script.network] : [script.network ?? 1];
  const indices = [...(script.indices ?? [125, 125])];
  return {
    calls,
    async connect() {
      calls.push('connect');
      if (script.connectThrows === true) throw new Error('unreachable');
    },
    async serverInfo() {
      calls.push('serverInfo');
      return { info: { network_id: networks.length > 1 ? networks.shift() : networks[0] } };
    },
    async validatedLedgerIndex() {
      calls.push('validatedLedgerIndex');
      return indices.length > 1 ? indices.shift() : indices[0];
    },
    async lookupTransaction(query) {
      calls.push(`lookup:${query.minLedger}-${query.maxLedger}`);
      if (script.lookupThrows !== undefined) throw script.lookupThrows;
      return script.lookup;
    },
  };
}

describe('TRADE-04D §5 — validated inclusion, bound to the row', () => {
  it('validated tesSUCCESS: included, applied; ledger index, hash, body and metadata carried; reads in order: network, index, bounded lookup, index, network', async () => {
    const reader = ledger({ lookup: validated() });
    const evidence = await readTradeLedgerEvidence(reader, IDENTITY, OPTIONS);
    assert.equal(evidence.status, 'included');
    if (evidence.status !== 'included') return;
    assert.equal(evidence.resultClass, 'tesSUCCESS');
    assert.equal(evidence.ledgerIndex, 110);
    assert.equal(evidence.ledgerHash, LEDGER_HASH);
    assert.equal(evidence.transaction['Account'], OWNER);
    assert.ok(Object.isFrozen(evidence.transaction) && Object.isFrozen(evidence.meta));
    assert.deepEqual(reader.calls, ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookup:101-120', 'validatedLedgerIndex', 'serverInfo']);
  });

  it('validated tec…: included with result class tec (fee consumed), never success', async () => {
    const evidence = await readTradeLedgerEvidence(ledger({ lookup: validated({ meta: { TransactionResult: 'tecUNFUNDED_OFFER' } }) }), IDENTITY, OPTIONS);
    assert.equal(evidence.status === 'included' && evidence.resultClass, 'tec');
  });

  it('an API v1 answer (fields at the top level, no ledger_hash) binds too; the hash is then absent, never invented', async () => {
    const { tx_json: _omit, ledger_hash: _alsoOmit, ...rest } = validated();
    const evidence = await readTradeLedgerEvidence(ledger({ lookup: { ...rest, ...body() } }), IDENTITY, OPTIONS);
    assert.equal(evidence.status, 'included');
    assert.equal(evidence.status === 'included' ? evidence.ledgerHash : 'x', undefined);
  });

  const mismatches: readonly [string, unknown, string][] = [
    ['transaction hash mismatch', validated({ hash: 'C'.repeat(64) }), 'transaction-hash-mismatch'],
    ['wrong owner account', validated({}, body({ Account: testAccount() })), 'wrong-account'],
    ['wrong delegate', validated({}, body({ Delegate: testAccount() })), 'wrong-delegate'],
    ['wrong transaction type', validated({}, body({ TransactionType: 'Payment' })), 'wrong-transaction-type'],
    ['another Sequence', validated({}, body({ Sequence: 42 })), 'sequence-mismatch'],
    ['another LastLedgerSequence', validated({}, body({ LastLedgerSequence: 121 })), 'last-ledger-sequence-mismatch'],
    ['included before the window', validated({ ledger_index: 100 }), 'ledger-outside-window'],
    ['included after LastLedgerSequence', validated({ ledger_index: 121 }), 'ledger-outside-window'],
    ['a malformed ledger hash', validated({ ledger_hash: 'not-a-hash' }), 'ledger-hash-malformed'],
    ['a result class no validated ledger holds (tem / tef / ter)', validated({ meta: { TransactionResult: 'temBAD_OFFER' } }), 'result-unrecognized'],
    ['a body missing the fields that bind it', validated({ tx_json: { TransactionType: 'OfferCreate' } }), 'transaction-body-missing'],
  ];
  for (const [name, answer, reason] of mismatches) {
    it(`${name}: unresolved (${reason}), never a closure`, async () => {
      assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookup: answer }), IDENTITY, OPTIONS), { status: 'unresolved', reason, validatedIndexBefore: 125 });
    });
  }

  it('the including ledger beyond the validated index read after the lookup: ledger-index disagreement', async () => {
    const evidence = await readTradeLedgerEvidence(ledger({ indices: [105, 105], lookup: validated({ ledger_index: 110 }) }), IDENTITY, OPTIONS);
    assert.deepEqual(evidence, { status: 'unresolved', reason: 'ledger-index-disagreement', validatedIndexBefore: 105 });
  });

  it('the validated index regressing between the two reads: ledger-index disagreement', async () => {
    const evidence = await readTradeLedgerEvidence(ledger({ indices: [130, 126], lookup: { error: 'txnNotFound', searched_all: true } }), IDENTITY, OPTIONS);
    assert.deepEqual(evidence, { status: 'unresolved', reason: 'ledger-index-disagreement', validatedIndexBefore: 130 });
  });
});

describe('TRADE-04D §7 — non-inclusion only by proof', () => {
  it('complete search, validated index (read FIRST) at or past LastLedgerSequence: proven not included, with the searched range', async () => {
    const evidence = await readTradeLedgerEvidence(ledger({ indices: [120, 121], lookup: { error: 'txnNotFound', searched_all: true } }), IDENTITY, OPTIONS);
    assert.deepEqual(evidence, { status: 'not-included', networkId: 1, transactionHash: HASH, searchedFrom: 101, searchedTo: 120, validatedIndexBefore: 120, validatedIndexAfter: 121 });
  });

  it('complete search while the window is open (validated index before < LastLedgerSequence, even if it reaches it during the lookup): window-open', async () => {
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ indices: [119, 125], lookup: { error: 'txnNotFound', searched_all: true } }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'window-open', validatedIndexBefore: 119 });
  });

  it('incomplete history after LastLedgerSequence (searched_all false): unresolved — never absence', async () => {
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookup: { error: 'txnNotFound', searched_all: false } }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'history-incomplete', validatedIndexBefore: 125 });
  });

  it('found but not validated after LastLedgerSequence: the server contradicts the protocol — unresolved', async () => {
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookup: validated({ validated: false }) }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'transaction-not-validated', validatedIndexBefore: 125 });
  });

  it('entryNotFound or any other server error is never absence', async () => {
    for (const lookup of [{ error: 'entryNotFound' }, { error: 'lgrNotFound' }, { error: 'txnNotFound' }]) {
      const evidence = await readTradeLedgerEvidence(ledger({ lookup }), IDENTITY, OPTIONS);
      assert.equal(evidence.status, 'unresolved', JSON.stringify(lookup));
    }
  });
});

describe('TRADE-04D §5 — unavailable, mismatched or inconsistent observations', () => {
  it('network identity mismatch before the lookup, or a different network after it', async () => {
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ network: 2, lookup: validated() }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'network-mismatch' });
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ network: [1, 2], lookup: validated() }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'network-changed', validatedIndexBefore: 125 });
  });

  it('unreachable ledger; unreadable validated index; a lookup timeout; a failed lookup; an unreadable answer', async () => {
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ connectThrows: true }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'ledger-unavailable' });
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ indices: ['x'], lookup: validated() }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'validated-index-unreadable' });
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookupThrows: Object.assign(new Error('t'), { name: 'TimeoutError' }) }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'read-timeout', validatedIndexBefore: 125 });
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookupThrows: new Error('socket') }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'read-failed', validatedIndexBefore: 125 });
    assert.deepEqual(await readTradeLedgerEvidence(ledger({ lookup: 'garbage' }), IDENTITY, OPTIONS), { status: 'unresolved', reason: 'transaction-unreadable', validatedIndexBefore: 125 });
  });

  it('readTradeInclusion demotes a non-binding validated answer to unreadable, so every existing caller stays conservative', () => {
    const reading = readTradeInclusion(validated({}, body({ Sequence: 99 })), IDENTITY);
    assert.deepEqual(reading, { reading: { kind: 'unreadable' }, problem: 'sequence-mismatch' });
    assert.deepEqual(readTradeInclusion({ error: 'txnNotFound', searched_all: true }, IDENTITY), { reading: { kind: 'not-found-complete' } });
  });
});
