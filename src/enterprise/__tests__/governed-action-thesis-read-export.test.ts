import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { all, predicate } from '../../features/domain-policy-pack-runtime/packs/policy-pack-builders.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import type { PolicyPredicateCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import { GRANT_EXERCISE_REASON_CODES as E, type GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { GRANT_REASON_CODES, GRANT_SEMANTICS_FORMAT_V1, createInMemoryBoundedGrantStore, type BoundedGrant, type BoundedGrantStorePort, type RequestedGrantBounds } from '../../features/grant-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { GovernedActionGrantPolicyQuery } from '../governed-action/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import {
  APPROVED_DESTINATION,
  CUSTOMER_DATA,
  DEPLOY_ACTION,
  EXPORT_ACTION,
  PAYMENT_ACTION,
  PRODUCTION_ENVIRONMENT,
  READ_ACTION,
  SEMANTIC_CONFIGURATION,
  TREASURY,
} from './governed-action-semantics-fixture.js';

/** NB-008: the trusted policy author these tests write as. */
const POLICY_WRITER = { system: true, actorId: 'operator:policy-pack-test' } as const;

/**
 * CORE-03 §24 / §52 — **the same resource, two materially different actions,
 * governed differently — by policy and profile semantics alone.**
 *
 * ```
 * customer ─ governAction ─ envelope (typed parameters, trusted profile) ─ Kernel (policy pack)
 *          ─ committed decision ─ BoundedGrant (profile + parameter bounds) ─ exercise ─ adapter
 * ```
 *
 * One `createEnterprise()` composition — the same composition root the
 * shipped Host boots — with **one** Kernel, **one** grant store, **one**
 * orchestrator and **one** adapter for every case. The deployment's
 * difference between `read` and `export` over `customer-data-example` lives
 * only in data: Governance Profiles and a real `PolicyPackRuntime` whose rules
 * read `actionClass`, `governanceProfile` and typed `parameter` fields. No
 * Kernel, orchestrator, grant or exercise code knows what "read", "export",
 * "customer", "deploy" or "production" mean (`governed-action-neutrality-structure.test.ts`).
 *
 * Synthetic fixtures only. No real customer data exists here.
 */

const ORG = 'org-a';
const TRUST_DOMAIN = 'trust-domain-a';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const SUBJECT = { system: 'core-03-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_CORE03_READ_EXPORT_API_KEY_SENTINEL_VALUE';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-a', externalSubject: SUBJECT } }];

const NO_TEMPORAL_BOUND: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'Durable Kernel Authority.' };

const ACTIONS = [READ_ACTION, EXPORT_ACTION, DEPLOY_ACTION, PAYMENT_ACTION];
const RESOURCES = [CUSTOMER_DATA, PRODUCTION_ENVIRONMENT, TREASURY];

// ---------------------------------------------------------------------------
// The organization's deterministic policy — data, not code.

const VERSION_ID = 'policy-pack-core03-customer-data-v1';
function parameterPredicate(parameterId: string, operator: PolicyPredicateCondition['operator'], value: unknown): PolicyPredicateCondition {
  return { type: 'predicate', field: 'parameter', parameterId, operator, value };
}
function rule(id: string, priority: number, condition: PolicyPackRule['condition'], effect: PolicyPackRule['effect']): PolicyPackRule {
  return { id, policyPackVersionId: VERSION_ID, name: id, description: id, status: 'active', priority, condition, effect, obligations: [], evidenceRequirements: [], approvalRequirements: [], severity: 'error', sourceIds: ['core03-source'] };
}
const RULES: readonly PolicyPackRule[] = [
  rule('read-volume-limit', 100, all(predicate('actionClass', 'equals', 'read'), parameterPredicate('recordCount', 'greater_than', 1000)), {
    type: 'deny',
    reasonCode: 'READ_VOLUME_EXCEEDS_POLICY',
    reason: 'A read may disclose at most 1000 records.',
  }),
  rule('export-volume-limit', 100, all(predicate('actionClass', 'equals', 'export'), parameterPredicate('recordCount', 'greater_than', 100)), {
    type: 'deny',
    reasonCode: 'EXPORT_VOLUME_EXCEEDS_POLICY',
    reason: 'An export may move at most 100 records.',
  }),
  rule('export-destination-review', 200, all(predicate('actionClass', 'equals', 'export'), parameterPredicate('destination', 'not_in', [APPROVED_DESTINATION])), {
    type: 'require_approval',
    reasonCode: 'EXPORT_DESTINATION_REQUIRES_REVIEW',
    reason: 'An export to an unapproved destination requires review.',
  }),
  rule('deploy-requires-rollback', 100, all(predicate('governanceProfile', 'equals', 'production-deploy'), parameterPredicate('rollbackAvailable', 'not_equals', true)), {
    type: 'deny',
    reasonCode: 'DEPLOY_WITHOUT_ROLLBACK',
    reason: 'A production deployment requires rollback to be available.',
  }),
];

