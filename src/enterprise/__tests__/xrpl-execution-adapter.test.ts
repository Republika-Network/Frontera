import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_FAILURE_REASONS, createExecutionAdapterRegistry, readExecutionAdapterResult, type ExecutionAdapter, type ExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import {
  XRPL_DESTINATION_NAMESPACE,
  XrplConfigurationError,
  createXrplExecutionAdapter,
  isXrplClassicAddress,
  isXrplStandardCurrencyCode,
  xrplDropsFromXrp,
  xrplIssuedCurrencyValue,
  type XrplExecutionAdapterOptions,
  type XrplIssuedCurrencyAmount,
  type XrplPaymentTransport,
  type XrplSubmissionObservation,
} from '../execution-adapters/xrpl/index.js';
import {
  FIXTURE_TRANSACTION_HASH,
  USD_ISSUED_OPTIONS,
  XRPL_ACCOUNT_ONE,
  XRPL_ACCOUNT_ZERO,
  XRPL_ADAPTER_ID,
  XRPL_CORRUPT_DESTINATION,
  XRPL_DESTINATION,
  XRPL_GENESIS_ACCOUNT,
  XRPL_ISSUER,
  XRPL_OTHER_DESTINATION,
  XRPL_OTHER_ISSUER,
  createSpyXrplTransport,
  validatedAction,
  xrplKey,
} from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-06 — the XRPL Execution Adapter at its own boundary: translation,
 * configuration, exact money and transport-outcome mapping. Offline: the
 * transport is an in-memory spy, and the property that matters on every
 * refusal is **transport calls = 0**.
 */

function adapterWith(options: XrplExecutionAdapterOptions = USD_ISSUED_OPTIONS, respond?: Parameters<typeof createSpyXrplTransport>[0]) {
  const transport = createSpyXrplTransport(respond);
  return { adapter: createXrplExecutionAdapter(options, transport), transport };
}

const USD_AND_XRP: XrplExecutionAdapterOptions = {
  adapterId: XRPL_ADAPTER_ID,
  assets: [
    { assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER } },
    { assetId: 'xrpl:XRP', representation: { kind: 'native' } },
  ],
};

function issuedAmount(adapterTransport: ReturnType<typeof createSpyXrplTransport>): XrplIssuedCurrencyAmount {
  const amount = adapterTransport.submissions[0]?.instruction.Amount;
  assert.equal(typeof amount, 'object', 'an issued-currency amount is an object');
  return amount as XrplIssuedCurrencyAmount;
}

function configurationError(options: unknown, transport: unknown = createSpyXrplTransport()): XrplConfigurationError {
  try {
    createXrplExecutionAdapter(options as XrplExecutionAdapterOptions, transport as XrplPaymentTransport);
  } catch (error) {
    assert.ok(error instanceof XrplConfigurationError, String(error));
    return error;
  }
  assert.fail('construction should have failed');
}

const ADAPTER_ERROR = { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR };

function assertRefused(result: ExecutionAdapterResult, detail: RegExp): void {
  assert.equal(result.outcome, ADAPTER_ERROR.outcome);
  assert.equal(result.outcome === 'failed' ? result.reason : undefined, ADAPTER_ERROR.reason);
  assert.match(result.outcome === 'failed' ? (result.detail ?? '') : '', detail);
  assert.equal(result.providerRef, undefined, 'a refusal before submission carries no reference');
}

