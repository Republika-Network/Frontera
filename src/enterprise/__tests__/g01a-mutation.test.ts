import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import type { CustomerIdentityAdmissionService } from '../customer-identity/contracts.js';
import { GOVERNANCE_ATTRIBUTION_EVENT_TYPE, GOVERNANCE_ATTRIBUTION_VERSION, type GovernanceEvaluationAttribution, type GovernanceRecord } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { EvaluateGovernanceRequestDependencies } from '../orchestration/evaluate-governance-request.js';
import { ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01A — mutation qualification of the identity-binding and replay
 * invariants. Each mutant edits one compiled module at one site; its guard
 * must hold for the shipped module and must detect the mutant. Together they
 * show that every check the advisory route depends on is load-bearing:
 *
 * - identity binding: the bound actor, the stated organization, the service
 *   allow-list, the trusted trust domain, the restricted legacy mode, and a
 *   scoped legacy key's tenant (not system) scope;
 * - replay: principal equality, the refusal to adopt an unattributed record,
 *   and the check on both the pre-Kernel probe and the append transaction;
 * - sealing: the attribution reaches the Store, and the Store refuses one that
 *   contradicts its request.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${mutant.file}: ${search.slice(0, 100)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the mutation`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

async function refusedWith(status: number, pending: Promise<unknown> | (() => unknown)): Promise<boolean> {
  try {
    await (typeof pending === 'function' ? pending() : pending);
    return false;
  } catch (error) {
    return (error as { httpStatus?: unknown }).httpStatus === status;
  }
}

const PRINCIPAL = 'principal-g01a-mutation';
const OTHER_PRINCIPAL = 'principal-g01a-mutation-other';
const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const OTHER_ACTOR = 'actor-g01a-mutation-other';
const CUSTOMER_KEY = 'G01A_MUTATION_CUSTOMER_KEY_0123456789abcdef';
const OTHER_CUSTOMER_KEY = 'G01A_MUTATION_OTHER_KEY_0123456789abcdef0';
const BARE_KEY = 'G01A_MUTATION_BARE_KEY_0123456789abcdef012';
const SCOPED_KEY = 'G01A_MUTATION_SCOPED_KEY_0123456789abcdef0';

const KEYS: readonly EnterpriseApiKey[] = [
  { key: CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: PRINCIPAL, externalSubject: SUBJECT } },
  { key: OTHER_CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: OTHER_PRINCIPAL, externalSubject: SUBJECT } },
  { key: SCOPED_KEY, organizationId: ORG },
  { key: BARE_KEY },
];

function configuration(legacyKeyMode: 'compat' | 'restricted' = 'compat'): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_REQUIRE_AUTH: 'true', AOC_ENTERPRISE_LOG_LEVEL: 'error' });
  return { ...base, authentication: { apiKeys: KEYS, servicePrincipals: [{ principalId: 'svc-g01a-mutation', organizationId: ORG, key: 'G01A_MUTATION_SERVICE_KEY_0123456789abcde', onBehalfOfActors: [PMFREAK_ACTOR_ID] }], legacyKeyMode } };
}

let sequence = 0;
function request(overrides: Partial<KernelEvaluationRequest> = {}): KernelEvaluationRequest {
  sequence += 1;
  return {
    requestId: `g01a-mutation-${sequence}`,
    actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID },
    action: { type: 'draft_closure_email', resourceScope: 'project:closure' },
    organization: { id: ORG },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A fake admission that binds any caller to the PMFreak actor — the identity is not under test here, the checks after it are. */
const ADMISSION: CustomerIdentityAdmissionService = {
  organizationId: ORG,
  admit: async () => ({ status: 'bound', identity: { principal: { plane: 'customer', principalId: PRINCIPAL, organizationId: ORG, externalSubject: SUBJECT }, actor: { actorId: PMFREAK_ACTOR_ID } } }),
};
const IDENTITY_DEPS = { configuration: configuration(), customerIdentityAdmission: ADMISSION, trustDomainId: TRUST_DOMAIN_ID };

type IdentityModule = typeof import('../orchestration/advisory-identity.js');
type AttributionModule = typeof import('../governance-store/attribution.js');
type OrchestratorModule = typeof import('../orchestration/evaluate-governance-request.js');
type ConfigurationModule = typeof import('../configuration/enterprise-configuration.js');
type CompositionModule = typeof import('../composition/composition-root.js');
const CONFIGURATION = 'configuration/enterprise-configuration.js';
const COMPOSITION = 'composition/composition-root.js';
const IDENTITY = 'orchestration/advisory-identity.js';
const ATTRIBUTION = 'governance-store/attribution.js';
const ORCHESTRATOR = 'orchestration/evaluate-governance-request.js';

const customerAttribution = (principalId: string): GovernanceEvaluationAttribution => ({ version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: ORG, requestingPrincipalId: principalId, evaluatedActorId: PMFREAK_ACTOR_ID });

describe('G-01A mutations — identity binding', () => {
  const mutants: readonly Mutant<IdentityModule>[] = [
    {
      id: 'customer-evaluates-as-any-actor',
      file: IDENTITY,
      replacements: [['if (actorId !== actor.actorId)', 'if (false)']],
      guard: (m) => refusedWith(403, m.establishAdvisoryIdentity({ kind: 'customer', organizationId: ORG }, `Bearer ${CUSTOMER_KEY}`, request({ actor: { id: OTHER_ACTOR, trustDomainId: TRUST_DOMAIN_ID } }), IDENTITY_DEPS)),
    },
    {
      id: 'omitted-organization-is-an-implicit-match',
      file: IDENTITY,
      replacements: [['if (request.organization?.id !== organizationId) {', 'if (request.organization !== undefined && request.organization.id !== organizationId) {']],
      guard: async (m) => {
        const { organization: _omitted, ...withoutOrganization } = request();
        return refusedWith(403, m.establishAdvisoryIdentity({ kind: 'legacy', organizationId: ORG }, `Bearer ${SCOPED_KEY}`, withoutOrganization, IDENTITY_DEPS));
      },
    },
    {
      id: 'service-acts-outside-its-allow-list',
      file: IDENTITY,
      replacements: [['if (!principal.onBehalfOfActors.includes(actorId))', 'if (false)']],
      guard: (m) =>
        refusedWith(
          403,
          m.establishAdvisoryIdentity(
            { kind: 'service', principal: { principalId: 'svc', organizationId: ORG, key: 'k', onBehalfOfActors: [PMFREAK_ACTOR_ID] } },
            'Bearer k',
            request({ actor: { id: OTHER_ACTOR, trustDomainId: TRUST_DOMAIN_ID } }),
            IDENTITY_DEPS,
          ),
        ),
    },
    {
      id: 'caller-chooses-the-trust-domain',
      file: IDENTITY,
      replacements: [['if (trustDomainId === undefined || request.actor.trustDomainId !== trustDomainId) {', 'if (false) {']],
      guard: (m) => refusedWith(403, m.establishAdvisoryIdentity({ kind: 'customer', organizationId: ORG }, `Bearer ${CUSTOMER_KEY}`, request({ actor: { id: PMFREAK_ACTOR_ID, trustDomainId: 'trust-domain-attacker' } }), IDENTITY_DEPS)),
    },
    {
      id: 'unscoped-key-accepted-while-restricted',
      file: IDENTITY,
      replacements: [["if (organizationId === undefined && configuration.authentication.legacyKeyMode === 'restricted') {", 'if (false) {']],
      guard: (m) => refusedWith(403, () => m.authenticateAdvisoryCaller(`Bearer ${BARE_KEY}`, undefined, configuration('restricted'))),
    },
    {
      id: 'scoped-legacy-key-writes-as-system',
      file: IDENTITY,
      replacements: [['accessContext: { system: false, organizationId: caller.organizationId, actorId },', 'accessContext: { system: true, organizationId: caller.organizationId, actorId },']],
      guard: async (m) => (await m.establishAdvisoryIdentity({ kind: 'legacy', organizationId: ORG }, `Bearer ${SCOPED_KEY}`, request(), IDENTITY_DEPS)).accessContext.system === false,
    },
  ];
  for (const mutant of mutants) it(`${mutant.id} is detected`, () => qualify(mutant));
});

function recordWith(attribution: GovernanceEvaluationAttribution | undefined): GovernanceRecord {
  const events = attribution === undefined ? [] : [{ eventType: GOVERNANCE_ATTRIBUTION_EVENT_TYPE, eventContract: 'aoc.governance-event-record.v1', eventPayload: { attribution } }];
  return { request: { actorId: PMFREAK_ACTOR_ID, organizationId: ORG }, events } as unknown as GovernanceRecord;
}

describe('G-01A mutations — replay and sealing rules', () => {
  it('replay-across-principals is detected', () =>
    qualify<AttributionModule>({
      id: 'replay-across-principals',
      file: ATTRIBUTION,
      replacements: [['return left.requestingPrincipalId === right.requestingPrincipalId;', 'return true;']],
      guard: (m) => m.sameRequester(customerAttribution(PRINCIPAL), customerAttribution(OTHER_PRINCIPAL)) === false,
    }));

  it('historical-record-adopted-by-a-principal is detected', () =>
    qualify<IdentityModule>({
      id: 'historical-record-adopted-by-a-principal',
      file: IDENTITY,
      replacements: [["return attribution === undefined || attribution.basis === 'legacy-asserted';", 'return true;']],
      guard: (m) => m.mayReplayTo(recordWith(undefined), customerAttribution(PRINCIPAL)) === false,
    }));

  it('store-accepts-a-contradicting-attribution is detected', () =>
    qualify<AttributionModule>({
      id: 'store-accepts-a-contradicting-attribution',
      file: ATTRIBUTION,
      replacements: [['if (attribution.evaluatedActorId !== request.actor.id || attribution.organizationId !== request.organization?.id) {', 'if (false) {']],
      guard: (m) => {
        try {
          m.assertAttributionMatchesRequest({ ...customerAttribution(PRINCIPAL), evaluatedActorId: OTHER_ACTOR }, request());
          return false;
        } catch {
          return true;
        }
      },
    }));
});

// ---------------------------------------------------------------------------
// The orchestrator's wiring: the check runs on both replay paths, and the
// attribution reaches the Store.

const enterprises: AocEnterprise[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
});

let world: Promise<{ readonly enterprise: AocEnterprise; readonly providers: ReturnType<typeof buildTestKernelProviders> }> | undefined;
function composed(): NonNullable<typeof world> {
  world ??= (async () => {
    const authority = createInMemoryKernelAuthorityStore();
    await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor(
      { system: true, actorId: 'operator-g01a-mutation' },
      { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
    );
    const providers = buildTestKernelProviders();
    const enterprise = await createEnterprise({ configuration: configuration(), kernelProviders: providers, kernelAuthorityStore: authority, customerIdentityAdmission: { enabled: true } });
    enterprises.push(enterprise);
    return { enterprise, providers };
  })();
  return world;
}

let eventSequence = 0;
async function dependencies(store: GovernanceStore): Promise<EvaluateGovernanceRequestDependencies> {
  const { enterprise, providers } = await composed();
  assert.ok(enterprise.customerIdentityAdmission !== undefined);
  return {
    kernel: enterprise.kernel,
    clock: providers.clock,
    idGenerator: providers.idGenerator,
    eventIdGenerator: { nextId: (prefix: string) => `${prefix}-g01a-mutation-${(eventSequence += 1)}` },
    store,
    eventPublisher: enterprise.eventPublisher,
    telemetry: enterprise.telemetry,
    logger: enterprise.logger,
    configuration: configuration(),
    enterpriseContext: () => ({ enterpriseVersion: 'test', lifecycleState: 'ready', modules: [] }),
    customerIdentityAdmission: enterprise.customerIdentityAdmission,
    trustDomainId: TRUST_DOMAIN_ID,
  };
}

/** Two principals bound to one actor submit the same payload under one key; the second must be refused and nothing written for it. */
async function crossPrincipalReplayRefused(m: OrchestratorModule, store: GovernanceStore, afterFirst: () => void = () => {}): Promise<boolean> {
  const deps = await dependencies(store);
  const rawBody = buildAllowedRequestBody({ requestId: `g01a-mutation-replay-${(sequence += 1)}`, organization: { id: ORG } });
  const idempotencyKey = `g01a-mutation-key-${sequence}`;
  await m.evaluateGovernanceRequest({ rawBody, authorizationHeader: `Bearer ${CUSTOMER_KEY}`, idempotencyKey }, deps);
  afterFirst();
  const before = (await store.query({ system: true }, {})).records.length;
  const refused = await refusedWith(409, m.evaluateGovernanceRequest({ rawBody, authorizationHeader: `Bearer ${OTHER_CUSTOMER_KEY}`, idempotencyKey }, deps));
  return refused && (await store.query({ system: true }, {})).records.length === before;
}

describe('G-01A mutations — orchestrator wiring', () => {
  it('pre-kernel-replay-unchecked is detected', () =>
    qualify<OrchestratorModule>({
      id: 'pre-kernel-replay-unchecked',
      file: ORCHESTRATOR,
      replacements: [['assertReplayableTo(resolution.record, attribution, idempotency, request.requestId, deps);', '']],
      guard: (m) => crossPrincipalReplayRefused(m, createInMemoryGovernanceStore()),
    }));

  it('append-transaction-replay-unchecked is detected', () =>
    qualify<OrchestratorModule>({
      id: 'append-transaction-replay-unchecked',
      file: ORCHESTRATOR,
      replacements: [['assertReplayableTo(appended.existingRecord, attribution, idempotency, request.requestId, deps);', '']],
      guard: (m) => {
        // The pre-Kernel probe is blinded after the first commit, so only the append transaction can find the earlier record.
        const raw = createInMemoryGovernanceStore();
        let blind = false;
        const store = new Proxy(raw, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (typeof value !== 'function') return value;
            if (property === 'resolveIdempotency' && blind) return async () => ({ kind: 'new' });
            return (value as (...inner: unknown[]) => unknown).bind(target);
          },
        });
        return crossPrincipalReplayRefused(m, store, () => {
          blind = true;
        });
      },
    }));

  it('attribution-never-sealed is detected', () =>
    qualify<OrchestratorModule>({
      id: 'attribution-never-sealed',
      file: ORCHESTRATOR,
      replacements: [['...(attribution !== undefined ? { attribution } : {}),', '']],
      guard: async (m) => {
        const store = createInMemoryGovernanceStore();
        const outcome = await m.evaluateGovernanceRequest(
          { rawBody: buildAllowedRequestBody({ requestId: `g01a-mutation-sealed-${(sequence += 1)}`, organization: { id: ORG } }), authorizationHeader: `Bearer ${CUSTOMER_KEY}` },
          await dependencies(store),
        );
        const record = await store.getByEvaluationId({ system: true }, outcome.body.governanceRecord?.evaluationId ?? '');
        return record?.events.some((event) => event.eventType === GOVERNANCE_ATTRIBUTION_EVENT_TYPE) === true;
      },
    }));
});

// ---------------------------------------------------------------------------
// Post-review hardening: embedders meet the Host's rules, and a replay signal
// without its record fails closed.

const SERVICE_SECRET = 'G01A_MUTATION_EMBEDDER_SERVICE_SECRET_0000';
const OPERATOR_SECRET = 'G01A_MUTATION_EMBEDDER_OPERATOR_SECRET_000';
function embedderConfiguration(servicePrincipal: { readonly principalId?: string; readonly key?: string }): EnterpriseConfiguration {
  const base = configuration();
  return {
    ...base,
    administration: { administrators: [], operators: [{ operatorId: 'ops-g01a-mutation', role: 'observer', key: OPERATOR_SECRET }] },
    authentication: { ...base.authentication, servicePrincipals: [{ principalId: servicePrincipal.principalId ?? 'svc-g01a-embedder', organizationId: ORG, key: servicePrincipal.key ?? SERVICE_SECRET, onBehalfOfActors: [PMFREAK_ACTOR_ID] }] },
  };
}
function throwsServicePrincipalError(m: IdentityModule, servicePrincipal: { readonly principalId?: string; readonly key?: string }): boolean {
  try {
    m.assertServicePrincipalConfiguration(embedderConfiguration(servicePrincipal), ORG);
    return false;
  } catch (error) {
    return error instanceof m.ServicePrincipalConfigurationError;
  }
}

describe('G-01A mutations — embedder validation', () => {
  it('service-principal-may-reuse-an-operator-id is detected', () =>
    qualify<IdentityModule>({
      id: 'service-principal-may-reuse-an-operator-id',
      file: IDENTITY,
      replacements: [['...operators.map((operator) => operator.operatorId),', '']],
      guard: (m) => throwsServicePrincipalError(m, { principalId: 'ops-g01a-mutation' }),
    }));

  it('service-principal-may-share-an-operator-secret is detected', () =>
    qualify<IdentityModule>({
      id: 'service-principal-may-share-an-operator-secret',
      file: IDENTITY,
      replacements: [['if (secrets.has(key))', 'if (false)']],
      guard: (m) => throwsServicePrincipalError(m, { key: OPERATOR_SECRET }),
    }));

  it('service-principal-may-use-the-agent-prefix is detected', () =>
    qualify<IdentityModule>({
      id: 'service-principal-may-use-the-agent-prefix',
      file: IDENTITY,
      replacements: [['if (servicePrincipal.principalId.startsWith(', 'if (false && servicePrincipal.principalId.startsWith(']],
      guard: (m) => throwsServicePrincipalError(m, { principalId: 'agent:g01a-mutation' }),
    }));

  it('secure-profile-defaults-to-compat is detected', () =>
    qualify<ConfigurationModule>({
      id: 'secure-profile-defaults-to-compat',
      file: CONFIGURATION,
      replacements: [['return configuration.authentication.legacyKeyMode ?? defaultLegacyKeyMode(configuration.environment);', "return configuration.authentication.legacyKeyMode ?? 'compat';"]],
      guard: (m) => m.effectiveLegacyKeyMode({ environment: 'production', authentication: { apiKeys: [] } }) === 'restricted' && m.effectiveLegacyKeyMode({ environment: 'staging', authentication: { apiKeys: [] } }) === 'restricted',
    }));

  it('composition-skips-the-legacy-key-rule is detected', () =>
    qualify<CompositionModule>({
      id: 'composition-skips-the-legacy-key-rule',
      file: COMPOSITION,
      replacements: [['(0, advisory_identity_js_1.assertLegacyKeyConfiguration)(configuration);', '']],
      guard: async (m) => {
        const base = configuration();
        try {
          const enterprise = await m.createEnterprise({ configuration: { ...base, environment: 'production', authentication: { apiKeys: [{ key: BARE_KEY }] } }, kernelProviders: buildTestKernelProviders() });
          await enterprise.close().catch(() => {});
          return false;
        } catch (error) {
          return (error as Error).name === 'LegacyKeyConfigurationError';
        }
      },
    }));

  it('composition-skips-the-service-principal-rule is detected', () =>
    qualify<CompositionModule>({
      id: 'composition-skips-the-service-principal-rule',
      file: COMPOSITION,
      replacements: [['(0, advisory_identity_js_1.assertServicePrincipalConfiguration)(configuration, configuration.kernelAuthority.organizationId);', '']],
      guard: async (m) => {
        try {
          const enterprise = await m.createEnterprise({ configuration: embedderConfiguration({ principalId: 'ops-g01a-mutation' }), kernelProviders: buildTestKernelProviders() });
          await enterprise.close().catch(() => {});
          return false;
        } catch (error) {
          return (error as Error).name === 'ServicePrincipalConfigurationError';
        }
      },
    }));
});

/** A Store that signals a replay but hands back no record, at the probe or inside the append. */
function replayWithoutRecord(where: 'probe' | 'append'): GovernanceStore {
  const raw = createInMemoryGovernanceStore();
  return new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'resolveIdempotency') return async () => (where === 'probe' ? { kind: 'replay', record: undefined } : { kind: 'new' });
      if (property === 'appendEvaluation' && where === 'append') {
        return async () => ({ evaluationId: 'gov-evaluation-foreign', decisionId: 'decision-foreign', requestId: 'foreign', created: false, idempotentReplay: true, aggregateDigest: `sha256:${'0'.repeat(64)}`, persistedAt: '2026-01-01T00:00:00.000Z' });
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
}

async function failsClosed(m: OrchestratorModule, where: 'probe' | 'append'): Promise<boolean> {
  const rawBody = buildAllowedRequestBody({ requestId: `g01a-mutation-no-record-${(sequence += 1)}`, organization: { id: ORG } });
  try {
    await m.evaluateGovernanceRequest({ rawBody, authorizationHeader: `Bearer ${CUSTOMER_KEY}`, idempotencyKey: `g01a-mutation-no-record-key-${sequence}` }, await dependencies(replayWithoutRecord(where)));
    return false;
  } catch (error) {
    return (error as { httpStatus?: unknown; code?: unknown }).httpStatus === 500 && (error as { code?: unknown }).code === 'GOVERNANCE_RECORD_CORRUPTED';
  }
}

describe('G-01A mutations — a replay without its record fails closed', () => {
  it('probe-replay-without-record-trusted is detected', () =>
    qualify<OrchestratorModule>({
      id: 'probe-replay-without-record-trusted',
      file: ORCHESTRATOR,
      replacements: [['if (!isReplayableRecordShape(record)) {', 'if (false) {']],
      guard: (m) => failsClosed(m, 'probe'),
    }));

  it('append-replay-without-record-is-a-fresh-commit is detected', () =>
    qualify<OrchestratorModule>({
      id: 'append-replay-without-record-is-a-fresh-commit',
      file: ORCHESTRATOR,
      replacements: [['if (appended.idempotentReplay) {', 'if (appended.idempotentReplay && appended.existingRecord !== undefined) {']],
      guard: (m) => failsClosed(m, 'append'),
    }));
});
