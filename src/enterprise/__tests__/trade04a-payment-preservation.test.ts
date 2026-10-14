import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as paymentRail from '../../features/payment-runtime/rails/xrpl/index.js';
import { TRADE_NETWORKS } from '../../features/trade-runtime/index.js';
import * as transport from '../../features/xrpl-transport/index.js';

/**
 * TRADE-04A — Payment behavior is unchanged by the extraction
 * (SEC-TRADE04A-12, AC-04).
 *
 * Five PAY-02 / PAY-03 functions now come from the shared transport,
 * re-exported under their original names, and the PAY-03 interlock decides
 * with the shared blocking rule. This file proves the equivalence directly:
 * the pre-extraction implementations are frozen below **verbatim** (from
 * `d04b8b61`), and each is compared with what the Payment rail exports now
 * over edge-case and generated vectors. The Payment barrel's runtime export
 * set is pinned to the baseline's.
 */

// ── Frozen pre-extraction implementations (d04b8b61), verbatim ──

const BASE_TRANSACTION_HASH = /^[0-9A-F]{64}$/;
function baseIsXrplTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && BASE_TRANSACTION_HASH.test(value);
}
const BASE_SIGNING_PUBLIC_KEY = /^(?:ED|0[23])[0-9A-F]{64}$/;
function baseIsXrplSigningPublicKey(value: unknown): value is string {
  return typeof value === 'string' && BASE_SIGNING_PUBLIC_KEY.test(value);
}
const BASE_ENGINE_RESULT = /^(?:tes|tec|tef|tel|tem|ter)[A-Z_]{1,48}$/;
function baseRecordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}
function baseReadSubmission(raw: unknown, hash: string): unknown {
  const result = baseRecordOf(raw);
  const engineResult = result?.['engine_result'];
  if (result === undefined || typeof engineResult !== 'string' || !BASE_ENGINE_RESULT.test(engineResult)) return { kind: 'unreadable' };
  const echoed = baseRecordOf(result['tx_json'])?.['hash'];
  if (echoed !== undefined && echoed !== hash) return { kind: 'unreadable' };
  return engineResult.startsWith('tem') ? { kind: 'malformed', engineResult } : { kind: 'provisional', engineResult };
}
function baseReadLedgerIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}
function baseReadLedgerHeader(raw: unknown): { readonly index: number; readonly closeTime: number } | undefined {
  const header = baseRecordOf(raw);
  const index = baseReadLedgerIndex(header?.['ledger_index']);
  const closeTime = header?.['close_time'];
  if (header?.['validated'] !== true || index === undefined || typeof closeTime !== 'number' || !Number.isSafeInteger(closeTime) || closeTime < 0) return undefined;
  return { index, closeTime };
}
function baseReadNetworkId(raw: unknown): number | undefined {
  const networkId = baseRecordOf(baseRecordOf(raw)?.['info'])?.['network_id'];
  return typeof networkId === 'number' && Number.isSafeInteger(networkId) && networkId >= 0 ? networkId : undefined;
}
/** PAY-03 `openBlocking`, after its SQL window filter `last_ledger_sequence > validatedLedgerIndex`. */
function baseBlocks(record: { readonly state: string; readonly sequence: number; readonly lastLedgerSequence: number }, sequence: number, validatedLedgerIndex: number): boolean {
  return record.lastLedgerSequence > validatedLedgerIndex && record.state !== 'settled' && record.sequence >= sequence;
}

// ── Vectors ──

