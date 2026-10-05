import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Wallet, decode } from 'xrpl';

import {
  XrplTransportConfigurationError,
  canonicalIssuedValue,
  createEnvXrplSigner,
  createSqliteXrplAttemptStore,
  createXrplTestnetTransport,
  issuedValuesEqual,
  resolveXrplTestnetConfiguration,
  runXrplPreflight,
  type XrplLedgerClient,
  type XrplPaymentSubmission,
  type XrplSettlementGate,
  type XrplSubmissionAttemptStore,
  type XrplTransactionLookup,
  type XrplTransactionSigner,
  type XrplTransportEvent,
} from '../src/index.js';

/**
 * ANDREW-P0-08 — the real XRPL Testnet transport, offline. The ledger is a
 * scripted fake; the signer is the real env signer over a throwaway wallet
 * generated in memory for this run (never printed, never persisted outside the
 * per-test temporary directory). What matters on every refusal: signer calls
 * 0, submissions 0, no attempt row.
 */

const RLUSD = '524C555344000000000000000000000000000000';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const MAINNET_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ENDPOINT = 'wss://s.altnet.rippletest.net:51233/';
const T0 = Date.parse('2026-10-04T12:00:00.000Z');

const treasury = Wallet.generate();
const recipient = Wallet.generate();
const SEED_VARIABLE = 'TEST_ONLY_XRPL_TREASURY_SEED';
const environment = { [SEED_VARIABLE]: treasury.seed };
const SECRETS = [treasury.seed ?? '', treasury.privateKey];

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xrpl-attempts-'));
  directories.push(directory);
  return join(directory, 'attempts.sqlite');
}

const AMOUNT = { currency: RLUSD, issuer: ISSUER, value: '75000' };

function submission(overrides: Partial<XrplPaymentSubmission> = {}, amount: XrplPaymentSubmission['instruction']['Amount'] = AMOUNT, destination = recipient.classicAddress): XrplPaymentSubmission {
  return {
    instruction: { TransactionType: 'Payment', Destination: destination, Amount: amount },
    executionId: 'exec-p008-1',
    requestId: 'req-p008-1',
    decisionId: 'decision-p008-1',
    notAfter: new Date(T0 + 600_000).toISOString(),
    network: 'xrpl-testnet',
    ...overrides,
  };
}

/** A stand-in for the P0-07 settlement check bound to the Testnet RLUSD profile. */
const settlementGate: XrplSettlementGate = (s) => {
  if (s.network !== 'xrpl-testnet') return { ok: false, refusal: s.network === undefined ? 'network-missing' : 'network-mismatch' };
  const amount = s.instruction.Amount;
  if (typeof amount === 'string' || amount.currency !== RLUSD || amount.issuer !== ISSUER) return { ok: false, refusal: 'token-not-settled' };
  return { ok: true };
};

interface FakeLedgerOptions {
  readonly networkId?: number | undefined;
  readonly validated?: () => number;
  readonly autofill?: (tx: Record<string, unknown>) => Record<string, unknown>;
  readonly submit?: (blob: string) => { readonly engineResult?: string };
  readonly lookup?: (hash: string, blob: string | undefined, call: number) => XrplTransactionLookup;
}

function validatedLookup(blob: string, hash: string, overrides: { readonly meta?: Record<string, unknown>; readonly transaction?: Record<string, unknown>; readonly closeTimeIso?: string; readonly hash?: string } = {}): XrplTransactionLookup {
  const tx = decode(blob) as Record<string, unknown>;
  return {
    found: true,
    validated: true,
    hash: overrides.hash ?? hash,
    ledgerIndex: 1002,
    closeTimeIso: overrides.closeTimeIso ?? new Date(T0 + 5_000).toISOString(),
    transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'], ...overrides.transaction },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx['Amount'], ...overrides.meta },
  };
}

