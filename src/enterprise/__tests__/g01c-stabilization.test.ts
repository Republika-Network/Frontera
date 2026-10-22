import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import type { AppendGovernanceEvaluationInput, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { GovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { hasUnpairedSurrogate } from '../governed-action/identifiers.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { secureEnv } from './core04-host-fixture.js';
import { ctrl02Env } from './ctrl02-host-fixture.js';
import { ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01C stabilization.
 *
 * 1. A request id with an unpaired surrogate code unit has no UTF-8 form. The
 *    SQLite Store persisted it under a lossy spelling, so the aggregate
 *    committed under it could never be read back whole: a permanent
 *    `GOVERNANCE_RECORD_CORRUPTED` any evaluate caller could plant (G-01C H-1).
 *    It is now refused at the evaluate route (400 `INVALID_REQUEST`) and by the
 *    Store itself (`GOVERNANCE_STORE_VALIDATION_ERROR`), before persistence, on
 *    both providers. Every well-formed identifier — non-ASCII, astral, combining
 *    — keeps its exact meaning.
 * 2. Host test fixtures that ran concurrently shared the repository-relative
 *    default `.data/evidence-bundles.sqlite`. Every fixture that composes a
 *    SQLite Host now names its own evidence path.
 */

const SYSTEM: GovernanceStoreAccessContext = { system: true };
const NOW = '2026-01-01T00:00:00.000Z';
let sequence = 0;
const fresh = (label: string): string => `g01c-stab-${label}-${(sequence += 1)}`;

const directories: string[] = [];
const enterprises: AocEnterprise[] = [];
const servers: EnterpriseServer[] = [];
const stores: GovernanceStore[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => {})));
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-g01c-stab-'));
  directories.push(directory);
  return directory;
}

const PROVIDERS: readonly { readonly name: string; readonly open: () => Promise<GovernanceStore> }[] = [
  { name: 'in-memory', open: async () => createInMemoryGovernanceStore() },
  { name: 'sqlite', open: async () => createSqliteGovernanceStore(':memory:') },
];

/** Every way a UTF-16 string can hold an unpaired surrogate: high or low, alone, at either end, reversed, doubled. */
const MALFORMED: readonly (readonly [string, string])[] = [
  ['a lone high surrogate', 'req-\uD800-x'],
  ['a lone low surrogate', 'req-\uDC00-x'],
  ['a trailing high surrogate', 'req-x\uDBFF'],
  ['a leading low surrogate', '\uDFFFreq-x'],
  ['a reversed pair', 'req-\uDC00\uD800-x'],
  ['two high surrogates', 'req-\uD800𐀀-x'],
];

/** Well-formed identifiers whose meaning must not change: BMP non-ASCII, astral characters (paired surrogates), combining marks, the private-use area. */
const WELL_FORMED: readonly (readonly [string, string])[] = [
  ['ASCII', 'req-ascii'],
  ['Latin-1 and CJK', 'req-ñandú-中文'],
  ['an astral character (a surrogate pair)', 'req-🧾-receipt'],
  ['a mathematical astral letter', 'req-𝔘'],
  ['a combining mark', 'req-é'],
  ['the private-use area', 'req-'],
];

function appendInput(requestId: string): AppendGovernanceEvaluationInput {
  const decisionId = `decision-${(sequence += 1)}`;
  const request: KernelEvaluationRequest = {
    requestId,
    actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID },
    action: { type: 'draft_closure_email', resourceScope: 'project:closure' },
    organization: { id: ORG },
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
    enterpriseContext: { enterpriseVersion: 'g01c-stab', lifecycleState: 'ready', modules: [] },
    events: [{ eventId: `evt-${decisionId}`, type: 'GovernanceEvaluationRequested', occurredAt: NOW, requestId } as unknown as EnterpriseEvent],
    accessContext: { system: true, organizationId: ORG, actorId: PMFREAK_ACTOR_ID },
  };
}

async function unauthenticatedEnterprise(store: GovernanceStore): Promise<AocEnterprise> {
  const enterprise = await createEnterprise({
    configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_LOG_LEVEL: 'error' }),
    kernelProviders: buildTestKernelProviders(),
    persistence: store,
  });
  enterprises.push(enterprise);
  return enterprise;
}

