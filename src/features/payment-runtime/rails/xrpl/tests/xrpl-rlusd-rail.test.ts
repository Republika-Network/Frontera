import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from 'xrpl';

import { EXECUTION_FAILURE_REASONS as F } from '../../../../execution-runtime/index.js';
import type { PaymentExecutionRequest, PaymentRailResult } from '../../../domain/index.js';
import {
  XRPL_DESTINATION_KINDS,
  XRPL_RAIL_DETAILS as D,
  XRPL_RLUSD_RAIL_ID,
  XrplRailConfigurationError,
  XrplSubmissionNotAttemptedError,
  buildXrplPayment,
  canonicalDecimalOfLedgerValue,
  createXrplRlusdRail,
  createXrplRlusdRailConfiguration,
  isXrplClassicAddress,
  parseXrplDestination,
  readAutofill,
  readLookup,
  readSubmission,
  signedPaymentMatches,
  xrplIssuedValueOf,
  type XrplRlusdRail,
  type XrplTransactionSigner,
} from '../index.js';
import {
  GOVERNED_ACCOUNT,
  ISSUER,
  OTHER_SOURCE,
  RLUSD_ASSET,
  RLUSD_CURRENCY_HEX,
  TREASURY,
  VENDOR,
  createFakeXrplClient,
  createTestSoftwareXrplSigner,
  testClock,
  testConfiguration,
  testConfigurationInput,
  validatedFailure,
  type FakeXrplClient,
  type FakeXrplScript,
} from './xrpl-test-fixtures.js';

/**
 * PAY-02 rail contract qualification — the rail alone, against the
 * deterministic fake client and the test-only software signer. No network.
 * The governed-path half (deny, approval, grant, P11, P12, evidence,
 * disclosure) is `src/enterprise/__tests__/pay02-xrpl-rlusd-rail.test.ts`.
 */

function request(overrides: Partial<PaymentExecutionRequest> = {}): PaymentExecutionRequest {
  return Object.freeze({
    executionId: 'aoc.exec:0123456789abcdef',
    requestId: 'aoc.req:fedcba9876543210',
    decisionId: 'aoc.dec:00112233',
    grantId: 'grant-1',
    notAfter: '2026-10-09T12:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: { kind: XRPL_DESTINATION_KINDS.account, reference: VENDOR.classicAddress },
    amount: { value: '1250.5', unit: RLUSD_ASSET },
    purpose: 'vendor-payment',
    ...overrides,
  } as PaymentExecutionRequest);
}

interface Harness {
  readonly rail: XrplRlusdRail;
  readonly client: FakeXrplClient;
  readonly signer: ReturnType<typeof createTestSoftwareXrplSigner>;
  readonly logs: { readonly level: string; readonly message: string; readonly fields: unknown }[];
}

function harness(script: FakeXrplScript = {}, configuration = testConfiguration()): Harness {
  const client = createFakeXrplClient(script);
  const signer = createTestSoftwareXrplSigner(TREASURY);
  const logs: { level: string; message: string; fields: unknown }[] = [];
  const rail = createXrplRlusdRail({
    configuration,
    client,
    signers: [signer],
    ...testClock(),
    logger: { info: (message, fields) => logs.push({ level: 'info', message, fields }), warn: (message, fields) => logs.push({ level: 'warn', message, fields }) },
  });
  return { rail, client, signer, logs };
}

const HASH = /^[0-9A-F]{64}$/;

