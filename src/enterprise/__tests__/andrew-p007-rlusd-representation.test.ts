import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANDREW_TESTNET_RLUSD_SETTLEMENT,
  AndrewSettlementConfigurationError,
  RLUSD_CURRENCY_CODE,
  RLUSD_XRPL_MAINNET_ISSUER,
  RLUSD_XRPL_TESTNET_ISSUER,
  andrewSettlementProfile,
  andrewXrplAdapterOptions,
  assertAndrewSettlement,
  createRecordingXrplTransport,
  type AndrewSettlementConfiguration,
} from '../andrew-demo/index.js';
import {
  XrplConfigurationError,
  checkXrplSettlement,
  createXrplExecutionAdapter,
  createXrplSettlementProfile,
  isXrplClassicAddress,
  isXrplNonStandardCurrencyCode,
  isXrplStandardCurrencyCode,
  type XrplExecutionAdapterOptions,
  type XrplPaymentSubmission,
} from '../execution-adapters/xrpl/index.js';
import { USD_ISSUED_OPTIONS, XRPL_DESTINATION, XRPL_ISSUER, XRPL_OTHER_ISSUER, createSpyXrplTransport, validatedAction, xrplKey } from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-07 — governed USD represented as RLUSD on XRPL Testnet, at the
 * adapter and settlement boundary. Offline; the property on every refusal is
 * **transport calls = 0**.
 */

const ADAPTER_ID = 'xrpl-testnet.treasury';
const TESTNET = 'xrpl.testnet';
const ANDREW = andrewXrplAdapterOptions(ADAPTER_ID);
const testnetAction = (overrides: Parameters<typeof validatedAction>[0] = {}) => validatedAction({ counterparty: xrplKey(XRPL_DESTINATION, TESTNET), ...overrides });

function configurationError(options: unknown): XrplConfigurationError {
  try {
    createXrplExecutionAdapter(options as XrplExecutionAdapterOptions, createSpyXrplTransport());
  } catch (error) {
    assert.ok(error instanceof XrplConfigurationError, String(error));
    return error;
  }
  return assert.fail('construction should have failed');
}

const pinned = (overrides: Record<string, unknown> = {}, assetId = 'USD') => ({
  adapterId: ADAPTER_ID,
  namespace: TESTNET,
  network: 'xrpl-testnet',
  assets: [{ assetId, representation: { kind: 'pinned', denominates: assetId, currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, ...overrides } }],
});

describe('ANDREW-P0-07 — the RLUSD 160-bit currency code', () => {
  it('accepts the RLUSD code, which independently encodes "RLUSD" zero-padded to 160 bits', () => {
    assert.equal(RLUSD_CURRENCY_CODE, '524C555344000000000000000000000000000000');
    assert.equal(Buffer.from('RLUSD', 'ascii').toString('hex').toUpperCase().padEnd(40, '0'), RLUSD_CURRENCY_CODE);
    assert.equal(Buffer.from(RLUSD_CURRENCY_CODE, 'hex').subarray(0, 5).toString('ascii'), 'RLUSD');
    assert.equal(isXrplNonStandardCurrencyCode(RLUSD_CURRENCY_CODE), true);
    assert.equal(isXrplStandardCurrencyCode(RLUSD_CURRENCY_CODE), false, 'a 160-bit code is never a standard code');
  });

  it('accepts only exactly 40 uppercase hex digits: no case folding, no padding, no other length', () => {
    for (const value of [
      RLUSD_CURRENCY_CODE.toLowerCase(),
      `524c555344${'0'.repeat(30)}`,
      RLUSD_CURRENCY_CODE.slice(0, 39),
      `${RLUSD_CURRENCY_CODE}0`,
      ` ${RLUSD_CURRENCY_CODE}`,
      `${RLUSD_CURRENCY_CODE} `,
      `0x${RLUSD_CURRENCY_CODE.slice(2)}`,
      `524C55534G${'0'.repeat(30)}`,
      'RLUSD',
      'USD',
      '',
      42,
      null,
      undefined,
    ]) {
      assert.equal(isXrplNonStandardCurrencyCode(value), false, JSON.stringify(value));
    }
  });

  it('refuses a hex code in the standard layout (first byte 0x00): it would be a second spelling of a standard code or of XRP', () => {
    const standardUsd = `${'00'.repeat(12)}555344${'00'.repeat(5)}`; // "USD" in XRPL's 160-bit standard layout
    assert.equal(standardUsd.length, 40);
    assert.equal(isXrplNonStandardCurrencyCode(standardUsd), false);
    assert.equal(isXrplNonStandardCurrencyCode('0'.repeat(40)), false, 'all zeros is XRP');
    assert.equal(isXrplNonStandardCurrencyCode(`01${'0'.repeat(38)}`), true, 'any first byte other than 0x00 is the nonstandard layout');
  });

  it('the verified Testnet and Mainnet issuers are checksum-valid classic addresses, and different', () => {
    assert.equal(isXrplClassicAddress(RLUSD_XRPL_TESTNET_ISSUER), true);
    assert.equal(isXrplClassicAddress(RLUSD_XRPL_MAINNET_ISSUER), true);
    assert.notEqual(RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER);
  });
});

