import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  XRPL_NETWORK_IDENTITIES,
  XRPL_VALIDATED_READ_FAILURES as F,
  XrplSequenceOwnershipError,
  XrplValidatedReaderConfigurationError,
  assertXrplSequenceOwnership,
  checkXrplNetworkIdentity,
  createXrplValidatedLedgerReader,
  isPermittedXrplNetworkId,
  isXrplEngineResult,
  isXrplLedgerHash,
  isXrplLedgerIndex,
  isXrplSigningPublicKey,
  isXrplTransactionHash,
  readXrplInclusion,
  readXrplLedgerHeader,
  readXrplServerValidatedLedger,
  readXrplSubmission,
  readXrplValidatedLedgerHeader,
  xrplNonInclusionProven,
  xrplSequenceWindowBlocks,
  xrplWindowClosed,
  type XrplReadTimer,
  type XrplValidatedLedgerEntryRequest,
  type XrplValidatedLedgerReadPort,
  type XrplValidatedLedgerReaderOptions,
} from '../index.js';

/**
 * TRADE-04A — the shared XRPL transport's contracts, qualified against
 * deterministic fakes (no network): network identity, validated-ledger
 * evidence, the bounded read-only reader, transaction-neutral submission and
 * inclusion reading, and owner-account `Sequence` safety.
 *
 * Matrix rows (`docs/integrations/trade/TRADE-04A-SHARED-XRPL-TRANSPORT.md`
 * §18) are named in each test: A = network identity, B = shared transport,
 * C = sequence safety, E = security.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const OTHER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const HASH_A = 'A'.repeat(64);
const HASH_B = 'B'.repeat(64);
const NODE_KEY = 'n9KorY8QtTdRx7TVDpwnG9NvyxsDwHUKUEeDLY3AkiGncVaSXZi5';
const TEST_NETWORK = XRPL_NETWORK_IDENTITIES.testnet;

function serverInfo(overrides: { networkId?: unknown; seq?: unknown; hash?: unknown; age?: unknown; pubkey?: string; validated?: boolean } = {}): unknown {
  const info: Record<string, unknown> = {};
  if (overrides.networkId !== null) info['network_id'] = overrides.networkId ?? TEST_NETWORK;
  if (overrides.validated !== false) info['validated_ledger'] = { seq: overrides.seq ?? 1_000, hash: overrides.hash ?? HASH_A, age: overrides.age ?? 2 };
  if (overrides.pubkey !== undefined) info['pubkey_node'] = overrides.pubkey;
  return { info };
}

/** A timer that never fires unless told to: every request completes before its bound. */
const idleTimer: XrplReadTimer = { set: () => undefined, clear: () => undefined };
/** A timer whose bound elapses immediately. */
const expiringTimer: XrplReadTimer = {
  set: (callback) => {
    queueMicrotask(callback);
    return undefined;
  },
  clear: () => undefined,
};

interface FakePort extends XrplValidatedLedgerReadPort {
  readonly calls: string[];
  info: () => unknown;
  header: (index: number) => unknown;
  entry: (request: XrplValidatedLedgerEntryRequest) => unknown;
}

function fakePort(): FakePort {
  const port: FakePort = {
    calls: [],
    info: () => serverInfo(),
    header: (index) => ({ ledger_index: index, ledger_hash: HASH_A, close_time: 800_000_000, validated: true }),
    entry: () => ({ ledger_index: 1_000, ledger_hash: HASH_A, validated: true, node: { LedgerEntryType: 'Delegate' }, index: HASH_B }),
    async serverInfo() {
      port.calls.push('serverInfo');
      return port.info();
    },
    async ledgerHeader(index) {
      port.calls.push('ledgerHeader');
      return port.header(index);
    },
    async ledgerEntry(request) {
      port.calls.push('ledgerEntry');
      return port.entry(request);
    },
  };
  return port;
}

function reader(port: XrplValidatedLedgerReadPort, overrides: Partial<XrplValidatedLedgerReaderOptions> = {}) {
  return createXrplValidatedLedgerReader({ port, networkId: TEST_NETWORK, maxValidatedLedgerAgeSeconds: 10, requestTimeoutMs: 1_000, maxResponseBytes: 65_536, timer: idleTimer, ...overrides });
}

