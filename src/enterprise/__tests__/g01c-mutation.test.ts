import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { GOVERNANCE_ATTRIBUTION_EVENT_TYPE, GOVERNANCE_ATTRIBUTION_VERSION, type AppendGovernanceEvaluationInput, type GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { GovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { hasGovernedActionProvenance } from '../governance-store/governed-provenance.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { deriveGovernedActionRequestId, governedActionIdempotencyScope } from '../governed-action/index.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { AgentPassportError } from '../passport/errors.js';
import { createInMemoryPassportStore } from '../passport/in-memory-passport-store.js';
import { EVALUATED_AT_POLICY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01C — mutation qualification. Each mutant edits one compiled module at one
 * site; its guard must hold for the shipped module and must detect the mutant:
 *
 * - M1 Passport: a link is refused for another organization's record;
 * - M2 Store: an attribution event is never accepted from `events[]`;
 * - M3 composition: the advisory trust domain is the one validated at composition;
 * - M4 SQLite: the `governed-action` predicate is the governed claim, evaluated in SQL;
 * - M5 SQLite: tenant visibility is decided before an integrity verdict;
 * - M6 G-01B0: L1 (the evaluate route refuses `aoc.` ids) and L2 (a governed
 *   probe is answered by its claim alone), in both providers.
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

const NOW = '2026-01-01T00:00:00.000Z';
const FOREIGN_ORG = 'org-g01c-mutation-foreign';
const SYSTEM: GovernanceStoreAccessContext = { system: true };
const TENANT: GovernanceStoreAccessContext = { system: false, organizationId: ORG };
const FOREIGN_TENANT: GovernanceStoreAccessContext = { system: false, organizationId: FOREIGN_ORG };

let sequence = 0;
const fresh = (label: string): string => `g01c-mutation-${label}-${(sequence += 1)}`;

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function appendInput(requestId: string, organizationId = ORG, overrides: Partial<AppendGovernanceEvaluationInput> = {}): AppendGovernanceEvaluationInput {
  const decisionId = `${requestId}-decision`;
  const request: KernelEvaluationRequest = {
    requestId,
    actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID },
    action: { type: 'draft_closure_email', resourceScope: 'project:closure' },
    organization: { id: organizationId },
    requestedAt: NOW,
  };
  const result = {
    requestId,
    decisionId,
    status: 'allowed',
    reasonCodes: ['OK'],
    summary: 'fine',
    recognition: { performed: true },
    authority: { performed: false },
    policies: [],
    approval: { performed: false, status: 'not_applicable' },
    evidence: [],
    trace: { steps: [{ sequence: 1, operator: 'recognition', status: 'passed', reasonCodes: ['OK'] }], decisionId, kernelVersion: '1.0.0' },
    evaluatedAt: NOW,
    kernelVersion: '1.0.0',
  } as KernelEvaluationResult;
  return {
    request,
    result,
    receivedAt: NOW,
    enterpriseContext: { enterpriseVersion: 'g01c', lifecycleState: 'ready', modules: [] },
    events: [],
    accessContext: { system: true, organizationId, actorId: PMFREAK_ACTOR_ID },
    ...overrides,
  };
}

const isStoreError = (error: unknown, code: string): boolean => error instanceof GovernanceStoreError && error.code === code;

// ---------------------------------------------------------------------------

type PassportModule = typeof import('../passport/service.js');
type ProjectionModule = typeof import('../governance-store/projection.js');
type CompositionModule = typeof import('../composition/composition-root.js');
type SqliteModule = typeof import('../governance-store/sqlite-governance-store.js');
type InMemoryModule = typeof import('../governance-store/in-memory-governance-store.js');
type ContractModule = typeof import('../api/governance-evaluate-contract.js');

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const CUSTOMER_KEY = 'G01C_MUTATION_CUSTOMER_KEY_0123456789abcdef';
const KEYS: readonly EnterpriseApiKey[] = [{ key: CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: 'principal-g01c-mutation', externalSubject: SUBJECT } }];

async function hostOptions(): Promise<CreateEnterpriseOptions> {
  const authority = createInMemoryKernelAuthorityStore();
  await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-g01c-mutation' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  const inner = createRecordingExecutionAdapter(async () => ({ outcome: 'completed', providerRef: 'provider-ref-g01c-mutation' }));
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_REQUIRE_AUTH: 'true', AOC_ENTERPRISE_LOG_LEVEL: 'error' });
  return {
    configuration: { ...base, authentication: { apiKeys: KEYS, legacyKeyMode: 'restricted' } },
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: authority,
    persistence: createInMemoryGovernanceStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: createInMemoryBoundedGrantStore(),
      executionAdapterRouting: { adapters: [{ adapterId: 'adapter-g01c-mutation', execute: (action: ValidatedExecutionAction) => inner.execute(action) }], selectAdapter: () => 'adapter-g01c-mutation' },
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [] },
    emergencyControl: { enabled: true, store: createInMemoryEmergencyControlStore() },
    executionOutcomes: { store: createInMemoryExecutionOutcomeStore({ now: () => new Date().toISOString() }) },
  };
}