function fakeLedger(options: FakeLedgerOptions = {}) {
  const calls = { connect: 0, autofill: 0, submit: 0, lookup: 0, blobs: [] as string[] };
  let submitted: string | undefined;
  let attemptHash: string | undefined;
  const client: XrplLedgerClient = {
    async serverInfo() {
      return 'networkId' in options && options.networkId === undefined ? { validatedLedgerIndex: 1000 } : { networkId: options.networkId ?? 1, validatedLedgerIndex: 1000 };
    },
    async validatedLedgerIndex() {
      return options.validated?.() ?? 1000;
    },
    async autofill(tx) {
      calls.autofill += 1;
      // Exactly what xrpl.js 4.7.0 `Client.autofill` returns on Testnet (network id 1 ≤ 1024):
      // a `NetworkID` key whose value is undefined (client/index.js), plus Flags, Sequence, Fee, LastLedgerSequence (+20).
      const prepared: Record<string, unknown> = { ...tx, Flags: 0, NetworkID: undefined, Sequence: 7, Fee: '12', LastLedgerSequence: 1020 };
      return options.autofill?.(prepared) ?? prepared;
    },
    async submit(blob) {
      calls.submit += 1;
      calls.blobs.push(blob);
      submitted = blob;
      return options.submit?.(blob) ?? { engineResult: 'tesSUCCESS' };
    },
    async transaction(hash) {
      calls.lookup += 1;
      attemptHash = hash;
      if (options.lookup) return options.lookup(hash, submitted, calls.lookup);
      if (submitted === undefined) return { found: false, searchedAll: false };
      return validatedLookup(submitted, hash);
    },
    async disconnect() {},
  };
  return { calls, connect: async () => ((calls.connect += 1), client), hash: () => attemptHash };
}

