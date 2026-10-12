import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { XRPL_FINALITY_CONTRADICTIONS, readLookup, readXrplPaymentFinality, type XrplExpectedSettlement } from '../index.js';
import { ISSUER, OTHER_SOURCE, RLUSD_CURRENCY_HEX, TREASURY, VENDOR } from './xrpl-test-fixtures.js';

/**
 * PAY-05 — the XRPL settlement-finality reader: validated inclusion with every
 * governed field read from the ledger's own transaction, compared exactly. A
 * hash only locates; the fields prove.
 */

const HASH = 'A'.repeat(64);
const AMOUNT = { currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '25.5' };
const EXPECTED: XrplExpectedSettlement = { hash: HASH, currency: AMOUNT.currency, issuer: AMOUNT.issuer, value: '25.5', account: TREASURY.classicAddress, destination: VENDOR.classicAddress, destinationTag: 4471 };

/** rippled API v2: fields under `tx_json`, instructed amount as `DeliverMax`. */
function v2(overrides: { readonly tx?: Record<string, unknown>; readonly top?: Record<string, unknown>; readonly meta?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    hash: HASH,
    validated: true,
    ledger_index: 8123,
    ledger_hash: 'B'.repeat(64),
    close_time_iso: '2026-10-12T09:30:00Z',
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT }, ...overrides.meta },
    tx_json: { TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, DestinationTag: 4471, DeliverMax: { ...AMOUNT }, Flags: 0, Sequence: 7, Fee: '12', LastLedgerSequence: 8130, ...overrides.tx },
    ...overrides.top,
  };
}

/** rippled API v1: fields at the top level, `Amount`. */
function v1(): Record<string, unknown> {
  return { hash: HASH, validated: true, ledger_index: 8123, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT } }, TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, DestinationTag: 4471, Amount: { ...AMOUNT }, Flags: 0 };
}

describe('PAY-05 XRPL finality reader', () => {
  it('a validated tesSUCCESS Payment with every governed field exact is final (API v2 and v1)', () => {
    assert.deepEqual(readXrplPaymentFinality(v2(), EXPECTED), { kind: 'final', ledgerIndex: 8123, ledgerHash: 'B'.repeat(64) });
    assert.deepEqual(readXrplPaymentFinality(v1(), EXPECTED), { kind: 'final', ledgerIndex: 8123 });
  });

  it('a ledger value in exponent form is compared as the exact decimal', () => {
    assert.equal(readXrplPaymentFinality(v2({ tx: { DeliverMax: { ...AMOUNT, value: '255e-1' } }, meta: { delivered_amount: { ...AMOUNT, value: '2.55e1' } } }), EXPECTED).kind, 'final');
  });

  it('an untagged destination is final only when the transaction carries no tag', () => {
    const { destinationTag: _tag0, ...untagged } = EXPECTED;
    assert.equal(readXrplPaymentFinality(v2(), untagged).kind, 'contradicted', 'a tag the governed destination did not have');
    const { DestinationTag: _tag, ...noTag } = v2().tx_json as Record<string, unknown>;
    assert.equal(readXrplPaymentFinality({ ...v2(), tx_json: noTag }, untagged).kind, 'final');
  });

  for (const [label, raw] of [
    ['another source account (S12)', v2({ tx: { Account: OTHER_SOURCE.classicAddress } })],
    ['another destination (S11)', v2({ tx: { Destination: ISSUER.classicAddress } })],
    ['another destination tag (S11)', v2({ tx: { DestinationTag: 4472 } })],
    ['another instructed amount (S9)', v2({ tx: { DeliverMax: { ...AMOUNT, value: '25.6' } } })],
    ['another currency (S10)', v2({ tx: { DeliverMax: { ...AMOUNT, currency: 'USD' } } })],
    ['another issuer (S10)', v2({ tx: { DeliverMax: { ...AMOUNT, issuer: TREASURY.classicAddress } } })],
    ['a partial-payment flag', v2({ tx: { Flags: 0x00020000 } })],
    ['a non-Payment transaction', v2({ tx: { TransactionType: 'EscrowCreate' } })],
    ['no instructed amount', v2({ tx: { DeliverMax: undefined } })],
  ] as const) {
    it(`${label} contradicts the governed payment`, () => {
      assert.deepEqual(readXrplPaymentFinality(raw, EXPECTED), { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.fieldMismatch });
    });
  }

  it('a validated failure, a different delivered amount (partial delivery) or an unrecognized result contradicts', () => {
    assert.deepEqual(readXrplPaymentFinality(v2({ meta: { TransactionResult: 'tecPATH_DRY', delivered_amount: undefined } }), EXPECTED), { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.validatedFailure });
    assert.deepEqual(readXrplPaymentFinality(v2({ meta: { delivered_amount: { ...AMOUNT, value: '0.01' } } }), EXPECTED), { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.deliveredMismatch });
    assert.deepEqual(readXrplPaymentFinality(v2({ meta: { TransactionResult: 'tefPAST_SEQ' } }), EXPECTED), { kind: 'contradicted', reason: XRPL_FINALITY_CONTRADICTIONS.unrecognizedResult });
  });

  it('not validated, not found, an incomplete search or an unreadable answer is never final — and never negative', () => {
    assert.deepEqual(readXrplPaymentFinality({ hash: HASH, validated: false }, EXPECTED), { kind: 'pending' });
    assert.deepEqual(readXrplPaymentFinality({ error: 'txnNotFound', searched_all: false }, EXPECTED), { kind: 'pending' });
    assert.deepEqual(readXrplPaymentFinality({ error: 'txnNotFound', searched_all: true }, EXPECTED), { kind: 'pending' }, 'absence is not settlement evidence either way');
    for (const raw of [undefined, null, 'tesSUCCESS', { error: 'internal' }, v2({ top: { hash: 'C'.repeat(64) } }), v2({ top: { ledger_index: '8123' } }), v2({ top: { ledger_index: undefined } }), v2({ top: { ledger_hash: 'not-hex' } }), v2({ top: { tx_json: 'blob' } })]) {
      assert.equal(readXrplPaymentFinality(raw, EXPECTED).kind, 'unreadable', JSON.stringify(raw)?.slice(0, 60));
    }
  });

  it('P12 is unchanged: its reader still answers validated-success on the PAY-03 shape (no transaction fields)', () => {
    assert.deepEqual(readLookup({ hash: HASH, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT } } }, EXPECTED), { kind: 'validated-success' });
    assert.equal(readXrplPaymentFinality({ hash: HASH, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT } } }, EXPECTED).kind, 'unreadable', 'what proves execution completion does not prove settlement of this payment');
  });
});