const failureOf = (read: { readonly outcome: string }): string | undefined => (read as { failure?: string }).failure;

describe('TRADE-04A grammar — closed, transaction-neutral', () => {
  it('hashes, ledger indexes, signing keys and engine results', () => {
    assert.equal(isXrplTransactionHash(HASH_A), true);
    for (const bad of ['a'.repeat(64), 'A'.repeat(63), 'A'.repeat(65), `${'A'.repeat(63)}G`, 1, undefined]) assert.equal(isXrplTransactionHash(bad), false, String(bad));
    assert.equal(isXrplLedgerHash(HASH_B), true);
    assert.equal(isXrplLedgerIndex(1), true);
    assert.equal(isXrplLedgerIndex(4_294_967_295), true);
    for (const bad of [0, -1, 1.5, 4_294_967_296, '7', Number.NaN]) assert.equal(isXrplLedgerIndex(bad), false, String(bad));
    assert.equal(isXrplSigningPublicKey(`ED${'0'.repeat(64)}`), true);
    assert.equal(isXrplSigningPublicKey(`02${'F'.repeat(64)}`), true);
    for (const bad of [`04${'0'.repeat(64)}`, `ed${'0'.repeat(64)}`, `ED${'0'.repeat(63)}`]) assert.equal(isXrplSigningPublicKey(bad), false, bad);
    for (const good of ['tesSUCCESS', 'tecUNFUNDED_OFFER', 'terNO_DELEGATE_PERMISSION', 'telCAN_NOT_QUEUE', 'temBAD_SIGNER', 'tefPAST_SEQ']) assert.equal(isXrplEngineResult(good), true, good);
    for (const bad of ['tesSUCCESS ', 'txxFOO', 'tes', 'TESSUCCESS']) assert.equal(isXrplEngineResult(bad), false, bad);
  });
});

describe('TRADE-04A network identity (matrix A; SEC-TRADE04A-06, -15)', () => {
  it('A1 correct Testnet: the stated network is the expected one', () => {
    assert.deepEqual(checkXrplNetworkIdentity(serverInfo(), TEST_NETWORK), { ok: true, networkId: TEST_NETWORK });
  });

  it('A2 wrong network id: Devnet or Mainnet answering for Testnet is refused, never evidence', () => {
    assert.deepEqual(checkXrplNetworkIdentity(serverInfo({ networkId: 2 }), TEST_NETWORK), { ok: false, failure: 'NETWORK_MISMATCH' });
    assert.deepEqual(checkXrplNetworkIdentity(serverInfo({ networkId: 0 }), TEST_NETWORK), { ok: false, failure: 'NETWORK_MISMATCH' });
  });

  it('A4 missing network identity: a server that does not state its network is not the network asked about', () => {
    for (const raw of [serverInfo({ networkId: null }), serverInfo({ networkId: '1' }), serverInfo({ networkId: -1 }), {}, null, 'testnet']) {
      assert.deepEqual(checkXrplNetworkIdentity(raw, TEST_NETWORK), { ok: false, failure: 'NETWORK_UNSTATED' }, JSON.stringify(raw));
    }
  });

  it('mainnet is never a default: it is permitted only with an explicit allowMainnet', () => {
    assert.equal(isPermittedXrplNetworkId(0, false), false);
    assert.equal(isPermittedXrplNetworkId(0, true), true);
    assert.equal(isPermittedXrplNetworkId(1, false), true);
    assert.equal(isPermittedXrplNetworkId(7, true), false, 'an unknown network is never permitted');
    assert.throws(() => reader(fakePort(), { networkId: 0 }), XrplValidatedReaderConfigurationError);
    assert.doesNotThrow(() => reader(fakePort(), { networkId: 0, allowMainnet: true }));
  });
});

