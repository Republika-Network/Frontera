import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { AuthorityAuthenticityConfigurationError } from '../authority-authenticity/errors.js';
import { createEnterprise, getInternalEnterpriseConfiguration } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, toPublicEnterpriseConfiguration, validateEnterpriseEnvironment } from '../configuration/enterprise-configuration.js';
import { loadEnterpriseHostConfiguration, isEnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, authorityAuthenticityEnv, openDurableStore, trustedKeyOf } from './authority-authenticity-fixture.js';
import { SIGNER_TOKEN, externalCustodyEnv, startInProcessSigner, withoutSoftwareCustody } from './core02-external-signer-fixture.js';
import { secureEnv } from './core04-host-fixture.js';
import { buildTestKernelProviders } from './support.js';
import { freshnessEnv, witnessKey } from './core07-freshness-fixture.js';

/** CORE-07: a secure profile also requires a freshness witness. Configuration only — never contacted here. */
const WITNESS_CONFIGURATION = freshnessEnv({ endpoint: 'https://witness.internal.example', witnessId: 'witness-config-only', publicKeyPem: witnessKey().publicKeyPem });

/**
 * CORE-02 — configuration: one custody, stated explicitly; the external mode
 * cannot carry, load or silently ignore a private key; nothing secret reaches a
 * public surface; composition proves the signer's identity before any store is
 * opened, and never falls back.
 */

const work = mkdtempSync(join(tmpdir(), 'frontera-core02-config-'));
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

const PEM_LINE = (AUTHORITY_KEY_A.privateKeyPem.split('\n')[1] ?? '').trim();
const external = (extra: Record<string, string> = {}) => externalCustodyEnv({ endpoint: 'http://127.0.0.1:65000', keyId: AUTHORITY_KEY_A.keyId }, [trustedKeyOf(AUTHORITY_KEY_A)], extra);

function dir(name: string): string {
  return mkdtempSync(join(work, `${name}-`));
}

