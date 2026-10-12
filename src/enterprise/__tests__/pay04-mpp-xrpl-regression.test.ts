import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentIntent,
} from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS, createMppPaymentProtocolAdapter, type MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { encodeJcs, onlyCandidate } from '../../features/payment-runtime/protocols/mpp/tests/mpp-test-support.js';
import { createXrplRlusdRail } from '../../features/payment-runtime/rails/xrpl/index.js';
import { RLUSD_ASSET, TREASURY, VENDOR, createFakeXrplClient, createTestSoftwareXrplSigner, testClock, testConfiguration, type FakeXrplClient, type FakeXrplScript } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryPaymentBusinessOperationStore, createPaymentProtocolIngress, derivePaymentBusinessOperationKey, type PaymentProtocolIngress, type PaymentProtocolIngressResult } from '../payment-protocol-ingress/index.js';
import { ALLOWED_INTENT, IDENTITY, ORG, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-04 layer J — PAY-02 / PAY-03 regression with a protocol in front:
 *
 * ```
 * MPP challenge → MPP adapter → PaymentIntent → PAY-01 compile → governed path → PAY-01 bridge → XRPL / RLUSD rail
 * ```
 *
 * The rail is PAY-02's real rail (build, network check, preparation,
 * signature verification, the one submission, finality) over the fake XRPL
 * client that counts submissions. MPP → XRPL is **composition**, not a law:
 * the trusted host maps an MPP method to an RLUSD amount, a resolver maps the
 * merchant to an XRPL destination, and a rail *preference* rides on PAY-01's
 * own `rail` field. The MPP adapter imports nothing from the rail and the rail
 * nothing from MPP (`mpp-protocol-boundaries.test.ts`).
 */

const PAYMENT_ACTION = ALLOWED_INTENT.action;
const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
const ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: RLUSD_ASSET, scale: 15 },
]);
const MONETARY = Object.freeze({ assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) });
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [GOVERNED_ACCOUNT] }],
  profiles: [
    {
      profileId: 'governed-payment',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' },
      actionClass: 'payment',
      resourceClass: 'governed-account',
      parameters: PAYMENT_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
  reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS],
});

/** Trusted host composition: the merchant's `ledgerpay` method quotes RLUSD as decimal text; the host maps it, and prefers the RLUSD rail. */
const LEDGERPAY: MppMethodNormalizer = {
  methodId: 'ledgerpay',
  intent: 'charge',
  rail: 'xrpl-rlusd',
  normalize(challenge) {
    const amount = challenge.decodedRequest['amount'];
    const recipient = challenge.decodedRequest['recipient'];
    if (typeof amount !== 'string' || challenge.decodedRequest['currency'] !== 'rlusd') return undefined;
    return { amount: { value: amount, unit: RLUSD_ASSET }, ...(typeof recipient === 'string' ? { merchantReference: recipient } : {}), reference: 'INV-2026-0042' };
  },
};

function challenge(id = 'ch-1', amount = '1250.50'): string {
  return `Payment id="${id}", realm="api.merchant.example", method="ledgerpay", intent="charge", request="${encodeJcs({ amount, currency: 'rlusd', recipient: 'merchant-7' })}", expires="2026-09-24T12:05:00Z"`;
}

let tick = 0;
const ingressClock = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();

interface XrplProtocolWorld {
  readonly world: GovernedWorld;
  readonly client: FakeXrplClient;
  readonly ingress: PaymentProtocolIngress;
}

