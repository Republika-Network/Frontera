import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRADE_DELEGATION_REQUEST_SCHEMA, tradeDelegateEntryIndex } from '../../../index.js';
import type { TradeDelegationAssessment } from '../../../index.js';
import { XRPL_DELEGATION_READ_FAILURES as F, XrplDelegationReaderConfigurationError, createXrplDelegationVerifier } from '../index.js';
import type { XrplDelegationLedgerPort } from '../index.js';

/**
 * TRADE-02 — the composed verifier (request → read-only observation →
 * assessment) against a fake ledger. No network. The `server_info` and
 * `ledger_entry` shapes are rippled 3.4.1's, as read live from Testnet on
 * 2026-10-13 (absence) and from xrpl.org (the entry). Test names carry the
 * TRADE-02 matrix ids (C, D, E) they cover.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const INDEX = tradeDelegateEntryIndex(OWNER, DELEGATE) as string;
const VALIDATED_HASH = 'F'.repeat(64);
const ENTRY_HASH = 'D'.repeat(64);
const TXN = 'E'.repeat(64);
const NOW = '2026-10-13T12:00:00.000Z';
const DIGEST = `sha256:${'1'.repeat(64)}`;

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: TRADE_DELEGATION_REQUEST_SCHEMA,
  organizationId: 'org-acme',
  proposalDigest: DIGEST,
  network: 'xrp-ledger-testnet',
  ownerAccount: OWNER,
  delegateAccount: DELEGATE,
  permission: 'OfferCreate',
  ...overrides,
});

const serverInfo = (validated: Record<string, unknown> = {}, info: Record<string, unknown> = {}): unknown => ({
  info: { build_version: '3.4.1', network_id: 1, server_state: 'full', validated_ledger: { seq: 500, hash: VALIDATED_HASH, age: 2, base_fee_xrp: 0.00001, reserve_base_xrp: 1, reserve_inc_xrp: 0.2, ...validated }, ...info },
  status: 'success',
});

const found = (node: Record<string, unknown> = {}, result: Record<string, unknown> = {}): unknown => ({
  index: INDEX,
  ledger_hash: ENTRY_HASH,
  ledger_index: 501,
  node: { Account: OWNER, Authorize: DELEGATE, Flags: 0, LedgerEntryType: 'Delegate', OwnerNode: '0', Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }], PreviousTxnID: TXN, PreviousTxnLgrSeq: 480, index: INDEX, ...node },
  status: 'success',
  validated: true,
  ...result,
});

/** The exact live shape of a validated absence (Testnet, rippled 3.4.1), with this pair's key. */
const notFound = (result: Record<string, unknown> = {}): unknown => ({
  error: 'entryNotFound',
  error_code: 98,
  error_message: 'Entry not found.',
  index: INDEX,
  ledger_hash: ENTRY_HASH,
  ledger_index: 501,
  request: { command: 'ledger_entry', delegate: { account: OWNER, authorize: DELEGATE }, ledger_index: 'validated' },
  status: 'error',
  validated: true,
  ...result,
});

interface Script {
  info?: () => unknown;
  entry?: () => unknown;
}

function verifier(script: Script = {}, clock: () => string = () => NOW) {
  const calls: string[] = [];
  const port: XrplDelegationLedgerPort = {
    serverInfo: async () => {
      calls.push('serverInfo');
      return (script.info ?? (() => serverInfo()))();
    },
    ledgerEntryDelegate: async () => {
      calls.push('ledgerEntryDelegate');
      return (script.entry ?? (() => found()))();
    },
  };
  const instance = createXrplDelegationVerifier({ port, network: 'xrp-ledger-testnet', clock, maxValidatedLedgerAgeSeconds: 10, policy: { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 10 } });
  return { verifier: instance, calls };
}

const outcome = (assessment: TradeDelegationAssessment): string => `${assessment.status}/${assessment.reason}${assessment.diagnostic !== undefined ? `/${assessment.diagnostic.readFailure}` : ''}`;

async function run(script: Script, raw: unknown = request()): Promise<string> {
  return outcome(await verifier(script).verifier.verify(raw));
}