describe('PAY-02 X1 / X2 / X22 — configuration composes, refuses, and never defaults to mainnet', () => {
  it('X1: a valid testnet configuration composes, frozen, with the canonical rail id and derived network id', () => {
    const configuration = testConfiguration();
    assert.equal(configuration.railId, XRPL_RLUSD_RAIL_ID);
    assert.equal(configuration.railId, 'xrpl-rlusd');
    assert.equal(configuration.network, 'testnet');
    assert.equal(configuration.networkId, 1);
    assert.equal(Object.isFrozen(configuration), true);
    assert.equal(Object.isFrozen(configuration.asset), true);
    assert.equal(Object.isFrozen(configuration.sourceAccounts), true);
    assert.equal(configuration.lastLedgerOffset, 20);
    assert.equal(configuration.maxFeeDrops, '1000');
    const { rail } = harness({}, configuration);
    assert.equal(rail.railId, 'xrpl-rlusd');
  });

  it('X2: invalid endpoint, network, issuer, currency, asset and source mappings are refused before execution', () => {
    const refused: [string, Partial<Record<keyof ReturnType<typeof testConfigurationInput>, unknown>>][] = [
      ['network', { network: undefined }],
      ['network', { network: 'Testnet' }],
      ['network', { network: 'livenet' }],
      ['endpoint', { endpoint: undefined }],
      ['endpoint', { endpoint: 'https://s.altnet.rippletest.net:51234' }],
      ['endpoint', { endpoint: 'ws://s.altnet.rippletest.net:51233' }],
      ['endpoint', { endpoint: 'wss://user:pass@s.altnet.rippletest.net:51233' }],
      ['endpoint', { endpoint: 'wss://s.altnet.rippletest.net:51233/?token=abc' }],
      ['endpoint', { endpoint: ' wss://s.altnet.rippletest.net:51233' }],
      ['endpoint', { endpoint: 'not a url' }],
      ['asset.issuer', { asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: 'rNotAnAddress' } }],
      ['asset.issuer', { asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: undefined } }],
      ['asset.currency', { asset: { paymentAsset: RLUSD_ASSET, currency: 'RLUSD', issuer: ISSUER.classicAddress } }],
      ['asset.currency', { asset: { paymentAsset: RLUSD_ASSET, currency: 'XRP', issuer: ISSUER.classicAddress } }],
      ['asset.currency', { asset: { paymentAsset: RLUSD_ASSET, currency: '524c555344000000000000000000000000000000', issuer: ISSUER.classicAddress } }],
      ['asset.paymentAsset', { asset: { paymentAsset: 'RL USD', currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress } }],
      ['asset.override', { asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, override: true } }],
      ['sourceAccounts', { sourceAccounts: [] }],
      ['sourceAccounts[0].address', { sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: 'r123' }] }],
      ['sourceAccounts[0].address', { sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: ISSUER.classicAddress }] }],
      ['sourceAccounts[0].accountId', { sourceAccounts: [{ accountId: 'has space', address: TREASURY.classicAddress }] }],
      ['sourceAccounts[1].accountId', { sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }, { accountId: GOVERNED_ACCOUNT, address: OTHER_SOURCE.classicAddress }] }],
      ['sourceAccounts[1].address', { sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }, { accountId: 'other', address: TREASURY.classicAddress }] }],
      ['sourceAccounts[0]', { sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress, seed: 'x' }] }],
      ['lastLedgerOffset', { lastLedgerOffset: 1 }],
      ['lastLedgerOffset', { lastLedgerOffset: 2.5 }],
      ['maxFeeDrops', { maxFeeDrops: 12 }],
      ['maxFeeDrops', { maxFeeDrops: '0' }],
      ['maxFeeDrops', { maxFeeDrops: '99999999' }],
      ['finalityTimeoutMs', { finalityTimeoutMs: 10 }],
      ['pollIntervalMs', { pollIntervalMs: 59_000 }],
      ['railId', { railId: 'XRPL RLUSD' }],
    ];
    for (const [field, overrides] of refused) {
      assert.throws(
        () => testConfiguration(overrides),
        (error: unknown) => error instanceof XrplRailConfigurationError && error.code === 'XRPL_RAIL_CONFIGURATION_INVALID' && error.field === field,
        `${field}: ${JSON.stringify(overrides)}`,
      );
    }
  });

  it('X2: a refusal never echoes the configured value', () => {
    const canary = 'wss://operator:CANARY-SECRET-77@s.altnet.rippletest.net:51233';
    try {
      testConfiguration({ endpoint: canary });
      assert.fail('refused');
    } catch (error) {
      assert.equal(String((error as Error).message).includes('CANARY-SECRET-77'), false);
      assert.equal(JSON.stringify(error).includes('CANARY-SECRET-77'), false);
    }
  });

  it('X2: the rail refuses a signer set that does not match the source mappings exactly', () => {
    const client = createFakeXrplClient();
    const configuration = testConfiguration();
    assert.throws(() => createXrplRlusdRail({ configuration, client, signers: [] }), XrplRailConfigurationError);
    assert.throws(() => createXrplRlusdRail({ configuration, client, signers: [createTestSoftwareXrplSigner(OTHER_SOURCE)] }), XrplRailConfigurationError);
    assert.throws(() => createXrplRlusdRail({ configuration, client, signers: [createTestSoftwareXrplSigner(TREASURY), createTestSoftwareXrplSigner(TREASURY)] }), XrplRailConfigurationError);
    assert.throws(() => createXrplRlusdRail({ configuration: { ...configuration }, client, signers: [createTestSoftwareXrplSigner(TREASURY)] }), XrplRailConfigurationError, 'an unfrozen, hand-built configuration');
    assert.throws(() => createXrplRlusdRail({ configuration, client: { ...client, submit: undefined } as never, signers: [createTestSoftwareXrplSigner(TREASURY)] }), XrplRailConfigurationError);
  });

  it('X22: mainnet is never implicit — it needs network: mainnet AND allowMainnet: true, and contradictions are refused', () => {
    assert.throws(() => testConfiguration({ network: 'mainnet', endpoint: 'wss://xrpl-main.invalid' }), (error: unknown) => (error as XrplRailConfigurationError).field === 'allowMainnet');
    assert.throws(() => testConfiguration({ network: 'mainnet', allowMainnet: 'yes', endpoint: 'wss://xrpl-main.invalid' }), XrplRailConfigurationError);
    assert.throws(() => testConfiguration({ allowMainnet: true }), (error: unknown) => (error as XrplRailConfigurationError).field === 'allowMainnet', 'allowMainnet on a test network is contradictory');
    for (const host of ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com:443', 'wss://XRPLCLUSTER.COM/']) {
      assert.throws(() => testConfiguration({ endpoint: host }), (error: unknown) => (error as XrplRailConfigurationError).field === 'endpoint', `${host} with network testnet`);
    }
    assert.throws(() => testConfiguration({ network: 'devnet', endpoint: 'wss://s.altnet.rippletest.net:51233' }), XrplRailConfigurationError, 'a testnet host configured as devnet');
    const mainnet = testConfiguration({ network: 'mainnet', allowMainnet: true, endpoint: 'wss://xrpl-main.invalid' });
    assert.equal(mainnet.networkId, 0, 'explicit, trusted mainnet configuration composes — and still must be confirmed by the server');
  });

  it('X22: the server must report the configured network before anything is prepared — a mainnet server behind a testnet configuration is refused with nothing submitted', async () => {
    for (const networkId of [0, 2, undefined]) {
      const { rail, client } = harness({ networkId });
      const result = await rail.execute(request());
      assert.deepEqual(result, { status: 'not-completed', reason: F.ADAPTER_ERROR, detail: D.NETWORK_MISMATCH }, String(networkId));
      assert.equal(client.calls.autofill, 0);
      assert.equal(client.calls.submit, 0);
      assert.deepEqual(await rail.readiness(), { status: 'unavailable', detail: D.NETWORK_MISMATCH });
    }
    assert.deepEqual(await harness().rail.readiness(), { status: 'ready' });
  });
});