function policyPackProvider(): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'policy-pack-core03-customer-data', name: 'CORE-03 proof policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: VERSION_ID,
    policyPackId: 'policy-pack-core03-customer-data',
    version: '1.0.0',
    scope: { resourceScopes: RESOURCES },
    rules: RULES,
    sources: [{ id: 'core03-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, VERSION_ID);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

// ---------------------------------------------------------------------------
// One Host.

const directories: string[] = [];
const enterprises: AocEnterprise[] = [];
const stores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

interface Host {
  readonly enterprise: AocEnterprise;
  readonly adapter: ReturnType<typeof createRecordingExecutionAdapter>;
  readonly grants: BoundedGrant[];
  readonly kernelRequests: string[];
}

async function provision(service: KernelAuthorityProvisioningService): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.issuerActor);
  await service.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
  await service.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'core-03-app', subjectId: 'owner-a' } });
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: SUBJECT });
  await service.provisionPassport(DURABLE_FIXTURE_OPERATOR, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(DURABLE_FIXTURE_OPERATOR, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: ACTIONS, resourceScopes: RESOURCES });
  await service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.authorityGrant,
    authorityGrantId: 'authority-grant-owner-a',
    subjectActorId: OWNER,
    actions: ACTIONS,
    resourceScopes: RESOURCES,
    // P10: money needs a per-execution ceiling and a durable spending limit;
    // neither says anything about the non-financial actions beside it.
    constraints: [
      { type: 'max_amount', currency: 'USD', value: '100' },
      { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '1000', window: { kind: 'lifetime' } },
    ],
  });
  await service.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent-a',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner-a',
    actions: ACTIONS,
    resourceScopes: RESOURCES,
  });
}

async function openHost(options: { readonly narrowing?: (query: GovernedActionGrantPolicyQuery) => RequestedGrantBounds | undefined } = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-core03-'));
  directories.push(dir);
  const authorityStore = await createSqliteKernelAuthorityStore(join(dir, 'kernel-authority.sqlite'));
  stores.push(authorityStore);
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
  });
  const grants: BoundedGrant[] = [];
  const raw = createInMemoryBoundedGrantStore();
  const grantStore: BoundedGrantStorePort = {
    async issue(input) {
      const outcome = await raw.issue(input);
      if (outcome.outcome === 'issued') grants.push(outcome.grant);
      return outcome;
    },
    read: (grantId) => raw.read(grantId),
    revoke: (input) => raw.revoke(input),
  };
  const adapter = createRecordingExecutionAdapter();
  const enterprise = await createEnterprise({
    configuration: { ...base, authentication: { apiKeys: KEYS } },
    kernelAuthorityStore: authorityStore,
    policyPackProvider: policyPackProvider(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore,
      executionAdapter: adapter,
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
      exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND },
    },
    governedActionOrchestrator: {
      enabled: true,
      trustDomainId: TRUST_DOMAIN,
      grantPolicy: (query) => {
        const requestedBounds = options.narrowing?.(query);
        return { grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + 10 * 60 * 1000).toISOString(), ...(requestedBounds !== undefined ? { requestedBounds } : {}) };
      },
    },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [PAYMENT_ACTION] },
    governance: SEMANTIC_CONFIGURATION,
  });
  enterprises.push(enterprise);
  assert.ok(enterprise.kernelAuthorityProvisioning !== undefined);
  await provision(enterprise.kernelAuthorityProvisioning);
  return { enterprise, adapter, grants, kernelRequests: [] };
}