const rejects = (error: unknown) => () => Promise.reject(error);

describe('TRADE-02 verifier — direct lookup (D)', () => {
  it('D01 a validated Delegate entry granting OfferCreate → AUTHORIZED, from the entry’s ledger', async () => {
    const { verifier: v, calls } = verifier();
    const assessment = await v.verify(request());
    assert.equal(outcome(assessment), 'AUTHORIZED/DELEGATION_VERIFIED');
    assert.equal(assessment.facts?.validatedLedgerIndex, 501);
    assert.equal(assessment.facts?.validatedLedgerHash, ENTRY_HASH);
    assert.equal(assessment.facts?.entryIndex, INDEX);
    assert.deepEqual(calls, ['serverInfo', 'ledgerEntryDelegate']);
  });

  it('D02 a validated entryNotFound (live shape) → NOT_AUTHORIZED with the validated ledger recorded', async () => {
    const assessment = await verifier({ entry: () => notFound() }).verifier.verify(request());
    assert.equal(outcome(assessment), 'NOT_AUTHORIZED/DELEGATION_ABSENT');
    assert.equal(assessment.facts?.state, 'absent');
    assert.equal(assessment.facts?.validatedLedgerHash, ENTRY_HASH);
  });

  it('D03 an absence naming another key, or an entry at another key, is never taken as this pair’s', async () => {
    assert.equal(await run({ entry: () => notFound({ index: 'A'.repeat(64) }) }), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.ENTRY_MISMATCH}`);
    assert.equal(await run({ entry: () => found({ index: 'A'.repeat(64) }, { index: 'A'.repeat(64) }) }), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.ENTRY_MISMATCH}`);
    assert.equal(await run({ entry: () => found({ Account: DELEGATE, Authorize: OWNER }) }), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.ENTRY_MISMATCH}`, 'inverted pair');
    assert.equal(tradeDelegateEntryIndex(OWNER, 'rNotAnAddress'), undefined);
    assert.equal(tradeDelegateEntryIndex('rrrrrrrrrrrrrrrrrrrrrhoLvTp', DELEGATE), undefined, 'reserved account');
  });

  it('D04 known-answer key: the xrpl.org Delegate example, which Testnet’s own ledger_entry also returned for this pair (2026-10-13)', () => {
    assert.equal(tradeDelegateEntryIndex('rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt', 'r9GAKojMTyexqvy8DXFWYq63Mod5k5wnkT'), '749D3DCDF9F032DDDB8AC49641BACBFDD398C4B6C231C4AB325B7755962329A2');
    assert.notEqual(tradeDelegateEntryIndex('r9GAKojMTyexqvy8DXFWYq63Mod5k5wnkT', 'rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt'), '749D3DCDF9F032DDDB8AC49641BACBFDD398C4B6C231C4AB325B7755962329A2');
  });

  it('A04 numeric permission values (8 = OfferCreate, 9 = OfferCancel; transaction type + 1) are accepted; 7 (OfferCreate’s transaction type) is not', async () => {
    assert.equal(await run({ entry: () => found({ Permissions: [{ Permission: { PermissionValue: 8 } }] }) }), 'AUTHORIZED/DELEGATION_VERIFIED');
    assert.equal(await run({ entry: () => found({ Permissions: [{ Permission: { PermissionValue: 7 } }] }) }), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    assert.equal(await run({ entry: () => found({ Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }, { Permission: { PermissionValue: 8 } }] }) }), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.RESPONSE_MALFORMED}`, 'one permission twice, in two spellings');
  });
});