function countingSigner(base: XrplTransactionSigner, transform?: (prepared: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) {
  const counter = { calls: 0 };
  const signer: XrplTransactionSigner = {
    account: base.account,
    async sign(prepared) {
      counter.calls += 1;
      return base.sign(transform ? transform(prepared) : prepared);
    },
  };
  return { signer, counter };
}

function build(options: { readonly ledger?: ReturnType<typeof fakeLedger>; readonly store?: XrplSubmissionAttemptStore; readonly signer?: XrplTransactionSigner; readonly now?: () => number; readonly validationTimeoutMs?: number } = {}) {
  const ledger = options.ledger ?? fakeLedger();
  const store = options.store ?? createSqliteXrplAttemptStore(storePath(), { now: () => new Date(T0).toISOString() });
  const base = createEnvXrplSigner({ environment, seedVariable: SEED_VARIABLE, expectedAccount: treasury.classicAddress });
  const { signer, counter } = options.signer ? { signer: options.signer, counter: { calls: Number.NaN } } : countingSigner(base);
  const events: XrplTransportEvent[] = [];
  let clock = T0;
  const transport = createXrplTestnetTransport({
    configuration: { endpoint: ENDPOINT, sourceAccount: treasury.classicAddress, forbiddenSourceAccounts: [ISSUER, MAINNET_ISSUER], validationTimeoutMs: options.validationTimeoutMs ?? 10_000, pollIntervalMs: 1_000 },
    settlementGate,
    signer,
    attempts: store,
    connect: ledger.connect,
    now: options.now ?? (() => clock),
    sleep: async (ms) => {
      clock += ms;
    },
    onEvent: (event) => events.push(event),
  });
  return { transport, ledger, store, counter, events };
}

describe('ANDREW-P0-08 transport — configuration is Testnet-only', () => {
  it('refuses Mainnet servers, non-wss endpoints and endpoints carrying credentials', () => {
    for (const endpoint of ['wss://s1.ripple.com/', 'wss://s2.ripple.com:443', 'wss://xrplcluster.com/', 'wss://eu.xrplcluster.com/', 'wss://xrpl.ws', 'https://s.altnet.rippletest.net:51234/', 'ws://s.altnet.rippletest.net:51233/', 'wss://user:pass@s.altnet.rippletest.net:51233/', 'not a url']) {
      assert.throws(() => resolveXrplTestnetConfiguration({ endpoint, sourceAccount: treasury.classicAddress }), XrplTransportConfigurationError, endpoint);
    }
  });

  it('refuses another network label or network id, an invalid source, or the issuer as source', () => {
    const base = { endpoint: ENDPOINT, sourceAccount: treasury.classicAddress };
    assert.throws(() => resolveXrplTestnetConfiguration({ ...base, networkLabel: 'xrpl-mainnet' }), XrplTransportConfigurationError);
    assert.throws(() => resolveXrplTestnetConfiguration({ ...base, expectedNetworkId: 0 }), XrplTransportConfigurationError);
    assert.throws(() => resolveXrplTestnetConfiguration({ ...base, expectedNetworkId: 2 }), XrplTransportConfigurationError);
    assert.throws(() => resolveXrplTestnetConfiguration({ ...base, sourceAccount: 'rNotAnAccount' }), XrplTransportConfigurationError);
    assert.throws(() => resolveXrplTestnetConfiguration({ endpoint: ENDPOINT, sourceAccount: ISSUER, forbiddenSourceAccounts: [ISSUER] }), XrplTransportConfigurationError);
    const resolved = resolveXrplTestnetConfiguration(base);
    assert.equal(resolved.ledgerHorizon, 4, 'XRPL reliable-submission guidance: last validated ledger + 4');
    assert.equal(resolved.expectedNetworkId, 1);
  });

  it('refuses a signer that signs for another account than the configured source', () => {
    const stranger = Wallet.generate();
    const signer = createEnvXrplSigner({ environment: { S: stranger.seed }, seedVariable: 'S', expectedAccount: stranger.classicAddress });
    assert.throws(
      () => createXrplTestnetTransport({ configuration: { endpoint: ENDPOINT, sourceAccount: treasury.classicAddress }, settlementGate, signer, attempts: createSqliteXrplAttemptStore(storePath()) }),
      XrplTransportConfigurationError,
    );
  });
});

describe('ANDREW-P0-08 transport — refusals happen before any signature or submission', () => {
  for (const [label, networkId] of [['Mainnet (0)', 0], ['Devnet (2)', 2], ['absent', undefined]] as const) {
    it(`a server reporting network id ${label} is refused: no prepare, no signature, no submit, no attempt`, async () => {
      const { transport, ledger, counter, store } = build({ ledger: fakeLedger({ networkId }) });
      assert.deepEqual(await transport.submitPayment(submission()), { kind: 'not-submitted' });
      assert.equal(ledger.calls.autofill, 0);
      assert.equal(counter.calls, 0);
      assert.equal(ledger.calls.submit, 0);
      assert.equal(store.find('exec-p008-1'), undefined);
    });
  }

  it('settlement drift (Mainnet issuer, another currency, another network, no network) refuses with zero network calls', async () => {
    for (const s of [
      submission({}, { ...AMOUNT, issuer: MAINNET_ISSUER }),
      submission({}, { ...AMOUNT, currency: 'USD' }),
      submission({ network: 'xrpl-mainnet' }),
      (({ network: _omitted, ...withoutNetwork }) => (void _omitted, withoutNetwork))(submission()),
    ]) {
      const { transport, ledger, counter } = build();
      assert.deepEqual(await transport.submitPayment(s), { kind: 'not-submitted' });
      assert.equal(ledger.calls.connect, 0);
      assert.equal(counter.calls, 0);
    }
  });

  it('an XRP amount, an invalid destination, or the treasury paying itself is refused locally', async () => {
    for (const s of [submission({}, '75000000000'), submission({}, AMOUNT, 'rNotAnAddress'), submission({}, AMOUNT, treasury.classicAddress)]) {
      const { transport, ledger, counter } = build();
      assert.deepEqual(await transport.submitPayment(s), { kind: 'not-submitted' });
      assert.equal(ledger.calls.connect + counter.calls, 0);
    }
  });

  it('insufficient remaining grant lifetime refuses before connecting or signing', async () => {
    const { transport, ledger, counter } = build();
    assert.deepEqual(await transport.submitPayment(submission({ notAfter: new Date(T0 + 60_000).toISOString() })), { kind: 'not-submitted' });
    assert.equal(ledger.calls.connect, 0);
    assert.equal(counter.calls, 0);
  });

  it('a prepared transaction carrying any extra field, a flag, a changed amount or an excessive fee is refused before signing', async () => {
    for (const mutate of [
      (tx: Record<string, unknown>) => ({ ...tx, NetworkID: 1 }),
      (tx: Record<string, unknown>) => ({ ...tx, NetworkID: 0 }),
      (tx: Record<string, unknown>) => ({ ...tx, NetworkID: 1025 }),
      (tx: Record<string, unknown>) => ({ ...tx, NetworkID: null }),
      (tx: Record<string, unknown>) => ({ ...tx, SendMax: tx['Amount'] }),
      (tx: Record<string, unknown>) => ({ ...tx, Paths: [] }),
      (tx: Record<string, unknown>) => ({ ...tx, Memos: [] }),
      (tx: Record<string, unknown>) => ({ ...tx, DestinationTag: 7 }),
      (tx: Record<string, unknown>) => ({ ...tx, Flags: 131072 }),
      (tx: Record<string, unknown>) => ({ ...tx, Fee: '999999' }),
      (tx: Record<string, unknown>) => ({ ...tx, Amount: { ...AMOUNT, value: '75001' } }),
      (tx: Record<string, unknown>) => ({ ...tx, Destination: Wallet.generate().classicAddress }),
      (tx: Record<string, unknown>) => ({ ...tx, Account: Wallet.generate().classicAddress }),
    ]) {
      const { transport, ledger, counter, store } = build({ ledger: fakeLedger({ autofill: mutate }) });
      assert.deepEqual(await transport.submitPayment(submission()), { kind: 'not-submitted' });
      assert.equal(counter.calls, 0);
      assert.equal(ledger.calls.submit, 0);
      assert.equal(store.find('exec-p008-1'), undefined);
    }
  });

  it('a signer failure produces no attempt and no submit', async () => {
    const failing: XrplTransactionSigner = { account: treasury.classicAddress, sign: async () => { throw new Error('hsm unavailable'); } };
    const { transport, ledger, store } = build({ signer: failing });
    assert.deepEqual(await transport.submitPayment(submission()), { kind: 'not-submitted' });
    assert.equal(ledger.calls.submit, 0);
    assert.equal(store.find('exec-p008-1'), undefined);
  });

  it('a signer that signs something other than the prepared transaction is caught before persistence or submit', async () => {
    const base = createEnvXrplSigner({ environment, seedVariable: SEED_VARIABLE, expectedAccount: treasury.classicAddress });
    const tampering = countingSigner(base, (prepared) => ({ ...prepared, Destination: Wallet.generate().classicAddress }));
    const { transport, ledger, store } = build({ signer: tampering.signer });
    assert.deepEqual(await transport.submitPayment(submission()), { kind: 'not-submitted' });
    assert.equal(ledger.calls.submit, 0);
    assert.equal(store.find('exec-p008-1'), undefined);
    const lying: XrplTransactionSigner = { account: treasury.classicAddress, sign: async (p) => ({ ...(await base.sign(p)), hash: 'A'.repeat(64) }) };
    const second = build({ signer: lying });
    assert.deepEqual(await second.transport.submitPayment(submission()), { kind: 'not-submitted' });
    assert.equal(second.ledger.calls.submit, 0);
  });

  it('a persistence failure before submit produces no submit', async () => {
    const real = createSqliteXrplAttemptStore(storePath());
    const failing: XrplSubmissionAttemptStore = { ...real, record: () => { throw new Error('disk full'); } };
    const { transport, ledger, counter } = build({ store: failing });
    assert.deepEqual(await transport.submitPayment(submission()), { kind: 'not-submitted' });
    assert.equal(counter.calls, 1, 'signed');
    assert.equal(ledger.calls.submit, 0, 'never submitted');
  });
});

describe('ANDREW-P0-08 transport — prepare, sign, persist, submit once, validate', () => {
  it('LIVE REGRESSION: xrpl.js autofill’s `NetworkID: undefined` is an absent field — signed without NetworkID; a NetworkID with any value is still refused', async () => {
    // The first live P0-08 run refused here ("prepared:unexpected-field:NetworkID"), before signing: the
    // allowlist read a present-but-undefined key as a field. Reproduce that exact autofill shape.
    const xrplJsShape = fakeLedger({ autofill: (tx) => {
      assert.equal('NetworkID' in tx && tx['NetworkID'] === undefined, true, 'the fake reproduces xrpl.js');
      return tx;
    } });
    const { transport, counter } = build({ ledger: xrplJsShape });
    const observation = await transport.submitPayment(submission());
    assert.equal(observation.kind, 'validated');
    assert.equal(counter.calls, 1);
    assert.equal(xrplJsShape.calls.submit, 1);
    const decoded = decode(xrplJsShape.calls.blobs[0] ?? '') as Record<string, unknown>;
    assert.equal('NetworkID' in decoded, false, 'the signed transaction carries no NetworkID');
    for (const value of [0, 1, 2, 1025]) {
      const valued = fakeLedger({ autofill: (tx) => ({ ...tx, NetworkID: value }) });
      const refused = build({ ledger: valued });
      assert.deepEqual(await refused.transport.submitPayment(submission()), { kind: 'not-submitted' }, String(value));
      assert.equal(refused.counter.calls, 0, `NetworkID ${value}: no signature`);
      assert.equal(valued.calls.submit, 0);
    }
  });

  it('the happy path: one signature, durable attempt BEFORE submit, one submit, validated evidence', async () => {
    const store = createSqliteXrplAttemptStore(storePath(), { now: () => new Date(T0).toISOString() });
    let persistedBeforeSubmit: string | undefined;
    const ledger = fakeLedger({
      submit: () => {
        persistedBeforeSubmit = store.find('exec-p008-1')?.state;
        return { engineResult: 'tesSUCCESS' };
      },
    });
    const { transport, counter, events } = build({ ledger, store });
    const observation = await transport.submitPayment(submission());
    assert.equal(persistedBeforeSubmit, 'signed', 'the attempt was durable before the submit call');
    assert.equal(counter.calls, 1);
    assert.equal(ledger.calls.submit, 1);
    assert.equal(observation.kind, 'validated');
    assert.ok(observation.kind === 'validated');
    assert.equal(observation.engineResult, 'tesSUCCESS');
    assert.equal(observation.ledgerIndex, '1002');
    assert.deepEqual(observation.deliveredAmount, AMOUNT);
    const record = store.find('exec-p008-1');
    assert.ok(record !== undefined);
    assert.equal(record.state, 'validated-success');
    assert.equal(record.attempt.transactionHash, observation.transactionHash);
    assert.equal(record.attempt.lastLedgerSequence, 1004, 'validated ledger 1000 + horizon 4, not autofill’s +20');
    assert.deepEqual(record.events.map((event) => event.state), ['signed', 'submitted', 'validated-success']);
    const blob = ledger.calls.blobs[0] ?? '';
    const decoded = decode(blob) as Record<string, unknown>;
    assert.equal(decoded['NetworkID'], undefined, 'Testnet (id 1 ≤ 1024) omits NetworkID');
    assert.equal(decoded['Account'], treasury.classicAddress);
    assert.deepEqual(decoded['Amount'], AMOUNT);
    assert.equal(events.some((event) => event.event === 'xrpl.attempt.validated'), true);
  });

  it('a duplicate executionId never re-signs or resubmits; it returns the durable result', async () => {
    const { transport, ledger, counter } = build();
    const first = await transport.submitPayment(submission());
    const second = await transport.submitPayment(submission());
    assert.equal(counter.calls, 1);
    assert.equal(ledger.calls.submit, 1);
    assert.deepEqual(second, first);
  });

  it('a restart with a persisted attempt mints no new transaction: it reconciles by hash', async () => {
    const path = storePath();
    const ledger = fakeLedger({ lookup: (_hash, _blob, call) => (call === 1 ? { found: false, searchedAll: false } : ({ found: false, searchedAll: false } as const)) });
    const firstStore = createSqliteXrplAttemptStore(path);
    const first = build({ ledger, store: firstStore, validationTimeoutMs: 2_000 });
    const pending = await first.transport.submitPayment(submission());
    assert.equal(pending.kind, 'unconfirmed');
    firstStore.close();
    // "Process restart": a new store over the same file and a new transport.
    const restartedLedger = fakeLedger({ lookup: (hash) => validatedLookup(ledger.calls.blobs[0] ?? '', hash) });
    const second = build({ ledger: restartedLedger, store: createSqliteXrplAttemptStore(path) });
    const reconciled = await second.transport.submitPayment(submission());
    assert.equal(second.counter.calls, 0, 'no new signature');
    assert.equal(restartedLedger.calls.submit, 0, 'no new submission');
    assert.equal(reconciled.kind, 'validated');
    assert.equal(ledger.calls.submit, 1, 'exactly one submission across both processes');
  });

  it('a submit that throws is uncertainty: no second transaction, the hash is reconciled', async () => {
    let submits = 0;
    const ledger = fakeLedger({
      submit: () => {
        submits += 1;
        throw new Error('socket closed');
      },
      lookup: (hash, blob, call) => (call < 3 ? { found: false, searchedAll: false } : validatedLookup(blob ?? '', hash)),
    });
    const { transport, store } = build({ ledger });
    const observation = await transport.submitPayment(submission());
    assert.equal(submits, 1);
    assert.equal(observation.kind, 'validated');
    assert.deepEqual(store.find('exec-p008-1')?.events.map((event) => event.state), ['signed', 'submit-uncertain', 'validated-success']);
  });

  it('no validated answer within the wait is `unconfirmed` — never failed, never resubmitted', async () => {
    const ledger = fakeLedger({ lookup: (hash, blob) => ({ ...(validatedLookup(blob ?? '', hash) as Extract<XrplTransactionLookup, { found: true }>), validated: false }) });
    const { transport, store } = build({ ledger, validationTimeoutMs: 3_000 });
    const observation = await transport.submitPayment(submission());
    assert.equal(observation.kind, 'unconfirmed');
    assert.equal(ledger.calls.submit, 1);
    assert.equal(store.find('exec-p008-1')?.state, 'unresolved');
  });

  it('LastLedgerSequence passed with every ledger searched: definitively not applied (`rejected`, expired)', async () => {
    let validated = 1000;
    const ledger = fakeLedger({ validated: () => (validated += 3), lookup: () => ({ found: false, searchedAll: true }) });
    const { transport, store } = build({ ledger });
    const observation = await transport.submitPayment(submission());
    assert.equal(observation.kind, 'rejected');
    assert.equal(store.find('exec-p008-1')?.state, 'expired');
  });

  it('LastLedgerSequence passed but the server did not search every ledger: still uncertain', async () => {
    let validated = 1000;
    const ledger = fakeLedger({ validated: () => (validated += 3), lookup: () => ({ found: false, searchedAll: false }) });
    const { transport } = build({ ledger, validationTimeoutMs: 3_000 });
    assert.equal((await transport.submitPayment(submission())).kind, 'unconfirmed');
  });
});

describe('ANDREW-P0-08 transport — only exact validated evidence is completion', () => {
  async function judged(overrides: Parameters<typeof validatedLookup>[2]) {
    const ledger = fakeLedger({ lookup: (hash, blob) => validatedLookup(blob ?? '', hash, overrides) });
    const { transport, store } = build({ ledger });
    const observation = await transport.submitPayment(submission());
    return { observation, record: store.find('exec-p008-1') };
  }

  it('a `tec…` result in a validated ledger is a definitive payment failure, not completion', async () => {
    const { observation, record } = await judged({ meta: { TransactionResult: 'tecPATH_DRY' } });
    assert.equal(observation.kind, 'rejected');
    assert.ok(observation.kind === 'rejected');
    assert.equal(observation.engineResult, 'tecPATH_DRY');
    assert.equal(record?.state, 'validated-tec');
  });

  for (const [label, overrides] of [
    ['a different transaction hash', { hash: 'B'.repeat(64) }],
    ['a delivered amount of 74999.99', { meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT, value: '74999.99' } } }],
    ['a delivered amount in another currency', { meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT, currency: 'USD' } } }],
    ['a delivered amount from another issuer', { meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT, issuer: MAINNET_ISSUER } } }],
    ['no delivered_amount', { meta: { TransactionResult: 'tesSUCCESS', delivered_amount: undefined } }],
    ['delivered_amount "unavailable"', { meta: { TransactionResult: 'tesSUCCESS', delivered_amount: 'unavailable' } }],
    ['another destination', { transaction: { Destination: Wallet.generate().classicAddress } }],
    ['no result code', { meta: { TransactionResult: undefined } }],
    ['a close time after the grant horizon', { closeTimeIso: new Date(T0 + 601_000).toISOString() }],
    ['no close time', { closeTimeIso: 'not-a-time' }],
  ] as const) {
    it(`${label}: an anomaly routed to reconciliation — never completion, never a retryable failure`, async () => {
      const { observation, record } = await judged(overrides as Parameters<typeof validatedLookup>[2]);
      assert.equal(observation.kind, 'unconfirmed');
      assert.equal(record?.state, 'anomaly');
    });
  }

  it('the delivered amount is compared as an exact decimal: "7.5e4" and "75000.000" equal "75000"; nothing approximate', async () => {
    for (const value of ['7.5e4', '75000.000', '75000']) {
      const { observation } = await judged({ meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...AMOUNT, value } } });
      assert.equal(observation.kind, 'validated', value);
    }
    assert.equal(issuedValuesEqual('75000', '75000.0000000000001'), false);
    assert.equal(issuedValuesEqual('0.1', '0.10'), true);
    assert.equal(issuedValuesEqual('1e-3', '0.001'), true);
    assert.equal(canonicalIssuedValue('NaN'), undefined);
    assert.equal(canonicalIssuedValue(75000), undefined);
  });
});