describe('ANDREW-P0-06 — the adapter conforms to the existing ExecutionAdapter port', () => {
  it('is an ExecutionAdapter: an adapterId and an execute that resolves to a well-formed result', async () => {
    const { adapter } = adapterWith();
    const port: ExecutionAdapter = adapter;
    assert.equal(port.adapterId, XRPL_ADAPTER_ID);
    assert.equal(typeof port.execute, 'function');
    const result = await port.execute(validatedAction());
    assert.deepEqual(readExecutionAdapterResult(result), result, 'the result survives the port reader unchanged');
    assert.equal(Object.isFrozen(adapter), true);
  });

  it('is a valid child of the existing registry, which attributes the effect to it and routes other actions elsewhere', async () => {
    const { adapter, transport } = adapterWith();
    const otherCalls: string[] = [];
    const other: ExecutionAdapter = { adapterId: 'test.other', execute: async (action) => (otherCalls.push(action.action), { outcome: 'completed' }) };
    const registry = createExecutionAdapterRegistry({ adapters: [other, adapter], selectAdapter: (action) => (action.action === 'transfer-funds' ? XRPL_ADAPTER_ID : 'test.other') });

    assert.deepEqual(await registry.execute(validatedAction()), { outcome: 'completed', providerRef: FIXTURE_TRANSACTION_HASH, adapterId: XRPL_ADAPTER_ID });
    assert.equal(transport.submissions.length, 1);
    assert.deepEqual(await registry.execute(validatedAction({ action: 'deploy-release' })), { outcome: 'completed', adapterId: 'test.other' });
    assert.equal(transport.submissions.length, 1, 'an action routed elsewhere never reaches the XRPL transport');
    assert.deepEqual(otherCalls, ['deploy-release']);
  });
});

describe('ANDREW-P0-06 — canonical USD 75,000 as issued USD', () => {
  it('produces exactly one deterministic Payment instruction: destination preserved, value "75000", issuer from configuration', async () => {
    const { adapter, transport } = adapterWith();
    const result = await adapter.execute(validatedAction());

    assert.deepEqual(result, { outcome: 'completed', providerRef: FIXTURE_TRANSACTION_HASH });
    assert.equal(transport.submissions.length, 1, 'transport called exactly once');
    const submission = transport.submissions[0];
    assert.deepEqual(submission, {
      instruction: { TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: { currency: 'USD', issuer: XRPL_ISSUER, value: '75000' } },
      executionId: 'exec-p006-1',
      requestId: 'req-p006-1',
      decisionId: 'decision-p006-1',
      notAfter: '2026-01-01T13:00:00.000Z',
    });
    assert.deepEqual(Object.keys(submission?.instruction ?? {}), ['TransactionType', 'Destination', 'Amount'], 'no Account, Fee, Sequence, LastLedgerSequence, Flags, SendMax, Paths, DestinationTag or Memos');
    assert.deepEqual(Object.keys(issuedAmount(transport)), ['currency', 'issuer', 'value']);
    assert.equal(Object.isFrozen(submission), true);
    assert.equal(Object.isFrozen(submission?.instruction), true);
    assert.equal(Object.isFrozen(submission?.instruction.Amount), true);
  });

  it('is deterministic: the same action yields byte-identical instructions', async () => {
    const { adapter, transport } = adapterWith();
    await adapter.execute(validatedAction());
    await adapter.execute(validatedAction());
    assert.equal(JSON.stringify(transport.submissions[0]), JSON.stringify(transport.submissions[1]));
  });

  it('the issuer comes only from configuration: the action has no field that can name one', async () => {
    const other = adapterWith({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_OTHER_ISSUER } }] });
    await other.adapter.execute(validatedAction());
    assert.equal(issuedAmount(other.transport).issuer, XRPL_OTHER_ISSUER);
    const smuggled = { ...validatedAction(), issuer: XRPL_ISSUER, currency: 'EUR', destination: XRPL_OTHER_DESTINATION } as unknown as ReturnType<typeof validatedAction>;
    await other.adapter.execute(smuggled);
    assert.deepEqual(other.transport.submissions[1]?.instruction, other.transport.submissions[0]?.instruction, 'undeclared action fields are never read');
  });

  it('USD is never XRP: with both mapped, a USD amount is sent as issued USD, never as drops', async () => {
    const { adapter, transport } = adapterWith(USD_AND_XRP);
    await adapter.execute(validatedAction());
    assert.deepEqual(transport.submissions[0]?.instruction.Amount, { currency: 'USD', issuer: XRPL_ISSUER, value: '75000' });
  });
});