describe('TRADE-02 verifier — RPC and ledger failures are UNAVAILABLE, never NOT_AUTHORIZED (C)', () => {
  const unavailable = (failure: string): string => `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${failure}`;

  it('C01/C02/C12 timeout, refused connection or an interrupted read', async () => {
    assert.equal(await run({ info: rejects(new Error('timeout')) }), unavailable(F.LEDGER_UNREACHABLE));
    assert.equal(await run({ info: rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) }), unavailable(F.LEDGER_UNREACHABLE));
    assert.equal(await run({ entry: rejects(new Error('socket hang up')) }), unavailable(F.LEDGER_UNREACHABLE));
  });

  it('C03/C10 an RPC error — including an unavailable historical ledger — is not absence', async () => {
    assert.equal(await run({ entry: () => ({ error: 'lgrNotFound', status: 'error', validated: true, ledger_index: 501, ledger_hash: ENTRY_HASH }) }), unavailable(F.LEDGER_ERROR));
    assert.equal(await run({ entry: () => ({ error: 'noNetwork', status: 'error' }) }), unavailable(F.LEDGER_ERROR));
    assert.equal(await run({ info: () => ({ error: 'tooBusy', status: 'error' }) }), unavailable(F.LEDGER_ERROR));
  });

  it('C04/C05 an unparsed, malformed or oversized response', async () => {
    assert.equal(await run({ entry: () => '{"result":' }), unavailable(F.RESPONSE_MALFORMED));
    assert.equal(await run({ info: () => null }), unavailable(F.RESPONSE_MALFORMED));
    const eleven = Array.from({ length: 11 }, () => ({ Permission: { PermissionValue: 'OfferCreate' } }));
    assert.equal(await run({ entry: () => found({ Permissions: eleven }) }), unavailable(F.RESPONSE_MALFORMED));
    assert.equal(await run({ entry: () => found({ Extra: 'x'.repeat(100_000) }) }), unavailable(F.RESPONSE_MALFORMED));
  });

  it('C06/SEC-07 an unvalidated answer, positive or negative', async () => {
    assert.equal(await run({ entry: () => found({}, { validated: false }) }), unavailable(F.NOT_VALIDATED));
    assert.equal(await run({ entry: () => notFound({ validated: false }) }), unavailable(F.NOT_VALIDATED));
    const { validated: _v, ...open } = found() as Record<string, unknown>;
    assert.equal(await run({ entry: () => open }), unavailable(F.NOT_VALIDATED));
  });

  it('C07/SEC-16 missing ledger provenance', async () => {
    const withoutHash = (base: unknown) => () => {
      const { ledger_hash: _h, ...rest } = base as Record<string, unknown>;
      return rest;
    };
    assert.equal(await run({ entry: withoutHash(found()) }), unavailable(F.RESPONSE_MALFORMED));
    assert.equal(await run({ entry: withoutHash(notFound()) }), unavailable(F.RESPONSE_MALFORMED));
    assert.equal(await run({ info: () => serverInfo({ hash: undefined }) }), unavailable(F.RESPONSE_MALFORMED));
    assert.equal(await run({ info: () => ({ info: { network_id: 1 } }) }), unavailable(F.NO_VALIDATED_LEDGER));
  });

  it('C08 two different hashes for one validated ledger index', async () => {
    assert.equal(await run({ entry: () => found({}, { ledger_index: 500, ledger_hash: ENTRY_HASH }) }), unavailable(F.LEDGER_HASH_CONFLICT));
    assert.equal(await run({ entry: () => notFound({ ledger_index: 500, ledger_hash: ENTRY_HASH }) }), unavailable(F.LEDGER_HASH_CONFLICT));
    assert.equal(await run({ entry: () => found({}, { ledger_index: 500, ledger_hash: VALIDATED_HASH }) }), 'AUTHORIZED/DELEGATION_VERIFIED', 'same index, same hash');
  });

  it('C09 the entry from an older ledger than the one server_info validated', async () => {
    assert.equal(await run({ entry: () => found({}, { ledger_index: 499 }) }), unavailable(F.LEDGER_REGRESSED));
    assert.equal(await run({ entry: () => found({ PreviousTxnLgrSeq: 502 }) }), unavailable(F.RESPONSE_MALFORMED), 'changed after the ledger it is read from');
  });

  it('C11/B11 a node behind the freshness bound, or on another network', async () => {
    assert.equal(await run({ info: () => serverInfo({ age: 11 }) }), unavailable(F.VALIDATED_LEDGER_TOO_OLD));
    assert.equal(await run({ info: () => serverInfo({}, { network_id: 0 }) }), unavailable(F.NETWORK_MISMATCH));
    assert.equal(await run({ info: () => serverInfo({}, { network_id: undefined }) }), unavailable(F.NETWORK_MISMATCH));
  });
});

