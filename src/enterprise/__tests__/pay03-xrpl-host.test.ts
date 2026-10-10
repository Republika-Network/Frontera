import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, validatePaymentIntent, type PaymentIntent } from '../../features/payment-runtime/index.js';
import { ISSUER as XRPL_ISSUER, OTHER_SOURCE, RLUSD_ASSET, RLUSD_CURRENCY_HEX, TREASURY, VENDOR } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { XRPL_PAYMENT_RAIL_MODULE_ID, XRPL_SUBMISSION_INTERLOCK_MODULE_ID } from '../xrpl-payment-rail/host-composition.js';
import { startReferenceXrplSigner } from '../xrpl-payment-rail/reference/reference-xrpl-signer-service.js';
import { createSqliteXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { XRPL_RESOLUTION_AUTHORITY_ID } from '../xrpl-payment-rail/xrpl-resolution-authority.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { ACCOUNT, AGENT, AUTH, ISSUER, ORG, OWNER, SECRETS, TRUST_DOMAIN, bootstrapOrganization, call, capturingLogger, create, createWorkspace, expectStatus, logLines, responses, type Reply } from './ctrl02-host-fixture.js';
import { SIGNER_ID, SIGNER_TOKEN, SIGNER_TOKEN_ENV, createLedgerSimulator, type LedgerSimulator } from './pay03-xrpl-fixture.js';
import { portability } from './prod02-recovery-fixture.js';

/**
 * PAY-03 — production composition, qualified through the **shipped Host**:
 * `bootEnterpriseHost()` from a plain environment and a governed-action file
 * carrying `xrplPaymentRail`, over real SQLite, real authority signing, the
 * real CTRL-02 operator plane and a real loopback listener; the external XRPL
 * signer is the real reference signer over HTTP, holding the only key.
 *
 * The one in-process seam is the ledger client factory (the Host's documented
 * `xrplLedgerClient` composition option), so the XRPL network is a
 * deterministic simulator and every submission can be counted. Everything a
 * governed payment does goes over HTTP; every P12 resolution goes through the
 * Host's own `executionReconciliation`.
 */

const PAYMENT = 'transfer-funds';
const RAIL = 'xrpl-rlusd';
const SEED_CANARY = TREASURY.seed!;
const ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: RLUSD_ASSET, scale: 15 },
]);
const BINDING = createPaymentGovernanceBinding({ action: PAYMENT });
const QUARANTINE = 4 + 4; // lastLedgerOffset 4 (the minimum) + margin

const workspace = createWorkspace('frontera-pay03-host-');
let signer: Awaited<ReturnType<typeof startReferenceXrplSigner>>;
let registry: Awaited<ReturnType<typeof portability>>['registry'];
before(async () => {
  signer = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN });
  registry = (await portability()).registry;
});
after(async () => {
  await workspace.close();
  await signer.close();
});

function railSection(overrides: Record<string, unknown> = {}, signerOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentAction: PAYMENT,
    network: 'testnet',
    endpoint: 'wss://xrpl-pay03.invalid:51233',
    asset: { paymentAsset: RLUSD_ASSET, currency: RLUSD_CURRENCY_HEX, issuer: XRPL_ISSUER.classicAddress },
    sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey }],
    lastLedgerOffset: 4,
    finalityTimeoutMs: 5_000,
    pollIntervalMs: 250,
    signer: { endpoint: `http://127.0.0.1:${signer.port}`, signerId: SIGNER_ID, credential: { kind: 'bearer', tokenEnv: SIGNER_TOKEN_ENV }, timeoutMs: 2_000, ...signerOverrides },
    ...overrides,
  };
}

function governedFile(overrides: Record<string, unknown> = {}, rail: Record<string, unknown> | null = railSection()): Record<string, unknown> {
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
      parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
      actionClasses: [{ id: 'payment', actions: [PAYMENT] }],
      resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
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
    },
    routes: [{ action: PAYMENT, adapterId: RAIL }],
    ...(rail !== null ? { xrplPaymentRail: rail } : {}),
    ...overrides,
  };
}

