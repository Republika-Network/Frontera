import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tradeDelegateEntryIndex } from '../../features/trade-runtime/index.js';
import { createXrplDelegationReader, type XrplDelegationLedgerPort } from '../../features/trade-runtime/rails/xrpl/index.js';
import { XRPL_VALIDATED_READ_FAILURES as F, createXrplValidatedLedgerReader, type XrplValidatedLedgerReadPort } from '../../features/xrpl-transport/index.js';

/**
 * TRADE-04A — the TRADE-02 delegation reader can stand on the shared
 * transport's read port, without importing the Payment vertical (AC-05,
 * AC-16; ADR-XRPL-SHARED-TRANSPORT §5 answer 6).
 *
 * TRADE-02's `XrplDelegationLedgerPort` and the transport's
 * `XrplValidatedLedgerReadPort` are both raw-answer ports, and TRADE-02's one
 * entry request is a member of the transport's closed selector — so one
 * adapter, two lines, satisfies TRADE-02 from the transport port (checked by
 * the compiler below). Both readers then agree: the same validated evidence
 * is accepted, and the same wrong-network and unvalidated answers refused.
 *
 * This is a composition **shape**, proven against a fake. No production read
 * port exists; composing one is TRADE-04B/C's reviewed edge.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const INDEX = tradeDelegateEntryIndex(OWNER, DELEGATE) as string;
const NOW = '2026-10-13T12:00:00.000Z';

function transportPort(script: { info?: () => unknown; entry?: () => unknown } = {}): XrplValidatedLedgerReadPort & { readonly asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    serverInfo: async () => (script.info ?? (() => ({ info: { network_id: 1, validated_ledger: { seq: 500, hash: 'F'.repeat(64), age: 2 } } })))(),
    ledgerHeader: async () => {
      throw new Error('not used');
    },
    ledgerEntry: async (request) => {
      asked.push(request);
      return (
        script.entry ??
        (() => ({
          index: INDEX,
          ledger_hash: 'D'.repeat(64),
          ledger_index: 501,
          validated: true,
          node: { Account: OWNER, Authorize: DELEGATE, Flags: 0, LedgerEntryType: 'Delegate', OwnerNode: '0', Permissions: [{ Permission: { PermissionValue: 'OfferCreate' } }], PreviousTxnID: 'E'.repeat(64), PreviousTxnLgrSeq: 480, index: INDEX },
        }))
      )();
    },
  };
}

/** The whole adapter: TRADE-02's port, from the transport's port. Type-checked: TRADE-02's request is a transport selector request. */
const delegationPortOf = (port: XrplValidatedLedgerReadPort): XrplDelegationLedgerPort => ({
  serverInfo: () => port.serverInfo(),
  ledgerEntryDelegate: (request) => port.ledgerEntry(request),
});

function readers(port: XrplValidatedLedgerReadPort) {
  return {
    trade02: createXrplDelegationReader({ port: delegationPortOf(port), network: 'xrp-ledger-testnet', clock: () => NOW, maxValidatedLedgerAgeSeconds: 10 }),
    transport: createXrplValidatedLedgerReader({ port, networkId: 1, maxValidatedLedgerAgeSeconds: 10, requestTimeoutMs: 1_000, maxResponseBytes: 65_536, timer: { set: () => undefined, clear: () => undefined } }),
  };
}

describe('TRADE-04A — TRADE-02 over the shared read port', () => {
  it('both readers accept the same validated Delegate entry, asked with the same validated request', async () => {
    const port = transportPort();
    const { trade02, transport } = readers(port);
    const observed = await trade02.observe({ owner: OWNER, delegate: DELEGATE });
    assert.equal(observed.outcome, 'observed');
    const read = await transport.ledgerEntry({ delegate: { account: OWNER, authorize: DELEGATE } });
    assert.equal(read.outcome, 'read');
    assert.deepEqual(port.asked[0], port.asked[1], 'one request shape for both');
    assert.deepEqual(port.asked[0], { delegate: { account: OWNER, authorize: DELEGATE }, ledger_index: 'validated' });
  });

  it('both refuse a server on another network, before the entry is asked', async () => {
    const port = transportPort({ info: () => ({ info: { network_id: 2, validated_ledger: { seq: 500, hash: 'F'.repeat(64), age: 2 } } }) });
    const { trade02, transport } = readers(port);
    assert.deepEqual(await trade02.observe({ owner: OWNER, delegate: DELEGATE }), { outcome: 'unavailable', failure: 'DELEGATION_READ_NETWORK_MISMATCH' });
    assert.deepEqual(await transport.ledgerEntry({ delegate: { account: OWNER, authorize: DELEGATE } }), { outcome: 'unavailable', failure: F.NETWORK_MISMATCH });
    assert.deepEqual(port.asked, []);
  });

  it('both refuse an unvalidated entry, and both refuse an answer from behind the reported validated ledger', async () => {
    for (const [entry, trade02Failure, transportFailure] of [
      [{ index: INDEX, ledger_hash: 'D'.repeat(64), ledger_index: 501, validated: false, node: {} }, 'DELEGATION_READ_NOT_VALIDATED', F.NOT_VALIDATED],
      [{ error: 'entryNotFound', index: INDEX, ledger_hash: 'D'.repeat(64), ledger_index: 499, validated: true }, 'DELEGATION_READ_LEDGER_REGRESSED', F.LEDGER_REGRESSED],
    ] as const) {
      const { trade02, transport } = readers(transportPort({ entry: () => entry }));
      assert.deepEqual(await trade02.observe({ owner: OWNER, delegate: DELEGATE }), { outcome: 'unavailable', failure: trade02Failure });
      assert.deepEqual(await transport.ledgerEntry({ delegate: { account: OWNER, authorize: DELEGATE } }), { outcome: 'unavailable', failure: transportFailure });
    }
  });
});
