import dns from 'node:dns';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ApprovalCommandPort, ApprovalRequestView } from '../approval-authority/index.js';
import { HUMAN_PASSKEY_DECISION_CHANNEL } from '../approval-authority/human-decision.js';
import { AUTHORITY_CSRF_HEADER } from '../authority-gateway/index.js';
import type { HumanAuthorityPort } from '../composition/human-authority-composition.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { openExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuanceRecord } from '../execution-capability-issuance/index.js';
import { parseExecutionCapability } from '../execution-capability/index.js';
import { parseExecutorReceipt, serializeExecutorReceipt } from '../executor-receipt/index.js';
import { openExecutionReceiptEvidenceStore } from '../execution-receipt-evidence/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, type IdentityAdministrator } from '../human-identity/index.js';
import { createSyntheticExecutionVerifier, type SyntheticExecutionVerification, type SyntheticExecutionVerificationInput } from '../synthetic-execution-verification/index.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { freshnessEnv, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { SECRETS, capturingLogger, create, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  APPROVE_RELEASE,
  AUTH,
  CTRL04_OPERATORS,
  DEPLOY,
  GOVERNANCE,
  ISSUER as ORG_ISSUER,
  ORG,
  PROD,
  QUORUM_1,
  TRUST_DOMAIN,
  assertAwaitingApproval,
  bearer,
  call,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  expectStatus,
  govern,
  operatorActor,
  provisionOrganization,
  release,
  releaseKey,
  standing,
  type Reply,
} from './ctrl04-host-fixture.js';
import { CREDENTIAL_TOKEN } from './g02c0-execution-binding-fixture.js';
import { BEARER_ENV, type SpawnedExecutor } from './g02c1a-reference-executor-fixture.js';
import { E2E_EXECUTOR_ID, E2E_RECEIPT_KEY_ID, afterObservers, e2eTrustedExecutor, eventually, executorDomain, loopbackHostPrimitive, signReceiptText, spawnE2EExecutor, startRelay, type ExecutorDomain, type Relay } from './g02c1d-end-to-end-fixture.js';

/**
 * AUTH-04D2S — verified synthetic execution, end to end, on the canonical shipped Host.
 *
 * One `bootEnterpriseHost()` with the production profile, SQLite stores, signed
 * authority artifacts, the CORE-07 witness, the AUTH-04A human authority and
 * the AUTH-04B gateway. A human decides **through the gateway with a passkey**
 * (the spec-faithful software authenticator — a CI fixture, never a claim about
 * a physical iPhone); CORE-05 records the verdict; the agent resumes with the
 * same idempotency key; the G-02 chain runs unchanged (G-02B capability, G-02C0
 * gate, the G-02C1A/B/C reference executor in its own process, G-02C1D receipt
 * evidence); and the AUTH-04D2S verifier re-checks every link under pinned
 * public keys.
 *
 * Two routes, selected by the governed action alone (never by a request field
 * or a public endpoint), exactly as the pilot kit routes them:
 *
 * - `synthetic.deploy-release` → the capability-gated adapter → the synthetic
 *   executor: `SIMULATED_SUCCESS` when every link verifies;
 * - `deploy-release` → `https://synthetic-executor.invalid`: never resolves,
 *   nothing is transmitted, `DELIVERY_FAILED` — never a success.
 *
 * **Transport, test-only, exactly as AUTH-01 and the G-02C1D shipped-Host
 * suite:** the gated adapter's hostname resolves, in this process, to a public
 * documentation address, and its HTTPS request goes — for that hostname alone —
 * as plain HTTP to a Unix-socket relay in front of the loopback executor. No
 * TLS, certificate check, public DNS or connect-address decision over a real
 * answer is exercised here (the pilot's nginx front is qualified separately, in
 * `authority-pilot-config`). The `.invalid` name goes to the real resolver.
 */

const CAPABILITY_ISSUER = 'frontera-auth04d2s-host';
const AUDIENCE = 'executor-auth04d2s-synthetic';
const GATED = 'auth04d2s.synthetic-executor';
const FAILING = 'auth04d2s.synthetic-executor-invalid';
const HOSTNAME = 'synthetic-executor.example';
const SYNTHETIC = 'synthetic.deploy-release';
const SYNTHETIC_ENV = 'synthetic-environment';
const RELEASE = 'release-77';
const OWNER = 'actor-synthetic-owner';
const AGENT = 'actor-synthetic-agent';
const AGENT_SUBJECT = { system: 'auth04d2s-ci', subjectId: 'synthetic-agent-1' } as const;
const CREDENTIAL_ENV = 'FRONTERA_TEST_AUTH04D2S_EXECUTOR_TOKEN';
const POLICY_ID = 'ctrl04-policy';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;

/** The CTO: an approver operator who decides only through the gateway, with a passkey. */
const CTO = { operatorId: 'cto', role: 'approver', apiKeyEnv: 'FRONTERA_AUTH04D2S_CTO' } as const;
const CTO_SECRET = 'FRONTERA_AUTH04D2S_CTO_SECRET_0c9e7d4b2a6f1e8053';

const GOVERNANCE_AUTH04D2S = {
  ...GOVERNANCE,
  actionClasses: [...GOVERNANCE.actionClasses, { id: 'synthetic', actions: [SYNTHETIC] }],
  resourceClasses: [...GOVERNANCE.resourceClasses, { id: 'synthetic_environment', resources: [SYNTHETIC_ENV] }],
  profiles: [
    ...GOVERNANCE.profiles,
    {
      profileId: 'synthetic-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'synthetic',
      resourceClass: 'synthetic_environment',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: [POLICY_ID],
      approval: QUORUM_1,
    },
  ],
};

/** The success route: capability-gated; the executor sees the request, decision and execution it acts for. */
const GATED_ADAPTER = {
  adapterId: GATED,
  origin: `https://${HOSTNAME}`,
  method: 'POST',
  path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
  headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
  body: {
    kind: 'json-object',
    fields: {
      release: { kind: 'parameter', dimension: 'releaseVersion' },
      requestId: { kind: 'source', source: 'correlation.requestId' },
      decisionId: { kind: 'source', source: 'correlation.decisionId' },
      executionId: { kind: 'source', source: 'correlation.executionId' },
    },
  },
  credential: { kind: 'bearer', tokenEnv: CREDENTIAL_ENV },
  timeoutMs: 5_000,
} as const;

/** The failure route: the pilot's `.invalid` executor, ungated and without a credential. It can never resolve. */
const FAILING_ADAPTER = {
  adapterId: FAILING,
  origin: 'https://synthetic-executor.invalid',
  method: 'POST',
  path: [{ kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
  body: { kind: 'json-object', fields: { release: { kind: 'parameter', dimension: 'releaseVersion' }, requestId: { kind: 'source', source: 'correlation.requestId' } } },
  timeoutMs: 5_000,
} as const;

function governedFile(dir: string, executorPublicKeyPem: string): Record<string, unknown> {
  return {
    ...ctrl04File(GOVERNANCE_AUTH04D2S),
    operators: [...CTRL04_OPERATORS, CTO],
    routes: [
      { action: DEPLOY, adapterId: FAILING },
      { action: SYNTHETIC, adapterId: GATED },
    ],
    approvalPolicy: {
      policyId: POLICY_ID,
      rules: [
        { ruleId: 'production-release-review', governanceProfile: 'release-production', reasonCode: 'PRODUCTION_DEPLOY_REVIEW' },
        { ruleId: 'synthetic-deploy-review', governanceProfile: 'synthetic-deploy', reasonCode: 'PRODUCTION_DEPLOY_REVIEW' },
      ],
    },
    genericHttpAdapters: [GATED_ADAPTER, FAILING_ADAPTER],
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

function gatewayEnv(dir: string, initialize: boolean): Record<string, string> {
  return {
    AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled',
    AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH: `${dir}/identity/human-identity.sqlite`,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: INTENDED_PRODUCTION_RP_ID,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: ORIGIN,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: initialize ? 'true' : 'false',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE: 'enabled',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_HOST: '127.0.0.1',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PORT: '0',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: ORIGIN,
  };
}

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly gatewayPort: number;
  readonly authority: HumanAuthorityPort;
}

/** The operator's one-time initializations (as the pilot's `execution-init` tool runs them): issuance ledger and evidence store. */
async function initialize(dir: string): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: CAPABILITY_ISSUER, clock: Date.now, create: true })).close();
  mkdirSync(join(dir, 'evidence'), { mode: 0o700 });
  (await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: CAPABILITY_ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now, create: true })).close();
}

/** The Host's whole environment: the same for the in-process Host and for the separate `run-enterprise-host.mjs` process. */
function hostEnv(dir: string, witness: StartedWitness, executorPublicKeyPem: string, first: boolean): Record<string, string | undefined> {
  return ctrl04Env(dir, governedFile(dir, executorPublicKeyPem), { [CTO.apiKeyEnv]: CTO_SECRET, [CREDENTIAL_ENV]: CREDENTIAL_TOKEN, ...freshnessEnv(witness), ...gatewayEnv(dir, first) });
}

async function boot(dir: string, witness: StartedWitness, executorPublicKeyPem: string, first: boolean): Promise<Booted> {
  if (first) await initialize(dir);
  const env = hostEnv(dir, witness, executorPublicKeyPem, first);
  const host = await bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger });
  const { port } = await host.listen();
  const gatewayPort = host.authorityGateway?.address()?.port;
  assert.ok(gatewayPort !== undefined, 'the Authority gateway listens');
  const authority = host.enterprise.humanAuthority;
  assert.ok(authority !== undefined, 'the human authority is composed');
  return { host, baseUrl: `http://127.0.0.1:${port}`, gatewayPort, authority };
}

// ── The browser and the human ───────────────────────────────────────────────────────

interface BrowserReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

/** A browser on the Authority origin, behind the TLS-terminating ingress: a cookie jar and the CSRF token, nothing else. */
class Browser {
  private readonly jar = new Map<string, string>();
  private csrf: string | undefined;
  constructor(private readonly port: number) {}

