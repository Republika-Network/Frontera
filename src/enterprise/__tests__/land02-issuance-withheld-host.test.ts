import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import { PARAMETER_AUTHORITY_REASON_CODES as P } from '../execution-governance/parameter-authority.js';
import { EMERGENCY_CONTROL_REASON_CODES as E } from '../../features/emergency-control-runtime/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/contracts.js';
import { issuanceWithheldReferenceId, reconsiderationRealizationReferenceId } from '../governed-action/identifiers.js';
import { issuanceWithheldDigest, issuanceWithheldUri, issuanceWithheldVersion } from '../governed-action/issuance-record.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import { ADMIN, AGENT_KEY, LEGACY_KEY, Workspace, call, createContextTable, nextKey, secureEnv, type ContextTable, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import {
  ACTIONS,
  AGENT,
  AGENT_SUBJECT,
  CLUSTER,
  DEVOPS_HTTP,
  EVERY_WORLD,
  ORG,
  OWNER,
  RESOURCES,
  TRANSFER,
  TREASURY_ACCOUNT,
  TREASURY_CEILING,
  TREASURY_HTTP,
  TRUST_DOMAIN,
  createProviderRecorder,
  deploy,
  observedPolicy,
  referenceFile,
  transfer,
  withFact,
  type ProviderRecorder,
} from './core08-reference-domains-fixture.js';

/**
 * LAND-02 — durable issuance-withheld evidence on the shipped, rail-neutral
 * Enterprise Host.
 *
 * One `bootEnterpriseHost()` in the secure profile (SQLite everywhere, signed
 * grants, the authority-state witness, P7, P11, emergency control) with the
 * CORE-08 reference domains behind the production Generic HTTP adapter core (a
 * fake network runtime: no provider is contacted). Every case is a request the
 * Kernel **allows** and issuance then **withholds**:
 *
 * | case | gate | public answer |
 * | --- | --- | --- |
 * | A | durable authority ceiling (a bounded value above it) | `authority-binding` · `FINANCIAL_AUTHORITY_CEILING_EXCEEDED` |
 * | B | an active emergency stop on the resource | `emergency-control` · `EMERGENCY_CONTROL_ACTIVE` |
 * | C | typed parameter authority (a maximum the request exceeds) | `authority-binding` · `PARAMETER_AUTHORITY_EXCEEDED` |
 *
 * For each: zero adapter calls, the response exactly as before, one durable
 * `issuance_record` row, the ASSURE-01 trace carrying `authority.issuance`,
 * and verification passing — before and after a restart on the same stores.
 * A Kernel denial records no issuance row; an executed action is unchanged;
 * LAND-01 lineage and LAND-02 issuance evidence coexist on one trace.
 *
 * Synthetic identifiers only; no rail, transport, wallet or demo composition.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

const OPERATOR = `Bearer ${LEGACY_KEY}`;
const OVER_CEILING = '1500';
const DEVOPS_BOUNDS = [
  { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
  { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
] as const;
const TREASURY_CONSTRAINTS: readonly AuthorityConstraint[] = [
  { type: 'max_amount', currency: 'USD', value: TREASURY_CEILING },
  { type: 'spending_limit', limitId: 'land02-lifetime', currency: 'USD', maximum: '100000', window: { kind: 'lifetime' } },
];

interface Booted {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly provider: ProviderRecorder;
}

let dir: string;
let env: Record<string, string | undefined>;
let context: ContextTable;
let booted: Booted;

async function boot(): Promise<Booted> {
  const provider = createProviderRecorder();
  const host = workspace.track(
    await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: provider.adapters, contextProvider: context.provider, policyPackProvider: observedPolicy().provider }),
  );
  const { port } = await host.listen();
  return { host, baseUrl: `http://127.0.0.1:${port}`, provider };
}

/** One owner, one agent; a treasury lineage with a durable ceiling and a devops lineage with typed parameter bounds. */
async function provisionAuthority(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: ACTIONS, resourceScopes: RESOURCES });
  const lineages = [
    { id: 'treasury', actions: [TRANSFER], resources: [TREASURY_ACCOUNT], extra: { constraints: TREASURY_CONSTRAINTS } },
    { id: 'devops', actions: [deploy().action], resources: [CLUSTER], extra: { parameterBounds: DEVOPS_BOUNDS } },
  ];
  for (const lineage of lineages) {
    await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: `authority-grant-${lineage.id}`, subjectActorId: OWNER, actions: lineage.actions, resourceScopes: lineage.resources, ...lineage.extra });
    await service.provisionDelegationGrant(operator, {
      ...payloads.delegationGrant,
      delegationGrantId: `delegation-${lineage.id}`,
      delegatorActorId: OWNER,
      delegateActorId: AGENT,
      sourceAuthorityGrantId: `authority-grant-${lineage.id}`,
      actions: lineage.actions,
      resourceScopes: lineage.resources,
      ...('parameterBounds' in lineage.extra ? { parameterBounds: lineage.extra.parameterBounds } : {}),
    });
  }
}

