import dns from 'node:dns';
import https from 'node:https';
import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { openExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuanceRecord } from '../execution-capability-issuance/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER, decodeExecutionCapabilityPresentation } from '../execution-capability-presentation/index.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/index.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN, parseExecutorReceipt } from '../executor-receipt/index.js';
import { openExecutionReceiptEvidenceStore } from '../execution-receipt-evidence/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { capturingLogger, create, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
  CTRL04_OPERATORS,
  DEPLOY,
  GOVERNANCE,
  ISSUER as ORG_ISSUER,
  ORG,
  SELF_AGENT,
  TRUST_DOMAIN,
  assertAwaitingApproval,
  bearer,
  bootstrap,
  call,
  command,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  detail,
  errorCodeOf,
  expectStatus,
  failureOf,
  govern,
  inbox,
  operatorActor,
  releaseKey,
  standing,
  type Reply,
} from './ctrl04-host-fixture.js';
import { CREDENTIAL_TOKEN } from './g02c0-execution-binding-fixture.js';
import { BEARER_ENV, parseRaw, type SpawnedExecutor } from './g02c1a-reference-executor-fixture.js';
import { E2E_EXECUTOR_ID, E2E_RECEIPT_KEY_ID, eventually, executorDomain, loopbackHostPrimitive, spawnE2EExecutor, startRelay, type ExecutorDomain, type Relay } from './g02c1d-end-to-end-fixture.js';

/**
 * AUTH-01 — connected human approval to governed execution (reference only, synthetic).
 *
 * One canonical shipped Host (`bootEnterpriseHost()`, production profile,
 * SQLite, signed authority artifacts, CORE-07 witness, software custody) with
 * **no in-process policy**: the only thing that sends a decision to a human is
 * the governed-action file's PROD-03 `approvalPolicy`. Every actor, authority,
 * credential and approver standing is provisioned over HTTP by identified
 * CTRL-02 operators, exactly as the CTRL-04 qualification does. Approvals are
 * decided over the CTRL-04 operator plane. The approved request then runs the
 * G-02 chain unchanged: G-02B issuance, the G-02C0 binding gate, presentation
 * to the G-02C1A/B/C reference executor in its own process, and G-02C1D receipt
 * verification and evidence.
 *
 * Nothing in production source is changed or simulated. The scenario:
 *
 * - agent `actor-deploy-agent`, delegated `synthetic.deploy-release` over two
 *   synthetic production environments only;
 * - approver `operator:cto`, an operator with the CTRL-04 `approver` role and
 *   Kernel-Authority standing for `approve-deploy` — never for the governed
 *   action itself;
 * - one approval required (`minimumApprovals: 1`), requester ≠ approver.
 *
 * **Human authentication is NOT qualified here.** Operators authenticate with
 * the existing reference mechanism: a static bearer secret per operator. That
 * is not individual human authentication, not phishing-resistant, not
 * WebAuthn/passkeys and not a mobile approval experience (AUTH-02/AUTH-03).
 *
 * **Transport, test-only, exactly as the G-02C1D shipped-Host suite and
 * DEMO-01A:** the gated adapter's hostname resolves (in this process) to a
 * public documentation address, and its HTTPS request is sent — for that
 * hostname alone — as plain HTTP to a Unix-socket byte relay in front of the
 * loopback executor. No TLS, no certificate check, no public DNS, and no
 * connect-address decision over a real answer. The Host's transport code and
 * the executor's loopback-only, synthetic-only configuration are unchanged.
 *
 * **Concurrency:** one Host process. The conflicting-verdict test proves the
 * in-process outcome only; it makes no multi-process claim.
 */

const CAPABILITY_ISSUER = 'frontera-auth01-host';
const AUDIENCE = 'executor-auth01-deploy-gateway';
const GATED = 'auth01.deploy-gateway';
const HOSTNAME = 'deploy-gateway.example';
const SYNTHETIC = 'synthetic.deploy-release';
const APPROVE_DEPLOY = 'approve-deploy';
const APPROVE_OTHER = 'approve-other';
/** The delegated environment the executor will act on. */
const PRODUCTION = 'production-environment-example';
/** A second delegated environment of the same class: approvals for one never cover the other. */
const SECONDARY = 'production-secondary-environment-example';
const RELEASE = 'release-42';
const OWNER = 'actor-deploy-owner';
const AGENT = 'actor-deploy-agent';
const AGENT_SUBJECT = { system: 'auth01-ci', subjectId: 'deploy-agent-1' } as const;
const SELF_SUBJECT = { system: 'auth01-ci', subjectId: 'deploy-agent-self' } as const;
const CREDENTIAL_ENV = 'FRONTERA_TEST_AUTH01_EXECUTOR_TOKEN';
const POLICY_ID = 'auth01-approvals';

/** The CTO: an approver operator, authenticated by the existing reference mechanism (a static bearer secret). */
const CTO = { operatorId: 'cto', role: 'approver', apiKeyEnv: 'FRONTERA_AUTH01_CTO' } as const;
const CTO_SECRET = 'FRONTERA_AUTH01_CTO_SECRET_6b2e9d4a1c7f3e8059';
const CTO_AUTH = bearer(CTO_SECRET);

const APPROVAL = { approverAction: APPROVE_DEPLOY, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 } as const;

