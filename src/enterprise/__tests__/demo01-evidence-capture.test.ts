import dns from 'node:dns';
import https from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { openExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuanceRecord } from '../execution-capability-issuance/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER, decodeExecutionCapabilityPresentation } from '../execution-capability-presentation/index.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN, parseExecutionCapability } from '../execution-capability/index.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN } from '../executor-receipt/index.js';
import { openExecutionReceiptEvidenceStore } from '../execution-receipt-evidence/index.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ACTIONS, ADAPTER_ID, ADMIN_KEY, AGENT, AGENT_KEY, AGENT_SUBJECT, GOVERNANCE, LEGACY_KEY, ORG, OWNER, PRODUCTION, RESOURCES, TRUST_DOMAIN, Workspace, committedRecord, createContextTable, govern, governedFile, nextKey, policyPackProvider, secureEnv, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { CREDENTIAL_TOKEN } from './g02c0-execution-binding-fixture.js';
import { BEARER, HEADER_CREDENTIAL, parseRaw, rawExchange, type SpawnedExecutor } from './g02c1a-reference-executor-fixture.js';
import { E2E_EXECUTOR_ID, E2E_RECEIPT_KEY_ID, eventually, executorDomain, loopbackHostPrimitive, spawnE2EExecutor, startRelay, type ExecutorDomain, type Relay } from './g02c1d-end-to-end-fixture.js';
import {
  DEMO_CLASSIFICATION_STATEMENT,
  DEMO_LIMITATIONS,
  assembleDemoEvidenceBundle,
  certaintyOf,
  parseDemoEvidenceBundle,
  pemSentinels,
  provenanceOf,
  sensitiveFindings,
  serializeDemoEvidenceBundle,
  verifyDemoEvidenceBundle,
  type DemoCapability,
  type DemoEvidence,
  type DemoScenario,
  type DemoSentinel,
  type DemoSignature,
} from './demo01-evidence-bundle.js';

/**
 * DEMO-01A — signed reference evidence capture, test-only.
 *
 * The G-02C1D shipped-Host world, for the DEMO-01 buyer story: an AI DevOps
 * agent, delegated by its owner, asks Frontera to deploy `release-42` to a
 * production environment. One canonical shipped Host (`bootEnterpriseHost()`,
 * production profile, SQLite, signed grants, CORE-07 witness, software custody)
 * and one reference executor in its own process (synthetic execution, durable
 * consumption, signed receipts), with a byte relay in front of it. Nothing here
 * simulates either side: every fact recorded below is read from the run.
 *
 * - **Authorized** — the delegated environment: governed, granted, bound,
 *   presented once, verified and consumed by the executor, one synthetic
 *   effect, a signed receipt, verified and correlated by the Host, persisted.
 *   The same request again, and the captured bytes again, change nothing.
 * - **Blocked** — an environment of the same class the agent was never
 *   delegated: whatever the Kernel decides and why is recorded as returned;
 *   no capability is issued, nothing reaches the executor.
 * - **Uncertain** — the delegated environment through a relay that drops the
 *   executor's answer: the executor consumed the capability, wrote its effect
 *   and its signed receipt; the Host sees no answer and says so. Nothing is
 *   retried.
 *
 * With `FRONTERA_DEMO01_EVIDENCE_OUT` set (the CI `demo-evidence` job), the
 * validated, verified and scanned `frontera.demo-evidence-bundle.v1` is
 * written there. Without it, every assertion still runs and nothing is
 * written.
 *
 * Network, test-only, exactly as the G-02C1D shipped-Host suite: the gated
 * adapter's hostname resolves to a public documentation address, and its
 * HTTPS request goes — for that hostname alone — as plain HTTP to a local
 * relay in front of the executor. No TLS, no public DNS, no address-policy
 * decision over a real answer.
 */