describe('ANDREW-P0-06 — destination namespace', () => {
  it('serves the canonical xrpl namespace by default', () => {
    assert.equal(XRPL_DESTINATION_NAMESPACE, 'xrpl');
  });

  for (const counterparty of [`lightning:${XRPL_DESTINATION}`, `XRPL:${XRPL_DESTINATION}`, `xrp:${XRPL_DESTINATION}`, `ripple:${XRPL_DESTINATION}`, `xrpl-mainnet:${XRPL_DESTINATION}`, `xrpl.testnet:${XRPL_DESTINATION}`]) {
    it(`refuses ${counterparty.slice(0, counterparty.indexOf(':'))}: — no reinterpretation, no stripping; transport 0`, async () => {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(validatedAction({ counterparty })), /not in the namespace|not a canonical destination key/);
      assert.equal(transport.submissions.length, 0);
    });
  }

  it('a deployment-stated namespace is served exactly, and the default namespace is then refused', async () => {
    const { adapter, transport } = adapterWith({ ...USD_ISSUED_OPTIONS, namespace: 'xrpl.testnet' });
    assert.equal((await adapter.execute(validatedAction({ counterparty: xrplKey(XRPL_DESTINATION, 'xrpl.testnet') }))).outcome, 'completed');
    assertRefused(await adapter.execute(validatedAction()), /not in the namespace/);
    assert.equal(transport.submissions.length, 1);
    assert.equal(transport.submissions[0]?.instruction.Destination, XRPL_DESTINATION, 'the namespace never reaches the instruction');
  });

  it('refuses a namespace configuration that is not xrpl or xrpl.<label>', () => {
    for (const namespace of ['lightning', 'XRPL', 'xrp', 'xrpl:main', 'xrpl.', '', 7]) {
      assert.equal(configurationError({ ...USD_ISSUED_OPTIONS, namespace }).code, 'XRPL_NAMESPACE_INVALID', String(namespace));
    }
  });

  for (const [label, action] of [
    ['no counterparty', validatedAction({ counterparty: undefined as unknown as string })],
    ['a bare address with no namespace', validatedAction({ counterparty: XRPL_DESTINATION })],
    ['a counterparty that is not a canonical destination key', validatedAction({ counterparty: `xrpl: ${XRPL_DESTINATION}` })],
    ['an empty namespace', validatedAction({ counterparty: `:${XRPL_DESTINATION}` })],
  ] as const) {
    it(`refuses ${label}; transport 0`, async () => {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(action), /destination/);
      assert.equal(transport.submissions.length, 0);
    });
  }
});

describe('ANDREW-P0-06 — XRPL address validity is the adapter’s check, and only an address check', () => {
  it('accepts checksum-valid classic addresses, including the public genesis and special-account vectors', () => {
    for (const address of [XRPL_DESTINATION, XRPL_ISSUER, XRPL_OTHER_DESTINATION, XRPL_OTHER_ISSUER, XRPL_GENESIS_ACCOUNT, XRPL_ACCOUNT_ZERO, XRPL_ACCOUNT_ONE]) {
      assert.equal(isXrplClassicAddress(address), true, address);
    }
  });

  it('refuses checksum failures, X-addresses, foreign alphabets, re-spellings and non-strings', () => {
    for (const value of [
      XRPL_CORRUPT_DESTINATION,
      'XVPcpSm47b1CZkf5AkKM9a84dQHe3m4sBhsrA4XtnBECTAc',
      XRPL_DESTINATION.toLowerCase(),
      XRPL_DESTINATION.slice(1),
      `r${XRPL_DESTINATION}`,
      `${XRPL_DESTINATION} `,
      'r0OIl00000000000000000000000000',
      'sEdFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
      '0x5e19749997a435ed6b80541a2890356de14c4d3f',
      '',
      null,
      42,
    ]) {
      assert.equal(isXrplClassicAddress(value), false, String(value));
    }
  });

  it('an invalid address is refused before the transport — however it was registered or approved', async () => {
    for (const identifier of [XRPL_CORRUPT_DESTINATION, 'rNotAnXrplAddress', 'abc123', 'scheme://destination/123']) {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(validatedAction({ counterparty: xrplKey(identifier) })), /not a valid XRPL classic address/);
      assert.equal(transport.submissions.length, 0, identifier);
    }
  });

  it('the destination is never substituted: a different valid address is sent as itself, exactly', async () => {
    const { adapter, transport } = adapterWith();
    await adapter.execute(validatedAction({ counterparty: xrplKey(XRPL_OTHER_DESTINATION) }));
    assert.equal(transport.submissions[0]?.instruction.Destination, XRPL_OTHER_DESTINATION);
  });
});

