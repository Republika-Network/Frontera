import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { AUTHORITY_ARTIFACT_VERSION, createAuthorityArtifactVerifier, createExecutionCapabilityIssuancePolicy, createSoftwareAuthorityArtifactSigner, type AuthoritySignature } from '../authority-authenticity/index.js';
import { createExecutionCapabilityVerifier, executionCapabilityActionBindingDigest } from '../execution-capability/index.js';
import { ExecutionCapabilityIssuanceError, createExecutionCapabilityIssuer, openExecutionCapabilityIssuanceLedger } from '../execution-capability-issuance/index.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError, loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ADAPTER_ID, ADMIN, ORG, PAYABLES, PAYABLES_WORLD, SETTLE, TRUST_DOMAIN, Workspace, call, createContextTable, govern, governedFile, policyPackProvider, provision, secureEnv, settle, storedGrant } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * G-02B on the canonical shipped Host (production profile, SQLite, signed
 * grants under the Host's authority key, CORE-07 witness): the opt-in
 * `executionCapabilities` section composes an issuer over the authenticated
 * grant store, the software custody boundary built with the same policy and
 * the operator-initialized issuance ledger — and nothing else. No route, no
 * adapter, no response and no boot option carries or hands out a capability
 * or the issuer (G-02C connects a caller). That a real governed grant is
 * issuable is proven over the Host's own signed grant record, read from its
 * file, through the same issuer and custody rule with the Host's key.
 */

const ISSUER = 'frontera-deployment-g02b-host';
const AUDIENCE = 'executor-payables-gateway';
const BINDING_FORMAT = 'frontera.http-request-binding.v1';

const workspace = new Workspace();
after(() => workspace.cleanup());

function section(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { issuer: ISSUER, issuanceLedgerPath: join(dir, 'execution-capability-issuance.sqlite'), audiences: [{ audience: AUDIENCE, actions: [SETTLE], bindingFormats: [BINDING_FORMAT] }], ...overrides };
}

async function initializeLedger(dir: string, issuer = ISSUER): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer, clock: Date.now, create: true })).close();
}

async function bootWith(env: Record<string, string | undefined>) {
  const calls: ValidatedExecutionAction[] = [];
  const adapter: ExecutionAdapter = {
    adapterId: ADAPTER_ID,
    async execute(action) {
      calls.push(action);
      return { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
  const context = createContextTable();
  const host = workspace.track(
    await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], contextProvider: context.provider, policyPackProvider: policyPackProvider() }),
  );
  const { port } = await host.listen();
  return { host, calls, context, baseUrl: `http://127.0.0.1:${port}` };
}

describe('G-02B on the shipped Host — opt-in issuance over the governed grant', () => {
  it('composes with the section; a real governed grant and execution, as the Host signed and filed them, are issuable — and nothing is issued twice', async () => {
    const dir = workspace.dir();
    await initializeLedger(dir);
    const booted = await bootWith(secureEnv(dir, governedFile({ executionCapabilities: section(dir) })));
    // Boot succeeded: the composition bound the issuer (the Host refuses an unbound slot) over the authenticated store and the existing ledger.
    await provision(booted.host);
    booted.context.set(PAYABLES_WORLD);
    const reply = await govern(booted.baseUrl, settle());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(JSON.stringify(reply.body).toLowerCase().includes('capabilit'), false, 'the governed-action response carries no capability');
    const executionId = reply.body['executionId'] as string;
    const lookup = await call(booted.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN });
    assert.equal(lookup.status, 200, lookup.text);
    const grantId = lookup.body['grantId'] as string;

    // The grant exactly as the Host signed and filed it, read from its file the way a qualification reads evidence.
    const grant = storedGrant(dir, grantId);
    const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
    let storeId: string;
    let signature: AuthoritySignature;
    try {
      storeId = (db.prepare('SELECT store_id FROM bounded_grant_revocation_state WHERE singleton = 1').get() as { store_id: string }).store_id;
      const row = db.prepare('SELECT signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grants WHERE grant_id = ?').get(grantId) as { signature_algorithm: 'ed25519-v1'; signing_key_id: string; signature: string; signature_version: string };
      signature = { algorithm: row.signature_algorithm, keyId: row.signing_key_id, signature: row.signature, artifactVersion: row.signature_version };
    } finally {
      db.close();
    }
    assert.equal(signature.artifactVersion, AUTHORITY_ARTIFACT_VERSION);
    const policy = createExecutionCapabilityIssuancePolicy({ issuer: ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, lifetimeMs: 30_000, audiences: [{ audience: AUDIENCE, actions: [SETTLE], bindingFormats: [BINDING_FORMAT] }] });
    const ledger = await openExecutionCapabilityIssuanceLedger(join(dir, 'qualification-issuance.sqlite'), { issuer: ISSUER, clock: Date.now, create: true });
    try {
      const issuer = createExecutionCapabilityIssuer({
        grants: { readSigned: async (id: string) => (id === grantId ? { storeId, grant, signature } : { storeId }) },
        signer: createSoftwareAuthorityArtifactSigner({ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, executionCapabilityIssuance: policy }),
        verifier: createAuthorityArtifactVerifier([trustedKeyOf(AUTHORITY_KEY_A)]),
        policy,
        ledger,
      });
      const request = { method: 'POST', path: '/payables/settle', body: { invoiceTotal: 500, destination: 'supplier-x' } };
      const input = { executionId, boundedGrantId: grantId, audience: AUDIENCE, action: SETTLE, resource: PAYABLES, actionBinding: { format: BINDING_FORMAT, digest: executionCapabilityActionBindingDigest({ format: BINDING_FORMAT, value: request }) } };
      const issued = await issuer.issue(input);
      assert.equal(issued.capability.executionId, executionId, 'the governed path’s execution id is the one custody derives from the grant');
      assert.equal(issued.capability.subjectActorId, grant.subject);
      assert.equal(issued.capability.organizationId, ORG);
      assert.equal(issued.capability.trustDomain, TRUST_DOMAIN);
      const verifier = createExecutionCapabilityVerifier({ trustedIssuers: [{ issuer: ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }], executor: { audience: AUDIENCE, organizationIds: [ORG], trustDomain: TRUST_DOMAIN }, clock: Date.now });
      assert.equal(verifier.verify({ presentation: { capability: issued.canonical, signature: issued.signature }, action: SETTLE, resource: PAYABLES, actionBinding: { format: BINDING_FORMAT, value: request } }).verification, 'verified');
      await assert.rejects(issuer.issue(input), (error: unknown) => error instanceof ExecutionCapabilityIssuanceError && error.code === 'CAPABILITY_ALREADY_ISSUED');
      await assert.rejects(issuer.issue({ ...input, executionId: 'aoc.exec:00000000000000000000000000000000' }), (error: unknown) => error instanceof ExecutionCapabilityIssuanceError && error.rule === 'EXECUTION_DERIVATION_MISMATCH');
    } finally {
      ledger.close();
    }
    // No HTTP surface exists for any of it.
    for (const path of ['/api/execution-capabilities', '/api/governed-actions/capability', '/api/admin/execution-capabilities']) {
      const answer = await call(booted.baseUrl, 'POST', path, { authorization: ADMIN, body: { executionId } });
      assert.ok(answer.status >= 400, `${path}: ${answer.status}`);
    }
  });

  it('a Host without the section is unchanged: no issuer is composed and no ledger is touched', async () => {
    const dir = workspace.dir();
    const booted = await bootWith(secureEnv(dir));
    assert.equal(existsSync(join(dir, 'execution-capability-issuance.sqlite')), false);
    assert.equal(booted.host.posture.governedActions, 'composed');
  });
});