function sqliteEnv(directory: string): Record<string, string> {
  return {
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_SQLITE_PATH: join(directory, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(directory, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(directory, 'assurance.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(directory, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(directory, 'emergency.sqlite'),
  };
}

function compose(configuration: ReturnType<typeof loadEnterpriseConfiguration>, grantStore?: Awaited<ReturnType<typeof openDurableStore>>) {
  return createEnterprise({
    configuration,
    kernelProviders: buildTestKernelProviders(),
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: createRecordingExecutionAdapter(),
      resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      ...(grantStore !== undefined ? { grantStore } : {}),
    },
  });
}

describe('CORE-02 — external mode never parses, stores or ignores a private key', () => {
  it('loadEnterpriseConfiguration in external mode does not read the private key into configuration — it records only that one was present', () => {
    const configuration = loadEnterpriseConfiguration({ ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem });
    assert.equal(configuration.authorityAuthenticity.mode, 'external');
    assert.equal('signingKeyPem' in configuration.authorityAuthenticity, false, 'no private-key field exists in external mode');
    assert.equal(JSON.stringify(configuration).includes(PEM_LINE), false, 'the key is nowhere in the configuration object');
    assert.equal(configuration.authorityAuthenticity.mode === 'external' && configuration.authorityAuthenticity.conflictingSigningKeyPresent, true);
    const clean = loadEnterpriseConfiguration(external());
    assert.equal(clean.authorityAuthenticity.mode === 'external' && clean.authorityAuthenticity.conflictingSigningKeyPresent, false);
  });

  it('absent mode is software — the historical shape, unchanged — and external is only ever selected explicitly', () => {
    const software = loadEnterpriseConfiguration(authorityAuthenticityEnv());
    assert.equal(software.authorityAuthenticity.mode, undefined);
    assert.equal(software.authorityAuthenticity.mode !== 'external' && software.authorityAuthenticity.signingKeyPem, AUTHORITY_KEY_A.privateKeyPem);
  });

  it('the strict environment reading refuses every ambiguous or contradictory custody, naming variables and never values', () => {
    const problems = (env: Record<string, string | undefined>) => validateEnterpriseEnvironment(env).join(' ');
    const cases: readonly [string, Record<string, string | undefined>, RegExp][] = [
      ['external + a private key', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem }, /AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM must not be set/],
      ['external + an empty private key variable', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: '' }, /AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM must not be set/],
      ['external without an endpoint', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: undefined }, /requires AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT/],
      ['external without a credential', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: undefined }, /requires AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN/],
      ['external with a short credential', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: 'short-secret' }, /AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN/],
      ['external without an expected key identity', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: undefined }, /requires AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID/],
      ['external without trusted verification keys', { ...external(), AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: undefined }, /requires AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS/],
      ['external over plain http beyond loopback', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'http://signer.internal.example:7443' }, /non-loopback/],
      ['external with credentials in the URL', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'https://user:pass@signer.example' }, /no credentials, path, query or fragment/],
      ['external with a path', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'https://signer.example/v1/sign' }, /no credentials, path, query or fragment/],
      ['external with an out-of-range timeout', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS: '0' }, /TIMEOUT_MS must be an integer from 1 to 60000/],
      ['external with unbounded attempts', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS: '10' }, /MAX_ATTEMPTS must be 1, 2 or 3/],
      ['external with an out-of-range probe interval', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: '60001' }, /PROBE_INTERVAL_MS must be an integer from 0 to 60000/],
      ['external with a non-numeric probe interval', { ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: '-1' }, /PROBE_INTERVAL_MS must be an integer from 0 to 60000/],
      ['software + a probe interval', { ...authorityAuthenticityEnv(), AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: '0' }, /Refusing to guess/],
      ['software + an external endpoint only', { ...authorityAuthenticityEnv(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'https://signer.example' }, /Refusing to guess/],
      ['no mode + an external credential', { AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: SIGNER_TOKEN }, /Refusing to guess/],
      ['an unknown mode', { AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'hsm' }, /must be one of: software, external/],
      ['an auto mode', { AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'auto' }, /must be one of: software, external/],
    ];
    for (const [label, env, expected] of cases) {
      const text = problems(env);
      assert.match(text, expected, label);
      assert.equal(text.includes(PEM_LINE) || text.includes(SIGNER_TOKEN) || text.includes('user:pass'), false, `${label}: no value is echoed`);
    }
    assert.deepEqual(validateEnterpriseEnvironment(external()), [], 'a complete external configuration is accepted');
    assert.deepEqual(validateEnterpriseEnvironment({ ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'https://signer.internal.example:8443' }), []);
  });

  it('the secure Host accepts external custody with no private key, and refuses it with one — before anything is composed', () => {
    const host = dir('secure');
    const env = { ...withoutSoftwareCustody(secureEnv(host)), ...external(), ...WITNESS_CONFIGURATION };
    const configuration = loadEnterpriseHostConfiguration(env);
    assert.equal(configuration.configuration.authorityAuthenticity.mode, 'external');
    assert.throws(
      () => loadEnterpriseHostConfiguration({ ...env, AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem }),
      (error: unknown) => isEnterpriseHostConfigurationError(error) && error.code === 'HOST_ENVIRONMENT_INVALID' && /must not be set/.test(error.message) && !error.message.includes(PEM_LINE),
    );
    // The secure profile still requires *a* signer: neither custody configured is refused.
    assert.throws(() => loadEnterpriseHostConfiguration(withoutSoftwareCustody(secureEnv(dir('none')))), (error: unknown) => isEnterpriseHostConfigurationError(error) && error.code === 'HOST_AUTHORITY_SIGNING_KEY_REQUIRED');
    // And software custody is still accepted where it was (development embedding, and deployments that choose it).
    assert.equal(loadEnterpriseHostConfiguration({ ...secureEnv(dir('software')), ...WITNESS_CONFIGURATION }).configuration.authorityAuthenticity.mode, undefined);
  });

  it('public configuration exposes mode, key id, algorithm material and the endpoint origin — never the credential, the private key, or an endpoint path', () => {
    const published = toPublicEnterpriseConfiguration(loadEnterpriseConfiguration({ ...external({ AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'https://signer.internal.example:8443' }) }));
    const text = JSON.stringify(published);
    assert.equal(published.authorityAuthenticity.signerMode, 'external');
    assert.equal(published.authorityAuthenticity.signingKeyConfigured, false);
    assert.deepEqual(published.authorityAuthenticity.externalSigner, { origin: 'https://signer.internal.example:8443', timeoutMs: 2000, maxAttempts: 1, probeIntervalMs: 0, credentialConfigured: true });
    for (const secret of [SIGNER_TOKEN, 'PRIVATE KEY', 'credential"', 'signingKeyPem', 'conflictingSigningKeyPresent']) assert.equal(text.includes(secret), false, secret);
    const software = toPublicEnterpriseConfiguration(loadEnterpriseConfiguration(authorityAuthenticityEnv()));
    assert.equal(software.authorityAuthenticity.signerMode, 'software');
    assert.equal(JSON.stringify(software).includes(PEM_LINE), false);
  });
});