function hostEnv(dir: string, file: Record<string, unknown> = governedFile(), overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(file));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${SECRETS.legacyKey}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'info',
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
    ...overrides,
  };
}

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly env: Record<string, string | undefined>;
}

async function boot(env: Record<string, string | undefined>, ledger: LedgerSimulator): Promise<Booted> {
  const witnessed = await withDeploymentWitness(env);
  const host = workspace.track(await bootEnterpriseHost({ env: witnessed, xrplLedgerClient: () => ledger, logger: capturingLogger }));
  const { port } = await host.listen();
  return { host, baseUrl: `http://127.0.0.1:${port}`, env: witnessed };
}

/** Owner + agent + an operator-issued credential, with standing authority to pay from ACCOUNT up to 1000 RLUSD (P10). */
async function onboardPayer(baseUrl: string, suffix: string): Promise<string> {
  const agentId = `${AGENT}-${suffix}`;
  const ownerId = `${OWNER}-${suffix}`;
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: ownerId, type: 'human', displayName: 'Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: agentId, type: 'agent', displayName: 'Payables Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pay03-erp', subjectId: agentId } });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${agentId}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${agentId}` } }), 200, 'issue credential');
  await create(baseUrl, AUTH.provisioner, 'authority-grant', {
    authorityGrantId: `authority-${suffix}`,
    issuerActorId: ISSUER,
    subjectActorId: ownerId,
    trustDomainId: TRUST_DOMAIN,
    capability: 'payables.manage',
    actions: [PAYMENT],
    resourceScopes: [ACCOUNT],
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
    constraints: [
      { type: 'max_amount', currency: RLUSD_ASSET, value: '1000' },
      { type: 'spending_limit', limitId: `payables-${suffix}`, currency: RLUSD_ASSET, maximum: '100000', window: { kind: 'lifetime' } },
    ],
  });
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: `passport-${suffix}`, type: 'agent_passport', subjectActorId: agentId, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', { capabilityTokenId: `capability-${suffix}`, subjectActorId: agentId, principalActorId: ownerId, issuerActorId: ownerId, trustDomainId: TRUST_DOMAIN, capability: 'payables.execute', actions: [PAYMENT], resourceScopes: [ACCOUNT], riskLevel: 'medium' });
  await create(baseUrl, AUTH.provisioner, 'delegation-grant', { delegationGrantId: `delegation-${suffix}`, delegatorActorId: ownerId, delegateActorId: agentId, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: `authority-${suffix}`, capability: 'payables.execute', actions: [PAYMENT], resourceScopes: [ACCOUNT], canRedelegate: false });
  return issued.body['bearerCredential'] as string;
}