describe('ANDREW-P0-06 — explicit asset mapping, no FX', () => {
  for (const unit of ['EUR', 'usd', 'USD ', 'xrpl:USD/' + XRPL_ISSUER, 'xrpl:XRP', 'USDC']) {
    it(`an amount in '${unit}' with only USD mapped is refused as unmapped — no conversion, no XRP fallback; transport 0`, async () => {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(validatedAction({ amount: { value: '75000', unit } })), /no configured XRPL representation/);
      assert.equal(transport.submissions.length, 0);
    });
  }

  it('refuses at construction a mapping that would convert: EUR → issued USD, USD → native XRP, an issuer other than the asset id names', () => {
    const issued = (assetId: string, currency = 'USD', issuer = XRPL_ISSUER) => ({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId, representation: { kind: 'issued', currency, issuer } }] });
    assert.equal(configurationError(issued('EUR')).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError(issued('xrpl:EUR/' + XRPL_ISSUER)).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError(issued('xrpl:USD/' + XRPL_OTHER_ISSUER)).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError(issued('stellar:USD')).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'native' } }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'xrpl:XRP/' + XRPL_ISSUER, representation: { kind: 'native' } }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    // The same issuer stated by the asset id is consistent and accepted.
    assert.doesNotThrow(() => createXrplExecutionAdapter(issued('xrpl:USD/' + XRPL_ISSUER) as XrplExecutionAdapterOptions, createSpyXrplTransport()));
  });

  it('refuses aliases and duplicates: one Frontera asset per XRPL amount, one mapping per asset', () => {
    const usd = { assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER } };
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [usd, usd] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [usd, { ...usd, assetId: 'xrpl:USD/' + XRPL_ISSUER }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'XRP', representation: { kind: 'native' } }, { assetId: 'xrpl:XRP', representation: { kind: 'native' } }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [] }).code, 'XRPL_ASSET_MAPPING_INVALID');
  });
});

