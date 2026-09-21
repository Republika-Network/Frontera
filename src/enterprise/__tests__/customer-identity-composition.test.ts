import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import {
  CUSTOMER_IDENTITY_REFUSAL_REASON_VALUES,
  CUSTOMER_IDENTITY_UNAVAILABLE_REASON_VALUES,
  CustomerIdentityConfigurationError,
} from '../customer-identity/index.js';
import { AUTHORITY_BINDING_REASON_CODE_VALUES } from '../execution-governance/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../../features/execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES } from '../../features/grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../kernel/reason-codes/reason-codes.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * The composition hook, IDENTITY-10 and IDENTITY-12, and the structural
 * boundary of `src/enterprise/customer-identity`.
 */

const ORG = 'org-acme';
const SUBJECT = { system: 'example-app', subjectId: 'user-42' } as const;
const SECRET = 'AOC_CUSTOMER_COMPOSITION_SECRET_SENTINEL_DO_NOT_USE';
const LEGACY = 'AOC_CUSTOMER_COMPOSITION_LEGACY_SENTINEL_DO_NOT_USE';

const CUSTOMER_KEYS: readonly EnterpriseApiKey[] = [
  { key: LEGACY, organizationId: ORG },
  { key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } },
];

const enterprises: AocEnterprise[] = [];
const stores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
});

function configurationWith(apiKeys: readonly EnterpriseApiKey[], env: Readonly<Record<string, string>> = {}): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    ...env,
  });
  return { ...base, authentication: { apiKeys } };
}

async function boundStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  stores.push(store);
  await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-1' },
    { actorId: 'actor-acme', type: 'agent', displayName: 'Acme agent', externalSubject: SUBJECT },
  );
  return store;
}

async function track(pending: Promise<AocEnterprise>): Promise<AocEnterprise> {
  const enterprise = await pending;
  enterprises.push(enterprise);
  return enterprise;
}