interface Reply {
  readonly status: string;
  readonly withheldBy?: string;
  readonly reasonCodes: readonly string[];
  readonly requestId?: string;
  readonly decision?: { readonly status: string; readonly evaluationId: string; readonly reasonCodes: readonly string[] };
}

let sequence = 0;
async function govern(host: Host, intent: Record<string, unknown>): Promise<Reply> {
  assert.ok(host.enterprise.governAction !== undefined);
  const reply = await host.enterprise.governAction({ idempotencyKey: `core03-${(sequence += 1)}`, ...intent }, { authorizationHeader: `Bearer ${SECRET}` });
  return reply.body as Reply;
}

const read = (recordCount: unknown) => ({ action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount } });
const exportTo = (recordCount: number, destination: string) => ({ action: EXPORT_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount, destination } });

async function committedRequestPayload(host: Host, reply: Reply): Promise<Record<string, unknown>> {
  assert.ok(reply.decision !== undefined);
  const record = await host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG, actorId: AGENT }, reply.decision.evaluationId);
  assert.ok(record !== null);
  return record.request.requestPayload as Record<string, unknown>;
}

/** The committed evaluation's result payload, serialized — where the policy layer's own rule evidence lives. */
async function committedResult(host: Host, reply: Reply): Promise<string> {
  assert.ok(reply.decision !== undefined);
  const record = await host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG, actorId: AGENT }, reply.decision.evaluationId);
  assert.ok(record !== null);
  return JSON.stringify(record.evaluation.resultPayload);
}

// ---------------------------------------------------------------------------