describe('PAY-02 §35 — XRPL address and destination parsing', () => {
  it('uses the SDK checksum, bounded by the classic shape', () => {
    assert.equal(isXrplClassicAddress(VENDOR.classicAddress), true);
    const corrupted = VENDOR.classicAddress.slice(0, -1) + (VENDOR.classicAddress.endsWith('a') ? 'b' : 'a');
    for (const bad of ['', ' ', ` ${VENDOR.classicAddress}`, `${VENDOR.classicAddress} `, `${VENDOR.classicAddress}\n`, corrupted, 'r' + '1'.repeat(40), 'x' + VENDOR.classicAddress.slice(1), VENDOR.classicAddress.toLowerCase(), 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ', 42, null, undefined, {}]) {
      assert.equal(isXrplClassicAddress(bad), false, JSON.stringify(bad));
    }
  });

  it('accepts exactly xrpl-account (classic) and xrpl-tagged-account (classic:tag), one spelling each', () => {
    const address = VENDOR.classicAddress;
    assert.deepEqual(parseXrplDestination({ kind: 'xrpl-account', reference: address }), { address });
    assert.deepEqual(parseXrplDestination({ kind: 'xrpl-tagged-account', reference: `${address}:0` }), { address, tag: 0 });
    assert.deepEqual(parseXrplDestination({ kind: 'xrpl-tagged-account', reference: `${address}:4294967295` }), { address, tag: 4294967295 });
    for (const [kind, reference] of [
      ['xrpl-account', `${address}:12`],
      ['xrpl-tagged-account', address],
      ['xrpl-tagged-account', `${address}:`],
      ['xrpl-tagged-account', `${address}:012`],
      ['xrpl-tagged-account', `${address}:-1`],
      ['xrpl-tagged-account', `${address}:4294967296`],
      ['xrpl-tagged-account', `${address}:99999999999`],
      ['xrpl-tagged-account', `${address}:1:2`],
      ['xrpl-tagged-account', `${address}:1e3`],
      ['account', address],
      ['xrpl-x-address', 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ'],
      ['xrpl-account', 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ'],
    ]) {
      assert.equal(parseXrplDestination({ kind: kind as string, reference: reference as string }), undefined, `${kind} ${reference}`);
    }
  });
});

describe('PAY-02 X9 — the RLUSD amount is the canonical decimal, exactly, or refused', () => {
  it('passes canonical decimal text through unchanged and refuses what the ledger cannot hold exactly', () => {
    for (const value of ['1250.5', '0.000000000000001', '1', '999999999999999', '123456789012345000000', '0.1']) assert.equal(xrplIssuedValueOf(value), value);
    for (const value of ['1234567890123456', '1.234567890123456', '0', '1.50', '01', '-1', '1e3', ' 1', 1, '1'.padEnd(97, '0'), `0.${'0'.repeat(96)}1`]) assert.equal(xrplIssuedValueOf(value), undefined, String(value));
    assert.equal(xrplIssuedValueOf(`1${'0'.repeat(95)}`), `1${'0'.repeat(95)}`, 'exponent 80 is the ceiling');
    assert.equal(xrplIssuedValueOf(`1${'0'.repeat(96)}`), undefined);
    assert.equal(xrplIssuedValueOf(`0.${'0'.repeat(80)}1`), `0.${'0'.repeat(80)}1`, 'exponent −96 is the floor');
    assert.equal(xrplIssuedValueOf(`0.${'0'.repeat(81)}1`), undefined);
  });

  it('reads ledger-reported values back into canonical decimal without floating point', () => {
    for (const [ledger, canonical] of [['1250.5', '1250.5'], ['1e-15', '0.000000000000001'], ['125e1', '1250'], ['1.25E2', '125'], ['0.10', '0.1'], ['1000000000000000e-15', '1'], ['9999999999999999e80', `9999999999999999${'0'.repeat(80)}`]]) {
      assert.equal(canonicalDecimalOfLedgerValue(ledger), canonical, String(ledger));
    }
    for (const bad of ['-1', '', 'NaN', '1.', '.5', '1e', 1, null]) assert.equal(canonicalDecimalOfLedgerValue(bad), undefined, String(bad));
  });

  it('the signed blob carries exactly the canonical value — no float conversion end to end', async () => {
    const { rail, client } = harness();
    await rail.execute(request({ amount: { value: '0.000000000000001', unit: RLUSD_ASSET } }));
    const amount = (decode(client.submitted[0] as string) as { Amount: { value: string } }).Amount;
    assert.equal(canonicalDecimalOfLedgerValue(amount.value), '0.000000000000001');
  });
});

describe('PAY-02 X3 / X4 / X8 — the transaction is built from the granted request and trusted configuration only', () => {
  it('X8: maps the request onto exactly the expected XRPL Payment', () => {
    const configuration = testConfiguration();
    assert.deepEqual(buildXrplPayment(request(), configuration), {
      built: true,
      transaction: { TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, Amount: { currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '1250.5' }, Flags: 0 },
    });
    const tagged = buildXrplPayment(request({ destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` } }), configuration);
    assert.equal(tagged.built && tagged.transaction.DestinationTag, 4471);
  });

  it('X8: the submitted, signed transaction is exactly that payment plus the trusted Sequence, Fee and LastLedgerSequence — no memo, path, SendMax or flag', async () => {
    const { rail, client } = harness();
    const result = await rail.execute(request({ reference: 'INV-2026-0042', purpose: 'payroll' }));
    assert.equal(result.status, 'completed');
    const signed = decode(client.submitted[0] as string) as Record<string, unknown>;
    const { SigningPubKey, TxnSignature, ...fields } = signed;
    assert.equal(typeof SigningPubKey, 'string');
    assert.equal(typeof TxnSignature, 'string');
    assert.deepEqual(fields, {
      TransactionType: 'Payment',
      Account: TREASURY.classicAddress,
      Destination: VENDOR.classicAddress,
      Amount: { currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '1250.5' },
      Flags: 0,
      Sequence: 7,
      Fee: '12',
      LastLedgerSequence: 1001 + 20,
    });
    assert.equal(JSON.stringify(signed).includes('INV-2026-0042'), false, 'the business reference stays off-ledger');
  });

  it('X3: a payment not denominated in the configured RLUSD asset is refused — zero client calls', async () => {
    for (const unit of ['USD', 'stable:RLUSD/other-issuer', 'stable:RLUSD', 'xrpl:XRP']) {
      const { rail, client } = harness();
      assert.deepEqual(await rail.execute(request({ amount: { value: '10', unit } })), { status: 'not-completed', reason: F.ADAPTER_ERROR, detail: D.ASSET_NOT_CONFIGURED });
      assert.deepEqual(client.calls, { connect: 0, disconnect: 0, serverInfo: 0, validatedLedgerIndex: 0, autofill: 0, submit: 0, lookup: 0 });
    }
  });

  it('X4: a malformed or unsupported destination is refused — zero submissions, zero client calls', async () => {
    const cases: [PaymentExecutionRequest['destination'], string][] = [
      [{ kind: 'xrpl-account', reference: 'rNotAValidAddress' }, D.DESTINATION_INVALID],
      [{ kind: 'account', reference: 'vendor-4471' }, D.DESTINATION_INVALID],
      [{ kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:-5` }, D.DESTINATION_INVALID],
      [{ kind: 'xrpl-account', reference: TREASURY.classicAddress }, D.DESTINATION_IS_SOURCE],
      [{ kind: 'xrpl-account', reference: ISSUER.classicAddress }, D.DESTINATION_IS_ISSUER],
    ];
    for (const [destination, detail] of cases) {
      const { rail, client } = harness();
      assert.deepEqual(await rail.execute(request({ destination })), { status: 'not-completed', reason: F.ADAPTER_ERROR, detail }, JSON.stringify(destination));
      assert.equal(client.calls.connect + client.calls.submit, 0);
    }
  });

  it('an unmapped source account and an unrepresentable amount are refused before any contact', async () => {
    for (const [overrides, detail] of [
      [{ source: { accountId: 'someone-elses-account' } }, D.SOURCE_NOT_MAPPED],
      [{ amount: { value: '1.234567890123456', unit: RLUSD_ASSET } }, D.AMOUNT_NOT_REPRESENTABLE],
    ] as const) {
      const { rail, client } = harness();
      assert.deepEqual(await rail.execute(request(overrides as Partial<PaymentExecutionRequest>)), { status: 'not-completed', reason: F.ADAPTER_ERROR, detail });
      assert.equal(client.calls.connect, 0);
    }
  });
});

describe('PAY-02 — trusted preparation: autofill may add Sequence and Fee, nothing else', () => {
  const tampered: [string, NonNullable<FakeXrplScript['autofill']>][] = [
    ['destination swapped', (tx) => ({ ...tx, Destination: OTHER_SOURCE.classicAddress, Sequence: 7, Fee: '12' })],
    ['amount changed', (tx) => ({ ...tx, Amount: { ...tx.Amount, value: '9999' }, Sequence: 7, Fee: '12' })],
    ['issuer changed', (tx) => ({ ...tx, Amount: { ...tx.Amount, issuer: OTHER_SOURCE.classicAddress }, Sequence: 7, Fee: '12' })],
    ['partial-payment flag', (tx) => ({ ...tx, Flags: 131072, Sequence: 7, Fee: '12' })],
    ['memo added', (tx) => ({ ...tx, Memos: [{ Memo: { MemoData: 'AB' } }], Sequence: 7, Fee: '12' })],
    ['SendMax added', (tx) => ({ ...tx, SendMax: '1000000', Sequence: 7, Fee: '12' })],
    ['LastLedgerSequence moved', (tx) => ({ ...tx, LastLedgerSequence: tx.LastLedgerSequence + 1000, Sequence: 7, Fee: '12' })],
    ['NetworkID set', (tx) => ({ ...tx, NetworkID: 1, Sequence: 7, Fee: '12' })],
    ['no sequence', (tx) => ({ ...tx, Fee: '12' })],
    ['fee not drops', (tx) => ({ ...tx, Sequence: 7, Fee: '0.000012' })],
    ['not an object', () => 'tx'],
  ];
  for (const [label, autofill] of tampered) {
    it(`refuses an autofill with ${label} — nothing signed, nothing submitted`, async () => {
      const { rail, client, signer } = harness({ autofill });
      assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_RESPONSE_INVALID, detail: D.PREPARATION_INVALID });
      assert.equal(signer.signCount, 0);
      assert.equal(client.calls.submit, 0);
    });
  }

  it('refuses a network fee above the trusted ceiling — nothing signed', async () => {
    const { rail, client, signer } = harness({ autofill: (tx) => ({ ...tx, Sequence: 7, Fee: '1001' }) });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_REJECTED, detail: D.FEE_CEILING_EXCEEDED });
    assert.equal(signer.signCount + client.calls.submit, 0);
  });

  it('readAutofill answers only Sequence and Fee', () => {
    const built = { TransactionType: 'Payment', Account: 'a', Destination: 'b', Amount: { currency: 'c', issuer: 'd', value: '1' }, Flags: 0, LastLedgerSequence: 9 };
    assert.deepEqual(readAutofill({ ...built, NetworkID: undefined, Sequence: 3, Fee: '10' }, built), { Sequence: 3, Fee: '10' });
  });
});

