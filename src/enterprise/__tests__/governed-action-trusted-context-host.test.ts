import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextResolutionDigest } from '../../features/context-resolution-runtime/index.js';
import { grantSourceDigest } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { GovernedActionConfigurationError } from '../governed-action/errors.js';
import {
  ADAPTER_ID,
  ADMIN,
  CUSTOMER_DATA,
  EXPORT,
  GOVERNANCE,
  PAYABLES_WORLD,
  READ,
  TRUSTED_CONTEXT,
  Workspace,
  boot,
  call,
  committedRecord,
  createContextTable,
  govern,
  governedFile,
  policyPackProvider,
  provision,
  secureEnv,
  settle,
  assertDenied,
  storedGrant,
  type Reading,
} from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * CORE-04 §92 / §93 / §52–§58 / §96 — trusted facts on the **canonical shipped
 * Host** (`bootEnterpriseHost()`, production profile, SQLite, signed grants,
 * a real listener). Every request crosses the real HTTP route, the real
 * customer admission, the one grant-aware Kernel (Trusted Context Boundary →
 * deterministic policy → decision), the Governance Store commit, signed grant
 * issuance, the exercise gate and the one adapter call site. The adapter's
 * call count is the proof of what reached execution.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

async function host() {
  const context = createContextTable();
  const dir = workspace.dir();
  const booted = await boot(workspace, secureEnv(dir), { context });
  await provision(booted.host);
  return { ...booted, context, dir };
}

describe('CORE-04 §92 — trusted facts reach policy and authorize through the one governed path', () => {
  it('fresh facts from the sources authorized to attest them: admitted → policy → decision → signed grant → exercise → one adapter call', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD);
    const reply = await govern(baseUrl, settle());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls.length, 1);

    // The provider was asked for exactly the profile's declared keys, in the request's organization — nothing else.
    const query = context.queries.at(-1);
    assert.deepEqual(query?.keys, ['destination.registered', 'invoice.amount', 'invoice.exists', 'signal.thresholdCircumvention']);
    assert.equal(query?.organizationId, 'org-core04');

    // The committed decision records what was admitted — provenance, never values — and the digest of it.
    const record = await committedRecord(booted, reply);
    const result = toKernelEvaluationResult(record) as unknown as Record<string, unknown>;
    const context04 = result['context'] as Record<string, unknown>;
    assert.equal(context04['resolved'], true);
    assert.match(context04['digest'] as string, /^sha256:[0-9a-f]{64}$/);
    assert.match(context04['profile'] as string, /^invoice-settlement@1#sha256:/);
    const facts = context04['facts'] as readonly Record<string, unknown>[];
    assert.deepEqual(facts.map((fact) => [fact['key'], fact['sourceId']]), [
      ['destination.registered', 'wallet-registry'],
      ['invoice.amount', 'erp-primary'],
      ['invoice.exists', 'erp-primary'],
    ]);
    for (const fact of facts) {
      assert.equal('value' in fact, false, 'values never enter the record');
      assert.match(fact['provenanceDigest'] as string, /^sha256:/);
    }
    assert.equal(JSON.stringify(context04).includes('"value"'), false, 'no fact value anywhere in the committed context evaluation');
  });

  it('negative sibling — the same fact and value from a source not authorized for it: not admitted, no authority, zero adapter calls', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    const variants: readonly [readonly Reading[], string][] = [
      [[{ key: 'invoice.exists', value: true, sourceId: 'random-api' }, ...PAYABLES_WORLD.slice(1)], 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
      [[{ key: 'invoice.exists', value: true, sourceId: 'wallet-registry' }, ...PAYABLES_WORLD.slice(1)], 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
      // §54: the ERP is authorized for invoice.* — not for destination.registered.
      [[...PAYABLES_WORLD.slice(0, 2), { key: 'destination.registered', value: true, sourceId: 'erp-primary' }], 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
    ];
    for (const [readings, code] of variants) {
      context.set(readings);
      await assertDenied(booted, await govern(baseUrl, settle()), code);
    }
    assert.equal(calls.length, 0);
  });
});

