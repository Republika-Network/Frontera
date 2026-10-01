import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT,
  AUTH,
  ISSUER,
  OWNER,
  TRUST_DOMAIN,
  bootCtrl02,
  bootstrapOrganization,
  call,
  create,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  errorCode,
  expectStatus,
  govern,
  type Booted,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-02 — STANDING AUTHORITY OVER TYPED GOVERNED PARAMETERS, through the
 * shipped Host, over HTTP only.
 *
 * A genuinely non-monetary domain: a production deployment governed by the
 * CORE-03 dimensions `replicaCount` (integer, maximum) and `deploymentStrategy`
 * (token, exact). **No policy pack is composed** — the standing ceiling exists
 * only because an identified operator provisioned it on the Kernel-Authority
 * grant over the operator plane. No source, configuration edit after boot,
 * REPL or database.
 */

const DEPLOY = 'deploy-release';
const CLUSTER = 'production-cluster';
const STAGING = 'staging-cluster';
const SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-1' } as const;

const GOVERNANCE = {
  parameterDimensions: [
    { id: 'replicaCount', type: 'integer', bound: 'maximum' },
    { id: 'deploymentStrategy', type: 'token', bound: 'exact' },
    { id: 'canary', type: 'boolean', bound: 'exact' },
  ],
  actionClasses: [{ id: 'deploy', actions: [DEPLOY] }],
  resourceClasses: [
    { id: 'production', resources: [CLUSTER] },
    { id: 'staging', resources: [STAGING] },
  ],
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
    {
      profileId: 'deploy-staging',
      version: 1,
      owner: 'org-pilot',
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'staging',
      parameters: [{ dimension: 'canary', required: false }],
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
};

const file = (): Record<string, unknown> => ctrl02File({ monetary: undefined, governance: GOVERNANCE, routes: [{ action: DEPLOY, adapterId: 'pilot.recording' }] });

const workspace = createWorkspace('frontera-ctrl02-params-');
after(() => workspace.close());

const REPLICAS_3 = [
  { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
  { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
];

let sequence = 0;
const deploy = (replicaCount: unknown, deploymentStrategy: unknown = 'rolling', resource = CLUSTER): Record<string, unknown> => ({
  action: DEPLOY,
  resource,
  parameters: { replicaCount, deploymentStrategy },
  idempotencyKey: `ctrl02-param-${process.pid}-${(sequence += 1)}`,
});

const grantBody = (id: string, parameterBounds: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  authorityGrantId: id,
  issuerActorId: ISSUER,
  subjectActorId: OWNER,
  trustDomainId: TRUST_DOMAIN,
  capability: 'release.manage',
  actions: [DEPLOY],
  resourceScopes: [CLUSTER],
  canDelegate: true,
  allowedDelegateActorTypes: ['agent'],
  maxDelegationDepth: 1,
  ...(parameterBounds !== undefined ? { parameterBounds } : {}),
  ...extra,
});

const delegationBody = (id: string, source: string, parameterBounds: unknown): Record<string, unknown> => ({
  delegationGrantId: id,
  delegatorActorId: OWNER,
  delegateActorId: AGENT,
  delegateActorType: 'agent',
  trustDomainId: TRUST_DOMAIN,
  sourceAuthorityGrantId: source,
  capability: 'release.execute',
  actions: [DEPLOY],
  resourceScopes: [CLUSTER],
  canRedelegate: false,
  ...(parameterBounds !== undefined ? { parameterBounds } : {}),
});

/** Bootstrap, the owner and the agent, the agent's credential, passport and capability token — everything but the standing grant and delegation. */
async function onboard(booted: Booted): Promise<string> {
  const { baseUrl } = booted;
  await bootstrapOrganization(baseUrl);
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Release Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Release Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: SUBJECT });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'release-agent-cred-1' } }), 200, 'credential');
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'passport-release', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', {
    capabilityTokenId: 'cap-release',
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'release.execute',
    actions: [DEPLOY],
    resourceScopes: [CLUSTER],
    riskLevel: 'high',
  });
  return issued.body['bearerCredential'] as string;
}

const reasonCodes = (reply: { body: Record<string, unknown> }): readonly string[] => (reply.body['reasonCodes'] as string[] | undefined) ?? [];