describe('ANDREW-P0-06 — issuer and currency configuration fail fast', () => {
  it('an invalid issuer fails construction, before any traffic, without echoing it', () => {
    for (const issuer of [XRPL_CORRUPT_DESTINATION, 'rIssuerA', '', 'sEdFAKEFAKEFAKEFAKEFAKEFAKEFAKE', 42, undefined]) {
      const error = configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer } }] });
      assert.equal(error.code, 'XRPL_ISSUER_INVALID', String(issuer));
      if (typeof issuer === 'string' && issuer.length > 0) assert.equal(error.message.includes(issuer), false, 'the message never echoes the value');
    }
  });

  it('a currency that is not a standard non-XRP code fails construction', () => {
    for (const currency of ['XRP', 'xrp', 'US', 'USDC', 'U D', '524C555344000000000000000000000000000000', '', 840]) {
      const error = configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'issued', currency, issuer: XRPL_ISSUER } }] });
      assert.equal(error.code, 'XRPL_CURRENCY_INVALID', String(currency));
    }
    assert.equal(isXrplStandardCurrencyCode('USD'), true);
    assert.equal(isXrplStandardCurrencyCode('EU$'), true, 'XRPL standard codes admit a few symbols');
  });

  it('refuses undeclared options — no seed, secret, key, endpoint or account may be configured here', () => {
    for (const key of ['seed', 'secret', 'privateKey', 'mnemonic', 'endpoint', 'url', 'account', 'fee', 'server', 'networkUrl']) {
      assert.equal(configurationError({ ...USD_ISSUED_OPTIONS, [key]: 'x' }).code, 'XRPL_OPTIONS_INVALID', key);
    }
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER, secret: 'x' } }] }).code, 'XRPL_OPTIONS_INVALID');
  });

  it('ANDREW-P0-07: `network` is declared only as a label — never an endpoint, URL or credential', () => {
    for (const value of ['wss://ledger.example:51233', 'https://ledger.example', 'ledger.example:443', 'Upper-Case', 'has space', '-leading', 'trailing-', 'a..b', '', 'x'.repeat(65), 42, null]) {
      assert.equal(configurationError({ ...USD_ISSUED_OPTIONS, network: value }).code, 'XRPL_NETWORK_INVALID', String(value));
    }
    assert.doesNotThrow(() => createXrplExecutionAdapter({ ...USD_ISSUED_OPTIONS, network: 'ledger-a.test' }, createSpyXrplTransport()));
  });

  it('refuses accessors, unrecordable ids, unknown kinds and a missing transport', () => {
    const withGetter = { assets: USD_ISSUED_OPTIONS.assets, get adapterId() { return XRPL_ADAPTER_ID; } };
    assert.equal(configurationError(withGetter).code, 'XRPL_OPTIONS_INVALID');
    assert.equal(configurationError({ ...USD_ISSUED_OPTIONS, adapterId: 'has space' }).code, 'XRPL_ADAPTER_ID_INVALID');
    assert.equal(configurationError({ adapterId: XRPL_ADAPTER_ID, assets: [{ assetId: 'USD', representation: { kind: 'iou', currency: 'USD', issuer: XRPL_ISSUER } }] }).code, 'XRPL_ASSET_MAPPING_INVALID');
    assert.equal(configurationError(USD_ISSUED_OPTIONS, null).code, 'XRPL_TRANSPORT_INVALID');
    assert.equal(configurationError(USD_ISSUED_OPTIONS, { submit: async () => ({ kind: 'validated' }) }).code, 'XRPL_TRANSPORT_INVALID');
  });

  it('snapshots configuration: mutating the options afterwards changes nothing', async () => {
    const representation = { kind: 'issued' as const, currency: 'USD', issuer: XRPL_ISSUER };
    const assets = [{ assetId: 'USD', representation }];
    const options = { adapterId: XRPL_ADAPTER_ID, assets };
    const transport = createSpyXrplTransport();
    const adapter = createXrplExecutionAdapter(options, transport);
    (representation as { issuer: string }).issuer = XRPL_OTHER_ISSUER;
    assets.push({ assetId: 'EUR', representation: { kind: 'issued', currency: 'EUR', issuer: XRPL_ISSUER } });
    await adapter.execute(validatedAction());
    assert.equal(issuedAmount(transport).issuer, XRPL_ISSUER);
    assertRefused(await adapter.execute(validatedAction({ amount: { value: '1', unit: 'EUR' } })), /no configured XRPL representation/);
  });
});

