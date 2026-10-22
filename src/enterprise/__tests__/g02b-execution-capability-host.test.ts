import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createExecutionCapabilityVerifier, executionCapabilityActionBindingDigest } from '../execution-capability/index.js';
import { ExecutionCapabilityIssuanceError, createExecutionCapabilityIssuerSlot, openExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuerSlot } from '../execution-capability-issuance/index.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ADAPTER_ID, ADMIN, ORG, PAYABLES, PAYABLES_WORLD, SETTLE, TRUST_DOMAIN, Workspace, call, createContextTable, govern, governedFile, policyPackProvider, provision, secureEnv, settle } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * G-02B on the canonical shipped Host (production profile, SQLite, signed
 * grants under the Host's authority key, CORE-07 witness): the opt-in
 * `executionCapabilities` section composes an issuer over the authenticated
 * grant store, the software custody boundary built with the same policy and
 * the operator-initialized issuance ledger — and nothing else. No route, no
 * adapter, no response carries a capability; the issuer is reachable only
 * through the in-process slot (G-02C's caller, a test here).
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

async function bootWith(env: Record<string, string | undefined>, slot?: ExecutionCapabilityIssuerSlot) {
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
    await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], contextProvider: context.provider, policyPackProvider: policyPackProvider(), ...(slot !== undefined ? { executionCapabilityIssuer: slot } : {}) }),
  );
  const { port } = await host.listen();
  return { host, calls, context, baseUrl: `http://127.0.0.1:${port}` };
}

describe('G-02B on the shipped Host — opt-in issuance over the governed grant', () => {
  it('issues a capability for an executed governed action’s own grant and execution; the executor verifier accepts it; nothing is issued twice', async () => {
    const dir = workspace.dir();
    await initializeLedger(dir);
    const slot = createExecutionCapabilityIssuerSlot();
    const booted = await bootWith(secureEnv(dir, governedFile({ executionCapabilities: section(dir) })), slot);
    assert.equal(slot.bound(), true);
    await provision(booted.host);
    booted.context.set(PAYABLES_WORLD);
    const reply = await govern(booted.baseUrl, settle());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(JSON.stringify(reply.body).includes('capability'), false, 'the governed-action response carries no capability');
    const executionId = reply.body['executionId'] as string;
    const lookup = await call(booted.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN });
    assert.equal(lookup.status, 200, lookup.text);
    const grantId = lookup.body['grantId'] as string;

    const request = { method: 'POST', path: '/payables/settle', body: { invoiceTotal: 500, destination: 'supplier-x' } };
    const input = { executionId, boundedGrantId: grantId, audience: AUDIENCE, action: SETTLE, resource: PAYABLES, actionBinding: { format: BINDING_FORMAT, digest: executionCapabilityActionBindingDigest({ format: BINDING_FORMAT, value: request }) } };
    const issued = await slot.issue(input);
    assert.equal(issued.capability.issuer, ISSUER);
    assert.equal(issued.capability.organizationId, ORG);
    assert.equal(issued.capability.trustDomain, TRUST_DOMAIN);
    assert.equal(issued.capability.issuerKeyId, AUTHORITY_KEY_A.keyId);
    const verifier = createExecutionCapabilityVerifier({ trustedIssuers: [{ issuer: ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }], executor: { audience: AUDIENCE, organizationIds: [ORG], trustDomain: TRUST_DOMAIN }, clock: Date.now });
    assert.equal(verifier.verify({ presentation: { capability: issued.canonical, signature: issued.signature }, action: SETTLE, resource: PAYABLES, actionBinding: { format: BINDING_FORMAT, value: request } }).verification, 'verified');
    assert.equal(slot.inspect(executionId), 'issued');
    await assert.rejects(slot.issue(input), (error: unknown) => error instanceof ExecutionCapabilityIssuanceError && error.code === 'CAPABILITY_ALREADY_ISSUED');
    // Another execution id for the same grant is refused in custody's rule: the execution is the grant's own.
    await assert.rejects(slot.issue({ ...input, executionId: 'aoc.exec:00000000000000000000000000000000' }), (error: unknown) => error instanceof ExecutionCapabilityIssuanceError && error.rule === 'EXECUTION_DERIVATION_MISMATCH');
    // No HTTP surface was added for any of it.
    for (const path of ['/api/execution-capabilities', '/api/governed-actions/capability', '/api/admin/execution-capabilities']) {
      const answer = await call(booted.baseUrl, 'POST', path, { authorization: ADMIN, body: input });
      assert.ok(answer.status >= 400 && !answer.text.includes(issued.capability.capabilityId), `${path}: ${answer.status}`);
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
  async function refused(env: Record<string, string | undefined>, slot?: ExecutionCapabilityIssuerSlot): Promise<unknown> {
    try {
      await bootWith(env, slot);
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

  it('memory persistence cannot issue (HOST_PERSISTENCE_NOT_DURABLE)', async () => {
    const dir = workspace.dir();
    const error = await refused({ ...secureEnv(dir, governedFile({ executionCapabilities: section(dir) })), AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' });
    assert.ok(error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_PERSISTENCE_NOT_DURABLE', String(error));
  });

  it('an embedder slot without the section is refused (HOST_COMPOSITION_INCOMPLETE)', async () => {
    const dir = workspace.dir();
    const error = await refused(secureEnv(dir), createExecutionCapabilityIssuerSlot());
    assert.ok(error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_COMPOSITION_INCOMPLETE', String(error));
  });
});