async function refusedWith(status: number, pending: Promise<unknown>): Promise<boolean> {
  try {
    await pending;
    return false;
  } catch (error) {
    return (error as { httpStatus?: unknown }).httpStatus === status;
  }
}

const recordCount = async (store: GovernanceStore): Promise<number> => (await store.query(SYSTEM, { limit: 200 })).records.length;

// ---------------------------------------------------------------------------
// 1. Malformed Unicode request ids.

describe('G-01C stabilization — the identifier rule', () => {
  for (const [label, value] of MALFORMED) {
    it(`${label} is an unpaired surrogate`, () => assert.equal(hasUnpairedSurrogate(value), true));
  }
  for (const [label, value] of WELL_FORMED) {
    it(`${label} is well formed`, () => assert.equal(hasUnpairedSurrogate(value), false));
  }
});

for (const provider of PROVIDERS) {
  describe(`G-01C stabilization — ${provider.name} Store — a malformed request id never reaches persistence`, () => {
    for (const [label, value] of MALFORMED) {
      it(`evaluate: ${label} is 400 INVALID_REQUEST, nothing is written, and no record reads as corrupted`, async () => {
        const store = await provider.open();
        stores.push(store);
        const enterprise = await unauthenticatedEnterprise(store);
        const before = await recordCount(store);
        assert.equal(await refusedWith(400, enterprise.evaluate(buildAllowedRequestBody({ requestId: value, organization: { id: ORG } }))), true);
        assert.equal(await recordCount(store), before, 'nothing was committed');
        assert.equal(await store.getByRequestId(SYSTEM, value), null);
      });

      it(`Store: ${label} is GOVERNANCE_STORE_VALIDATION_ERROR on a direct append, and nothing is written`, async () => {
        const store = await provider.open();
        stores.push(store);
        await assert.rejects(store.appendEvaluation(appendInput(value)), (error: unknown) => error instanceof GovernanceStoreError && error.code === 'GOVERNANCE_STORE_VALIDATION_ERROR');
        assert.equal(await recordCount(store), 0);
      });
    }

    it('Store: a request id that changes between reads is validated and persisted as one value — never a malformed one', async () => {
      const store = await provider.open();
      stores.push(store);
      const input = appendInput(fresh('shifting'));
      const wellFormed = input.request.requestId;
      let reads = 0;
      const request = Object.defineProperty({ ...input.request }, 'requestId', {
        enumerable: true,
        get: () => ((reads += 1) === 1 ? wellFormed : 'req-\uD800-x'),
      }) as KernelEvaluationRequest;
      let appended: { readonly evaluationId: string } | undefined;
      try {
        appended = await store.appendEvaluation({ ...input, request });
      } catch (error) {
        assert.ok(error instanceof GovernanceStoreError, String(error));
      }
      for (const record of (await store.query(SYSTEM, { limit: 200 })).records) {
        assert.equal(hasUnpairedSurrogate(record.requestId), false, 'no malformed request id was persisted');
      }
      if (appended !== undefined) {
        const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
        assert.ok(record !== null);
        assert.equal(hasUnpairedSurrogate(record.request.requestId), false);
      }
    });

    for (const [label, value] of WELL_FORMED) {
      it(`unchanged: ${label} is evaluated, stored exactly, found by itself and verified`, async () => {
        const store = await provider.open();
        stores.push(store);
        const enterprise = await unauthenticatedEnterprise(store);
        const requestId = `${value}-${(sequence += 1)}`;
        const reply = await enterprise.evaluate(buildAllowedRequestBody({ requestId, organization: { id: ORG } }));
        assert.equal(reply.httpStatus, 200);
        assert.equal(reply.body.requestId, requestId, 'echoed exactly');
        const record = await store.getByRequestId(SYSTEM, requestId);
        assert.ok(record !== null);
        assert.equal(record.request.requestId, requestId, 'stored exactly');
        assert.equal((await store.verify(SYSTEM, record.evaluation.evaluationId)).valid, true);
      });
    }
  });
}

