import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMERGENCY_CONTROL_REASON_CODES,
  createEmergencyControlReader,
  createInMemoryEmergencyControlStore,
  type EmergencyControlQuery,
  type EmergencyControlStorePort,
} from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { isExecutionGovernanceError } from '../execution-governance/index.js';
import { createSqliteEmergencyControlStore, type DurableEmergencyControlStore } from '../emergency-control/index.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { EVALUATED_AT_POLICY, ALLOWED_INTENT, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * Composition: **one** interlock instance, opt-in, fail-closed, host-owned when
 * the host opened it — and reachable from no caller, on no route, through no
 * SDK method.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const SECRET = 'AOC_EMERGENCY_CONTROL_SECRET_SENTINEL_DO_NOT_USE';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];
const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';

const enterprises: AocEnterprise[] = [];
const authorityStores: KernelAuthorityStore[] = [];
const controlStores: DurableEmergencyControlStore[] = [];
const workDir = mkdtempSync(join(tmpdir(), 'aoc-emergency-control-composition-'));
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(authorityStores.map((store) => store.close().catch(() => {})));
  await Promise.all(controlStores.map((store) => store.close().catch(() => {})));
  rmSync(workDir, { recursive: true, force: true });
});

function configuration(): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG });
  return { ...base, authentication: { apiKeys: KEYS } };
}

async function boundStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  authorityStores.push(store);
  await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-1' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  return store;
}

async function options(overrides: Partial<CreateEnterpriseOptions> = {}, adapter = createRecordingExecutionAdapter()): Promise<CreateEnterpriseOptions> {
  return {
    configuration: configuration(),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: await boundStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: adapter,
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    ...overrides,
  };
}

async function track(pending: Promise<AocEnterprise>): Promise<AocEnterprise> {
  const enterprise = await pending;
  enterprises.push(enterprise);
  return enterprise;
}

async function govern(enterprise: AocEnterprise, intent: unknown = ALLOWED_INTENT) {
  const admitted = await enterprise.customerIdentityAdmission?.admit({ authorizationHeader: `Bearer ${SECRET}` });
  assert.ok(admitted?.status === 'bound');
  const orchestrator = enterprise.governedActionOrchestrator;
  assert.ok(orchestrator !== undefined);
  return orchestrator.govern(admitted.identity, intent);
}

function namedAdapter(adapterId: string): RecordingExecutionAdapter {
  const inner = createRecordingExecutionAdapter();
  return {
    adapterId,
    calls: inner.calls,
    get callCount(): number {
      return inner.callCount;
    },
    execute: (action: ValidatedExecutionAction) => inner.execute(action),
  };
}

describe('Emergency control composition — omitting it changes nothing', () => {
  it('no operator surface, no checks, and the governed path behaves exactly as before', async () => {
    const adapter = createRecordingExecutionAdapter();
    const enterprise = await track(createEnterprise(await options({}, adapter)));
    assert.equal(enterprise.emergencyControlAdministration, undefined, 'undefined means no interlock is enforced — never that execution is unstoppable');
    const result = await govern(enterprise);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(adapter.callCount, 1);
  });

  it('`enabled: false` is the same as absent', async () => {
    const enterprise = await track(createEnterprise(await options({ emergencyControl: { enabled: false } })));
    assert.equal(enterprise.emergencyControlAdministration, undefined);
    assert.equal((await govern(enterprise)).status, 'executed');
  });

  it('the legacy evaluate() path is untouched whether or not the interlock is composed', async () => {
    const withControl = await track(createEnterprise(await options({ emergencyControl: { enabled: true } })));
    const store = withControl.emergencyControlAdministration;
    assert.ok(store !== undefined);
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });

    // An active global stop does not touch the frozen evaluation surface: the
    // interlock governs the bounded-grant path, and that scope is stated rather
    // than implied.
    const response = await withControl.evaluate(buildAllowedRequestBody(), { authorizationHeader: `Bearer ${SECRET}` });
    assert.equal(response.httpStatus, 200, JSON.stringify(response.body));
  });
});