describe('TRADE-04A validated-ledger evidence (matrix A; SEC-TRADE04A-07)', () => {
  const expected = { networkId: TEST_NETWORK, maxAgeSeconds: 10 };

  it('A1: server_info → the validated ledger, its index, hash and age', () => {
    assert.deepEqual(readXrplServerValidatedLedger(serverInfo(), expected), { networkId: TEST_NETWORK, ledgerIndex: 1_000, ledgerHash: HASH_A, ageSeconds: 2 });
  });

  it('A5 stale validated ledger: older than the bound is refused', () => {
    assert.equal(readXrplServerValidatedLedger(serverInfo({ age: 11 }), expected), F.VALIDATED_LEDGER_TOO_OLD);
  });

  it('A6 unvalidated: no validated ledger, or an unvalidated header, never satisfies a validated read', () => {
    assert.equal(readXrplServerValidatedLedger(serverInfo({ validated: false }), expected), F.NO_VALIDATED_LEDGER);
    assert.equal(readXrplValidatedLedgerHeader({ ledger_index: 5, ledger_hash: HASH_A, close_time: 1, validated: false }, 5), F.NOT_VALIDATED);
    assert.equal(readXrplValidatedLedgerHeader({ ledger_index: 5, ledger_hash: HASH_A, close_time: 1 }, 5), F.NOT_VALIDATED);
    assert.equal(readXrplLedgerHeader({ ledger_index: 5, close_time: 1, validated: 'true' }), undefined);
  });

  it('the network is checked before anything else the server says, and a pinned node identity must match', () => {
    assert.equal(readXrplServerValidatedLedger(serverInfo({ networkId: 2, age: 999 }), expected), F.NETWORK_MISMATCH);
    assert.equal(readXrplServerValidatedLedger(serverInfo({ pubkey: NODE_KEY }), { ...expected, nodePublicKey: NODE_KEY }) !== F.NODE_IDENTITY_MISMATCH, true);
    assert.equal(readXrplServerValidatedLedger(serverInfo(), { ...expected, nodePublicKey: NODE_KEY }), F.NODE_IDENTITY_MISMATCH);
  });

  it('a malformed or getter-carrying answer is malformed, never partly believed', () => {
    for (const raw of [serverInfo({ seq: 0 }), serverInfo({ hash: 'a'.repeat(64) }), serverInfo({ age: -1 }), serverInfo({ seq: '1000' }), { info: [] }, []]) {
      assert.equal(readXrplServerValidatedLedger(raw, expected), F.RESPONSE_MALFORMED, JSON.stringify(raw));
    }
    const getter = { info: { network_id: TEST_NETWORK, get validated_ledger() { return { seq: 1, hash: HASH_A, age: 0 }; } } };
    assert.equal(readXrplServerValidatedLedger(getter, expected), F.NO_VALIDATED_LEDGER);
    assert.equal(readXrplServerValidatedLedger({ error: 'noNetwork' }, expected), F.LEDGER_ERROR);
  });
});

