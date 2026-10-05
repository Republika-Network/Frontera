import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  AGENT,
  AUTH,
  ISSUER,
  OWNER,
  TRUST_DOMAIN,
  bearer,
  bootCtrl02,
  bootstrapOrganization,
  call,
  create,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  errorCode,
  expectStatus,
  type Booted,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-03 — the two operator-plane reads the web control plane needs and the
 * 47-endpoint surface did not have: committed decision activity
 * (`GET /api/admin/activity/decisions`) and one decision's evidence with the
 * Governance Store's own verification (`GET /api/admin/evidence/decisions/{evaluationId}`).
 *
 * Both are read-only views over capabilities that already existed in process
 * (`GovernanceStore.query` / `getByEvaluationId` / `verify`), held to
 * `inventory.read` (every CTRL-02 role; never a CTRL-01 administrator, an API
 * key or an agent credential), scoped to the one organization the Host serves,
 * with closed query strings.
 */

const DEPLOY = 'deploy-release';
const CLUSTER = 'production-cluster';
const SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-activity' } as const;
const GOVERNANCE = {
  parameterDimensions: [
    { id: 'replicaCount', type: 'integer', bound: 'maximum' },
    { id: 'deploymentStrategy', type: 'token', bound: 'exact' },
  ],
  actionClasses: [{ id: 'deploy', actions: [DEPLOY] }],
  resourceClasses: [{ id: 'production', resources: [CLUSTER] }],
  profiles: [
    {
      profileId: 'deploy-production',
      version: 1,
      owner: 'org-pilot',
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'production',
      parameters: [
        { dimension: 'replicaCount', required: true },
        { dimension: 'deploymentStrategy', required: true },
      ],
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
};
const BOUNDS = [
  { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
  { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
];

const workspace = createWorkspace('frontera-ctrl03-activity-');
after(() => workspace.close());

let booted: Booted;
let dataDir: string;
let credential = '';
const outcomes: Record<string, Record<string, unknown>> = {};
let sequence = 0;

async function deploy(replicaCount: number): Promise<Record<string, unknown>> {
  sequence += 1;
  const reply = await call(booted.baseUrl, 'POST', '/api/governed-actions', {
    authorization: bearer(credential),
    body: { action: DEPLOY, resource: CLUSTER, parameters: { replicaCount, deploymentStrategy: 'rolling' }, idempotencyKey: `ctrl03-activity-${process.pid}-${sequence}` },
  });
  return reply.body;
}

const ACTIVITY = '/api/admin/activity/decisions';
const evidencePath = (evaluationId: string): string => `/api/admin/evidence/decisions/${encodeURIComponent(evaluationId)}`;

before(async () => {
  dataDir = workspace.dir();
  booted = await bootCtrl02(workspace, ctrl02Env(dataDir, ctrl02File({ monetary: undefined, governance: GOVERNANCE, routes: [{ action: DEPLOY, adapterId: 'pilot.recording' }] })));
  const { baseUrl } = booted;
  await bootstrapOrganization(baseUrl);
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: SUBJECT });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'activity-cred-0001' } }), 200, 'credential');
  credential = issued.body['bearerCredential'] as string;
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'passport-activity', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', {
    capabilityTokenId: 'cap-activity',
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'release.execute',
    actions: [DEPLOY],
    resourceScopes: [CLUSTER],
    riskLevel: 'medium',
  });
  await create(baseUrl, AUTH.provisioner, 'authority-grant', {
    authorityGrantId: 'authority-activity',
    issuerActorId: ISSUER,
    subjectActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'release.manage',
    actions: [DEPLOY],
    resourceScopes: [CLUSTER],
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
    parameterBounds: BOUNDS,
  });
  await create(baseUrl, AUTH.provisioner, 'delegation-grant', {
    delegationGrantId: 'delegation-activity',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: 'authority-activity',
    capability: 'release.execute',
    actions: [DEPLOY],
    resourceScopes: [CLUSTER],
    canRedelegate: false,
    parameterBounds: BOUNDS,
  });
  outcomes['executed'] = await deploy(2);
  outcomes['withheld'] = await deploy(4);
  outcomes['executed2'] = await deploy(3);
  assert.equal(outcomes['executed']['status'], 'executed', JSON.stringify(outcomes['executed']));
  assert.equal(outcomes['withheld']['status'], 'withheld', JSON.stringify(outcomes['withheld']));
});

const evaluationOf = (name: string): string => String((outcomes[name]?.['decision'] as Record<string, unknown>)['evaluationId']);