async function grantParameters(baseUrl: string, executionId: string): Promise<unknown> {
  const execution = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: AUTH.observer }), 200, 'execution');
  const grant = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(execution.body['grantId'] as string)}`, { authorization: AUTH.observer }), 200, 'grant');
  return (grant.body['bounds'] as Record<string, unknown>)['parameters'];
}

describe('CTRL-02 — standing authority constrains a non-monetary governed parameter, provisioned by an operator over HTTP, enforced before any grant or adapter call', () => {
  it('replicaCount ≤ 3 and deploymentStrategy = rolling on the standing grant: 2 and 3 execute with the canonical bound signed; 4, another strategy and a wrong type reach no adapter; durable across restart', async () => {
    const dir = workspace.dir();
    const env = ctrl02Env(dir, file());
    const first = await bootCtrl02(workspace, env);
    const { baseUrl } = first;
    const credential = await onboard(first);

    // The standing ceiling, over HTTP, by the provisioner: the owner's grant and the agent's delegation.
    const grant = await create(baseUrl, AUTH.provisioner, 'authority-grant', grantBody('authority-release', REPLICAS_3));
    assert.deepEqual((grant.body['entity'] as Record<string, Record<string, unknown>>)['terms']?.['parameterBounds'], REPLICAS_3, 'stored in canonical (dimension) order, exactly as provisioned');
    await create(baseUrl, AUTH.provisioner, 'delegation-grant', delegationBody('delegation-release', 'authority-release', REPLICAS_3));

    // In bounds: executes; the signed grant carries the canonical assessed bound (≤ the standing one).
    const two = await govern(baseUrl, credential, deploy(2));
    assert.equal(two.body['status'], 'executed', two.text);
    assert.equal(first.adapter.calls.length, 1);
    assert.deepEqual(first.adapter.calls[0]?.parameters, [
      { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' },
      { dimension: 'replicaCount', type: 'integer', value: 2 },
    ]);
    assert.deepEqual(await grantParameters(baseUrl, two.body['executionId'] as string), [
      { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
      { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 2 },
    ]);
    const three = await govern(baseUrl, credential, deploy(3));
    assert.equal(three.body['status'], 'executed', three.text);
    assert.equal(first.adapter.calls.length, 2, 'at the standing maximum: authorized');

    // Outside the standing authority: withheld before any grant — the adapter is never reached.
    const four = await govern(baseUrl, credential, deploy(4));
    assert.equal(four.body['status'], 'withheld', four.text);
    assert.equal(four.body['withheldBy'], 'authority-binding');
    assert.ok(reasonCodes(four).includes('PARAMETER_AUTHORITY_EXCEEDED'), four.text);
    const bluegreen = await govern(baseUrl, credential, deploy(1, 'blue-green'));
    assert.equal(bluegreen.body['status'], 'withheld', bluegreen.text);
    assert.ok(reasonCodes(bluegreen).includes('PARAMETER_AUTHORITY_EXCEEDED'), 'an exact standing value admits nothing else');
    assert.equal(first.adapter.calls.length, 2, 'out-of-authority requests reached the adapter zero times');

    // CORE-03 semantics at the envelope, unchanged: wrong type, unsafe integer, unknown dimension, missing required — refused, never coerced.
    for (const [label, body] of [
      ['string "2"', deploy('2')],
      ['unsafe integer', deploy(2 ** 53)],
      ['float', deploy(2.5)],
      ['missing required replicaCount', { action: DEPLOY, resource: CLUSTER, parameters: { deploymentStrategy: 'rolling' }, idempotencyKey: `missing-${sequence++}` }],
      ['unknown dimension', { action: DEPLOY, resource: CLUSTER, parameters: { replicaCount: 1, deploymentStrategy: 'rolling', blastRadius: 1 }, idempotencyKey: `unknown-${sequence++}` }],
    ] as const) {
      const reply = await govern(baseUrl, credential, body as Record<string, unknown>);
      assert.notEqual(reply.body['status'], 'executed', `${label}: ${reply.text}`);
    }
    assert.equal(first.adapter.calls.length, 2, 'no malformed parameter reached the adapter');

    // Durable: a fresh process image enforces the same standing bound.
    await first.host.close();
    const second = await bootCtrl02(workspace, env);
    assert.equal((await govern(second.baseUrl, credential, deploy(4))).body['status'], 'withheld');
    assert.equal((await govern(second.baseUrl, credential, deploy(3))).body['status'], 'executed');
    assert.equal(second.adapter.calls.length, 1);
  });

  it('delegation attenuates: a delegate may narrow a standing bound, never widen or drop it; the narrower bound governs', async () => {
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), file()));
    const { baseUrl } = booted;
    const credential = await onboard(booted);
    await create(baseUrl, AUTH.provisioner, 'authority-grant', grantBody('authority-release', REPLICAS_3));

    const widened = await call(baseUrl, 'POST', '/api/admin/authority/entities/delegation-grant', {
      authorization: AUTH.provisioner,
      body: delegationBody('delegation-wide', 'authority-release', [REPLICAS_3[0], { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 4 }]),
    });
    assert.equal(widened.status, 409, widened.text);
    assert.equal((widened.body['error'] as Record<string, unknown>)['failure'], 'PARAMETER_BOUND_WIDENED');
    const dropped = await call(baseUrl, 'POST', '/api/admin/authority/entities/delegation-grant', { authorization: AUTH.provisioner, body: delegationBody('delegation-drop', 'authority-release', [REPLICAS_3[1]]) });
    assert.equal((dropped.body['error'] as Record<string, unknown>)['failure'], 'PARAMETER_BOUND_REMOVED', 'dropping the exact strategy bound would widen');
    const none = await call(baseUrl, 'POST', '/api/admin/authority/entities/delegation-grant', { authorization: AUTH.provisioner, body: delegationBody('delegation-none', 'authority-release', undefined) });
    assert.equal((none.body['error'] as Record<string, unknown>)['failure'], 'PARAMETER_BOUND_REMOVED');
    const changedExact = await call(baseUrl, 'POST', '/api/admin/authority/entities/delegation-grant', {
      authorization: AUTH.provisioner,
      body: delegationBody('delegation-exact', 'authority-release', [{ dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'blue-green' }, REPLICAS_3[1]]),
    });
    assert.equal((changedExact.body['error'] as Record<string, unknown>)['failure'], 'PARAMETER_BOUND_WIDENED', 'an exact value is preserved, never changed');

    // Narrower: ≤ 2. It — not the parent's ≤ 3 — now bounds the agent.
    await create(baseUrl, AUTH.provisioner, 'delegation-grant', delegationBody('delegation-narrow', 'authority-release', [REPLICAS_3[0], { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 2 }]));
    assert.equal((await govern(baseUrl, credential, deploy(2))).body['status'], 'executed');
    const three = await govern(baseUrl, credential, deploy(3));
    assert.equal(three.body['status'], 'withheld', three.text);
    assert.ok(reasonCodes(three).includes('PARAMETER_AUTHORITY_EXCEEDED'));
    assert.equal(booted.adapter.calls.length, 1);
  });

  it('a parent with no parameter bound may delegate a new narrower one, and it binds', async () => {
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), file()));
    const { baseUrl } = booted;
    const credential = await onboard(booted);
    await create(baseUrl, AUTH.provisioner, 'authority-grant', grantBody('authority-open', undefined));
    await create(baseUrl, AUTH.provisioner, 'delegation-grant', delegationBody('delegation-new-bound', 'authority-open', [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 5 }]));
    assert.equal((await govern(baseUrl, credential, deploy(5))).body['status'], 'executed');
    assert.equal((await govern(baseUrl, credential, deploy(6))).body['status'], 'withheld');
    assert.equal(booted.adapter.calls.length, 1);
  });

  it('an inert, mistyped, undeclared or duplicated bound is refused before it is written', async () => {
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), file()));
    const { baseUrl } = booted;
    await onboard(booted);
    for (const [label, bounds, failure, status] of [
      ['undeclared dimension', [{ dimension: 'blastRadius', kind: 'maximum', type: 'integer', limit: 1 }], 'PARAMETER_BOUND_DIMENSION_UNDECLARED', 409],
      ['type mismatch (token on an integer dimension)', [{ dimension: 'replicaCount', kind: 'exact', type: 'token', value: 'three' }], 'PARAMETER_BOUND_DECLARATION_MISMATCH', 409],
      ['a dimension the production profile does not govern', [{ dimension: 'canary', kind: 'exact', type: 'boolean', value: false }], 'PARAMETER_BOUND_UNVERIFIABLE', 409],
      ['string limit', [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: '3' }], undefined, 400],
      ['maximum over a token', [{ dimension: 'deploymentStrategy', kind: 'maximum', type: 'token', limit: 3 }], undefined, 400],
      ['unsafe integer', [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 2 ** 53 }], undefined, 400],
      ['duplicate dimension', [REPLICAS_3[1], { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 2 }], undefined, 400],
      ['case-only duplicate', [REPLICAS_3[1], { dimension: 'ReplicaCount', kind: 'maximum', type: 'integer', limit: 2 }], undefined, 400],
      ['extra key', [{ ...REPLICAS_3[1], expression: 'x <= 3' }], undefined, 400],
      ['empty list', [], undefined, 400],
    ] as const) {
      const reply = await call(baseUrl, 'POST', '/api/admin/authority/entities/authority-grant', { authorization: AUTH.provisioner, body: grantBody(`authority-bad-${label.length}`, bounds) });
      assert.equal(reply.status, status, `${label}: ${reply.text}`);
      if (failure !== undefined) assert.equal((reply.body['error'] as Record<string, unknown>)['failure'], failure, label);
    }
    // Scope that includes an ungoverned resource for the dimension: refused (the bound would be inert there).
    const mixed = await call(baseUrl, 'POST', '/api/admin/authority/entities/authority-grant', {
      authorization: AUTH.provisioner,
      body: grantBody('authority-mixed', [REPLICAS_3[1]], { resourceScopes: [CLUSTER, STAGING] }),
    });
    assert.equal((mixed.body['error'] as Record<string, unknown>)['failure'], 'PARAMETER_BOUND_UNVERIFIABLE');
    // A legacy administrator still cannot provision anything.
    const legacy = await call(baseUrl, 'POST', '/api/admin/authority/entities/authority-grant', { authorization: AUTH.legacyAdministrator, body: grantBody('authority-legacy', REPLICAS_3) });
    assert.equal(legacy.status, 403);
    assert.equal(errorCode(legacy), 'OPERATOR_PERMISSION_DENIED');
    const listed = expectStatus(await call(baseUrl, 'GET', '/api/admin/authority/entities?kind=authority-grant', { authorization: AUTH.observer }), 200, 'list');
    assert.deepEqual(listed.body['entities'], [], 'nothing was written');
  });
});