describe('TRADE-04A validated reader (matrix A, B; SEC-TRADE04A-06, -07, -15)', () => {
  it('B1 read-only: the port has three read requests, and an entry is asked at the validated ledger only', async () => {
    const port = fakePort();
    let asked: XrplValidatedLedgerEntryRequest | undefined;
    port.entry = (request) => {
      asked = request;
      return { ledger_index: 1_000, ledger_hash: HASH_A, validated: true, node: { LedgerEntryType: 'Delegate' } };
    };
    const read = await reader(port).ledgerEntry({ delegate: { account: OWNER, authorize: DELEGATE } });
    assert.equal(read.outcome, 'read');
    assert.deepEqual(asked, { delegate: { account: OWNER, authorize: DELEGATE }, ledger_index: 'validated' });
    assert.deepEqual(port.calls, ['serverInfo', 'ledgerEntry'], 'network identity first, then one entry request');
  });

  it('A1: a validated entry, and a validated absence, are bound to the reported validated ledger', async () => {
    const port = fakePort();
    const present = await reader(port).ledgerEntry({ offer: { account: OWNER, seq: 7 } });
    assert.equal(present.outcome, 'read');
    if (present.outcome === 'read') assert.equal(present.value.entry.state, 'present');
    port.entry = () => ({ error: 'entryNotFound', ledger_index: 1_001, ledger_hash: HASH_B, validated: true });
    const absent = await reader(port).ledgerEntry({ account_root: OWNER });
    assert.equal(absent.outcome, 'read');
    if (absent.outcome === 'read') assert.deepEqual([absent.value.entry, absent.value.ledgerIndex], [{ state: 'absent' }, 1_001]);
  });

  it('A6: an unvalidated entry or unvalidated absence is NOT_VALIDATED — never "absent", never "present"', async () => {
    const port = fakePort();
    port.entry = () => ({ ledger_index: 1_000, ledger_hash: HASH_A, node: {} });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.NOT_VALIDATED);
    port.entry = () => ({ error: 'entryNotFound', ledger_current_index: 1_002, validated: false });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.NOT_VALIDATED);
  });

  it('A2/A3: a wrong network or a wrong pinned node is refused before the entry is asked', async () => {
    const port = fakePort();
    port.info = () => serverInfo({ networkId: 2 });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.NETWORK_MISMATCH);
    assert.deepEqual(port.calls, ['serverInfo'], 'the entry is never asked of the wrong network');
    const pinned = fakePort();
    pinned.info = () => serverInfo({ pubkey: 'n94Ffx3bS3GbRGeuCoBo3wZjADVmRWSHBjwqSTbqPq5nbQqHYULF' });
    assert.equal(failureOf(await reader(pinned, { nodePublicKey: NODE_KEY }).validatedLedger()), F.NODE_IDENTITY_MISMATCH);
  });

  it('B7 reconnection constraints: every read re-proves the network, so a reconnect to another network or a lagging node is refused', async () => {
    const port = fakePort();
    const r = reader(port);
    assert.equal((await r.validatedLedger()).outcome, 'read');
    port.info = () => serverInfo({ networkId: 0 });
    assert.equal(failureOf(await r.validatedLedger()), F.NETWORK_MISMATCH, 'the same reader, after a silent reconnect to mainnet');
    port.info = () => serverInfo({ seq: 990 });
    assert.equal(failureOf(await r.validatedLedger()), F.LEDGER_REGRESSED, 'a node behind what this reader already proved');
    port.info = () => serverInfo({ seq: 1_005, hash: HASH_B });
    assert.equal((await r.validatedLedger()).outcome, 'read');
  });

  it('E forged ledger state: an entry behind the reported validated ledger, or a second hash for one index, is refused', async () => {
    const port = fakePort();
    port.entry = () => ({ ledger_index: 999, ledger_hash: HASH_A, validated: true, node: {} });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.LEDGER_REGRESSED);
    port.entry = () => ({ ledger_index: 1_000, ledger_hash: HASH_B, validated: true, node: {} });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.LEDGER_HASH_CONFLICT);
    port.header = (index) => ({ ledger_index: index, ledger_hash: HASH_B, close_time: 1, validated: true });
    assert.equal(failureOf(await reader(port).ledgerHeader(1_000)), F.LEDGER_HASH_CONFLICT);
  });

  it('A6: a header the network has not validated yet is never asked for, and one for another index is malformed', async () => {
    const port = fakePort();
    assert.equal(failureOf(await reader(port).ledgerHeader(1_001)), F.NOT_VALIDATED);
    assert.deepEqual(port.calls, ['serverInfo']);
    port.header = () => ({ ledger_index: 900, ledger_hash: HASH_A, close_time: 1, validated: true });
    assert.equal(failureOf(await reader(port).ledgerHeader(901)), F.RESPONSE_MALFORMED);
    port.header = (index) => ({ ledger_index: index, ledger_hash: HASH_B, close_time: 1, validated: true });
    const header = await reader(port).ledgerHeader(900);
    assert.deepEqual(header, { outcome: 'read', value: { ledgerIndex: 900, ledgerHash: HASH_B, closeTime: 1 } });
  });

  it('B2 disconnected client: a rejected or throwing port is LEDGER_UNREACHABLE, and nothing of its error crosses the reader', async () => {
    const secret = 'wss://user:FRONTERA_SECRET_TOKEN@node.example';
    const port = fakePort();
    port.serverInfo = async () => {
      throw new Error(`NotConnectedError ${secret}`);
    };
    const read = await reader(port).validatedLedger();
    assert.deepEqual(read, { outcome: 'unavailable', failure: F.LEDGER_UNREACHABLE });
    assert.equal(JSON.stringify(read).includes('SECRET'), false);
    const syncThrow = fakePort();
    syncThrow.serverInfo = () => {
      throw new Error(secret);
    };
    assert.deepEqual(await reader(syncThrow).validatedLedger(), { outcome: 'unavailable', failure: F.LEDGER_UNREACHABLE });
  });

  it('B3 timeout: an answer that does not arrive within the bound is TIMEOUT, once — no retry', async () => {
    const port = fakePort();
    port.serverInfo = () => {
      port.calls.push('serverInfo');
      return new Promise(() => {});
    };
    assert.deepEqual(await reader(port, { timer: expiringTimer }).validatedLedger(), { outcome: 'unavailable', failure: F.TIMEOUT });
    assert.deepEqual(port.calls, ['serverInfo'], 'one attempt');
  });

  it('B4 malformed and B5 excessive responses are refused', async () => {
    const port = fakePort();
    port.info = () => 'not an object';
    assert.equal(failureOf(await reader(port).validatedLedger()), F.RESPONSE_MALFORMED);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    port.info = () => circular;
    assert.equal(failureOf(await reader(port).validatedLedger()), F.RESPONSE_MALFORMED);
    port.info = () => ({ ...(serverInfo() as object), padding: 'x'.repeat(2_000) });
    assert.equal(failureOf(await reader(port, { maxResponseBytes: 1_024 }).validatedLedger()), F.RESPONSE_TOO_LARGE);
    port.info = () => serverInfo();
    port.entry = () => ({ ledger_index: 1_000, ledger_hash: HASH_A, validated: true, node: 'flat' });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.RESPONSE_MALFORMED);
    port.entry = () => ({ error: 'invalidParams', validated: true, ledger_index: 1_000, ledger_hash: HASH_A });
    assert.equal(failureOf(await reader(port).ledgerEntry({ account_root: OWNER })), F.LEDGER_ERROR);
  });

  it('E out-of-scope requests: the selector is closed — an unknown object kind, an extra key or a malformed address is never asked', async () => {
    const port = fakePort();
    const r = reader(port);
    for (const selector of [
      { ripple_state: { accounts: [OWNER, OTHER], currency: 'USD' } },
      { account_root: OWNER, offer: { account: OWNER, seq: 1 } },
      { delegate: { account: OWNER, authorize: OWNER } },
      { delegate: { account: OWNER, authorize: DELEGATE, extra: 1 } },
      { offer: { account: OWNER, seq: 0 } },
      { account_root: 'not-an-address' },
      { account_root: OWNER, ledger_index: 'current' },
    ]) {
      assert.equal(failureOf(await r.ledgerEntry(selector as never)), F.READER_INVALID, JSON.stringify(selector));
    }
    assert.equal(failureOf(await r.ledgerHeader(0)), F.READER_INVALID);
    assert.deepEqual(port.calls, [], 'nothing was asked');
  });

  it('configuration is closed: bounds, port shape and timer are checked at creation', () => {
    const port = fakePort();
    for (const overrides of [{ maxValidatedLedgerAgeSeconds: 0 }, { maxValidatedLedgerAgeSeconds: 61 }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 60_001 }, { maxResponseBytes: 1_023 }, { maxResponseBytes: 1_048_577 }, { nodePublicKey: 'x' }, { networkId: 99 }, { allowMainnet: 'yes' as never }]) {
      assert.throws(() => reader(port, overrides as Partial<XrplValidatedLedgerReaderOptions>), XrplValidatedReaderConfigurationError, JSON.stringify(overrides));
    }
    assert.throws(() => createXrplValidatedLedgerReader({ port: { serverInfo: port.serverInfo } as never, networkId: TEST_NETWORK, maxValidatedLedgerAgeSeconds: 10, requestTimeoutMs: 10, maxResponseBytes: 2_048 }), XrplValidatedReaderConfigurationError);
  });
});

