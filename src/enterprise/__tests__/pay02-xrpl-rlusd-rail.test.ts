import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentGovernanceBinding,
  type PaymentGovernedActionIntent,
  type PaymentIntent,
} from '../../features/payment-runtime/index.js';
import { XRPL_RAIL_DETAILS, createXrplRlusdRail } from '../../features/payment-runtime/rails/xrpl/index.js';
import {
  ISSUER,
  RLUSD_ASSET,
  RLUSD_CURRENCY_HEX,
  TREASURY,
  VENDOR,
  createFakeXrplClient,
  createTestSoftwareXrplSigner,
  testClock,
  testConfiguration,
  validatedFailure,
  type FakeXrplClient,
  type FakeXrplScript,
} from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { buildAuthorityTrace } from '../evidence/trace-builder.js';
import { AUDITOR_DISCLOSURE_POLICY_V2, CUSTOMER_DISCLOSURE_POLICY_V2, PARTNER_DISCLOSURE_POLICY_V2, PUBLIC_DISCLOSURE_POLICY_V2, discloseAuthorityTrace } from '../evidence/trace-disclosure.js';
import { createExecutionActivityGuard } from '../execution-reconciliation/activity-guard.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createOperatorAttestationAuthority, selectOperatorAttestation } from '../execution-reconciliation/operator-attestation.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionApprovalAssessment } from '../governed-action/index.js';
import { ALLOWED_INTENT, APPROVAL_INTENT, DENIED_ACTOR, IDENTITY, NOW, ORG, buildGovernedWorld, identityFor, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-02 qualification on the **real governed path**:
 *
 * ```
 * PaymentIntent ─ validate ─ compile ─ orchestrator ─ Kernel ─ committed decision ─ (approval)
 *   ─ P10 ceiling ─ bounded grant ─ exercise ─ P7 reservation ─ write-ahead claim
 *   ─ createPaymentRailExecutionAdapter ─ XRPL / RLUSD rail ─ (fake XRPL client) ─ P11 ─ trace ─ P12
 * ```
 *
 * Everything is the production code of PAY-01 and PAY-02 except two test
 * doubles: the XRPL client (deterministic, no network, counts submissions) and
 * the software signer (test-only key, never funded). The rail itself — build,
 * network check, preparation, signature verification, the one submission,
 * finality — is the real rail.
 */

const PAYMENT_ACTION = ALLOWED_INTENT.action;
const REVIEWED_PAYMENT_ACTION = APPROVAL_INTENT.action;
const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
const REVIEWED_BINDING = createPaymentGovernanceBinding({ action: REVIEWED_PAYMENT_ACTION });

const ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: RLUSD_ASSET, scale: 15 },
]);
const MONETARY = Object.freeze({ assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION, REVIEWED_PAYMENT_ACTION] }) });
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION, REVIEWED_PAYMENT_ACTION] }],
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
});

interface XrplWorld {
  readonly world: GovernedWorld;
  readonly client: FakeXrplClient;
  readonly signer: ReturnType<typeof createTestSoftwareXrplSigner>;
  readonly logs: string[];
}

function xrplWorld(options: { readonly script?: FakeXrplScript; readonly binding?: PaymentGovernanceBinding; readonly approvals?: () => GovernedActionApprovalAssessment } = {}): XrplWorld {
  const client = createFakeXrplClient(options.script);
  const signer = createTestSoftwareXrplSigner(TREASURY);
  const logs: string[] = [];
  const rail = createXrplRlusdRail({
    configuration: testConfiguration({ sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }] }),
    client,
    signers: [signer],
    ...testClock(),
    logger: { info: (message, fields) => logs.push(JSON.stringify({ message, fields })), warn: (message, fields) => logs.push(JSON.stringify({ message, fields })) },
  });
  const world = buildGovernedWorld({
    monetary: MONETARY,
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority('5000', '20000', RLUSD_ASSET),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: options.binding ?? BINDING }),
    ...(options.approvals !== undefined ? { approvals: { assess: () => Promise.resolve(options.approvals!()) } } : {}),
  });
  return { world, client, signer, logs };
}