const ISSUER = 'frontera-demo01-host';
const AUDIENCE = 'executor-demo01-deploy-gateway';
const GATED = 'demo01.deploy-gateway';
const HOSTNAME = 'deploy-gateway.example';
const SYNTHETIC = 'synthetic.deploy-release';
const RELEASE = 'release-42';
/** Same resource class as `PRODUCTION`, governed by the same profile, and never delegated to the agent. */
const UNDELEGATED = 'production-eu-environment-example';
const PRINCIPAL = 'principal-agent';
const TOKEN_ENV = 'G02C1A_GATEWAY_TOKEN';
const CREDENTIAL_ENV = 'FRONTERA_TEST_DEMO01_EXECUTOR_TOKEN';
const OUTPUT_VARIABLE = 'FRONTERA_DEMO01_EVIDENCE_OUT';

const ADAPTER_OPTIONS = {
  adapterId: GATED,
  origin: `https://${HOSTNAME}`,
  method: 'POST',
  path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
  headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
  body: { kind: 'json-object', fields: { release: { kind: 'parameter', dimension: 'releaseVersion' }, subject: { kind: 'source', source: 'subject' } } },
  credential: { kind: 'bearer', tokenEnv: CREDENTIAL_ENV },
  timeoutMs: 5_000,
} as const;

const GOVERNANCE_WITH_SYNTHETIC = {
  ...GOVERNANCE,
  actionClasses: [...(GOVERNANCE.actionClasses ?? []), { id: 'synthetic', actions: [SYNTHETIC] }],
  resourceClasses: (GOVERNANCE.resourceClasses ?? []).map((resourceClass) => (resourceClass.id === 'production_environment' ? { ...resourceClass, resources: [...resourceClass.resources, UNDELEGATED] } : resourceClass)),
  profiles: [
    ...(GOVERNANCE.profiles ?? []),
    {
      profileId: 'synthetic-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:platform', approvedBy: 'operator:security' },
      actionClass: 'synthetic',
      resourceClass: 'production_environment',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['core04-policy'],
    },
  ],
};

function governed(dir: string, publicKeyPem: string): Record<string, unknown> {
  return governedFile({
    governance: GOVERNANCE_WITH_SYNTHETIC,
    genericHttpAdapters: [ADAPTER_OPTIONS],
    routes: [...ACTIONS.map((action) => ({ action, adapterId: ADAPTER_ID })), { action: SYNTHETIC, adapterId: GATED }],
    executionCapabilities: {
      issuer: ISSUER,
      issuanceLedgerPath: join(dir, 'execution-capability-issuance.sqlite'),
      audiences: [{ audience: AUDIENCE, actions: [SYNTHETIC], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }],
      adapters: [{ adapterId: GATED, audience: AUDIENCE }],
      receiptEvidence: {
        storePath: join(dir, 'evidence', 'receipt-evidence.sqlite'),
        trustedExecutors: [{ executorId: E2E_EXECUTOR_ID, keys: [{ keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: publicKeyPem.trim() }], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] }],
      },
    },
  });
}

/** The operator's one-time initializations: the issuance ledger and the evidence store (in a directory of its own). */
async function initialize(dir: string): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now, create: true })).close();
  mkdirSync(join(dir, 'evidence'), { mode: 0o700 });
  (await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now, create: true })).close();
}

/** The agent, delegated by its owner, for the fixture's actions and the synthetic deploy — over `RESOURCES` only. */
async function provision(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const actions = [...ACTIONS, SYNTHETIC];
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions, resourceScopes: RESOURCES });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions, resourceScopes: RESOURCES });
  await service.provisionDelegationGrant(operator, { ...payloads.delegationGrant, delegationGrantId: 'delegation-agent', delegatorActorId: OWNER, delegateActorId: AGENT, sourceAuthorityGrantId: 'authority-grant-owner', actions, resourceScopes: RESOURCES });
}

/** The adapter the fixture's other routes name; never reached by the synthetic action. */
function unusedAdapter(): ExecutionAdapter {
  return {
    adapterId: ADAPTER_ID,
    async execute() {
      throw new Error('DEMO-01A never routes to the recording adapter.');
    },
  };
}

const deploy = (resource: string) => ({ action: SYNTHETIC, resource, parameters: { releaseVersion: RELEASE } });

// ── Reading the run ────────────────────────────────────────────────────────

