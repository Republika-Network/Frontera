import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createAuthorityAdministrationService, type AuthorityAdministrationService } from '../authority-administration/service.js';
import { createGovernanceProfileRegistry, type GovernanceConfiguration } from '../governance-profile/index.js';
import type { KernelAuthorityAccessContext } from '../kernel-authority/contracts.js';
import { KernelAuthorityError } from '../kernel-authority/errors.js';
import { createCustomerIdentityAdmission, createKernelAuthoritySubjectBindingReader } from '../customer-identity/index.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { agentCredentialVerifier, createAgentCredentialVerifier, formatAgentCredential, newAgentCredentialId, newAgentCredentialSecret } from '../operator-control/agent-credentials.js';
import { createSqliteControlPlaneStore, replayProfileLifecycle, type ControlPlaneStore, type ProfileLifecycleState } from '../operator-control/control-plane-store.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { createOperatorControlService, type OperatorControlService } from '../operator-control/service.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';

/**
 * CTRL-02 — the operator control service, qualified directly: the complete
 * role × operation matrix (CTRL-01 and CTRL-02 operations), organization
 * binding, and the provisioning matrix for every Kernel-Authority kind the
 * operator plane exposes. The Host-level suites prove the same boundary over
 * HTTP; this one can count body reads and store writes exactly.
 */

const ORG = 'org-pilot';
const FOREIGN = 'org-foreign';
const TD = 'td-pilot';
const SECRET = {
  'organization-administrator': 'svc-secret-org-admin-0123456789abcdef0123',
  provisioner: 'svc-secret-provisioner-0123456789abcdef012',
  observer: 'svc-secret-observer-0123456789abcdef012345',
  responder: 'svc-secret-responder-0123456789abcdef01234',
  'profile-steward': 'svc-secret-steward-0123456789abcdef0123456',
  'legacy-administrator': 'svc-secret-legacy-admin-0123456789abcdef01',
  customer: 'svc-secret-ordinary-customer-key-0123456789',
} as const;
type Caller = keyof typeof SECRET;
const CALLERS: readonly Exclude<Caller, 'customer'>[] = ['organization-administrator', 'provisioner', 'observer', 'responder', 'profile-steward', 'legacy-administrator'];
const auth = (caller: Caller): string => `Bearer ${SECRET[caller]}`;

const GOVERNANCE: GovernanceConfiguration = {
  actionClasses: [{ id: 'payment', actions: ['transfer-funds'] }],
  resourceClasses: [{ id: 'operating-funds', resources: ['operating-account'] }],
  profiles: [1, 2].map((version) => ({
    profileId: 'payables-transfer',
    version,
    owner: ORG,
    provenance: { authoredBy: 'policy-team', approvedBy: 'risk-committee' },
    actionClass: 'payment',
    resourceClass: 'operating-funds',
    parameters: [],
    materialFacts: [],
    relevantPolicies: version === 1 ? ['payables-baseline'] : ['payables-baseline', 'payables-v2'],
  })),
};

interface Harness {
  readonly service: OperatorControlService;
  readonly admin: AuthorityAdministrationService;
  readonly store: KernelAuthorityStore;
  readonly provisioning: KernelAuthorityProvisioningService;
  readonly foreign: KernelAuthorityProvisioningService;
  readonly controlPlane: ControlPlaneStore;
  readonly writes: KernelAuthorityAccessContext[];
  readonly logs: string[];
  readonly mutations: { count: number };
  readonly lifecycle: () => ProfileLifecycleState;
  readonly registry: ReturnType<typeof createGovernanceProfileRegistry>;
}

const BOOT: KernelAuthorityAccessContext = { system: true, actorId: 'operator:test-bootstrap' };

async function harness(options: { readonly store?: KernelAuthorityStore; readonly lifecycle?: boolean } = {}): Promise<Harness> {
  const store = options.store ?? createInMemoryKernelAuthorityStore();
  const assets = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }]);
  const real = createKernelAuthorityProvisioningService({ store, organizationId: ORG, monetaryAssets: assets });
  const writes: KernelAuthorityAccessContext[] = [];
  const mutations = { count: 0 };
  // A spy over the real provisioning service: every write context the operator plane hands it is recorded.
  const provisioning = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || !/^(provision|revoke)/.test(String(property))) return value;
      return (context: KernelAuthorityAccessContext, ...rest: unknown[]) => {
        writes.push(context);
        mutations.count += 1;
        return (value as (...args: unknown[]) => unknown).call(target, context, ...rest);
      };
    },
  }) as KernelAuthorityProvisioningService;
  const foreign = createKernelAuthorityProvisioningService({ store, organizationId: FOREIGN });
  const controlPlane = await createSqliteControlPlaneStore(':memory:');
  let state: ProfileLifecycleState = replayProfileLifecycle([]);
  const lifecycleOn = options.lifecycle !== false;
  const registry = createGovernanceProfileRegistry(GOVERNANCE, lifecycleOn ? { lifecycle: { activeVersion: (id: string) => state.active.get(id) } } : {});
  const logs: string[] = [];
  const logger: EnterpriseLogger = {
    debug: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => logs.push(JSON.stringify({ message, fields })),
  };
  const operators = (['organization-administrator', 'provisioner', 'observer', 'responder', 'profile-steward'] as const).map((role) => ({ operatorId: `ops-${role}`, role, key: SECRET[role] }));
  const administrators = [{ operatorId: 'ops-legacy', key: SECRET['legacy-administrator'] }];
  const ordinaryCredentials = [{ key: SECRET.customer, organizationId: ORG }];
  const authenticator = createOperatorAuthenticator({ administrators, operators, ordinaryCredentials, organizationId: ORG, isReady: () => true, lifecycleState: () => 'ready' });
  const now = () => '2026-10-01T12:00:00.000Z';
  const service = createOperatorControlService({
    authenticator,
    organizationId: ORG,
    trustDomainId: TD,
    now,
    logger,
    kernelAuthority: { store, provisioning },
    controlPlane,
    staticCustomerSubjects: [{ system: 'static-app', subjectId: 'static-1' }],
    governance: registry,
    ...(lifecycleOn
      ? {
          profileLifecycle: {
            reload: async () => {
              state = replayProfileLifecycle(await controlPlane.listProfileLifecycleEvents(ORG));
            },
          },
        }
      : {}),
  });
  const emergency = {
    active: () => [],
    activate: () => {
      mutations.count += 1;
    },
    release: () => {
      mutations.count += 1;
    },
  };
  const admin = createAuthorityAdministrationService({
    administrators,
    operators,
    authenticator,
    ordinaryCredentials,
    organizationId: ORG,
    now,
    isReady: () => true,
    lifecycleState: () => 'ready',
    logger,
    grants: {
      reader: { read: async () => ({}) },
      revoke: async () => {
        mutations.count += 1;
        return { outcome: 'refused', reasonCodes: ['GRANT_NOT_FOUND'] } as never;
      },
    },
    kernelAuthority: { store, provisioning },
    emergencyControl: emergency as never,
    executionOutcomes: { read: async () => undefined } as never,
  });
  return { service, admin, store, provisioning, foreign, controlPlane, writes, logs, mutations, lifecycle: () => state, registry };
}