describe('CTRL-03 — operator-plane decision activity and evidence reads', () => {
  it('every CTRL-02 role may read them; a CTRL-01 administrator, an API key, an agent credential and an anonymous caller may not', async () => {
    const allowed = [AUTH.administrator, AUTH.provisioner, AUTH.observer, AUTH.responder, AUTH.steward];
    for (const authorization of allowed) {
      expectStatus(await call(booted.baseUrl, 'GET', ACTIVITY, { authorization }), 200, 'activity');
      expectStatus(await call(booted.baseUrl, 'GET', evidencePath(evaluationOf('executed')), { authorization }), 200, 'evidence');
    }
    for (const path of [ACTIVITY, evidencePath(evaluationOf('executed'))]) {
      const legacy = await call(booted.baseUrl, 'GET', path, { authorization: AUTH.legacyAdministrator });
      assert.deepEqual([legacy.status, errorCode(legacy)], [403, 'OPERATOR_PERMISSION_DENIED'], 'a CTRL-01 administrator gains no CTRL-02/03 read');
      assert.equal((await call(booted.baseUrl, 'GET', path, { authorization: AUTH.legacyKey })).status, 403, 'an API key is not an operator');
      assert.equal((await call(booted.baseUrl, 'GET', path, { authorization: bearer(credential) })).status, 401, 'an agent credential is unknown on the operator plane');
      assert.equal((await call(booted.baseUrl, 'GET', path)).status, 401);
      assert.equal((await call(booted.baseUrl, 'GET', path, { authorization: bearer('not-a-real-operator-secret-0000000000') })).status, 401);
    }
  });

  it('lists exactly the organization’s committed Kernel decisions, newest first, restating the store’s summary fields', async () => {
    const reply = expectStatus(await call(booted.baseUrl, 'GET', ACTIVITY, { authorization: AUTH.observer }), 200, 'activity');
    const decisions = reply.body['decisions'] as Record<string, unknown>[];
    assert.equal(reply.body['coverage'], 'governance-store-decisions');
    assert.deepEqual(
      decisions.map((decision) => decision['evaluationId']),
      [evaluationOf('executed2'), evaluationOf('withheld'), evaluationOf('executed')],
    );
    for (const decision of decisions) {
      assert.deepEqual(Object.keys(decision).sort(), ['actionType', 'actorId', 'correlationId', 'decisionId', 'evaluatedAt', 'evaluationId', 'persistedAt', 'reasonCodes', 'requestId', 'status'].sort(), 'a closed DTO: no payload, no digest');
      assert.equal(decision['actorId'], AGENT);
      assert.equal(decision['actionType'], DEPLOY);
    }
    const withheld = decisions.find((decision) => decision['evaluationId'] === evaluationOf('withheld'));
    assert.equal(withheld?.['status'], 'allowed', 'the Kernel decision is recorded as such; the withholding after it is not a Kernel status');
    assert.equal(withheld?.['requestId'], outcomes['withheld']?.['requestId']);
  });

  it('filters by actor, decision, request and status, and pages with an opaque cursor', async () => {
    const byDecision = await call(booted.baseUrl, 'GET', `${ACTIVITY}?decisionId=${encodeURIComponent(String((outcomes['executed']?.['decision'] as Record<string, unknown>)['decisionId']))}`, { authorization: AUTH.observer });
    assert.deepEqual((byDecision.body['decisions'] as Record<string, unknown>[]).map((decision) => decision['evaluationId']), [evaluationOf('executed')]);
    const byRequest = await call(booted.baseUrl, 'GET', `${ACTIVITY}?requestId=${encodeURIComponent(String(outcomes['withheld']?.['requestId']))}`, { authorization: AUTH.observer });
    assert.deepEqual((byRequest.body['decisions'] as Record<string, unknown>[]).map((decision) => decision['evaluationId']), [evaluationOf('withheld')]);
    assert.equal(((await call(booted.baseUrl, 'GET', `${ACTIVITY}?actorId=nobody-here`, { authorization: AUTH.observer })).body['decisions'] as unknown[]).length, 0);
    assert.equal(((await call(booted.baseUrl, 'GET', `${ACTIVITY}?status=denied`, { authorization: AUTH.observer })).body['decisions'] as unknown[]).length, 0);
    const first = await call(booted.baseUrl, 'GET', `${ACTIVITY}?limit=2`, { authorization: AUTH.observer });
    assert.equal((first.body['decisions'] as unknown[]).length, 2);
    assert.equal(typeof first.body['nextCursor'], 'string');
    const second = await call(booted.baseUrl, 'GET', `${ACTIVITY}?limit=2&cursor=${encodeURIComponent(String(first.body['nextCursor']))}`, { authorization: AUTH.observer });
    assert.deepEqual((second.body['decisions'] as Record<string, unknown>[]).map((decision) => decision['evaluationId']), [evaluationOf('executed')]);
    assert.equal(second.body['nextCursor'], null);
  });

  it('the query is closed: an organization, a tenant or any other key, and malformed values, are refused before the store is read', async () => {
    for (const query of ['organizationId=org-other', 'tenantId=org-other', 'system=true', 'limit=0', 'limit=101', 'limit=abc', 'status=executed', 'actorId=%20padded', 'cursor=%3Cscript%3E']) {
      const reply = await call(booted.baseUrl, 'GET', `${ACTIVITY}?${query}`, { authorization: AUTH.observer });
      assert.deepEqual([reply.status, errorCode(reply)], [400, 'INVALID_REQUEST'], query);
    }
    const evidence = await call(booted.baseUrl, 'GET', `${evidencePath(evaluationOf('executed'))}?organizationId=org-other`, { authorization: AUTH.observer });
    assert.equal(evidence.status, 400);
  });

  it('evidence: the record, its references and the store’s verification — the executed decision links its grant and execution; the withheld one records neither', async () => {
    const executed = expectStatus(await call(booted.baseUrl, 'GET', evidencePath(evaluationOf('executed')), { authorization: AUTH.observer }), 200, 'evidence');
    const decision = executed.body['decision'] as Record<string, unknown>;
    assert.equal(decision['decisionId'], (outcomes['executed']?.['decision'] as Record<string, unknown>)['decisionId']);
    assert.equal(decision['requestId'], outcomes['executed']?.['requestId']);
    assert.equal(decision['resourceScope'], CLUSTER);
    const references = executed.body['references'] as Record<string, unknown>[];
    assert.ok(references.some((reference) => reference['referenceType'] === 'authorization_artifact' && typeof reference['externalId'] === 'string' && (reference['externalId'] as string).startsWith('aoc.grant:')));
    assert.ok(references.some((reference) => reference['referenceType'] === 'execution_record' && reference['externalId'] === outcomes['executed']?.['executionId']));
    const verification = executed.body['verification'] as Record<string, unknown>;
    assert.equal(verification['valid'], true);
    assert.deepEqual(verification['failures'], []);
    assert.equal(executed.body['coverage'], 'governance-store-decision-record');
    assert.equal(JSON.stringify(executed.body).includes('requestPayload'), false, 'no raw request payload is serialized');
    const withheld = expectStatus(await call(booted.baseUrl, 'GET', evidencePath(evaluationOf('withheld')), { authorization: AUTH.observer }), 200, 'evidence');
    const withheldReferences = withheld.body['references'] as readonly Record<string, unknown>[];
    assert.deepEqual(withheldReferences.filter((reference) => reference['referenceType'] !== 'issuance_record'), [], 'no grant or execution was recorded for the withheld request');
    // ANDREW-P0-10: what *was* recorded is the issuance withholding itself — evidence of the result, never authority.
    assert.deepEqual(withheldReferences.map((reference) => [reference['referenceType'], reference['externalVersion']]), [['issuance_record', 'withheld:authority-binding:PARAMETER_AUTHORITY_EXCEEDED']]);
    const missing = await call(booted.baseUrl, 'GET', evidencePath('no-such-evaluation'), { authorization: AUTH.observer });
    assert.deepEqual([missing.status, errorCode(missing)], [404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND']);
  });

  it('neither route accepts a write: POST, PUT and DELETE on them are unrouted', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const path of [ACTIVITY, evidencePath(evaluationOf('executed'))]) {
        const reply = await call(booted.baseUrl, method, path, { authorization: AUTH.administrator, body: {} });
        assert.equal(reply.status, 404, `${method} ${path}`);
      }
    }
  });

  it('a tampered decision record is reported by the store’s verification as invalid — never as verified', async () => {
    const db = new Database(join(dataDir, 'governance.sqlite'));
    try {
      db.prepare(`UPDATE governance_evaluations SET summary = 'tampered summary' WHERE evaluation_id = ?`).run(evaluationOf('executed2'));
    } finally {
      db.close();
    }
    const reply = expectStatus(await call(booted.baseUrl, 'GET', evidencePath(evaluationOf('executed2')), { authorization: AUTH.observer }), 200, 'evidence');
    const verification = reply.body['verification'] as { valid: boolean; failures: unknown[]; checks: Record<string, boolean> };
    assert.equal(verification.valid, false);
    assert.ok(verification.failures.length > 0);
    assert.equal(verification.checks['evaluationDigest'], false);
  });
});