describe('CORE-02 — composition: identity before stores, no fallback, no mixed custody', () => {
  it('an unreachable external signer refuses the Host before a single store file exists — and never falls back to a software key', async () => {
    const directory = dir('unreachable');
    await assert.rejects(
      () => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...external() })),
      (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && error.reason === 'EXTERNAL_SIGNER_UNREACHABLE',
    );
    assert.deepEqual(readdirSync(directory), [], 'nothing was opened');
  });

  it('a configuration object carrying both custodies is refused, even when built by hand', async () => {
    const directory = dir('both');
    const base = loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...external() });
    const both = { ...base, authorityAuthenticity: { ...base.authorityAuthenticity, signingKeyPem: AUTHORITY_KEY_A.privateKeyPem } } as unknown as typeof base;
    await assert.rejects(() => compose(both), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /no mixed or fallback mode/.test(error.message) && !error.message.includes(PEM_LINE));
    const flagged = loadEnterpriseConfiguration({ ...sqliteEnv(dir('flagged')), ...external(), AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: AUTHORITY_KEY_A.privateKeyPem });
    await assert.rejects(() => compose(flagged), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /no mixed or fallback mode/.test(error.message));
  });

  it('a host-supplied grant store signed in-process is refused under external custody (CORE-02R — every supplied authority store is)', async () => {
    const directory = dir('mixed');
    const softwareStore = await openDurableStore(join(work, 'mixed-supplied.sqlite'));
    cleanups.push(() => softwareStore.close());
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...external() }), softwareStore), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /no mixed custody/.test(error.message));
    assert.deepEqual(readdirSync(directory), [], 'refused before anything was opened');
  });

  it('a composed external Host reports external custody, holds no private key, and degrades — never fails — when the signer goes away', async () => {
    const signer = await startInProcessSigner(AUTHORITY_KEY_A);
    const directory = dir('composed');
    const configuration = loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...externalCustodyEnv({ endpoint: signer.endpoint, keyId: AUTHORITY_KEY_A.keyId }, [trustedKeyOf(AUTHORITY_KEY_A), trustedKeyOf(AUTHORITY_KEY_B)]) });
    const enterprise = await compose(configuration);
    cleanups.push(() => enterprise.close());
    await enterprise.start();
    assert.equal(enterprise.configuration.authorityAuthenticity.signerMode, 'external');
    const internal = getInternalEnterpriseConfiguration(enterprise);
    assert.equal(internal !== undefined && 'signingKeyPem' in internal.authorityAuthenticity, false, 'the full internal configuration has no private-key field');
    const healthy = await enterprise.health();
    assert.equal(healthy.posture?.authoritySigner, 'external');
    assert.equal(healthy.authoritySigner?.custody, 'external');
    assert.equal(healthy.authoritySigner?.state, 'ready');
    assert.deepEqual(await signer.counts(), { signGrant: 0, signRevocation: 0, signRevocationState: 1, signObligationDischargeState: 0, signApprovalState: 0 }, 'genesis signed externally; the health probe signed nothing');

    await signer.close();
    const degraded = await enterprise.health();
    assert.equal(degraded.authoritySigner?.state, 'unavailable');
    assert.equal(degraded.authoritySigner?.reason, 'EXTERNAL_SIGNER_UNREACHABLE');
    assert.equal(degraded.status, 'degraded', 'reads still verify locally; only new authority cannot be signed');
    assert.equal(enterprise.isReady(), true);
    const text = JSON.stringify(degraded);
    for (const secret of [SIGNER_TOKEN, 'PRIVATE KEY']) assert.equal(text.includes(secret), false, secret);
  });
});