describe('ANDREW-P0-07 — governed USD as Testnet RLUSD: exact value, no FX', () => {
  for (const value of ['75000', '0.01', '74999.99', '100000', '0.000001', '123456789.123456']) {
    it(`governed USD ${value} becomes RLUSD value "${value}", byte for byte`, async () => {
      const transport = createSpyXrplTransport();
      const result = await createXrplExecutionAdapter(ANDREW, transport).execute(testnetAction({ amount: { value, unit: 'USD' } }));
      assert.equal(result.outcome, 'completed');
      assert.equal(transport.submissions.length, 1);
      assert.equal(
        JSON.stringify(transport.submissions[0]?.instruction),
        JSON.stringify({ TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value } }),
      );
    });
  }

  it('is deterministic: the same action yields byte-identical submissions', async () => {
    const transport = createSpyXrplTransport();
    const adapter = createXrplExecutionAdapter(ANDREW, transport);
    await adapter.execute(testnetAction());
    await adapter.execute(testnetAction());
    assert.equal(JSON.stringify(transport.submissions[0]), JSON.stringify(transport.submissions[1]));
  });

  it('refuses an amount RLUSD cannot state exactly instead of rounding it; transport 0', async () => {
    for (const value of ['9007199254740993', '0.30000000000000004', '1234567890123456']) {
      const transport = createSpyXrplTransport();
      const result = await createXrplExecutionAdapter(ANDREW, transport).execute(testnetAction({ amount: { value, unit: 'USD' } }));
      assert.equal(result.outcome, 'failed', value);
      assert.equal(transport.submissions.length, 0, value);
    }
  });

  it('EUR cannot use the USD → RLUSD representation: unmapped, never converted; transport 0', async () => {
    for (const unit of ['EUR', 'usd', 'RLUSD', RLUSD_CURRENCY_CODE, `xrpl:USD/${RLUSD_XRPL_TESTNET_ISSUER}`, 'xrpl:XRP']) {
      const transport = createSpyXrplTransport();
      const result = await createXrplExecutionAdapter(ANDREW, transport).execute(testnetAction({ amount: { value: '75000', unit } }));
      assert.equal(result.outcome, 'failed', unit);
      assert.equal(transport.submissions.length, 0, unit);
    }
  });

  it('the action cannot substitute issuer, currency, network or mapping: undeclared fields are never read', async () => {
    const transport = createSpyXrplTransport();
    const adapter = createXrplExecutionAdapter(ANDREW, transport);
    await adapter.execute(testnetAction());
    const forged = { ...testnetAction(), issuer: RLUSD_XRPL_MAINNET_ISSUER, currency: 'USD', network: 'xrpl-mainnet', mapping: 'rate:2', parameters: { issuer: XRPL_OTHER_ISSUER, currency: 'EUR', network: 'xrpl-mainnet' } };
    await adapter.execute(forged as unknown as ReturnType<typeof testnetAction>);
    assert.equal(transport.submissions.length, 2);
    assert.equal(JSON.stringify(transport.submissions[1]), JSON.stringify(transport.submissions[0]));
    assert.equal(transport.submissions[1]?.network, 'xrpl-testnet');
  });

  it('serves only the Testnet namespace: the same address as xrpl:, xrpl.mainnet: or bare is refused; transport 0', async () => {
    for (const counterparty of [xrplKey(XRPL_DESTINATION), xrplKey(XRPL_DESTINATION, 'xrpl.mainnet'), xrplKey(XRPL_DESTINATION, 'XRPL.TESTNET'), XRPL_DESTINATION, `xrpl.testnet:${XRPL_DESTINATION.toLowerCase()}`]) {
      const transport = createSpyXrplTransport();
      const result = await createXrplExecutionAdapter(ANDREW, transport).execute(testnetAction({ counterparty }));
      assert.equal(result.outcome, 'failed', counterparty);
      assert.equal(transport.submissions.length, 0, counterparty);
    }
  });

  it('every submission carries the configured network label; an adapter configured without one is unchanged (P0-06)', async () => {
    const transport = createSpyXrplTransport();
    await createXrplExecutionAdapter(ANDREW, transport).execute(testnetAction());
    assert.deepEqual(Object.keys(transport.submissions[0] ?? {}), ['instruction', 'executionId', 'requestId', 'decisionId', 'notAfter', 'network']);
    assert.equal(transport.submissions[0]?.network, 'xrpl-testnet');
    const legacy = createSpyXrplTransport();
    await createXrplExecutionAdapter(USD_ISSUED_OPTIONS, legacy).execute(validatedAction());
    assert.deepEqual(Object.keys(legacy.submissions[0] ?? {}), ['instruction', 'executionId', 'requestId', 'decisionId', 'notAfter']);
  });
});

