import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../../features/execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES } from '../../features/grant-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createAocKernel } from '../../kernel/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../kernel/reason-codes/reason-codes.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { CUSTOMER_IDENTITY_REFUSAL_REASON_VALUES, CUSTOMER_IDENTITY_UNAVAILABLE_REASON_VALUES } from '../customer-identity/index.js';
import { AUTHORITY_BINDING_REASON_CODE_VALUES } from '../execution-governance/index.js';
import { GOVERNED_ACTION_REASON_CODE_VALUES, GovernedActionConfigurationError } from '../governed-action/index.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID } from '../modules/governed-action-orchestrator-module.js';
import { EVALUATED_AT_POLICY, ALLOWED_INTENT, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * The composition hook (§41–42), legacy `POST /api/governance/evaluate` parity
 * (GOV-ACT-10), the one capability-gated customer route (GOV-ACT-11, narrowed
 * by P5), and the structural boundary of `src/enterprise/governed-action`
 * (§30, §31, §44).
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const SECRET = 'AOC_GOVERNED_ACTION_SECRET_SENTINEL_DO_NOT_USE';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];

const enterprises: AocEnterprise[] = [];
const stores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
});

function configuration(): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG });
  return { ...base, authentication: { apiKeys: KEYS } };
}

async function boundStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  stores.push(store);
  await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-1' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  return store;
}

async function options(): Promise<CreateEnterpriseOptions> {
  return {
    configuration: configuration(),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: await boundStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: createRecordingExecutionAdapter(),
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
  };
}

/** `options()` with one capability left out entirely — absent, not `undefined`. */
async function optionsWithout(key: 'governedActionOrchestrator' | 'customerIdentityAdmission' | 'authorityControlledExecution'): Promise<CreateEnterpriseOptions> {
  const { [key]: _omitted, ...rest } = await options();
  return rest;
}

async function track(pending: Promise<AocEnterprise>): Promise<AocEnterprise> {
  const enterprise = await pending;
  enterprises.push(enterprise);
  return enterprise;
}