describe('CORE-03 §52 — same resource, read vs export, governed differently by policy + profile alone', () => {
  it('read 50 records: allowed, bounded, executed — and the committed decision records the classification', async () => {
    const host = await openHost();
    const reply = await govern(host, read(50));
    assert.equal(reply.status, 'executed', JSON.stringify(reply));
    assert.equal(host.adapter.callCount, 1);
    assert.deepEqual([host.adapter.calls[0]?.action, host.adapter.calls[0]?.resource], [READ_ACTION, CUSTOMER_DATA]);

    const grant = host.grants[0];
    assert.ok(grant !== undefined);
    assert.match(grant.scope.governanceProfile?.kind === 'identity' ? grant.scope.governanceProfile.value : '', /^customer-data-read@1#sha256:[0-9a-f]{64}$/, 'the grant is bound to the profile that governed it');
    assert.deepEqual(grant.scope.parameters, [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 50 }], 'the grant bounds exactly what the decision evaluated');
    assert.deepEqual(grant.scope.resources, { kind: 'set', values: [CUSTOMER_DATA] });
    assert.deepEqual([grant.scope.actionClass, grant.scope.resourceClass], [{ kind: 'identity', value: 'read' }, { kind: 'identity', value: 'customer_dataset' }], 'classes are explicit, signed axes');
    assert.equal(grant.semanticsFormat, GRANT_SEMANTICS_FORMAT_V1, 'the explicit semantic format marker');

    const payload = await committedRequestPayload(host, reply);
    const action = payload['action'] as { semantics: { actionClass: string; resourceClass: string; governanceProfile: { id: string; version: number } }; governedParameters: unknown };
    assert.deepEqual([action.semantics.actionClass, action.semantics.resourceClass, action.semantics.governanceProfile.id, action.semantics.governanceProfile.version], ['read', 'customer_dataset', 'customer-data-read', 1]);
    assert.deepEqual(action.governedParameters, [{ dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 50 }]);
  });

  it('export 50 records to the approved destination: allowed, bounded by both dimensions, executed', async () => {
    const host = await openHost();
    const reply = await govern(host, exportTo(50, APPROVED_DESTINATION));
    assert.equal(reply.status, 'executed', JSON.stringify(reply));
    assert.deepEqual(host.grants[0]?.scope.parameters, [
      { dimension: 'destination', kind: 'exact', type: 'token', value: APPROVED_DESTINATION },
      { dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 50 },
    ]);
  });

  it('500 records: a read is allowed, an export of the same resource is denied — policy on actionClass + typed parameter', async () => {
    const host = await openHost();
    const readReply = await govern(host, read(500));
    const exportReply = await govern(host, exportTo(500, APPROVED_DESTINATION));
    assert.equal(readReply.status, 'executed', JSON.stringify(readReply));
    assert.equal(exportReply.status, 'denied', JSON.stringify(exportReply));
    assert.deepEqual([...exportReply.reasonCodes], ['DOMAIN_POLICY_DENIED', 'POLICY_ACTION_PROHIBITED']);
    assert.ok((await committedResult(host, exportReply)).includes('EXPORT_VOLUME_EXCEEDS_POLICY'), 'the committed decision records the export rule that decided');
    assert.equal((await committedResult(host, readReply)).includes('READ_VOLUME_EXCEEDS_POLICY'), false, 'the read rule never fired for 500');
    assert.equal(host.adapter.callCount, 1, 'only the read reached the adapter');
    assert.equal(host.grants.length, 1, 'no grant exists for the denied export');
  });

  it('5000 records: the read is denied too — its own, higher limit', async () => {
    const host = await openHost();
    const reply = await govern(host, read(5000));
    assert.equal(reply.status, 'denied', JSON.stringify(reply));
    assert.equal(host.adapter.callCount, 0);
    assert.equal(host.grants.length, 0);
  });

  it('an export to an unapproved destination is withheld for approval — a requirement the read profile never has', async () => {
    const host = await openHost();
    const reply = await govern(host, exportTo(10, 'unvetted-bucket'));
    assert.equal(reply.status, 'withheld', JSON.stringify(reply));
    assert.equal(reply.withheldBy, 'approval');
    assert.equal(reply.decision?.status, 'approval_required');
    assert.equal(host.adapter.callCount, 0);
  });

  it('the same Kernel, grant store, orchestrator and adapter served every case above in one Host', async () => {
    const host = await openHost();
    const statuses = [];
    for (const intent of [read(50), exportTo(50, APPROVED_DESTINATION), exportTo(500, APPROVED_DESTINATION), exportTo(10, 'unvetted-bucket'), read(5000)]) {
      statuses.push((await govern(host, intent)).status);
    }
    assert.deepEqual(statuses, ['executed', 'executed', 'denied', 'withheld', 'denied']);
    assert.equal(host.adapter.callCount, 2);
    assert.deepEqual(new Set(host.grants.map((grant) => grant.correlation.resourceScope)), new Set([CUSTOMER_DATA]), 'one resource throughout');
  });
});