const GOVERNANCE_AUTH01 = {
  ...GOVERNANCE,
  actionClasses: [...GOVERNANCE.actionClasses, { id: 'synthetic', actions: [SYNTHETIC] }],
  resourceClasses: [...GOVERNANCE.resourceClasses, { id: 'production_environment', resources: [PRODUCTION, SECONDARY] }],
  profiles: [
    ...GOVERNANCE.profiles,
    {
      profileId: 'synthetic-deploy-production',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'synthetic',
      resourceClass: 'production_environment',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: [POLICY_ID],
      approval: APPROVAL,
    },
  ],
};

const ADAPTER = {
  adapterId: GATED,
  origin: `https://${HOSTNAME}`,
  method: 'POST',
  path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
  headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
  body: { kind: 'json-object', fields: { release: { kind: 'parameter', dimension: 'releaseVersion' }, subject: { kind: 'source', source: 'subject' } } },
  credential: { kind: 'bearer', tokenEnv: CREDENTIAL_ENV },
  timeoutMs: 5_000,
} as const;

function governedFile(dir: string, executorPublicKeyPem: string): Record<string, unknown> {
  return {
    ...ctrl04File(GOVERNANCE_AUTH01),
    operators: [...CTRL04_OPERATORS, CTO],
    routes: [
      { action: DEPLOY, adapterId: 'pilot.recording' },
      { action: SYNTHETIC, adapterId: GATED },
    ],
    approvalPolicy: { policyId: POLICY_ID, rules: [{ ruleId: 'synthetic-production-deploy-review', governanceProfile: 'synthetic-deploy-production', reasonCode: 'PRODUCTION_DEPLOY_REVIEW' }] },
    genericHttpAdapters: [ADAPTER],
    executionCapabilities: {
      issuer: CAPABILITY_ISSUER,
      issuanceLedgerPath: join(dir, 'execution-capability-issuance.sqlite'),
      audiences: [{ audience: AUDIENCE, actions: [SYNTHETIC], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }],
      adapters: [{ adapterId: GATED, audience: AUDIENCE }],
      receiptEvidence: {
        storePath: join(dir, 'evidence', 'receipt-evidence.sqlite'),
        trustedExecutors: [
          { executorId: E2E_EXECUTOR_ID, keys: [{ keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: executorPublicKeyPem.trim() }], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] },
        ],
      },
    },
  };
}

/** The operator's one-time initializations: the issuance ledger and the evidence store (in a private directory of its own). */
async function initialize(dir: string): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: CAPABILITY_ISSUER, clock: Date.now, create: true })).close();
  mkdirSync(join(dir, 'evidence'), { mode: 0o700 });
  (await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: CAPABILITY_ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now, create: true })).close();
}

async function bootAuth01(dir: string, executorPublicKeyPem: string): Promise<{ readonly host: EnterpriseHost; readonly baseUrl: string }> {
  await initialize(dir);
  const env = ctrl04Env(dir, governedFile(dir, executorPublicKeyPem), { [CTO.apiKeyEnv]: CTO_SECRET, [CREDENTIAL_ENV]: CREDENTIAL_TOKEN });
  const host = await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [recordingAdapter()], logger: capturingLogger });
  const { port } = await host.listen();
  return { host, baseUrl: `http://127.0.0.1:${port}` };
}

// ── Provisioning, over HTTP, by identified operators ────────────────────────