function payment(overrides: Record<string, unknown> = {}): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` },
      amount: { value: '1250.50', unit: RLUSD_ASSET },
      purpose: 'vendor-payment',
      reference: 'INV-2026-0042',
      rail: 'xrpl-rlusd',
      idempotencyKey: 'pay-xrpl-1',
      ...overrides,
    },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { readonly intent: PaymentIntent }).intent;
}

function governed(intent: PaymentIntent, binding: PaymentGovernanceBinding = BINDING): PaymentGovernedActionIntent {
  return compilePaymentIntent(intent, binding, { assertedContext: binding === BINDING ? ALLOWED_INTENT.assertedContext : APPROVAL_INTENT.assertedContext });
}

const HASH = /^[0-9A-F]{64}$/;
const ctx = { organizationId: ORG };

describe('PAY-02 X7 / X10 — a granted RLUSD payment reaches the XRPL rail exactly once and completes', () => {
  it('governs, grants, reserves, claims, submits once, and records confirmed-completed with the transaction hash', async () => {
    const { world, client } = xrplWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(world.kernelRequests.length, 1, 'the Kernel decided it');
    assert.ok(world.issueOutcomes.some((outcome) => outcome.outcome === 'issued'), 'a bounded grant was issued before the rail ran');
    assert.equal(client.calls.submit, 1);
    const hash = result.status === 'executed' ? result.providerRef : undefined;
    assert.match(hash ?? '', HASH, 'providerRef is the XRPL transaction hash');

    const record = await world.outcomes.read(ctx, result.executionId!);
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.certainty, 'confirmed-completed');
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.providerRef, hash);
    assert.deepEqual(record?.attempt.amount, { value: '1250.5', unit: RLUSD_ASSET });
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.adapterId, 'xrpl-rlusd', 'the rail is recorded as the adapter that performed the effect');
  });

  it('the Kernel governed the tagged XRPL destination as the counterparty — the tag is part of what was granted', async () => {
    const { world } = xrplWorld();
    await world.orchestrator.govern(IDENTITY, governed(payment()));
    const kernel = world.kernelRequests[0] as unknown as { readonly action: Record<string, unknown> };
    assert.equal(kernel.action['counterpartyId'], `xrpl-tagged-account:${VENDOR.classicAddress}:4471`);
    assert.equal(kernel.action['currency'], RLUSD_ASSET);
  });
});

describe('PAY-02 X5 / X6 / limits — no XRPL contact before a grant', () => {
  it('X5: a denied payment never reaches the rail — zero submissions, zero client calls', async () => {
    const { world, client } = xrplWorld();
    const result = await world.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), governed(payment()));
    assert.equal(result.status, 'denied', JSON.stringify(result));
    assert.equal(client.calls.connect + client.calls.submit, 0);
  });

  it('X6: a payment awaiting approval reaches XRPL zero times until approval completes, then exactly once', async () => {
    let answer: GovernedActionApprovalAssessment = { kind: 'withheld', status: 'pending' };
    const { world, client } = xrplWorld({ binding: REVIEWED_BINDING, approvals: () => answer });
    const intent = governed(payment(), REVIEWED_BINDING);
    const pending = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(pending.status === 'withheld' && pending.withheldBy, 'approval', JSON.stringify(pending));
    assert.equal(client.calls.connect + client.calls.submit, 0);
    answer = { kind: 'approved', approvalDigest: `sha256:${'b'.repeat(64)}`, notAfter: new Date(Date.parse(NOW) + 5 * 60_000).toISOString() };
    const approved = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(approved.status, 'executed', JSON.stringify(approved));
    assert.equal(client.calls.submit, 1);
  });

  it('limits: a payment above the P10 RLUSD ceiling is withheld before any grant — zero submissions', async () => {
    const { world, client } = xrplWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000.01', unit: RLUSD_ASSET } })));
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.ok(result.reasonCodes.includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'));
    assert.equal(client.calls.submit, 0);
  });

  it('limits: cumulative P7 exposure stops the payment that would exceed it before it reaches XRPL', async () => {
    const { world, client } = xrplWorld();
    for (let index = 0; index < 4; index += 1) {
      const result = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000', unit: RLUSD_ASSET }, idempotencyKey: `pay-cap-${index}` })));
      assert.equal(result.status, 'executed', JSON.stringify(result));
    }
    const over = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '0.01', unit: RLUSD_ASSET }, idempotencyKey: 'pay-cap-over' })));
    assert.equal(over.status === 'withheld' && over.withheldBy, 'exercise', JSON.stringify(over));
    assert.equal(client.calls.submit, 4);
  });

  it('X3 (governed): a granted payment in another asset routed to this rail is refused by the rail with nothing contacted', async () => {
    const { world, client } = xrplWorld();
    const usd = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '10', unit: 'USD' } })));
    // The USD ceiling is absent from authority, so the governed path itself may stop it first; either way XRPL is never contacted.
    assert.notEqual(usd.status, 'executed', JSON.stringify(usd));
    assert.equal(client.calls.connect + client.calls.submit, 0);
  });

  it('X4 (governed): a granted destination the rail cannot parse fails definitively with nothing contacted', async () => {
    const { world, client } = xrplWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment({ destination: { kind: 'account', reference: 'vendor-4471' } })));
    assert.equal(result.status === 'execution_failed' && result.failure, 'ADAPTER_ERROR', JSON.stringify(result));
    assert.equal(client.calls.connect + client.calls.submit, 0);
    const record = await world.outcomes.read(ctx, result.executionId!);
    assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.certainty, 'confirmed-not-completed');
  });

  it('a payment granted for a different rail never reaches the XRPL rail', async () => {
    const { world, client } = xrplWorld();
    const result = await world.orchestrator.govern(IDENTITY, governed(payment({ rail: 'other-rail' })));
    assert.equal(result.status === 'execution_failed' && result.failure, 'ADAPTER_ERROR', JSON.stringify(result));
    assert.equal(client.calls.connect + client.calls.submit, 0);
  });
});

describe('PAY-02 X11 / X13 / X16 / X17 — XRPL outcomes are the existing durable outcomes; P12 owns ambiguity', () => {
  it('X11: a validated tec failure → execution_failed PROVIDER_REJECTED, confirmed-not-completed, hash kept; replay does not resubmit', async () => {
    const { world, client } = xrplWorld({ script: { lookup: validatedFailure('tecPATH_DRY') } });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status === 'execution_failed' && result.failure, 'PROVIDER_REJECTED', JSON.stringify(result));
    const record = await world.outcomes.read(ctx, result.executionId!);
    const observation = record?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' && observation.certainty, 'confirmed-not-completed');
    assert.match(observation?.kind === 'provider' ? (observation.providerRef ?? '') : '', HASH);
    const replay = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(replay.status === 'execution_failed' && replay.replayed, true);
    assert.equal(client.calls.submit, 1);
  });

  it('X13 / X16 / X17: a submission timeout → execution_unconfirmed, P11 unconfirmed with the hash, never resubmitted, resolved by the existing operator resolution', async () => {
    const { world, client } = xrplWorld({ script: { submit: () => Promise.reject(new Error('Timeout for request')) } });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    assert.ok(result.reasonCodes.includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED));
    const executionId = result.executionId!;
    const record = await world.outcomes.read(ctx, executionId);
    const observation = record?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' && observation.certainty, 'unconfirmed');
    const hash = observation?.kind === 'provider' ? observation.providerRef : undefined;
    assert.match(hash ?? '', HASH, 'the operator is handed the transaction hash to look up');

    // X16: the same governed request replays; XRPL is not contacted again.
    for (let index = 0; index < 3; index += 1) {
      const again = await world.orchestrator.govern(IDENTITY, governed(payment()));
      assert.equal(again.status, 'execution_unconfirmed');
      assert.equal(again.executionId, executionId);
    }
    assert.equal(client.calls.submit, 1, 'an unconfirmed XRPL payment is never re-sent');

    // X17: the existing P12 operator resolution — no XRPL-specific path.
    const resolutions = createInMemoryExecutionResolutionStore({ now: () => NOW });
    const service = createExecutionReconciliationService({
      outcomes: world.outcomes,
      resolutions,
      composition: snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 'test'),
      claimed: async () => true,
      activity: createExecutionActivityGuard(),
      now: () => NOW,
    });
    const resolved = await service.recordOperatorResolution({ organizationId: ORG, executionId, attestedBy: 'operator:treasury-ops', observedOutcome: 'unconfirmed', certainty: 'confirmed-completed' });
    assert.equal(resolved.outcome, 'recorded', JSON.stringify(resolved));
    assert.equal((await resolutions.read(ctx, executionId))?.resolution?.certainty, 'confirmed-completed');
    const durable = await world.outcomes.read(ctx, executionId);
    assert.equal(durable?.terminal?.observation.kind === 'provider' && durable.terminal.observation.providerRef, hash, 'the durable provider outcome is not overwritten');
    assert.equal(client.calls.submit, 1, 'resolution re-sends nothing');
  });

  it('X13: no validated answer before the finality deadline → execution_unconfirmed, P12-eligible', async () => {
    const { world, client } = xrplWorld({ script: { lookup: (context) => ({ hash: context.hash, validated: false }) } });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
    assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
    assert.equal(client.calls.submit, 1);
  });

  it('X12 (governed): XRPL unreachable before submission → execution_failed PROVIDER_UNAVAILABLE; the P7 reservation is released', async () => {
    const { world, client } = xrplWorld({
      script: {
        connect: () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000', unit: RLUSD_ASSET } })));
    assert.equal(result.status === 'execution_failed' && result.failure, 'PROVIDER_UNAVAILABLE', JSON.stringify(result));
    assert.equal(client.calls.submit, 0);
    // A definitive non-completion releases capacity: four full payments still fit the lifetime limit afterwards.
    for (let index = 0; index < 4; index += 1) {
      const next = await world.orchestrator.govern(IDENTITY, governed(payment({ amount: { value: '5000', unit: RLUSD_ASSET }, idempotencyKey: `after-${index}` })));
      assert.notEqual(next.status === 'withheld' && next.withheldBy, 'exercise', JSON.stringify(next));
    }
  });
});

describe('PAY-02 X18 / X19 / X20 — evidence, disclosure and secrets use the existing trace and tiers', () => {
  async function tracedPayment(script: FakeXrplScript = {}) {
    const harness = xrplWorld({ script });
    const result = await harness.world.orchestrator.govern(IDENTITY, governed(payment()));
    const build = await buildAuthorityTrace(
      { governance: harness.world.rawStore, grants: { kind: 'in-memory', read: (grantId) => harness.world.grantStore.read(grantId) }, outcomes: harness.world.outcomes },
      { system: true },
      result.requestId!,
    );
    assert.ok(build !== null);
    return { ...harness, result, trace: build.trace };
  }

  it('X18: the trace carries amount, asset, source reference, rail, transaction hash and outcome — no XRPL-specific record exists', async () => {
    const { result, trace } = await tracedPayment();
    const hash = result.status === 'executed' ? result.providerRef : undefined;
    assert.deepEqual(trace.stages.parameters.amount, { value: '1250.5', unit: RLUSD_ASSET });
    assert.equal(trace.stages.outcome.kind, 'provider');
    assert.equal(trace.stages.outcome.certainty, 'confirmed-completed');
    assert.equal(trace.stages.outcome.providerRef, hash);
    const text = JSON.stringify(trace);
    for (const value of [GOVERNED_ACCOUNT, 'xrpl-rlusd', 'paymentRail']) assert.ok(text.includes(value), value);
  });

  it('X19: the hash is AUDITOR and PARTNER evidence only; amount and source are AUDITOR only; no tier discloses the XRPL destination or issuer', async () => {
    const { result, trace } = await tracedPayment();
    const hash = result.status === 'executed' ? (result.providerRef ?? '') : '';
    const view = (policy: Parameters<typeof discloseAuthorityTrace>[1]) => JSON.stringify(discloseAuthorityTrace(trace, policy));
    const auditor = view(AUDITOR_DISCLOSURE_POLICY_V2);
    const partner = view(PARTNER_DISCLOSURE_POLICY_V2);
    const customer = view(CUSTOMER_DISCLOSURE_POLICY_V2);
    const publicView = view(PUBLIC_DISCLOSURE_POLICY_V2);
    for (const value of [hash, '1250.5', GOVERNED_ACCOUNT]) assert.ok(auditor.includes(value), `AUDITOR sees ${value}`);
    assert.ok(partner.includes(hash), 'PARTNER sees the rail execution reference');
    for (const value of ['1250.5', GOVERNED_ACCOUNT]) assert.equal(partner.includes(value), false, `PARTNER does not see ${value}`);
    for (const disclosed of [customer, publicView]) {
      for (const value of [hash, '1250.5', GOVERNED_ACCOUNT]) assert.equal(disclosed.includes(value), false, `CUSTOMER/PUBLIC do not see ${value}`);
    }
    for (const disclosed of [auditor, partner, customer, publicView]) {
      for (const value of [VENDOR.classicAddress, ISSUER.classicAddress, TREASURY.classicAddress, RLUSD_CURRENCY_HEX]) assert.equal(disclosed.includes(value), false, value);
    }
  });

  it('X20: the signer secret appears in no governed result, trace, disclosure, log line or durable outcome — on success, failure and ambiguity', async () => {
    for (const script of [{}, { lookup: validatedFailure('tecNO_LINE') }, { submit: () => Promise.reject(new Error('reset')) }] as FakeXrplScript[]) {
      const { world, result, trace, signer, logs } = await tracedPayment(script);
      const record = await world.outcomes.read(ctx, result.executionId!);
      const observed = JSON.stringify({ result, trace, record, logs, disclosed: discloseAuthorityTrace(trace, AUDITOR_DISCLOSURE_POLICY_V2) });
      assert.equal(observed.includes(signer.canarySecret), false);
      assert.equal(/"(seed|privateKey|secret|tx_blob|signedTransaction)"/i.test(observed), false);
    }
  });

  it('P11 records certainty and the transaction hash only: no rail detail token or XRPL vocabulary becomes durable outcome data', async () => {
    const { world, result } = await tracedPayment({ submit: () => ({}) });
    const record = await world.outcomes.read(ctx, result.executionId!);
    const observation = record?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' && observation.certainty, 'unconfirmed');
    assert.match(observation?.kind === 'provider' ? (observation.providerRef ?? '') : '', HASH);
    assert.equal(JSON.stringify(record).includes(XRPL_RAIL_DETAILS.SUBMISSION_RESPONSE_UNREADABLE), false, 'details are live and logged, not durable — P11 is unchanged');
  });
});