describe('CORE-03 — profile substitution: the caller hints, the server decides', () => {
  it('a substituted, more permissive profile id/version is refused; the valid follow-up commits and binds the real profile id, version and digest', async () => {
    const host = await openHost();
    const effective = createGovernanceProfileRegistry(SEMANTIC_CONFIGURATION).resolve(READ_ACTION, CUSTOMER_DATA);
    assert.equal(effective.kind, 'resolved');
    if (effective.kind !== 'resolved') return;

    for (const substitute of [{ id: 'customer-data-export', version: 2 }, { id: 'customer-data-read', version: 2 }, { id: 'customer-data-read', version: 0 }]) {
      const refused = await govern(host, { ...read(50), expectedGovernanceProfile: substitute });
      assert.equal(refused.status, 'rejected', JSON.stringify(substitute));
      assert.equal(refused.decision, undefined, 'no decision is committed under any profile');
    }
    assert.equal(host.grants.length, 0);

    const followUp = await govern(host, read(50));
    assert.equal(followUp.status, 'executed', JSON.stringify(followUp));
    const committed = (await committedRequestPayload(host, followUp))['action'] as { semantics: { governanceProfile: { id: string; version: number; digest: string } } };
    assert.deepEqual(committed.semantics.governanceProfile, effective.profile.reference, 'the decision records the effective profile');
    assert.equal(
      host.grants[0]?.scope.governanceProfile?.kind === 'identity' ? host.grants[0].scope.governanceProfile.value : undefined,
      `${effective.profile.reference.id}@${effective.profile.reference.version}#${effective.profile.reference.digest}`,
      'the grant binds the effective profile',
    );
  });
});

describe('CORE-03 §54 — envelope refusals on the real path: missing, wrong type, undeclared, unprofiled', () => {
  it('each is rejected before the Kernel runs: no decision, no grant, no adapter', async () => {
    const host = await openHost();
    for (const intent of [
      { action: READ_ACTION, resource: CUSTOMER_DATA },
      read('50'),
      read(null),
      { ...read(50), parameters: { recordCount: 50, destination: 'x' } },
      { ...read(50), parameters: { recordCount: 50, RecordCount: 1000000 } },
      { ...read(50), assertedContext: { recordCount: 1000000 } },
      { ...read(50), expectedGovernanceProfile: { id: 'customer-data-export', version: 2 } },
      { action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '10', currency: 'USD' }, parameters: { recordCount: 1 } },
    ]) {
      const reply = await govern(host, intent);
      assert.equal(reply.status, 'rejected', JSON.stringify(intent));
      assert.equal(reply.decision, undefined);
    }
    assert.equal(host.grants.length, 0);
    assert.equal(host.adapter.callCount, 0);
  });
});