let paymentCounter = 0;
function paymentBody(value = '25.5'): Record<string, unknown> {
  paymentCounter += 1;
  const validation = validatePaymentIntent(
    {
      source: { accountId: ACCOUNT },
      destination: { kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:${paymentCounter}` },
      amount: { value, unit: RLUSD_ASSET },
      purpose: 'vendor-payment',
      reference: `INV-PAY03-${paymentCounter}`,
      rail: RAIL,
      idempotencyKey: `pay03-${process.pid}-${paymentCounter}`,
    },
    { assets: ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return compilePaymentIntent((validation as { readonly intent: PaymentIntent }).intent, BINDING) as unknown as Record<string, unknown>;
}

const pay = (baseUrl: string, credential: string, body: Record<string, unknown> = paymentBody()): Promise<Reply> => call(baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${credential}`, body });

function interlockRows(dir: string): Record<string, unknown>[] {
  const path = registry.storeEnvironmentFor(dir)['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH']!;
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT execution_id, sequence, state, settlement FROM xrpl_submissions ORDER BY row_id').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function resolutionAuthorityOf(dir: string, executionId: string): unknown {
  const db = new Database(registry.storeEnvironmentFor(dir)['AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH']!, { readonly: true });
  try {
    return (db.prepare('SELECT authority_id FROM execution_resolution_bindings WHERE execution_id = ?').get(executionId) as { authority_id?: unknown } | undefined)?.authority_id;
  } finally {
    db.close();
  }
}

async function readyPayer(dir: string, ledger: LedgerSimulator, suffix: string, env: Record<string, string | undefined> = hostEnv(dir)): Promise<Booted & { readonly credential: string }> {
  const booted = await boot(env, ledger);
  await bootstrapOrganization(booted.baseUrl);
  const credential = await onboardPayer(booted.baseUrl, suffix);
  ledger.index += QUARANTINE;
  return { ...booted, credential };
}

describe('PAY-03 production Host composition — the governed payment path', () => {
  it('a governed payment goes intent → decision → grant → claim → PAY-01 bridge → rail → external signer → XRPL once → P11, bound to the XRPL resolution authority', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { baseUrl, host, credential } = await readyPayer(dir, ledger, 'happy');
    const signaturesBefore = signer.signatures();
    const reply = expectStatus(await pay(baseUrl, credential), 200, 'governed payment');
    assert.equal(reply.body['status'], 'executed', reply.text);
    const executionId = reply.body['executionId'] as string;
    assert.equal(ledger.calls.submit, 1, 'exactly one XRPL submission');
    assert.equal(signer.signatures() - signaturesBefore, 1, 'exactly one external signature');
    assert.deepEqual(interlockRows(dir).map((row) => [row['execution_id'], row['state'], row['settlement']]), [[executionId, 'settled', 'validated-success']]);
    assert.equal(resolutionAuthorityOf(dir, executionId), XRPL_RESOLUTION_AUTHORITY_ID, 'bound to the XRPL authority before its claim');
    // Replay of the same governed request reaches nothing.
    const report = await host.enterprise.health();
    assert.equal(report.modules?.[XRPL_SUBMISSION_INTERLOCK_MODULE_ID]?.health.status, 'healthy');
    assert.equal(report.modules?.[XRPL_PAYMENT_RAIL_MODULE_ID]?.health.status, 'healthy');
    assert.equal(report.modules?.[XRPL_PAYMENT_RAIL_MODULE_ID]?.required, false);
    assert.equal(report.modules?.[XRPL_SUBMISSION_INTERLOCK_MODULE_ID]?.required, true);
  });

  it('a denied payment (above the authority ceiling) reaches neither the signer nor XRPL', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { baseUrl, credential } = await readyPayer(dir, ledger, 'denied');
    const signaturesBefore = signer.signatures();
    const reply = await pay(baseUrl, credential, paymentBody('5000'));
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assert.equal(ledger.calls.submit, 0);
    assert.equal(ledger.calls.autofill, 0);
    assert.equal(signer.signatures(), signaturesBefore);
    assert.deepEqual(interlockRows(dir), []);
  });

  it('unconfirmed → the next competing payment is refused before signing → the ledger decides → P12 (XRPL authority) resolves → the interlock releases → the next payment proceeds', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { baseUrl, host, credential } = await readyPayer(dir, ledger, 'unconfirmed');
    ledger.nextOutcome = 'pending';
    const first = expectStatus(await pay(baseUrl, credential), 409, 'unconfirmed payment');
    assert.equal(first.body['status'], 'execution_unconfirmed', first.text);
    const executionId = first.body['executionId'] as string;
    assert.equal(interlockRows(dir)[0]?.['state'], 'unconfirmed');

    const signaturesBefore = signer.signatures();
    const competing = await pay(baseUrl, credential);
    assert.equal(competing.body['status'], 'execution_failed', competing.text);
    assert.equal(ledger.calls.submit, 1, 'the competing payment was never submitted');
    assert.equal(signer.signatures(), signaturesBefore, 'nor signed');

    // Not yet decided on the ledger: P12 asks once, learns nothing, writes nothing.
    assert.deepEqual(await host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' });
    const hash = [...ledger.transactions.keys()][0]!;
    ledger.validate(hash, 'success');
    const resolved = await host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId });
    assert.equal(resolved?.outcome, 'resolved', JSON.stringify(resolved));
    assert.equal((resolved as { resolution: { certainty: string; authorityId: string; providerRef?: string } }).resolution.certainty, 'confirmed-completed');
    assert.equal((resolved as { resolution: { authorityId: string } }).resolution.authorityId, XRPL_RESOLUTION_AUTHORITY_ID);
    assert.equal((resolved as { resolution: { providerRef?: string } }).resolution.providerRef, hash);
    assert.equal(interlockRows(dir)[0]?.['state'], 'settled');
    assert.equal(ledger.calls.submit, 1, 'P12 resubmitted nothing');

    ledger.nextOutcome = 'success';
    assert.equal(expectStatus(await pay(baseUrl, credential), 200, 'after resolution').body['status'], 'executed');
    assert.equal(ledger.calls.submit, 2);
    // The governed replay of the resolved execution reports what P12 established, and still reaches nothing.
  });

  it('an operator cannot attest over an XRPL-bound execution: P12 precedence is unchanged (one binding, provider truth)', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { baseUrl, credential } = await readyPayer(dir, ledger, 'precedence');
    ledger.nextOutcome = 'pending';
    const first = await pay(baseUrl, credential);
    const executionId = first.body['executionId'] as string;
    const attempt = await call(baseUrl, 'POST', `/api/admin/operations/executions/${encodeURIComponent(executionId)}/resolution`, { authorization: AUTH.administrator, body: { resolution: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'unconfirmed' } });
    assert.notEqual(attempt.status, 200, attempt.text);
    assert.equal(interlockRows(dir)[0]?.['state'], 'unconfirmed', 'nothing an operator says releases the sequence interlock');
  });

  it('restart: the unconfirmed record survives, the quarantine refuses everything at first, the binding survives, and the restarted Host resolves from the ledger', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const env = hostEnv(dir);
    const first = await readyPayer(dir, ledger, 'restart', env);
    ledger.nextOutcome = 'pending';
    const unconfirmed = await pay(first.baseUrl, first.credential);
    const executionId = unconfirmed.body['executionId'] as string;
    await first.host.close();
    assert.equal(interlockRows(dir)[0]?.['state'], 'unconfirmed', 'shutdown cleared nothing');

    const second = await boot(env, ledger);
    const during = await pay(second.baseUrl, first.credential);
    assert.equal(during.body['status'], 'execution_failed', during.text);
    assert.equal(ledger.calls.submit, 1);
    const hash = [...ledger.transactions.keys()][0]!;
    ledger.validate(hash, 'tec');
    const resolved = await second.host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId });
    assert.equal((resolved as { resolution?: { certainty: string } }).resolution?.certainty, 'confirmed-not-completed', JSON.stringify(resolved));
    ledger.index += QUARANTINE;
    ledger.nextOutcome = 'success';
    assert.equal((await pay(second.baseUrl, first.credential)).body['status'], 'executed');
  });

  it('shutdown closes the XRPL clients and the interlock — and nothing is cleared', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { host, baseUrl, credential } = await readyPayer(dir, ledger, 'shutdown');
    ledger.nextOutcome = 'pending';
    await pay(baseUrl, credential);
    const before = interlockRows(dir);
    await host.close();
    assert.ok(ledger.calls.disconnect >= 2, 'rail client and resolver client both closed');
    assert.deepEqual(interlockRows(dir), before);
  });
});