describe('PAY-02 §17 — the signing boundary: a signature of exactly the prepared payment, or nothing is submitted', () => {
  function withSigner(sign: XrplTransactionSigner['sign']): Harness {
    const client = createFakeXrplClient();
    const real = createTestSoftwareXrplSigner(TREASURY);
    const rail = createXrplRlusdRail({ configuration: testConfiguration(), client, signers: [{ address: TREASURY.classicAddress, sign: (tx) => sign.call(real, tx) }], ...testClock() });
    return { rail, client, signer: real, logs: [] };
  }

  it('a signer that signs a different destination, adds a memo, or lies about the hash is refused before submission', async () => {
    const signers: XrplTransactionSigner['sign'][] = [
      async (tx) => {
        const { tx_blob, hash } = TREASURY.sign({ ...tx, Amount: { ...tx.Amount }, Destination: OTHER_SOURCE.classicAddress });
        return { signedTransaction: tx_blob, hash };
      },
      async (tx) => {
        const { tx_blob, hash } = TREASURY.sign({ ...tx, Amount: { ...tx.Amount }, Memos: [{ Memo: { MemoData: 'AB' } }] });
        return { signedTransaction: tx_blob, hash };
      },
      async (tx) => {
        const { tx_blob } = TREASURY.sign({ ...tx, Amount: { ...tx.Amount } });
        return { signedTransaction: tx_blob, hash: 'A'.repeat(64) };
      },
      async () => ({ signedTransaction: 'zz', hash: 'nope' }),
    ];
    for (const sign of signers) {
      const { rail, client } = withSigner(sign);
      assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.ADAPTER_ERROR, detail: D.SIGNATURE_MISMATCH });
      assert.equal(client.calls.submit, 0);
    }
  });

  it('a signer that throws or answers nothing is a definitive failure — nothing was submitted', async () => {
    for (const sign of [async () => Promise.reject(new Error('hsm offline')), async () => undefined as never, async () => 'blob' as never]) {
      const { rail, client } = withSigner(sign);
      assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.ADAPTER_ERROR, detail: D.SIGNING_FAILED });
      assert.equal(client.calls.submit, 0);
    }
  });

  it('signedPaymentMatches accepts the real signature of the prepared payment', () => {
    const prepared = { TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, Amount: { currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '1' }, Flags: 0, LastLedgerSequence: 50, Sequence: 3, Fee: '12' } as const;
    const { tx_blob, hash } = TREASURY.sign({ ...prepared, Amount: { ...prepared.Amount } });
    assert.equal(signedPaymentMatches(prepared, { signedTransaction: tx_blob, hash }), true);
  });
});