async function rejectsWithCode(pending: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof GovernedActionConfigurationError, `expected GovernedActionConfigurationError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('Governed action composition (§41–42)', () => {
  it('is absent unless requested, and registers no module when absent', async () => {
    const plain = await track(createEnterprise(await optionsWithout('governedActionOrchestrator')));
    assert.equal(plain.governedActionOrchestrator, undefined);
    assert.equal(plain.modules().some((module) => module.id === GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID), false);

    const disabled = await track(createEnterprise({ ...(await options()), governedActionOrchestrator: { enabled: false, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY } }));
    assert.equal(disabled.governedActionOrchestrator, undefined);
  });

  it('composes from the Host’s own capabilities, end to end: admission → orchestrator → adapter', async () => {
    const enterprise = await track(createEnterprise(await options()));
    const orchestrator = enterprise.governedActionOrchestrator;
    assert.ok(orchestrator !== undefined);
    assert.ok(enterprise.modules().some((module) => module.id === GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID));
    assert.equal(enterprise.isReady(), true);

    const admitted = await enterprise.customerIdentityAdmission?.admit({ authorizationHeader: `Bearer ${SECRET}` });
    assert.ok(admitted?.status === 'bound');
    const result = await orchestrator.govern(admitted.identity, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', JSON.stringify(result));

    const record = await enterprise.persistence.getByRequestId({ system: true }, result.requestId ?? '');
    assert.equal(record?.request.actorId, PMFREAK_ACTOR_ID);
    assert.equal(record?.request.organizationId, ORG);
    assert.ok(record?.evaluation.resultPayload['grants'] !== undefined, 'the committed decision came from the grant-aware Kernel');
  });

  it('fails composition without customer identity admission', async () => {
    await rejectsWithCode(createEnterprise(await optionsWithout('customerIdentityAdmission')), 'GOVERNED_ACTION_CUSTOMER_IDENTITY_REQUIRED');
  });

  it('fails composition without Authority-Controlled Execution', async () => {
    await rejectsWithCode(createEnterprise(await optionsWithout('authorityControlledExecution')), 'GOVERNED_ACTION_EXECUTION_REQUIRED');
  });

  it('fails composition when the execution Kernel is host-supplied and cannot be proven grant-aware', async () => {
    const base = await options();
    const providers = buildTestKernelProviders();
    const notGrantAware = createAocKernel({ recognitionProvider: providers.recognitionProvider, clock: providers.clock, idGenerator: providers.idGenerator });
    await rejectsWithCode(
      createEnterprise({ ...base, authorityControlledExecution: { ...base.authorityControlledExecution!, kernel: notGrantAware } }),
      'GOVERNED_ACTION_KERNEL_NOT_PROVABLY_GRANT_AWARE',
    );
  });

  it('fails composition with a malformed trust domain or no grant policy — there is no default expiry', async () => {
    await rejectsWithCode(
      createEnterprise({ ...(await options()), governedActionOrchestrator: { enabled: true, trustDomainId: ' padded ', grantPolicy: EVALUATED_AT_POLICY } }),
      'GOVERNED_ACTION_CONFIGURATION_INVALID',
    );
    await rejectsWithCode(
      createEnterprise({
        ...(await options()),
        governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: undefined as unknown as typeof EVALUATED_AT_POLICY },
      }),
      'GOVERNED_ACTION_CONFIGURATION_INVALID',
    );
  });

  it('fails composition when the Governance Store cannot re-read, verify and reference decisions', async () => {
    const real = createInMemoryGovernanceStore();
    const crippled = { ...real, verify: undefined } as unknown as GovernanceStore;
    await rejectsWithCode(createEnterprise({ ...(await options()), persistence: crippled }), 'GOVERNED_ACTION_GOVERNANCE_STORE_UNAVAILABLE');
  });
});

describe('GOV-ACT-10: legacy POST /api/governance/evaluate is unchanged by composing the orchestrator', () => {
  async function evaluateTwice(enterprise: AocEnterprise) {
    const body = buildAllowedRequestBody({ organization: { id: ORG }, requestId: 'legacy-parity-1', requestedAt: '2026-01-01T00:00:00.000Z' });
    const first = await enterprise.evaluate(body, { authorizationHeader: `Bearer ${SECRET}`, idempotencyKey: 'legacy-key' });
    const replay = await enterprise.evaluate(body, { authorizationHeader: `Bearer ${SECRET}`, idempotencyKey: 'legacy-key' });
    const record = await enterprise.persistence.getByRequestId({ system: true }, 'legacy-parity-1');
    return { first, replay, record };
  }

  it('same request → same status, reason codes, record shape and idempotent replay, with or without the orchestrator', async () => {
    const withOrchestrator = await track(createEnterprise(await options()));
    const without = await track(createEnterprise({ configuration: configuration(), kernelProviders: buildTestKernelProviders() }));

    const a = await evaluateTwice(withOrchestrator);
    const b = await evaluateTwice(without);

    assert.equal(a.first.httpStatus, b.first.httpStatus);
    assert.equal(a.first.body.status, b.first.body.status);
    assert.deepEqual(a.first.body.reasonCodes, b.first.body.reasonCodes);
    assert.deepEqual(Object.keys(a.first.body).sort(), Object.keys(b.first.body).sort());
    assert.equal(a.replay.body.decisionId, a.first.body.decisionId, 'replay answers with the stored decision');
    assert.equal(b.replay.body.decisionId, b.first.body.decisionId);
    assert.ok(a.record !== null && b.record !== null);
    assert.deepEqual(Object.keys(a.record.evaluation.resultPayload).sort(), Object.keys(b.record.evaluation.resultPayload).sort());
    assert.equal(a.record.evaluation.resultPayload['grants'], undefined, 'the evaluate Kernel stays non-grant-aware');
    assert.deepEqual(
      a.record.events.map((event) => event.eventType),
      b.record.events.map((event) => event.eventType),
    );
    assert.equal(a.record.references.length, 0, 'evaluate never issues or references a grant');
  });
});

// ---------------------------------------------------------------------------

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

describe('Structural boundary of src/enterprise/governed-action (§30, §31, §44)', () => {
  const ROOT = 'src/enterprise/governed-action';
  const SOURCES = sourceFiles(ROOT);

  it('has real production sources to measure', () => {
    assert.ok(SOURCES.length >= 5, `expected sources under ${ROOT}, found ${SOURCES.length}`);
  });

  it('imports only identity types, Kernel contracts, the Governance Store, ACE, grant/execution/emergency-control runtime types and event infrastructure', () => {
    const allowed = new Set([
      '../../features/grant-runtime/index.js',
      '../../features/execution-runtime/index.js',
      // The operational interlock's **read** port and its reason-code
      // vocabulary. The orchestrator owns the admission checkpoint and the
      // ledger records which layer withheld an effect, so both need the
      // vocabulary; neither can reach a mutation, because the reader port
      // declares none (`emergency-control-boundaries.test.ts`).
      '../../features/emergency-control-runtime/index.js',
      // P7: the exercise-control **reason-code vocabulary** only, so the
      // evidence ledger can record `withheld:exercise-control:<CODE>…` against
      // a closed set. The orchestrator never holds the exercise-control
      // reservation store and never reserves, settles or releases —
      // `exercise-control-boundaries.test.ts` pins that.
      '../../features/exercise-control-runtime/index.js',
      // P8: the canonical authority event stream's **write-only** recorder,
      // type-only. The orchestrator reports facts after it has established
      // them and never reads the stream — every recorder method returns
      // `Promise<void>` and every call is wrapped so its failure changes no
      // result (`authority-event-stream-boundaries.test.ts` pins that). The
      // store, reader, verifier and projector are not reachable from here.
      '../authority-event-stream/recorder.js',
      // P9: the pure monetary primitive — the trusted asset registry, the
      // financial action classifier and the single amount ingress. Pure data
      // and logic with no imports of its own (`monetary-boundaries.test.ts`).
      '../../features/monetary-runtime/index.js',
      '../../kernel/index.js',
      '../customer-identity/index.js',
      '../events/enterprise-events.js',
      '../execution-governance/index.js',
      '../execution-governance/issuance-core.js',
      // P11: the execution outcome store's record types and its narrow
      // prepare / record / read port, type-only. The orchestrator is handed the
      // port by the composition root; it never opens, closes or constructs a
      // store, and nothing it reads there can permit a new effect
      // (`execution-outcome-boundaries.test.ts`).
      '../execution-outcome-store/contracts.js',
      '../execution-outcome-store/outcome-store.js',
      // P12: the resolution record type, the read-only reader and the
      // pre-claim binder, type-only. The orchestrator holds no resolution
      // authority and no reconciliation service, so replay can read a
      // resolution and can never ask for one
      // (`execution-reconciliation-boundaries.test.ts`).
      '../execution-resolution-store/contracts.js',
      '../execution-resolution-store/resolution-store.js',
      '../execution-reconciliation/binder.js',
      '../governance-store/contracts.js',
      '../governance-store/errors.js',
      '../governance-store/governance-store.js',
      '../governance-store/projection.js',
      '../governance-store/store-common.js',
      '../orchestration/governance-evaluation-events.js',
      'node:crypto',
    ]);
    for (const file of SOURCES) {
      for (const specifier of importsOf(file)) {
        assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports ${specifier}; the orchestrator may reach nothing else`);
      }
    }
  });

  it('never authenticates: no credential matching, bearer parsing, API keys or HTTP adapter', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/credential-matching/, /extractBearerToken|matchApiKey/, /EnterpriseApiKey/, /authorizationHeader/, /node-http-adapter|enterprise-server/, /customer-authenticator|admission-service/]) {
        assert.equal(pattern.test(text), false, `${file} must not reach ${String(pattern)}`);
      }
    }
  });

  it('reaches no provider, AI, filesystem, network, process or dynamic code', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [
        /pinata|stripe|xrpl|openai|anthropic|langchain/i,
        /node:fs|['"]fs['"]/,
        /child_process/,
        /node:net|node:http|node:https|node:dns/,
        /\bfetch\s*\(/,
        /\beval\s*\(/,
        /new\s+Function\s*\(/,
        /\bimport\s*\(/,
        /\brequire\s*\(/,
      ]) {
        assert.equal(pattern.test(text), false, `${file} must not have ${String(pattern)}`);
      }
    }
  });

  it('never constructs a privileged context: no `system: true` anywhere in the layer', () => {
    for (const file of SOURCES) {
      assert.equal(/system\s*:\s*true/.test(codeOf(file)), false, `${file} must never construct a system context`);
    }
  });

  it('never calls AocKernel.enforce() and never reproduces a policy decision', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      assert.equal(/\.enforce\s*\(/.test(text), false);
      assert.equal(/policy_allowed|policy_denied|evaluatePolicyForEnforcement|assessGrantEligibility/.test(text), false, `${file} must not decide`);
    }
  });

  it('reaches the adapter only through ACE exercise — it never calls an adapter itself', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      assert.equal(/\.execute\s*\(/.test(text), false, `${file} must not invoke an adapter directly`);
      assert.equal(/ExecutionAdapter\b/.test(text), false, `${file} must not hold an adapter`);
    }
  });

  it('keeps the issuance core internal: not re-exported from execution-governance or any public entrypoint', () => {
    for (const entry of ['src/enterprise/execution-governance/index.ts', 'src/enterprise/index.ts', 'src/index.ts']) {
      const text = codeOf(entry);
      assert.equal(/issuance-core|createAuthorityControlledIssuanceCore|issueFromDecision/.test(text), false, `${entry} must not expose the issuance core`);
    }
    const importers = sourceFiles('src')
      .filter((file) => !file.includes('__tests__') && !file.endsWith('issuance-core.ts'))
      .filter((file) => /issuance-core\.js/.test(codeOf(file)));
    assert.deepEqual(
      importers.map((file) => file.replaceAll('\\', '/')).sort(),
      [
        'src/enterprise/composition/composition-root.ts',
        'src/enterprise/execution-governance/service.ts',
        'src/enterprise/governed-action/decision-commit.ts',
        'src/enterprise/governed-action/orchestrator.ts',
      ],
    );
  });

  it('persist-before-grant is structural: only decision-commit evaluates and appends; only the orchestrator issues, from a VerifiedDecision', () => {
    const callers = (pattern: RegExp) => SOURCES.filter((file) => pattern.test(codeOf(file))).map((file) => file.replaceAll('\\', '/').split('/').pop()).sort();
    assert.deepEqual(callers(/\.evaluate\s*\(/), ['decision-commit.ts'], 'only the commit phase reaches the Kernel');
    assert.deepEqual(callers(/\.appendEvaluation\s*\(/), ['decision-commit.ts']);
    assert.deepEqual(callers(/\.verify\s*\(/), ['decision-commit.ts']);
    assert.deepEqual(callers(/\.issueFromDecision\s*\(/), ['orchestrator.ts']);
    assert.deepEqual(callers(/\.appendReference\s*\(/), ['execution-ledger.ts'], 'evidence is written in one place');
    const commit = codeOf(join(ROOT, 'decision-commit.ts'));
    const verifiedShape = commit.slice(commit.indexOf('export interface VerifiedDecision'), commit.indexOf('export type DecisionCommitOutcome'));
    assert.equal(/transient/.test(verifiedShape), false, 'a VerifiedDecision cannot carry the transient Kernel result');
    const orchestrator = codeOf(join(ROOT, 'orchestrator.ts'));
    assert.match(orchestrator, /issueFromDecision\(\{[^}]*decision:\s*persisted,/, 'issuance is handed the persisted decision');
    assert.equal(/transient/.test(orchestrator), false, 'the orchestrator never sees a transient decision');
  });

  it('the public entrypoint exports the orchestrator as types only', () => {
    const text = codeOf('src/enterprise/index.ts');
    const statements = [...text.matchAll(/export\s+(type\s+)?\{[^}]*\}\s*from\s*'\.\/governed-action\/index\.js'/g)];
    assert.ok(statements.length > 0);
    for (const statement of statements) assert.ok(statement[1] !== undefined, 'governed-action exports from the frozen entrypoint must be type-only');
  });

  it('keeps its reason vocabulary prefixed and disjoint from Kernel, CUSTOMER_*, grant, exercise and binding codes', () => {
    const own = [...GOVERNED_ACTION_REASON_CODE_VALUES];
    assert.equal(new Set(own).size, own.length);
    for (const code of own) assert.ok(code.startsWith('GOVERNED_ACTION_'), code);
    const others = new Set<string>([
      ...Object.values(AOC_KERNEL_REASON_CODES),
      ...CUSTOMER_IDENTITY_REFUSAL_REASON_VALUES,
      ...CUSTOMER_IDENTITY_UNAVAILABLE_REASON_VALUES,
      ...GRANT_REASON_CODE_VALUES,
      ...GRANT_EXERCISE_REASON_CODE_VALUES,
      ...AUTHORITY_BINDING_REASON_CODE_VALUES,
    ]);
    for (const code of own) assert.equal(others.has(code), false, `${code} collides with an existing vocabulary`);
  });
});

describe('GOV-ACT-11 (narrowed by P5): exactly one HTTP route reaches the orchestrator, and only through the customer-plane sequence', () => {
  const ADAPTER = 'src/enterprise/adapters/node-http-adapter.ts';
  const SEQUENCE = 'src/enterprise/orchestration/govern-governed-action-request.ts';

  it('the Node HTTP adapter reaches governed actions only through `enterprise.governAction`, gated on both capabilities', () => {
    const adapter = codeOf(ADAPTER);
    assert.equal((adapter.match(/url\.pathname === '\/api\/governed-actions'/g) ?? []).length, 1, 'one route, one literal');
    assert.match(adapter, /enterprise\.customerIdentityAdmission !== undefined && enterprise\.governedActionOrchestrator !== undefined \? enterprise\.governAction : undefined/);
    // Nothing below the application call is reachable from the transport.
    for (const pattern of [/\.govern\s*\(/, /\.admit\s*\(/, /governed-action\/|customer-identity\//, /execution-governance|grant-runtime|execution-runtime|emergency-control/, /\.exercise\s*\(|\.execute\s*\(|issueFromDecision|selectAdapter/]) {
      assert.equal(pattern.test(adapter), false, `the HTTP adapter must not reach ${String(pattern)}`);
    }
  });

  it('the application sequence admits, then calls govern() — and reaches nothing below the orchestrator', () => {
    const sequence = codeOf(SEQUENCE);
    assert.deepEqual([...importsOf(SEQUENCE)].sort(), [
      '../api/governed-action-contract.js',
      '../customer-identity/index.js',
      '../governed-action/index.js',
      '../telemetry/enterprise-logger.js',
    ]);
    assert.ok(sequence.indexOf('.admit(') < sequence.indexOf('.govern('), 'admission precedes govern()');
    assert.match(sequence, /if \(admitted\.status !== 'bound'\)/, 'only a bound identity proceeds');
    for (const pattern of [/\.evaluate\s*\(/, /\.exercise\s*\(|\.execute\s*\(/, /issue|selectAdapter|grantStore|emergencyControl/, /system\s*:\s*true/, /requireAuthentication/]) {
      assert.equal(pattern.test(sequence), false, `${SEQUENCE} must not reach ${String(pattern)}`);
    }
  });

  it('the frozen API surface lists the route once, as capability-gated — never as an unconditional probe', () => {
    const surface = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as {
      readonly routeLiterals: readonly string[];
      readonly probes: readonly { readonly path: string }[];
      readonly capabilityGatedProbes: readonly { readonly path: string; readonly requires: readonly string[] }[];
    };
    assert.equal(surface.routeLiterals.filter((route) => /governed/i.test(route)).length, 1);
    assert.ok(surface.routeLiterals.includes('/api/governed-actions'));
    assert.equal(surface.probes.some((probe) => /governed/i.test(probe.path)), false);
    const gated = surface.capabilityGatedProbes.find((probe) => probe.path === '/api/governed-actions');
    assert.ok(gated !== undefined);
    assert.deepEqual([...gated.requires].sort(), ['customerIdentityAdmission', 'governedActionOrchestrator']);
  });
});