describe('CORE-04 §93 — stale context: same action, source, value and provenance; only the time changes', () => {
  it('fresh executes; exactly on the boundary and beyond it fail closed; a future-dated reading is refused — no sleeps', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    const withInvoiceAge = (ageSeconds: number): readonly Reading[] => [{ key: 'invoice.exists', value: true, sourceId: 'erp-primary', ageSeconds }, ...PAYABLES_WORLD.slice(1)];

    context.set(withInvoiceAge(899));
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed');
    assert.equal(calls.length, 1);

    for (const ageSeconds of [900, 3600]) {
      context.set(withInvoiceAge(ageSeconds));
      await assertDenied(booted, await govern(baseUrl, settle()), 'CONTEXT_REQUIRED_FACT_STALE', `${ageSeconds}s`);
    }
    context.set(withInvoiceAge(-60));
    await assertDenied(booted, await govern(baseUrl, settle()), 'CONTEXT_REQUIRED_FACT_TIME_INVALID');
    assert.equal(calls.length, 1, 'no stale or impossible fact reached execution');
  });
});

describe('CORE-04 §52 — required fact match proof: facts inform deterministic policy, and the proposal and the attestation stay distinct', () => {
  it('each negative variant fails closed with its own reason, and none reaches the adapter', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    const cases: readonly [string, readonly Reading[], Record<string, unknown>, string][] = [
      ['invoice missing', PAYABLES_WORLD.slice(1), settle(), 'CONTEXT_REQUIRED_FACT_UNRESOLVED'],
      ['invoice attested as not existing', [{ key: 'invoice.exists', value: false, sourceId: 'erp-primary' }, ...PAYABLES_WORLD.slice(1)], settle(), 'INVOICE_NOT_FOUND'],
      ['wrong amount (proposed 500, attested 400)', [PAYABLES_WORLD[0] as Reading, { key: 'invoice.amount', value: 400, sourceId: 'erp-primary' }, PAYABLES_WORLD[2] as Reading], settle(500), 'INVOICE_AMOUNT_MISMATCH'],
      ['destination not registered', [...PAYABLES_WORLD.slice(0, 2), { key: 'destination.registered', value: false, sourceId: 'wallet-registry' }], settle(), 'DESTINATION_NOT_REGISTERED'],
      ['unauthorized source', [{ key: 'invoice.exists', value: true, sourceId: 'random-api' }, ...PAYABLES_WORLD.slice(1)], settle(), 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
      ['stale fact', [{ key: 'invoice.exists', value: true, sourceId: 'erp-primary', ageSeconds: 7200 }, ...PAYABLES_WORLD.slice(1)], settle(), 'CONTEXT_REQUIRED_FACT_STALE'],
      ['invalid provenance', [{ key: 'invoice.amount', value: 500, sourceId: 'erp-primary', tamper: { value: 5 } }, PAYABLES_WORLD[0] as Reading, PAYABLES_WORLD[2] as Reading], settle(5), 'CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID'],
      ['malformed value', [PAYABLES_WORLD[0] as Reading, { key: 'invoice.amount', value: 500, sourceId: 'erp-primary', tamper: { value: 500.5 } }, PAYABLES_WORLD[2] as Reading], settle(), 'CONTEXT_REQUIRED_FACT_MALFORMED'],
      ['conflicting trusted sources', [...PAYABLES_WORLD, { key: 'invoice.exists', value: false, sourceId: 'erp-secondary' }], settle(), 'CONTEXT_REQUIRED_FACT_CONFLICTED'],
      ['a reading claiming another organization', [{ key: 'invoice.exists', value: true, sourceId: 'erp-primary', organizationId: 'org-other' }, ...PAYABLES_WORLD.slice(1)], settle(), 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
    ];
    for (const [name, readings, intent, code] of cases) {
      context.set(readings);
      await assertDenied(booted, await govern(baseUrl, intent), code, name);
    }
    assert.equal(calls.length, 0);

    // And the positive: every fact admitted and consistent → executed once.
    context.set(PAYABLES_WORLD);
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed');
    assert.equal(calls.length, 1);
  });

  it('duplicate readings change nothing: same decision, the same three admitted facts — nothing multiplied, nothing reordered', async () => {
    const { host: booted, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD);
    const once = await govern(baseUrl, settle());
    context.set([...PAYABLES_WORLD, ...PAYABLES_WORLD].reverse());
    const twice = await govern(baseUrl, settle());
    assert.equal(once.body['status'], 'executed');
    assert.equal(twice.body['status'], 'executed');
    // Each request resolves at its own instant, so compare what was admitted, not when.
    const admitted = async (reply: typeof once) =>
      (toKernelEvaluationResult(await committedRecord(booted, reply)).context?.facts ?? []).map((fact) => [fact.key, fact.sourceId, fact.reference, fact.resolution]);
    assert.deepEqual(await admitted(twice), await admitted(once));
    assert.equal((await admitted(twice)).length, 3);
  });
});

describe('CORE-04 §58 / §28 — context smuggling: nothing a caller sends can occupy or shadow an admitted fact', () => {
  it('a declared fact class, any case of it, or a reserved namespace in assertedContext is refused before any decision', async () => {
    const { calls, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD);
    for (const assertedContext of [
      { 'invoice.exists': true },
      { 'INVOICE.EXISTS': true },
      { 'Invoice.Amount': 500 },
      { 'aoc.context': { facts: [] } },
      { 'AOC.CONTEXT.facts': [] },
      { 'aoc.obligations': {} },
      { recordCount: 1 },
      { invoiceTotal: 1 },
    ]) {
      const reply = await govern(baseUrl, { ...settle(), assertedContext });
      assert.equal(reply.body['status'], 'rejected', `${JSON.stringify(assertedContext)} → ${reply.text}`);
      assert.equal(reply.body['decision'], undefined);
    }
    assert.equal(calls.length, 0);
  });

  it('nested, trusted-looking or metadata-shaped assertions satisfy nothing: with no trusted reading the request still fails closed', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD.slice(1));
    const smuggled = {
      meta: { 'invoice.exists': true, trusted: true, trustClass: 'attested', source: 'erp-primary', provenance: 'verified' },
      contextFacts: [{ factClass: 'invoice.exists', value: true }],
      metadata: { 'aoc.context': { facts: [{ key: 'invoice.exists', value: true, sourceId: 'erp-primary' }] } },
    };
    await assertDenied(booted, await govern(baseUrl, { ...settle(), assertedContext: smuggled }), 'CONTEXT_REQUIRED_FACT_UNRESOLVED');
    assert.equal(calls.length, 0);
  });

  it('duplicate JSON keys: the parser keeps one value, and it is still only an asserted claim — refused by name', async () => {
    const { calls, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD.slice(1));
    const reply = await call(baseUrl, 'POST', '/api/governed-actions', {
      authorization: 'Bearer FRONTERA_CORE04_AGENT_KEY_SENTINEL_4c19e2',
      rawBody: '{"action":"settle-invoice","resource":"payables-ledger","idempotencyKey":"core04-dup-json","parameters":{"invoiceTotal":500,"destination":"supplier-x"},"assertedContext":{"note":"a","note":"b","invoice.exists":false,"invoice.exists":true}}',
    });
    assert.equal(reply.body['status'], 'rejected', reply.text);
    assert.equal(calls.length, 0);
  });
});