  async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<BrowserReply> {
    const payload = body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined;
    const headers: Record<string, string> = {
      host: INTENDED_PRODUCTION_RP_ID,
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      ...(this.csrf !== undefined ? { [AUTHORITY_CSRF_HEADER]: this.csrf } : {}),
      ...(this.jar.size > 0 ? { cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
    };
    const reply = await new Promise<{ status: number; text: string; setCookies: string[] }>((resolvePromise, rejectPromise) => {
      const req = request({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookies: res.headers['set-cookie'] ?? [] }));
      });
      req.on('error', rejectPromise);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    for (const header of reply.setCookies) {
      const [pair] = header.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = (pair ?? '').slice(index + 1);
      if (/Max-Age=0/.test(header) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(reply.text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (typeof parsed['csrfToken'] === 'string') this.csrf = parsed['csrfToken'];
    return { status: reply.status, body: parsed, text: reply.text };
  }
}

type AssertionOptions = Parameters<SoftwareAuthenticator['assert']>[0];
interface Human {
  readonly device: SoftwareAuthenticator;
  readonly credentialId: string;
}

const administrator = (): IdentityAdministrator =>
  identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' });

/** Bootstrap enrolment, in-process (the embedder path AUTH-04B qualifies; the pilot uses the AUTH-04B2 ceremony). */
async function enrol(authority: HumanAuthorityPort, operatorId: string): Promise<Human> {
  const device = new SoftwareAuthenticator({ origin: ORIGIN });
  const admin = administrator();
  if (authority.identity.principal(operatorId) === undefined) await authority.identity.createPrincipal(admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = await authority.identity.authorizeEnrolment(admin, operatorId);
  const credential = await authority.identity.finishRegistration(issued.enrolmentToken, device.register(authority.identity.beginRegistration(issued.enrolmentToken)));
  return { device, credentialId: credential.credentialId };
}

async function signedIn(port: number, human: Human): Promise<Browser> {
  const browser = new Browser(port);
  const options = await browser.send('POST', '/authority/v1/session/login/options');
  assert.equal(options.status, 200, options.text);
  const reply = await browser.send('POST', '/authority/v1/session/login', { assertion: human.device.assert(options.body['publicKey'] as AssertionOptions) });
  assert.equal(reply.status, 200, reply.text);
  return browser;
}

/** The decision ceremony: a challenge for the exact subject and verdict, a fresh assertion over it. Returns the challenge and the reply. */
async function decide(browser: Browser, human: Human, view: ApprovalRequestView, verdict: 'approve' | 'reject'): Promise<{ readonly challenge: BrowserReply; readonly assertion: unknown; readonly decided: BrowserReply }> {
  const challenge = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(view.approvalRequestId)}/decision-challenges`, { subjectDigest: view.subjectDigest, verdict });
  assert.equal(challenge.status, 200, challenge.text);
  const assertion = human.device.assert(challenge.body['publicKey'] as AssertionOptions);
  const decided = await browser.send('POST', '/authority/v1/decisions', { assertion });
  return { challenge, assertion, decided };
}

// ── Provisioning: the synthetic agent and approver standing ────────────────────────

async function onboardSyntheticAgent(baseUrl: string): Promise<string> {
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Synthetic Owner', issuerId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'authority-grant', {
    authorityGrantId: 'authority-synthetic-owner',
    issuerActorId: ORG_ISSUER,
    subjectActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'deploy.manage',
    actions: [SYNTHETIC],
    resourceScopes: [SYNTHETIC_ENV],
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
  });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Synthetic agent', issuerId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: AGENT_SUBJECT });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${encodeURIComponent(AGENT)}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'issue-synthetic-credential' } }), 200, 'issue credential');
  const credential = issued.body['bearerCredential'];
  assert.equal(typeof credential, 'string', issued.text);
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'passport-synthetic', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ORG_ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', {
    capabilityTokenId: 'capability-synthetic',
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'deploy.execute',
    actions: [SYNTHETIC],
    resourceScopes: [SYNTHETIC_ENV],
    riskLevel: 'medium',
  });
  await create(baseUrl, AUTH.provisioner, 'delegation-grant', {
    delegationGrantId: 'delegation-synthetic',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: 'authority-synthetic-owner',
    capability: 'deploy.execute',
    actions: [SYNTHETIC],
    resourceScopes: [SYNTHETIC_ENV],
    canRedelegate: false,
  });
  return credential as string;
}

interface World {
  readonly releaseCredential: string;
  readonly syntheticCredential: string;
}

/** CTRL-04's organization (the release agent and its approvers), the synthetic agent, and approval standing over the synthetic environment. */
async function provision(baseUrl: string): Promise<World> {
  const org = await provisionOrganization(baseUrl);
  const syntheticCredential = await onboardSyntheticAgent(baseUrl);
  await standing(baseUrl, await operatorActor(baseUrl, CTO.operatorId), APPROVE_RELEASE, [PROD, SYNTHETIC_ENV], 'approval-standing-cto');
  // Two humans whose only approve-release standing is over the synthetic environment: approver-e (CTRL-04 gave it
  // execution standing only, its actor exists) and approver-nostanding (no actor yet).
  await standing(baseUrl, 'operator:approver-e', APPROVE_RELEASE, [SYNTHETIC_ENV], 'approval-standing-approver-e-synthetic');
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-nostanding'), APPROVE_RELEASE, [SYNTHETIC_ENV], 'approval-standing-approver-nostanding-synthetic');
  // approver-d: CTRL-04 gave it standing for another approver action only.
  await standing(baseUrl, 'operator:approver-d', APPROVE_RELEASE, [SYNTHETIC_ENV], 'approval-standing-approver-d-synthetic');
  return { releaseCredential: org.agentCredential, syntheticCredential };
}

const synthetic = (idempotencyKey: string, releaseVersion: string = RELEASE): Record<string, unknown> => ({ action: SYNTHETIC, resource: SYNTHETIC_ENV, parameters: { releaseVersion }, idempotencyKey });

function countRows(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number }).n;
  } finally {
    db.close();
  }
}

/** One raw HTTP/1.1 exchange straight to the executor's loopback port, bypassing the Host. */
function rawExchange(port: number, bytes: Buffer | string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolvePromise(Buffer.concat(chunks).toString('latin1')));
    socket.on('close', () => resolvePromise(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', rejectPromise);
    socket.write(bytes);
  });
}

const statusOf = (raw: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);

/** A loopback port nothing listens on: the executor outage. */
async function deadPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

// ── The suite ────────────────────────────────────────────────────────────────────────

describe('AUTH-04D2S — a passkey-approved governed action, a CORE-05 verdict, and a separately verifiable SIMULATED_SUCCESS', { timeout: 600_000 }, () => {
  const workspace = createWorkspace('frontera-auth04d2s-');
  const cleanups: (() => void | Promise<void>)[] = [];
  const realLookup = dns.promises.lookup;
  const realRequest = https.request;
  let route: { readonly path: string } | undefined;
  let domain: ExecutorDomain;
  let executor: SpawnedExecutor;
  let relay: Relay;
  let lossyRelay: Relay;
  let outageRelay: Relay;
  let witness: StartedWitness;
  let booted: Booted;
  let dir: string;
  let world: World;
  const humans = new Map<string, Human>();
  const human = (operatorId: string): Human => humans.get(operatorId) ?? assert.fail(`no enrolled human ${operatorId}`);
  /** Request ids of the scenarios above, for the AUTH-04D2V operator verifier to read back. */
  const scenario: Record<string, string> = {};

  const verifier = (): ReturnType<typeof createSyntheticExecutionVerifier> =>
    createSyntheticExecutionVerifier({
      trustedIssuer: { issuer: CAPABILITY_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] },
      trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem, { audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] })],
      syntheticActions: [SYNTHETIC],
    });

  const issuanceRows = (): number => countRows(join(dir, 'execution-capability-issuance.sqlite'), 'execution_capability_issuances');
  const observationRows = (): number => countRows(join(dir, 'evidence', 'receipt-evidence.sqlite'), 'receipt_observations');
  const requestsSeen = (): number => relay.requests.length + lossyRelay.requests.length + outageRelay.requests.length;
  const effects = (): number => domain.records().length;
  const footprint = (): readonly [issued: number, requests: number, effects: number, observations: number] => [issuanceRows(), requestsSeen(), effects(), observationRows()];

  const approvals = (): ApprovalCommandPort => booted.host.enterprise.approvals as ApprovalCommandPort;
  async function viewOf(requestId: string): Promise<ApprovalRequestView | null> {
    return (await approvals().list()).find((view) => view.requestId === requestId) ?? null;
  }

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

  /** Everything the verifier is given, read the way an operator reads it: the ASSURE-01 trace over HTTP (an organization API key), CORE-05's view, the Host's stores. */
  async function verificationInput(requestId: string): Promise<SyntheticExecutionVerificationInput> {
    const traced = expectStatus(await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: AUTH.legacyKey }), 200, 'trace');
    const verified = expectStatus(await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, { authorization: AUTH.legacyKey }), 200, 'trace verification');
    const trace = traced.body['trace'] as Record<string, unknown>;
    const executionId = trace['executionId'] as string | undefined;
    const issuance = executionId === undefined ? null : await issuanceOf(executionId);
    const evidence = executionId === undefined ? { observations: [], evidence: [] } : await evidenceOf(executionId);
    return {
      approval: await viewOf(requestId),
      trace: {
        requestId: trace['requestId'] as string,
        organizationId: trace['organizationId'] as string,
        decisionId: trace['decisionId'] as string,
        ...(executionId !== undefined ? { executionId } : {}),
        finalState: (trace['summary'] as Record<string, unknown>)['finalState'] as string,
        verified: verified.body['verified'] === true,
      },
      issuance,
      evidence: { observations: evidence.observations, receipts: evidence.evidence.map((entry) => ({ sequence: entry.sequence, presented: entry.presented })) },
    };
  }

  const verify = async (requestId: string): Promise<SyntheticExecutionVerification> => verifier().verify(await verificationInput(requestId));

  /** A fresh synthetic request, withheld for approval, and its CORE-05 view. */
  async function pendingSynthetic(prefix: string, credential?: string): Promise<{ readonly key: string; readonly withheld: Reply; readonly view: ApprovalRequestView }> {
    const key = releaseKey(prefix);
    const withheld = await govern(booted.baseUrl, credential ?? world.syntheticCredential, synthetic(key));
    assertAwaitingApproval(withheld);
    const view = await viewOf(withheld.body['requestId'] as string);
    assert.ok(view !== null, 'CORE-05 opened an approval request');
    return { key, withheld, view };
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
        permittedResources: [SYNTHETIC_ENV],
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
    outageRelay = await startRelay(domain.root, await deadPort());
    cleanups.push(() => outageRelay.close());

    witness = await startWitness();
    cleanups.push(() => witness.close());
    dir = workspace.dir();
    booted = await boot(dir, witness, domain.publicKeyPem, true);
    world = await provision(booted.baseUrl);
    for (const operatorId of [CTO.operatorId, 'approver-a', 'approver-d', 'approver-e', 'approver-nostanding']) humans.set(operatorId, await enrol(booted.authority, operatorId));
    route = relay.target;
  });

  after(async () => {
    (dns.promises as { lookup: unknown }).lookup = realLookup;
    (https as unknown as { request: unknown }).request = realRequest;
    await booted?.host.close().catch(() => undefined);
    await workspace.close();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('1–5: passkey decision → CORE-05 approved → same key resumes → one capability → executor consumes once → signed receipt → SIMULATED_SUCCESS; durable across a Host restart; duplicate delivery adds nothing', async () => {
    route = relay.target;
    const [issuedBefore, requestsBefore, effectsBefore] = footprint();
    const cto = human(CTO.operatorId);

    // The agent asks; the file-declared policy sends it to a human; nothing is issued, presented or performed.
    const { key, withheld, view } = await pendingSynthetic('auth04d2s-success');
    assert.deepEqual(footprint().slice(0, 3), [issuedBefore, requestsBefore, effectsBefore], 'awaiting approval: nothing exists downstream');
    const waiting = await verify(withheld.body['requestId'] as string);
    assert.deepEqual([waiting.status, waiting.reason], ['NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED'], 'pending is not authorized');

    // 1. The CTO signs in with a passkey and decides the exact subject with a fresh, decision-bound assertion.
    const browser = await signedIn(booted.gatewayPort, cto);
    const inbox = await browser.send('GET', '/authority/v1/approvals');
    assert.equal(inbox.status, 200, inbox.text);
    assert.ok(JSON.stringify(inbox.body).includes(view.approvalRequestId), 'the request is in the CTO’s inbox');
    const { challenge, decided } = await decide(browser, cto, view, 'approve');
    assert.equal(decided.status, 200, decided.text);
    assert.deepEqual([decided.body['outcome'], decided.body['verdict'], (decided.body['approval'] as Record<string, unknown>)['status']], ['recorded', 'approve', 'approved']);
    // The Authority surface reports the decision, never an execution.
    assert.equal(decided.body['execution'], 'not_observed');

    // 2. CORE-05 holds an approved verdict on the passkey channel, for exactly this subject.
    const approved = await viewOf(view.requestId);
    assert.ok(approved !== null);
    assert.equal(approved.state.status, 'approved');
    assert.deepEqual(approved.state.approvers, [`operator:${CTO.operatorId}`]);
    assert.deepEqual(approved.state.verdicts.filter((verdict) => verdict.counted).map((verdict) => verdict.recordedBy), [HUMAN_PASSKEY_DECISION_CHANNEL]);
    const authorized = await verify(view.requestId);
    assert.deepEqual([authorized.status, authorized.reason], ['AUTHORIZED', 'NOT_EXECUTED'], 'an approval is not an execution');
    assert.equal(authorized.receipt, null);
    assert.deepEqual(footprint().slice(0, 3), [issuedBefore, requestsBefore, effectsBefore], 'still nothing downstream');

    // 3. The agent resumes with the same key; the Host revalidates and runs the G-02 chain.
    const resumed = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    const executionId = resumed.body['executionId'] as string;
    scenario['success'] = view.requestId;
    scenario['successExecution'] = executionId;
    await eventually(async () => (await evidenceOf(executionId)).observations.length > 0);
    assert.deepEqual([issuanceRows() - issuedBefore, requestsSeen() - requestsBefore, effects() - effectsBefore], [1, 1, 1], 'one capability, one presentation, one synthetic effect');

    // The request the executor received names this governed request, decision and execution (bound into the capability's binding digest).
    const delivered = (relay.requests.at(-1) ?? Buffer.alloc(0)).toString('utf8');
    const body = JSON.parse(delivered.slice(delivered.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
    assert.deepEqual([body['requestId'], body['decisionId'], body['executionId'], body['release']], [view.requestId, view.decisionId, executionId, RELEASE]);

    // The verified synthetic receipt.
    const success = await verify(view.requestId);
    assert.deepEqual([success.status, success.reason], ['SIMULATED_SUCCESS', 'VERIFIED'], JSON.stringify(success));
    assert.equal(success.executionId, executionId, 'the execution id is recomputed from the request and decision, and matches');
    assert.equal(success.organizationId, ORG);
    assert.deepEqual(success.operation, { action: SYNTHETIC, resource: SYNTHETIC_ENV });
    assert.deepEqual(success.approval, { approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, currentStatus: 'approved', approvalDigest: approved.state.approvalDigest ?? null, approvedBy: [`operator:${CTO.operatorId}`], channel: HUMAN_PASSKEY_DECISION_CHANNEL });
    assert.equal(success.capability?.issuer, CAPABILITY_ISSUER);
    assert.equal(success.capability?.issuerKeyId, AUTHORITY_KEY_A.keyId);
    assert.equal(success.receipt?.executorId, E2E_EXECUTOR_ID);
    assert.equal(success.receipt?.executorKeyId, E2E_RECEIPT_KEY_ID);
    assert.equal(success.receipt?.outcome, 'completed-observed');
    assert.match(success.receipt?.observationDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.match(success.verificationDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(success.externalEffect, 'none-synthetic-only');
    const effect = JSON.parse(domain.recordText(success.capability?.capabilityId ?? '') ?? '{}') as Record<string, unknown>;
    assert.equal(effect['executionId'], executionId, 'the synthetic record is the one effect, for this execution');
    // The Authority status still reports only the decision.
    const status = await browser.send('GET', `/authority/v1/decisions/${encodeURIComponent(challenge.body['commitment'] as string)}`);
    assert.equal(status.body['execution'], 'not_observed', 'the browser never learns, constructs or infers an execution');

    // 5. Duplicate delivery. (a) The agent again: answered from the record. (b) The exact presented bytes, straight to the executor again.
    const again = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.deepEqual([again.body['executionId'], again.body['replayed']], [executionId, true], again.text);
    const replayedAnswer = await rawExchange(executor.port, relay.requests.at(-1) ?? '');
    assert.notEqual(statusOf(replayedAnswer), 0, 'the executor answered the duplicate');
    assert.deepEqual([issuanceRows() - issuedBefore, effects() - effectsBefore], [1, 1], 'one capability and one synthetic effect: the logical outcome happened exactly once');
    assert.equal((await domain.receipts(success.capability?.capabilityId ?? '')).length, 1, 'one receipt at the executor');
    const afterDuplicate = await verify(view.requestId);
    assert.equal(afterDuplicate.verificationDigest, success.verificationDigest, 'the verification is unchanged by a duplicate');

    // 4. Durable across a Host restart: the same records, the same verification, no re-execution.
    await booted.host.close();
    booted = await boot(dir, witness, domain.publicKeyPem, false);
    const restarted = await verify(view.requestId);
    assert.equal(restarted.verificationDigest, success.verificationDigest, 'after a restart, the receipt and its verification are byte-identical');
    const replay = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.deepEqual([replay.body['executionId'], replay.body['replayed']], [executionId, true], replay.text);
    assert.deepEqual([issuanceRows() - issuedBefore, effects() - effectsBefore], [1, 1]);

    // 15. A modified receipt is never final. Every change to the stored receipt or its signature fails closed.
    const input = await verificationInput(view.requestId);
    const presented = input.evidence.receipts[0]?.presented;
    assert.ok(presented !== undefined);
    const tamperedText = presented.receipt.replace('"completed-observed"', '"failed-observed"');
    assert.notEqual(tamperedText, presented.receipt);
    const tampered = verifier().verify({ ...input, evidence: { ...input.evidence, receipts: [{ sequence: 1, presented: { receipt: tamperedText, signature: presented.signature } }] } });
    assert.equal(tampered.status, 'EXECUTION_UNKNOWN');
    const signature = presented.signature as Record<string, string>;
    const forged = verifier().verify({ ...input, evidence: { ...input.evidence, receipts: [{ sequence: 1, presented: { receipt: presented.receipt, signature: { ...signature, signature: `${(signature['signature'] ?? '').slice(0, -4)}AAAA` } } }] } });
    assert.deepEqual([forged.status, forged.reason], ['EXECUTION_UNKNOWN', 'RECEIPT_INVALID']);
    const parsed = parseExecutorReceipt(presented.receipt);
    assert.ok(parsed.ok);
    // A capability signature under a key the verifier does not pin is not this Host's authorization.
    const issuanceSignature = (input.issuance?.signature ?? {}) as Record<string, string>;
    const unsigned = verifier().verify({ ...input, issuance: { ...(input.issuance ?? { state: 'absent' }), signature: { ...issuanceSignature, keyId: 'frontera-unpinned-authority-key' } } });
    assert.deepEqual([unsigned.status, unsigned.reason], ['EXECUTION_UNKNOWN', 'CAPABILITY_SIGNATURE_INVALID']);
    // A missing receipt, or a trace that is not verified, is never success.
    assert.deepEqual(verifier().verify({ ...input, evidence: { observations: input.evidence.observations, receipts: [] } }).status, 'EXECUTION_UNKNOWN');
    assert.deepEqual(verifier().verify({ ...input, trace: { ...input.trace, verified: false } }).reason, 'TRACE_UNVERIFIED');

    // 6–8. Wrong organization, wrong request, wrong subject: the approval of one request never accounts for anything else.
    // With an execution on record, a defect in the approval is EXECUTION_UNKNOWN with its precise reason — never success,
    // and never a claim that the recorded execution was unauthorized.
    const wrongOrg = verifier().verify({ ...input, trace: { ...input.trace, organizationId: 'org-elsewhere' } });
    assert.deepEqual([wrongOrg.status, wrongOrg.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_SUBJECT_MISMATCH']);
    const wrongRequest = verifier().verify({ ...input, trace: { ...input.trace, requestId: 'request-elsewhere' } });
    assert.deepEqual([wrongRequest.status, wrongRequest.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_SUBJECT_MISMATCH']);
    const approval = input.approval;
    assert.ok(approval !== null);
    const wrongSubject = verifier().verify({ ...input, approval: { ...approval, subjectDigest: `sha256:${'0'.repeat(64)}` } });
    assert.deepEqual([wrongSubject.status, wrongSubject.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_SUBJECT_MISMATCH']);
    const alteredSubject = verifier().verify({ ...input, approval: { ...approval, subject: { ...approval.subject, resourceScope: PROD } } });
    assert.deepEqual([alteredSubject.status, alteredSubject.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_SUBJECT_MISMATCH']);
    // An operator-plane (bearer) verdict is not a human passkey decision.
    const bearerChannel = verifier().verify({ ...input, approval: { ...approval, state: { ...approval.state, verdicts: approval.state.verdicts.map((verdict) => ({ ...verdict, recordedBy: 'operator-plane' })) } } });
    assert.deepEqual([bearerChannel.status, bearerChannel.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_NOT_HUMAN_PASSKEY']);
    assert.deepEqual(verifier().verify({ ...input, approval: null }).status, 'EXECUTION_UNKNOWN', 'a missing approval for a recorded execution is unknown, not unauthorized');

    // Temporal authorization: the approval as it reads now versus the approval at the execution point.
    const withState = (state: Partial<typeof approval.state>) => verifier().verify({ ...input, approval: { ...approval, state: { ...approval.state, ...state } } });
    // Expiry after the execution: the signed capability is capped at notAfter and the signed claim lies inside it.
    // (A lapsed approval carries no approval digest; CORE-05 states one only while approved.)
    const lapsedState = { status: 'approval-expired', approvers: approval.state.approvers, verdicts: approval.state.verdicts, ...(approval.state.notAfter !== undefined ? { notAfter: approval.state.notAfter } : {}) };
    const lapsedAfter = verifier().verify({ ...input, approval: { ...approval, state: lapsedState } });
    assert.deepEqual([lapsedAfter.status, lapsedAfter.reason, lapsedAfter.approval?.currentStatus], ['SIMULATED_SUCCESS', 'VERIFIED', 'approval-expired']);
    // An approval window that closed before the capability's: never success.
    const capability = parseExecutionCapability(input.issuance?.canonical ?? '');
    assert.ok(capability.ok);
    const shortWindow = withState({ notAfter: new Date(Date.parse(capability.capability.expiresAt) - 1).toISOString() });
    assert.deepEqual([shortWindow.status, shortWindow.reason], ['EXECUTION_UNKNOWN', 'CAPABILITY_MISMATCH']);
    // Revocation after the execution, as CORE-05 reports it now.
    const revokedNow = withState({ status: 'revoked' });
    assert.deepEqual([revokedNow.status, revokedNow.reason, revokedNow.approval?.currentStatus], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN', 'revoked']);
    // Standing withdrawn after the execution: CORE-05 re-resolves the request to pending and stops counting the verdict.
    const uncounted = approval.state.verdicts.map((verdict) => ({ ...verdict, counted: false }));
    const standingNow = withState({ status: 'pending', approvers: [], verdicts: uncounted });
    assert.deepEqual([standingNow.status, standingNow.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN']);
    // Forged ordering: verdict timestamps that claim the decision came long before (or long after) change nothing — none is read.
    const full = await viewOf(view.requestId);
    assert.ok(full !== null);
    for (const shift of [-365 * 86_400_000, 365 * 86_400_000]) {
      const shifted = full.state.verdicts.map((verdict) => ({ ...verdict, counted: false, recordedAt: new Date(Date.parse(verdict.recordedAt) + shift).toISOString() }));
      const forged = verifier().verify({ ...input, approval: { ...full, state: { ...full.state, status: 'pending', approvers: [], verdicts: shifted } } });
      assert.deepEqual([forged.status, forged.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN']);
    }
    // Missing ordering evidence (no approving row at all) with an execution on record: unknown, never authorized.
    const noRows = withState({ status: 'revoked', approvers: [], verdicts: [] });
    assert.deepEqual([noRows.status, noRows.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_NOT_APPROVED']);
    // Restored status with uncounted rows: ambiguous, so not success.
    assert.notEqual(withState({ verdicts: uncounted }).status, 'SIMULATED_SUCCESS');

    // A validly signed receipt whose claim lies outside the capability window is never success.
    const stored = parseExecutorReceipt(presented.receipt);
    assert.ok(stored.ok);
    const late = new Date(Date.parse(capability.capability.expiresAt) + 1_000).toISOString();
    const lateText = serializeExecutorReceipt({ ...stored.receipt, consumption: { ...stored.receipt.consumption, claimedAt: late }, observedAt: late });
    const lateReceipt = verifier().verify({ ...input, evidence: { ...input.evidence, receipts: [{ sequence: 1, presented: { receipt: lateText, signature: signReceiptText(domain.keyFile, lateText) } }] } });
    assert.deepEqual([lateReceipt.status, lateReceipt.reason], ['EXECUTION_UNKNOWN', 'RECEIPT_OUTSIDE_CAPABILITY_WINDOW']);
  });

  it('6–8 on the live path: a decision for another subject, and a challenge for one request used on another, are refused; nothing is recorded or executed', async () => {
    const before = footprint();
    const cto = human(CTO.operatorId);
    const first = await pendingSynthetic('auth04d2s-wrong-a');
    const second = await pendingSynthetic('auth04d2s-wrong-b', world.syntheticCredential);
    const browser = await signedIn(booted.gatewayPort, cto);
    // Wrong subject digest for the request.
    const wrong = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(first.view.approvalRequestId)}/decision-challenges`, { subjectDigest: second.view.subjectDigest, verdict: 'approve' });
    assert.notEqual(wrong.status, 200, wrong.text);
    // An assertion over the first request's challenge cannot decide the second.
    const challenge = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(first.view.approvalRequestId)}/decision-challenges`, { subjectDigest: first.view.subjectDigest, verdict: 'approve' });
    assert.equal(challenge.status, 200, challenge.text);
    const crossed = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(second.view.approvalRequestId)}/decision-challenges`, { subjectDigest: first.view.subjectDigest, verdict: 'approve' });
    assert.notEqual(crossed.status, 200, crossed.text);
    for (const pending of [first, second]) {
      assert.equal((await viewOf(pending.view.requestId))?.state.status, 'pending');
      assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(pending.key)));
      assert.equal((await verify(pending.view.requestId)).status, 'NOT_AUTHORIZED');
    }
    assert.deepEqual(footprint(), before);
  });

  it('9 — missing authorization: an unapproved request never reaches the executor, and nothing unapproved is ever called authorized', async () => {
    const before = footprint();
    const { key, view } = await pendingSynthetic('auth04d2s-missing');
    scenario['pending'] = view.requestId;
    assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(key)));
    const verification = await verify(view.requestId);
    assert.equal(verification.status, 'NOT_AUTHORIZED');
    const input = await verificationInput(view.requestId);
    assert.deepEqual([verifier().verify({ ...input, approval: null }).status, verifier().verify({ ...input, approval: null }).reason], ['NOT_AUTHORIZED', 'APPROVAL_MISSING']);
    assert.deepEqual(footprint(), before);
  });

  it('10 — a passkey rejection is final: the retry is withheld, nothing is issued or performed, and the verification is NOT_AUTHORIZED', async () => {
    const before = footprint();
    const cto = human(CTO.operatorId);
    const { key, view } = await pendingSynthetic('auth04d2s-rejected');
    const { decided } = await decide(await signedIn(booted.gatewayPort, cto), cto, view, 'reject');
    assert.equal(decided.status, 200, decided.text);
    assert.equal((decided.body['approval'] as Record<string, unknown>)['status'], 'rejected');
    assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(key)), 'GOVERNED_ACTION_APPROVAL_REJECTED');
    assert.deepEqual([(await verify(view.requestId)).status, (await verify(view.requestId)).reason], ['NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED']);
    assert.deepEqual(footprint(), before);
  });

  it('12 — revoked human standing after the passkey verdict withdraws the unused approval: the retry does not execute', async () => {
    const before = footprint();
    const approver = human('approver-nostanding');
    const { key, view } = await pendingSynthetic('auth04d2s-standing');
    const { decided } = await decide(await signedIn(booted.gatewayPort, approver), approver, view, 'approve');
    assert.equal(decided.status, 200, decided.text);
    const revoked = await call(booted.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-nostanding-synthetic/revoke', { authorization: AUTH.responder, body: { reason: 'left the change board' } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((await viewOf(view.requestId))?.state.status, 'pending', 'CORE-05 re-resolves standing at every read');
    assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(key)));
    assert.equal((await verify(view.requestId)).status, 'NOT_AUTHORIZED');
    assert.deepEqual(footprint(), before);
  });

  it('13–14 — a revoked passkey credential cannot decide, and a replayed assertion records nothing new', async () => {
    const before = footprint();
    // 14. Replay: the same assertion submitted twice records exactly one verdict.
    const approverE = human('approver-e');
    const replayed = await pendingSynthetic('auth04d2s-replay');
    const browser = await signedIn(booted.gatewayPort, approverE);
    const first = await decide(browser, approverE, replayed.view, 'reject');
    assert.equal(first.decided.status, 200, first.decided.text);
    const again = await browser.send('POST', '/authority/v1/decisions', { assertion: first.assertion });
    assert.equal(again.status, 409, again.text);
    assert.equal((again.body['error'] as Record<string, unknown> | undefined)?.['code'], 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED');
    assert.equal((await viewOf(replayed.view.requestId))?.state.verdicts.length, 1);
    // 13. Revocation: a credential revoked between challenge and submission decides nothing.
    const lost = await enrol(booted.authority, 'approver-e');
    const target = await pendingSynthetic('auth04d2s-revoked-credential');
    const session = await signedIn(booted.gatewayPort, lost);
    const challenge = await session.send('POST', `/authority/v1/approvals/${encodeURIComponent(target.view.approvalRequestId)}/decision-challenges`, { subjectDigest: target.view.subjectDigest, verdict: 'approve' });
    assert.equal(challenge.status, 200, challenge.text);
    await booted.authority.identity.revokeCredential(administrator(), lost.credentialId, 'device lost');
    const refused = await session.send('POST', '/authority/v1/decisions', { assertion: lost.device.assert(challenge.body['publicKey'] as AssertionOptions) });
    assert.notEqual(refused.status, 200, refused.text);
    assert.equal((await viewOf(target.view.requestId))?.state.verdicts.length, 0, 'nothing recorded');
    assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(target.key)));
    assert.deepEqual(footprint(), before);
  });

  it('16 — an unauthenticated request straight to the executor is refused and performs nothing', async () => {
    const effectsBefore = effects();
    const payload = JSON.stringify({ release: RELEASE });
    for (const headers of [
      `Host: ${HOSTNAME}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`,
      `Host: ${HOSTNAME}\r\nAuthorization: Bearer ${CREDENTIAL_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`,
    ]) {
      const answer = await rawExchange(executor.port, `POST /v1/deployments/${SYNTHETIC_ENV} HTTP/1.1\r\n${headers}Connection: close\r\n\r\n${payload}`);
      const status = statusOf(answer);
      assert.ok(status >= 400 && 500 > status, `refused without a capability: ${answer.slice(0, 120)}`);
    }
    assert.equal(effects(), effectsBefore);
  });

  it('17 — the .invalid route: a passkey-approved action fails delivery definitively; nothing reaches any executor; never a success', async () => {
    const before = footprint();
    const approverA = human('approver-a');
    const key = releaseKey('auth04d2s-invalid');
    const withheld = await govern(booted.baseUrl, world.releaseCredential, release(PROD, key));
    assertAwaitingApproval(withheld);
    const view = await viewOf(withheld.body['requestId'] as string);
    assert.ok(view !== null);
    scenario['invalid'] = view.requestId;
    const { decided } = await decide(await signedIn(booted.gatewayPort, approverA), approverA, view, 'approve');
    assert.equal(decided.status, 200, decided.text);
    const authorized = await verify(view.requestId);
    assert.equal(authorized.status, 'AUTHORIZED', 'the action is authorized');
    const resumed = await govern(booted.baseUrl, world.releaseCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'execution_failed', resumed.text);
    assert.equal(resumed.body['failure'], 'PROVIDER_UNAVAILABLE', resumed.text);
    const failed = await verify(view.requestId);
    assert.deepEqual([failed.status, failed.reason, failed.capability, failed.receipt], ['DELIVERY_FAILED', 'DELIVERY_NOT_COMPLETED', null, null], JSON.stringify(failed));
    // Evidence records the failed attempt: the trace holds the P11 attempt and its definite failure.
    const traced = expectStatus(await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(view.requestId)}?level=AUDITOR`, { authorization: AUTH.legacyKey }), 200, 'trace');
    assert.equal(((traced.body['trace'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['finalState'], 'executed-confirmed-not-completed');
    assert.deepEqual(footprint(), before, 'no capability, no request to any executor, no effect, no receipt evidence');
    // Retrying never turns a definite failure into a success.
    const retry = await govern(booted.baseUrl, world.releaseCredential, release(PROD, key));
    assert.notEqual(retry.body['status'], 'executed', retry.text);
    assert.equal((await verify(view.requestId)).status, 'DELIVERY_FAILED');
  });

  it('18 — lost executor response: the executor acted, the Host stays unconfirmed, and the verification is EXECUTION_UNKNOWN — never success', async () => {
    const cto = human(CTO.operatorId);
    const { key, view } = await pendingSynthetic('auth04d2s-lost');
    scenario['lost'] = view.requestId;
    assert.equal((await decide(await signedIn(booted.gatewayPort, cto), cto, view, 'approve')).decided.status, 200);
    route = lossyRelay.target;
    const effectsBefore = effects();
    const reply = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    route = relay.target;
    assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
    await eventually(async () => (await evidenceOf(reply.body['executionId'] as string)).observations.length > 0);
    assert.equal(effects() - effectsBefore, 1, 'the executor performed its one synthetic effect');
    const unknown = await verify(view.requestId);
    assert.equal(unknown.status, 'EXECUTION_UNKNOWN', JSON.stringify(unknown));
    assert.equal(unknown.receipt, null, 'the Host holds no receipt it was never given');
    const again = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.notEqual(again.body['status'], 'executed', again.text);
    assert.equal(effects() - effectsBefore, 1, 'never re-executed');
  });

  it('19 — executor outage: nothing answers; the Host never reports success and the verification is EXECUTION_UNKNOWN', async () => {
    const cto = human(CTO.operatorId);
    const { key, view } = await pendingSynthetic('auth04d2s-outage');
    assert.equal((await decide(await signedIn(booted.gatewayPort, cto), cto, view, 'approve')).decided.status, 200);
    route = outageRelay.target;
    const effectsBefore = effects();
    const reply = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    route = relay.target;
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assert.equal(effects(), effectsBefore, 'nothing was performed');
    const verification = await verify(view.requestId);
    assert.notEqual(verification.status, 'SIMULATED_SUCCESS');
    assert.ok(['EXECUTION_UNKNOWN', 'DELIVERY_FAILED'].includes(verification.status), JSON.stringify(verification));
    assert.equal(verification.receipt, null);
  });


  // ── AUTH-04D2V: the pilot operator's read-only verifier, against this Host ───────────────────────

  interface CliRun {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  /** The pinned public configuration, as `synthetic-execution-render` writes it: the Host policy and the executor's trust. */
  function pinnedDirectory(overrides: { readonly executorKey?: string; readonly authorityKey?: string; readonly organizationId?: string; readonly issuancePath?: string; readonly evidencePath?: string } = {}): string {
    const pinned = mkdtempSync(join(tmpdir(), 'frontera-auth04d2v-pinned-'));
    const policy = governedFile(dir, overrides.executorKey ?? domain.publicKeyPem) as { executionCapabilities: { issuanceLedgerPath: string; receiptEvidence: { storePath: string; trustedExecutors: { organizationIds: string[] }[] } } };
    if (overrides.issuancePath !== undefined) policy.executionCapabilities.issuanceLedgerPath = overrides.issuancePath;
    if (overrides.evidencePath !== undefined) policy.executionCapabilities.receiptEvidence.storePath = overrides.evidencePath;
    if (overrides.organizationId !== undefined) for (const entry of policy.executionCapabilities.receiptEvidence.trustedExecutors) entry.organizationIds = [overrides.organizationId];
    writeFileSync(join(pinned, 'governed-actions.json'), JSON.stringify({ ...policy, trustDomainId: TRUST_DOMAIN }));
    const authority = overrides.authorityKey === undefined ? trustedKeyOf(AUTHORITY_KEY_A) : { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: overrides.authorityKey };
    writeFileSync(join(pinned, 'synthetic-executor.json'), JSON.stringify({ trustedIssuers: [{ issuer: CAPABILITY_ISSUER, keys: [authority] }], syntheticExecution: { syntheticActions: [SYNTHETIC] } }));
    return pinned;
  }

  /** The tool as the `execution-verifier` service runs it — a separate process; async, so this Host keeps answering. */
  function runVerifier(args: readonly string[], env: Record<string, string>): Promise<CliRun> {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, ['scripts/deploy/verify-synthetic-execution.mjs', ...args], { env: { PATH: process.env['PATH'] ?? '', ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('close', (status) => resolveRun({ status, stdout, stderr }));
    });
  }

  const operatorEnv = (pinned: string, overrides: Record<string, string> = {}): Record<string, string> => ({
    FRONTERA_VERIFIER_HOST: booted.baseUrl,
    FRONTERA_SYNTHETIC_EXECUTION_DIR: pinned,
    FRONTERA_OPERATOR_KEY_OBSERVER: SECRETS.observer,
    // The organization-scoped API key this Host configures plays the pilot auditor's part (AOC_ENTERPRISE_API_KEYS).
    FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER: SECRETS.legacyKey,
    ...overrides,
  });

  const statementOf = (run: CliRun): SyntheticExecutionVerification => {
    assert.equal(run.status, 0, run.stderr);
    const marker = run.stdout.indexOf('\n--- statement (');
    assert.ok(marker !== -1, run.stdout);
    return JSON.parse(run.stdout.slice(run.stdout.indexOf('\n', marker + 1) + 1)) as SyntheticExecutionVerification;
  };

  const SECRET_VALUES = (): readonly string[] => [SECRETS.observer, SECRETS.legacyKey, CREDENTIAL_TOKEN, CTO_SECRET];
  function assertNoLeak(run: CliRun): void {
    for (const text of [run.stdout, run.stderr]) {
      for (const secret of SECRET_VALUES()) assert.equal(text.includes(secret), false, 'no credential in the output');
      assert.equal(/PRIVATE KEY|-----BEGIN/.test(text), false, 'no key material');
      assert.equal(/frontera\.execution-capability\.v1|"ledgerState"|"consumption"|"signature"/.test(text), false, 'no capability, receipt or signature artifact');
    }
  }

  /** Every Host store the verifier could touch, as rows: equal before and after means it wrote nothing. */
  function storeContents(): string {
    const dump = (path: string): string => {
      const db = new Database(path, { readonly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { readonly name: string }[];
        return tables.map(({ name }) => `${name}:${JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())}`).join('\n');
      } finally {
        db.close();
      }
    };
    return [join(dir, 'execution-capability-issuance.sqlite'), join(dir, 'evidence', 'receipt-evidence.sqlite')].map(dump).join('\n');
  }

  it('AUTH-04D2V — the operator verifier reports exactly the AUTH-04D2S statement for success, failed delivery, pending and lost response; it reads only, and prints no secret', async () => {
    const pinned = pinnedDirectory();
    const before = storeContents();
    const footprintBefore = footprint();

    // Valid synthetic execution: the same statement, byte for byte, as the verifier computes in process.
    const success = await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned));
    assertNoLeak(success);
    const statement = statementOf(success);
    assert.deepEqual([statement.status, statement.reason], ['SIMULATED_SUCCESS', 'VERIFIED']);
    assert.equal(statement.verificationDigest, (await verify(scenario['success'] ?? '')).verificationDigest, 'the operator path and the in-process verification agree exactly');
    assert.match(success.stdout, /SYNTHETIC ONLY/);
    assert.match(success.stdout, /SIMULATED success/);
    // By execution id: the same request, resolved by recomputing every approval's execution identity.
    const byExecution = statementOf(await runVerifier(['--execution', scenario['successExecution'] ?? ''], operatorEnv(pinned)));
    assert.equal(byExecution.verificationDigest, statement.verificationDigest);
    // Re-running is a replay of a read: the identical statement.
    assert.equal(statementOf(await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned))).verificationDigest, statement.verificationDigest);

    // The .invalid scenario: DELIVERY_FAILED, never success. Pending: NOT_AUTHORIZED, never shown as executed. Lost response: EXECUTION_UNKNOWN.
    const invalid = await runVerifier(['--request', scenario['invalid'] ?? ''], operatorEnv(pinned));
    assertNoLeak(invalid);
    assert.deepEqual([statementOf(invalid).status, statementOf(invalid).reason], ['DELIVERY_FAILED', 'DELIVERY_NOT_COMPLETED']);
    assert.match(invalid.stdout, /delivery FAILED/);
    const pending = statementOf(await runVerifier(['--request', scenario['pending'] ?? ''], operatorEnv(pinned)));
    assert.equal(pending.status, 'NOT_AUTHORIZED');
    assert.equal(pending.receipt, null);
    const lost = statementOf(await runVerifier(['--request', scenario['lost'] ?? ''], operatorEnv(pinned)));
    assert.equal(lost.status, 'EXECUTION_UNKNOWN', 'never converted into success');

    // No write operation: every store row, and everything downstream, is exactly as it was.
    assert.equal(storeContents(), before, 'the verifier wrote nothing to the Host stores');
    assert.deepEqual(footprint(), footprintBefore, 'nothing issued, presented or performed');
  });

  it('AUTH-04D2V — wrong or untrusted keys, another organization, missing evidence, and an unknown execution never yield success; refused access prints no secret', async () => {
    const request = scenario['success'] ?? '';
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const untrustedExecutor = statementOf(await runVerifier(['--request', request], operatorEnv(pinnedDirectory({ executorKey: other }))));
    assert.deepEqual([untrustedExecutor.status, untrustedExecutor.reason], ['EXECUTION_UNKNOWN', 'RECEIPT_INVALID']);
    const untrustedAuthority = statementOf(await runVerifier(['--request', request], operatorEnv(pinnedDirectory({ authorityKey: other }))));
    assert.deepEqual([untrustedAuthority.status, untrustedAuthority.reason], ['EXECUTION_UNKNOWN', 'CAPABILITY_SIGNATURE_INVALID']);
    const otherOrganization = await runVerifier(['--request', request], operatorEnv(pinnedDirectory({ organizationId: 'org-elsewhere' })));
    assert.equal(statementOf(otherOrganization).status, 'EXECUTION_UNKNOWN');
    assert.match(otherOrganization.stdout, /another organization than the pinned one/);
    const missing = statementOf(await runVerifier(['--request', request], operatorEnv(pinnedDirectory({ issuancePath: join(dir, 'absent-issuance.sqlite'), evidencePath: join(dir, 'evidence', 'absent.sqlite') }))));
    assert.deepEqual([missing.status, missing.reason], ['EXECUTION_UNKNOWN', 'CAPABILITY_MISSING']);

    // A tampered evidence store: in the read-only filesystem test below, where the copy keeps a WAL like the live store.

    // An exact id that resolves to nothing.
    const unknown = await runVerifier(['--execution', 'aoc.exec:00000000000000000000000000000000'], operatorEnv(pinnedDirectory()));
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /EXECUTION_NOT_FOUND/);
    const unknownRequest = await runVerifier(['--request', 'request-that-does-not-exist'], operatorEnv(pinnedDirectory()));
    assert.equal(unknownRequest.status, 2);

    // Missing or unauthorized private access: refused, nothing verified, no secret echoed.
    const pinned = pinnedDirectory();
    for (const env of [
      operatorEnv(pinned, { FRONTERA_OPERATOR_KEY_OBSERVER: '' }),
      operatorEnv(pinned, { FRONTERA_OPERATOR_KEY_OBSERVER: 'not-the-observer-credential' }),
      operatorEnv(pinned, { FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER: SECRETS.observer }),
      operatorEnv(pinned, { FRONTERA_VERIFIER_HOST: 'http://authority.frontera-systems.com:443' }),
    ]) {
      const refused = await runVerifier(['--request', request], env);
      assert.equal(refused.status, 2, refused.stdout);
      assert.equal(refused.stdout, '', 'no statement without verified access');
      assertNoLeak(refused);
    }
    // No argument can supply an approval view or a key.
    assert.equal((await runVerifier(['--request', request, '--approval', '{}'], operatorEnv(pinned))).status, 2);
  });


  // ── AUTH-04D2V: filesystem-level read-only enforcement, against a real read-only mount ────────────

  /** A real read-only bind mount of `source` (Linux, passwordless sudo: the CI runners). Elsewhere the test is skipped, never passed. */
  function readOnlyMount(source: string): { readonly path: string; release(): void } | undefined {
    const target = mkdtempSync(join(tmpdir(), 'frontera-auth04d2v-ro-'));
    const sudo = (args: readonly string[]): boolean => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' }).status === 0;
    if (!sudo(['mount', '--bind', source, target])) return undefined;
    if (!sudo(['mount', '-o', 'remount,bind,ro', target])) {
      sudo(['umount', target]);
      return undefined;
    }
    return { path: target, release: () => void sudo(['umount', target]) };
  }

  const STORE_FILES = ['execution-capability-issuance.sqlite', join('evidence', 'receipt-evidence.sqlite')];

  /** Every file and directory under `root`, with each store file's (and its -wal/-shm's) bytes digested. */
  function filesystemSnapshot(root: string): string {
    const entries: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const relative = path.slice(root.length + 1);
        const stats = statSync(path);
        if (stats.isDirectory()) {
          entries.push(`${relative}/`);
          walk(path);
        } else entries.push(relative);
      }
    };
    walk(root);
    const digests = STORE_FILES.flatMap((file) => ['', '-wal', '-shm'].map((suffix) => {
      const path = join(root, `${file}${suffix}`);
      return `${file}${suffix}:${existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'}`;
    }));
    return [...entries, ...digests].join('\n');
  }

  it('AUTH-04D2V — a real read-only mount: both stores read through the Host’s WAL; no byte, file or record changes; Host stopped → exit 2; restart → the same verdict; corrupted evidence → EXECUTION_UNKNOWN', async (t) => {
    const mount = readOnlyMount(dir);
    if (mount === undefined) {
      assert.notEqual(process.env['CI'], 'true', 'CI runners must provide the read-only mount; this test is never skipped there');
      t.skip('a real read-only bind mount needs Linux and passwordless sudo');
      return;
    }
    const mounts = [mount];
    try {
      // The mount is genuinely read-only: nothing can be created there.
      assert.throws(() => writeFileSync(join(mount.path, 'probe'), 'x'), /EROFS/);
      const pinned = pinnedDirectory({ issuancePath: join(mount.path, STORE_FILES[0] ?? ''), evidencePath: join(mount.path, STORE_FILES[1] ?? '') });
      // Expected verdicts first (they open the stores read-write in this process); then the Host is left quiescent.
      const expected = (await verify(scenario['success'] ?? '')).verificationDigest;
      await afterObservers();
      // Row counts are read outside the byte window: even a read-only reader in this process may touch a -shm.
      const recordsBefore = footprint();
      const quiescent = (): readonly string[] => [filesystemSnapshot(dir), JSON.stringify(witness.operationCounts())];
      const before = quiescent();
      assert.match(before[0] ?? '', /receipt-evidence\.sqlite-wal:[0-9a-f]{64}/, 'the running Host keeps the evidence store in WAL mode');

      const success = await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned));
      assertNoLeak(success);
      const statement = statementOf(success);
      assert.deepEqual([statement.status, statement.reason], ['SIMULATED_SUCCESS', 'VERIFIED'], 'both stores are read correctly through the read-only mount');
      assert.equal(statement.verificationDigest, expected);
      const invalid = statementOf(await runVerifier(['--request', scenario['invalid'] ?? ''], operatorEnv(pinned)));
      assert.equal(invalid.status, 'DELIVERY_FAILED');
      // No database page, WAL or SHM byte changed, no file appeared or vanished, no witness operation ran…
      assert.deepEqual(quiescent(), before);
      // …and no record was issued, presented, performed or signed.
      assert.deepEqual(footprint(), recordsBefore);

      // Host stopped: its connections close, SQLite folds and removes the WAL. The verifier fails closed with exit 2 and creates nothing.
      await booted.host.close();
      const stopped = filesystemSnapshot(dir);
      const down = await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned));
      assert.equal(down.status, 2, down.stdout);
      assert.equal(down.stdout, '', 'no verdict while the Host is stopped');
      assert.match(down.stderr, /not reachable/);
      assert.equal(filesystemSnapshot(dir), stopped, 'nothing created or repaired while stopped');

      // Restart: the same verdict, byte for byte.
      booted = await boot(dir, witness, domain.publicKeyPem, false);
      const restarted = statementOf(await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned)));
      assert.deepEqual([restarted.status, restarted.verificationDigest], ['SIMULATED_SUCCESS', expected]);

      // A store without the running Host's WAL read state fails closed with exit 2 — a precondition, not a verdict.
      const copies = mkdtempSync(join(tmpdir(), 'frontera-auth04d2v-copy-'));
      mkdirSync(join(copies, 'cold'), { mode: 0o700 });
      const live = new Database(join(dir, STORE_FILES[1] ?? ''), { readonly: true });
      try {
        await live.backup(join(copies, 'cold', 'receipt-evidence.sqlite'));
        await live.backup(join(copies, 'tampered.sqlite'));
      } finally {
        live.close();
      }
      const coldMount = readOnlyMount(join(copies, 'cold'));
      assert.ok(coldMount !== undefined);
      mounts.push(coldMount);
      const cold = await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinnedDirectory({ issuancePath: join(mount.path, STORE_FILES[0] ?? ''), evidencePath: join(coldMount.path, 'receipt-evidence.sqlite') })));
      assert.equal(cold.status, 2, cold.stdout);
      assert.match(cold.stderr, /PRECONDITION_UNAVAILABLE/);
      assert.equal(cold.stdout, '');

      // Corrupted evidence, served read-only with a live WAL (a holder keeps it open, as the Host does): EXECUTION_UNKNOWN, never success.
      const holder = new Database(join(copies, 'tampered.sqlite'));
      try {
        holder.pragma('journal_mode = WAL');
        holder.exec('DROP TRIGGER IF EXISTS receipt_evidence_never_updated');
        holder.prepare("UPDATE receipt_evidence SET canonical = replace(canonical, 'completed-observed', 'failed-observed') WHERE execution_id = ?").run(scenario['successExecution'] ?? '');
        const tamperedMount = readOnlyMount(copies);
        assert.ok(tamperedMount !== undefined);
        mounts.push(tamperedMount);
        const tampered = await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinnedDirectory({ issuancePath: join(mount.path, STORE_FILES[0] ?? ''), evidencePath: join(tamperedMount.path, 'tampered.sqlite') })));
        const corrupted = statementOf(tampered);
        assert.equal(corrupted.status, 'EXECUTION_UNKNOWN');
        assert.match(tampered.stdout, /receipt evidence store unreadable \(refused its own integrity checks\)/);
      } finally {
        holder.close();
      }
    } finally {
      for (const entry of mounts.reverse()) entry.release();
    }
  });


  // ── AUTH-04D2V: the Host as its own operating-system process, as the pilot runs it ───────────────

  /** `scripts/run-enterprise-host.mjs` — the pilot image's command — on this world's state, in its own process. */
  async function spawnHostProcess(): Promise<{ readonly baseUrl: string; readonly pid: number; running(): boolean; stop(): Promise<void> }> {
    const env = Object.fromEntries(Object.entries(hostEnv(dir, witness, domain.publicKeyPem, false)).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = spawn(process.execPath, ['scripts/run-enterprise-host.mjs'], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const baseUrl = await new Promise<string>((resolveStart, rejectStart) => {
      const timer = setTimeout(() => rejectStart(new Error(`the Host process did not start: ${output.slice(-2000)}`)), 90_000);
      const read = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolveStart(match[1]);
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      void exited.then((code) => rejectStart(new Error(`the Host process exited (${String(code)}): ${output.slice(-2000)}`)));
    });
    assert.ok(child.pid !== undefined);
    let alive = true;
    void exited.then(() => (alive = false));
    return {
      baseUrl,
      pid: child.pid,
      running: () => alive,
      stop: async () => {
        child.kill('SIGTERM');
        assert.equal(await exited, 0, `the Host process shuts down cleanly: ${output.slice(-1000)}`);
      },
    };
  }

  const walState = (root: string): readonly boolean[] => STORE_FILES.flatMap((file) => ['-wal', '-shm'].map((suffix) => existsSync(join(root, `${file}${suffix}`))));

  it('AUTH-04D2V — separate processes: the Host process holds its stores in WAL; the verifier reads them through a read-only mount — running, repeated, across an unrelated transition, across a restart; stopped and WAL-less fail closed', async (t) => {
    const mount = readOnlyMount(dir);
    if (mount === undefined) {
      assert.notEqual(process.env['CI'], 'true', 'CI runners must provide the read-only mount; this test is never skipped there');
      t.skip('a real read-only bind mount needs Linux and passwordless sudo');
      return;
    }
    const expected = (await verify(scenario['success'] ?? '')).verificationDigest;
    // The in-process Host steps aside: from here only the Host process opens the stores read-write.
    await booted.host.close();
    let hostProcess = await spawnHostProcess();
    const cleanup: (() => Promise<void> | void)[] = [() => mount.release()];
    try {
      assert.notEqual(hostProcess.pid, process.pid, 'the Host runs in its own operating-system process');
      const pinned = pinnedDirectory({ issuancePath: join(mount.path, STORE_FILES[0] ?? ''), evidencePath: join(mount.path, STORE_FILES[1] ?? '') });
      const env = (): Record<string, string> => operatorEnv(pinned, { FRONTERA_VERIFIER_HOST: hostProcess.baseUrl });
      const success = async (): Promise<SyntheticExecutionVerification> => statementOf(await runVerifier(['--request', scenario['success'] ?? ''], env()));

      // A. Running normally: the Host process's own connections give both stores their WAL read state.
      assert.deepEqual(walState(dir), [true, true, true, true], 'issuance and evidence: -wal and -shm, held by the Host process');
      const recordsBefore = footprint();
      const before = [filesystemSnapshot(dir), JSON.stringify(witness.operationCounts())];
      const first = await success();
      assert.deepEqual([first.status, first.reason, first.verificationDigest], ['SIMULATED_SUCCESS', 'VERIFIED', expected]);
      const invalid = statementOf(await runVerifier(['--request', scenario['invalid'] ?? ''], env()));
      assert.equal(invalid.status, 'DELIVERY_FAILED');
      // B. Repeated verification: the same statement every time.
      for (let run = 0; run < 3; run += 1) assert.equal((await success()).verificationDigest, expected, `run ${String(run)}`);
      // No byte of either store (main file, -wal, -shm), no file, no witness operation: the verifier changed nothing.
      assert.deepEqual([filesystemSnapshot(dir), JSON.stringify(witness.operationCounts())], before);
      assert.deepEqual(footprint(), recordsBefore, 'no record issued, presented, performed or signed');

      // C. An unrelated, permitted state transition in the Host process between reads: a new request, withheld for approval.
      const withheld = await govern(hostProcess.baseUrl, world.syntheticCredential, synthetic(releaseKey('auth04d2v-unrelated')));
      assertAwaitingApproval(withheld);
      assert.equal((await success()).verificationDigest, expected, 'the verdict is unchanged by the Host writing elsewhere');
      assert.deepEqual(walState(dir), [true, true, true, true]);

      // D. Host restart: a new Host process on the same state.
      await hostProcess.stop();
      hostProcess = await spawnHostProcess();
      assert.deepEqual(walState(dir), [true, true, true, true], 'the restarted Host process holds its stores in WAL again');
      assert.equal((await success()).verificationDigest, expected, 'the same verdict after a restart');

      // E. Host stopped: the Host process folds and removes its WAL on a clean shutdown; the verifier fails closed with exit 2.
      await hostProcess.stop();
      const stopped = filesystemSnapshot(dir);
      const down = await runVerifier(['--request', scenario['success'] ?? ''], env());
      assert.equal(down.status, 2, down.stdout);
      assert.equal(down.stdout, '');
      assert.equal(filesystemSnapshot(dir), stopped, 'nothing created or repaired while stopped');

      // F. WAL absent: SQLite itself cannot read the stopped Host's stores through the read-only mount — the precondition
      // is SQLite's own requirement, not a stricter one. The verifier refuses before opening anything.
      assert.deepEqual(walState(dir), [false, false, false, false], 'a clean shutdown left no WAL read state');
      await assert.rejects(openExecutionReceiptEvidenceStore(join(mount.path, STORE_FILES[1] ?? ''), { issuer: CAPABILITY_ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now }), 'the shared opener cannot open a WAL-less store read-only');
      await assert.rejects(openExecutionCapabilityIssuanceLedger(join(mount.path, STORE_FILES[0] ?? ''), { issuer: CAPABILITY_ISSUER, clock: Date.now }), 'nor the issuance ledger');
      assert.equal(filesystemSnapshot(dir), stopped, 'the refused opens changed nothing');
    } finally {
      if (hostProcess.running()) await hostProcess.stop().catch(() => undefined);
      for (const step of cleanup.reverse()) await step();
      // The in-process Host returns for the rest of the suite.
      booted = await boot(dir, witness, domain.publicKeyPem, false);
    }
  });

  // ── Temporal authorization: the execution point (A) versus current authority (B) ──────────────────

  /** A passkey-approved synthetic request, executed and verified to SIMULATED_SUCCESS. */
  async function executedBy(operatorId: string, prefix: string): Promise<{ readonly key: string; readonly view: ApprovalRequestView; readonly executionId: string }> {
    route = relay.target;
    const who = human(operatorId);
    const { key, view } = await pendingSynthetic(prefix);
    assert.equal((await decide(await signedIn(booted.gatewayPort, who), who, view, 'approve')).decided.status, 200);
    const reply = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.equal(reply.body['status'], 'executed', reply.text);
    const executionId = reply.body['executionId'] as string;
    await eventually(async () => (await evidenceOf(executionId)).evidence.length > 0);
    assert.equal((await verify(view.requestId)).status, 'SIMULATED_SUCCESS');
    return { key, view, executionId };
  }

  it('20 — a credential revoked after the execution: the passkey decision stays history (SIMULATED_SUCCESS); that credential decides nothing new', async () => {
    const { view } = await executedBy('approver-e', 'auth04d2s-credential-after');
    await booted.authority.identity.revokeCredential(administrator(), human('approver-e').credentialId, 'device lost after the decision');
    const after = await verify(view.requestId);
    assert.deepEqual([after.status, after.approval?.currentStatus], ['SIMULATED_SUCCESS', 'approved'], 'CORE-05 still counts the verdict the passkey made when it was valid');
    // B: the revoked credential cannot sign in, so it cannot decide a new request.
    const browser = new Browser(booted.gatewayPort);
    const options = await browser.send('POST', '/authority/v1/session/login/options');
    assert.equal(options.status, 200, options.text);
    const refused = await browser.send('POST', '/authority/v1/session/login', { assertion: human('approver-e').device.assert(options.body['publicKey'] as AssertionOptions) });
    assert.notEqual(refused.status, 200, refused.text);
  });

  it('21 — the approval revoked after the execution: never re-read as NOT_AUTHORIZED; EXECUTION_UNKNOWN (APPROVAL_WITHDRAWN_ORDER_UNPROVEN); nothing re-executes', async () => {
    const { key, view, executionId } = await executedBy(CTO.operatorId, 'auth04d2s-revoked-after');
    scenario['revokedAfter'] = view.requestId;
    const effectsBefore = effects();
    const revoked = await call(booted.baseUrl, 'POST', `/api/admin/approvals/${encodeURIComponent(view.approvalRequestId)}/revoke`, { authorization: bearer(CTO_SECRET), body: { subjectDigest: view.subjectDigest, reason: 'withdrawn after the release' } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((await viewOf(view.requestId))?.state.status, 'revoked');
    const after = await verify(view.requestId);
    assert.deepEqual([after.status, after.reason, after.approval?.currentStatus], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN', 'revoked'], JSON.stringify(after));
    assert.equal(after.receipt, null, 'the statement stops at the approval and reports no receipt it did not verify');
    assert.equal((await evidenceOf(executionId)).evidence[0]?.outcome, 'completed-observed', 'the Host still holds the executor’s signed receipt, as evidence');
    // B: the same key never executes again, and nothing new happens downstream.
    const again = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
    assert.ok(again.body['status'] !== 'executed' || again.body['replayed'] === true, `answered from the record, never a new execution: ${again.text}`);
    assert.equal(effects(), effectsBefore);
  });

  it('22 — the approver’s standing withdrawn after the execution: EXECUTION_UNKNOWN (APPROVAL_WITHDRAWN_ORDER_UNPROVEN); that human decides nothing new', async () => {
    const { view } = await executedBy('approver-d', 'auth04d2s-standing-after');
    scenario['standingAfter'] = view.requestId;
    const revoked = await call(booted.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-d-synthetic/revoke', { authorization: AUTH.responder, body: { reason: 'left the change board after the release' } });
    assert.equal(revoked.status, 200, revoked.text);
    const after = await verify(view.requestId);
    assert.deepEqual([after.status, after.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN'], JSON.stringify(after));
    // B: a new request is not in this human's inbox, and no challenge is issued.
    const fresh = await pendingSynthetic('auth04d2s-standing-after-new');
    const browser = await signedIn(booted.gatewayPort, human('approver-d'));
    const challenge = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(fresh.view.approvalRequestId)}/decision-challenges`, { subjectDigest: fresh.view.subjectDigest, verdict: 'approve' });
    assert.notEqual(challenge.status, 200, challenge.text);
    assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(fresh.key)));
  });

  it('23 — a capability issued before a revocation and presented after it: the executor acts, the Host records the receipt, and the verification is EXECUTION_UNKNOWN — never success; nothing new executes', async () => {
    const delayRelay = await startRelay(domain.root, executor.port, { delayMs: 2_000 });
    try {
      const cto = human(CTO.operatorId);
      const { key, view } = await pendingSynthetic('auth04d2s-presented-after');
      scenario['presentedAfter'] = view.requestId;
      assert.equal((await decide(await signedIn(booted.gatewayPort, cto), cto, view, 'approve')).decided.status, 200);
      route = delayRelay.target;
      const effectsBefore = effects();
      const running = govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
      // The capability is issued and on its way (the relay holds it) when the approver's standing is revoked.
      await eventually(async () => delayRelay.requests.length > 0);
      const revoked = await call(booted.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-cto/revoke', { authorization: AUTH.responder, body: { reason: 'revoked while a capability was in flight' } });
      assert.equal(revoked.status, 200, revoked.text);
      const reply = await running;
      route = relay.target;
      const executionId = reply.body['executionId'] as string;
      await eventually(async () => (await evidenceOf(executionId)).observations.length > 0);
      assert.equal(effects() - effectsBefore, 1, 'the executor performed the one synthetic effect the capability allowed');
      const after = await verify(view.requestId);
      assert.notEqual(after.status, 'SIMULATED_SUCCESS');
      assert.deepEqual([after.status, after.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN'], JSON.stringify(after));
      // B: revocation blocks every new execution at once.
      const fresh = await pendingSynthetic('auth04d2s-presented-after-new');
      assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(fresh.key)));
      assert.equal(effects() - effectsBefore, 1);
    } finally {
      route = relay.target;
      await delayRelay.close();
    }
  });

  it('AUTH-04D2V — approval withdrawal after execution: the operator verifier reports EXECUTION_UNKNOWN, never NOT_AUTHORIZED and never success', async () => {
    // This Host runs inside the test process, whose helpers open and close their own read-write connections to its
    // stores; in CI that was seen to leave a store without its WAL read state while the Host kept running, and the
    // verifier then (correctly) exits 2. The live read path is proven by the read-only-mount test above. Here the
    // verifier reads a consistent snapshot of both stores, held in WAL mode as the Host holds its own: same evidence.
    const snapshot = mkdtempSync(join(tmpdir(), 'frontera-auth04d2v-snapshot-'));
    mkdirSync(join(snapshot, 'evidence'), { mode: 0o700 });
    const holders: InstanceType<typeof Database>[] = [];
    for (const file of STORE_FILES) {
      const source = new Database(join(dir, file), { readonly: true });
      try {
        await source.backup(join(snapshot, file));
      } finally {
        source.close();
      }
      const holder = new Database(join(snapshot, file));
      holder.pragma('journal_mode = WAL');
      // One frame into the WAL, with no change to any table, schema or row the stores check.
      holder.pragma(`user_version = ${Number(holder.pragma('user_version', { simple: true }))}`);
      holders.push(holder);
      assert.ok(existsSync(join(snapshot, `${file}-wal`)) && existsSync(join(snapshot, `${file}-shm`)), `${file}: WAL read state held`);
    }
    const pinned = pinnedDirectory({ issuancePath: join(snapshot, STORE_FILES[0] ?? ''), evidencePath: join(snapshot, STORE_FILES[1] ?? '') });
    try {
    for (const name of ['revokedAfter', 'standingAfter', 'presentedAfter']) {
      const run = await runVerifier(['--request', scenario[name] ?? ''], operatorEnv(pinned));
      assertNoLeak(run);
      const statement = statementOf(run);
      assert.deepEqual([statement.status, statement.reason], ['EXECUTION_UNKNOWN', 'APPROVAL_WITHDRAWN_ORDER_UNPROVEN'], name);
      assert.match(run.stdout, /Execution UNKNOWN/);
    }
    // The first success, whose approver's standing was revoked since (test 23): history is not rewritten into NOT_AUTHORIZED.
    const first = statementOf(await runVerifier(['--request', scenario['success'] ?? ''], operatorEnv(pinned)));
    assert.equal(first.status, 'EXECUTION_UNKNOWN');
    } finally {
      for (const holder of holders) holder.close();
    }
  });
});

describe('AUTH-04D2S — an expired passkey approval authorizes nothing (a mocked Host clock; no sleeps)', { timeout: 300_000 }, () => {
  const workspace = createWorkspace('frontera-auth04d2s-expiry-');
  let domain: ExecutorDomain;
  let witness: StartedWitness;

  before(async () => {
    domain = await executorDomain(AUDIENCE);
    witness = await startWitness();
  });

  after(async () => {
    await workspace.close();
    await witness.close();
    domain.cleanup();
  });

  it('11 — the approval lapses before the agent resumes: no capability, no effect, and the verification is NOT_AUTHORIZED', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const dir = workspace.dir();
      const booted = await boot(dir, witness, domain.publicKeyPem, true);
      workspace.track(booted.host);
      const world = await provision(booted.baseUrl);
      const cto = await enrol(booted.authority, CTO.operatorId);
      const key = releaseKey('auth04d2s-expiry');
      const withheld = await govern(booted.baseUrl, world.syntheticCredential, synthetic(key));
      assertAwaitingApproval(withheld);
      const view = ((await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === withheld.body['requestId']) ?? assert.fail('no approval'));
      const { decided } = await decide(await signedIn(booted.gatewayPort, cto), cto, view, 'approve');
      assert.equal(decided.status, 200, decided.text);
      const notAfter = (decided.body['approval'] as Record<string, unknown>)['notAfter'];
      const lapse = typeof notAfter === 'string' ? Date.parse(notAfter) : Date.now() + QUORUM_1.approvalValiditySeconds * 1000;
      mock.timers.setTime(lapse);
      assertAwaitingApproval(await govern(booted.baseUrl, world.syntheticCredential, synthetic(key)), 'GOVERNED_ACTION_APPROVAL_EXPIRED');
      assert.equal(countRows(join(dir, 'execution-capability-issuance.sqlite'), 'execution_capability_issuances'), 0, 'no capability');
      assert.equal(domain.records().length, 0, 'no effect');
      const lapsed = (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === view.requestId) ?? assert.fail('no approval');
      assert.equal(lapsed.state.status, 'approval-expired');
      const verifier = createSyntheticExecutionVerifier({
        trustedIssuer: { issuer: CAPABILITY_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] },
        trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem, { audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] })],
        syntheticActions: [SYNTHETIC],
      });
      const verification = verifier.verify({
        approval: lapsed,
        trace: { requestId: view.requestId, organizationId: ORG, decisionId: view.decisionId, finalState: 'withheld-at-exercise', verified: true },
        issuance: null,
        evidence: { observations: [], receipts: [] },
      });
      assert.deepEqual([verification.status, verification.reason], ['NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED']);
      await booted.host.close();
    } finally {
      mock.timers.reset();
    }
  });
});