describe('ANDREW-P0-08 transport — secrets never leave the signer', () => {
  it('no seed or private key in events, errors, observations or attempt records; the signed blob never in events or `find`', async () => {
    const { transport, ledger, events, store } = build();
    const observation = await transport.submitPayment(submission());
    const blob = ledger.calls.blobs[0] ?? '';
    const visible = JSON.stringify({ events, observation, record: store.find('exec-p008-1') });
    for (const secret of SECRETS) assert.equal(secret.length > 0 && visible.includes(secret), false);
    assert.equal(visible.includes(blob), false, 'the signed blob is not in events, the observation or find()');
    assert.equal(store.signedBlob('exec-p008-1'), blob, 'it is durable for manual reconciliation only');
  });

  it('the env signer never echoes its seed: missing, malformed or foreign seeds fail with fixed phrases', () => {
    const messages: string[] = [];
    for (const [env, expected] of [
      [{}, treasury.classicAddress],
      [{ S: 'sNotASeed' }, treasury.classicAddress],
      [{ S: treasury.seed }, recipient.classicAddress],
    ] as const) {
      try {
        createEnvXrplSigner({ environment: env as Record<string, string | undefined>, seedVariable: 'S', expectedAccount: expected });
        assert.fail('should refuse');
      } catch (error) {
        assert.ok(error instanceof XrplTransportConfigurationError);
        messages.push(error.message);
      }
    }
    for (const message of messages) for (const secret of [...SECRETS, 'sNotASeed']) assert.equal(message.includes(secret), false);
    const signer = createEnvXrplSigner({ environment, seedVariable: SEED_VARIABLE, expectedAccount: treasury.classicAddress });
    assert.deepEqual(Object.keys(signer).sort(), ['account', 'sign']);
    assert.equal(JSON.stringify(signer).includes(treasury.seed ?? '#'), false);
  });

  it('the attempt database holds the blob but no seed or private key', async () => {
    const path = storePath();
    const { transport } = build({ store: createSqliteXrplAttemptStore(path) });
    await transport.submitPayment(submission());
    const bytes = readFileSync(path).toString('latin1') + (() => { try { return readFileSync(`${path}-wal`).toString('latin1'); } catch { return ''; } })();
    for (const secret of SECRETS) assert.equal(bytes.includes(secret), false);
  });
});