describe('Emergency control composition — one reader, every checkpoint', () => {
  it('the same instance answers admission, the commit boundary, the exercise gate and the registry', async () => {
    const queries: EmergencyControlQuery[] = [];
    const inner = createInMemoryEmergencyControlStore();
    const recording: EmergencyControlStorePort = {
      read(query) {
        queries.push(query);
        return inner.read(query);
      },
      activate: (declaration) => inner.activate(declaration),
      release: (release) => inner.release(release),
      active: () => inner.active(),
    };
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const enterprise = await track(
      createEnterprise(
        await options({
          emergencyControl: { enabled: true, store: recording },
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            executionAdapterRouting: {
              adapters: [a, b],
              selectAdapter: (action) => (action.action === ALLOWED_INTENT.action ? 'adapter-a' : 'adapter-b'),
            },
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
        }),
      ),
    );

    const result = await govern(enterprise);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);

    // Four reads, all reaching this one store through the single narrowed
    // reader the composition root built: three that know no adapter, and one
    // that does — which is the registry's, after routing resolved a child.
    assert.equal(queries.length, 4, `expected four checkpoint reads, saw ${JSON.stringify(queries)}`);
    assert.equal(queries.filter((query) => query.adapterId !== undefined).length, 1);
    assert.equal(queries.find((query) => query.adapterId !== undefined)?.adapterId, 'adapter-a');
    for (const query of queries) {
      assert.equal(query.organizationId, ORG);
      assert.equal(query.actorId, PMFREAK_ACTOR_ID);
      // No workflow scope is ever manufactured: no canonical trusted source exists.
      assert.equal(query.workflowId, undefined);
    }
  });

  it('a stop activated through the operator surface is honoured by the governed path immediately', async () => {
    const adapter = createRecordingExecutionAdapter();
    const enterprise = await track(createEnterprise(await options({ emergencyControl: { enabled: true } }, adapter)));
    const store = enterprise.emergencyControlAdministration;
    assert.ok(store !== undefined);

    store.activate({ scope: 'organization', value: ORG, issuerRef: ISSUER, declaredAt: AT });
    const stopped = await govern(enterprise);
    assert.equal(stopped.status, 'withheld');
    assert.equal(stopped.status === 'withheld' ? stopped.withheldBy : undefined, 'emergency-control');
    assert.deepEqual([...stopped.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(adapter.callCount, 0);

    store.release({ scope: 'organization', value: ORG, issuerRef: ISSUER, releasedAt: AT });
    const resumed = await govern(enterprise, { ...ALLOWED_INTENT, idempotencyKey: 'key-after-release' });
    assert.equal(resumed.status, 'executed');
    assert.equal(adapter.callCount, 1);
  });
});

describe('Emergency control composition — store ownership and durability selection', () => {
  it('a host-supplied store is never closed from here', async () => {
    const dbPath = join(workDir, 'host-owned.sqlite');
    const hostStore = await createSqliteEmergencyControlStore(dbPath, { now: () => AT });
    controlStores.push(hostStore);
    const enterprise = await track(createEnterprise(await options({ emergencyControl: { enabled: true, store: hostStore } })));
    assert.equal(enterprise.emergencyControlAdministration, hostStore);

    await enterprise.close();
    // Still readable and still writable: the host closes what the host opened.
    hostStore.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(hostStore.read({}).state, 'blocked');
  });

  it('a store this root opened is closed on shutdown', async () => {
    const enterprise = await track(
      createEnterprise(
        await options({
          configuration: { ...configuration(), persistence: { ...configuration().persistence, provider: 'sqlite', sqlitePath: join(workDir, 'gov.sqlite') }, emergencyControl: { sqlitePath: join(workDir, 'composed.sqlite') } },
          emergencyControl: { enabled: true },
        }),
      ),
    );
    const store = enterprise.emergencyControlAdministration;
    assert.ok(store !== undefined);
    store.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(store.read({}).state, 'blocked');

    await enterprise.close();
    // Closed, and a closed store withholds rather than answering `clear`.
    assert.equal(store.read({}).state, 'unavailable');
  });

  it('the durable path is named by configuration, and is its own file', () => {
    const config = loadEnterpriseConfiguration({});
    assert.equal(config.emergencyControl.sqlitePath, '.data/emergency-controls.sqlite');
    for (const other of [config.persistence.sqlitePath, config.passport.sqlitePath, config.kernelAuthority.sqlitePath, config.assurance.sqlitePath, config.boundedGrant.sqlitePath]) {
      assert.notEqual(config.emergencyControl.sqlitePath, other, 'the interlock never shares a file with the records it governs');
    }
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: '/srv/stops.sqlite' }).emergencyControl.sqlitePath, '/srv/stops.sqlite');
  });

  it('the composition root, not the execution layers, is what knows about SQLite', () => {
    const root = readFileSync('src/enterprise/composition/composition-root.ts', 'utf8');
    assert.ok(root.includes('createSqliteEmergencyControlStore('), 'store selection belongs at the composition boundary');
    for (const dir of ['src/enterprise/execution-governance', 'src/features/emergency-control-runtime', 'src/features/execution-runtime']) {
      for (const file of sourceFiles(dir)) {
        // Comments stripped: these modules legitimately *explain* why
        // better-sqlite3's synchronous model is what makes a commit-boundary
        // read possible, and a rule that punished the explanation would push
        // the explanation out of the file.
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .split('\n')
          .map((line) => {
            const index = line.indexOf('//');
            return index === -1 ? line : line.slice(0, index);
          })
          .join('\n');
        assert.equal(/better-sqlite3|createSqliteEmergencyControlStore/.test(code), false, `${file} must stay storage-agnostic`);
      }
    }
  });
});