describe('G-01C stabilization — over HTTP and across a SQLite restart', () => {
  it('a JSON body escaping an unpaired surrogate (\\ud800) is 400 INVALID_REQUEST and writes nothing', async () => {
    const store = await createSqliteGovernanceStore(':memory:');
    stores.push(store);
    const server = await createEnterpriseServer({
      configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1', AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_LOG_LEVEL: 'error' }),
      kernelProviders: buildTestKernelProviders(),
      persistence: store,
    });
    servers.push(server);
    const { port } = await server.listen();
    const payload = JSON.stringify(buildAllowedRequestBody({ requestId: 'req-placeholder', organization: { id: ORG } })).replace('req-placeholder', 'req-\\ud800-x');
    assert.ok(payload.includes('\\ud800'), 'the wire carries the escape, as a client would send it');
    const response = await fetch(`http://127.0.0.1:${port}/api/governance/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.equal((JSON.parse(text) as { error?: { code?: unknown } }).error?.code, 'INVALID_REQUEST', text);
    assert.equal(await recordCount(store), 0);
  });

  it('well-formed non-ASCII and astral request ids survive a SQLite restart exactly and still verify', async () => {
    const path = join(workDir(), 'restart.sqlite');
    const first = await createSqliteGovernanceStore(path);
    const committed: string[] = [];
    for (const [, value] of WELL_FORMED) {
      const requestId = `${value}-${(sequence += 1)}`;
      await first.appendEvaluation(appendInput(requestId));
      committed.push(requestId);
    }
    await first.close();
    const second = await createSqliteGovernanceStore(path);
    stores.push(second);
    for (const requestId of committed) {
      const record = await second.getByRequestId(SYSTEM, requestId);
      assert.ok(record !== null, `found after restart: ${JSON.stringify(requestId)}`);
      assert.equal(record.request.requestId, requestId);
      assert.equal((await second.verify(SYSTEM, record.evaluation.evaluationId)).valid, true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence Bundle Store isolation of Host test fixtures.

const PROVIDER_LINE = `AOC_ENTERPRISE_PERSISTENCE_PROVIDER: ${"'"}sqlite${"'"}`;
const GOVERNANCE_PATH_KEY = 'AOC_ENTERPRISE_SQLITE_PATH' + ':';
const EVIDENCE_PATH_VARIABLE = 'AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH';
const DEFAULT_EVIDENCE_PATH = loadEnterpriseConfiguration({}).evidence.sqlitePath;

function testSources(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') found.push(...testSources(path));
    } else if (path.split(/[\\/]/).includes('__tests__') && name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('G-01C stabilization — Host test fixtures never share an Evidence Bundle Store file', () => {
  it('the shared default is repository-relative, so two fixtures that leave it unset would open one file', () => {
    assert.equal(isAbsolute(DEFAULT_EVIDENCE_PATH), false, DEFAULT_EVIDENCE_PATH);
  });

  it('every test source that composes a SQLite Host with explicit store paths names its own evidence path', () => {
    const sources = testSources('src');
    assert.ok(sources.length > 100, `the scan sees the test tree (${String(sources.length)} files)`);
    const offenders = sources.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes(PROVIDER_LINE) && source.includes(GOVERNANCE_PATH_KEY) && !source.includes(EVIDENCE_PATH_VARIABLE) && !source.includes('storeEnvironmentFor(');
    });
    assert.deepEqual(offenders, [], 'these fixtures would share the default evidence file with every other concurrently running Host test');
  });

  it('every test that composes an Enterprise over a SQLite provider — in any spelling — names its own evidence store', () => {
    const sqliteProvider = /(?:PERSISTENCE_PROVIDER|\bprovider)\s*:[^,\n]*\x27sqlite\x27/;
    const composes = /createEnterprise|createEnterpriseServer|bootEnterpriseHost/;
    const namesEvidence = /AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH|evidence: \{|storeEnvironmentFor\(/;
    /** Reviewed exceptions, each with why the shared default is never opened. */
    const exempt = new Map<string, string>([
      ['g01c-security-qualification.test.ts', 'its only SQLite provider is a Host-loader refusal; no SQLite Host is composed'],
      ['prod02-backup-integrity-host.test.ts', 'every store path comes from deployment.envFor, i.e. storeEnvironmentFor (the store registry), which names the evidence store'],
    ]);
    const offenders = testSources('src').filter((path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      if (exempt.has(name)) return false;
      const source = readFileSync(path, 'utf8');
      return sqliteProvider.test(source) && composes.test(source) && !namesEvidence.test(source);
    });
    assert.deepEqual(offenders, [], 'these compositions would open the repository-relative default evidence file');
  });

  it('two independent CTRL-02 and CORE-04 fixture workspaces resolve distinct evidence paths, each inside its own workspace', () => {
    const resolved = [ctrl02Env(workDir()), ctrl02Env(workDir()), secureEnv(workDir()), secureEnv(workDir())].map((env) => {
      const path = loadEnterpriseConfiguration(env).evidence.sqlitePath;
      const governance = env['AOC_ENTERPRISE_SQLITE_PATH'];
      assert.ok(governance !== undefined);
      const workspace = resolve(governance, '..');
      assert.equal(relative(workspace, resolve(path)).startsWith('..'), false, `${path} lies inside ${workspace}`);
      assert.notEqual(path, DEFAULT_EVIDENCE_PATH);
      return resolve(path);
    });
    assert.equal(new Set(resolved).size, resolved.length, 'no two fixtures share an evidence file');
  });
});

// ---------------------------------------------------------------------------
// 3. Mutation qualification of the two refusals and the rule.

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

type ContractModule = typeof import('../api/governance-evaluate-contract.js');
type ProjectionModule = typeof import('../governance-store/projection.js');
type IdentifiersModule = typeof import('../governed-action/identifiers.js');

const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

describe('G-01C stabilization mutations', () => {
  it('evaluate-route-accepts-an-unpaired-surrogate is detected', () =>
    qualify<ContractModule>({
      id: 'evaluate-route-accepts-an-unpaired-surrogate',
      file: 'api/governance-evaluate-contract.js',
      replacements: [['hasUnpairedSurrogate)(body.requestId)', 'hasUnpairedSurrogate)(body.requestId) && false']],
      guard: (m) =>
        !throws(() => m.validateGovernanceEvaluateRequestBody(buildAllowedRequestBody({ requestId: fresh('ordinary'), organization: { id: ORG } }))) &&
        throws(() => m.validateGovernanceEvaluateRequestBody(buildAllowedRequestBody({ requestId: 'req-\uD800-x', organization: { id: ORG } }))),
    }));

  it('store-persists-an-unpaired-surrogate is detected', () =>
    qualify<ProjectionModule>({
      id: 'store-persists-an-unpaired-surrogate',
      file: 'governance-store/projection.js',
      replacements: [['hasUnpairedSurrogate)(input.request.requestId)', 'hasUnpairedSurrogate)(input.request.requestId) && false']],
      guard: (m) => {
        try {
          m.buildGovernanceAggregate(appendInput('req-\uDC00-x'), { now: () => NOW, nextId: (prefix) => fresh(prefix), limits: m.DEFAULT_GOVERNANCE_STORE_LIMITS }, { chainPosition: 1 });
          return false;
        } catch (error) {
          return error instanceof GovernanceStoreError && error.code === 'GOVERNANCE_STORE_VALIDATION_ERROR';
        }
      },
    }));

  it('rule-refuses-nothing is detected', () =>
    qualify<IdentifiersModule>({
      id: 'rule-refuses-nothing',
      file: 'governed-action/identifiers.js',
      replacements: [['return UNPAIRED_SURROGATE.test(value);', 'return false;']],
      guard: (m) => MALFORMED.every(([, value]) => m.hasUnpairedSurrogate(value)) && WELL_FORMED.every(([, value]) => !m.hasUnpairedSurrogate(value)),
    }));

  it('rule-refuses-every-surrogate (would break astral identifiers) is detected', () =>
    qualify<IdentifiersModule>({
      id: 'rule-refuses-every-surrogate',
      file: 'governed-action/identifiers.js',
      replacements: [['return UNPAIRED_SURROGATE.test(value);', 'return /[\\uD800-\\uDFFF]/.test(value);']],
      guard: (m) => MALFORMED.every(([, value]) => m.hasUnpairedSurrogate(value)) && WELL_FORMED.every(([, value]) => !m.hasUnpairedSurrogate(value)),
    }));
});