describe('G-02B on the shipped Host — configuration and composition refusals', () => {
  async function refused(env: Record<string, string | undefined>): Promise<unknown> {
    try {
      await bootWith(env);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('a missing issuance ledger refuses startup — it is never created by the Host', async () => {
    const dir = workspace.dir();
    const error = await refused(secureEnv(dir, governedFile({ executionCapabilities: section(dir) })));
    assert.ok(error instanceof Error && /never recreated implicitly/.test(error.message), String(error));
    assert.equal(existsSync(join(dir, 'execution-capability-issuance.sqlite')), false);
  });

  it('a ledger recorded for another issuer refuses startup', async () => {
    const dir = workspace.dir();
    await initializeLedger(dir, 'frontera-deployment-other');
    const error = await refused(secureEnv(dir, governedFile({ executionCapabilities: section(dir) })));
    assert.ok(error instanceof Error && /another issuer/.test(error.message), String(error));
  });

  const invalid: readonly [string, (dir: string) => Record<string, unknown>][] = [
    ['an extra key', (dir) => section(dir, { organizationId: 'org-other' })],
    ['no issuer', (dir) => Object.fromEntries(Object.entries(section(dir)).filter(([key]) => key !== 'issuer'))],
    ['a wildcard audience', (dir) => section(dir, { audiences: [{ audience: '*', actions: [SETTLE], bindingFormats: [BINDING_FORMAT] }] })],
    ['an action that is not routed', (dir) => section(dir, { audiences: [{ audience: AUDIENCE, actions: ['launch-rocket'], bindingFormats: [BINDING_FORMAT] }] })],
    ['no audiences', (dir) => section(dir, { audiences: [] })],
    ['a lifetime above 60 s', (dir) => section(dir, { lifetimeMs: 60_001 })],
    ['a null lifetime', (dir) => section(dir, { lifetimeMs: null })],
    ['no ledger path', (dir) => Object.fromEntries(Object.entries(section(dir)).filter(([key]) => key !== 'issuanceLedgerPath'))],
  ];
  for (const [name, build] of invalid) {
    it(`refuses ${name} (HOST_GOVERNED_ACTIONS_FILE_INVALID)`, async () => {
      const dir = workspace.dir();
      await initializeLedger(dir);
      const error = await refused(secureEnv(dir, governedFile({ executionCapabilities: build(dir) })));
      assert.ok(error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID', String(error));
    });
  }

  it('memory persistence cannot issue, in any profile — the G-02B rule itself refuses (HOST_PERSISTENCE_NOT_DURABLE)', () => {
    const dir = workspace.dir();
    // A non-secure profile, so the secure profile's own sqlite rule cannot be what refuses.
    const env = { ...secureEnv(dir, governedFile({ executionCapabilities: section(dir) })), AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' };
    assert.throws(() => loadEnterpriseHostConfiguration(env), (error: unknown) => error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_PERSISTENCE_NOT_DURABLE' && /executionCapabilities requires/.test(error.message));
    assert.doesNotThrow(() => loadEnterpriseHostConfiguration({ ...env, AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite' }), 'the same development configuration over sqlite is accepted');
  });
});