describe('Emergency control composition — adapter routing is host configuration, exactly one shape', () => {
  it('refuses both an adapter and a routing table', async () => {
    await assert.rejects(
      createEnterprise(
        await options({
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            executionAdapter: createRecordingExecutionAdapter(),
            executionAdapterRouting: { adapters: [namedAdapter('adapter-a')], selectAdapter: () => 'adapter-a' },
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
        }),
      ),
      (error: unknown) => isExecutionGovernanceError(error) && error.code === 'EXECUTION_ADAPTER_COMPOSITION_INVALID',
    );
  });

  it('refuses neither', async () => {
    await assert.rejects(
      createEnterprise(
        await options({
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
        }),
      ),
      (error: unknown) => isExecutionGovernanceError(error) && error.code === 'EXECUTION_ADAPTER_COMPOSITION_INVALID',
    );
  });

  it('a single adapter remains a valid composition — no host is forced to adopt routing', async () => {
    const adapter = createRecordingExecutionAdapter();
    const enterprise = await track(createEnterprise(await options({}, adapter)));
    assert.equal((await govern(enterprise)).status, 'executed');
    assert.equal(adapter.callCount, 1);
  });

  it('routing composes without emergency control, and still routes', async () => {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const enterprise = await track(
      createEnterprise(
        await options({
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            executionAdapterRouting: { adapters: [a, b], selectAdapter: () => 'adapter-b' },
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
        }),
      ),
    );
    assert.equal((await govern(enterprise)).status, 'executed');
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 1);
  });

  it('the ACE module reports the composite’s identity, not a child’s', async () => {
    const enterprise = await track(
      createEnterprise(
        await options({
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            executionAdapterRouting: { adapterId: 'router-1', adapters: [namedAdapter('adapter-a')], selectAdapter: () => 'adapter-a' },
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
        }),
      ),
    );
    assert.ok(enterprise.modules().some((entry) => entry.id.includes('authority-controlled-execution')), 'the ACE module must still be registered');
    const report = await enterprise.health();
    assert.equal(JSON.stringify(report).includes('router-1'), true, 'the module reports the boundary the Host holds, not one of the children behind it');
  });
});