describe('PAY-02 X10 / X11 / X12 / X13 / X14 — submission versus finality', () => {
  it('X10: validated tesSUCCESS delivering exactly the granted amount → completed, reference = transaction hash', async () => {
    const { rail, client } = harness();
    const result = await rail.execute(request());
    assert.equal(result.status, 'completed');
    assert.match(result.externalReference ?? '', HASH);
    assert.equal(client.calls.submit, 1);
    assert.equal(client.calls.lookup, 1);
  });

  it('X10: a provisional tesSUCCESS is NOT completion — the rail waits for the validated ledger', async () => {
    const { rail, client } = harness({ lookup: (context) => (context.attempt < 3 ? { hash: context.hash, validated: false } : { hash: context.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: context.transaction['Amount'] } }) });
    assert.equal((await rail.execute(request())).status, 'completed');
    assert.equal(client.calls.lookup, 3);
  });

  it('X10: validated success that delivered anything other than the granted amount is never completed', async () => {
    for (const delivered of [{ currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '1250' }, { currency: RLUSD_CURRENCY_HEX, issuer: OTHER_SOURCE.classicAddress, value: '1250.5' }, '1250500000', undefined]) {
      const { rail } = harness({ lookup: (context) => ({ hash: context.hash, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: delivered } }) });
      const result = await rail.execute(request());
      assert.equal(result.status, 'unconfirmed');
      assert.equal(result.status === 'unconfirmed' && result.detail, D.DELIVERED_AMOUNT_MISMATCH);
    }
  });

  it('X11: a definitive validated failure → not-completed PROVIDER_REJECTED, detail = the bounded engine code, reference kept', async () => {
    for (const code of ['tecPATH_DRY', 'tecNO_LINE', 'tecUNFUNDED_PAYMENT', 'tecDST_TAG_NEEDED', 'tecNO_DST']) {
      const { rail } = harness({ lookup: validatedFailure(code) });
      const result = await rail.execute(request());
      assert.equal(result.status, 'not-completed');
      assert.equal(result.status === 'not-completed' && result.reason, F.PROVIDER_REJECTED);
      assert.equal(result.status === 'not-completed' && result.detail, code);
      assert.match(result.externalReference ?? '', HASH);
    }
  });

  it('X11: a tem… submit answer (malformed, never applied) is definitive; nothing is looked up', async () => {
    const { rail, client } = harness({ submit: (_blob, hash) => ({ engine_result: 'temBAD_AMOUNT', tx_json: { hash } }) });
    const result = await rail.execute(request());
    assert.deepEqual({ ...result, externalReference: '<hash>' }, { status: 'not-completed', reason: F.PROVIDER_REJECTED, externalReference: '<hash>', detail: 'temBAD_AMOUNT' });
    assert.equal(client.calls.lookup, 0);
  });

  it('X11: provisional tef / tel / ter answers are not treated as final — the validated ledger decides', async () => {
    for (const engine of ['tefPAST_SEQ', 'telINSUF_FEE_P', 'terQUEUED', 'tecPATH_DRY']) {
      const { rail } = harness({ submit: (_blob, hash) => ({ engine_result: engine, tx_json: { hash } }) });
      assert.equal((await rail.execute(request())).status, 'completed', `${engine} provisional, then validated success`);
    }
  });

  it('X11: provably never included — not found with complete history after LastLedgerSequence passed → not-completed, expired', async () => {
    const { rail, client } = harness({ validatedLedgerIndex: (call) => (call === 1 ? 1000 : 1000 + call * 10), lookup: () => ({ error: 'txnNotFound', searched_all: true }) });
    const result = await rail.execute(request());
    assert.equal(result.status, 'not-completed');
    assert.equal(result.status === 'not-completed' && result.detail, D.TRANSACTION_EXPIRED);
    assert.equal(client.calls.submit, 1);
  });

  it('X11: not found is NOT expiry while validation has not passed LastLedgerSequence, or history is incomplete', async () => {
    const before = harness({ validatedLedgerIndex: () => 1000, lookup: () => ({ error: 'txnNotFound', searched_all: true }) });
    assert.equal((await before.rail.execute(request())).status, 'unconfirmed');
    const incomplete = harness({ validatedLedgerIndex: (call) => 1000 + call * 50, lookup: () => ({ error: 'txnNotFound', searched_all: false }) });
    assert.equal((await incomplete.rail.execute(request())).status, 'unconfirmed');
  });

  it('X12: connection failure before submission → definitive not-completed PROVIDER_UNAVAILABLE, nothing submitted', async () => {
    const { rail, client } = harness({
      connect: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_UNAVAILABLE, detail: D.NETWORK_UNAVAILABLE });
    assert.equal(client.calls.submit, 0);
    assert.deepEqual(await rail.readiness(), { status: 'unavailable', detail: D.NETWORK_UNAVAILABLE });
  });

  it('X12: timeout during preparation (before submission) → definitive not-completed', async () => {
    const { rail, client } = harness({
      autofill: () => {
        throw new Error('Timeout for request');
      },
    });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_UNAVAILABLE, detail: D.PREPARATION_FAILED });
    assert.equal(client.calls.submit, 0);
  });

  it('X12: a client that proves the submission was never attempted → definitive not-completed', async () => {
    const { rail, client } = harness({
      submit: () => {
        throw new XrplSubmissionNotAttemptedError();
      },
    });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_UNAVAILABLE, detail: D.SUBMISSION_NOT_ATTEMPTED });
    assert.equal(client.calls.submit, 1, 'one attempt, which never left the process');
    assert.equal(client.calls.lookup, 0);
  });

  it('X13: a timeout or reset after the blob may have been written → unconfirmed with the transaction hash, never not-completed', async () => {
    for (const thrown of [new Error('Timeout for request: {"command":"submit"}'), new Error('websocket was closed'), Object.assign(new Error('DisconnectedError'), { name: 'DisconnectedError' })]) {
      const { rail, client } = harness({
        submit: () => {
          throw thrown;
        },
      });
      const result = await rail.execute(request());
      assert.equal(result.status, 'unconfirmed', thrown.message);
      assert.equal(result.status === 'unconfirmed' && result.detail, D.SUBMISSION_OUTCOME_UNKNOWN);
      assert.match(result.externalReference ?? '', HASH, 'the hash is known before submission, so P12 can look it up');
      assert.equal(client.calls.submit, 1);
    }
  });

  it('X13: no validated answer by the finality deadline → unconfirmed with the hash; lookup failures are not outcomes', async () => {
    let lookups = 0;
    const { rail, client } = harness({
      lookup: (context) => {
        lookups += 1;
        if (lookups % 2 === 0) throw new Error('timeout');
        return { hash: context.hash, validated: false };
      },
    });
    const result = await rail.execute(request());
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.status === 'unconfirmed' && result.detail, D.FINALITY_UNKNOWN);
    assert.equal(client.calls.submit, 1);
    assert.equal(client.calls.lookup, 60_000 / 1_000, 'one read per poll interval until the deadline');
  });

  it('X14: an unreadable submit answer → unconfirmed (the submission happened), never a definitive failure', async () => {
    for (const answer of [undefined, null, 'ok', {}, { engine_result: 42 }, { engine_result: 'tesSUCCESS!' }, { engine_result: 'tesSUCCESS', tx_json: { hash: 'B'.repeat(64) } }]) {
      const { rail, client } = harness({ submit: () => answer });
      const result = await rail.execute(request());
      assert.equal(result.status, 'unconfirmed', JSON.stringify(answer));
      assert.equal(result.status === 'unconfirmed' && result.detail, D.SUBMISSION_RESPONSE_UNREADABLE);
      assert.equal(client.calls.lookup, 0);
    }
  });

  it('X14: unreadable lookups are not outcomes; an unrecognized validated result is unconfirmed', async () => {
    const unreadable = harness({ lookup: () => ({ validated: true }) });
    assert.equal((await unreadable.rail.execute(request())).status, 'unconfirmed');
    const strange = harness({ lookup: (context) => ({ hash: context.hash, validated: true, meta: { TransactionResult: 'tefPAST_SEQ' } }) });
    const result = await strange.rail.execute(request());
    assert.equal(result.status === 'unconfirmed' && result.detail, D.RESULT_UNRECOGNIZED);
  });

  it('X14: a malformed validated-ledger index during preparation is a definitive refusal before submission', async () => {
    const { rail, client } = harness({ validatedLedgerIndex: () => 'latest' });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: F.PROVIDER_RESPONSE_INVALID, detail: D.PREPARATION_INVALID });
    assert.equal(client.calls.submit, 0);
  });

  it('the readers are total over hostile input', () => {
    const expected = { hash: 'A'.repeat(64), currency: RLUSD_CURRENCY_HEX, issuer: ISSUER.classicAddress, value: '1' };
    for (const raw of [undefined, null, 0, 'x', [], { error: 'internal' }, { hash: 'A'.repeat(64), validated: 'yes' }, { hash: 'A'.repeat(64), validated: true, meta: null }]) {
      assert.doesNotThrow(() => readLookup(raw, expected));
      assert.notEqual(readLookup(raw, expected).kind, 'validated-success');
      assert.doesNotThrow(() => readSubmission(raw, expected.hash));
    }
  });
});