async function rejectsWithCode(pending: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CustomerIdentityConfigurationError, `expected CustomerIdentityConfigurationError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
}

describe('Customer identity composition hook', () => {
  it('is absent unless requested, and changes nothing when absent', async () => {
    const enterprise = await track(createEnterprise({ configuration: configurationWith(CUSTOMER_KEYS), kernelProviders: buildTestKernelProviders() }));
    assert.equal(enterprise.customerIdentityAdmission, undefined);

    const disabled = await track(
      createEnterprise({ configuration: configurationWith(CUSTOMER_KEYS), kernelProviders: buildTestKernelProviders(), customerIdentityAdmission: { enabled: false } }),
    );
    assert.equal(disabled.customerIdentityAdmission, undefined);
  });

  it('composes over the Kernel Authority store and admits the bound actor', async () => {
    const enterprise = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );
    const admission = enterprise.customerIdentityAdmission;
    assert.ok(admission !== undefined);
    assert.equal(admission.organizationId, ORG);

    const result = await admission.admit({ authorizationHeader: `Bearer ${SECRET}` });
    assert.equal(result.status, 'bound');
    if (result.status === 'bound') assert.equal(result.identity.actor.actorId, 'actor-acme');
  });

  it('fails composition when no Kernel Authority store exists — there is no second binding source to fall back to', async () => {
    await rejectsWithCode(
      createEnterprise({ configuration: configurationWith(CUSTOMER_KEYS), kernelProviders: buildTestKernelProviders(), customerIdentityAdmission: { enabled: true } }),
      'CUSTOMER_IDENTITY_AUTHORITY_UNAVAILABLE',
    );
  });

  it('fails composition when no credential is customer-plane eligible', async () => {
    await rejectsWithCode(
      createEnterprise({
        configuration: configurationWith([{ key: LEGACY, organizationId: ORG }, { key: SECRET }]),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
      'CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL',
    );
  });

  it('fails composition for a customer credential of an organization this instance does not serve', async () => {
    await rejectsWithCode(
      createEnterprise({
        configuration: configurationWith([{ key: SECRET, organizationId: 'org-beta', customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }]),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
      'CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED',
    );
  });

  it('fails composition for an unscoped customer credential', async () => {
    await rejectsWithCode(
      createEnterprise({
        configuration: configurationWith([{ key: SECRET, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }]),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
      'CUSTOMER_IDENTITY_CREDENTIAL_UNSCOPED',
    );
  });

  it('never inherits the legacy authentication switch: with AOC_ENTERPRISE_REQUIRE_AUTH off, a caller without a credential is still refused', async () => {
    const configuration = configurationWith(CUSTOMER_KEYS, { AOC_ENTERPRISE_REQUIRE_AUTH: 'false' });
    assert.equal(configuration.features.requireAuthentication, false);
    const enterprise = await track(
      createEnterprise({ configuration, kernelProviders: buildTestKernelProviders(), kernelAuthorityStore: await boundStore(), customerIdentityAdmission: { enabled: true } }),
    );
    assert.deepEqual(await enterprise.customerIdentityAdmission?.admit({}), { status: 'refused', reason: 'CUSTOMER_AUTH_REQUIRED' });
  });

  it('never exposes customer identity metadata or credentials through the public configuration', async () => {
    const enterprise = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );
    const serialized = JSON.stringify(enterprise.configuration);
    for (const needle of [SECRET, LEGACY, 'principal-1', 'user-42', 'customerIdentity']) {
      assert.equal(serialized.includes(needle), false, `public configuration exposed ${needle}`);
    }
    assert.deepEqual(Object.keys(enterprise.configuration.authentication).sort(), ['apiKeyCount', 'apiKeyOrganizationScopes', 'requireAuthentication']);
  });
});

describe('IDENTITY-10: admission grants no authority and makes no decision', () => {
  it('admitting callers commits no Governance Record and produces no Kernel decision', async () => {
    const enterprise = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );
    const everything = { system: true } as const;
    const before = await enterprise.persistence.query(everything, {});

    for (const header of [undefined, 'garbage', `Bearer ${LEGACY}`, `Bearer ${SECRET}`]) {
      await enterprise.customerIdentityAdmission?.admit(header === undefined ? {} : { authorizationHeader: header });
    }

    const afterwards = await enterprise.persistence.query(everything, {});
    assert.equal(before.records.length, 0);
    assert.deepEqual(afterwards.records, before.records, 'admission must never write a Governance Record');
  });
});

describe('IDENTITY-12: existing v1 routes are unchanged by this capability', () => {
  it('evaluate() answers identically with and without customer identity admission composed', async () => {
    const plain = await track(createEnterprise({ configuration: configurationWith(CUSTOMER_KEYS), kernelProviders: buildTestKernelProviders() }));
    const composed = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );

    const without = await plain.evaluate(buildAllowedRequestBody({ requestId: 'req-customer-identity-compat' }));
    const withAdmission = await composed.evaluate(buildAllowedRequestBody({ requestId: 'req-customer-identity-compat' }));

    assert.equal(withAdmission.httpStatus, without.httpStatus);
    assert.equal(withAdmission.body.status, without.body.status);
    assert.deepEqual(withAdmission.body.reasonCodes, without.body.reasonCodes);
    assert.equal(withAdmission.body.status, 'allowed');
  });

  it('legacy authentication on evaluate() is untouched: a customer-plane key still authenticates there as the scoped key it always was', async () => {
    const enterprise = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS, { AOC_ENTERPRISE_REQUIRE_AUTH: 'true' }),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );

    await assert.rejects(enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-legacy-auth-missing' })));
    const legacy = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-legacy-auth-legacy' }), { authorizationHeader: `Bearer ${LEGACY}` });
    assert.equal(legacy.body.status, 'allowed');
  });

  it('on its own adds no HTTP route: the one customer route needs the orchestrator too', async () => {
    // Since P5, `POST /api/governed-actions` consumes admission — but only when
    // the Governed Action Orchestrator is composed as well. Admission alone
    // mounts nothing and exposes no application call.
    const enterprise = await track(
      createEnterprise({
        configuration: configurationWith(CUSTOMER_KEYS),
        kernelProviders: buildTestKernelProviders(),
        kernelAuthorityStore: await boundStore(),
        customerIdentityAdmission: { enabled: true },
      }),
    );
    assert.ok(enterprise.customerIdentityAdmission !== undefined);
    assert.equal(enterprise.governAction, undefined);

    const adapter = readFileSync('src/enterprise/adapters/node-http-adapter.ts', 'utf8');
    assert.match(
      adapter,
      /enterprise\.customerIdentityAdmission !== undefined && enterprise\.governedActionOrchestrator !== undefined \? enterprise\.governAction : undefined/,
      'the governed-action route must be gated on BOTH capabilities',
    );
    // The adapter never admits a caller itself: admission runs inside `governAction`.
    for (const needle of ['customer-identity', '.admit(', 'BoundCustomerIdentity', '/api/customer-identity', '/api/grants']) {
      assert.equal(adapter.includes(needle), false, `the HTTP adapter must not reference ${needle}`);
    }
    const surface = readFileSync('release/api-surface.v1.json', 'utf8');
    for (const needle of ['customer-identity', '/api/grants']) {
      assert.equal(surface.includes(needle), false, `the frozen v1 API surface must not list ${needle}`);
    }
  });
});

describe('Structural — the customer-identity layer admits; it cannot decide, provision or execute', () => {
  const ROOT = 'src/enterprise/customer-identity';

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

  const SOURCES = sourceFiles(ROOT);

  it('has real production sources to measure', () => {
    assert.ok(SOURCES.length >= 6, `expected production sources under ${ROOT}, found ${SOURCES.length}`);
  });

  it('imports only configuration types, the canonical credential matcher, the Kernel Authority store type and itself', () => {
    const allowed = new Set([
      '../configuration/enterprise-configuration.js',
      '../orchestration/credential-matching.js',
      '../kernel-authority/kernel-authority-store.js',
    ]);
    for (const file of SOURCES) {
      for (const specifier of importsOf(file)) {
        assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports ${specifier}; the admission layer may reach nothing else`);
      }
    }
  });

  it('reaches no Kernel, grant, execution, policy, provisioning or provider code', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [
        /AocKernel/,
        /\.evaluate\s*\(/,
        /\.enforce\s*\(/,
        /grant-runtime|execution-runtime|execution-governance|bounded-grant/,
        /issueGrant|revokeGrant|\.exercise\s*\(|\.execute\s*\(/,
        /provisioning-service|provisionActor|provisionPassport|provisionCapabilityToken|provisionAuthorityGrant|provisionDelegationGrant|appendEvent|\.revoke\s*\(/,
        /PolicyPack|policyPack|registerPolicy/,
        /pinata|stripe|xrpl|openai|anthropic|langchain/i,
      ]) {
        assert.equal(pattern.test(text), false, `${file} must not reach ${String(pattern)}`);
      }
    }
  });

  it('has no I/O, network, process or dynamic-code capability of its own', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/node:fs|['"]fs['"]/, /child_process/, /node:net|node:http|node:https|node:dns/, /\bfetch\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/]) {
        assert.equal(pattern.test(text), false, `${file} must not have ${String(pattern)}`);
      }
    }
  });

  it('never constructs a privileged context: no `system: true` anywhere in the layer', () => {
    for (const file of SOURCES) {
      assert.equal(/system\s*:\s*true/.test(codeOf(file)), false, `${file} must never construct or claim a system context`);
    }
  });

  it('never compares credentials itself — the canonical constant-time matcher is the only comparison', () => {
    const authenticator = codeOf(join(ROOT, 'customer-authenticator.ts'));
    assert.match(authenticator, /import\s*\{\s*extractBearerToken,\s*matchApiKey\s*\}\s*from\s*'\.\.\/orchestration\/credential-matching\.js'/);
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/createHash/, /timingSafeEqual/, /\.key\s*===|===\s*[a-zA-Z.]*\.key\b/, /\.key\s*!==|\.key\b\s*\)/, /apiKeys\.find\(/, /localeCompare/]) {
        assert.equal(pattern.test(text), false, `${file} must not compare credentials itself (${String(pattern)})`);
      }
    }
  });

  it('never mentions an Agent Passport as a caller credential', () => {
    for (const file of SOURCES) {
      assert.equal(/passport/i.test(codeOf(file)), false, `${file} must keep passports out of caller authentication`);
    }
  });

  it('keeps its reason vocabulary prefixed and disjoint from every Kernel, obligation, issuance, exercise and binding code', () => {
    const own = [...CUSTOMER_IDENTITY_REFUSAL_REASON_VALUES, ...CUSTOMER_IDENTITY_UNAVAILABLE_REASON_VALUES];
    assert.equal(new Set(own).size, own.length);
    for (const code of own) assert.ok(code.startsWith('CUSTOMER_'), `${code} must carry the CUSTOMER_ prefix`);
    const others = new Set<string>([
      ...Object.values(AOC_KERNEL_REASON_CODES),
      ...GRANT_REASON_CODE_VALUES,
      ...GRANT_EXERCISE_REASON_CODE_VALUES,
      ...AUTHORITY_BINDING_REASON_CODE_VALUES,
      'DENIED',
      'INDETERMINATE',
      'denied',
      'indeterminate',
    ]);
    for (const code of own) assert.equal(others.has(code), false, `${code} collides with an existing vocabulary`);
  });
});