describe('ANDREW-P0-07 — a pinned representation is a declared carrier, never a rate', () => {
  it('accepts the canonical pinned mapping', () => {
    assert.doesNotThrow(() => createXrplExecutionAdapter(pinned() as XrplExecutionAdapterOptions, createSpyXrplTransport()));
  });

  it('has no field for a rate, factor, oracle or conversion — each such field is refused', () => {
    for (const key of ['rate', 'factor', 'multiplier', 'oracle', 'conversion', 'fx', 'scale', 'network']) {
      assert.equal(configurationError(pinned({ [key]: '1' })).code, 'XRPL_OPTIONS_INVALID', key);
    }
  });

  it('`denominates` must restate the governed asset exactly', () => {
    for (const denominates of ['EUR', 'usd', 'USD ', 'RLUSD', undefined]) {
      assert.equal(configurationError(pinned({ denominates })).code, 'XRPL_ASSET_MAPPING_INVALID', String(denominates));
    }
  });

  it('only a bare governed unit may be pinned: an asset id naming a rail or an issuer is refused', () => {
    for (const assetId of ['xrpl:USD', `USD/${RLUSD_XRPL_TESTNET_ISSUER}`, `xrpl:USD/${RLUSD_XRPL_TESTNET_ISSUER}`]) {
      assert.equal(configurationError(pinned({ denominates: assetId }, assetId)).code, 'XRPL_ASSET_MAPPING_INVALID', assetId);
    }
  });

  it('only a canonical 160-bit token code may be pinned; a standard code must use `issued`, where it has to equal the asset', () => {
    for (const currency of ['USD', 'EUR', RLUSD_CURRENCY_CODE.toLowerCase(), `00${RLUSD_CURRENCY_CODE.slice(2)}`, 'RLUSD']) {
      assert.equal(configurationError(pinned({ currency })).code, 'XRPL_CURRENCY_INVALID', currency);
    }
    // `issued` still refuses conversion by configuration, and refuses a 160-bit code outright.
    assert.equal(configurationError({ adapterId: ADAPTER_ID, assets: [{ assetId: 'EUR', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER } }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'issued', currency: RLUSD_CURRENCY_CODE, issuer: XRPL_ISSUER } }] }).code, 'XRPL_CURRENCY_INVALID');
  });

  it('an invalid issuer fails construction', () => {
    for (const issuer of ['rNotAnAddress', RLUSD_XRPL_TESTNET_ISSUER.toLowerCase(), '', 42]) {
      assert.equal(configurationError(pinned({ issuer })).code, 'XRPL_ISSUER_INVALID', String(issuer));
    }
  });

  it('one token cannot carry two governed assets: USD and EUR both pinned to RLUSD is an alias, refused', () => {
    const options = {
      adapterId: ADAPTER_ID,
      namespace: TESTNET,
      assets: [
        { assetId: 'USD', representation: { kind: 'pinned', denominates: 'USD', currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER } },
        { assetId: 'EUR', representation: { kind: 'pinned', denominates: 'EUR', currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER } },
      ],
    };
    assert.equal(configurationError(options).code, 'XRPL_ASSET_MAPPING_INVALID');
  });

  it('the configuration is snapshotted: mutating it afterwards changes nothing sent', async () => {
    const mutable = JSON.parse(JSON.stringify(pinned())) as { network: string; assets: { representation: { issuer: string; currency: string } }[] };
    const transport = createSpyXrplTransport();
    const adapter = createXrplExecutionAdapter(mutable as unknown as XrplExecutionAdapterOptions, transport);
    mutable.network = 'xrpl-mainnet';
    const representation = mutable.assets[0]?.representation;
    assert.ok(representation !== undefined);
    representation.issuer = RLUSD_XRPL_MAINNET_ISSUER;
    representation.currency = 'USD';
    await adapter.execute(testnetAction());
    assert.equal(transport.submissions[0]?.network, 'xrpl-testnet');
    assert.deepEqual(transport.submissions[0]?.instruction.Amount, { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' });
  });
});