describe('Emergency control composition — no customer surface', () => {
  it('the frozen HTTP surface gains no emergency or adapter route, and no route mentions emergency control', () => {
    const adapterSource = readFileSync('src/enterprise/adapters/node-http-adapter.ts', 'utf8');
    for (const token of ['emergency', 'emergencyControl', 'adapterRouting', 'selectAdapter']) {
      assert.equal(new RegExp(token, 'i').test(adapterSource), false, `the HTTP adapter must not mention ${token}`);
    }
    const freeze = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { readonly routeLiterals: readonly string[] };
    for (const route of freeze.routeLiterals) {
      // `/api/governed-actions` (P5) is the customer route onto the path the
      // interlock governs; it can observe a withholding, never administer one.
      assert.equal(/emergency|adapter/i.test(route), false, `${route} must not exist`);
    }
  });

  it('the SDK stays transport only, with no emergency or adapter method', () => {
    const sdk = readFileSync('packages/enterprise-host-sdk/src/client.ts', 'utf8');
    // The governed-action response decoder must recognize the one value a
    // caller can *observe* — `withheldBy: 'emergency-control'` — so that exact
    // quoted literal is the single permitted mention. Anything else (a method,
    // a route, an option, a field name) is still a failure.
    assert.equal((sdk.match(/'emergency-control'/g) ?? []).length, 1, 'the withheldBy vocabulary names emergency-control exactly once');
    const withoutObservedValue = sdk.replace("'emergency-control'", '');
    for (const token of ['emergency', 'adapterId', 'selectAdapter']) {
      assert.equal(new RegExp(token, 'i').test(withoutObservedValue), false, `the SDK must not expose ${token}`);
    }
    assert.equal(/\/api\/[^'"`]*emergency/i.test(sdk), false, 'the SDK must call no emergency-control route');
  });

  it('the Enterprise barrel re-exports no emergency-control value a consumer could call', () => {
    const barrel = readFileSync('src/enterprise/index.ts', 'utf8');
    for (const symbol of ['createSqliteEmergencyControlStore', 'createInMemoryEmergencyControlStore', 'createExecutionAdapterRegistry', 'EMERGENCY_CONTROL_REASON_CODES']) {
      // Type-only exports are fine; a *value* export would hand a published
      // consumer a factory for a store that can stop or resume a deployment.
      const valueExport = new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`, 's');
      assert.equal(valueExport.test(barrel), false, `${symbol} must not be a value export of the Enterprise barrel`);
    }
  });

  it('the intent stays closed against every emergency- and routing-shaped key', async () => {
    const enterprise = await track(createEnterprise(await options({ emergencyControl: { enabled: true } })));
    for (const key of ['emergencyControl', 'emergency', 'workflowId', 'adapterId', 'adapter', 'provider', 'url', 'host', 'endpoint', 'credential']) {
      const result = await govern(enterprise, { ...ALLOWED_INTENT, [key]: 'anything' });
      assert.equal(result.status, 'rejected', `an intent carrying '${key}' must be refused`);
    }
  });

  it('what the execution path holds is a one-method reader, not the store', async () => {
    const enterprise = await track(createEnterprise(await options({ emergencyControl: { enabled: true } })));
    const store = enterprise.emergencyControlAdministration;
    assert.ok(store !== undefined, 'the operator surface is the store');
    assert.equal(typeof store.activate, 'function');
    // And the capability the execution path receives is a fresh object with one
    // method, so a cast cannot walk back to the writer.
    const reader = createEmergencyControlReader(store) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(reader), ['read']);
    assert.equal(Object.isFrozen(reader), true);
    assert.equal('activate' in reader, false);
    assert.equal('release' in reader, false);
  });

  it('the orchestrator is handed a reader, and the reader declares no mutation', () => {
    const orchestrator = readFileSync('src/enterprise/governed-action/orchestrator.ts', 'utf8');
    assert.ok(/emergencyControl\?: EmergencyControlReaderPort/.test(orchestrator), 'the orchestrator must depend on the read capability only');
    for (const source of ['src/enterprise/governed-action/orchestrator.ts', 'src/enterprise/execution-governance/service.ts', 'src/enterprise/execution-governance/issuance-core.ts', 'src/features/execution-runtime/services/grant-execution-service.ts', 'src/features/execution-runtime/services/execution-adapter-registry.ts']) {
      const text = readFileSync(source, 'utf8');
      assert.equal(/EmergencyControlStorePort/.test(text), false, `${source} must not name the operator store`);
      assert.equal(/\.activate\(|\.release\(/.test(text), false, `${source} must not mutate an emergency control`);
    }
  });
});

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
