import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import type { ObligationCorrelation } from '../../features/obligation-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, validatePaymentIntent, type PaymentIntent } from '../../features/payment-runtime/index.js';
import { createXrplRlusdRailConfiguration } from '../../features/payment-runtime/rails/xrpl/index.js';
import { ISSUER as XRPL_ISSUER, RLUSD_ASSET, RLUSD_CURRENCY_HEX, TREASURY, VENDOR } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { createSqliteObligationDischargeStore } from '../obligation-discharge/sqlite-obligation-discharge-store.js';
import {
  createPaymentObligationDischarger,
  createPaymentSettlementService,
  createSqlitePaymentSettlementStore,
  paymentObligationReference,
  verifyPaymentReceipt,
} from '../payment-settlement/index.js';
import { startReferenceXrplSigner } from '../xrpl-payment-rail/reference/reference-xrpl-signer-service.js';
import { createSqliteXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { XRPL_FINALITY_AUTHORITY_ID, createXrplFinalityAuthority, readOnlyXrplFinalityLedger } from '../xrpl-payment-rail/xrpl-finality-authority.js';
import { authorityAuthenticityEnv, testAuthenticity } from './authority-authenticity-fixture.js';
import { boundaryFor, withDeploymentWitness } from './core07-freshness-fixture.js';
import { ACCOUNT, AGENT, AUTH, ISSUER, ORG, OWNER, SECRETS, TRUST_DOMAIN, bootstrapOrganization, call, capturingLogger, create, createWorkspace, expectStatus, type Reply } from './ctrl02-host-fixture.js';
import { SIGNER_ID, SIGNER_TOKEN, SIGNER_TOKEN_ENV, SIMULATED_RESTART_QUARANTINE, createLedgerSimulator, type LedgerSimulator } from './pay03-xrpl-fixture.js';
import { portability } from './prod02-recovery-fixture.js';

/**
 * PAY-05 — the exit proofs, on the **shipped Host** (`bootEnterpriseHost()`,
 * production profile, SQLite everywhere, signed grants, the CORE-07 witness,
 * the PAY-03 XRPL rail with the external reference signer, a loopback
 * listener; the XRPL network is PAY-03's deterministic simulator).
 *
 * ```
 * release-goods (order-1001) ─▶ Kernel ALLOWED, blocking obligation payment.settled required ─▶ grant WITHHELD, adapter 0
 *   the payer's RLUSD payment, its reference derived from that obligation ─▶ governed ─▶ XRPL once ─▶ P11 completed
 *   ── not settled: bridge says not-settled; a self-report reaches "discharged" only ─▶ still WITHHELD
 *   PAY-05 (embedder-composed): XRPL finality authority re-reads the validated ledger ─▶ settled + receipt
 *   ─▶ bridge: CORE-04's recorder, configured INDEPENDENT source ─▶ obligation verified
 *   the SAME release request (same key) ─▶ the SAME committed decision (not recomputed) ─▶ grant ─▶ executed, adapter 1
 *   no second XRPL submission, ever
 * ```
 *
 * PAY-05 is composed here exactly as an embedder would compose it beside the
 * Host: second connections to the Host's own durable stores (P11, P12, the
 * CORE-04 discharge store and the XRPL interlock — the anchored ones under the
 * same CORE-07 witness), the Host's Governance Store, its CORE-04 trusted
 * recorder, and a read-only ledger client.
 */

const PAYMENT = 'transfer-funds';
const RELEASE = 'release-goods';
const ORDERS = 'order-desk';
const RAIL = 'xrpl-rlusd';
const RELEASE_ADAPTER = 'pilot.release-recording';
const OBLIGATION = 'payment.settled';
const ASSETS = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: RLUSD_ASSET, scale: 15 }]);
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT });

const workspace = createWorkspace('frontera-pay05-exit-');
let signer: Awaited<ReturnType<typeof startReferenceXrplSigner>>;
let registry: Awaited<ReturnType<typeof portability>>['registry'];
before(async () => {
  signer = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: TREASURY.seed!, credential: SIGNER_TOKEN });
  registry = (await portability()).registry;
});
after(async () => {
  await workspace.close();
  await signer.close();
});

const RAIL_SECTION = () => ({
  paymentAction: PAYMENT,
  network: 'testnet',
  endpoint: 'wss://xrpl-pay05.invalid:51233',
  asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: XRPL_ISSUER.classicAddress },
  sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey }],
  lastLedgerOffset: 4,
  finalityTimeoutMs: 5_000,
  pollIntervalMs: 250,
  signer: { endpoint: `http://127.0.0.1:${signer.port}`, signerId: SIGNER_ID, credential: { kind: 'bearer', tokenEnv: SIGNER_TOKEN_ENV }, timeoutMs: 2_000 },
});

function governedFile(): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 300,
    customerPrincipals: [],
    operators: [
      { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_CTRL02_ADMIN' },
      { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' },
      { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' },
    ],
    monetary: { assets: [{ assetId: 'USD', scale: 2 }, { assetId: RLUSD_ASSET, scale: 15 }], financialActions: [PAYMENT] },
    governance: {
      parameterDimensions: [...PAYMENT_PARAMETER_DIMENSIONS, { id: 'orderRef', type: 'token', bound: 'exact' }],
      actionClasses: [
        { id: 'payment', actions: [PAYMENT] },
        { id: 'release', actions: [RELEASE] },
      ],
      resourceClasses: [
        { id: 'governed-account', resources: [ACCOUNT] },
        { id: 'order-desk', resources: [ORDERS] },
      ],
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
        {
          profileId: 'order-release',
          version: 1,
          owner: ORG,
          provenance: { authoredBy: 'operator:fulfilment', approvedBy: 'operator:security' },
          actionClass: 'release',
          resourceClass: 'order-desk',
          parameters: [{ dimension: 'orderRef', required: true }],
          materialFacts: [],
          obligations: [{ obligationType: OBLIGATION, blocking: true }],
          relevantPolicies: [],
        },
      ],
    },
    obligations: {
      sources: [
        { sourceId: 'payment-settlement', kind: 'provider_adapter', name: 'Settlement-verified payment (PAY-05)', verificationClass: 'independent' },
        { sourceId: 'payer-statement', kind: 'internal_store', name: 'The payer says it paid', verificationClass: 'self_reported' },
      ],
    },
    routes: [
      { action: PAYMENT, adapterId: RAIL },
      { action: RELEASE, adapterId: RELEASE_ADAPTER },
    ],
    xrplPaymentRail: RAIL_SECTION(),
  };
}

function hostEnv(dir: string): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(governedFile()));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${SECRETS.legacyKey}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    ...registry.storeEnvironmentFor(dir),
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: filePath,
    FRONTERA_CTRL02_ADMIN: SECRETS.administrator,
    FRONTERA_CTRL02_PROVISIONER: SECRETS.provisioner,
    FRONTERA_CTRL02_OBSERVER: SECRETS.observer,
    [SIGNER_TOKEN_ENV]: SIGNER_TOKEN,
  };
}

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly env: Record<string, string | undefined>;
  readonly releases: ValidatedExecutionAction[];
  readonly credential: string;
}

async function bootReady(dir: string, ledger: LedgerSimulator): Promise<Booted> {
  const env = await withDeploymentWitness(hostEnv(dir));
  const releases: ValidatedExecutionAction[] = [];
  const releaseAdapter: ExecutionAdapter = {
    adapterId: RELEASE_ADAPTER,
    async execute(action) {
      releases.push(action);
      return { outcome: 'completed', providerRef: `release-${releases.length}` };
    },
  };
  const host = workspace.track(await bootEnterpriseHost({ env, xrplLedgerClient: () => ledger, executionAdapters: [releaseAdapter], logger: capturingLogger }));
  const { port } = await host.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  await bootstrapOrganization(baseUrl);
  const credential = await onboard(baseUrl);
  ledger.index += SIMULATED_RESTART_QUARANTINE;
  return { host, baseUrl, env, releases, credential };
}