describe('ANDREW-P0-06 — exact money: text in, text out, never a number', () => {
  for (const value of ['75000', '74999.99', '75000.01', '0.000001', '0.01', '999999999999999', '123456789.123456', '0.000000000000001']) {
    it(`issued USD "${value}" reaches the instruction byte-identical`, async () => {
      const { adapter, transport } = adapterWith();
      assert.equal((await adapter.execute(validatedAction({ amount: { value, unit: 'USD' } }))).outcome, 'completed');
      assert.equal(issuedAmount(transport).value, value);
      assert.equal(typeof issuedAmount(transport).value, 'string');
    });
  }

  it('refuses issued values the ledger would round or cannot hold, instead of sending an approximation; transport 0', async () => {
    for (const value of ['0', '1234567890123456', '75000.0000000000001', '0.30000000000000004', '9007199254740993', `1${'0'.repeat(97)}`, `0.${'0'.repeat(81)}1`]) {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(validatedAction({ amount: { value, unit: 'USD' } })), /cannot be stated exactly/);
      assert.equal(transport.submissions.length, 0, value);
    }
  });

  it('refuses a value that is not canonical decimal text — a number, an exponent, a sign; transport 0', async () => {
    for (const value of [75000 as unknown as string, '7.5e4', '-75000', '75000.10', '075000', ' 75000']) {
      const { adapter, transport } = adapterWith();
      assertRefused(await adapter.execute(validatedAction({ amount: { value, unit: 'USD' } })), /cannot be stated exactly/);
      assert.equal(transport.submissions.length, 0, String(value));
    }
  });

  it('the issued-value bounds are XRPL’s: 15 significant digits, exponent −96 … 80', () => {
    assert.equal(xrplIssuedCurrencyValue('999999999999999'), '999999999999999');
    assert.equal(xrplIssuedCurrencyValue('9999999999999990'), '9999999999999990', 'trailing zeros are exponent, not precision');
    assert.equal(xrplIssuedCurrencyValue('9999999999999999'), undefined);
    assert.equal(xrplIssuedCurrencyValue(`9${'0'.repeat(95)}`), `9${'0'.repeat(95)}`, '9e95 = 9000000000000000e80');
    assert.equal(xrplIssuedCurrencyValue(`9${'0'.repeat(96)}`), undefined);
    assert.equal(xrplIssuedCurrencyValue(`0.${'0'.repeat(80)}1`), `0.${'0'.repeat(80)}1`, '1e-81 = 1000000000000000e-96');
    assert.equal(xrplIssuedCurrencyValue(`0.${'0'.repeat(81)}1`), undefined);
  });
});

describe('ANDREW-P0-06 — native XRP, explicitly mapped, in exact drops', () => {
  it('1 XRP → "1000000" drops; 0.000001 XRP → "1"; sub-drop precision refused', () => {
    assert.equal(xrplDropsFromXrp('1'), '1000000');
    assert.equal(xrplDropsFromXrp('0.000001'), '1');
    assert.equal(xrplDropsFromXrp('0.0000001'), undefined);
    assert.equal(xrplDropsFromXrp('75000'), '75000000000');
    assert.equal(xrplDropsFromXrp('90071992547.40993'), '90071992547409930', 'beyond 2^53 drops, still exact — no float on the way');
    assert.equal(xrplDropsFromXrp('100000000000'), '100000000000000000', 'the whole supply');
    assert.equal(xrplDropsFromXrp('100000000000.000001'), undefined, 'more than exists');
    assert.equal(xrplDropsFromXrp('0'), undefined);
  });

  it('an xrpl:XRP amount is sent as a drops string; a sub-drop amount never reaches the transport', async () => {
    const { adapter, transport } = adapterWith(USD_AND_XRP);
    await adapter.execute(validatedAction({ amount: { value: '0.000001', unit: 'xrpl:XRP' } }));
    assert.deepEqual(transport.submissions[0]?.instruction, { TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: '1' });
    assertRefused(await adapter.execute(validatedAction({ amount: { value: '0.0000001', unit: 'xrpl:XRP' } })), /cannot be stated exactly/);
    assert.equal(transport.submissions.length, 1);
  });
});