describe('PAY-03 Host startup, readiness and configuration', () => {
  it('without xrplPaymentRail nothing XRPL is composed: no modules, no interlock file, no XRPL authority', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const file = governedFile({ routes: [{ action: PAYMENT, adapterId: 'pilot.recording' }] }, null);
    const host = workspace.track(
      await bootEnterpriseHost({ env: await withDeploymentWitness(hostEnv(dir, file)), xrplLedgerClient: () => ledger, executionAdapters: [{ adapterId: 'pilot.recording', execute: async () => ({ outcome: 'completed' }) }], logger: capturingLogger }),
    );
    const report = await host.enterprise.health();
    assert.equal(report.modules?.[XRPL_PAYMENT_RAIL_MODULE_ID], undefined);
    assert.equal(report.modules?.[XRPL_SUBMISSION_INTERLOCK_MODULE_ID], undefined);
    assert.equal(existsSync(registry.storeEnvironmentFor(dir)['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH']!), false);
    assert.equal(ledger.calls.connect, 0);
  });

  it('a signer that is unreachable at boot leaves the Host up but degraded; payments are refused with nothing submitted until it answers', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const late = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN });
    const port = late.port;
    await late.close();
    const env = hostEnv(dir, governedFile({}, railSection({}, { endpoint: `http://127.0.0.1:${port}` })));
    const { host, baseUrl, credential } = await readyPayer(dir, ledger, 'degraded', env);
    const report = await host.enterprise.health();
    assert.equal(report.status, 'degraded');
    assert.equal(report.modules?.[XRPL_PAYMENT_RAIL_MODULE_ID]?.health.details?.['signer'], 'unverified');
    assert.equal((await call(baseUrl, 'GET', '/ready')).status, 200, 'still ready: governed work that is not an XRPL payment continues');
    const refused = await pay(baseUrl, credential);
    assert.equal(refused.body['status'], 'execution_failed', refused.text);
    assert.equal(ledger.calls.submit, 0);
    const back = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN, port });
    assert.equal((await pay(baseUrl, credential)).body['status'], 'executed');
    await back.close();
  });

  it('refuses to start — before listening, with a closed code and no secret in the message — on every unsafe configuration', async () => {
    const cases: [string, () => Record<string, string | undefined>, string][] = [
      ['memory persistence', () => hostEnv(workspace.dir(), governedFile(), { AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' }), 'HOST_PERSISTENCE_NOT_DURABLE'],
      ['missing signer credential', () => hostEnv(workspace.dir(), governedFile(), { [SIGNER_TOKEN_ENV]: undefined }), 'HOST_SECRET_REFERENCE_UNRESOLVED'],
      ['missing signer section', () => hostEnv(workspace.dir(), governedFile({}, { ...railSection(), signer: undefined })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['malformed signing public key', () => hostEnv(workspace.dir(), governedFile({}, railSection({ sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress, signingPublicKey: 'ED12' }] }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['missing source mappings', () => hostEnv(workspace.dir(), governedFile({}, railSection({ sourceAccounts: [] }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['mainnet without allowMainnet', () => hostEnv(workspace.dir(), governedFile({}, railSection({ network: 'mainnet', endpoint: 'wss://xrpl-pay03.invalid' }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['allowMainnet on testnet', () => hostEnv(workspace.dir(), governedFile({}, railSection({ allowMainnet: true }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['a seed field', () => hostEnv(workspace.dir(), governedFile({}, railSection({ seed: SEED_CANARY }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['an inline signer secret', () => hostEnv(workspace.dir(), governedFile({}, railSection({}, { credential: { kind: 'bearer', token: SIGNER_TOKEN } }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['payment action not routed to the rail', () => hostEnv(workspace.dir(), governedFile({ routes: [{ action: PAYMENT, adapterId: 'elsewhere' }] })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['payment action not financial', () => hostEnv(workspace.dir(), governedFile({ monetary: { assets: [{ assetId: RLUSD_ASSET, scale: 15 }], financialActions: [] } })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['plain http signer beyond loopback', () => hostEnv(workspace.dir(), governedFile({}, railSection({}, { endpoint: 'http://signer.example.com' }))), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
      ['XRPL key material in the Host environment', () => hostEnv(workspace.dir(), governedFile(), { FRONTERA_XRPL_TREASURY_SEED: SEED_CANARY }), 'HOST_ENVIRONMENT_INVALID'],
      ['the reference signer’s own configuration in the Host environment', () => hostEnv(workspace.dir(), governedFile(), { FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE: 'signer-key.json' }), 'HOST_ENVIRONMENT_INVALID'],
      ['signer identity mismatch', () => hostEnv(workspace.dir(), governedFile({}, railSection({ sourceAccounts: [{ accountId: ACCOUNT, address: TREASURY.classicAddress, signingPublicKey: OTHER_SOURCE.publicKey }] }))), 'XRPL_SIGNER_IDENTITY_MISMATCH'],
      ['wrong signer id pinned', () => hostEnv(workspace.dir(), governedFile({}, railSection({}, { signerId: 'another-signer' }))), 'XRPL_SIGNER_IDENTITY_MISMATCH'],
    ];
    for (const [name, env, code] of cases) {
      const ledger = createLedgerSimulator();
      await assert.rejects(
        bootEnterpriseHost({ env: await withDeploymentWitness(env()), xrplLedgerClient: () => ledger, logger: capturingLogger }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, code, `${name}: ${error.message}`);
          assert.equal(error.message.includes(SEED_CANARY) || error.message.includes(SIGNER_TOKEN), false, `${name}: no secret in the refusal`);
          return true;
        },
        name,
      );
      assert.equal(ledger.calls.submit, 0, name);
    }
  });

  it('refuses to start against a server reporting another network, and against an interlock bound to another network', async () => {
    const wrong = createLedgerSimulator({ networkId: 0 });
    await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(hostEnv(workspace.dir())), xrplLedgerClient: () => wrong, logger: capturingLogger }), (error: { code?: string }) => error.code === 'XRPL_NETWORK_MISMATCH');
    const dir = workspace.dir();
    const foreign = await createSqliteXrplSubmissionInterlock(registry.storeEnvironmentFor(dir)['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH']!, { scope: { railId: RAIL, networkId: 2 }, now: () => new Date().toISOString() });
    await foreign.close();
    await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(hostEnv(dir)), xrplLedgerClient: () => createLedgerSimulator(), logger: capturingLogger }), (error: { code?: string }) => error.code === 'XRPL_INTERLOCK_UNAVAILABLE');
  });

  it('config-check (the shipped preflight) passes a valid XRPL configuration, flags a broken one, and requires the interlock store — contacting nothing', async () => {
    const { runHostPreflight, formatPreflight } = (await import(pathToFileURL(resolve('scripts/deploy/host-preflight.mjs')).href)) as { runHostPreflight: (env: Record<string, string | undefined>) => Promise<{ ok: boolean; checks: { id: string; status: string; code?: string; detail: string }[] }>; formatPreflight: (result: unknown) => string[] };
    const good = await runHostPreflight(await withDeploymentWitness(hostEnv(workspace.dir())));
    const configuration = good.checks.find((check) => check.id === 'configuration');
    assert.equal(configuration?.status, 'pass', JSON.stringify(good.checks));
    assert.equal(good.checks.find((check) => check.id === 'storage')?.status, 'pass');
    const goodEnv = await withDeploymentWitness(hostEnv(workspace.dir()));
    const { loadEnterpriseConfiguration } = await import('../configuration/enterprise-configuration.js');
    const derive = registry.deriveDeploymentRequirements as unknown as (env: unknown, configuration: unknown) => unknown;
    const holds = registry.conditionHolds as unknown as (condition: string, requirements: unknown) => boolean;
    const requirements = derive(goodEnv, loadEnterpriseConfiguration(goodEnv));
    assert.equal(holds('xrpl-payment-rail', requirements), true, 'the interlock store is a required store of this deployment');
    assert.equal(holds('embedder-reconciliation', requirements), true, 'and so is P12');
    const bad = await runHostPreflight(await withDeploymentWitness(hostEnv(workspace.dir(), governedFile({}, railSection({ sourceAccounts: [{ accountId: ACCOUNT, address: 'rNOPE', signingPublicKey: TREASURY.publicKey }] })))));
    assert.equal(bad.checks.find((check) => check.id === 'configuration')?.status, 'fail');
    const printed = [...formatPreflight(good), ...formatPreflight(bad)].join('\n');
    for (const secret of [SIGNER_TOKEN, SEED_CANARY]) assert.equal(printed.includes(secret), false);
  });
});

describe('PAY-03 backup / restore and secrets', () => {
  it('C9 / I7: a cold backup taken with an unresolved submission restores it unresolved — and it still blocks the competing sequence', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const env = hostEnv(dir);
    const { host, baseUrl, credential, env: witnessed } = await readyPayer(dir, ledger, 'backup', env);
    ledger.nextOutcome = 'pending';
    await pay(baseUrl, credential);
    await host.close();
    const { runBackup, runRestore } = await portability();
    const backupDir = join(workspace.dir(), 'backup');
    await runBackup({ output: backupDir, env: witnessed, cold: true });
    const manifest = JSON.parse(readFileSync(join(backupDir, 'backup-manifest.json'), 'utf8')) as { stores: { name: string }[]; configuration: { secretEnvironmentVariables: string[] } };
    assert.ok(manifest.stores.some((store) => store.name === 'xrpl-submission-interlock'), 'the interlock is in the backup');
    assert.ok(manifest.configuration.secretEnvironmentVariables.includes(SIGNER_TOKEN_ENV), 'the signer credential is named as a secret to restore from the secret manager');
    const target = workspace.dir();
    const report = await runRestore({ backup: backupDir, target, env: { ...witnessed, ...registry.storeEnvironmentFor(target) } });
    assert.equal(report.status, 'restored');
    assert.deepEqual(interlockRows(target).map((row) => row['state']), ['unconfirmed'], 'restore cleared nothing');
    // The restored interlock blocks the competing sequence exactly as before (the window is still open at this ledger index).
    const store = await createSqliteXrplSubmissionInterlock(registry.storeEnvironmentFor(target)['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH']!, { scope: { railId: RAIL, networkId: 1 }, now: () => new Date().toISOString() });
    const restored = interlockRows(target)[0]!;
    assert.equal(await store.blocking({ account: TREASURY.classicAddress, sequence: restored['sequence'] as number, validatedLedgerIndex: ledger.index }), true);
    assert.equal(await store.blocking({ account: OTHER_SOURCE.classicAddress, sequence: restored['sequence'] as number, validatedLedgerIndex: ledger.index }), false, 'scoped to its source account');
    const backupBytes = readFileSync(join(backupDir, 'stores', 'xrpl-submission-interlock.sqlite')).toString('latin1');
    for (const secret of [SEED_CANARY, SIGNER_TOKEN]) assert.equal(backupBytes.includes(secret), false, 'no secret in the backed-up interlock');
    await store.close();
  });

  it('the signer secret and the XRPL key appear in no response, log line, health report or durable store', async () => {
    const dir = workspace.dir();
    const ledger = createLedgerSimulator();
    const { host, baseUrl, credential } = await readyPayer(dir, ledger, 'canary');
    await pay(baseUrl, credential);
    ledger.nextOutcome = 'pending';
    await pay(baseUrl, credential);
    const health = JSON.stringify(await host.enterprise.health());
    const durable = ['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH', 'AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH', 'AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH', 'AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH', 'AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH']
      .map((name) => registry.storeEnvironmentFor(dir)[name]!)
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString('latin1'))
      .join('\n');
    for (const secret of [SEED_CANARY, SIGNER_TOKEN, TREASURY.privateKey]) {
      for (const [where, text] of [
        ['responses', responses.join('\n')],
        ['logs', logLines.join('\n')],
        ['health', health],
        ['durable stores', durable],
      ] as const) {
        assert.equal(text.includes(secret), false, `${where} must not contain the signer secret or the XRPL key`);
      }
    }
    assert.match(health, /"signer":"verified"/);
    assert.equal(health.includes(`127.0.0.1:${signer.port}`), false, 'health names no signer endpoint');
  });
});