/** One agent with standing authority to pay from ACCOUNT (P10: ≤ 1000 RLUSD) and, separately, to release orders. */
async function onboard(baseUrl: string): Promise<string> {
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Commerce Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pay05-erp', subjectId: AGENT } });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${AGENT}` } }), 200, 'issue credential');
  const grants = [
    { suffix: 'pay', capability: 'payables', actions: [PAYMENT], resources: [ACCOUNT], constraints: [{ type: 'max_amount', currency: RLUSD_ASSET, value: '1000' }, { type: 'spending_limit', limitId: 'payables', currency: RLUSD_ASSET, maximum: '100000', window: { kind: 'lifetime' } }] },
    { suffix: 'release', capability: 'fulfilment', actions: [RELEASE], resources: [ORDERS], constraints: [] },
  ];
  for (const grant of grants) {
    await create(baseUrl, AUTH.provisioner, 'authority-grant', {
      authorityGrantId: `authority-${grant.suffix}`,
      issuerActorId: ISSUER,
      subjectActorId: OWNER,
      trustDomainId: TRUST_DOMAIN,
      capability: `${grant.capability}.manage`,
      actions: grant.actions,
      resourceScopes: grant.resources,
      canDelegate: true,
      allowedDelegateActorTypes: ['agent'],
      maxDelegationDepth: 1,
      ...(grant.constraints.length > 0 ? { constraints: grant.constraints } : {}),
    });
    await create(baseUrl, AUTH.provisioner, 'capability-token', { capabilityTokenId: `capability-${grant.suffix}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: `${grant.capability}.execute`, actions: grant.actions, resourceScopes: grant.resources, riskLevel: 'medium' });
    await create(baseUrl, AUTH.provisioner, 'delegation-grant', { delegationGrantId: `delegation-${grant.suffix}`, delegatorActorId: OWNER, delegateActorId: AGENT, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: `authority-${grant.suffix}`, capability: `${grant.capability}.execute`, actions: grant.actions, resourceScopes: grant.resources, canRedelegate: false });
  }
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'passport-commerce', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  return issued.body['bearerCredential'] as string;
}

const governed = (booted: Booted, body: Record<string, unknown>): Promise<Reply> => call(booted.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${booted.credential}`, body });
const releaseOrder = (booted: Booted, key: string): Promise<Reply> => governed(booted, { idempotencyKey: key, action: RELEASE, resource: ORDERS, parameters: { orderRef: 'order-1001' } });

function paymentFor(correlation: ObligationCorrelation, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const validation = validatePaymentIntent(
    {
      source: { accountId: ACCOUNT },
      destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:1001` },
      amount: { value: '125.5', unit: RLUSD_ASSET },
      purpose: 'purchase',
      reference: paymentObligationReference(correlation, OBLIGATION),
      rail: RAIL,
      idempotencyKey: `pay05-exit-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return compilePaymentIntent((validation as { readonly intent: PaymentIntent }).intent, BINDING) as unknown as Record<string, unknown>;
}

/** PAY-05, composed by the embedder beside the running Host. */
async function composePay05(booted: Booted, dir: string, ledger: LedgerSimulator) {
  const paths = registry.storeEnvironmentFor(dir);
  const now = (): string => new Date().toISOString();
  const witness = { endpoint: booted.env['AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT']!, witnessId: booted.env['AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID']!, publicKeyPem: booted.env['AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY']! };
  const boundary = await boundaryFor(witness, ORG);
  const outcomes = await createSqliteExecutionOutcomeStore(paths['AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH']!, { now });
  const resolutions = await createSqliteExecutionResolutionStore(paths['AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH']!, { now });
  const configuration = createXrplRlusdRailConfiguration({ network: 'testnet', endpoint: 'wss://xrpl-pay05.invalid:51233', asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: XRPL_ISSUER.classicAddress }, sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress }] });
  const interlock = await createSqliteXrplSubmissionInterlock(paths['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH']!, { scope: { railId: configuration.railId, networkId: configuration.networkId }, now, freshness: { boundary } });
  const discharges = await createSqliteObligationDischargeStore(paths['AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH']!, { now, organizationId: ORG, authenticity: testAuthenticity(), freshness: { boundary } });
  const store = await createSqlitePaymentSettlementStore(join(dir, 'payment-settlements.sqlite'), { now });
  const settlements = createPaymentSettlementService({
    outcomes,
    resolutions,
    governance: booted.host.enterprise.persistence,
    payments: [BINDING],
    store,
    authorities: [createXrplFinalityAuthority({ configuration, ledger: readOnlyXrplFinalityLedger(ledger), interlock })],
    selectAuthority: (context) => (context.railId === RAIL || context.rail === RAIL ? XRPL_FINALITY_AUTHORITY_ID : 'none'),
    now,
  });
  const recorder = booted.host.enterprise.obligationDischarges;
  assert.ok(recorder !== undefined, 'CORE-04 obligations are composed on this Host');
  const bridge = createPaymentObligationDischarger({
    settlements,
    registry: ({ correlation, obligationType }) =>
      obligationType === OBLIGATION && correlation.action === RELEASE && correlation.resourceScope === ORDERS
        ? { amount: { value: '125.5', unit: RLUSD_ASSET }, destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:1001` }, source: { accountId: ACCOUNT } }
        : undefined,
    recorder,
    discharges,
    sourceId: 'payment-settlement',
    writer: { system: true, actorId: 'service:payment-settlement' },
    now,
  });
  return {
    settlements,
    bridge,
    discharges,
    async close() {
      for (const closable of [store, discharges, interlock, resolutions, outcomes]) await closable.close();
    },
  };
}

function assertWithheld(reply: Reply, label: string): void {
  assert.equal(reply.body['status'], 'withheld', `${label}: ${reply.text}`);
  assert.equal(reply.body['withheldBy'], 'obligations', label);
  assert.equal((reply.body['decision'] as { status: string }).status, 'allowed', `${label}: an unmet obligation withholds the grant; it never rewrites the decision`);
}

describe('PAY-05 exit proof — a blocking payment obligation is satisfied only by funds finality with evidence, through CORE-04', () => {
  it('withheld → payment completes (not settled: still withheld; self-report: still withheld) → finality verified → independent discharge → the same committed decision resumes → executed once; no extra payment', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const booted = await bootReady(dir, ledger);
    const releaseKey = 'release-order-1001';

    // 1. The obligated action: decided ALLOWED, committed, grant withheld for the unmet payment obligation.
    const withheld = await releaseOrder(booted, releaseKey);
    assertWithheld(withheld, 'initial');
    assert.equal(booted.releases.length, 0);
    const decision = withheld.body['decision'] as { decisionId: string; evaluationId: string };
    const correlation: ObligationCorrelation = { requestId: withheld.body['requestId'] as string, action: RELEASE, resourceScope: ORDERS };

    // 2. The payer pays exactly what the obligation expects, under the reference derived from it.
    const paid = expectStatus(await governed(booted, paymentFor(correlation)), 200, 'payment');
    assert.equal(paid.body['status'], 'executed', paid.text);
    const paymentExecutionId = paid.body['executionId'] as string;
    assert.equal(ledger.calls.submit, 1);

    const pay05 = await composePay05(booted, dir, ledger);
    try {
      // 3. P11 completed is not settled: nothing to discharge; the release stays withheld.
      assert.deepEqual(await pay05.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation, obligationType: OBLIGATION }, executionId: paymentExecutionId }), { outcome: 'not-settled' });
      assertWithheld(await releaseOrder(booted, releaseKey), 'completed but not settled');

      // 4. A self-report ("I paid") is recorded and reaches `discharged` — never verified; still withheld.
      await booted.host.enterprise.obligationDischarges!.record({ system: true, actorId: 'payer-portal' }, { correlation, obligationType: OBLIGATION, sourceId: 'payer-statement', outcome: 'discharged', observedAt: new Date(Date.now() - 60_000).toISOString(), reference: 'payer-says-paid' });
      assertWithheld(await releaseOrder(booted, releaseKey), 'self-reported');

      // 5. Funds finality, verified from the validated ledger; a durable settlement and its receipt.
      const settled = await pay05.settlements.verifySettlement({ organizationId: ORG, executionId: paymentExecutionId });
      assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
      if (settled.outcome !== 'settled') return;
      assert.deepEqual(verifyPaymentReceipt(settled.receipt, settled.settlement), { valid: true });

      // 6. The settlement-backed discharge, through CORE-04's own recorder, from the configured independent source.
      const discharged = await pay05.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation, obligationType: OBLIGATION }, executionId: paymentExecutionId });
      assert.equal(discharged.outcome, 'recorded', JSON.stringify(discharged));
      assert.equal(discharged.outcome === 'recorded' && discharged.receiptId, settled.receipt.receiptId);

      // 7. The same request resumes the SAME committed decision — never re-made — and executes once.
      const released = await releaseOrder(booted, releaseKey);
      assert.equal(released.body['status'], 'executed', released.text);
      assert.deepEqual(
        { decisionId: (released.body['decision'] as { decisionId: string }).decisionId, evaluationId: (released.body['decision'] as { evaluationId: string }).evaluationId },
        { decisionId: decision.decisionId, evaluationId: decision.evaluationId },
        'the Kernel decision is not recomputed',
      );
      assert.equal(booted.releases.length, 1);

      // 8. Replays change nothing: the discharge is idempotent, the release replays, and nothing pays again.
      assert.equal((await pay05.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation, obligationType: OBLIGATION }, executionId: paymentExecutionId })).outcome, 'already-recorded');
      const replay = await releaseOrder(booted, releaseKey);
      assert.equal(replay.body['status'], 'executed');
      assert.equal(booted.releases.length, 1);
      assert.equal(ledger.calls.submit, 1, 'no extra payment execution — settlement, receipt and discharge never reached the rail');
      const rows = await pay05.discharges.read(ORG, correlation);
      assert.deepEqual(rows.map((row) => [row.sourceId, row.outcome]), [['payer-statement', 'discharged'], ['payment-settlement', 'discharged']]);
    } finally {
      await pay05.close();
    }
  });

  it('a payment that settles but is not the one the obligation expects never releases', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const booted = await bootReady(dir, ledger);
    const withheld = await releaseOrder(booted, 'release-order-wrong');
    assertWithheld(withheld, 'initial');
    const correlation: ObligationCorrelation = { requestId: withheld.body['requestId'] as string, action: RELEASE, resourceScope: ORDERS };
    const underpaid = expectStatus(await governed(booted, paymentFor(correlation, { amount: { value: '125.4', unit: RLUSD_ASSET } })), 200, 'payment');
    assert.equal(underpaid.body['status'], 'executed');
    const pay05 = await composePay05(booted, dir, ledger);
    try {
      assert.equal((await pay05.settlements.verifySettlement({ organizationId: ORG, executionId: underpaid.body['executionId'] as string })).outcome, 'settled');
      assert.deepEqual(await pay05.bridge.dischargeObligation({ organizationId: ORG, obligation: { correlation, obligationType: OBLIGATION }, executionId: underpaid.body['executionId'] as string }), { outcome: 'mismatch', field: 'amount' });
      assertWithheld(await releaseOrder(booted, 'release-order-wrong'), 'underpaid');
      assert.equal(booted.releases.length, 0);
    } finally {
      await pay05.close();
    }
  });
});