async function httpError(promise: Promise<unknown>): Promise<EnterpriseHttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EnterpriseHttpError, `expected an EnterpriseHttpError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the operation to be refused');
}

const reader = (body: unknown, counter?: { reads: number }) => async (): Promise<unknown> => {
  if (counter !== undefined) counter.reads += 1;
  return body;
};

/** The organization's bootstrap and one agent, provisioned in-process (this suite qualifies the service itself, not onboarding). */
async function world(h: Harness): Promise<void> {
  const p = h.provisioning;
  await p.provisionActor(BOOT, { actorId: 'actor-org', type: 'organization', displayName: 'Org' });
  await p.provisionTrustDomain(BOOT, { trustDomainId: TD, name: 'TD', issuerActorId: 'actor-org', acceptedIssuerIds: ['actor-org'], acceptedActorTypes: ['human', 'agent', 'organization'] });
  await p.provisionRootIssuer(BOOT, { trustDomainId: TD, actorId: 'actor-org' });
  await p.provisionActor(BOOT, { actorId: 'actor-owner', type: 'human', displayName: 'Owner', issuerId: 'actor-org', trustDomainId: TD });
  await p.provisionActor(BOOT, { actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD, externalSubject: { system: 'app', subjectId: 'agent-1' } });
  h.writes.length = 0;
  h.mutations.count = 0;
}

// -- valid request bodies, one per kind ----------------------------------------------

function validBody(kind: string, suffix = '1'): Record<string, unknown> {
  switch (kind) {
    case 'actor':
      return { actorId: `actor-new-${suffix}`, type: 'agent', displayName: 'New Agent', issuerId: 'actor-org', trustDomainId: TD, externalSubject: { system: 'app', subjectId: `new-${suffix}` } };
    case 'trust-domain':
      return { trustDomainId: `td-new-${suffix}`, name: 'New TD', issuerActorId: 'actor-org', acceptedIssuerIds: ['actor-org'], acceptedActorTypes: ['agent'] };
    case 'root-issuer':
      return { trustDomainId: 'td-new-1', actorId: suffix === '1' ? 'actor-org' : 'actor-owner' };
    case 'passport':
      return { passportId: `passport-${suffix}`, type: 'agent_passport', subjectActorId: 'actor-agent', issuerActorId: 'actor-org', trustDomainId: TD };
    case 'capability-token':
      return {
        capabilityTokenId: `cap-${suffix}`,
        subjectActorId: 'actor-agent',
        principalActorId: 'actor-owner',
        issuerActorId: 'actor-owner',
        trustDomainId: TD,
        capability: 'payables.execute',
        actions: ['transfer-funds'],
        resourceScopes: ['operating-account'],
        riskLevel: 'medium',
      };
    case 'authority-grant':
      return {
        authorityGrantId: `grant-${suffix}`,
        issuerActorId: 'actor-org',
        subjectActorId: 'actor-owner',
        trustDomainId: TD,
        capability: 'payables.manage',
        actions: ['transfer-funds'],
        resourceScopes: ['operating-account'],
        canDelegate: true,
        allowedDelegateActorTypes: ['agent'],
        maxDelegationDepth: 1,
        constraints: [{ type: 'max_amount', currency: 'USD', value: '500' }],
      };
    case 'delegation-grant':
      return {
        delegationGrantId: `delegation-${suffix}`,
        delegatorActorId: 'actor-owner',
        delegateActorId: 'actor-agent',
        delegateActorType: 'agent',
        trustDomainId: TD,
        sourceAuthorityGrantId: 'grant-base',
        capability: 'payables.execute',
        actions: ['transfer-funds'],
        resourceScopes: ['operating-account'],
      };
    default:
      throw new Error(kind);
  }
}

/** Prerequisites a kind's valid body names. */
async function prerequisites(h: Harness, kind: string): Promise<void> {
  if (kind === 'root-issuer') await h.provisioning.provisionTrustDomain(BOOT, validBody('trust-domain') as never);
  if (kind === 'delegation-grant') await h.provisioning.provisionAuthorityGrant(BOOT, { ...validBody('authority-grant'), authorityGrantId: 'grant-base' } as never);
  h.writes.length = 0;
  h.mutations.count = 0;
}

const idOf = (kind: string, body: Record<string, unknown>): string =>
  kind === 'root-issuer'
    ? `${String(body['trustDomainId'])}::${String(body['actorId'])}`
    : String(body[{ actor: 'actorId', 'trust-domain': 'trustDomainId', passport: 'passportId', 'capability-token': 'capabilityTokenId', 'authority-grant': 'authorityGrantId', 'delegation-grant': 'delegationGrantId' }[kind] ?? '']);

// =====================================================================================
// 1. The role × operation matrix
// =====================================================================================

type Operation = {
  readonly name: string;
  readonly allowed: readonly Exclude<Caller, 'customer'>[];
  readonly mutates: boolean;
  /** `true` when the operation reads a body; the body must never be read for a refused caller. */
  readonly body: boolean;
  readonly run: (h: Harness, header: string, read: () => Promise<unknown>) => Promise<unknown>;
};

const ALL: readonly Exclude<Caller, 'customer'>[] = ['organization-administrator', 'provisioner', 'observer', 'responder', 'profile-steward', 'legacy-administrator'];
const CTRL02_READERS: readonly Exclude<Caller, 'customer'>[] = ['organization-administrator', 'provisioner', 'observer', 'responder', 'profile-steward'];

/**
 * The expectation table, written out by hand — deliberately NOT derived from
 * `roles.ts`, so a change to the policy that grants or removes a permission is
 * caught here rather than restated.
 */
const OPERATIONS: readonly Operation[] = [
  // CTRL-01
  { name: 'inspectGrant', allowed: ALL, mutates: false, body: false, run: (h, a) => h.admin.inspectGrant(a, 'aoc.grant:00000000000000000000000000000000') },
  { name: 'inspectExecutionGrant', allowed: ALL, mutates: false, body: false, run: (h, a) => h.admin.inspectExecutionGrant(a, 'exec-1') },
  { name: 'inspectAuthorityEntity', allowed: ALL, mutates: false, body: false, run: (h, a) => h.admin.inspectAuthorityEntity(a, 'actor', 'actor-agent') },
  { name: 'listEmergencyControls', allowed: ALL, mutates: false, body: false, run: (h, a) => h.admin.listEmergencyControls(a) },
  { name: 'revokeGrant', allowed: ['organization-administrator', 'provisioner', 'responder', 'legacy-administrator'], mutates: true, body: true, run: (h, a, r) => h.admin.revokeGrant(a, 'aoc.grant:00000000000000000000000000000000', r) },
  { name: 'revokeAuthorityEntity', allowed: ['organization-administrator', 'provisioner', 'responder', 'legacy-administrator'], mutates: true, body: true, run: (h, a, r) => h.admin.revokeAuthorityEntity(a, 'actor', 'actor-agent', r) },
  { name: 'activateEmergencyControl', allowed: ['organization-administrator', 'responder', 'legacy-administrator'], mutates: true, body: true, run: (h, a, r) => h.admin.activateEmergencyControl(a, r) },
  { name: 'releaseEmergencyControl', allowed: ['organization-administrator', 'legacy-administrator'], mutates: true, body: true, run: (h, a, r) => h.admin.releaseEmergencyControl(a, r) },
  // CTRL-02 reads
  { name: 'describeOrganization', allowed: CTRL02_READERS, mutates: false, body: false, run: (h, a) => h.service.describeOrganization(a, {}) },
  { name: 'listAgents', allowed: CTRL02_READERS, mutates: false, body: false, run: (h, a) => h.service.listAgents(a, {}) },
  { name: 'inspectAgent', allowed: CTRL02_READERS, mutates: false, body: false, run: (h, a) => h.service.inspectAgent(a, 'actor-agent', {}) },
  { name: 'listAuthorityEntities', allowed: CTRL02_READERS, mutates: false, body: false, run: (h, a) => h.service.listAuthorityEntities(a, {}) },
  { name: 'listGovernanceProfiles', allowed: CTRL02_READERS, mutates: false, body: false, run: (h, a) => h.service.listGovernanceProfiles(a, {}) },
  // CTRL-02 credentials
  { name: 'issueAgentCredential', allowed: ['organization-administrator', 'provisioner'], mutates: true, body: true, run: (h, a, r) => h.service.issueAgentCredential(a, 'actor-agent', r) },
  { name: 'rotateAgentCredential', allowed: ['organization-administrator', 'provisioner'], mutates: true, body: true, run: (h, a, r) => h.service.rotateAgentCredential(a, 'actor-agent', 'agc-00000000000000000000000000000000', r) },
  { name: 'revokeAgentCredential', allowed: ['organization-administrator', 'provisioner', 'responder'], mutates: true, body: true, run: (h, a, r) => h.service.revokeAgentCredential(a, 'actor-agent', 'agc-00000000000000000000000000000000', r) },
  // CTRL-02 provisioning — standing authority
  ...(['actor', 'passport', 'capability-token', 'authority-grant', 'delegation-grant'] as const).map(
    (kind): Operation => ({ name: `provision:${kind}`, allowed: ['organization-administrator', 'provisioner'], mutates: true, body: true, run: (h, a, r) => h.service.provisionAuthorityEntity(a, kind, r) }),
  ),
  // CTRL-02 provisioning — organization bootstrap
  ...(['trust-domain', 'root-issuer'] as const).map(
    (kind): Operation => ({ name: `provision:${kind}`, allowed: ['organization-administrator'], mutates: true, body: true, run: (h, a, r) => h.service.provisionAuthorityEntity(a, kind, r) }),
  ),
  // CTRL-02 profile lifecycle
  { name: 'activateProfile', allowed: ['organization-administrator', 'profile-steward'], mutates: true, body: true, run: (h, a, r) => h.service.transitionGovernanceProfile(a, 'payables-transfer', '1', 'activate', r) },
  { name: 'retireProfile', allowed: ['organization-administrator', 'profile-steward'], mutates: true, body: true, run: (h, a, r) => h.service.transitionGovernanceProfile(a, 'payables-transfer', '1', 'retire', r) },
];

describe('CTRL-02 role matrix — every operator role × every CTRL-01 and CTRL-02 operation', () => {
  it('the matrix covers every operation of both services', async () => {
    const h = await harness();
    const covered = new Set(OPERATIONS.map((operation) => operation.name.split(':')[0]));
    for (const method of [...Object.keys(h.admin), ...Object.keys(h.service).map((name) => (name === 'provisionAuthorityEntity' ? 'provision' : name === 'transitionGovernanceProfile' ? 'activateProfile' : name))]) {
      assert.ok(covered.has(method), `operation ${method} is not in the matrix`);
    }
  });

  for (const operation of OPERATIONS) {
    for (const caller of CALLERS) {
      const allowed = operation.allowed.includes(caller);
      it(`${caller} → ${operation.name}: ${allowed ? 'authorized (never 401/403)' : '403, body unread, nothing written, nothing logged'}`, async () => {
        const h = await harness();
        await world(h);
        const counter = { reads: 0 };
        const logsBefore = h.logs.length;
        const outcome = await operation.run(h, auth(caller), reader({}, counter)).then(
          () => undefined,
          (error: unknown) => error,
        );
        if (allowed) {
          if (outcome !== undefined) {
            assert.ok(outcome instanceof EnterpriseHttpError, String(outcome));
            assert.ok(outcome.httpStatus !== 401 && outcome.httpStatus !== 403, `${caller} must be authorized for ${operation.name}; got ${outcome.httpStatus} ${outcome.code}`);
          }
          if (operation.body) assert.equal(counter.reads, 1, 'an authorized mutation reads its body');
        } else {
          assert.ok(outcome instanceof EnterpriseHttpError, `${caller} must be refused ${operation.name}`);
          assert.equal(outcome.httpStatus, 403);
          assert.equal(outcome.code, 'OPERATOR_PERMISSION_DENIED');
          assert.equal(counter.reads, 0, 'the body of a refused operation is never read');
          assert.equal(h.mutations.count, 0, 'nothing is written');
          assert.equal((await h.controlPlane.listAgentPrincipals(ORG)).length, 0, 'no credential state is written');
          assert.equal((await h.controlPlane.listProfileLifecycleEvents(ORG)).length, 0, 'no lifecycle state is written');
          assert.equal(h.logs.length, logsBefore, 'no audit record claims anything');
        }
      });
    }
  }

  it('a read-only observer holds no permission that writes: every mutating operation is 403, its body unread, nothing written', async () => {
    const h = await harness();
    await world(h);
    for (const operation of OPERATIONS.filter((candidate) => candidate.mutates)) {
      const counter = { reads: 0 };
      const error = await httpError(operation.run(h, auth('observer'), reader({}, counter)));
      assert.equal(error.code, 'OPERATOR_PERMISSION_DENIED', operation.name);
      assert.equal(counter.reads, 0, operation.name);
    }
    assert.equal(h.mutations.count, 0);
    assert.equal((await h.controlPlane.listAgentPrincipals(ORG)).length, 0);
    assert.equal((await h.controlPlane.listProfileLifecycleEvents(ORG)).length, 0);
  });

  it('a responder only narrows: it revokes and stops, and cannot create, widen, release or promote anything', async () => {
    const h = await harness();
    await world(h);
    for (const operation of OPERATIONS.filter((candidate) => candidate.mutates && !['revokeGrant', 'revokeAuthorityEntity', 'activateEmergencyControl', 'revokeAgentCredential'].includes(candidate.name))) {
      const counter = { reads: 0 };
      const error = await httpError(operation.run(h, auth('responder'), reader({}, counter)));
      assert.equal(error.code, 'OPERATOR_PERMISSION_DENIED', operation.name);
      assert.equal(counter.reads, 0, operation.name);
    }
    assert.equal(h.mutations.count, 0);
  });

  it('an organization actor is bootstrap: a provisioner is refused it (after its own body is validated) and nothing is written', async () => {
    const h = await harness();
    await world(h);
    const error = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'actor', reader({ actorId: 'actor-org-2', type: 'organization', displayName: 'Second Org' })));
    assert.equal(error.httpStatus, 403);
    assert.equal(error.code, 'OPERATOR_PERMISSION_DENIED');
    assert.equal(h.mutations.count, 0);
    // The observer never gets that far: its body is not read.
    const counter = { reads: 0 };
    assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('observer'), 'actor', reader({}, counter)))).httpStatus, 403);
    assert.equal(counter.reads, 0);
  });

  for (const [label, header, status] of [
    ['no header', undefined, 401],
    ['an empty header', '', 401],
    ['a non-Bearer scheme', `Basic ${SECRET.provisioner}`, 401],
    ['a truncated secret', `Bearer ${SECRET.provisioner.slice(0, -1)}`, 401],
    ['an unknown secret', 'Bearer not-a-real-operator-secret-0123456789abcdef', 401],
    ['an ordinary customer key', auth('customer'), 403],
    ['an operator-issued agent credential', 'Bearer fra1.agc-0123456789abcdef0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 401],
  ] as const) {
    it(`${label} → ${status} on every operation; nothing read, written or logged`, async () => {
      const h = await harness();
      await world(h);
      for (const operation of OPERATIONS) {
        const counter = { reads: 0 };
        const error = await httpError(operation.run(h, header as string, reader({}, counter)));
        assert.equal(error.httpStatus, status, `${operation.name}`);
        assert.equal(counter.reads, 0);
      }
      assert.equal(h.mutations.count, 0);
      assert.equal(h.logs.length, 0);
    });
  }

  it('a CTRL-01 administrator is held to CTRL-01: it can revoke and stop, and cannot provision, issue credentials, promote profiles or read the CTRL-02 inventory', async () => {
    const h = await harness();
    await world(h);
    const who = await httpError(h.service.describeOrganization(auth('legacy-administrator'), {}));
    assert.equal(who.code, 'OPERATOR_PERMISSION_DENIED');
    for (const kind of ['actor', 'trust-domain', 'root-issuer', 'passport', 'capability-token', 'authority-grant', 'delegation-grant']) {
      assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('legacy-administrator'), kind, reader(validBody(kind))))).httpStatus, 403, kind);
    }
    const revoked = await h.admin.revokeAuthorityEntity(auth('legacy-administrator'), 'actor', 'actor-agent', reader({ reason: 'incident' }));
    assert.equal(revoked.entity.revokedBy, 'operator:ops-legacy');
  });
});

// =====================================================================================
// 2. Organization binding
// =====================================================================================

describe('CTRL-02 organization binding — the served organization is the only one, and it is never caller-chosen', () => {
  for (const field of ['organizationId', 'tenantId', 'operatorId', 'role', 'permissions', 'system', 'actorRef', 'issuerRef', 'provisionedBy', 'approvedBy', 'authenticated', 'authorityState', 'digest', 'signature', 'privateKey', 'apiKey', 'credentialHash', 'admin', 'parameters', 'boundedGrant']) {
    it(`a provisioning body carrying '${field}' is refused before anything is written`, async () => {
      const h = await harness();
      await world(h);
      const error = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'passport', reader({ ...validBody('passport'), [field]: field === 'system' ? true : 'x' })));
      assert.equal(error.httpStatus, 400);
      assert.equal(h.mutations.count, 0);
    });
  }

  it('an organization in the query string is refused on every CTRL-02 read', async () => {
    const h = await harness();
    await world(h);
    for (const run of [
      () => h.service.describeOrganization(auth('observer'), { organizationId: FOREIGN }),
      () => h.service.listAgents(auth('observer'), { organizationId: FOREIGN }),
      () => h.service.inspectAgent(auth('observer'), 'actor-agent', { organizationId: FOREIGN }),
      () => h.service.listAuthorityEntities(auth('observer'), { organizationId: FOREIGN }),
      () => h.service.listGovernanceProfiles(auth('observer'), { organization: FOREIGN }),
    ]) {
      assert.equal((await httpError(run())).httpStatus, 400);
    }
  });

  it("another organization's actor, authority and profile lifecycle are invisible, unaddressable and cannot be attached", async () => {
    const h = await harness();
    await world(h);
    // The foreign organization provisions in the same store — same ids, different organization.
    await h.foreign.provisionActor(BOOT, { actorId: 'actor-foreign-agent', type: 'agent', displayName: 'Foreign', externalSubject: { system: 'app', subjectId: 'foreign-1' } });
    await h.foreign.provisionActor(BOOT, { actorId: 'actor-owner', type: 'human', displayName: 'Foreign Owner' });
    await h.foreign.provisionAuthorityGrant(BOOT, { ...validBody('authority-grant'), authorityGrantId: 'grant-foreign' } as never);
    h.mutations.count = 0;

    const agents = await h.service.listAgents(auth('observer'), {});
    assert.deepEqual(agents.agents.map((agent) => agent.actorId), ['actor-agent']);
    assert.equal((await httpError(h.service.inspectAgent(auth('observer'), 'actor-foreign-agent', {}))).httpStatus, 404);
    const entities = await h.service.listAuthorityEntities(auth('observer'), {});
    assert.ok(entities.entities.every((entity) => entity.organizationId === ORG));
    assert.ok(!entities.entities.some((entity) => entity.entityId === 'grant-foreign'));
    // A credential for a foreign actor: not found here.
    assert.equal((await httpError(h.service.issueAgentCredential(auth('provisioner'), 'actor-foreign-agent', reader({ idempotencyKey: 'foreign-credential-1' })))).httpStatus, 404);
    // A delegation from a foreign authority grant: the engines cannot replay it in this organization — refused before any write.
    const attach = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'delegation-grant', reader({ ...validBody('delegation-grant'), sourceAuthorityGrantId: 'grant-foreign' })));
    assert.equal(attach.httpStatus, 409);
    assert.equal(attach.code, 'OPERATOR_OPERATION_REFUSED');
    assert.equal(h.mutations.count, 0);
    // A foreign organization's lifecycle history does not activate anything here.
    const definition = h.registry.profiles[0];
    assert.ok(definition !== undefined);
    await h.controlPlane.transitionProfile({ organizationId: FOREIGN, profileId: 'payables-transfer', version: 1, digest: definition.reference.digest, transition: 'activated', operatorRef: 'operator:foreign', at: '2026-10-01T00:00:00.000Z' });
    const profiles = await h.service.listGovernanceProfiles(auth('observer'), {});
    assert.ok(profiles.profiles.every((profile) => profile.state === 'draft'));
  });

  it('an operator-issued credential of another organization authenticates nothing here', async () => {
    const h = await harness();
    const credentialId = newAgentCredentialId();
    const secret = newAgentCredentialSecret();
    await h.controlPlane.issueAgentCredential({
      organizationId: FOREIGN,
      principal: { principalId: 'agent:actor-foreign', actorId: 'actor-foreign', externalSubject: { system: 'app', subjectId: 'foreign-1' } },
      credentialId,
      verifier: agentCredentialVerifier(secret),
      operatorRef: 'operator:foreign',
      at: '2026-10-01T00:00:00.000Z',
      idempotencyKey: 'foreign-issue-0001',
      requestDigest: 'sha256:foreign',
    });
    const token = formatAgentCredential(credentialId, secret);
    assert.equal((await createAgentCredentialVerifier(h.controlPlane, FOREIGN).authenticate(token)).status, 'authenticated', 'control: it is valid in its own organization');
    assert.deepEqual(await createAgentCredentialVerifier(h.controlPlane, ORG).authenticate(token), { status: 'refused' });
    assert.equal(await h.controlPlane.readAgentCredentialForVerification(ORG, credentialId), undefined);
  });

  it('admission believes the Kernel Authority, not the credential record: a principal naming another actor than the binding admits no one', async () => {
    const h = await harness();
    await world(h);
    const admission = createCustomerIdentityAdmission({
      apiKeys: [],
      subjectBindings: createKernelAuthoritySubjectBindingReader(h.store),
      organizationId: ORG,
      agentCredentials: createAgentCredentialVerifier(h.controlPlane, ORG),
      reservedPrincipalPrefix: 'agent:',
    });
    const issue = async (actorId: string, key: string): Promise<string> => {
      const credentialId = newAgentCredentialId();
      const secret = newAgentCredentialSecret();
      await h.controlPlane.issueAgentCredential({
        organizationId: ORG,
        principal: { principalId: `agent:${actorId}`, actorId, externalSubject: { system: 'app', subjectId: 'agent-1' } },
        credentialId,
        verifier: agentCredentialVerifier(secret),
        operatorRef: 'operator:test',
        at: '2026-10-01T00:00:00.000Z',
        idempotencyKey: key,
        requestDigest: `sha256:${key}`,
      });
      return formatAgentCredential(credentialId, secret);
    };
    // A control-plane row (as a tampered file could hold) claiming the agent's subject for a different actor.
    const forged = await issue('actor-impostor', 'forged-binding-0001');
    const refusedForged = await admission.admit({ authorizationHeader: `Bearer ${forged}` });
    assert.equal(refusedForged.status, 'unavailable');
    assert.equal((await admission.admit({ authorizationHeader: 'Bearer fra1.agc-00000000000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status, 'refused');
  });

  it('every write reaches the provisioning service under the served organization and the authenticated operator — never a caller value', async () => {
    const h = await harness();
    await world(h);
    await h.service.provisionAuthorityEntity(auth('provisioner'), 'passport', reader(validBody('passport')));
    await h.service.provisionAuthorityEntity(auth('organization-administrator'), 'trust-domain', reader(validBody('trust-domain', '9')));
    assert.deepEqual(h.writes, [
      { system: true, organizationId: ORG, actorId: 'operator:ops-provisioner' },
      { system: true, organizationId: ORG, actorId: 'operator:ops-organization-administrator' },
    ]);
    for (const record of await h.store.listRecords({ system: false, organizationId: ORG }, { organizationId: ORG })) assert.equal(record.organizationId, ORG);
  });
});

// =====================================================================================
// 3. The provisioning matrix
// =====================================================================================

const KINDS = ['actor', 'trust-domain', 'root-issuer', 'passport', 'capability-token', 'authority-grant', 'delegation-grant'] as const;
const REVOCABLE = new Set(['actor', 'passport', 'capability-token', 'authority-grant', 'delegation-grant']);
const operatorFor = (kind: string): Caller => (kind === 'trust-domain' || kind === 'root-issuer' ? 'organization-administrator' : 'provisioner');

describe('CTRL-02 provisioning matrix — every exposed kind, through the existing provisioning service and its append rules', () => {
  for (const kind of KINDS) {
    const who = operatorFor(kind);
    it(`${kind}: valid create → provisioned, attributed, and readable`, async () => {
      const h = await harness();
      await world(h);
      await prerequisites(h, kind);
      const body = validBody(kind);
      const result = await h.service.provisionAuthorityEntity(auth(who), kind, reader(body));
      assert.equal(result.outcome, 'provisioned');
      assert.equal(result.entity.entityId, idOf(kind, body));
      assert.equal(result.entity.provisionedBy, `operator:ops-${who}`);
      assert.equal(result.entity.organizationId, ORG);
      assert.equal(JSON.stringify(result).includes('latestEventDigest'), false, 'no store digest is serialized');
    });

    it(`${kind}: the same body again → replayed, no second event; changed terms under the same id → refused, never rewritten`, async () => {
      const h = await harness();
      await world(h);
      await prerequisites(h, kind);
      const body = validBody(kind);
      await h.service.provisionAuthorityEntity(auth(who), kind, reader(body));
      assert.equal((await h.service.provisionAuthorityEntity(auth(who), kind, reader(body))).outcome, 'replayed');
      const events = await h.store.listEvents({ system: false, organizationId: ORG }, ORG, kind, idOf(kind, body));
      assert.equal(events.length, 1);
      const changed = kind === 'root-issuer' ? undefined : { ...body, ...(kind === 'actor' ? { displayName: 'Changed' } : kind === 'trust-domain' ? { name: 'Changed' } : kind === 'passport' ? { type: 'human_passport' } : { capability: 'changed.capability' }) };
      if (changed !== undefined) {
        const conflict = await httpError(h.service.provisionAuthorityEntity(auth(who), kind, reader(changed)));
        assert.equal(conflict.httpStatus, 409);
        assert.equal((conflict.extra as Record<string, unknown> | undefined)?.['failure'], 'KERNEL_AUTHORITY_ENTITY_CONFLICT');
      }
      assert.equal((await h.store.listEvents({ system: false, organizationId: ORG }, ORG, kind, idOf(kind, body))).length, 1);
    });

    it(`${kind}: idempotency — same key + same body replays; same key + different authority conflicts; concurrent same key commits once`, async () => {
      const h = await harness();
      await world(h);
      await prerequisites(h, kind);
      const body = { ...validBody(kind), idempotencyKey: `idem-${kind}-0001` };
      const results = await Promise.all(Array.from({ length: 8 }, () => h.service.provisionAuthorityEntity(auth(who), kind, reader(body))));
      assert.equal(results.filter((result) => result.outcome === 'provisioned').length, 1);
      assert.equal(results.filter((result) => result.outcome === 'replayed').length, 7);
      const other = { ...validBody(kind, '2'), idempotencyKey: `idem-${kind}-0001` };
      const conflict = await httpError(h.service.provisionAuthorityEntity(auth(who), kind, reader(other)));
      assert.equal(conflict.httpStatus, 409);
      assert.equal(conflict.code, 'OPERATOR_IDEMPOTENCY_CONFLICT');
      assert.equal(await h.store.getRecord({ system: false, organizationId: ORG }, ORG, kind, idOf(kind, other)), null, 'the conflicting authority was not written');
    });

    it(`${kind}: malformed id, unknown field, forged provenance and a non-object body are refused before any write`, async () => {
      const h = await harness();
      await world(h);
      await prerequisites(h, kind);
      const body = validBody(kind);
      const idField = kind === 'root-issuer' ? 'actorId' : Object.keys(body)[0] ?? 'x';
      for (const bad of [
        { ...body, [idField]: ' padded' },
        { ...body, [idField]: 'has space' },
        { ...body, [idField]: 'x'.repeat(200) },
        { ...body, unexpected: true },
        { ...body, provisionedBy: 'operator:someone-else' },
        { ...body, organizationId: FOREIGN },
        { ...body, system: true },
        [],
        'not-an-object',
        null,
      ]) {
        assert.equal((await httpError(h.service.provisionAuthorityEntity(auth(who), kind, reader(bad)))).httpStatus, 400, JSON.stringify(bad).slice(0, 80));
      }
      assert.equal(h.mutations.count, 0);
    });

    if (REVOCABLE.has(kind)) {
      it(`${kind}: a revoked id is never provisioned again — revocation is terminal`, async () => {
        const h = await harness();
        await world(h);
        await prerequisites(h, kind);
        const body = kind === 'actor' ? validBody(kind) : validBody(kind);
        await h.service.provisionAuthorityEntity(auth(who), kind, reader(body));
        await h.admin.revokeAuthorityEntity(auth('responder'), kind, idOf(kind, body), reader({ reason: 'test' }));
        const again = await httpError(h.service.provisionAuthorityEntity(auth(who), kind, reader(body)));
        assert.equal(again.httpStatus, 409);
        assert.equal((again.extra as Record<string, unknown> | undefined)?.['failure'], 'KERNEL_AUTHORITY_ENTITY_REVOKED');
        const record = await h.store.getRecord({ system: false, organizationId: ORG }, ORG, kind, idOf(kind, body));
        assert.equal(record?.status, 'revoked');
      });
    }

    it(`${kind}: store unavailable → 503, integrity failure → 500, never success`, async () => {
      for (const [code, status] of [
        ['KERNEL_AUTHORITY_STORE_UNAVAILABLE', 503],
        ['KERNEL_AUTHORITY_INTEGRITY_FAILED', 500],
      ] as const) {
        const base = createInMemoryKernelAuthorityStore();
        const failing: KernelAuthorityStore = { ...base, appendEvent: () => Promise.reject(new KernelAuthorityError(code, 'simulated')) };
        const h = await harness({ store: failing });
        await (async () => {
          // The world is provisioned on the underlying store, which the failing wrapper shares for reads.
          const direct = createKernelAuthorityProvisioningService({ store: base, organizationId: ORG });
          await direct.provisionActor(BOOT, { actorId: 'actor-org', type: 'organization', displayName: 'Org' });
          await direct.provisionTrustDomain(BOOT, { trustDomainId: TD, name: 'TD', issuerActorId: 'actor-org', acceptedIssuerIds: ['actor-org'], acceptedActorTypes: ['human', 'agent', 'organization'] });
          await direct.provisionRootIssuer(BOOT, { trustDomainId: TD, actorId: 'actor-org' });
          await direct.provisionActor(BOOT, { actorId: 'actor-owner', type: 'human', displayName: 'Owner', issuerId: 'actor-org', trustDomainId: TD });
          await direct.provisionActor(BOOT, { actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD, externalSubject: { system: 'app', subjectId: 'agent-1' } });
          if (kind === 'root-issuer') await direct.provisionTrustDomain(BOOT, validBody('trust-domain') as never);
          if (kind === 'delegation-grant') await direct.provisionAuthorityGrant(BOOT, { ...validBody('authority-grant'), authorityGrantId: 'grant-base' } as never);
        })();
        const error = await httpError(h.service.provisionAuthorityEntity(auth(who), kind, reader(validBody(kind))));
        assert.equal(error.httpStatus, status, code);
      }
    });
  }

  it('an unknown entity kind, and a bounded grant, are not provisionable', async () => {
    const h = await harness();
    await world(h);
    for (const kind of ['bounded-grant', 'grant', 'BoundedGrant', 'policy', 'approval']) {
      assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('organization-administrator'), kind, reader({})))).httpStatus, 400, kind);
    }
    assert.equal(h.mutations.count, 0);
  });

  it('references the engines cannot replay are refused before they are written — the world stays bootable', async () => {
    const h = await harness();
    await world(h);
    for (const [kind, body] of [
      ['passport', { ...validBody('passport'), subjectActorId: 'actor-missing' }],
      ['capability-token', { ...validBody('capability-token'), subjectActorId: 'actor-missing' }],
      ['delegation-grant', { ...validBody('delegation-grant'), sourceAuthorityGrantId: 'grant-missing' }],
      ['authority-grant', { ...validBody('authority-grant'), parentGrantId: 'grant-missing' }],
      ['authority-grant', { ...validBody('authority-grant'), subjectActorId: 'actor-missing' }],
      ['authority-grant', { ...validBody('authority-grant'), trustDomainId: 'td-missing' }],
      ['actor', { ...validBody('actor'), trustDomainId: 'td-missing' }],
      ['root-issuer', { trustDomainId: TD, actorId: 'actor-missing' }],
    ] as const) {
      const error = await httpError(h.service.provisionAuthorityEntity(auth(operatorFor(kind)), kind, reader(body)));
      assert.equal(error.httpStatus, 409, kind);
      assert.equal(error.code, 'OPERATOR_OPERATION_REFUSED');
      assert.equal(await h.store.getRecord({ system: false, organizationId: ORG }, ORG, kind, idOf(kind, body)), null);
    }
    assert.equal(h.mutations.count, 0);
  });

  it('a revoked actor is never re-authorized: authority naming it is refused, and a revoked agent is never re-onboarded under its id', async () => {
    const h = await harness();
    await world(h);
    await h.admin.revokeAuthorityEntity(auth('responder'), 'actor', 'actor-agent', reader({ reason: 'offboarded' }));
    h.mutations.count = 0;
    for (const kind of ['passport', 'capability-token'] as const) {
      const error = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), kind, reader(validBody(kind))));
      assert.equal(error.httpStatus, 409);
      assert.equal((error.extra as Record<string, unknown> | undefined)?.['failure'], 'KERNEL_AUTHORITY_REFERENCE_REVOKED');
    }
    const again = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'actor', reader({ actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD, externalSubject: { system: 'app', subjectId: 'agent-1' } })));
    assert.equal((again.extra as Record<string, unknown> | undefined)?.['failure'], 'KERNEL_AUTHORITY_ENTITY_REVOKED');
    // A new identity under the same external subject is refused too: the subject stays bound to the revoked actor.
    const rebind = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'actor', reader({ actorId: 'actor-agent-2', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD, externalSubject: { system: 'app', subjectId: 'agent-1' } })));
    assert.equal((rebind.extra as Record<string, unknown> | undefined)?.['failure'], 'KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT');
    assert.equal((await httpError(h.service.issueAgentCredential(auth('provisioner'), 'actor-agent', reader({ idempotencyKey: 'revoked-credential-1' })))).httpStatus, 409);
  });

  it('monetary authority: an unknown asset, an over-scale value, a malformed or widening constraint shape are refused before commit', async () => {
    const h = await harness();
    await world(h);
    for (const constraints of [
      [{ type: 'max_amount', currency: 'EUR', value: '100' }],
      [{ type: 'max_amount', currency: 'USD', value: '100.001' }],
      [{ type: 'max_amount', currency: 'USD', value: '-5' }],
      [{ type: 'max_amount', currency: 'USD', value: '0' }],
      [{ type: 'max_amount', currency: 'USD', value: '100', scale: 2 }],
      [{ type: 'max_amount', currency: 'USD', value: 100 }],
      [{ type: 'spending_limit', limitId: 'x', currency: 'USD', maximum: '10', window: { kind: 'rolling', seconds: 0 } }],
      [{ type: 'spending_limit', limitId: 'x', currency: 'USD', maximum: '10', window: { kind: 'lifetime' }, used: '0' }],
      [{ type: 'time_window', start: 'x' }],
      [],
      'unbounded',
    ]) {
      const error = await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'authority-grant', reader({ ...validBody('authority-grant'), constraints })));
      assert.equal(error.httpStatus, 400, JSON.stringify(constraints));
    }
    // Constraints only on grants: a passport or token stating one is refused by the closed schema.
    assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'capability-token', reader({ ...validBody('capability-token'), constraints: [{ type: 'max_amount', currency: 'USD', value: '1' }] })))).httpStatus, 400);
    // The asset and scale checks are the provisioning service's own (the trusted registry); either way nothing committed.
    assert.equal(await h.store.getRecord({ system: false, organizationId: ORG }, ORG, 'authority-grant', 'grant-1'), null);
    assert.equal((await h.store.listRecords({ system: false, organizationId: ORG }, { organizationId: ORG, entityKind: 'authority-grant' })).length, 0);
  });

  it('typed governed parameters have one authority model: runtime values, a second bound shape or policy disguised as authority are refused, not ignored', async () => {
    const h = await harness();
    await world(h);
    for (const field of ['parameters', 'maximum', 'spendingLimit', 'limits', 'parameterLimits', 'scope', 'policy']) {
      assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'authority-grant', reader({ ...validBody('authority-grant'), [field]: [{ dimension: 'replicaCount', maximum: 3 }] })))).httpStatus, 400, field);
    }
    // `parameterBounds` is the one standing parameter-authority field, and only in the canonical CORE-03 shape.
    for (const bounds of [[{ dimension: 'replicaCount', maximum: 3 }], [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3, value: 3 }], [{ dimension: 'replicaCount', kind: 'range', type: 'integer', limit: 3 }]]) {
      assert.equal((await httpError(h.service.provisionAuthorityEntity(auth('provisioner'), 'authority-grant', reader({ ...validBody('authority-grant'), parameterBounds: bounds })))).httpStatus, 400);
    }
    assert.equal(h.mutations.count, 0);
  });
});