describe('TRADE-02 verifier — the request, the network and the cache', () => {
  it('a rejected request, or one for another network than this reader’s, never reaches the ledger', async () => {
    const rejected = verifier();
    assert.equal(outcome(await rejected.verifier.verify(request({ delegationVerified: true }))), 'UNAVAILABLE/DELEGATION_REQUEST_REJECTED');
    assert.equal(outcome(await rejected.verifier.verify(request({ endpoint: 'https://attacker.example' }))), 'UNAVAILABLE/DELEGATION_REQUEST_REJECTED');
    assert.deepEqual(rejected.calls, []);
    const devnet = verifier();
    assert.equal(outcome(await devnet.verifier.verify(request({ network: 'xrp-ledger-devnet' }))), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.NETWORK_MISMATCH}`);
    assert.deepEqual(devnet.calls, []);
  });

  it('E01–E03/E05/SEC-15 every verify reads the ledger again: grant, then revocation, then outage — no earlier answer survives', async () => {
    let state: 'granted' | 'reduced' | 'deleted' | 'down' = 'granted';
    const { verifier: v, calls } = verifier({
      info: () => (state === 'down' ? Promise.reject(new Error('down')) : serverInfo()),
      entry: () => (state === 'granted' ? found() : state === 'reduced' ? found({ Permissions: [{ Permission: { PermissionValue: 'OfferCancel' } }] }) : notFound()),
    });
    assert.equal((await v.verify(request())).status, 'AUTHORIZED');
    state = 'reduced';
    assert.equal(outcome(await v.verify(request())), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    state = 'deleted';
    assert.equal(outcome(await v.verify(request())), 'NOT_AUTHORIZED/DELEGATION_ABSENT');
    state = 'granted';
    assert.equal((await v.verify(request())).status, 'AUTHORIZED');
    state = 'down';
    assert.equal(outcome(await v.verify(request())), `UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE/${F.LEDGER_UNREACHABLE}`);
    assert.equal(calls.length, 9, 'four full reads and one failed server_info: nothing answered from memory');
  });

  it('E04/E08 a slow read that outlives the policy bound is UNAVAILABLE; a clock stepping backwards fails closed', async () => {
    const instants = ['2026-10-13T12:00:00.000Z', '2026-10-13T12:00:10.001Z'];
    assert.equal(outcome(await verifier({}, () => instants.shift() as string).verifier.verify(request())), 'UNAVAILABLE/DELEGATION_OBSERVATION_STALE');
    const stepped = ['2026-10-13T12:00:00.000Z', '2026-10-13T11:59:59.990Z'];
    assert.equal(outcome(await verifier({}, () => stepped.shift() as string).verifier.verify(request())), 'UNAVAILABLE/DELEGATION_OBSERVATION_FROM_FUTURE');
    let calls = 0;
    const failing = () => {
      calls += 1;
      if (calls > 1) throw new Error('clock');
      return NOW;
    };
    assert.equal(outcome(await verifier({}, failing).verifier.verify(request())), 'UNAVAILABLE/DELEGATION_CONTEXT_INVALID');
  });

  it('configuration is trusted and refused, never defaulted: policy, port, network and bounds', () => {
    const port: XrplDelegationLedgerPort = { serverInfo: async () => serverInfo(), ledgerEntryDelegate: async () => found() };
    const base = { port, network: 'xrp-ledger-testnet' as const, clock: () => NOW, maxValidatedLedgerAgeSeconds: 10, policy: { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 10 } };
    for (const options of [
      { ...base, policy: undefined },
      { ...base, policy: { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 120 } },
      { ...base, policy: { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 10, endpoint: 'https://x' } },
      { ...base, network: 'xrp-ledger-mainnet' },
      { ...base, maxValidatedLedgerAgeSeconds: 0 },
      { ...base, port: { serverInfo: async () => serverInfo() } },
    ]) {
      assert.throws(() => createXrplDelegationVerifier(options as never), XrplDelegationReaderConfigurationError);
    }
  });
});