function xrplProtocolWorld(script?: FakeXrplScript): XrplProtocolWorld {
  const client = createFakeXrplClient(script);
  const rail = createXrplRlusdRail({
    configuration: testConfiguration({ sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }] }),
    client,
    signers: [createTestSoftwareXrplSigner(TREASURY)],
    ...testClock(),
  });
  const world = buildGovernedWorld({ monetary: MONETARY, governance: GOVERNANCE, financialAuthority: monetaryAuthority('5000', '20000', RLUSD_ASSET), executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }) });
  const adapter = createMppPaymentProtocolAdapter({
    methods: [LEDGERPAY],
    resolveCounterparty: (context) => (context.merchantReference === 'merchant-7' ? { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` } : undefined),
    selectChallenge: onlyCandidate,
    assets: ASSETS,
  });
  const ingress = createPaymentProtocolIngress({ orchestrator: world.orchestrator, store: createInMemoryPaymentBusinessOperationStore({ now: ingressClock }), adapters: [adapter], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock });
  return { world, client, ingress };
}

function present(ingress: PaymentProtocolIngress, header: string, businessOperationId = 'checkout-x1') {
  return ingress.prepareAndGovern(IDENTITY, {
    businessOperationId,
    protocol: 'mpp',
    challenges: header,
    protectedRequest: { target: 'merchant:report-42', method: 'GET' },
    payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'vendor-payment' },
    envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
  });
}

function governed(outcome: PaymentProtocolIngressResult) {
  assert.equal(outcome.outcome, 'governed', JSON.stringify(outcome));
  if (outcome.outcome !== 'governed') throw new Error('unreachable');
  return outcome.result;
}

function directPayment(idempotencyKey: string): PaymentIntent {
  const validation = validatePaymentIntent(
    { source: { accountId: GOVERNED_ACCOUNT }, destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` }, amount: { value: '1250.50', unit: RLUSD_ASSET }, purpose: 'vendor-payment', reference: 'INV-2026-0042', rail: 'xrpl-rlusd', idempotencyKey },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true);
  return (validation as { readonly intent: PaymentIntent }).intent;
}

describe('PAY-04 J — MPP → PaymentIntent → XRPL uses exactly the PAY-01 / PAY-02 path', () => {
  it('a challenge governs, grants, and submits once through the existing rail; the governed intent is the direct payment’s compilation', async () => {
    const { world, client, ingress } = xrplProtocolWorld();
    const result = governed(await present(ingress, challenge()));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(client.calls.submit, 1);
    const kernel = world.kernelRequests[0] as unknown as { readonly action: Record<string, unknown> };
    assert.equal(kernel.action['counterpartyId'], `xrpl-tagged-account:${VENDOR.classicAddress}:4471`);
    assert.equal(kernel.action['currency'], RLUSD_ASSET);
    // The same payment stated directly compiles to the identical governed intent but for its key: one model, one compiler.
    const key = derivePaymentBusinessOperationKey({ organizationId: ORG, principalId: IDENTITY.principal.principalId, businessOperationId: 'checkout-x1' });
    const viaProtocol = compilePaymentIntent(directPayment(key), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext });
    const replay = await world.orchestrator.govern(IDENTITY, viaProtocol);
    assert.equal(replay.status === 'executed' && replay.replayed, true, 'the direct compilation is the very request the protocol governed');
    assert.equal(client.calls.submit, 1);
  });

  it('direct PAY-01 → XRPL still works unchanged beside it', async () => {
    const { world, client, ingress } = xrplProtocolWorld();
    governed(await present(ingress, challenge()));
    const direct = await world.orchestrator.govern(IDENTITY, compilePaymentIntent(directPayment('pay-direct-1'), BINDING, { assertedContext: ALLOWED_INTENT.assertedContext }));
    assert.equal(direct.status, 'executed', JSON.stringify(direct));
    assert.equal(client.calls.submit, 2);
  });

  it('M33 / M37 on XRPL: a submission timeout is unconfirmed; refreshed challenges never resubmit', async () => {
    const { client, ingress } = xrplProtocolWorld({ submit: () => Promise.reject(new Error('Timeout for request')) });
    const first = governed(await present(ingress, challenge()));
    assert.equal(first.status, 'execution_unconfirmed', JSON.stringify(first));
    for (let index = 2; index <= 4; index += 1) {
      const again = governed(await present(ingress, challenge(`ch-${index}`)));
      assert.equal(again.status, 'execution_unconfirmed');
      assert.equal(again.executionId, first.executionId);
    }
    assert.equal(client.calls.submit, 1, 'an unconfirmed XRPL payment is never re-sent because the merchant refreshed');
  });

  it('a protocol payment above the P10 RLUSD ceiling is withheld before XRPL is contacted', async () => {
    const { client, ingress } = xrplProtocolWorld();
    const result = governed(await present(ingress, challenge('ch-big', '5000.01'), 'checkout-big'));
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal(client.calls.connect + client.calls.submit, 0);
  });
});