const govern = (intent: Record<string, unknown>, idempotencyKey = nextKey('land02')) => call(booted.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${AGENT_KEY}`, body: { idempotencyKey, ...intent } });
const admin = (method: string, path: string, body?: unknown) => call(booted.baseUrl, method, path, { authorization: ADMIN, ...(body !== undefined ? { body } : {}) });
const requestIdOf = (reply: Reply): string => reply.body['requestId'] as string;
const decisionOf = (reply: Reply) => reply.body['decision'] as { readonly decisionId: string; readonly evaluationId: string; readonly status: string };
const codesOf = (reply: Reply) => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const adapterCalls = (): number => booted.provider.actions.length;

async function recordOf(reply: Reply): Promise<GovernanceRecord> {
  const record = await booted.host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decisionOf(reply).evaluationId);
  assert.ok(record !== null, reply.text);
  assert.equal((await booted.host.enterprise.persistence.verify({ system: false, organizationId: ORG }, decisionOf(reply).evaluationId)).valid, true);
  return record;
}

async function fetchTrace(requestId: string) {
  const reply = await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: OPERATOR });
  assert.equal(reply.status, 200, reply.text);
  return { trace: reply.body['trace'] as { readonly stages: Record<string, Record<string, unknown>>; readonly summary: Record<string, unknown> }, traceDigest: reply.body['traceDigest'] as string };
}

async function verifyTrace(requestId: string) {
  const reply = await call(booted.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, { authorization: OPERATOR });
  assert.equal(reply.status, 200, reply.text);
  return reply.body as { readonly verified: boolean; readonly checks: readonly { readonly check: string; readonly status: string; readonly detail?: string }[] };
}

async function assertVerified(requestId: string, label: string): Promise<readonly { readonly check: string; readonly status: string }[]> {
  const verification = await verifyTrace(requestId);
  assert.deepEqual(verification.checks.filter((entry) => entry.status === 'fail'), [], label);
  assert.equal(verification.verified, true, label);
  return verification.checks;
}

/** Asserts the Kernel allowed, issuance withheld with exactly this layer and code, and nothing reached an adapter. */
function assertWithheldAfterAllow(reply: Reply, withheldBy: string, code: string, label: string): void {
  assert.equal(reply.body['status'], 'withheld', `${label}: ${reply.text}`);
  assert.equal(reply.body['withheldBy'], withheldBy, label);
  assert.deepEqual(codesOf(reply), [code], label);
  assert.equal(decisionOf(reply).status, 'allowed', `${label}: the Kernel permitted the action`);
  assert.equal(Object.prototype.hasOwnProperty.call(reply.body, 'executionId'), false, `${label}: no execution identity was ever claimed`);
}

/** The one durable issuance row on the decision's own evaluation, and nothing that carries authority or execution. */
async function assertIssuanceRow(reply: Reply, expected: { readonly withheldBy: string; readonly code: string; readonly uriTail: string; readonly ceiling?: { readonly value: string; readonly unit: string } }): Promise<void> {
  const record = await recordOf(reply);
  assert.deepEqual(record.references.filter((entry) => entry.referenceType === 'authorization_artifact' || entry.referenceType === 'execution_record'), [], 'no grant, no execution');
  const rows = record.references.filter((entry) => entry.referenceType === 'issuance_record');
  assert.equal(rows.length, 1);
  const version = `withheld:${expected.withheldBy}:${expected.code}`;
  assert.equal(rows[0]?.externalVersion, version);
  assert.equal(rows[0]?.externalId, requestIdOf(reply));
  assert.equal(rows[0]?.referenceId, issuanceWithheldReferenceId({ evaluationId: decisionOf(reply).evaluationId, version, ...(expected.ceiling !== undefined ? { ceiling: expected.ceiling } : {}) }));
  assert.equal(rows[0]?.uri, `urn:aoc:issuance-record:v1;decision=${decisionOf(reply).decisionId}${expected.uriTail}`);
}

/** The ASSURE-01 trace carries the issuance stage — rebuilt from the row, never re-decided — and verifies. */
async function assertIssuanceTrace(reply: Reply, expected: { readonly withheldBy: string; readonly code: string; readonly requested?: unknown; readonly ceiling?: unknown }, label: string): Promise<void> {
  const { trace } = await fetchTrace(requestIdOf(reply));
  assert.equal(trace.stages['decision']?.['status'], 'allowed', `${label}: the trace shows the Kernel allowed`);
  const authority = trace.stages['authority'] ?? {};
  assert.equal(authority['presence'], 'recorded', `${label}: issuance was reached`);
  assert.deepEqual(authority['grants'], [], `${label}: no grant`);
  const issuance = authority['issuance'] as Record<string, unknown> | undefined;
  assert.ok(issuance !== undefined, `${label}: ${JSON.stringify(authority)}`);
  assert.equal(issuance['presence'], 'recorded');
  assert.equal(issuance['outcome'], 'withheld');
  assert.equal(issuance['withheldBy'], expected.withheldBy);
  assert.deepEqual(issuance['reasonCodes'], [expected.code]);
  assert.deepEqual(issuance['requested'], expected.requested);
  assert.deepEqual(issuance['ceiling'], expected.ceiling);
  const { presence: _presence, outcome: _outcome, records, ...first } = issuance;
  void _presence;
  void _outcome;
  assert.deepEqual(records, [first], 'one withholding, listed once');
  assert.equal(trace.summary['finalState'], 'not-executed');
  assert.equal((trace.stages['execution']?.['claim'] as Record<string, unknown>)['presence'], 'not-reached');
  const checks = await assertVerified(requestIdOf(reply), label);
  for (const name of ['issuance.record-well-formed', 'issuance.request-linkage', 'issuance.decision-linkage', 'issuance.requested-amount', 'issuance.on-executable-decision', 'issuance.withheld-before-any-authority', 'issuance.no-grant-while-withheld', 'issuance.no-execution-while-withheld']) {
    assert.equal(checks.find((entry) => entry.check === name)?.status, 'pass', `${label}: ${name}`);
  }
}

const cases: Record<string, Reply> = {};

before(async () => {
  dir = workspace.dir();
  env = secureEnv(dir, referenceFile());
  context = createContextTable();
  booted = await boot();
  await provisionAuthority(booted.host);
  context.set(EVERY_WORLD);
});

describe('LAND-02 — Kernel allowed, issuance withheld, durable evidence: on the rail-neutral Host', () => {
  it('control: an allowed action within every bound executes exactly as before — one adapter call, a grant, and no issuance row', async () => {
    const reply = await govern(transfer('250'));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(adapterCalls(), 1);
    assert.equal(booted.provider.callsTo(TREASURY_HTTP), 1);
    const record = await recordOf(reply);
    assert.equal(record.references.some((entry) => entry.referenceType === 'issuance_record'), false);
    assert.ok(record.references.some((entry) => entry.referenceType === 'authorization_artifact'));
    const { trace } = await fetchTrace(requestIdOf(reply));
    assert.equal('issuance' in (trace.stages['authority'] ?? {}), false, 'an executed trace is exactly as before');
    const checks = await assertVerified(requestIdOf(reply), 'executed');
    assert.equal(checks.some((entry) => entry.check.startsWith('issuance.')), false);
    cases['executed'] = reply;
  });

  it('CASE A — a bounded value above the durable authority ceiling: withheld at issuance, zero adapter calls, durable evidence, verified trace', async () => {
    const before = adapterCalls();
    const reply = await govern(transfer(OVER_CEILING));
    assertWithheldAfterAllow(reply, 'authority-binding', F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED, 'A');
    assert.equal(adapterCalls(), before);
    await assertIssuanceRow(reply, { withheldBy: 'authority-binding', code: F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED, uriTail: `;requested=USD:${OVER_CEILING};ceiling=USD:${TREASURY_CEILING}`, ceiling: { value: TREASURY_CEILING, unit: 'USD' } });
    await assertIssuanceTrace(reply, { withheldBy: 'authority-binding', code: F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED, requested: { value: OVER_CEILING, unit: 'USD' }, ceiling: { value: TREASURY_CEILING, unit: 'USD' } }, 'A');
    cases['ceiling'] = reply;
  });

  it('CASE B — an emergency stop on the resource: withheld before issuance, zero adapter calls, durable evidence, verified trace', async () => {
    const before = adapterCalls();
    const activated = await admin('POST', '/api/admin/emergency-controls/activate', { scope: 'resource', value: CLUSTER });
    assert.equal(activated.status, 200, activated.text);
    try {
      const reply = await govern(deploy(2));
      assertWithheldAfterAllow(reply, 'emergency-control', E.EMERGENCY_CONTROL_ACTIVE, 'B');
      assert.equal(adapterCalls(), before);
      assert.equal(booted.provider.callsTo(DEVOPS_HTTP), 0);
      await assertIssuanceRow(reply, { withheldBy: 'emergency-control', code: E.EMERGENCY_CONTROL_ACTIVE, uriTail: '' });
      await assertIssuanceTrace(reply, { withheldBy: 'emergency-control', code: E.EMERGENCY_CONTROL_ACTIVE }, 'B');
      cases['emergency'] = reply;
    } finally {
      const released = await admin('POST', '/api/admin/emergency-controls/release', { scope: 'resource', value: CLUSTER });
      assert.equal(released.status, 200, released.text);
    }
  });

  it('CASE C — a typed parameter above the standing parameter authority: withheld at issuance, zero adapter calls, durable evidence, verified trace', async () => {
    const before = adapterCalls();
    const reply = await govern(deploy(4));
    assertWithheldAfterAllow(reply, 'authority-binding', P.PARAMETER_AUTHORITY_EXCEEDED, 'C');
    assert.equal(adapterCalls(), before);
    await assertIssuanceRow(reply, { withheldBy: 'authority-binding', code: P.PARAMETER_AUTHORITY_EXCEEDED, uriTail: '' });
    await assertIssuanceTrace(reply, { withheldBy: 'authority-binding', code: P.PARAMETER_AUTHORITY_EXCEEDED }, 'C');
    // Within the bound, the same action executes: the gate, not the action, withheld.
    const within = await govern(deploy(3));
    assert.equal(within.body['status'], 'executed', within.text);
    assert.equal(booted.provider.callsTo(DEVOPS_HTTP), 1);
    cases['parameter'] = reply;
  });

  it('a Kernel denial is distinguishable: denied, no issuance row, and no issuance stage on its trace', async () => {
    context.set(withFact(EVERY_WORLD, 'payee.approved', false));
    try {
      const reply = await govern(transfer(OVER_CEILING));
      assert.equal(reply.body['status'], 'denied', reply.text);
      const record = await recordOf(reply);
      assert.deepEqual(record.references, []);
      const { trace } = await fetchTrace(requestIdOf(reply));
      assert.equal('issuance' in (trace.stages['authority'] ?? {}), false);
      assert.equal(trace.stages['authority']?.['presence'], 'not-applicable');
      await assertVerified(requestIdOf(reply), 'denied');
    } finally {
      context.set(EVERY_WORLD);
    }
  });

  it('forged issuance evidence fails verification: a malformed row, and a genuine row grafted onto another request', async () => {
    const store = booted.host.enterprise.persistence;
    const target = await govern(transfer('100'));
    assert.equal(target.body['status'], 'executed', target.text);
    await store.appendReference({ system: true }, {
      referenceId: 'aoc.gar.ref:land02-forged-malformed',
      evaluationId: decisionOf(target).evaluationId,
      referenceType: 'issuance_record',
      externalId: requestIdOf(target),
      externalVersion: 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED',
      uri: 'urn:aoc:issuance-record:v1;decision=forged',
      digest: `sha256:${'0'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    });
    const malformed = await verifyTrace(requestIdOf(target));
    assert.equal(malformed.verified, false);
    assert.equal(malformed.checks.find((entry) => entry.check === 'issuance.record-well-formed')?.status, 'fail');
    assert.equal(malformed.checks.find((entry) => entry.check === 'issuance.withheld-before-any-authority')?.status, 'fail', 'appended after the grant it claims preceded');

    // The ceiling case's own, well-formed evidence, copied onto an executed request.
    const grafted = await govern(transfer('110'));
    assert.equal(grafted.body['status'], 'executed', grafted.text);
    const ceiling = cases['ceiling'] as Reply;
    const evidence = { requestId: requestIdOf(ceiling), decisionId: decisionOf(ceiling).decisionId, withheldBy: 'authority-binding', reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED], requested: { value: OVER_CEILING, unit: 'USD' }, ceiling: { value: TREASURY_CEILING, unit: 'USD' } };
    const version = issuanceWithheldVersion(evidence);
    await store.appendReference({ system: true }, {
      referenceId: issuanceWithheldReferenceId({ evaluationId: decisionOf(grafted).evaluationId, version, ceiling: evidence.ceiling }),
      evaluationId: decisionOf(grafted).evaluationId,
      referenceType: 'issuance_record',
      externalId: evidence.requestId,
      externalVersion: version,
      uri: issuanceWithheldUri(evidence),
      digest: issuanceWithheldDigest(evidence),
      createdAt: new Date().toISOString(),
    });
    const graftedChecks = (await verifyTrace(requestIdOf(grafted))).checks;
    for (const name of ['issuance.request-linkage', 'issuance.decision-linkage', 'issuance.requested-amount']) {
      assert.equal(graftedChecks.find((entry) => entry.check === name)?.status, 'fail', name);
    }
    assert.equal(graftedChecks.find((entry) => entry.check === 'issuance.record-well-formed')?.status, 'pass', 'well-formed — and still not this request’s');
  });

  it('restart on the same stores: every issuance record, trace and verification is unchanged, and nothing re-executes', async () => {
    const names = ['executed', 'ceiling', 'emergency', 'parameter'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const name of names) {
        const requestId = requestIdOf(cases[name] as Reply);
        out[name] = (await fetchTrace(requestId)).traceDigest;
        await assertVerified(requestId, `${name} (snapshot)`);
      }
      return out;
    };
    const before = await snapshot();
    await booted.host.close();
    booted = await boot();
    assert.deepEqual(await snapshot(), before, 'a restart changes no canonical component of any trace');
    await assertIssuanceRow(cases['ceiling'] as Reply, { withheldBy: 'authority-binding', code: F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED, uriTail: `;requested=USD:${OVER_CEILING};ceiling=USD:${TREASURY_CEILING}`, ceiling: { value: TREASURY_CEILING, unit: 'USD' } });
    await assertIssuanceTrace(cases['emergency'] as Reply, { withheldBy: 'emergency-control', code: E.EMERGENCY_CONTROL_ACTIVE }, 'B after restart');
    assert.equal(adapterCalls(), 0, 'reading and verifying after restart reaches no adapter');
  });
});