describe('PAY-02 X15 — at most one XRPL submission per execution, whatever happens', () => {
  const scripts: [string, FakeXrplScript][] = [
    ['success', {}],
    ['validated failure', { lookup: validatedFailure('tecPATH_DRY') }],
    ['submit timeout', { submit: () => Promise.reject(new Error('timeout')) }],
    ['unreadable submit', { submit: () => ({}) }],
    ['finality never arrives', { lookup: (context) => ({ hash: context.hash, validated: false }) }],
    ['every lookup throws', { lookup: () => Promise.reject(new Error('reset')) }],
    ['malformed', { submit: (_blob, hash) => ({ engine_result: 'temREDUNDANT', tx_json: { hash } }) }],
    ['expired', { validatedLedgerIndex: (call) => 1000 + call * 30, lookup: () => ({ error: 'txnNotFound', searched_all: true }) }],
  ];
  for (const [label, script] of scripts) {
    it(`${label}: exactly one submit, one signature`, async () => {
      const { rail, client, signer } = harness(script);
      await rail.execute(request());
      assert.equal(client.calls.submit, 1);
      assert.equal(signer.signCount, 1);
      assert.equal(client.calls.autofill, 1, 'never re-prepared');
    });
  }

  it('a rail with a throwing logger, clock or sleeper still submits once and never reports a definitive failure after submission', async () => {
    const client = createFakeXrplClient();
    let clockCalls = 0;
    const rail = createXrplRlusdRail({
      configuration: testConfiguration(),
      client,
      signers: [createTestSoftwareXrplSigner(TREASURY)],
      now: () => {
        clockCalls += 1;
        if (clockCalls > 1) throw new Error('clock');
        return 0;
      },
      sleep: async () => undefined,
      logger: {
        info: () => {
          throw new Error('log sink down');
        },
        warn: () => {
          throw new Error('log sink down');
        },
      },
    });
    const result = await rail.execute(request());
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.status === 'unconfirmed' && result.detail, D.RAIL_ERROR_AFTER_SUBMISSION);
    assert.equal(client.calls.submit, 1);
  });

  it('concurrent payments from one source account are prepared and submitted one at a time (no shared Sequence)', async () => {
    const order: string[] = [];
    let sequence = 10;
    const { rail, client } = harness({
      autofill: (tx) => {
        order.push('autofill');
        sequence += 1;
        return { ...tx, Sequence: sequence, Fee: '12' };
      },
      submit: (_blob, hash) => {
        order.push('submit');
        return { engine_result: 'tesSUCCESS', tx_json: { hash } };
      },
    });
    const results = await Promise.all([rail.execute(request({ executionId: 'aoc.exec:a' })), rail.execute(request({ executionId: 'aoc.exec:b' }))]);
    assert.deepEqual(results.map((result) => result.status), ['completed', 'completed']);
    assert.deepEqual(order, ['autofill', 'submit', 'autofill', 'submit']);
    const sequences = client.submitted.map((blob) => (decode(blob) as { Sequence: number }).Sequence);
    assert.deepEqual(sequences, [11, 12]);
  });
});