describe('CORE-03 §73 — a read grant cannot be exercised as an export, over another resource, above its bound, or under another profile', () => {
  it('ACE refuses every substitution of a real, issued read grant; the adapter is never reached', async () => {
    const host = await openHost();
    assert.equal((await govern(host, read(50))).status, 'executed');
    const grant = host.grants[0];
    const ace = host.enterprise.authorityControlledExecution;
    assert.ok(grant !== undefined && ace !== undefined);
    const profile = grant.scope.governanceProfile?.kind === 'identity' ? grant.scope.governanceProfile.value : '';
    const genuine: GrantExerciseRequest = {
      boundedGrantId: grant.id,
      subject: AGENT,
      action: READ_ACTION,
      resource: CUSTOMER_DATA,
      organization: ORG,
      governanceProfile: profile,
      actionClass: 'read',
      resourceClass: 'customer_dataset',
      parameters: [{ dimension: 'recordCount', type: 'integer', value: 50 }],
      correlation: grant.correlation,
      executionId: 'exec-substitution',
    };
    assert.equal((await ace.assessExercise(genuine)).usable, true, 'the genuine attempt is within the grant');

    const cases: readonly [string, GrantExerciseRequest, string][] = [
      ['action substitution (read → export)', { ...genuine, action: EXPORT_ACTION }, E.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE],
      ['resource substitution', { ...genuine, resource: 'all-customer-records' }, E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE],
      ['over the parameter bound', { ...genuine, parameters: [{ dimension: 'recordCount', type: 'integer', value: 51 }] }, E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
      ['a smuggled extra dimension', { ...genuine, parameters: [{ dimension: 'destination', type: 'token', value: 'x' }, { dimension: 'recordCount', type: 'integer', value: 50 }] }, E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
      ['profile substitution', { ...genuine, governanceProfile: profile.replace('customer-data-read@1', 'customer-data-export@2') }, E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH],
      ['action-class substitution (read → export)', { ...genuine, actionClass: 'export' }, E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH],
      ['resource-class substitution', { ...genuine, resourceClass: 'public_dataset' }, E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH],
    ];
    for (const [name, attempt, code] of cases) {
      const assessment = await ace.assessExercise(attempt);
      assert.equal(assessment.usable, false, name);
      assert.ok(assessment.reasonCodes.includes(code as never), `${name}: ${JSON.stringify(assessment.reasonCodes)}`);
      const outcome = await ace.exercise({ ...attempt, executionId: `exec-${name.replace(/\W+/g, '-')}` });
      assert.equal(outcome.status, 'withheld', name);
    }
    assert.equal(host.adapter.callCount, 1, 'only the original governed read ever reached the adapter');
  });
});

describe('CORE-03 §54 — host narrowing of a non-money bound through the production grant path', () => {
  it('a narrower host bound (recordCount <= 10) issues, and the over-bound exercise is withheld before the adapter is called', async () => {
    const host = await openHost({ narrowing: (query) => (query.action === READ_ACTION ? { parameters: [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 10 }] } : undefined) });
    const within = await govern(host, read(10));
    assert.equal(within.status, 'executed', JSON.stringify(within));
    const over = await govern(host, read(50));
    assert.equal(over.status, 'withheld', JSON.stringify(over));
    assert.equal(over.withheldBy, 'exercise');
    assert.deepEqual([...over.reasonCodes], [E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE]);
    assert.equal(over.decision?.status, 'allowed', 'the decision stands exactly as committed; the grant is what is narrower');
    assert.equal(host.adapter.callCount, 1);
  });

  it('a host "narrowing" that is really a widening (recordCount <= 100000) is refused: no grant issues', async () => {
    const host = await openHost({ narrowing: () => ({ parameters: [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 100000 }] }) });
    const reply = await govern(host, read(50));
    assert.equal(reply.status, 'withheld', JSON.stringify(reply));
    assert.equal(reply.withheldBy, 'grant');
    assert.deepEqual([...reply.reasonCodes], [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    assert.equal(host.grants.length, 0);
    assert.equal(host.adapter.callCount, 0);
  });
});

describe('CORE-03 §25 — a second non-financial shape (deploy × production environment) and money, on the same Host', () => {
  it('deploy with rollback available executes; without rollback it is denied by policy', async () => {
    const host = await openHost();
    const ok = await govern(host, { action: DEPLOY_ACTION, resource: PRODUCTION_ENVIRONMENT, parameters: { releaseVersion: '1.4.2', rollbackAvailable: true } });
    const unsafe = await govern(host, { action: DEPLOY_ACTION, resource: PRODUCTION_ENVIRONMENT, parameters: { releaseVersion: '1.4.3', rollbackAvailable: false } });
    assert.equal(ok.status, 'executed', JSON.stringify(ok));
    assert.equal(unsafe.status, 'denied', JSON.stringify(unsafe));
    assert.deepEqual(host.grants[0]?.scope.parameters, [
      { dimension: 'releaseVersion', kind: 'exact', type: 'token', value: '1.4.2' },
      { dimension: 'rollbackAvailable', kind: 'exact', type: 'boolean', value: true },
    ]);
  });

  it('an unprofiled financial action keeps its exact P9 amount and its P10 authority ceiling, unchanged', async () => {
    const host = await openHost();
    const paid = await govern(host, { action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '75.50', currency: 'USD' } });
    const over = await govern(host, { action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '100.01', currency: 'USD' } });
    assert.equal(paid.status, 'executed', JSON.stringify(paid));
    assert.deepEqual(host.adapter.calls[0]?.amount, { value: '75.5', unit: 'USD' }, 'exact canonical decimal text');
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' }, 'the ceiling is the authority’s, never the request’s');
    assert.equal(host.grants[0]?.scope.governanceProfile, undefined, 'money is not forced through a profile');
    assert.equal(host.grants[0]?.scope.parameters, undefined);
    assert.equal(over.status, 'withheld');
    assert.equal(over.withheldBy, 'authority-binding');
  });
});