/** A small deterministic generator: the same vectors on every run. */
function generator(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
const random = generator(0x7_04a);
const HEX = '0123456789ABCDEFabcdefG';
const hexString = (length: number): string => Array.from({ length }, () => HEX[Math.floor(random() * HEX.length)]).join('');

const STRINGS: readonly unknown[] = [
  'A'.repeat(64),
  'a'.repeat(64),
  'A'.repeat(63),
  'A'.repeat(65),
  `ED${'0'.repeat(64)}`,
  `02${'F'.repeat(64)}`,
  `03${'A'.repeat(64)}`,
  `04${'A'.repeat(64)}`,
  `ed${'0'.repeat(64)}`,
  '',
  ' ',
  undefined,
  null,
  0,
  {},
  [],
  ...Array.from({ length: 400 }, () => hexString(64)),
  ...Array.from({ length: 200 }, () => `${['ED', '02', '03', '04', 'ed'][Math.floor(random() * 5)]}${hexString(64)}`),
  ...Array.from({ length: 100 }, () => hexString(Math.floor(random() * 70))),
];

const ENGINE_CODES: readonly unknown[] = ['tesSUCCESS', 'temBAD_FEE', 'temMALFORMED', 'tecUNFUNDED', 'terQUEUED', 'tefPAST_SEQ', 'telCAN_NOT_QUEUE', 'txxFOO', 'tes', 'tesSUCCESS ', 'TESSUCCESS', `tec${'A'.repeat(48)}`, `tec${'A'.repeat(49)}`, 7, undefined, null];
const SUBMIT_ANSWERS: readonly unknown[] = [
  ...ENGINE_CODES.flatMap((code) => [{ engine_result: code }, { engine_result: code, tx_json: { hash: 'A'.repeat(64) } }, { engine_result: code, tx_json: { hash: 'B'.repeat(64) } }, { engine_result: code, tx_json: 'x' }]),
  null,
  undefined,
  [],
  'tesSUCCESS',
  { tx_json: { hash: 'A'.repeat(64) } },
];

const NUMBERS: readonly unknown[] = [1, 0, -1, 2 ** 53 - 1, 2 ** 53, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, 4_294_967_296, ...Array.from({ length: 50 }, () => Math.floor(random() * 1e9) - 1e3)];
const HEADERS: readonly unknown[] = [
  ...NUMBERS.flatMap((index) => [true, false, 'true', undefined].flatMap((validated) => [0, 1, -1, 1.5, '1', 800_000_000].map((close) => ({ ledger_index: index, close_time: close, validated })))),
  null,
  [],
  'header',
];
const SERVER_INFOS: readonly unknown[] = [...NUMBERS.map((id) => ({ info: { network_id: id } })), { info: null }, { info: [] }, {}, null, [], { network_id: 1 }, { info: { network_id: 1, validated_ledger: { seq: 1 } } }];

describe('TRADE-04A — Payment preservation (SEC-TRADE04A-12)', () => {
  it('the Payment rail exports exactly the baseline names, and the extracted ones are the shared functions themselves', () => {
    assert.deepEqual(
      Object.keys(paymentRail)
        .filter((name) => name !== '__esModule' && name !== 'default')
        .sort(),
      [
        // TRADE-04C (G2) added exactly the reserved submission client's four names; every baseline name is unchanged.
        'RIPPLE_EPOCH_UNIX_SECONDS', 'XRPL_DESTINATION_KINDS', 'XRPL_FINALITY_CONTRADICTIONS', 'XRPL_HISTORICAL_MAX_LAST_LEDGER_OFFSET', 'XRPL_INTERLOCK_SETTLEMENTS', 'XRPL_ISSUED_VALUE_LIMITS', 'XRPL_NETWORK_IDS', 'XRPL_RAIL_DETAILS', 'XRPL_RAIL_LIMITS', 'XRPL_RESTART_ANCHOR_SLACK_SECONDS', 'XRPL_RESTART_QUARANTINE_LEDGERS', 'XRPL_RESTART_QUARANTINE_MARGIN', 'XRPL_RLUSD_RAIL_ID', 'XrplRailConfigurationError', 'XrplSubmissionNotAttemptedError', 'buildXrplPayment', 'canonicalDecimalOfLedgerValue', 'createXrplRlusdRail', 'createXrplRlusdRailConfiguration', 'createXrplSdkClient', 'isXrplClassicAddress', 'isXrplCurrencyCode', 'isXrplRlusdRailConfiguration', 'isXrplSigningPublicKey', 'isXrplTransactionHash', 'parseXrplDestination', 'readAutofill', 'readLedgerHeader', 'readLedgerIndex', 'readLookup', 'readNetworkId', 'readSubmission', 'readXrplFinalLedger', 'readXrplPaymentFinality', 'signedByPinnedKey', 'signedPaymentMatches', 'xrplIssuedValueOf',
        'XrplReservedSubmissionRefusedError', 'createXrplReservedSubmissionClient', 'createXrplReservedSubmissionConfiguration', 'xrplSubmissionClaimOf',
      ].sort(),
    );
    assert.equal(paymentRail.isXrplTransactionHash, transport.isXrplTransactionHash);
    assert.equal(paymentRail.isXrplSigningPublicKey, transport.isXrplSigningPublicKey);
    assert.equal(paymentRail.readSubmission, transport.readXrplSubmission);
    assert.equal(paymentRail.readLedgerIndex, transport.readXrplLedgerIndex);
    assert.equal(paymentRail.readLedgerHeader, transport.readXrplLedgerHeader);
    assert.equal(paymentRail.readNetworkId, transport.readXrplNetworkId);
  });

  it('hash and signing-key grammars accept and refuse exactly what they did', () => {
    for (const value of STRINGS) {
      assert.equal(paymentRail.isXrplTransactionHash(value), baseIsXrplTransactionHash(value), String(value));
      assert.equal(paymentRail.isXrplSigningPublicKey(value), baseIsXrplSigningPublicKey(value), String(value));
    }
  });

  it('readSubmission: definitive malformed, provisional and unreadable exactly as before', () => {
    for (const raw of SUBMIT_ANSWERS) assert.deepEqual(paymentRail.readSubmission(raw, 'A'.repeat(64)), baseReadSubmission(raw, 'A'.repeat(64)), JSON.stringify(raw));
  });

  it('readLedgerIndex, readLedgerHeader and readNetworkId answer exactly as before', () => {
    for (const raw of NUMBERS) assert.equal(paymentRail.readLedgerIndex(raw), baseReadLedgerIndex(raw), String(raw));
    for (const raw of HEADERS) assert.deepEqual(paymentRail.readLedgerHeader(raw), baseReadLedgerHeader(raw), JSON.stringify(raw));
    for (const raw of SERVER_INFOS) assert.equal(paymentRail.readNetworkId(raw), baseReadNetworkId(raw), JSON.stringify(raw));
  });

  it('readLookup still classifies every engine result as before (its grammar now comes from the shared transport)', () => {
    const expected = { hash: 'A'.repeat(64), currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '1' };
    for (const code of ENGINE_CODES) {
      const answer = paymentRail.readLookup({ hash: expected.hash, validated: true, meta: { TransactionResult: code, delivered_amount: { currency: 'USD', issuer: expected.issuer, value: '1' } } }, expected);
      const kind =
        typeof code !== 'string' || !BASE_ENGINE_RESULT.test(code) ? 'unreadable' : code === 'tesSUCCESS' ? 'validated-success' : code.startsWith('tec') ? 'validated-failure' : 'validated-unrecognized';
      assert.equal(answer.kind, kind, String(code));
    }
  });

  it('the PAY-03 blocking rule is unchanged: the shared predicate decides exactly as openBlocking did, over every state and boundary', () => {
    let compared = 0;
    for (const state of ['submitting', 'unconfirmed', 'settled']) {
      for (const sequence of [1, 9, 10, 11, 2 ** 32 - 1]) {
        for (const lastLedgerSequence of [1, 99, 100, 101, 120]) {
          for (const candidate of [1, 9, 10, 11, 2 ** 32 - 1]) {
            for (const validated of [1, 99, 100, 101, 119, 120, 121]) {
              const shared = transport.xrplSequenceWindowBlocks({ sequence, lastLedgerSequence, open: state !== 'settled' }, candidate, validated);
              assert.equal(shared, baseBlocks({ state, sequence, lastLedgerSequence }, candidate, validated), JSON.stringify({ state, sequence, lastLedgerSequence, candidate, validated }));
              compared += 1;
            }
          }
        }
      }
    }
    assert.equal(compared, 3 * 5 * 5 * 5 * 7);
  });

  it('one network table: the Payment rail’s and the trade vertical’s network ids agree with the shared identities', () => {
    assert.deepEqual({ ...paymentRail.XRPL_NETWORK_IDS }, { ...transport.XRPL_NETWORK_IDENTITIES });
    for (const [name, { networkId }] of Object.entries(TRADE_NETWORKS)) {
      assert.equal(networkId, transport.XRPL_NETWORK_IDENTITIES[name.replace('xrp-ledger-', '') as 'testnet' | 'devnet'], name);
    }
    assert.equal(Object.values(TRADE_NETWORKS).some(({ networkId }) => (networkId as number) === transport.XRPL_MAINNET_NETWORK_ID), false, 'the trade vertical names no mainnet');
  });
});