describe('TRADE-04A submission and inclusion reading (SEC-TRADE04A-11)', () => {
  it('a submit answer proves only malformation; everything else readable is provisional', () => {
    assert.deepEqual(readXrplSubmission({ engine_result: 'temBAD_FEE' }, HASH_A), { kind: 'malformed', engineResult: 'temBAD_FEE' });
    for (const code of ['tesSUCCESS', 'terQUEUED', 'terNO_DELEGATE_PERMISSION', 'telCAN_NOT_QUEUE', 'tecUNFUNDED_OFFER', 'tefPAST_SEQ']) assert.deepEqual(readXrplSubmission({ engine_result: code }, HASH_A), { kind: 'provisional', engineResult: code }, code);
    assert.deepEqual(readXrplSubmission({ engine_result: 'tesSUCCESS', tx_json: { hash: HASH_B } }, HASH_A), { kind: 'unreadable' }, 'an answer about another transaction');
    assert.deepEqual(readXrplSubmission({}, HASH_A), { kind: 'unreadable' });
  });

  it('inclusion is final only from a validated answer; non-inclusion only from a complete search after the window closed', () => {
    assert.deepEqual(readXrplInclusion({ hash: HASH_A, validated: true, ledger_index: 50, meta: { TransactionResult: 'tecKILLED' } }, HASH_A), { kind: 'validated', engineResult: 'tecKILLED', ledgerIndex: 50 });
    assert.deepEqual(readXrplInclusion({ hash: HASH_A, validated: false }, HASH_A), { kind: 'pending' });
    assert.deepEqual(readXrplInclusion({ hash: HASH_B, validated: true, ledger_index: 50, meta: { TransactionResult: 'tesSUCCESS' } }, HASH_A), { kind: 'unreadable' });
    assert.deepEqual(readXrplInclusion({ error: 'txnNotFound', searched_all: false }, HASH_A), { kind: 'pending' });
    const notFound = readXrplInclusion({ error: 'txnNotFound', searched_all: true }, HASH_A);
    assert.deepEqual(notFound, { kind: 'not-found-complete' });
    assert.equal(xrplNonInclusionProven(notFound, 99, 100), false, 'C12: the window is still open at 99');
    assert.equal(xrplNonInclusionProven(notFound, undefined, 100), false, 'an unread validated index proves nothing');
    assert.equal(xrplNonInclusionProven(notFound, 100, 100), true, 'C12: LastLedgerSequence itself validated');
    assert.equal(xrplNonInclusionProven({ kind: 'pending' }, 10_000, 100), false, 'C10: elapsed ledgers alone never prove non-inclusion');
    assert.equal(xrplWindowClosed(100, 100), true);
    assert.equal(xrplWindowClosed(99, 100), false);
  });
});