/** A narrowly scoped agent: `synthetic.deploy-release` over the two synthetic production environments, delegated by its owner. Returns its one-time credential. */
async function onboardDeployAgent(baseUrl: string, agentId: string, subject: { readonly system: string; readonly subjectId: string }, suffix: string): Promise<string> {
  const owners = await call(baseUrl, 'GET', '/api/admin/authority/entities?kind=actor', { authorization: AUTH.observer });
  if (!(owners.body['entities'] as { entityId: string }[]).some((entity) => entity.entityId === OWNER)) {
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Deployment Owner', issuerId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'authority-grant', {
      authorityGrantId: 'authority-deploy-owner',
      issuerActorId: ORG_ISSUER,
      subjectActorId: OWNER,
      trustDomainId: TRUST_DOMAIN,
      capability: 'deploy.manage',
      actions: [SYNTHETIC],
      resourceScopes: [PRODUCTION, SECONDARY],
      canDelegate: true,
      allowedDelegateActorTypes: ['agent'],
      maxDelegationDepth: 1,
    });
  }
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: agentId, type: 'agent', displayName: `Deploy agent ${suffix}`, issuerId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: subject });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${encodeURIComponent(agentId)}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${suffix}-credential` } }), 200, 'issue credential');
  const credential = issued.body['bearerCredential'];
  assert.equal(typeof credential, 'string', issued.text);
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: `passport-${suffix}`, type: 'agent_passport', subjectActorId: agentId, issuerActorId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', {
    capabilityTokenId: `capability-${suffix}`,
    subjectActorId: agentId,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'deploy.execute',
    actions: [SYNTHETIC],
    resourceScopes: [PRODUCTION, SECONDARY],
    riskLevel: 'medium',
  });
  await create(baseUrl, AUTH.provisioner, 'delegation-grant', {
    delegationGrantId: `delegation-${suffix}`,
    delegatorActorId: OWNER,
    delegateActorId: agentId,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: 'authority-deploy-owner',
    capability: 'deploy.execute',
    actions: [SYNTHETIC],
    resourceScopes: [PRODUCTION, SECONDARY],
    canRedelegate: false,
  });
  return credential as string;
}

interface Organization {
  readonly agentCredential: string;
  readonly selfCredential: string;
}

/**
 * The organization: the deploy agent; a second agent whose actor id is also
 * the `approver-self` operator's identity (the self-approval case, which also
 * holds approval standing so that only segregation of duties stands in its
 * way); and approver standing — `operator:cto`, `approver-a` and `approver-b`
 * hold `approve-deploy` over both environments; `approver-c` over the
 * secondary environment only; `approver-d` for another approver action;
 * `approver-e` only the authority to *execute* the action.
 */
async function provisionOrganization(baseUrl: string): Promise<Organization> {
  await bootstrap(baseUrl);
  const agentCredential = await onboardDeployAgent(baseUrl, AGENT, AGENT_SUBJECT, 'agent');
  const selfCredential = await onboardDeployAgent(baseUrl, SELF_AGENT, SELF_SUBJECT, 'self');
  for (const operatorId of [CTO.operatorId, 'approver-a', 'approver-b']) {
    await standing(baseUrl, await operatorActor(baseUrl, operatorId), APPROVE_DEPLOY, [PRODUCTION, SECONDARY], `approval-standing-${operatorId}`);
  }
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-c'), APPROVE_DEPLOY, [SECONDARY], 'approval-standing-approver-c');
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-d'), APPROVE_OTHER, [PRODUCTION, SECONDARY], 'approval-standing-approver-d');
  // approver-e: authority to execute the governed action itself — and none to approve it.
  await create(baseUrl, AUTH.provisioner, 'authority-grant', {
    authorityGrantId: 'execution-standing-approver-e',
    issuerActorId: ORG_ISSUER,
    subjectActorId: await operatorActor(baseUrl, 'approver-e'),
    trustDomainId: TRUST_DOMAIN,
    capability: 'deploy.execute',
    actions: [SYNTHETIC],
    resourceScopes: [PRODUCTION, SECONDARY],
    canDelegate: false,
    allowedDelegateActorTypes: ['human'],
    maxDelegationDepth: 0,
  });
  await standing(baseUrl, SELF_AGENT, APPROVE_DEPLOY, [PRODUCTION, SECONDARY], 'approval-standing-approver-self');
  return { agentCredential, selfCredential };
}

// ── The governed path and the approval plane ───────────────────────────────

const deploy = (resource: string, idempotencyKey: string, releaseVersion: string = RELEASE): Record<string, unknown> => ({ action: SYNTHETIC, resource, parameters: { releaseVersion }, idempotencyKey });

/** The approval request a withheld reply opened, found in the inbox by its governed request id (as an operator would find it). */
async function approvalFor(baseUrl: string, reply: Reply): Promise<Record<string, unknown>> {
  const requestId = reply.body['requestId'];
  assert.equal(typeof requestId, 'string', reply.text);
  const entry = (await inbox(baseUrl, AUTH.observer, 'all')).find((candidate) => candidate['requestId'] === requestId);
  assert.ok(entry !== undefined, `request ${String(requestId)} appears in the inbox`);
  return detail(baseUrl, entry['approvalRequestId'] as string);
}

const id = (approval: Record<string, unknown>): string => approval['approvalRequestId'] as string;
const digestOf = (approval: Record<string, unknown>): string => approval['subjectDigest'] as string;
const subjectOf = (approval: Record<string, unknown>): Record<string, unknown> => approval['subject'] as Record<string, unknown>;
const decisionIdOf = (reply: Reply): unknown => (reply.body['decision'] as Record<string, unknown> | undefined)?.['decisionId'];
const reasonCodesOf = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as string[] | undefined) ?? [];

function expectRefusal(reply: Reply, failure: string, where: string): void {
  assert.equal(reply.status, 409, `${where}: ${reply.text}`);
  assert.equal(errorCodeOf(reply), 'OPERATOR_OPERATION_REFUSED', where);
  assert.equal(failureOf(reply), failure, `${where}: ${reply.text}`);
  assert.equal((reply.body['error'] as Record<string, unknown>)['recorded'], false, where);
}

function countRows(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number }).n;
  } finally {
    db.close();
  }
}

const NAME = (line: string): string => line.slice(0, line.indexOf(':')).toLowerCase();

describe('AUTH-01 — human approval connected to signed, request-bound execution on the shipped Host', { timeout: 300_000 }, () => {
  const workspace = createWorkspace('frontera-auth01-');
  const cleanups: (() => void | Promise<void>)[] = [];
  const realLookup = dns.promises.lookup;
  const realRequest = https.request;
  let route: { readonly path: string } | undefined;
  let domain: ExecutorDomain;
  let executor: SpawnedExecutor;
  let relay: Relay;
  let lossyRelay: Relay;
  let baseUrl: string;
  let dir: string;
  let org: Organization;

  const issuanceRows = (): number => countRows(join(dir, 'execution-capability-issuance.sqlite'), 'execution_capability_issuances');
  const observationRows = (): number => countRows(join(dir, 'evidence', 'receipt-evidence.sqlite'), 'receipt_observations');
  const requestsSeen = (): number => relay.requests.length + lossyRelay.requests.length;
  const effects = (): number => domain.records().length;
  /** Everything that would show an execution happened: Host issuance, anything reaching the executor, any synthetic effect, any evidence. */
  const footprint = (): readonly number[] => [issuanceRows(), requestsSeen(), effects(), observationRows()];

  async function issuanceOf(executionId: string): Promise<ExecutionCapabilityIssuanceRecord> {
    const ledger = await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: CAPABILITY_ISSUER, clock: Date.now });
    try {
      return ledger.read(executionId);
    } finally {
      ledger.close();
    }
  }

  async function evidenceOf(executionId: string) {
    const store = await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: CAPABILITY_ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now });
    try {
      return { observations: store.observationsFor(executionId), evidence: store.evidenceFor(executionId) };
    } finally {
      store.close();
    }
  }

  /** A fresh request that waits for approval; returns the withheld reply, its approval and the idempotency key. */
  async function pending(resource: string = PRODUCTION, prefix = 'auth01'): Promise<{ readonly key: string; readonly withheld: Reply; readonly approval: Record<string, unknown> }> {
    const key = releaseKey(prefix);
    const withheld = await govern(baseUrl, org.agentCredential, deploy(resource, key));
    assertAwaitingApproval(withheld);
    return { key, withheld, approval: await approvalFor(baseUrl, withheld) };
  }

  before(async () => {
    (dns.promises as { lookup: unknown }).lookup = async (hostname: string, options?: unknown) => (hostname === HOSTNAME ? [{ address: '93.184.216.34', family: 4 }] : (realLookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options));
    (https as unknown as { request: unknown }).request = (options: { readonly hostname?: string }, onResponse: never) => {
      if (options?.hostname === HOSTNAME && route !== undefined) return loopbackHostPrimitive(route)(options as never, onResponse);
      return (realRequest as unknown as (o: unknown, c: unknown) => unknown)(options, onResponse);
    };

    domain = await executorDomain(AUDIENCE);
    cleanups.push(() => domain.cleanup());
    executor = await spawnE2EExecutor(domain, {
      audience: AUDIENCE,
      overrides: {
        organizationIds: [ORG],
        trustDomain: TRUST_DOMAIN,
        trustedIssuers: [{ issuer: CAPABILITY_ISSUER, keys: [{ ...trustedKeyOf(AUTHORITY_KEY_A) }] }],
        permittedActions: [SYNTHETIC],
        permittedResources: [PRODUCTION],
        expectedOrigin: `https://${HOSTNAME}`,
        syntheticExecution: { effect: 'frontera.synthetic-deployment-record.v1', consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: [SYNTHETIC] },
      },
    });
    cleanups.push(() => executor.kill());
    assert.equal(executor.environment[BEARER_ENV], CREDENTIAL_TOKEN, 'the executor expects the credential the Host adapter sends');
    relay = await startRelay(domain.root, executor.port);
    cleanups.push(() => relay.close());
    lossyRelay = await startRelay(domain.root, executor.port, { dropResponse: true });
    cleanups.push(() => lossyRelay.close());

    dir = workspace.dir();
    const booted = await bootAuth01(dir, domain.publicKeyPem);
    workspace.track(booted.host);
    baseUrl = booted.baseUrl;
    org = await provisionOrganization(baseUrl);
    route = relay.target;
  });

  after(async () => {
    (dns.promises as { lookup: unknown }).lookup = realLookup;
    (https as unknown as { request: unknown }).request = realRequest;
    await workspace.close();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('A–P: request → approval required → pending → operator approves the exact subject → same key resumes → bounded capability → executor verifies and consumes → one synthetic effect → signed receipt → Host verifies, correlates and records', async () => {
    route = relay.target;
    const posture = (await call(baseUrl, 'GET', '/health')).body['posture'] as Record<string, unknown>;
    assert.equal(posture['approvals'], 'durable', 'CORE-05 approvals are on the durable, signed store');
    const [issuedBefore, requestsBefore, effectsBefore, observedBefore] = footprint();

    // A–D. The agent submits; the file-declared policy requires approval; CORE-05 opens a request; the agent is withheld.
    const key = releaseKey('auth01-approved');
    const withheld = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    assertAwaitingApproval(withheld);
    assert.ok(reasonCodesOf(withheld).includes('GOVERNED_ACTION_APPROVAL_PENDING'), withheld.text);
    assert.notEqual(withheld.body['status'], 'executed');
    assert.deepEqual(footprint(), [issuedBefore, requestsBefore, effectsBefore, observedBefore], 'awaiting approval: no capability, no request, no effect, no evidence');

    // E. The operator retrieves the actual approval request and its subject digest.
    const approval = await approvalFor(baseUrl, withheld);
    assert.equal(approval['status'], 'pending');
    assert.equal(approval['requestId'], withheld.body['requestId'], 'the approval names the governed request');
    assert.equal(approval['decisionId'], decisionIdOf(withheld), 'and its committed decision');
    assert.match(digestOf(approval), /^sha256:[0-9a-f]{64}$/);
    const subject = subjectOf(approval);
    assert.equal(subject['actorId'], AGENT);
    assert.equal(subject['action'], SYNTHETIC);
    assert.equal(subject['resourceScope'], PRODUCTION);
    assert.equal(subject['governanceProfile'], 'synthetic-deploy-production');
    assert.deepEqual((subject['parameters'] as Record<string, unknown>[]).map((p) => [p['dimension'], p['value']]), [['releaseVersion', RELEASE]]);
    assert.deepEqual((approval['requirement'] as Record<string, unknown>)['approverAction'], APPROVE_DEPLOY);
    assert.equal((approval['requirement'] as Record<string, unknown>)['minimumApprovals'], 1);

    // F–G. operator:cto approves exactly that subject, over the existing operator plane (static bearer — reference authentication only).
    const approved = await command(baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) });
    assert.equal(approved.status, 200, approved.text);
    const decided = approved.body['approval'] as Record<string, unknown>;
    assert.equal(decided['status'], 'approved');
    assert.match(decided['approvalDigest'] as string, /^sha256:[0-9a-f]{64}$/);
    const notAfter = Date.parse(decided['notAfter'] as string);
    assert.ok(Number.isFinite(notAfter));
    assert.deepEqual((decided['quorum'] as Record<string, unknown>)['countedApprovers'], ['operator:cto']);
    assert.deepEqual(footprint(), [issuedBefore, requestsBefore, effectsBefore, observedBefore], 'an approval is not an execution');

    // H–P. The agent resubmits with the SAME idempotency key; the Host revalidates and runs the G-02 chain.
    const resumed = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(resumed.body['requestId'], withheld.body['requestId'], 'the same governed request');
    assert.equal(decisionIdOf(resumed), approval['decisionId'], 'under the same committed decision (not re-evaluated)');
    const executionId = resumed.body['executionId'];
    assert.equal(typeof executionId, 'string', resumed.text);

    // J. The bounded, short-lived, single-use, request-bound capability, as the Host's issuance ledger holds it.
    const record = await issuanceOf(executionId as string);
    assert.ok(record.state !== 'absent', 'the Host issuance ledger holds a row for this execution');
    assert.equal(record.state, 'issued');
    assert.ok(record.signature !== undefined);
    const capability = record.capability;
    assert.equal(capability.executionId, executionId);
    assert.equal(capability.issuer, CAPABILITY_ISSUER);
    assert.equal(capability.issuerKeyId, AUTHORITY_KEY_A.keyId);
    assert.equal(capability.audience, AUDIENCE);
    assert.equal(capability.subjectActorId, AGENT);
    assert.equal(capability.action, SYNTHETIC);
    assert.equal(capability.resource, PRODUCTION);
    assert.equal(capability.consumption, 'single-use');
    assert.equal(capability.actionBinding.format, GENERIC_HTTP_REQUEST_BINDING_FORMAT);
    const lifetime = Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt);
    assert.ok(lifetime > 0 && lifetime <= 60_000, `short-lived (${String(lifetime)} ms)`);
    assert.ok(Date.parse(capability.expiresAt) <= notAfter, 'the capability never outlives the approval');
    assert.equal(
      verify(null, Buffer.from(`${EXECUTION_CAPABILITY_SIGNING_DOMAIN}${record.canonical}`, 'utf8'), createPublicKey(AUTHORITY_KEY_A.publicKeyPem), Buffer.from(record.signature.signature, 'base64url')),
      true,
      'the capability signature verifies independently under the Host authority key',
    );
    assert.equal(issuanceRows() - issuedBefore, 1, 'exactly one issuance');

    // K. Exactly one presentation reached the executor, carrying exactly the issued capability.
    await eventually(async () => (await evidenceOf(executionId as string)).observations.length > 0);
    const delivered = relay.requests.slice(requestsBefore);
    assert.equal(delivered.length, 1, 'one request reached the executor');
    const presentations = delivered.flatMap((bytes) => parseRaw(bytes).headerLines.filter((line) => NAME(line) === EXECUTION_CAPABILITY_PRESENTATION_HEADER).map((line) => line.slice(line.indexOf(':') + 1).trim()));
    assert.equal(presentations.length, 1);
    const decoded = decodeExecutionCapabilityPresentation(presentations[0] ?? '');
    assert.ok(decoded.ok);
    assert.equal(decoded.presentation.capability, record.canonical);
    assert.equal(decoded.presentation.signature.signature, record.signature.signature);

    // K–M. The executor's own durable state: consumed once, one synthetic effect, one signed receipt about this capability.
    const state = await domain.state(capability.capabilityId);
    assert.equal(state.state, 'completed');
    assert.equal(effects() - effectsBefore, 1, 'one synthetic effect');
    const effect = JSON.parse(domain.recordText(capability.capabilityId) ?? '{}') as Record<string, unknown>;
    assert.equal(effect['capabilityId'], capability.capabilityId);
    assert.equal(effect['executionId'], executionId);
    assert.equal(effect['bindingDigest'], capability.actionBinding.digest, 'the effect is bound to the exact request the capability names');
    const receipts = await domain.receipts(capability.capabilityId);
    assert.equal(receipts.length, 1);
    const receiptText = receipts[0]?.receipt ?? '';
    const receipt = parseExecutorReceipt(receiptText);
    assert.ok(receipt.ok);
    assert.equal(receipt.receipt.capabilityId, capability.capabilityId);
    assert.equal(receipt.receipt.executionId, executionId);
    assert.deepEqual(receipt.receipt.actionBinding, { format: capability.actionBinding.format, digest: capability.actionBinding.digest });
    assert.equal(receipt.receipt.outcome, 'completed-observed');
    assert.equal(
      verify(null, Buffer.from(`${EXECUTOR_RECEIPT_SIGNING_DOMAIN}${receiptText}`, 'utf8'), createPublicKey(domain.publicKeyPem), Buffer.from(receipts[0]?.signature.signature ?? '', 'base64url')),
      true,
      'the receipt signature verifies independently under the pinned executor key',
    );

    // N–O. The Host verified the receipt against its pinned executor key, correlated it with its own issuance, and recorded it.
    const evidence = await evidenceOf(executionId as string);
    assert.deepEqual(
      evidence.observations.map((o) => [o.transmission, o.disposition, o.agreement, o.httpOutcome, o.receiptOutcome]),
      [['response', 'receipt-correlated', 'consistent', 'completed', 'completed-observed']],
    );
    assert.equal(evidence.evidence.length, 1);
    assert.equal(evidence.evidence[0]?.presented.receipt, receiptText, 'the executor’s receipt, verbatim, as Host evidence');

    // 9. The same request again: answered from the record — no second presentation, effect or receipt.
    const again = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    assert.equal(again.body['executionId'], executionId, again.text);
    assert.equal(again.body['replayed'], true, again.text);
    assert.deepEqual([requestsSeen() - requestsBefore, effects() - effectsBefore, issuanceRows() - issuedBefore], [1, 1, 1], 'no duplicate presentation, effect or issuance');
    assert.equal((await domain.receipts(capability.capabilityId)).length, 1, 'still one receipt at the executor');
  });

  it('1 — approval pending: the agent may retry; nothing is issued, presented or performed', async () => {
    const before = footprint();
    const { key } = await pending(PRODUCTION, 'auth01-pending');
    assertAwaitingApproval(await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key)));
    assert.deepEqual(footprint(), before);
  });

  it('2 — approval rejected: final; the retry never executes and nothing is issued or performed', async () => {
    const before = footprint();
    const { key, approval } = await pending(PRODUCTION, 'auth01-rejected');
    const rejected = await command(baseUrl, CTO_AUTH, id(approval), 'reject', { subjectDigest: digestOf(approval), reason: 'outside the change window' });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal((rejected.body['approval'] as Record<string, unknown>)['status'], 'rejected');
    assertAwaitingApproval(await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key)), 'GOVERNED_ACTION_APPROVAL_REJECTED');
    expectRefusal(await command(baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_REJECTED', 'approve after a rejection');
    assert.deepEqual(footprint(), before);
  });

  it('3 — wrong approver: no credential, an agent credential, a role without approval, and every operator without exact standing are refused; nothing is recorded', async () => {
    const before = footprint();
    const { key, approval } = await pending(PRODUCTION, 'auth01-wrong-approver');
    const path = `/api/admin/approvals/${encodeURIComponent(id(approval))}/approve`;
    const body = { subjectDigest: digestOf(approval) };
    assert.equal((await call(baseUrl, 'POST', path, { body })).status, 401, 'no credential');
    assert.equal((await call(baseUrl, 'POST', path, { authorization: bearer(org.agentCredential), body })).status, 401, 'the requesting agent’s credential');
    const observer = await command(baseUrl, AUTH.observer, id(approval), 'approve', body);
    assert.equal(observer.status, 403, observer.text);
    assert.equal(errorCodeOf(observer), 'OPERATOR_PERMISSION_DENIED');
    for (const [who, authorization] of [
      ['standing over another environment only', AUTH.approverC],
      ['standing for another approver action', AUTH.approverD],
      ['authority to execute the action, none to approve it', AUTH.approverE],
      ['no Kernel-Authority actor at all', AUTH.approverNoStanding],
    ] as const) {
      expectRefusal(await command(baseUrl, authorization, id(approval), 'approve', body), 'APPROVAL_APPROVER_INELIGIBLE', who);
    }
    assert.equal((await detail(baseUrl, id(approval)))['status'], 'pending');
    assertAwaitingApproval(await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key)));
    assert.deepEqual(footprint(), before);
  });

  it('4 — requester attempts its own approval: refused by segregation of duties, even holding approval standing', async () => {
    const before = footprint();
    const key = releaseKey('auth01-self');
    const withheld = await govern(baseUrl, org.selfCredential, deploy(PRODUCTION, key));
    assertAwaitingApproval(withheld);
    const approval = await approvalFor(baseUrl, withheld);
    assert.equal(subjectOf(approval)['actorId'], SELF_AGENT, 'the requester is the operator’s own identity');
    expectRefusal(await command(baseUrl, AUTH.approverSelf, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_SEGREGATION_OF_DUTIES', 'self-approval');
    assert.equal((await detail(baseUrl, id(approval)))['status'], 'pending');
    assertAwaitingApproval(await govern(baseUrl, org.selfCredential, deploy(PRODUCTION, key)));
    assert.deepEqual(footprint(), before);
  });

  it('7 — changed action parameters: the approved subject cannot be reused', async () => {
    const before = footprint();
    const { key, approval } = await pending(PRODUCTION, 'auth01-parameters');
    assert.equal((await command(baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) })).status, 200);
    // Same idempotency key, another release: refused as a conflicting reuse of the key — the Kernel is not re-run, nothing executes.
    const conflicting = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key, 'release-43'));
    assert.notEqual(conflicting.body['status'], 'executed', conflicting.text);
    assert.ok(reasonCodesOf(conflicting).includes('GOVERNED_ACTION_IDEMPOTENCY_CONFLICT'), conflicting.text);
    // A new request for the other release is its own decision, with its own subject, and waits for its own approval.
    const fresh = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, releaseKey('auth01-parameters-new'), 'release-43'));
    assertAwaitingApproval(fresh);
    const freshApproval = await approvalFor(baseUrl, fresh);
    assert.notEqual(digestOf(freshApproval), digestOf(approval));
    // The approved subject's digest does not approve the other request.
    const crossed = await command(baseUrl, CTO_AUTH, id(freshApproval), 'approve', { subjectDigest: digestOf(approval) });
    assert.equal(crossed.status, 400, crossed.text);
    assert.equal((await detail(baseUrl, id(freshApproval)))['status'], 'pending');
    assert.deepEqual(footprint(), before);
  });

  it('8 — changed target resource: the approval cannot be reused for another environment', async () => {
    const before = footprint();
    const { key, approval } = await pending(PRODUCTION, 'auth01-resource');
    assert.equal((await command(baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) })).status, 200);
    const conflicting = await govern(baseUrl, org.agentCredential, deploy(SECONDARY, key));
    assert.notEqual(conflicting.body['status'], 'executed', conflicting.text);
    assert.ok(reasonCodesOf(conflicting).includes('GOVERNED_ACTION_IDEMPOTENCY_CONFLICT'), conflicting.text);
    const fresh = await govern(baseUrl, org.agentCredential, deploy(SECONDARY, releaseKey('auth01-resource-new')));
    assertAwaitingApproval(fresh);
    const freshApproval = await approvalFor(baseUrl, fresh);
    assert.equal(subjectOf(freshApproval)['resourceScope'], SECONDARY);
    assert.notEqual(digestOf(freshApproval), digestOf(approval));
    assert.equal((await command(baseUrl, CTO_AUTH, id(freshApproval), 'approve', { subjectDigest: digestOf(approval) })).status, 400);
    assert.deepEqual(footprint(), before);
  });

  it('10 — lost executor response: the executor acted, the Host stays execution_unconfirmed and never re-executes', async () => {
    const { key, approval } = await pending(PRODUCTION, 'auth01-lost');
    assert.equal((await command(baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) })).status, 200);
    route = lossyRelay.target;
    const [issuedBefore, , effectsBefore] = footprint();
    const lossyBefore = lossyRelay.requests.length;
    const reply = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
    const executionId = reply.body['executionId'] as string;
    const record = await issuanceOf(executionId);
    assert.ok(record.state !== 'absent', 'the Host issuance ledger holds a row for this execution');
    assert.equal(record.state, 'issued');
    await eventually(async () => (await evidenceOf(executionId)).observations.length > 0);
    assert.equal(lossyRelay.requests.length - lossyBefore, 1, 'one presentation reached the executor');
    // Executor side (read from its own durable state; the Host never knew): consumed, one effect, one signed receipt kept.
    assert.equal((await domain.state(record.capability.capabilityId)).state, 'completed');
    assert.equal(effects() - effectsBefore, 1);
    assert.equal((await domain.receipts(record.capability.capabilityId)).length, 1);
    // Host side: no answer, so no receipt — recorded as missing, never as completed.
    const evidence = await evidenceOf(executionId);
    assert.deepEqual(evidence.observations.map((o) => [o.transmission, o.disposition, o.agreement, o.httpOutcome]), [['unconfirmed', 'receipt-missing', 'not-comparable', 'unconfirmed']]);
    assert.deepEqual(evidence.evidence, []);
    // The same request again, through the working relay: no re-presentation, no second effect, never reported executed.
    route = relay.target;
    const [, requestsBeforeRetry, effectsBeforeRetry] = footprint();
    const again = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    assert.equal(again.body['executionId'], executionId, again.text);
    assert.notEqual(again.body['status'], 'executed', again.text);
    assert.deepEqual([requestsSeen() - requestsBeforeRetry, effects() - effectsBeforeRetry, issuanceRows() - issuedBefore], [0, 0, 1]);
    assert.deepEqual((await evidenceOf(executionId)).evidence, [], 'the Host still holds no verified receipt');
  });

  it('11 — concurrent conflicting verdicts (one Host process): exactly one terminal verdict wins, the other is refused unrecorded, and execution follows the winner', async () => {
    route = relay.target;
    const { key, approval } = await pending(PRODUCTION, 'auth01-race');
    const [approve, reject] = await Promise.all([
      command(baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) }),
      command(baseUrl, AUTH.approverA, id(approval), 'reject', { subjectDigest: digestOf(approval), reason: 'conflicting review' }),
    ]);
    const winners = [approve, reject].filter((reply) => reply.status === 200);
    assert.equal(winners.length, 1, `exactly one verdict is recorded: ${approve.text} | ${reject.text}`);
    const winner = winners[0] as Reply;
    const loser = winner === approve ? reject : approve;
    const finalStatus = (winner.body['approval'] as Record<string, unknown>)['status'] as string;
    assert.ok(finalStatus === 'approved' || finalStatus === 'rejected', finalStatus);
    assert.equal(loser.status, 409, loser.text);
    assert.equal(errorCodeOf(loser), 'OPERATOR_OPERATION_REFUSED');
    assert.equal((loser.body['error'] as Record<string, unknown>)['recorded'], false);
    assert.equal((loser.body['error'] as Record<string, unknown>)['approvalStatus'], finalStatus, 'the refusal names the winning terminal state');
    assert.equal((await detail(baseUrl, id(approval)))['status'], finalStatus);
    const [, , effectsBefore] = footprint();
    const resumed = await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key));
    if (finalStatus === 'approved') {
      assert.equal(resumed.body['status'], 'executed', resumed.text);
      assert.equal(effects() - effectsBefore, 1);
    } else {
      assertAwaitingApproval(resumed, 'GOVERNED_ACTION_APPROVAL_REJECTED');
      assert.equal(effects() - effectsBefore, 0);
    }
  });

  it('12 — revoked authority: revoking the approver’s live standing after the verdict withdraws the unused approval; the retry does not execute', async () => {
    const before = footprint();
    const { key, approval } = await pending(PRODUCTION, 'auth01-revoked');
    const approved = await command(baseUrl, AUTH.approverB, id(approval), 'approve', { subjectDigest: digestOf(approval) });
    assert.equal((approved.body['approval'] as Record<string, unknown>)['status'], 'approved', approved.text);
    const revoked = await call(baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-b/revoke', { authorization: AUTH.responder, body: { reason: 'approver left the change board' } });
    assert.equal(revoked.status, 200, revoked.text);
    const now = await detail(baseUrl, id(approval));
    assert.equal(now['status'], 'pending', 'CORE-05 re-resolves approver standing at every read');
    assertAwaitingApproval(await govern(baseUrl, org.agentCredential, deploy(PRODUCTION, key)));
    assert.deepEqual(footprint(), before);
  });
});