/**
 * LAND-01 × LAND-02 — a linked reconsideration the Kernel now allows, withheld
 * at issuance. Lineage and issuance evidence are independent rows on the same
 * evaluation; the trace carries both, and verifies; the at-most-one
 * realization semantics are unchanged.
 */
describe('LAND-02 × LAND-01 — a reconsideration allowed by the Kernel and withheld at issuance', () => {
  it('the realization right is claimed before issuance, the issuance row is added independently, and the trace carries both stages', async () => {
    context.set(withFact(EVERY_WORLD, 'payee.approved', false));
    const original = await govern(transfer(OVER_CEILING), 'land02-recon-original');
    assert.equal(original.body['status'], 'denied', original.text);
    const originalId = requestIdOf(original);
    context.set(EVERY_WORLD);

    const before = adapterCalls();
    const reconsidered = await govern({ ...transfer(OVER_CEILING), reconsideration: { of: originalId, reason: 'context-changed' } }, 'land02-recon-holder');
    assertWithheldAfterAllow(reconsidered, 'authority-binding', F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED, 'reconsideration');
    assert.equal(adapterCalls(), before);
    const record = await recordOf(reconsidered);
    assert.deepEqual(record.references.map((entry) => entry.referenceType).sort(), ['issuance_record', 'reconsideration_link', 'reconsideration_link'], 'link, realization marker, and the issuance evidence');
    assert.ok(record.references.some((entry) => entry.referenceId === reconsiderationRealizationReferenceId(originalId)));

    const { trace } = await fetchTrace(requestIdOf(reconsidered));
    const lineage = trace.stages['request']?.['lineage'] as Record<string, unknown> | undefined;
    assert.equal(lineage?.['role'], 'reconsideration');
    assert.equal(lineage?.['realizedOriginal'], true);
    const issuance = (trace.stages['authority'] ?? {})['issuance'] as Record<string, unknown> | undefined;
    assert.deepEqual(issuance?.['reasonCodes'], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    const checks = await assertVerified(requestIdOf(reconsidered), 'reconsideration withheld at issuance');
    assert.ok(checks.some((entry) => entry.check.startsWith('lineage.')) && checks.some((entry) => entry.check.startsWith('issuance.')));

    // LAND-01 unchanged: the holder keeps the one realization; a rival is refused before issuance and records no issuance row.
    const rival = await govern({ ...transfer(OVER_CEILING), reconsideration: { of: originalId, reason: 'policy-changed' } }, 'land02-recon-rival');
    assert.equal(rival.body['status'], 'withheld', rival.text);
    assert.equal(rival.body['withheldBy'], 'reconsideration');
    assert.deepEqual(codesOf(rival), [R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED]);
    assert.equal((await recordOf(rival)).references.some((entry) => entry.referenceType === 'issuance_record'), false);
    await assertVerified(requestIdOf(rival), 'rival');
    assert.equal(adapterCalls(), before);

    // The original, a plain denial, carries neither lineage nor issuance.
    const plain = await fetchTrace(originalId);
    assert.equal('lineage' in (plain.trace.stages['request'] ?? {}), false);
    assert.equal('issuance' in (plain.trace.stages['authority'] ?? {}), false);
  });

  it('a plain (non-reconsideration) issuance withholding invents no lineage', async () => {
    const { trace } = await fetchTrace(requestIdOf(cases['ceiling'] as Reply));
    assert.equal('lineage' in (trace.stages['request'] ?? {}), false);
    assert.ok('issuance' in (trace.stages['authority'] ?? {}));
    const checks = await assertVerified(requestIdOf(cases['ceiling'] as Reply), 'plain');
    assert.equal(checks.some((entry) => entry.check.startsWith('lineage.')), false);
  });
});
