import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { isEnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { externalCustodyEnv, startInProcessSigner, withoutSoftwareCustody } from './core02-external-signer-fixture.js';
import { Workspace, createContextTable, secureEnv } from './core04-host-fixture.js';
import { approvalPolicy, approvalsFile } from './core05-host-fixture.js';
import { buildTestKernelProviders } from './support.js';

/**
 * CORE-02R D — the canonical Host's "no authority private key in this process"
 * claim is about the **process**, not about the configuration map it was
 * handed. `bootEnterpriseHost({ env })` reads configuration from `env`; the
 * real `process.env` may still carry `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`.
 * Under external custody the Host must refuse that before listen.
 *
 * This file mutates `process.env`, so it is its own test file (its own test
 * process under `node --test`), every mutation is restored in `afterEach`, and
 * no assertion message or error ever carries the fixture key.
 */

const VARIABLE = 'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM';
const PEM_LINE = (AUTHORITY_KEY_A.privateKeyPem.split('\n')[1] ?? '').trim();
const workspace = new Workspace();
const cleanups: (() => Promise<void>)[] = [];
let saved: { readonly present: boolean; readonly value: string | undefined };

beforeEach(() => {
  saved = { present: Object.prototype.hasOwnProperty.call(process.env, VARIABLE), value: process.env[VARIABLE] };
});
afterEach(() => {
  if (saved.present) process.env[VARIABLE] = saved.value;
  else delete process.env[VARIABLE];
});
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  await workspace.cleanup();
});

function bootRaw(env: Record<string, string | undefined>) {
  return bootEnterpriseHost({
    env,
    executionAdapters: [{ adapterId: 'test.recording', execute: async () => ({ outcome: 'completed', providerRef: 'never' }) }],
    contextProvider: createContextTable().provider,
    policyPackProvider: approvalPolicy(),
  });
}

async function cleanExternalEnv(dir: string) {
  const service = await startInProcessSigner(AUTHORITY_KEY_A);
  cleanups.push(() => service.close());
  const env = { ...withoutSoftwareCustody(secureEnv(dir, approvalsFile())), ...externalCustodyEnv({ endpoint: service.endpoint, keyId: AUTHORITY_KEY_A.keyId }, [trustedKeyOf(AUTHORITY_KEY_A)]) };
  assert.equal(VARIABLE in env, false, 'the supplied map is sanitized');
  return { env, service };
}

const refusedForProcessEnv = (error: unknown) => {
  assert.ok(isEnterpriseHostConfigurationError(error), 'a Host configuration refusal');
  assert.equal(error.code, 'HOST_ENVIRONMENT_INVALID');
  assert.match(error.message, /process environment/);
  assert.ok(error.message.includes(VARIABLE));
  assert.equal(error.message.includes(PEM_LINE), false, 'the key is never echoed');
  return true;
};

describe('CORE-02R D — the canonical external Host refuses a private-key variable in the REAL process environment, even when options.env is sanitized', () => {
  it('dirty process.env + sanitized options.env → refused before composition: nothing opened, no signer contacted, no socket', async () => {
    const dir = workspace.dir();
    const { env, service } = await cleanExternalEnv(dir);
    process.env[VARIABLE] = AUTHORITY_KEY_A.privateKeyPem;
    await assert.rejects(() => bootRaw(env), refusedForProcessEnv);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.sqlite')), [], 'refused before any store file was opened');
    assert.deepEqual(await service.counts(), { signGrant: 0, signRevocation: 0, signRevocationState: 0, signObligationDischargeState: 0, signApprovalState: 0 }, 'nothing was signed');
  });

  it('presence is enough: an empty value is refused too', async () => {
    const { env } = await cleanExternalEnv(workspace.dir());
    process.env[VARIABLE] = '';
    await assert.rejects(() => bootRaw(env), refusedForProcessEnv);
  });

  it('with the real process environment clean, the same sanitized map boots — the refusal is caused by the process variable alone', async () => {
    const { env } = await cleanExternalEnv(workspace.dir());
    delete process.env[VARIABLE];
    const host = await bootRaw(env);
    cleanups.push(() => host.close());
    assert.equal(host.posture.authoritySigner, 'external');
  });

  it('software custody is unaffected by the process variable (it makes no external claim)', async () => {
    process.env[VARIABLE] = AUTHORITY_KEY_A.privateKeyPem;
    const host = await bootRaw(secureEnv(workspace.dir(), approvalsFile()));
    cleanups.push(() => host.close());
    assert.equal(host.posture.authoritySigner, 'software');
  });

  it('createEnterprise is the embedding surface: it judges the configuration it is handed, not the process it runs in (the process claim belongs to the Host)', async () => {
    const service = await startInProcessSigner(AUTHORITY_KEY_A);
    cleanups.push(() => service.close());
    process.env[VARIABLE] = AUTHORITY_KEY_A.privateKeyPem;
    const enterprise = await createEnterprise({
      configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_LOG_LEVEL: 'error', ...externalCustodyEnv({ endpoint: service.endpoint, keyId: AUTHORITY_KEY_A.keyId }, [trustedKeyOf(AUTHORITY_KEY_A)]) }),
      kernelProviders: buildTestKernelProviders(),
    });
    cleanups.push(() => enterprise.close());
    assert.equal(enterprise.configuration.authorityAuthenticity.signerMode, 'external');
  });

  it('the restore discipline holds: the variable is gone from this process after each test', () => {
    assert.equal(process.env[VARIABLE], saved.value);
  });
});