describe('ANDREW-P0-07 — the settlement check: configuration drift fails closed at the transport', () => {
  const profile = andrewSettlementProfile();
  function submission(overrides: Partial<XrplPaymentSubmission> = {}, amount: XrplPaymentSubmission['instruction']['Amount'] = { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' }): XrplPaymentSubmission {
    return { instruction: { TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: amount }, executionId: 'e', requestId: 'r', decisionId: 'd', notAfter: '2026-01-01T00:00:00.000Z', network: 'xrpl-testnet', ...overrides };
  }

  it('accepts exactly the Testnet RLUSD submission', () => {
    assert.deepEqual(checkXrplSettlement(profile, submission()), { ok: true });
  });

  it('refuses a submission with no network, or for another network', () => {
    const { network: _drop, ...withoutNetwork } = submission();
    void _drop;
    assert.deepEqual(checkXrplSettlement(profile, withoutNetwork), { ok: false, refusal: 'network-missing' });
    for (const network of ['xrpl-mainnet', 'xrpl-devnet', 'XRPL-TESTNET', 'xrpl-testnet ']) {
      assert.deepEqual(checkXrplSettlement(profile, submission({ network })), { ok: false, refusal: 'network-mismatch' }, network);
    }
  });

  it('refuses another issuer (including Mainnet RLUSD), another currency, or XRP', () => {
    for (const amount of [
      { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_MAINNET_ISSUER, value: '75000' },
      { currency: RLUSD_CURRENCY_CODE, issuer: XRPL_OTHER_ISSUER, value: '75000' },
      { currency: 'USD', issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' },
      { currency: RLUSD_CURRENCY_CODE.toLowerCase(), issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' },
      '75000000000',
    ]) {
      assert.deepEqual(checkXrplSettlement(profile, submission({}, amount)), { ok: false, refusal: 'token-not-settled' }, JSON.stringify(amount));
    }
  });

  it('a profile is validated at construction', () => {
    const refusedWith = (code: string) => (error: unknown) => error instanceof XrplConfigurationError && error.code === code;
    assert.throws(() => createXrplSettlementProfile({ network: 'wss://ledger.example', tokens: [{ currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER }] }), refusedWith('XRPL_NETWORK_INVALID'));
    assert.throws(() => createXrplSettlementProfile({ network: 'xrpl-testnet', tokens: [] }), refusedWith('XRPL_OPTIONS_INVALID'));
    assert.throws(() => createXrplSettlementProfile({ network: 'xrpl-testnet', tokens: [{ currency: 'XRP', issuer: RLUSD_XRPL_TESTNET_ISSUER }] }), refusedWith('XRPL_CURRENCY_INVALID'));
    assert.throws(() => createXrplSettlementProfile({ network: 'xrpl-testnet', tokens: [{ currency: RLUSD_CURRENCY_CODE, issuer: 'rNope' }] }), refusedWith('XRPL_ISSUER_INVALID'));
    const token = { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER };
    assert.throws(() => createXrplSettlementProfile({ network: 'xrpl-testnet', tokens: [token, token] }), refusedWith('XRPL_OPTIONS_INVALID'));
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.tokens));
  });

  it('the recording transport records, checks settlement, and never claims a settled payment or a hash', async () => {
    const transport = createRecordingXrplTransport(profile);
    const good = await transport.submitPayment(submission());
    const drifted = await transport.submitPayment(submission({ network: 'xrpl-mainnet' }));
    assert.deepEqual(good, { kind: 'not-submitted' });
    assert.deepEqual(drifted, { kind: 'not-submitted' });
    assert.equal(transport.accepted.length, 1);
    assert.deepEqual(transport.refused.map((entry) => entry.refusal), ['network-mismatch']);
  });
});

describe('ANDREW-P0-07 — the Andrew settlement is pinned to Testnet RLUSD; any drift refuses startup', () => {
  const drift = (overrides: Partial<AndrewSettlementConfiguration>) => () => assertAndrewSettlement({ ...ANDREW_TESTNET_RLUSD_SETTLEMENT, ...overrides });
  /** The right error, and a message that never echoes an address-shaped or hex-code value. */
  const refused = (error: unknown) => error instanceof AndrewSettlementConfigurationError && !/r[1-9A-HJ-NP-Za-km-z]{24,}|[0-9A-Fa-f]{40}/.test(error.message);

  it('the default is valid, frozen, and exactly the verified Testnet values', () => {
    const settlement = assertAndrewSettlement();
    assert.deepEqual(settlement, { network: 'xrpl-testnet', destinationNamespace: 'xrpl.testnet', governedAsset: 'USD', currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER });
    assert.ok(Object.isFrozen(settlement) && Object.isFrozen(ANDREW_TESTNET_RLUSD_SETTLEMENT));
  });

  it('refuses the Mainnet RLUSD issuer by name, and any other issuer — without echoing it', () => {
    assert.throws(drift({ issuer: RLUSD_XRPL_MAINNET_ISSUER }), (error: unknown) => refused(error) && /Mainnet/.test((error as Error).message));
    assert.throws(drift({ issuer: XRPL_OTHER_ISSUER }), refused);
  });

  it('refuses another network, another namespace, another currency or another governed asset', () => {
    for (const overrides of [
      { network: 'xrpl-mainnet' },
      { network: 'xrpl-devnet' },
      { destinationNamespace: 'xrpl' },
      { destinationNamespace: 'xrpl.mainnet' },
      { currency: 'USD' },
      { currency: RLUSD_CURRENCY_CODE.toLowerCase() },
      { currency: `${RLUSD_CURRENCY_CODE.slice(0, 39)}1` },
      { governedAsset: 'EUR' },
    ] as const) {
      assert.throws(drift(overrides), refused, JSON.stringify(overrides));
    }
  });

  it('adapter options and transport profile are derived from the same validated settlement', () => {
    assert.deepEqual(ANDREW, {
      adapterId: ADAPTER_ID,
      namespace: 'xrpl.testnet',
      network: 'xrpl-testnet',
      assets: [{ assetId: 'USD', representation: { kind: 'pinned', denominates: 'USD', currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER } }],
    });
    assert.deepEqual(andrewSettlementProfile(), { network: 'xrpl-testnet', tokens: [{ currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER }] });
    assert.throws(() => andrewXrplAdapterOptions(ADAPTER_ID, { ...ANDREW_TESTNET_RLUSD_SETTLEMENT, issuer: RLUSD_XRPL_MAINNET_ISSUER }), AndrewSettlementConfigurationError);
    assert.throws(() => andrewSettlementProfile({ ...ANDREW_TESTNET_RLUSD_SETTLEMENT, network: 'xrpl-mainnet' }), AndrewSettlementConfigurationError);
  });
});