describe('PAY-02 X20 — secret material never leaves the signer', () => {
  it('the signer’s secret appears in no result, log line or error, on any path', async () => {
    const scripts: FakeXrplScript[] = [{}, { lookup: validatedFailure('tecNO_LINE') }, { submit: () => Promise.reject(new Error('timeout')) }, { networkId: 0 }, { autofill: () => ({}) }];
    for (const script of scripts) {
      const { rail, signer, logs } = harness(script);
      const result: PaymentRailResult = await rail.execute(request());
      const observed = JSON.stringify({ result, logs });
      assert.equal(observed.includes(signer.canarySecret), false);
      assert.equal(/seed|private|secret|tx_blob|signedTransaction/i.test(observed), false, observed);
    }
  });

  it('logs carry bounded fields only: event, rail id, execution id, hash, engine code, detail — never an address, amount or endpoint', async () => {
    const { rail, logs } = harness();
    await rail.execute(request());
    assert.deepEqual(
      logs.map((line) => line.message),
      ['xrpl.payment.prepared', 'xrpl.payment.submitted', 'xrpl.payment.completed'],
    );
    for (const line of logs) {
      for (const key of Object.keys(line.fields as object)) assert.ok(['railId', 'executionId', 'transactionHash', 'engineResult', 'detail'].includes(key), key);
      const text = JSON.stringify(line.fields);
      for (const forbidden of [TREASURY.classicAddress, VENDOR.classicAddress, ISSUER.classicAddress, '1250.5', 'xrpl-test.invalid']) assert.equal(text.includes(forbidden), false, forbidden);
    }
  });
});

describe('PAY-02 — lifecycle', () => {
  it('connects lazily, verifies the network before every preparation, and closes on demand', async () => {
    const { rail, client } = harness();
    assert.equal(client.calls.connect, 0, 'composition opens nothing');
    await rail.execute(request());
    assert.equal(client.calls.connect, 1);
    assert.equal(client.calls.serverInfo, 1);
    await rail.close();
    assert.equal(client.calls.disconnect, 1);
  });

  it('the rail object is frozen; its id cannot be changed after composition', () => {
    const { rail } = harness();
    assert.equal(Object.isFrozen(rail), true);
    assert.throws(() => {
      (rail as { railId: string }).railId = 'other';
    });
  });

  it('createXrplRlusdRailConfiguration is the only way in', () => {
    assert.throws(() => createXrplRlusdRailConfiguration(undefined as never), XrplRailConfigurationError);
    assert.throws(() => createXrplRlusdRailConfiguration([] as never), XrplRailConfigurationError);
  });
});