describe('CORE-04 §96 — same resource, read vs export: the action changes which trusted facts are material', () => {
  it('read needs an open support case; export needs an approved destination and confirmed residency — all through the boundary', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    const read = { action: READ, resource: CUSTOMER_DATA, parameters: { recordCount: 10 } };
    const exportIntent = { action: EXPORT, resource: CUSTOMER_DATA, parameters: { recordCount: 10 } };

    context.set([{ key: 'supportCase.open', value: true, sourceId: 'support-desk' }]);
    assert.equal((await govern(baseUrl, read)).body['status'], 'executed');
    await assertDenied(booted, await govern(baseUrl, exportIntent), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', 'the read’s fact is not the export’s');
    assert.deepEqual(context.queries.at(-1)?.keys, ['dataResidency.compliant', 'exportDestination.approved']);

    context.set([
      { key: 'exportDestination.approved', value: true, sourceId: 'dlp-gateway' },
      { key: 'dataResidency.compliant', value: false, sourceId: 'dlp-gateway' },
    ]);
    await assertDenied(booted, await govern(baseUrl, exportIntent), 'EXPORT_RESIDENCY_UNCONFIRMED');

    context.set([
      { key: 'exportDestination.approved', value: true, sourceId: 'dlp-gateway' },
      { key: 'dataResidency.compliant', value: true, sourceId: 'dlp-gateway' },
    ]);
    assert.equal((await govern(baseUrl, exportIntent)).body['status'], 'executed');
    context.set([{ key: 'supportCase.open', value: false, sourceId: 'support-desk' }]);
    await assertDenied(booted, await govern(baseUrl, read), 'READ_WITHOUT_SUPPORT_CASE');
    assert.equal(calls.length, 2);
  });
});