describe('AUTH-01 — approval and request expiry stop execution before any capability exists (a mocked Host clock; no sleeps)', { timeout: 300_000 }, () => {
  // These Hosts never reach the executor: an expired approval or request withholds the action before
  // issuance. The executor's own clock is never involved, so only the Host's `Date` is mocked.
  const workspace = createWorkspace('frontera-auth01-expiry-');
  let domain: ExecutorDomain;

  before(async () => {
    domain = await executorDomain(AUDIENCE);
  });

  after(async () => {
    await workspace.close();
    await domain.cleanup();
  });

  async function withClock(body: (setTo: (instant: number) => void) => Promise<void>): Promise<void> {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await body((instant) => mock.timers.setTime(instant));
    } finally {
      mock.timers.reset();
    }
  }

  async function local(): Promise<{ readonly baseUrl: string; readonly dir: string; readonly org: Organization }> {
    const dir = workspace.dir();
    const booted = await bootAuth01(dir, domain.publicKeyPem);
    workspace.track(booted.host);
    return { baseUrl: booted.baseUrl, dir, org: await provisionOrganization(booted.baseUrl) };
  }

  const issued = (dir: string): number => countRows(join(dir, 'execution-capability-issuance.sqlite'), 'execution_capability_issuances');

  it('5 — the approval expires before the agent resumes: no capability is issued and nothing executes', async () => {
    await withClock(async (setTo) => {
      const host = await local();
      const key = releaseKey('auth01-approval-expiry');
      const withheld = await govern(host.baseUrl, host.org.agentCredential, deploy(PRODUCTION, key));
      assertAwaitingApproval(withheld);
      const approval = await approvalFor(host.baseUrl, withheld);
      const approved = await command(host.baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) });
      assert.equal(approved.status, 200, approved.text);
      setTo(Date.parse((approved.body['approval'] as Record<string, unknown>)['notAfter'] as string));
      assert.equal((await detail(host.baseUrl, id(approval)))['status'], 'approval-expired');
      assertAwaitingApproval(await govern(host.baseUrl, host.org.agentCredential, deploy(PRODUCTION, key)), 'GOVERNED_ACTION_APPROVAL_EXPIRED');
      assert.equal(issued(host.dir), 0, 'no capability');
      assert.equal(domain.records().length, 0, 'no effect');
    });
  });

  it('6 — the approval request expires before anyone decides: the verdict is refused and nothing executes', async () => {
    await withClock(async (setTo) => {
      const host = await local();
      const key = releaseKey('auth01-request-expiry');
      const withheld = await govern(host.baseUrl, host.org.agentCredential, deploy(PRODUCTION, key));
      assertAwaitingApproval(withheld);
      const approval = await approvalFor(host.baseUrl, withheld);
      setTo(Date.parse(approval['requestExpiresAt'] as string));
      expectRefusal(await command(host.baseUrl, CTO_AUTH, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_REQUEST_EXPIRED', 'at the expiry instant');
      assert.equal((await detail(host.baseUrl, id(approval)))['status'], 'request-expired');
      assertAwaitingApproval(await govern(host.baseUrl, host.org.agentCredential, deploy(PRODUCTION, key)), 'GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED');
      assert.equal(issued(host.dir), 0, 'no capability');
      assert.equal(domain.records().length, 0, 'no effect');
    });
  });
});