describe('ANDREW-P0-06 — transport outcome mapping onto the existing result semantics', () => {
  const cases: readonly (readonly [string, XrplSubmissionObservation, ExecutionAdapterResult])[] = [
    ['validated with a hash → completed, hash as providerRef', { kind: 'validated', transactionHash: FIXTURE_TRANSACTION_HASH }, { outcome: 'completed', providerRef: FIXTURE_TRANSACTION_HASH }],
    ['validated without a hash → completed, no providerRef invented', { kind: 'validated' }, { outcome: 'completed' }],
    ['rejected → failed PROVIDER_REJECTED, hash kept', { kind: 'rejected', transactionHash: FIXTURE_TRANSACTION_HASH }, { outcome: 'failed', reason: 'PROVIDER_REJECTED', providerRef: FIXTURE_TRANSACTION_HASH, detail: 'XRPL network rejected the payment.' }],
    ['not-submitted → failed PROVIDER_UNAVAILABLE', { kind: 'not-submitted' }, { outcome: 'failed', reason: 'PROVIDER_UNAVAILABLE', detail: 'XRPL payment was not submitted.' }],
    ['unconfirmed → unconfirmed, hash kept as the reconciliation handle', { kind: 'unconfirmed', transactionHash: FIXTURE_TRANSACTION_HASH }, { outcome: 'unconfirmed', providerRef: FIXTURE_TRANSACTION_HASH, detail: 'XRPL payment outcome could not be confirmed.' }],
  ];
  for (const [label, observation, expected] of cases) {
    it(label, async () => {
      const { adapter, transport } = adapterWith(USD_ISSUED_OPTIONS, () => observation);
      assert.deepEqual(await adapter.execute(validatedAction()), expected);
      assert.equal(transport.submissions.length, 1, 'one submission, no retry');
    });
  }

  it('a hash is surfaced only when supplied and well-formed: never on not-submitted, never a malformed or credential-shaped value', async () => {
    for (const transactionHash of ['abc', `${FIXTURE_TRANSACTION_HASH}0`, 'Bearer abcdefghijklmnop', `https://explorer.example/${FIXTURE_TRANSACTION_HASH}`, 42]) {
      const { adapter } = adapterWith(USD_ISSUED_OPTIONS, () => ({ kind: 'validated', transactionHash }) as unknown as XrplSubmissionObservation);
      assert.deepEqual(await adapter.execute(validatedAction()), { outcome: 'completed' }, String(transactionHash));
    }
    const { adapter } = adapterWith(USD_ISSUED_OPTIONS, () => ({ kind: 'not-submitted', transactionHash: FIXTURE_TRANSACTION_HASH }) as unknown as XrplSubmissionObservation);
    assert.equal((await adapter.execute(validatedAction())).providerRef, undefined, 'nothing reached the network, so there is no reference');
  });

  it('a throwing transport is unconfirmed — never failed, never retried — and its error text never leaks', async () => {
    const secret = 'sEdSECRETSEEDSHOULDNEVERAPPEAR0000';
    let calls = 0;
    const adapter = createXrplExecutionAdapter(USD_ISSUED_OPTIONS, {
      async submitPayment() {
        calls += 1;
        throw new Error(`socket reset while holding ${secret}`);
      },
    });
    const result = await adapter.execute(validatedAction());
    assert.deepEqual(result, { outcome: 'unconfirmed', detail: 'XRPL payment outcome could not be confirmed.' });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  it('an unreadable observation — null, an unknown kind, a throwing getter — is unconfirmed, never completed', async () => {
    const hostile = Object.defineProperty({}, 'kind', { get() { throw new Error('boom'); } });
    for (const observation of [null, undefined, 'validated', { kind: 'success' }, { kind: 'VALIDATED' }, hostile]) {
      const { adapter, transport } = adapterWith(USD_ISSUED_OPTIONS, () => observation as unknown as XrplSubmissionObservation);
      assert.equal((await adapter.execute(validatedAction())).outcome, 'unconfirmed', String(observation));
      assert.equal(transport.submissions.length, 1);
    }
  });

  it('the submission carries the existing idempotency handle and the grant horizon, and nothing secret', async () => {
    const { adapter, transport } = adapterWith();
    await adapter.execute(validatedAction({ correlation: { requestId: 'r-9', decisionId: 'd-9', executionId: 'e-9' }, notAfter: '2026-02-02T00:00:00.000Z' }));
    const submission = transport.submissions[0];
    assert.deepEqual(Object.keys(submission ?? {}), ['instruction', 'executionId', 'requestId', 'decisionId', 'notAfter']);
    assert.equal(submission?.executionId, 'e-9');
    assert.equal(submission?.notAfter, '2026-02-02T00:00:00.000Z');
    assert.equal(/seed|secret|private|mnemonic|signature|boundedGrantId|subject|organization/i.test(JSON.stringify(submission)), false);
  });
});