describe('ANDREW-P0-08 preflight — non-secret facts and an honest verdict', () => {
  const reader = (overrides: { readonly networkId?: number; readonly balance?: string; readonly treasuryLine?: boolean; readonly recipientLine?: boolean } = {}) => ({
    async serverInfo() {
      return { networkId: overrides.networkId ?? 1, validatedLedgerIndex: 1000 };
    },
    async xrpBalanceDrops() {
      return 100_000_000n;
    },
    async trustLine(account: string) {
      if (account === treasury.classicAddress) return overrides.treasuryLine === false ? undefined : { balance: overrides.balance ?? '75000', limit: '1000000' };
      return overrides.recipientLine === false ? undefined : { balance: '0', limit: '1000000' };
    },
  });
  const input = { expectedNetworkId: 1, treasury: treasury.classicAddress, recipient: recipient.classicAddress, currency: RLUSD, issuer: ISSUER, requiredValue: '75000', minimumXrpDrops: 20_000_000n };

  it('ready only when every fact is green', async () => {
    assert.equal((await runXrplPreflight(reader(), input)).ready, true);
  });

  it('an RLUSD balance below 75,000 is a blocker naming the exact shortfall — never a smaller payment', async () => {
    for (const balance of ['0', '74999.99', '1000']) {
      const report = await runXrplPreflight(reader({ balance }), input);
      assert.equal(report.ready, false);
      assert.equal(report.treasury.tokenSufficient, false);
      assert.ok(report.blockers.some((blocker) => blocker.includes(`holds ${balance} RLUSD; 75000 is required`)), report.blockers.join('; '));
    }
  });

  it('a wrong network or a missing trust line is a blocker', async () => {
    assert.equal((await runXrplPreflight(reader({ networkId: 0 }), input)).ready, false);
    assert.equal((await runXrplPreflight(reader({ treasuryLine: false }), input)).ready, false);
    assert.equal((await runXrplPreflight(reader({ recipientLine: false }), input)).ready, false);
  });
});