describe('TRADE-04A owner-account Sequence safety (matrix C; SEC-TRADE04A-08, -17)', () => {
  const window = { sequence: 10, lastLedgerSequence: 120, open: true };

  it('C1 same account, same Sequence: blocked while the window is open', () => {
    assert.equal(xrplSequenceWindowBlocks(window, 10, 100), true);
  });

  it('C2 same account, a later Sequence is free; an earlier or equal one is blocked', () => {
    assert.equal(xrplSequenceWindowBlocks(window, 11, 100), false);
    assert.equal(xrplSequenceWindowBlocks(window, 9, 100), true);
  });

  it('C11 ledger progression and C12 LastLedgerSequence passed: the window closes at the ledger fact, never before', () => {
    assert.equal(xrplSequenceWindowBlocks(window, 10, 119), true);
    assert.equal(xrplSequenceWindowBlocks(window, 10, 120), false);
  });

  it('C10 uncertain transaction: an open record blocks whatever its local belief; only a ledger-fact settlement closes it', () => {
    assert.equal(xrplSequenceWindowBlocks({ ...window, open: true }, 10, 100), true);
    assert.equal(xrplSequenceWindowBlocks({ ...window, open: false }, 10, 100), false);
    assert.equal(xrplSequenceWindowBlocks({ ...window, open: 'yes' as never }, 10, 100), true, 'fail-closed: only an explicit false releases');
    assert.equal(xrplSequenceWindowBlocks({ ...window, open: undefined as never }, 10, 100), true, 'fail-closed: an unknown state blocks');
    assert.equal(xrplSequenceWindowBlocks({ ...window, lastLedgerSequence: Number.NaN }, 10, 100), true, 'fail-closed: an incomparable window blocks');
  });

  it('C8 Payment and Trade sharing an owner account on one network are refused; C9 disjoint accounts are accepted', () => {
    const payment = { domainId: 'xrpl-rlusd', networkId: TEST_NETWORK, sequenceAccounts: [OWNER] };
    const trade = { domainId: 'xrpl-offer', networkId: TEST_NETWORK, sequenceAccounts: [OWNER] };
    assert.throws(
      () => assertXrplSequenceOwnership([payment, trade]),
      (error: unknown) => error instanceof XrplSequenceOwnershipError && error.code === 'XRPL_SEQUENCE_ACCOUNT_SHARED' && !error.message.includes(OWNER),
    );
    const ownership = assertXrplSequenceOwnership([payment, { ...trade, sequenceAccounts: [OTHER] }]);
    assert.equal(ownership.ownerOf(TEST_NETWORK, OWNER), 'xrpl-rlusd');
    assert.equal(ownership.ownerOf(TEST_NETWORK, OTHER), 'xrpl-offer');
  });

  it('C3 different accounts and C4 different networks are independent sequence spaces', () => {
    const ownership = assertXrplSequenceOwnership([
      { domainId: 'xrpl-rlusd', networkId: TEST_NETWORK, sequenceAccounts: [OWNER] },
      { domainId: 'xrpl-offer', networkId: XRPL_NETWORK_IDENTITIES.devnet, sequenceAccounts: [OWNER] },
    ]);
    assert.equal(ownership.ownerOf(TEST_NETWORK, OWNER), 'xrpl-rlusd');
    assert.equal(ownership.ownerOf(XRPL_NETWORK_IDENTITIES.devnet, OWNER), 'xrpl-offer');
  });

  it('the delegate is not a sequence account: a delegate that is another domain’s source account is not a sequence conflict', () => {
    // Delegated OfferCreate consumes the owner's Sequence; the delegate signs and pays the fee only.
    assert.doesNotThrow(() =>
      assertXrplSequenceOwnership([
        { domainId: 'xrpl-rlusd', networkId: TEST_NETWORK, sequenceAccounts: [DELEGATE] },
        { domainId: 'xrpl-offer', networkId: TEST_NETWORK, sequenceAccounts: [OWNER] },
      ]),
    );
  });

  it('declarations are closed: duplicate domains, unknown or unpermitted networks and malformed accounts are refused', () => {
    const base = { domainId: 'xrpl-rlusd', networkId: TEST_NETWORK, sequenceAccounts: [OWNER] };
    for (const [domains, code] of [
      [[base, { ...base, sequenceAccounts: [OTHER] }], 'XRPL_SEQUENCE_DOMAIN_DUPLICATE'],
      [[{ ...base, networkId: 0 }], 'XRPL_SEQUENCE_DOMAIN_INVALID'],
      [[{ ...base, networkId: 42 }], 'XRPL_SEQUENCE_DOMAIN_INVALID'],
      [[{ ...base, sequenceAccounts: [] }], 'XRPL_SEQUENCE_DOMAIN_INVALID'],
      [[{ ...base, sequenceAccounts: ['nope'] }], 'XRPL_SEQUENCE_DOMAIN_INVALID'],
      [[{ ...base, domainId: '' }], 'XRPL_SEQUENCE_DOMAIN_INVALID'],
    ] as const) {
      assert.throws(() => assertXrplSequenceOwnership(domains as never), (error: unknown) => error instanceof XrplSequenceOwnershipError && error.code === code, JSON.stringify(domains));
    }
    assert.doesNotThrow(() => assertXrplSequenceOwnership([{ ...base, networkId: 0 }], { allowMainnet: true }));
    assert.doesNotThrow(() => assertXrplSequenceOwnership([{ ...base, sequenceAccounts: [OWNER, OWNER] }]), 'one domain naming its own account twice is not a conflict');
  });
});
