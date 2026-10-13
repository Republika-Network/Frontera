import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRADE_DELEGATION_REFUSAL_CODES, tradeDelegateEntryIndex, verifyTradeDelegation } from '../../../index.js';
import { XRPL_DELEGATION_READ_FAILURES as F, XrplDelegationReaderConfigurationError, createXrplDelegationReader } from '../index.js';
import type { XrplDelegateLedgerEntryRequest, XrplDelegationLedgerPort, XrplDelegationRead } from '../index.js';

/**
 * TRADE-02 — the read-only delegation reader against a fake ledger. No
 * network: the port is a script of `server_info` and `ledger_entry` results,
 * shaped as rippled 3.4.1 returns them.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const OTHER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const INDEX = tradeDelegateEntryIndex(OWNER, DELEGATE) as string;
const LEDGER_HASH = 'D'.repeat(64);
const TXN = 'E'.repeat(64);
const NOW = '2026-10-13T12:00:00.000Z';

const serverInfo = (overrides: Record<string, unknown> = {}, validated: Record<string, unknown> | null = {}): Record<string, unknown> => ({
  info: {
    build_version: '3.4.1',
    network_id: 1,
    server_state: 'full',
    ...(validated === null ? {} : { validated_ledger: { seq: 500, hash: 'F'.repeat(64), age: 2, base_fee_xrp: 0.00001, reserve_base_xrp: 1, reserve_inc_xrp: 0.2, ...validated } }),
    ...overrides,
  },
  status: 'success',
});

const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  Account: OWNER,
  Authorize: DELEGATE,
  Flags: 0,
  LedgerEntryType: 'Delegate',
  OwnerNode: '0',
  Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }],
  PreviousTxnID: TXN,
  PreviousTxnLgrSeq: 480,
  index: INDEX,
  ...overrides,
});

const found = (nodeOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  index: INDEX,
  ledger_hash: LEDGER_HASH,
  ledger_index: 501,
  node: node(nodeOverrides),
  status: 'success',
  validated: true,
  ...overrides,
});

const notFound = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  error: 'entryNotFound',
  ledger_hash: LEDGER_HASH,
  ledger_index: 501,
  status: 'error',
  validated: true,
  ...overrides,
});

interface Script {
  readonly info?: () => unknown;
  readonly entry?: () => unknown;
}

function world(script: Script = {}, clock: () => string = () => NOW) {
  const calls: { method: string; request?: XrplDelegateLedgerEntryRequest }[] = [];
  const port: XrplDelegationLedgerPort = {
    serverInfo: async () => {
      calls.push({ method: 'serverInfo' });
      return (script.info ?? (() => serverInfo()))();
    },
    ledgerEntryDelegate: async (request) => {
      calls.push({ method: 'ledgerEntryDelegate', request });
      return (script.entry ?? (() => found()))();
    },
  };
  const reader = createXrplDelegationReader({ port, network: 'xrp-ledger-testnet', clock, maxValidatedLedgerAgeSeconds: 10 });
  return { reader, calls };
}

const failureOf = (read: XrplDelegationRead): string => (read.outcome === 'unavailable' ? read.failure : `observed:${read.observation.state}`);

async function failure(script: Script, request: { owner: string; delegate: string } = { owner: OWNER, delegate: DELEGATE }): Promise<string> {
  return failureOf(await world(script).reader.observe(request));
}

describe('TRADE-02 reader — what the validated ledger says', () => {
  it('a granted entry becomes a granted observation at the entry’s validated ledger, observed before the ledger was asked', async () => {
    const { reader, calls } = world();
    const read = await reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.equal(read.outcome, 'observed');
    assert.ok(read.outcome === 'observed' && read.observation.state === 'granted');
    assert.deepEqual(read.observation, {
      schema: 'frontera.trade-delegation-observation.v1',
      network: 'xrp-ledger-testnet',
      networkId: 1,
      validatedLedgerIndex: 501,
      validatedLedgerHash: LEDGER_HASH,
      owner: OWNER,
      delegate: DELEGATE,
      entryIndex: INDEX,
      observedAt: NOW,
      state: 'granted',
      permissions: ['OfferCreate'],
      previousTxnId: TXN,
      previousTxnLedgerIndex: 480,
    });
    assert.deepEqual(calls, [
      { method: 'serverInfo' },
      { method: 'ledgerEntryDelegate', request: { delegate: { account: OWNER, authorize: DELEGATE }, ledger_index: 'validated' } },
    ]);
    assert.equal(Object.isFrozen(calls[1]?.request), true);
  });

  it('a validated entryNotFound is the only way to an absent observation', async () => {
    const read = await world({ entry: () => notFound() }).reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.ok(read.outcome === 'observed' && read.observation.state === 'absent');
    assert.equal(read.observation.validatedLedgerIndex, 501);
  });

  it('numeric permission values are canonicalised, and a destination directory hint is accepted', async () => {
    const read = await world({ entry: () => found({ Permissions: [{ Permission: { PermissionValue: 9 } }, { Permission: { PermissionValue: 8 } }], DestinationNode: '1' }) }).reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.ok(read.outcome === 'observed' && read.observation.state === 'granted');
    assert.deepEqual(read.observation.permissions, ['OfferCancel', 'OfferCreate']);
  });

  it('an entry granting more than trading is observed faithfully — and the verifier refuses it', async () => {
    const read = await world({ entry: () => found({ Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }, { Permission: { PermissionValue: 'Payment' } }] }) }).reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.ok(read.outcome === 'observed');
    const verdict = verifyTradeDelegation(read.observation, { network: 'xrp-ledger-testnet', owner: OWNER, delegate: DELEGATE, at: NOW, maxAgeSeconds: 10 });
    assert.deepEqual(verdict, { verified: false, code: TRADE_DELEGATION_REFUSAL_CODES.PERMISSION_EXCESS });
  });

  it('end to end: what the reader observes, the verifier proves', async () => {
    const read = await world().reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.ok(read.outcome === 'observed');
    const verdict = verifyTradeDelegation(read.observation, { network: 'xrp-ledger-testnet', owner: OWNER, delegate: DELEGATE, at: '2026-10-13T12:00:03.000Z', maxAgeSeconds: 10 });
    assert.ok(verdict.verified);
    assert.equal(verdict.evidence.validatedLedgerIndex, 501);
  });

  it('revocation, observed: grant at ledger 501, validated absence at 520 — the later read wins and the earlier grant cannot be replayed past it', async () => {
    const first = await world().reader.observe({ owner: OWNER, delegate: DELEGATE });
    const second = await world({ info: () => serverInfo({}, { seq: 519 }), entry: () => notFound({ ledger_index: 520 }) }).reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.ok(first.outcome === 'observed' && second.outcome === 'observed');
    const requirement = { network: 'xrp-ledger-testnet' as const, owner: OWNER, delegate: DELEGATE, at: NOW, maxAgeSeconds: 10, minimumValidatedLedgerIndex: second.observation.validatedLedgerIndex };
    assert.deepEqual(verifyTradeDelegation(second.observation, requirement), { verified: false, code: TRADE_DELEGATION_REFUSAL_CODES.ABSENT });
    assert.deepEqual(verifyTradeDelegation(first.observation, requirement), { verified: false, code: TRADE_DELEGATION_REFUSAL_CODES.LEDGER_BELOW_MINIMUM });
  });
});

describe('TRADE-02 reader — a failure is never an answer', () => {
  it('an unreachable node (either call) is unavailable, and nothing more is asked after a failed server_info', async () => {
    const { reader, calls } = world({ info: () => { throw new Error('ECONNREFUSED secret-host:51234'); } });
    const read = await reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.deepEqual(read, { outcome: 'unavailable', failure: F.LEDGER_UNREACHABLE });
    assert.equal(JSON.stringify(read).includes('secret-host'), false, 'no transport detail leaks');
    assert.deepEqual(calls.map((call) => call.method), ['serverInfo']);
    assert.equal(await failure({ entry: () => Promise.reject(new Error('timeout')) }), F.LEDGER_UNREACHABLE);
  });

  it('one attempt per read: a failing node is not retried', async () => {
    const { reader, calls } = world({ entry: () => { throw new Error('reset'); } });
    await reader.observe({ owner: OWNER, delegate: DELEGATE });
    assert.deepEqual(calls.map((call) => call.method), ['serverInfo', 'ledgerEntryDelegate']);
  });

  it('server_info: wrong or missing network id, no validated ledger, a lagging ledger, an error, a malformed shape', async () => {
    const cases: readonly [string, () => unknown, string][] = [
      ['devnet node', () => serverInfo({ network_id: 2 }), F.NETWORK_MISMATCH],
      ['mainnet node', () => serverInfo({ network_id: 0 }), F.NETWORK_MISMATCH],
      ['no network id', () => { const result = serverInfo(); delete (result['info'] as Record<string, unknown>)['network_id']; return result; }, F.NETWORK_MISMATCH],
      ['network id as text', () => serverInfo({ network_id: '1' }), F.NETWORK_MISMATCH],
      ['no validated ledger yet', () => serverInfo({}, null), F.NO_VALIDATED_LEDGER],
      ['validated ledger 11 s old', () => serverInfo({}, { age: 11 }), F.VALIDATED_LEDGER_TOO_OLD],
      ['validated ledger without hash', () => serverInfo({}, { hash: undefined }), F.RESPONSE_MALFORMED],
      ['negative age', () => serverInfo({}, { age: -1 }), F.RESPONSE_MALFORMED],
      ['error result', () => ({ error: 'noNetwork', status: 'error' }), F.LEDGER_ERROR],
      ['not an object', () => 'ok', F.RESPONSE_MALFORMED],
      ['info missing', () => ({ status: 'success' }), F.RESPONSE_MALFORMED],
    ];
    for (const [name, info, expected] of cases) assert.equal(await failure({ info }), expected, name);
    assert.equal(await failure({ info: () => serverInfo({}, { age: 10 }) }), 'observed:granted', 'exactly the limit is accepted');
  });

  it('ledger_entry: unvalidated answers, absence without a ledger, other errors, a lagging node', async () => {
    const cases: readonly [string, () => unknown, string][] = [
      ['found but not validated', () => found({}, { validated: false }), F.NOT_VALIDATED],
      ['found, validated missing', () => { const result = found(); delete result['validated']; return result; }, F.NOT_VALIDATED],
      ['not found in an unvalidated ledger', () => notFound({ validated: false }), F.NOT_VALIDATED],
      ['not found without a ledger index', () => { const result = notFound(); delete result['ledger_index']; return result; }, F.RESPONSE_MALFORMED],
      ['not found without a ledger hash', () => { const result = notFound(); delete result['ledger_hash']; return result; }, F.RESPONSE_MALFORMED],
      ['ledger not found', () => notFound({ error: 'lgrNotFound' }), F.LEDGER_ERROR],
      ['malformed request', () => notFound({ error: 'malformedRequest' }), F.LEDGER_ERROR],
      ['entry from an older ledger than server_info reported', () => found({}, { ledger_index: 499 }), F.LEDGER_REGRESSED],
      ['absence from an older ledger', () => notFound({ ledger_index: 499 }), F.LEDGER_REGRESSED],
    ];
    for (const [name, entry, expected] of cases) assert.equal(await failure({ entry }), expected, name);
  });

  it('ledger_entry: an entry for another pair, at another key, or of another type is never accepted', async () => {
    const otherIndex = tradeDelegateEntryIndex(OWNER, OTHER) as string;
    const cases: readonly [string, () => unknown, string][] = [
      ['response index of another pair', () => found({}, { index: otherIndex }), F.ENTRY_MISMATCH],
      ['node index of another pair', () => found({ index: otherIndex }), F.ENTRY_MISMATCH],
      ['other delegate in the node', () => found({ Authorize: OTHER }), F.ENTRY_MISMATCH],
      ['owner and delegate swapped', () => found({ Account: DELEGATE, Authorize: OWNER }), F.ENTRY_MISMATCH],
      ['an Offer entry', () => found({ LedgerEntryType: 'Offer' }), F.RESPONSE_MALFORMED],
      ['non-zero flags', () => found({ Flags: 1 }), F.RESPONSE_MALFORMED],
      ['unknown field', () => found({ Sponsor: OTHER }), F.RESPONSE_MALFORMED],
      ['missing PreviousTxnID', () => found({ PreviousTxnID: undefined }), F.RESPONSE_MALFORMED],
      ['previous transaction after the ledger', () => found({ PreviousTxnLgrSeq: 502 }), F.RESPONSE_MALFORMED],
      ['empty permissions', () => found({ Permissions: [] }), F.RESPONSE_MALFORMED],
      ['eleven permissions', () => found({ Permissions: Array.from({ length: 11 }, (_, index) => ({ Permission: { PermissionValue: 100 + index } })) }), F.RESPONSE_MALFORMED],
      ['duplicate permission (name and number)', () => found({ Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }, { Permission: { PermissionValue: 8 } }] }), F.RESPONSE_MALFORMED],
      ['permission without wrapper', () => found({ Permissions: [{ PermissionValue: 'OfferCreate' }] }), F.RESPONSE_MALFORMED],
      ['permission with an extra field', () => found({ Permissions: [{ Permission: { PermissionValue: 'OfferCreate', Limit: '10' } }] }), F.RESPONSE_MALFORMED],
      ['permission value zero', () => found({ Permissions: [{ Permission: { PermissionValue: 0 } }] }), F.RESPONSE_MALFORMED],
      ['owner node not hex', () => found({ OwnerNode: 'zz' }), F.RESPONSE_MALFORMED],
      ['node missing', () => { const result = found(); delete result['node']; return result; }, F.RESPONSE_MALFORMED],
    ];
    for (const [name, entry, expected] of cases) assert.equal(await failure({ entry }), expected, name);
  });

  it('never runs a getter in a response', async () => {
    let touched = false;
    const trap = (): Record<string, unknown> => {
      const result = found();
      Object.defineProperty(result, 'validated', { enumerable: true, get: () => { touched = true; return true; } });
      return result;
    };
    assert.equal(await failure({ entry: trap }), F.NOT_VALIDATED);
    const infoTrap = (): Record<string, unknown> => {
      const result = serverInfo();
      Object.defineProperty(result['info'] as object, 'network_id', { enumerable: true, get: () => { touched = true; return 1; } });
      return result;
    };
    assert.equal(await failure({ info: infoTrap }), F.NETWORK_MISMATCH);
    assert.equal(touched, false);
  });

  it('refuses a request it cannot key, and an instant it cannot trust, before asking the ledger', async () => {
    for (const request of [{ owner: OWNER, delegate: OWNER }, { owner: 'nope', delegate: DELEGATE }, { owner: OWNER, delegate: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' }]) {
      const { reader, calls } = world();
      assert.equal(failureOf(await reader.observe(request)), F.REQUEST_INVALID);
      assert.deepEqual(calls, []);
    }
    for (const clock of [() => 'now', () => '2026-10-13T12:00:00Z', () => { throw new Error('no clock'); }]) {
      const { reader, calls } = world({}, clock);
      assert.equal(failureOf(await reader.observe({ owner: OWNER, delegate: DELEGATE })), F.CLOCK_INVALID);
      assert.deepEqual(calls, []);
    }
  });
});

describe('TRADE-02 reader — configuration is refused, never defaulted', () => {
  it('requires a two-method port, a TRADE network, a clock and a bounded ledger age', () => {
    const port: XrplDelegationLedgerPort = { serverInfo: async () => serverInfo(), ledgerEntryDelegate: async () => found() };
    const good = { port, network: 'xrp-ledger-testnet' as const, clock: () => NOW, maxValidatedLedgerAgeSeconds: 10 };
    assert.doesNotThrow(() => createXrplDelegationReader(good));
    const bad: readonly Record<string, unknown>[] = [
      { ...good, port: { serverInfo: async () => ({}) } },
      { ...good, network: 'xrp-ledger-mainnet' },
      { ...good, clock: undefined },
      { ...good, maxValidatedLedgerAgeSeconds: 0 },
      { ...good, maxValidatedLedgerAgeSeconds: 61 },
      { ...good, maxValidatedLedgerAgeSeconds: 2.5 },
    ];
    for (const options of bad) assert.throws(() => createXrplDelegationReader(options as never), XrplDelegationReaderConfigurationError);
  });
});