function countRows(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number };
    return row.n;
  } finally {
    db.close();
  }
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
/** A CORE-02 envelope's four strings, copied field by field — nothing else it might carry is kept. */
const signatureOf = (envelope: object): DemoSignature => {
  const fields = envelope as Readonly<Record<string, unknown>>;
  const field = (name: string): string => {
    const value = fields[name];
    assert.equal(typeof value, 'string', `signature envelope field ${name}`);
    return value as string;
  };
  return { algorithm: field('algorithm'), artifactVersion: field('artifactVersion'), keyId: field('keyId'), signature: field('signature') };
};

function responseOf(reply: Reply): DemoScenario['host']['response'] {
  const replayed = reply.body['replayed'];
  return {
    httpStatus: reply.status,
    status: asString(reply.body['status']) ?? '',
    reasonCodes: asStrings(reply.body['reasonCodes']),
    executionId: asString(reply.body['executionId']),
    replayed: typeof replayed === 'boolean' ? replayed : null,
  };
}

const NAME = (line: string): string => line.slice(0, line.indexOf(':')).toLowerCase();

describe('DEMO-01A — signed reference evidence from the shipped Host and the reference executor', { timeout: 300_000 }, () => {
  const workspace = new Workspace();
  const cleanups: (() => void | Promise<void>)[] = [];
  const realLookup = dns.promises.lookup;
  const realRequest = https.request;
  let route: { readonly path: string } | undefined;
  let domain: ExecutorDomain;
  let executor: SpawnedExecutor;
  let relay: Relay;
  let lossyRelay: Relay;
  let host: EnterpriseHost;
  let baseUrl: string;
  let dir: string;
  const scenarios: Partial<Record<DemoScenario['id'], DemoScenario>> = {};

  const issuanceLedgerPath = (): string => join(dir, 'execution-capability-issuance.sqlite');
  const evidenceStorePath = (): string => join(dir, 'evidence', 'receipt-evidence.sqlite');
  const issuanceRows = (): number => countRows(issuanceLedgerPath(), 'execution_capability_issuances');
  const observationRows = (): number => countRows(evidenceStorePath(), 'receipt_observations');
  const requestsSeen = (): number => relay.requests.length + lossyRelay.requests.length;

  async function issuanceOf(executionId: string): Promise<ExecutionCapabilityIssuanceRecord> {
    const ledger = await openExecutionCapabilityIssuanceLedger(issuanceLedgerPath(), { issuer: ISSUER, clock: Date.now });
    try {
      return ledger.read(executionId);
    } finally {
      ledger.close();
    }
  }

  async function evidenceOf(executionId: string) {
    const store = await openExecutionReceiptEvidenceStore(evidenceStorePath(), { issuer: ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now });
    try {
      return { observations: store.observationsFor(executionId), evidence: store.evidenceFor(executionId) };
    } finally {
      store.close();
    }
  }

  async function decisionOf(reply: Reply): Promise<DemoScenario['host']['decision']> {
    const result = toKernelEvaluationResult(await committedRecord(host, reply));
    return {
      decisionId: result.decisionId,
      status: result.status,
      reasonCodes: [...result.reasonCodes],
      failedChecks: result.policies.filter((policy) => !policy.passed).map((policy) => ({ policyId: policy.policyId, reasonCode: policy.reasonCode })),
    };
  }

  function capabilityOf(record: ExecutionCapabilityIssuanceRecord): DemoCapability {
    assert.ok(record.state !== 'absent', 'the Host issuance ledger holds a row for this execution');
    assert.ok(record.signature !== undefined, 'and a committed signature');
    const c = record.capability;
    return {
      issuanceState: record.state,
      capabilityId: c.capabilityId,
      executionId: c.executionId,
      issuer: c.issuer,
      issuerKeyId: c.issuerKeyId,
      audience: c.audience,
      subjectActorId: c.subjectActorId,
      onBehalfOfActorId: c.onBehalfOfActorId,
      action: c.action,
      resource: c.resource,
      actionBinding: { format: c.actionBinding.format, digest: c.actionBinding.digest },
      consumption: c.consumption,
      statusRequirement: c.statusRequirement,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
      canonical: record.canonical,
      signature: signatureOf(record.signature),
    };
  }

  /** What the executor received, compared with what the Host issued — read from the relay's raw bytes; the bytes themselves are never kept. */
  function wireOf(requests: readonly Buffer[], issued: DemoCapability | null): DemoScenario['wire'] {
    const presentations = requests.flatMap((bytes) => parseRaw(bytes).headerLines.filter((line) => NAME(line) === EXECUTION_CAPABILITY_PRESENTATION_HEADER).map((line) => line.slice(line.indexOf(':') + 1).trim()));
    let matches: boolean | null = null;
    if (presentations.length > 0) {
      matches =
        issued !== null &&
        presentations.every((value) => {
          const decoded = decodeExecutionCapabilityPresentation(value);
          return decoded.ok && decoded.presentation.capability === issued.canonical && decoded.presentation.signature.signature === issued.signature.signature && decoded.presentation.signature.keyId === issued.signature.keyId;
        });
    }
    return { requestsReachingExecutor: requests.length, presentationHeaders: presentations.length, presentedCapabilityMatchesIssued: matches };
  }

  async function executorFactsOf(capabilityId: string | null, effectsBefore: number): Promise<DemoScenario['executor']> {
    if (capabilityId === null) {
      return { source: 'executor-durable-state-read-by-test-harness', consumptionState: null, outcomeRecorded: null, syntheticEffectsAdded: domain.records().length - effectsBefore, effectRecord: null, receipts: [] };
    }
    const state = await domain.state(capabilityId);
    const receipts = await domain.receipts(capabilityId);
    return {
      source: 'executor-durable-state-read-by-test-harness',
      consumptionState: state.state,
      outcomeRecorded: state.state === 'absent' ? null : state.outcomeRecorded,
      syntheticEffectsAdded: domain.records().length - effectsBefore,
      effectRecord: domain.recordText(capabilityId) ?? null,
      receipts: receipts.map((issued) => ({ receipt: issued.receipt, signature: signatureOf(issued.signature) })),
    };
  }

  async function hostEvidenceOf(executionId: string | null) {
    if (executionId === null) return { observations: [], acceptedReceipts: [] };
    const { observations, evidence } = await evidenceOf(executionId);
    return {
      observations: observations.map((observation) => ({
        transmission: observation.transmission,
        httpStatus: observation.httpStatus,
        httpOutcome: observation.httpOutcome,
        disposition: observation.disposition,
        failure: observation.failure,
        receiptOutcome: observation.receiptOutcome,
        agreement: observation.agreement,
      })),
      acceptedReceipts: evidence.map((accepted) => ({ receiptId: accepted.receiptId, digest: accepted.digest, outcome: accepted.outcome, receipt: accepted.presented.receipt, signature: signatureOf(accepted.presented.signature) })),
    };
  }

  const requestOf = (resource: string): DemoScenario['request'] => ({ principalId: PRINCIPAL, agentActorId: AGENT, action: SYNTHETIC, resource, parameters: { releaseVersion: RELEASE } });

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
        trustedIssuers: [{ issuer: ISSUER, keys: [{ ...trustedKeyOf(AUTHORITY_KEY_A) }] }],
        permittedActions: [SYNTHETIC],
        permittedResources: [PRODUCTION],
        expectedOrigin: `https://${HOSTNAME}`,
        syntheticExecution: { effect: 'frontera.synthetic-deployment-record.v1', consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: [SYNTHETIC] },
      },
    });
    cleanups.push(() => executor.kill());
    assert.equal(executor.environment[TOKEN_ENV], CREDENTIAL_TOKEN, 'the executor expects the credential the Host adapter sends');
    relay = await startRelay(domain.root, executor.port);
    cleanups.push(() => relay.close());
    lossyRelay = await startRelay(domain.root, executor.port, { dropResponse: true });
    cleanups.push(() => lossyRelay.close());

    dir = workspace.dir();
    await initialize(dir);
    const env = { ...secureEnv(dir, governed(dir, domain.publicKeyPem)), [CREDENTIAL_ENV]: CREDENTIAL_TOKEN };
    host = workspace.track(
      await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [unusedAdapter()], contextProvider: createContextTable().provider, policyPackProvider: policyPackProvider() }),
    );
    const { port } = await host.listen();
    await provision(host);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    (dns.promises as { lookup: unknown }).lookup = realLookup;
    (https as unknown as { request: unknown }).request = realRequest;
    await workspace.cleanup();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('A — authorized: governed, issued, presented once, consumed, one effect, a signed receipt verified and correlated by the Host; no second effect', async () => {
    route = relay.target;
    const [issuedBefore, observedBefore, effectsBefore, relayBefore] = [issuanceRows(), observationRows(), domain.records().length, relay.requests.length];
    const key = nextKey('demo01-authorized');
    const reply = await govern(baseUrl, deploy(PRODUCTION), key);
    assert.equal(reply.body['status'], 'executed', reply.text);
    const executionId = asString(reply.body['executionId']);
    assert.ok(executionId !== null, reply.text);
    const capability = capabilityOf(await issuanceOf(executionId));
    assert.equal(capability.issuanceState, 'issued');
    await eventually(async () => (await evidenceOf(executionId)).observations.length > 0);

    const delivered = relay.requests.slice(relayBefore);
    const wire = wireOf(delivered, capability);
    const executorFacts = await executorFactsOf(capability.capabilityId, effectsBefore);
    const evidence = await hostEvidenceOf(executionId);
    assert.deepEqual(wire, { requestsReachingExecutor: 1, presentationHeaders: 1, presentedCapabilityMatchesIssued: true });
    assert.equal(executorFacts.consumptionState, 'completed');
    assert.equal(executorFacts.syntheticEffectsAdded, 1);
    assert.equal(executorFacts.receipts.length, 1);
    assert.deepEqual(evidence.observations.map((o) => [o.transmission, o.disposition, o.agreement, o.httpOutcome, o.receiptOutcome]), [['response', 'receipt-correlated', 'consistent', 'completed', 'completed-observed']]);
    assert.equal(evidence.acceptedReceipts[0]?.receipt, executorFacts.receipts[0]?.receipt, 'the executor’s persisted receipt, verbatim, as Host evidence');
    const issuanceRecordsAdded = issuanceRows() - issuedBefore;
    const evidenceObservationsAdded = observationRows() - observedBefore;

    // The same request again: answered by governance from its record — no second presentation, effect or receipt.
    const effectsBeforeResubmission = domain.records().length;
    const requestsBeforeResubmission = requestsSeen();
    const again = await govern(baseUrl, deploy(PRODUCTION), key);
    assert.equal(again.body['executionId'], executionId, again.text);
    const resubmission = { status: asString(again.body['status']) ?? '', requestsReachingExecutorAdded: requestsSeen() - requestsBeforeResubmission, syntheticEffectsAdded: domain.records().length - effectsBeforeResubmission };
    assert.deepEqual([resubmission.requestsReachingExecutorAdded, resubmission.syntheticEffectsAdded], [0, 0]);

    // The captured bytes, written to the executor directly again: consumed once — nothing is performed.
    const bytes = delivered[0];
    assert.ok(bytes !== undefined);
    const effectsBeforeRepresentation = domain.records().length;
    const raw = await rawExchange(executor.port, bytes);
    const representation = { executorHttpStatus: raw.status ?? null, syntheticEffectsAdded: domain.records().length - effectsBeforeRepresentation };
    assert.equal(representation.syntheticEffectsAdded, 0);
    assert.equal((await executorFactsOf(capability.capabilityId, effectsBefore)).receipts.length, 1, 'still one receipt at the executor');

    const decision = await decisionOf(reply);
    const host_ = { response: responseOf(reply), decision, capabilityIssued: capability, issuanceRecordsAdded, evidenceObservationsAdded, ...evidence };
    scenarios.authorized = {
      id: 'authorized',
      title: 'Authorized: the agent deploys release-42 to the production environment it was delegated',
      request: requestOf(PRODUCTION),
      host: host_,
      wire,
      executor: executorFacts,
      resubmission,
      representation,
      certainty: certaintyOf({ host: host_, executor: executorFacts }),
    };
    assert.deepEqual(scenarios.authorized.certainty, { authorized: true, executedAtExecutor: true, observedByHost: true, verifiedByHost: true, confirmed: true, hostConclusion: 'executed' });
  });

  it('B — blocked: an environment outside the agent’s delegated authority is refused with the Kernel’s own codes; no capability, nothing reaches the executor', async () => {
    route = relay.target;
    const [issuedBefore, observedBefore, effectsBefore, requestsBefore] = [issuanceRows(), observationRows(), domain.records().length, requestsSeen()];
    const key = nextKey('demo01-blocked');
    const reply = await govern(baseUrl, deploy(UNDELEGATED), key);
    assert.equal(reply.body['status'], 'denied', reply.text);
    const response = responseOf(reply);
    assert.ok(response.reasonCodes.length > 0, `a denial carries the Kernel's reason codes: ${reply.text}`);
    const decision = await decisionOf(reply);
    assert.equal(decision.status, 'denied');

    const again = await govern(baseUrl, deploy(UNDELEGATED), key);
    const resubmission = { status: asString(again.body['status']) ?? '', requestsReachingExecutorAdded: requestsSeen() - requestsBefore, syntheticEffectsAdded: domain.records().length - effectsBefore };

    const capability = response.executionId === null ? null : await issuanceOf(response.executionId);
    assert.ok(capability === null || capability.state === 'absent', 'no capability is issued for a denied request');
    const wire = wireOf([], null);
    assert.equal(requestsSeen(), requestsBefore, 'nothing reached the executor');
    const executorFacts = await executorFactsOf(null, effectsBefore);
    assert.equal(executorFacts.syntheticEffectsAdded, 0);
    const evidence = await hostEvidenceOf(response.executionId);
    const host_ = { response, decision, capabilityIssued: null, issuanceRecordsAdded: issuanceRows() - issuedBefore, evidenceObservationsAdded: observationRows() - observedBefore, ...evidence };
    assert.deepEqual([host_.issuanceRecordsAdded, host_.evidenceObservationsAdded, host_.observations.length, host_.acceptedReceipts.length], [0, 0, 0, 0]);
    scenarios.blocked = {
      id: 'blocked',
      title: 'Blocked: the agent targets a production environment it was never delegated',
      request: requestOf(UNDELEGATED),
      host: host_,
      wire,
      executor: executorFacts,
      resubmission,
      representation: null,
      certainty: certaintyOf({ host: host_, executor: executorFacts }),
    };
    assert.equal(scenarios.blocked.certainty.authorized, false);
  });

  it('C — uncertain: the executor acts and its answer is lost; the Host says unconfirmed, holds no verified receipt and runs nothing again', async () => {
    route = lossyRelay.target;
    const [issuedBefore, observedBefore, effectsBefore, lossyBefore] = [issuanceRows(), observationRows(), domain.records().length, lossyRelay.requests.length];
    const key = nextKey('demo01-uncertain');
    const reply = await govern(baseUrl, deploy(PRODUCTION), key);
    assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
    const executionId = asString(reply.body['executionId']);
    assert.ok(executionId !== null, reply.text);
    const capability = capabilityOf(await issuanceOf(executionId));
    assert.equal(capability.issuanceState, 'issued');
    await eventually(async () => (await evidenceOf(executionId)).observations.length > 0);

    const wire = wireOf(lossyRelay.requests.slice(lossyBefore), capability);
    assert.deepEqual(wire, { requestsReachingExecutor: 1, presentationHeaders: 1, presentedCapabilityMatchesIssued: true });
    // Executor side: the capability consumed, the effect written, the receipt signed and kept — none of it known to the Host.
    const executorFacts = await executorFactsOf(capability.capabilityId, effectsBefore);
    assert.equal(executorFacts.consumptionState, 'completed');
    assert.equal(executorFacts.syntheticEffectsAdded, 1);
    assert.equal(executorFacts.receipts.length, 1, 'signed and persisted by the executor — never delivered');
    // Host side: no answer, so no receipt; recorded as missing, never as completed.
    const evidence = await hostEvidenceOf(executionId);
    assert.deepEqual(evidence.observations.map((o) => [o.transmission, o.disposition, o.agreement, o.httpOutcome]), [['unconfirmed', 'receipt-missing', 'not-comparable', 'unconfirmed']]);
    assert.deepEqual(evidence.acceptedReceipts, []);
    const issuanceRecordsAdded = issuanceRows() - issuedBefore;
    const evidenceObservationsAdded = observationRows() - observedBefore;

    // The same request again: no re-presentation, no second effect — whatever the Host answers, it does not retry.
    route = relay.target;
    const effectsBeforeResubmission = domain.records().length;
    const requestsBeforeResubmission = requestsSeen();
    const again = await govern(baseUrl, deploy(PRODUCTION), key);
    assert.equal(again.body['executionId'], executionId, again.text);
    const resubmission = { status: asString(again.body['status']) ?? '', requestsReachingExecutorAdded: requestsSeen() - requestsBeforeResubmission, syntheticEffectsAdded: domain.records().length - effectsBeforeResubmission };
    assert.deepEqual([resubmission.requestsReachingExecutorAdded, resubmission.syntheticEffectsAdded], [0, 0]);
    assert.notEqual(resubmission.status, 'executed', 'an unconfirmed outcome is never later reported as executed without evidence');
    assert.deepEqual((await evidenceOf(executionId)).evidence, [], 'the Host still holds no verified receipt');

    const decision = await decisionOf(reply);
    const host_ = { response: responseOf(reply), decision, capabilityIssued: capability, issuanceRecordsAdded, evidenceObservationsAdded, ...evidence };
    scenarios.uncertain = {
      id: 'uncertain',
      title: 'Uncertain: the executor deploys, but its answer is lost before the Host receives it',
      request: requestOf(PRODUCTION),
      host: host_,
      wire,
      executor: executorFacts,
      resubmission,
      representation: null,
      certainty: certaintyOf({ host: host_, executor: executorFacts }),
    };
    assert.deepEqual(scenarios.uncertain.certainty, { authorized: true, executedAtExecutor: true, observedByHost: false, verifiedByHost: false, confirmed: false, hostConclusion: 'execution_unconfirmed' });
  });

  it('the bundle: closed schema, independently verified, free of secrets and local paths — written only where CI asks', async () => {
    const { authorized, blocked, uncertain } = scenarios;
    assert.ok(authorized !== undefined && blocked !== undefined && uncertain !== undefined, 'all three scenarios were captured');
    const evidence: DemoEvidence = {
      classification: { origin: 'reference-implementation-test-run', data: 'synthetic', production: false, live: false, effect: 'synthetic-deployment-record', transport: 'loopback-http-without-tls', statement: DEMO_CLASSIFICATION_STATEMENT },
      story: {
        headline: 'An AI DevOps agent asks to deploy release-42 to production',
        principalId: PRINCIPAL,
        agentActorId: AGENT,
        delegatedByActorId: OWNER,
        action: SYNTHETIC,
        delegatedResource: PRODUCTION,
        undelegatedResource: UNDELEGATED,
        releaseVersion: RELEASE,
      },
      verificationKeys: [
        { role: 'capability-issuer', subject: ISSUER, keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.publicKeyPem, signingDomain: EXECUTION_CAPABILITY_SIGNING_DOMAIN, origin: 'ephemeral-key-generated-for-this-run' },
        { role: 'executor-receipt', subject: E2E_EXECUTOR_ID, keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: domain.publicKeyPem, signingDomain: EXECUTOR_RECEIPT_SIGNING_DOMAIN, origin: 'ephemeral-key-generated-for-this-run' },
      ],
      scenarios: [authorized, blocked, uncertain],
      limitations: [...DEMO_LIMITATIONS],
    };
    const bundle = assembleDemoEvidenceBundle(evidence, provenanceOf(process.env, new Date().toISOString()));
    const serialized = serializeDemoEvidenceBundle(bundle);

    // 1. Schema: the written text parses back to exactly the closed shape.
    const parsed = parseDemoEvidenceBundle(serialized);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.problems.join('\n'));
    assert.equal(serializeDemoEvidenceBundle(parsed.bundle), serialized, 'deterministic serialization');
    for (const capability of [authorized.host.capabilityIssued, uncertain.host.capabilityIssued]) {
      assert.ok(capability !== null);
      const reparsed = parseExecutionCapability(capability.canonical);
      assert.ok(reparsed.ok, 'the canonical capability text is G-02A canonical');
    }

    // 2. Independent verification, over the parsed text.
    const checks = verifyDemoEvidenceBundle(parsed.bundle);
    assert.deepEqual(checks.filter((check) => !check.passed), []);
    assert.ok(checks.length >= 20, `every check ran (${String(checks.length)})`);

    // 3. The checks are not vacuous: a changed byte in a signed artifact, a changed fact or an extra field is caught.
    // Inside the bundle's JSON, the receipt's own canonical text is an escaped string.
    const tamperedReceipt = serialized.replace('\\"outcome\\":\\"completed-observed\\"', '\\"outcome\\":\\"failed-observed\\"');
    assert.notEqual(tamperedReceipt, serialized, 'a signed receipt text was edited');
    const tamperedParse = parseDemoEvidenceBundle(tamperedReceipt);
    assert.ok(tamperedParse.ok);
    assert.ok(verifyDemoEvidenceBundle(tamperedParse.bundle).some((check) => !check.passed), 'an edited receipt fails verification');
    assert.ok(serialized.includes('"confirmed": true'));
    const flipped = parseDemoEvidenceBundle(serialized.replace('"confirmed": true', '"confirmed": false'));
    assert.ok(flipped.ok);
    assert.ok(verifyDemoEvidenceBundle(flipped.bundle).some((check) => !check.passed), 'an edited certainty fails verification');
    const extended = JSON.parse(serialized) as Record<string, unknown>;
    assert.equal(parseDemoEvidenceBundle(JSON.stringify({ ...extended, note: 'x' })).ok, false, 'an unknown field is refused');
    assert.equal(parseDemoEvidenceBundle(JSON.stringify({ ...extended, privateKeyPem: 'x' })).ok, false, 'a secret-named field is refused');

    // 4. Sensitive material: every run-specific secret, credential and local directory, and the generic shapes.
    const receiptPrivateKey = readFileSync(domain.keyFile, 'utf8');
    const sentinels: DemoSentinel[] = [
      ...pemSentinels('the Host authority private key', AUTHORITY_KEY_A.privateKeyPem),
      ...pemSentinels('a second authority private key', AUTHORITY_KEY_B.privateKeyPem),
      ...pemSentinels('the untrusted private key', AUTHORITY_KEY_UNTRUSTED.privateKeyPem),
      ...pemSentinels('the executor receipt private key', receiptPrivateKey),
      { label: 'the executor bearer credential', value: CREDENTIAL_TOKEN },
      { label: 'a gateway bearer', value: BEARER },
      { label: 'a gateway header credential', value: HEADER_CREDENTIAL },
      { label: 'the agent API key', value: AGENT_KEY },
      { label: 'the administrator API key', value: ADMIN_KEY },
      { label: 'the legacy API key', value: LEGACY_KEY },
      { label: 'the Host state directory', value: dir },
      { label: 'the executor state directory', value: domain.root },
      { label: 'the OS temporary directory', value: tmpdir() },
      { label: 'the home directory', value: homedir() },
      { label: 'the working directory', value: process.cwd() },
      ...Object.entries(process.env).flatMap(([name, value]) => (value !== undefined && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PEM/i.test(name) ? [{ label: `the value of ${name}`, value }] : [])),
    ];
    assert.deepEqual(sensitiveFindings(serialized, sentinels), []);
    // The scan itself is live: each kind of leak would be reported.
    assert.ok(sensitiveFindings(`${serialized}${CREDENTIAL_TOKEN}`, sentinels).length > 0);
    assert.ok(sensitiveFindings(`${serialized}${AUTHORITY_KEY_A.privateKeyPem}`, sentinels).length > 0);
    assert.ok(sensitiveFindings(`${serialized}"${join(dir, 'x')}"`, sentinels).length > 0);

    // 5. Written only where the CI job asks, as public material.
    const out = process.env[OUTPUT_VARIABLE];
    if (out !== undefined && out.length > 0) {
      assert.ok(isAbsolute(out), `${OUTPUT_VARIABLE} must be an absolute path`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, serialized, { mode: 0o644 });
      assert.equal(readFileSync(out, 'utf8'), serialized);
    }
  });
});