describe('CORE-04 §42 / §43 / §46 / §76 — admitted context is bound to the decision and the signed grant', () => {
  it('the grant’s signed sourceDigest commits to the admitted-context digest, and its validity is capped at the earliest material fact’s staleness', async () => {
    const dir = workspace.dir();
    const context = createContextTable();
    const booted = await boot(workspace, secureEnv(dir), { context });
    await provision(booted.host);
    // invoice.exists read 600 s ago with a 900 s bound: stale in 300 s — long before the Host's 3600 s grant lifetime.
    context.set([{ key: 'invoice.exists', value: true, sourceId: 'erp-primary', ageSeconds: 600 }, ...PAYABLES_WORLD.slice(1)]);
    const reply = await govern(booted.baseUrl, settle());
    assert.equal(reply.body['status'], 'executed', reply.text);
    const record = await committedRecord(booted.host, reply);
    const decision = toKernelEvaluationResult(record);
    assert.ok(decision.context?.digest !== undefined && decision.context.validUntil !== undefined);

    const lookup = await call(booted.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
    const grant = storedGrant(dir, lookup.body['grantId'] as string);

    // §46: the grant cannot outlive the context it relied on.
    assert.equal(Date.parse(grant.expiresAt) <= Date.parse(decision.context.validUntil), true, `grant ${grant.expiresAt} must not outlive its context (${decision.context.validUntil})`);
    assert.equal(Date.parse(decision.context.validUntil) - Date.parse(decision.evaluatedAt) <= 300_000, true);

    // §76: recompute the source from the committed decision alone. The signed
    // grant's sourceDigest equals it *with* the admitted-context digest, and
    // differs from it without — so the signature covers the context.
    const request = record.request.requestPayload as unknown as KernelEvaluationRequest;
    const source = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), request, decision);
    assert.equal(source.contextDigest, decision.context.digest);
    assert.equal(grant.sourceDigest, grantSourceDigest(source));
    const { contextDigest: _dropped, ...withoutContext } = source;
    assert.notEqual(grant.sourceDigest, grantSourceDigest(withoutContext));
  });

  it('materially different admitted context → a different context digest → a different grant source digest, for the same action and parameters', async () => {
    const { host: booted, baseUrl, context, dir } = await host();
    const sourceDigestOf = async (reply: { body: Record<string, unknown> }) => {
      const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
      return storedGrant(dir, lookup.body['grantId'] as string).sourceDigest;
    };
    context.set(PAYABLES_WORLD);
    const first = await govern(baseUrl, settle());
    context.set(PAYABLES_WORLD.map((reading) => ({ ...reading, reference: `${reading.sourceId}:${reading.key}:another-record` })));
    const second = await govern(baseUrl, settle());
    assert.equal(first.body['status'], 'executed');
    assert.equal(second.body['status'], 'executed');
    const firstDigest = (toKernelEvaluationResult(await committedRecord(booted, first)) as unknown as { context: { digest: string } }).context.digest;
    const secondDigest = (toKernelEvaluationResult(await committedRecord(booted, second)) as unknown as { context: { digest: string } }).context.digest;
    assert.notEqual(firstDigest, secondDigest, 'another provenance reference is another admitted context');
    assert.notEqual(await sourceDigestOf(first), await sourceDigestOf(second));
    assert.equal(typeof grantSourceDigest, 'function');
    assert.equal(typeof contextResolutionDigest, 'function');
  });

  it('the decision, its admitted-context digest and the signed grant verify across a restart', async () => {
    const dir = workspace.dir();
    const context = createContextTable();
    const first = await boot(workspace, secureEnv(dir), { context });
    await provision(first.host);
    context.set(PAYABLES_WORLD);
    const reply = await govern(first.baseUrl, settle());
    assert.equal(reply.body['status'], 'executed');
    const before = toKernelEvaluationResult(await committedRecord(first.host, reply)) as unknown as { context: { digest: string } };
    await first.host.close();
    const second = await boot(workspace, secureEnv(dir), { context });
    const afterRestart = toKernelEvaluationResult(await committedRecord(second.host, reply)) as unknown as { context: { digest: string } };
    assert.equal(afterRestart.context.digest, before.context.digest);
    const lookup = await call(second.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
    const view = await call(second.baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(lookup.body['grantId'] as string)}`, { authorization: ADMIN });
    assert.equal(view.status, 200, view.text);
  });
});

const STUB_ADAPTER = { adapterId: ADAPTER_ID, execute: () => Promise.resolve({ outcome: 'completed' as const }) };

describe('CORE-04 §66 / §67 / §101 — startup: no default trust, no fallback, refusal before listen', () => {
  const refusesToBoot = async (file: Record<string, unknown>, withProvider = true, withPolicy = true, code?: string) => {
    const context = createContextTable();
    await assert.rejects(
      async () => bootEnterpriseHost({ env: await withDeploymentWitness(secureEnv(workspace.dir(), file)), executionAdapters: [STUB_ADAPTER], ...(withProvider ? { contextProvider: context.provider } : {}), ...(withPolicy ? { policyPackProvider: policyPackProvider() } : {}) }),
      (error: unknown) =>
        (error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID' && (code === undefined || error.message.includes(code))) ||
        (error instanceof GovernedActionConfigurationError && (code === undefined || error.code === code)),
    );
  };
  const sources = TRUSTED_CONTEXT.sources;

  it('refuses a profile that declares facts with no trusted source registry at all', async () => {
    const file = governedFile();
    delete file['trustedContext'];
    await refusesToBoot(file, true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_REQUIRED');
  });

  it('refuses a declared fact no source may attest, an attestation of an undeclared fact, and a source for another organization', async () => {
    await refusesToBoot(governedFile({ trustedContext: { sources: sources.filter((source) => source.sourceId !== 'wallet-registry') } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INCOMPLETE');
    await refusesToBoot(governedFile({ trustedContext: { sources: [...sources, { sourceId: 'extra', kind: 'erp', name: 'x', trustClass: 'authoritative', organizationId: 'org-core04', attests: [{ factClass: 'invoice.paid', maxAgeSeconds: 60 }] }] } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID');
    await refusesToBoot(governedFile({ trustedContext: { sources: [...sources.slice(1), { ...sources[0], organizationId: 'org-b' }] } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID');
  });

  it('refuses a requester-kind or asserted source, an attestation without a freshness bound, duplicates and unknown keys', async () => {
    const first = sources[0];
    for (const bad of [
      { ...first, kind: 'request' },
      { ...first, trustClass: 'asserted' },
      { ...first, attests: [{ factClass: 'invoice.exists' }] },
      { ...first, attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 0 }] },
      { ...first, attests: [] },
      { ...first, trusted: true },
      { ...first, sourceId: 'ERP-PRIMARY'.toLowerCase().toUpperCase() },
    ]) {
      const replaced = [bad, ...sources.slice(1)];
      const withDuplicate = bad.sourceId === 'ERP-PRIMARY' ? [...sources, bad] : replaced;
      await refusesToBoot(governedFile({ trustedContext: { sources: withDuplicate } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID');
    }
    await refusesToBoot(governedFile({ trustedContext: { sources, maxFutureSkewSeconds: 3600 } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID');
  });

  it('CORE-04 review: refuses an `attested` source — the Host composes no attestation verifier, and a reference alone is not attestation', async () => {
    for (const kind of ['signed_attestation', 'erp']) {
      await refusesToBoot(governedFile({ trustedContext: { sources: [{ ...sources[0], kind, trustClass: 'attested' }, ...sources.slice(1)] } }), true, true, 'GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID');
    }
  });

  it('refuses facts declared with no context provider, or with no policy to decide with them — never healthy-and-proceeding', async () => {
    await assert.rejects(
      async () => bootEnterpriseHost({ env: await withDeploymentWitness(secureEnv(workspace.dir())), executionAdapters: [STUB_ADAPTER], policyPackProvider: policyPackProvider() }),
      (error: unknown) => error instanceof GovernedActionConfigurationError && error.code === 'GOVERNED_ACTION_TRUSTED_CONTEXT_REQUIRED',
    );
    await assert.rejects(
      async () => bootEnterpriseHost({ env: await withDeploymentWitness(secureEnv(workspace.dir())), executionAdapters: [STUB_ADAPTER], contextProvider: createContextTable().provider }),
      (error: unknown) => error instanceof GovernedActionConfigurationError && error.code === 'GOVERNED_ACTION_CONTEXT_POLICY_REQUIRED',
    );
  });

  it('a Host whose profiles declare no facts needs none of it, and says so', async () => {
    const withoutFacts = {
      ...GOVERNANCE,
      profiles: (GOVERNANCE.profiles ?? []).map((profile) => ({ ...profile, materialFacts: [], restrictiveFacts: undefined, obligations: undefined })).map(({ restrictiveFacts: _r, obligations: _o, ...rest }) => rest),
    };
    const file = governedFile({ governance: withoutFacts });
    delete file['trustedContext'];
    delete file['obligations'];
    const booted = await boot(workspace, secureEnv(workspace.dir(), file), { policy: null });
    assert.equal(booted.host.posture.trustedContext, 'not-configured');
    assert.equal(booted.host.posture.obligations, 'not-configured');
  });

  it('§68 / §102 — the posture reports what was composed', async () => {
    const booted = await boot(workspace, secureEnv(workspace.dir()), { context: createContextTable() });
    assert.equal(booted.host.posture.trustedContext, 'composed');
    assert.equal(booted.host.posture.obligations, 'durable');
    const health = await call(booted.baseUrl, 'GET', '/health');
    const posture = health.body['posture'] as Record<string, unknown>;
    assert.equal(posture['trustedContext'], 'composed');
    assert.equal(posture['obligations'], 'durable');
    assert.equal(JSON.stringify(health.body).includes('erp-primary'), false, 'no source identity or configuration leaks into health');
  });
});