/** A SQLite file holding one record of ORG whose result payload no longer parses. */
async function corruptedFile(): Promise<{ readonly path: string; readonly evaluationId: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-g01c-mutation-'));
  directories.push(directory);
  const path = join(directory, 'corrupted.sqlite');
  const seed = await createSqliteGovernanceStore(path);
  const appended = await seed.appendEvaluation(appendInput(fresh('corrupted')));
  await seed.close();
  const db = new Database(path);
  db.prepare(`UPDATE governance_evaluations SET result_payload_json = 'not json{' WHERE evaluation_id = ?`).run(appended.evaluationId);
  db.close();
  return { path, evaluationId: appended.evaluationId };
}

describe('G-01C mutations', () => {
  it('M1 passport-links-another-organizations-record is detected', () =>
    qualify<PassportModule>({
      id: 'passport-links-another-organizations-record',
      file: 'passport/service.js',
      replacements: [['if (record.request.organizationId !== passport.organization.organizationId) {', 'if (false) {']],
      guard: async (m) => {
        const governanceStore = createInMemoryGovernanceStore();
        const passports = m.createAgentPassportService({ store: createInMemoryPassportStore(), governanceStore, now: () => NOW, nextId: (prefix) => fresh(prefix) });
        const scope = { system: true } as const;
        const { passport } = await passports.issuePassport(scope, { subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent' }, organization: { organizationId: ORG, recognizedBy: 'registry' }, actorId: 'user-g01c' });
        const appended = await governanceStore.appendEvaluation(appendInput(fresh('foreign'), FOREIGN_ORG));
        const record = await governanceStore.getByEvaluationId(SYSTEM, appended.evaluationId);
        assert.ok(record !== null);
        try {
          await passports.linkGovernanceRecord(scope, passport.passportId, {
            evaluationId: record.evaluation.evaluationId,
            decisionId: record.evaluation.decisionId,
            requestId: record.request.requestId,
            status: record.evaluation.status,
            occurredAt: record.evaluation.evaluatedAt,
            governanceRecordDigest: record.integrity.aggregateDigest,
          }, 'user-g01c');
          return false;
        } catch (error) {
          return error instanceof AgentPassportError && error.code === 'PASSPORT_GOVERNANCE_RECORD_NOT_FOUND';
        }
      },
    }));

  it('M2 store-accepts-an-injected-attribution-event is detected', () =>
    qualify<ProjectionModule>({
      id: 'store-accepts-an-injected-attribution-event',
      file: 'governance-store/projection.js',
      replacements: [['input.events.some(isReservedAttributionEvent)', 'false']],
      guard: (m) => {
        const requestId = fresh('injected');
        const injected = {
          eventId: `evt-${requestId}`,
          type: GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
          occurredAt: NOW,
          attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: ORG, requestingPrincipalId: 'principal-forged', evaluatedActorId: PMFREAK_ACTOR_ID, salt: '0123456789abcdef0123456789abcdef' },
        } as unknown as EnterpriseEvent;
        try {
          m.buildGovernanceAggregate(appendInput(requestId, ORG, { events: [injected] }), { now: () => NOW, nextId: (prefix) => fresh(prefix), limits: m.DEFAULT_GOVERNANCE_STORE_LIMITS }, { chainPosition: 1 });
          return false;
        } catch (error) {
          return isStoreError(error, 'GOVERNANCE_STORE_VALIDATION_ERROR');
        }
      },
    }));

  it('M3 composition-serves-a-live-trust-domain is detected', () =>
    qualify<CompositionModule>({
      id: 'composition-serves-a-live-trust-domain',
      file: 'composition/composition-root.js',
      replacements: [['Object.freeze({ ...options.governedActionOrchestrator })', 'options.governedActionOrchestrator']],
      guard: async (m) => {
        const options = await hostOptions();
        const enterprise = await m.createEnterprise(options);
        try {
          (options.governedActionOrchestrator as unknown as { trustDomainId: string }).trustDomainId = 'trust-domain-g01c-mutation-attacker';
          const reply = await enterprise.evaluate(buildAllowedRequestBody({ requestId: fresh('trust-domain'), organization: { id: ORG } }), { authorizationHeader: `Bearer ${CUSTOMER_KEY}` });
          return reply.httpStatus === 200;
        } catch {
          return false;
        } finally {
          await enterprise.close().catch(() => {});
        }
      },
    }));

  it('M4 sql-governed-path-ignores-the-claim is detected', () =>
    qualify<SqliteModule>({
      id: 'sql-governed-path-ignores-the-claim',
      file: 'governance-store/sqlite-governance-store.js',
      replacements: [['AND ${GOVERNED_ACTION_FN}(r.organization_id, e.request_id, ic.scope, ic.idempotency_key) = 1', 'AND 1 = 1']],
      guard: async (m) => {
        const store = await m.createSqliteGovernanceStore(':memory:');
        closers.push(() => store.close());
        // An advisory evaluation committed with its own (org-scoped) idempotency claim: a claim, but not the governed one.
        const appended = await store.appendEvaluation(appendInput(fresh('advisory-claimed'), ORG, { idempotency: { scope: `org:${ORG}`, idempotencyKey: fresh('advisory-key') } }));
        const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
        assert.ok(record !== null);
        return !(await hasGovernedActionProvenance(store, TENANT, record));
      },
    }));

  it('M5 sqlite-discloses-integrity-before-visibility is detected', () =>
    qualify<SqliteModule>({
      id: 'sqlite-discloses-integrity-before-visibility',
      file: 'governance-store/sqlite-governance-store.js',
      replacements: [['function mayDiscloseAggregate(context, evaluationId) {', 'function mayDiscloseAggregate(context, evaluationId) { return true;']],
      guard: async (m) => {
        const { path, evaluationId } = await corruptedFile();
        const store = await m.createSqliteGovernanceStore(path);
        try {
          return (await store.getByEvaluationId(FOREIGN_TENANT, evaluationId)) === null;
        } catch {
          return false;
        } finally {
          await store.close();
        }
      },
    }));

  it('M6a evaluate-route-accepts-a-server-derived-request-id (SEC-INV-335, L1) is detected', () =>
    qualify<ContractModule>({
      id: 'evaluate-route-accepts-a-server-derived-request-id',
      file: 'api/governance-evaluate-contract.js',
      replacements: [['isServerDerivedIdentifierNamespace)(body.requestId)', 'isServerDerivedIdentifierNamespace)(body.requestId) && false']],
      guard: (m) => {
        m.validateGovernanceEvaluateRequestBody(buildAllowedRequestBody({ requestId: fresh('ordinary'), organization: { id: ORG } }));
        try {
          m.validateGovernanceEvaluateRequestBody(buildAllowedRequestBody({ requestId: ' AOC.gar:0123456789abcdef0123456789abcdef', organization: { id: ORG } }));
          return false;
        } catch {
          return true;
        }
      },
    }));

  /** A record at a victim principal's governed request id with no governed claim, then the victim's governed probe for it. */
  async function plantedProbeIsRefused(store: GovernanceStore): Promise<boolean> {
    const principalId = 'principal-g01c-mutation-victim';
    const idempotencyKey = fresh('victim-key');
    const requestId = deriveGovernedActionRequestId({ organizationId: ORG, principalId, idempotencyKey });
    const appended = await store.appendEvaluation(appendInput(requestId));
    const planted = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
    assert.ok(planted !== null);
    const resolution = await store.resolveIdempotency(TENANT, {
      requestId,
      payloadDigest: planted.request.payloadDigest,
      idempotency: { scope: governedActionIdempotencyScope({ organizationId: ORG, principalId }), idempotencyKey },
    });
    return resolution.kind === 'conflict';
  }

  it('M6b in-memory-governed-probe-adopts-a-planted-record (SEC-INV-336, L2) is detected', () =>
    qualify<InMemoryModule>({
      id: 'in-memory-governed-probe-adopts-a-planted-record',
      file: 'governance-store/in-memory-governance-store.js',
      replacements: [['probesGovernedActionClaim)(context, probe)', 'probesGovernedActionClaim)(context, probe) && false']],
      guard: (m) => plantedProbeIsRefused(m.createInMemoryGovernanceStore()),
    }));

  it('M6c sqlite-governed-probe-adopts-a-planted-record (SEC-INV-336, L2) is detected', () =>
    qualify<SqliteModule>({
      id: 'sqlite-governed-probe-adopts-a-planted-record',
      file: 'governance-store/sqlite-governance-store.js',
      replacements: [['probesGovernedActionClaim)(context, probe)', 'probesGovernedActionClaim)(context, probe) && false']],
      guard: async (m) => {
        const store = await m.createSqliteGovernanceStore(':memory:');
        closers.push(() => store.close());
        return plantedProbeIsRefused(store);
      },
    }));
});
