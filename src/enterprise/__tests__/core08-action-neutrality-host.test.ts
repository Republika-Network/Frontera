import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GRANT_EXERCISE_REASON_CODES as E, type GrantExerciseRequest, type ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { GovernedParameter } from '../../features/governed-parameter-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { AocKernel, type KernelEvaluationRequest } from '../../kernel/index.js';
import { EXECUTION_OUTCOME_STORE_SCHEMA_VERSION } from '../execution-outcome-store/contracts.js';
import { ADMIN, AGENT_KEY, Workspace, call, nextKey, storedGrant, type Reply } from './core04-host-fixture.js';
import {
  AGENT,
  CLUSTER,
  CUSTOMER_RECORDS,
  DATA_HTTP,
  DATA_TOKEN,
  DEPLOY,
  DEVOPS_HTTP,
  DEVOPS_KEY,
  DEVOPS_WORLD,
  EVERY_WORLD,
  EXPORT,
  EXPORT_WORLD,
  ORG,
  OTHER_RECORDS,
  PAYEE,
  READ,
  READ_WORLD,
  TRANSFER,
  TREASURY_ACCOUNT,
  TREASURY_CEILING,
  TREASURY_HTTP,
  TREASURY_TOKEN,
  TREASURY_WORLD,
  bootReferenceHost,
  deploy,
  exportRecords,
  read,
  transfer,
  withFact,
  without,
  type ReferenceHost,
} from './core08-reference-domains-fixture.js';

/**
 * CORE-08 — Action-Neutrality Qualification: **GOVERNED ACTION THESIS**.
 *
 * One `bootEnterpriseHost()` in the `production` secure profile (SQLite
 * everywhere, Ed25519-signed grants, the external authority-state witness,
 * P7, P11, emergency control), one listener, one Kernel, one policy runtime,
 * one governed-action pipeline — and three materially different reference
 * domains in the same configuration world at the same time:
 *
 * | domain | action × resource | material bound | trusted facts |
 * | --- | --- | --- | --- |
 * | TREASURY | transfer-funds × treasury account | `amount` ≤ P10 ceiling (P9 money) | invoice approved, payee approved |
 * | DEVOPS | deploy-release × production cluster | `replicaCount` ≤, `deploymentStrategy` = | change window open, rollback available |
 * | DATA | read / export × customer records | `recordCount` ≤ (+ `exportFormat` = on export) | support case (read); destination + residency (export) |
 *
 * Every request goes through `POST /api/governed-actions`. Every refusal
 * asserts that no adapter ran; every success asserts exactly one adapter call
 * and the exact `ValidatedExecutionAction` it received, then the exact wire
 * request the production Generic HTTP adapter core built from it (behind a
 * fake network runtime — see the fixture: this is not a real-provider run).
 *
 * **Revoked mid-flight** uses the CORE-06 stranded-grant technique, per
 * domain: an adapter-scoped emergency stop on *that domain's* adapter strands
 * a genuine issued grant after issuance, P7 reservation and every exercise
 * check; the grant is revoked through the administration API; the exercise
 * gate re-reads the authoritative store and withholds. A control per domain
 * shows the same stranded grant executes when nothing changed.
 *
 * Every matrix cell is recorded as it is proven, and the last suite checks the
 * machine-readable matrix and the qualification document agree.
 *
 * Synthetic identifiers only.
 */

const workspace = new Workspace();
let ref: ReferenceHost;
/** Every Kernel evaluation in this process while the suite runs: which instance, which action. */
const kernelSeen: { readonly instance: object; readonly action: string }[] = [];
const originalEvaluate = AocKernel.prototype.evaluate;
let coreDigestBefore = '';

// ---------------------------------------------------------------------------
// The machine-checked domain matrix (§35 / §65).

type Domain = 'treasury' | 'devops' | 'data';
type Row = 'valid' | 'policy-deny' | 'over-bound' | 'missing-fact' | 'revoked-mid-flight' | 'adapter-exactness';
const DOMAINS: readonly Domain[] = ['treasury', 'devops', 'data'];
const ROWS: readonly Row[] = ['valid', 'policy-deny', 'over-bound', 'missing-fact', 'revoked-mid-flight', 'adapter-exactness'];
const MATRIX = new Map<string, 'PASS'>();
const proven = (domain: Domain, row: Row): void => {
  MATRIX.set(`${domain}:${row}`, 'PASS');
};
let readExportDistinguished = false;

// ---------------------------------------------------------------------------
// Helpers — every one domain-neutral.

const reasonCodes = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const govern = (intent: Record<string, unknown>, idempotencyKey = nextKey('core08')) =>
  call(ref.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${AGENT_KEY}`, body: { idempotencyKey, ...intent } });
const admin = (method: string, path: string, body?: unknown) => call(ref.baseUrl, method, path, { authorization: ADMIN, ...(body !== undefined ? { body } : {}) });

async function noEffect<T>(label: string, work: () => Promise<T>): Promise<T> {
  const before = ref.provider.actions.length;
  const wire = ref.provider.wire.length;
  const result = await work();
  assert.equal(ref.provider.actions.length, before, `${label}: no adapter may be invoked`);
  assert.equal(ref.provider.wire.length, wire, `${label}: nothing may reach the wire`);
  return result;
}

/** Runs `work`, asserting exactly one adapter call, to `adapterId`, and one wire request; returns what the adapter received. */
async function oneEffect(label: string, adapterId: string, work: () => Promise<Reply>): Promise<{ readonly reply: Reply; readonly action: ValidatedExecutionAction; readonly wire: (typeof ref.provider.wire)[number] }> {
  const before = ref.provider.actions.length;
  const wireBefore = ref.provider.wire.length;
  const reply = await work();
  assert.equal(ref.provider.actions.length, before + 1, `${label}: exactly one adapter invocation — ${reply.text}`);
  assert.equal(ref.provider.wire.length, wireBefore + 1, `${label}: exactly one provider request`);
  const entry = ref.provider.actions.at(-1);
  const wire = ref.provider.wire.at(-1);
  assert.ok(entry !== undefined && wire !== undefined);
  assert.equal(entry.adapterId, adapterId, `${label}: routed by trusted configuration to ${adapterId}`);
  assert.equal(wire.adapterId, adapterId);
  return { reply, action: entry.action, wire };
}

function assertDeniedBy(reply: Reply, code: string, label: string): void {
  assert.equal(reply.body['status'], 'denied', `${label}: ${reply.text}`);
  const codes = reasonCodes(reply);
  if (code.startsWith('CONTEXT_')) assert.deepEqual(codes, [code], label);
  else assert.ok(codes.includes('DOMAIN_POLICY_DENIED'), `${label}: ${codes.join(',')}`);
}

async function assertPolicyRule(reply: Reply, ruleCode: string, label: string): Promise<void> {
  assertDeniedBy(reply, ruleCode, label);
  const decision = reply.body['decision'] as { readonly evaluationId: string } | undefined;
  assert.ok(decision !== undefined, label);
  const record = await ref.host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decision.evaluationId);
  assert.ok(record !== null && JSON.stringify(record).includes(ruleCode), `${label}: the committed decision records ${ruleCode}`);
}

function assertWithheld(reply: Reply, by: string, code?: string): void {
  assert.equal(reply.body['status'], 'withheld', reply.text);
  assert.equal(reply.body['withheldBy'], by, reply.text);
  if (code !== undefined) assert.ok(reasonCodes(reply).includes(code), `${code}: ${reply.text}`);
}

async function grantOf(reply: Reply): Promise<BoundedGrant> {
  const executionId = reply.body['executionId'];
  assert.equal(typeof executionId, 'string', reply.text);
  const lookup = await admin('GET', `/api/admin/authority/executions/${encodeURIComponent(executionId as string)}`);
  assert.equal(lookup.status, 200, lookup.text);
  return storedGrant(ref.dir, lookup.body['grantId'] as string);
}

/**
 * The attempt that sits exactly at a grant's own bounds, rebuilt from the
 * stored grant alone — generic over every axis, so the same helper exercises a
 * treasury, a deployment and a data grant.
 */
function attemptAtBounds(grant: BoundedGrant, executionId: string, overrides: Partial<GrantExerciseRequest> = {}): GrantExerciseRequest {
  const scope = grant.scope;
  const identity = (bound: { readonly kind: string; readonly value?: string } | undefined): string | undefined => (bound?.kind === 'identity' ? bound.value : undefined);
  const action = identity(scope.action);
  const resources = scope.resources;
  assert.ok(action !== undefined && resources !== undefined && resources.kind === 'set');
  const counterparty = identity(scope.counterparty);
  const organization = identity(scope.organization);
  const governanceProfile = identity(scope.governanceProfile);
  const actionClass = identity(scope.actionClass);
  const resourceClass = identity(scope.resourceClass);
  const parameters = scope.parameters?.map((bound): GovernedParameter => (bound.kind === 'maximum' ? { dimension: bound.dimension, type: 'integer', value: bound.limit } : ({ dimension: bound.dimension, type: bound.type, value: bound.value } as GovernedParameter)));
  return {
    boundedGrantId: grant.id,
    subject: grant.subject,
    action,
    resource: resources.values[0] as string,
    ...(counterparty !== undefined ? { counterparty } : {}),
    ...(organization !== undefined ? { organization } : {}),
    ...(scope.amount?.kind === 'ceiling' ? { amount: { value: scope.amount.limit, unit: scope.amount.unit } } : {}),
    ...(governanceProfile !== undefined ? { governanceProfile } : {}),
    ...(actionClass !== undefined ? { actionClass } : {}),
    ...(resourceClass !== undefined ? { resourceClass } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    correlation: grant.correlation,
    executionId,
    ...overrides,
  };
}

const ace = () => {
  const service = ref.host.enterprise.authorityControlledExecution;
  assert.ok(service !== undefined);
  return service;
};

/** A genuine issued, never-exercised grant for `intent`, stranded by an adapter-scoped stop on the domain's own adapter. */
async function strand(adapterId: string, intent: Record<string, unknown>): Promise<{ readonly grant: BoundedGrant; readonly key: string }> {
  ref.context.set(EVERY_WORLD);
  const key = nextKey('core08-strand');
  const activated = await admin('POST', '/api/admin/emergency-controls/activate', { scope: 'adapter', value: adapterId });
  assert.equal(activated.status, 200, activated.text);
  try {
    const reply = await noEffect(`stranded at ${adapterId}`, () => govern(intent, key));
    assertWithheld(reply, 'emergency-control');
    assert.equal((reply.body['decision'] as { readonly status?: string } | undefined)?.status, 'allowed');
    return { grant: await grantOf(reply), key };
  } finally {
    const released = await admin('POST', '/api/admin/emergency-controls/release', { scope: 'adapter', value: adapterId });
    assert.equal(released.status, 200, released.text);
  }
}

// ---------------------------------------------------------------------------
// Generic CORE source identity.

const GENERIC_CORE_DIST = ['dist/src/kernel', 'dist/src/enterprise/governed-action', 'dist/src/features/grant-runtime', 'dist/src/features/execution-runtime', 'dist/src/features/governed-parameter-runtime', 'dist/src/enterprise/governance-profile', 'dist/src/features/domain-policy-pack-runtime'];

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'tests' && name !== '__tests__') out.push(...jsFiles(full));
    } else if (full.endsWith('.js') && !full.endsWith('.test.js')) out.push(full);
  }
  return out;
}

function genericCoreDigest(): string {
  const hash = createHash('sha256');
  for (const file of GENERIC_CORE_DIST.flatMap(jsFiles)) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

before(async () => {
  coreDigestBefore = genericCoreDigest();
  // Observe — never alter — every Kernel evaluation: the instance that ran it
  // and the action it evaluated. The governed path's grant-aware Kernel is
  // built once inside composition and is reachable no other way.
  AocKernel.prototype.evaluate = function observed(this: AocKernel, request: KernelEvaluationRequest, ...rest: unknown[]) {
    kernelSeen.push({ instance: this, action: request.action.type });
    return (originalEvaluate as (...args: unknown[]) => ReturnType<AocKernel['evaluate']>).call(this, request, ...rest);
  } as AocKernel['evaluate'];
  ref = await bootReferenceHost(workspace);
});
after(async () => {
  AocKernel.prototype.evaluate = originalEvaluate;
  await workspace.cleanup();
});

// ===========================================================================

describe('CORE-08 §28 / §50 — one Host, one Kernel, one pipeline, three domains at once', () => {
  it('the shipped Host is composed in the secure profile with P7, P11, emergency control and signed authority', () => {
    const posture = ref.host.posture;
    assert.equal(posture.persistence, 'durable');
    assert.equal(posture.authentication, 'required');
    assert.equal(posture.governedActions, 'composed');
    assert.equal(posture.authorityStore, 'authenticated-durable');
    assert.equal(posture.exerciseControls, 'composed');
    assert.equal(posture.emergencyControl, 'composed');
    assert.equal(posture.authorityFreshness, 'external');
  });

  it('the three domains interleave on the same Host: each executes exactly once through its own configured adapter', async () => {
    ref.context.set(EVERY_WORLD);
    const t = await oneEffect('treasury', TREASURY_HTTP, () => govern(transfer()));
    const d = await oneEffect('devops', DEVOPS_HTTP, () => govern(deploy()));
    const r = await oneEffect('data read', DATA_HTTP, () => govern(read()));
    const x = await oneEffect('data export', DATA_HTTP, () => govern(exportRecords()));
    for (const { reply } of [t, d, r, x]) assert.equal(reply.body['status'], 'executed', reply.text);
    proven('treasury', 'valid');
    proven('devops', 'valid');
    proven('data', 'valid');
  });
});

// ===========================================================================

describe('CORE-08 §20 / §21 — TREASURY: transfer-funds × treasury account (P9 money, P10 ceiling)', () => {
  it('TR-1 — a valid transfer is authorized, bounded, and executes exactly once with the exact amount and unit', async () => {
    ref.context.set(EVERY_WORLD);
    const { reply, action, wire } = await oneEffect('TR-1', TREASURY_HTTP, () => govern(transfer('250.75')));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(action.amount, { value: '250.75', unit: 'USD' }, 'P9 canonical money, never a number');
    assert.equal(action.counterparty, PAYEE);
    assert.equal(action.resource, TREASURY_ACCOUNT);
    assert.equal(action.subject, AGENT);
    assert.equal(Object.prototype.hasOwnProperty.call(action, 'parameters'), false, 'money is money: no generic parameter is invented for it');
    assert.equal(wire.request.body, `{"account":"${TREASURY_ACCOUNT}","payee":"${PAYEE}","amount":250.75,"currency":"USD","requestId":"${String(reply.body['requestId'])}"}`);
    // P10: the signed grant's ceiling is the durable authority's, never the caller's number …
    const grant = await grantOf(reply);
    assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: TREASURY_CEILING, unit: 'USD' }, 'the grant ceiling is sourced from authority');
    // … and the exact amount the adapter received is what P11 durably prepared.
    const outcome = await ref.host.enterprise.executionOutcomes?.read({ organizationId: ORG }, reply.body['executionId'] as string);
    assert.deepEqual(outcome?.attempt.amount, { value: '250.75', unit: 'USD' });
    assert.equal(outcome?.attempt.parameters, undefined);
    proven('treasury', 'adapter-exactness');
  });

  it('TR-2 — a policy denial reaches no adapter', async () => {
    ref.context.set(withFact(EVERY_WORLD, 'payee.approved', false));
    await assertPolicyRule(await noEffect('TR-2', () => govern(transfer())), 'TREASURY_PAYEE_NOT_APPROVED', 'TR-2');
    proven('treasury', 'policy-deny');
  });

  it('TR-3 — an amount above the durable P10 authority ceiling reaches no adapter; at the ceiling it executes', async () => {
    ref.context.set(EVERY_WORLD);
    const over = await noEffect('TR-3', () => govern(transfer('1000.01')));
    assertWithheld(over, 'authority-binding', 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED');
    const at = await oneEffect('TR-3 control', TREASURY_HTTP, () => govern(transfer(TREASURY_CEILING)));
    assert.equal(at.reply.body['status'], 'executed');
    // And at exercise: a genuine grant's own ceiling cannot be exceeded.
    const { grant } = await strand(TREASURY_HTTP, transfer('300'));
    const outcome = await noEffect('TR-3 exercise', () => ace().exercise(attemptAtBounds(grant, 'exec-core08-tr3', { amount: { value: '1000.01', unit: 'USD' } })));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_AMOUNT_EXCEEDED), JSON.stringify(outcome));
    proven('treasury', 'over-bound');
  });

  it('TR-4 — a missing required trusted fact is never allowed by default', async () => {
    for (const fact of ['invoice.approved', 'payee.approved']) {
      ref.context.set(without(EVERY_WORLD, fact));
      assertDeniedBy(await noEffect(`TR-4 ${fact}`, () => govern(transfer())), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', `TR-4 ${fact}`);
    }
    proven('treasury', 'missing-fact');
  });

  it('TR-6 — the wrong asset, counterparty or resource reaches no adapter', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('TR-6', async () => {
      const unknownAsset = await govern(transfer('250', 'XRP'));
      assert.equal(unknownAsset.status, 400, unknownAsset.text);
      // EUR is a recognized asset — but the treasury lineage states no EUR ceiling.
      assertWithheld(await govern(transfer('250', 'EUR')), 'authority-binding');
      const { grant } = await strand(TREASURY_HTTP, transfer('200'));
      for (const [name, overrides, code] of [
        ['other unit', { amount: { value: '200', unit: 'EUR' } }, E.GRANT_EXERCISE_AMOUNT_EXCEEDED],
        ['other counterparty', { counterparty: 'supplier-attacker' }, E.GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE],
        ['other resource', { resource: CLUSTER }, E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE],
      ] as const) {
        const outcome = await ace().exercise(attemptAtBounds(grant, `exec-core08-tr6-${name.replace(/\W+/g, '-')}`, overrides));
        assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(code), `${name}: ${JSON.stringify(outcome)}`);
      }
    });
  });

  it('TR-7 — replaying the same execution identity produces no second provider call', async () => {
    ref.context.set(EVERY_WORLD);
    const key = nextKey('core08-tr7');
    assert.equal((await oneEffect('TR-7', TREASURY_HTTP, () => govern(transfer('99'), key))).reply.body['status'], 'executed');
    const replay = await noEffect('TR-7 replay', () => govern(transfer('99'), key));
    assert.equal(replay.body['status'], 'executed');
    assert.equal(replay.body['replayed'], true);
  });
});

// ===========================================================================

describe('CORE-08 §22 / §24 — DEVOPS: deploy-release × production cluster (replicaCount ≤, deploymentStrategy =)', () => {
  it('DO-1 / DO-8 — a valid deploy executes exactly once; the adapter receives exactly the canonical typed parameters', async () => {
    ref.context.set(EVERY_WORLD);
    const { reply, action, wire } = await oneEffect('DO-1', DEVOPS_HTTP, () => govern(deploy(4, 'rolling')));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(action.parameters, [
      { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' },
      { dimension: 'replicaCount', type: 'integer', value: 4 },
    ]);
    assert.ok(Object.isFrozen(action) && Object.isFrozen(action.parameters));
    assert.equal(action.resource, CLUSTER);
    assert.equal(action.amount, undefined);
    // The exact provider request the production mapper built from that action.
    assert.equal(wire.request.method, 'PATCH');
    assert.equal(wire.request.hostname, 'deploy.platform.example');
    assert.equal(wire.request.port, 443);
    assert.equal(wire.request.path, `/deployments/${CLUSTER}?strategy=rolling`);
    assert.equal(wire.request.body, `{"strategy":"rolling","replicas":4,"requestId":"${String(reply.body['requestId'])}"}`);
    assert.ok(wire.request.headers.some(([name, value]) => name === 'x-replica-count' && value === '4'));
    assert.ok(wire.request.headers.some(([name, value]) => name === 'x-deploy-key' && value === DEVOPS_KEY));
    // The signed grant bounds exactly those parameters.
    const grant = await grantOf(reply);
    assert.deepEqual(grant.scope.parameters, [
      { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
      { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 4 },
    ]);
    // P11 v2 bound the exact parameters the adapter received, before the provider crossing.
    const outcome = await ref.host.enterprise.executionOutcomes?.read({ organizationId: ORG }, reply.body['executionId'] as string);
    assert.ok(outcome !== undefined);
    assert.equal(outcome.attempt.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION);
    assert.deepEqual(outcome.attempt.parameters, action.parameters);
    proven('devops', 'adapter-exactness');
  });

  it('DO-2 — a policy denial reaches no adapter', async () => {
    ref.context.set(EVERY_WORLD);
    await assertPolicyRule(await noEffect('DO-2', () => govern(deploy(4, 'recreate'))), 'DEPLOY_STRATEGY_NOT_PERMITTED', 'DO-2');
    proven('devops', 'policy-deny');
  });

  it('DO-3 — replicaCount above the maximum reaches no adapter: at policy, and against a genuine grant at exercise', async () => {
    ref.context.set(EVERY_WORLD);
    await assertPolicyRule(await noEffect('DO-3 policy', () => govern(deploy(11))), 'DEPLOY_SCALE_EXCEEDS_POLICY', 'DO-3');
    const { grant } = await strand(DEVOPS_HTTP, deploy(4));
    const over = attemptAtBounds(grant, 'exec-core08-do3', {
      parameters: [
        { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' },
        { dimension: 'replicaCount', type: 'integer', value: 5 },
      ],
    });
    const outcome = await noEffect('DO-3 exercise', () => ace().exercise(over));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE), JSON.stringify(outcome));
    proven('devops', 'over-bound');
  });

  it('DO-4 — a different deploymentStrategy against the exact bound reaches no adapter', async () => {
    const { grant } = await strand(DEVOPS_HTTP, deploy(3, 'blue-green'));
    const swapped = attemptAtBounds(grant, 'exec-core08-do4', {
      parameters: [
        { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' },
        { dimension: 'replicaCount', type: 'integer', value: 3 },
      ],
    });
    const outcome = await noEffect('DO-4', () => ace().exercise(swapped));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE), JSON.stringify(outcome));
  });

  it('DO-5 / DO-6 — a missing change-window or rollback fact is never allowed', async () => {
    for (const fact of ['changeWindow.open', 'rollback.available']) {
      ref.context.set(without(EVERY_WORLD, fact));
      assertDeniedBy(await noEffect(`missing ${fact}`, () => govern(deploy())), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', `missing ${fact}`);
    }
    ref.context.set(withFact(EVERY_WORLD, 'rollback.available', false));
    await assertPolicyRule(await noEffect('rollback false', () => govern(deploy())), 'DEPLOY_WITHOUT_ROLLBACK', 'DO-6 attested false');
    proven('devops', 'missing-fact');
  });

  it('DO-9 / DO-10 — the string "3" for an integer, and an undeclared parameter, are refused before any decision', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('DO-9/10', async () => {
      for (const intent of [deploy('3'), deploy(3.5), deploy(3, 'Rolling Update'), { ...deploy(), parameters: { replicaCount: 4, deploymentStrategy: 'rolling', region: 'eu' } }, { action: DEPLOY, resource: CLUSTER, parameters: { replicaCount: 4 } }]) {
        const reply = await govern(intent);
        assert.equal(reply.status, 400, `${JSON.stringify(intent)}: ${reply.text}`);
        assert.equal(reply.body['decision'], undefined);
      }
    });
  });
});

// ===========================================================================

describe('CORE-08 §25 – §27 — DATA: read vs export × the same customer records', () => {
  it('DA-1 / DA-2 / DA-10 — a valid read and a valid export each execute exactly once with the exact recordCount', async () => {
    ref.context.set(EVERY_WORLD);
    const r = await oneEffect('DA-1', DATA_HTTP, () => govern(read(25)));
    assert.equal(r.reply.body['status'], 'executed', r.reply.text);
    assert.deepEqual(r.action.parameters, [{ dimension: 'recordCount', type: 'integer', value: 25 }]);
    assert.equal(r.wire.request.path, `/v1/datasets/${CUSTOMER_RECORDS}/jobs?limit=25`);
    assert.equal(r.wire.request.body, `{"operation":"${READ}","limit":25,"requestId":"${String(r.reply.body['requestId'])}"}`, 'a read carries no format: the optional adapter field is omitted');
    const x = await oneEffect('DA-2', DATA_HTTP, () => govern(exportRecords(40, 'csv')));
    assert.equal(x.reply.body['status'], 'executed', x.reply.text);
    assert.deepEqual(x.action.parameters, [
      { dimension: 'exportFormat', type: 'token', value: 'csv' },
      { dimension: 'recordCount', type: 'integer', value: 40 },
    ]);
    assert.equal(x.wire.request.body, `{"operation":"${EXPORT}","limit":40,"format":"csv","requestId":"${String(x.reply.body['requestId'])}"}`);
    assert.ok(x.wire.request.headers.some(([name, value]) => name === 'authorization' && value === `Bearer ${DATA_TOKEN}`));
    proven('data', 'adapter-exactness');
  });

  it('DA-3 — a policy denial reaches no adapter', async () => {
    ref.context.set(withFact(EVERY_WORLD, 'dataResidency.compliant', false));
    await assertPolicyRule(await noEffect('DA-3', () => govern(exportRecords())), 'EXPORT_RESIDENCY_UNCONFIRMED', 'DA-3');
    proven('data', 'policy-deny');
  });

  it('DA-4 — recordCount above the bound reaches no adapter: 1001 for a read, 101 for an export, and past a genuine grant', async () => {
    ref.context.set(EVERY_WORLD);
    await assertPolicyRule(await noEffect('DA-4 read', () => govern(read(1001))), 'READ_VOLUME_EXCEEDS_POLICY', 'DA-4 read');
    await assertPolicyRule(await noEffect('DA-4 export', () => govern(exportRecords(101))), 'EXPORT_VOLUME_EXCEEDS_POLICY', 'DA-4 export');
    const { grant } = await strand(DATA_HTTP, read(10));
    const outcome = await noEffect('DA-4 exercise', () => ace().exercise(attemptAtBounds(grant, 'exec-core08-da4', { parameters: [{ dimension: 'recordCount', type: 'integer', value: 11 }] })));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE), JSON.stringify(outcome));
    proven('data', 'over-bound');
  });

  it('DA-5 / DA-6 — a missing read fact, or a missing stricter export fact, is never allowed', async () => {
    ref.context.set(without(EVERY_WORLD, 'supportCase.open'));
    assertDeniedBy(await noEffect('DA-5', () => govern(read())), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', 'DA-5');
    for (const fact of ['exportDestination.approved', 'dataResidency.compliant']) {
      ref.context.set(without(EVERY_WORLD, fact));
      assertDeniedBy(await noEffect(`DA-6 ${fact}`, () => govern(exportRecords())), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', `DA-6 ${fact}`);
    }
    proven('data', 'missing-fact');
  });

  it('DA-11 — read and export of the same resource are governed differently by profile, facts and policy data alone', async () => {
    // The read's world satisfies a read but not an export; 50 records is inside a read's policy volume and outside an export's.
    ref.context.set([...TREASURY_WORLD, ...DEVOPS_WORLD, ...READ_WORLD]);
    assert.equal((await oneEffect('DA-11 read', DATA_HTTP, () => govern(read(50)))).reply.body['status'], 'executed');
    assertDeniedBy(await noEffect('DA-11 export, read world', () => govern(exportRecords(50))), 'CONTEXT_REQUIRED_FACT_UNRESOLVED', 'DA-11 export facts');
    ref.context.set(EVERY_WORLD);
    await assertPolicyRule(await noEffect('DA-11 export volume', () => govern(exportRecords(150))), 'EXPORT_VOLUME_EXCEEDS_POLICY', 'DA-11 volume');
    assert.equal((await oneEffect('DA-11 read volume', DATA_HTTP, () => govern(read(150)))).reply.body['status'], 'executed');
    // An export is required to state a format; a read may not state one.
    await noEffect('DA-11 format', async () => {
      assert.equal((await govern({ action: EXPORT, resource: CUSTOMER_RECORDS, parameters: { recordCount: 5 } })).status, 400);
      assert.equal((await govern({ action: READ, resource: CUSTOMER_RECORDS, parameters: { recordCount: 5, exportFormat: 'csv' } })).status, 400);
    });
    // Same resource, different signed authority: the grants' profiles and classes differ.
    ref.context.set(EVERY_WORLD);
    const readGrant = (await strand(DATA_HTTP, read(5))).grant;
    const exportGrant = (await strand(DATA_HTTP, exportRecords(5))).grant;
    assert.deepEqual(readGrant.scope.resources, exportGrant.scope.resources);
    assert.notDeepEqual(readGrant.scope.governanceProfile, exportGrant.scope.governanceProfile);
    assert.notDeepEqual(readGrant.scope.actionClass, exportGrant.scope.actionClass);
    readExportDistinguished = true;
  });

  it('DA-8 — a read grant cannot execute an export; DA-9 — an export grant cannot substitute another data resource', async () => {
    const readGrant = (await strand(DATA_HTTP, read(5))).grant;
    const exportGrant = (await strand(DATA_HTTP, exportRecords(5))).grant;
    await noEffect('DA-8 / DA-9', async () => {
      const asExport = await ace().exercise(
        attemptAtBounds(readGrant, 'exec-core08-da8', {
          action: EXPORT,
          actionClass: 'export',
          parameters: [
            { dimension: 'exportFormat', type: 'token', value: 'csv' },
            { dimension: 'recordCount', type: 'integer', value: 5 },
          ],
        }),
      );
      assert.ok(asExport.status === 'withheld' && asExport.assessment.reasonCodes.includes(E.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE), JSON.stringify(asExport));
      assert.ok(asExport.status === 'withheld' && asExport.assessment.reasonCodes.includes(E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH));
      const otherResource = await ace().exercise(attemptAtBounds(exportGrant, 'exec-core08-da9', { resource: OTHER_RECORDS }));
      assert.ok(otherResource.status === 'withheld' && otherResource.assessment.reasonCodes.includes(E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE), JSON.stringify(otherResource));
    });
  });
});

// ===========================================================================

describe('CORE-08 §36 — revoked mid-flight, per domain: the authoritative grant is re-read and the action refused', () => {
  const cases: readonly { readonly domain: Domain; readonly adapterId: string; readonly intent: () => Record<string, unknown> }[] = [
    { domain: 'treasury', adapterId: TREASURY_HTTP, intent: () => transfer('120') },
    { domain: 'devops', adapterId: DEVOPS_HTTP, intent: () => deploy(2, 'blue-green') },
    { domain: 'data', adapterId: DATA_HTTP, intent: () => exportRecords(7) },
  ];
  for (const { domain, adapterId, intent } of cases) {
    it(`${domain}: control — the stranded grant executes when nothing changed (so the zero below is load-bearing)`, async () => {
      const { grant } = await strand(adapterId, intent());
      assert.equal((await ace().assessExercise(attemptAtBounds(grant, `exec-core08-${domain}-control`))).usable, true);
      const before = ref.provider.callsTo(adapterId);
      const outcome = await ace().exercise(attemptAtBounds(grant, `exec-core08-${domain}-control`));
      assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
      assert.equal(ref.provider.callsTo(adapterId), before + 1);
    });

    it(`${domain}: a grant revoked through the administration API after issuance and before the adapter → zero adapter calls`, async () => {
      const { grant, key } = await strand(adapterId, intent());
      const attempt = attemptAtBounds(grant, `exec-core08-${domain}-revoked`);
      assert.equal((await ace().assessExercise(attempt)).usable, true, 'usable before the revocation');
      const revoked = await admin('POST', `/api/admin/authority/grants/${encodeURIComponent(grant.id)}/revoke`, { reason: 'security-incident' });
      assert.equal(revoked.status, 200, revoked.text);
      await noEffect(`${domain} revoked mid-flight`, async () => {
        const assessment = await ace().assessExercise(attempt);
        assert.ok(!assessment.usable && assessment.reasonCodes.includes(E.GRANT_EXERCISE_REVOKED), 'the revocation is read from the authoritative store');
        const outcome = await ace().exercise(attempt);
        assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'grant-exercise' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_REVOKED), JSON.stringify(outcome));
        // The caller's own retry is answered from the record, never re-executed.
        ref.context.set(EVERY_WORLD);
        assert.notEqual((await govern(intent(), key)).body['status'], 'executed');
      });
      proven(domain, 'revoked-mid-flight');
    });
  }
});

// ===========================================================================

describe('CORE-08 §40 — cross-domain substitution fails closed before any provider effect', () => {
  it('CROSS-1 / CROSS-5 — a domain action over another domain’s resource is refused by the envelope before any decision', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('CROSS-1/5', async () => {
      // Both classes are declared, and no Governance Profile governs the
      // combination: the envelope is refused before any decision, with or
      // without parameters. (A separate authority lineage per domain would
      // deny it too; the envelope is the first closed door.)
      for (const intent of [
        { action: DEPLOY, resource: CUSTOMER_RECORDS, parameters: { replicaCount: 4, deploymentStrategy: 'rolling' } },
        { action: DEPLOY, resource: CUSTOMER_RECORDS },
        { action: READ, resource: CLUSTER, parameters: { recordCount: 5 } },
        { action: READ, resource: CLUSTER },
        { action: EXPORT, resource: TREASURY_ACCOUNT, parameters: { recordCount: 5, exportFormat: 'csv' } },
        { action: TRANSFER, resource: CUSTOMER_RECORDS, counterparty: PAYEE, amount: { value: '10', currency: 'USD' } },
      ]) {
        const reply = await govern(intent);
        assert.equal(reply.status, 400, `${JSON.stringify(intent)}: ${reply.text}`);
        assert.equal(reply.body['status'], 'rejected');
        assert.equal(reply.body['decision'], undefined, 'nothing was decided');
      }
    });
  });

  it('CROSS-2 / CROSS-6 — pinning another domain’s profile, or the right profile at another version, is refused', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('CROSS-2/6', async () => {
      assert.equal((await govern({ ...read(), expectedGovernanceProfile: { id: 'deploy-production', version: 1 } })).status, 400);
      assert.equal((await govern({ ...read(), expectedGovernanceProfile: { id: 'customer-data-read', version: 2 } })).status, 400);
      assert.equal((await govern({ ...deploy(), expectedGovernanceProfile: { id: 'customer-data-export', version: 1 } })).status, 400);
    });
    // The right id and version with another digest, at exercise.
    const { grant } = await strand(DATA_HTTP, read(3));
    const genuine = attemptAtBounds(grant, 'exec-core08-cross6');
    const pinned = genuine.governanceProfile ?? '';
    const otherDigest = `${pinned.slice(0, -1)}${pinned.endsWith('0') ? '1' : '0'}`;
    const outcome = await noEffect('CROSS-6 digest', () => ace().exercise({ ...genuine, governanceProfile: otherDigest }));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH), JSON.stringify(outcome));
  });

  it('CROSS-3 / CROSS-7 — a parameter valid in one profile is refused in another', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('CROSS-3/7', async () => {
      assert.equal((await govern({ ...transfer(), parameters: { replicaCount: 4 } })).status, 400, 'treasury declares no generic parameter');
      assert.equal((await govern({ ...read(), parameters: { recordCount: 5, replicaCount: 4 } })).status, 400);
      assert.equal((await govern({ ...deploy(), parameters: { replicaCount: 4, deploymentStrategy: 'rolling', recordCount: 5 } })).status, 400);
    });
    // And at exercise: a treasury grant bounds no parameter, so none may be stated.
    const { grant } = await strand(TREASURY_HTTP, transfer('80'));
    const outcome = await noEffect('CROSS-3 exercise', () => ace().exercise(attemptAtBounds(grant, 'exec-core08-cross3', { parameters: [{ dimension: 'replicaCount', type: 'integer', value: 4 }] })));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE), JSON.stringify(outcome));
  });

  it('CROSS-4 / CROSS-8 — a data grant used for export, or exercised with a DevOps parameter bound, is withheld', async () => {
    const readGrant = (await strand(DATA_HTTP, read(4))).grant;
    const deployGrant = (await strand(DEVOPS_HTTP, deploy(4))).grant;
    await noEffect('CROSS-4/8', async () => {
      const asExport = await ace().exercise(attemptAtBounds(readGrant, 'exec-core08-cross4', { action: EXPORT }));
      assert.ok(asExport.status === 'withheld' && asExport.assessment.reasonCodes.includes(E.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE));
      const reused = attemptAtBounds(readGrant, 'exec-core08-cross8', { parameters: attemptAtBounds(deployGrant, 'x').parameters ?? [] });
      const outcome = await ace().exercise(reused);
      assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE), JSON.stringify(outcome));
      const deployAsData = await ace().exercise(attemptAtBounds(deployGrant, 'exec-core08-cross8b', { resource: CUSTOMER_RECORDS }));
      assert.ok(deployAsData.status === 'withheld' && deployAsData.assessment.reasonCodes.includes(E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE));
    });
  });
});

// ===========================================================================

describe('CORE-08 §13 / §44 / §58 — the caller controls values, never mapping, routing or history', () => {
  it('no request field can name an adapter, origin, provider mapping, credential or payload', async () => {
    ref.context.set(EVERY_WORLD);
    await noEffect('§13 / §44', async () => {
      for (const [field, value] of [
        ['adapterId', DEVOPS_HTTP],
        ['origin', 'https://attacker.example'],
        ['url', 'https://attacker.example/deployments'],
        ['mapping', { replicas: 'parameters.replicaCount' }],
        ['headers', { authorization: 'Bearer attacker' }],
        ['providerCredential', 'attacker'],
        ['payload', { replicas: 100 }],
        ['executionPayload', { replicas: 100 }],
      ] as const) {
        const reply = await govern({ ...deploy(), [field]: value });
        assert.equal(reply.status, 400, `${field}: ${reply.text}`);
      }
    });
  });

  it('a parameter value can never reach the destination: a hostile-looking token is data inside one encoded value', async () => {
    // The token grammar already excludes "/", "\\", whitespace and control characters;
    // "@", ":" and "." are legal — and still cannot move the request.
    // The organization's policy allows only rolling | blue-green, so this one is denied first;
    // the mapping-level proof that it could not have moved the request is in the Generic HTTP suite.
    ref.context.set(EVERY_WORLD);
    await assertPolicyRule(await noEffect('hostile strategy', () => govern(deploy(2, 'evil.example:443@x'))), 'DEPLOY_STRATEGY_NOT_PERMITTED', 'hostile token');
    for (const wire of ref.provider.wire) {
      assert.ok(['payments.treasury-bank.example', 'deploy.platform.example', 'records.data-platform.example'].includes(wire.hostname));
      assert.equal(wire.request.port, 443);
    }
  });

  it('W — the same idempotency key with changed parameters is refused; the committed request is never reinterpreted', async () => {
    ref.context.set(EVERY_WORLD);
    const key = nextKey('core08-w');
    assert.equal((await oneEffect('W', DEVOPS_HTTP, () => govern(deploy(3), key))).reply.body['status'], 'executed');
    await noEffect('W changed', async () => {
      for (const intent of [deploy(2), deploy(3, 'blue-green'), read(3)]) {
        const reply = await govern(intent, key);
        assert.ok(reply.status === 409 || reply.status === 400, `${JSON.stringify(intent)}: ${reply.text}`);
      }
      const replay = await govern(deploy(3), key);
      assert.equal(replay.body['replayed'], true);
    });
  });
});

// ===========================================================================

describe('CORE-08 §33 / §47 / §51 — the same CORE for every domain; no intelligence', () => {
  it('one Kernel instance evaluated requests from all three domains; one policy runtime saw them all', () => {
    const domainEvaluations = kernelSeen.filter((entry) => [TRANSFER, DEPLOY, READ, EXPORT].includes(entry.action));
    for (const action of [TRANSFER, DEPLOY, READ, EXPORT]) assert.ok(domainEvaluations.some((entry) => entry.action === action), `the Kernel evaluated ${action}`);
    assert.equal(new Set(domainEvaluations.map((entry) => entry.instance)).size, 1, 'one and the same Kernel instance decided every domain');
    const policyActions = new Set(ref.policy.evaluated.map((input) => input.action));
    for (const action of [TRANSFER, DEPLOY, READ, EXPORT]) assert.ok(policyActions.has(action), `the one policy runtime evaluated ${action}`);
  });

  it('the generic CORE source is byte-identical before and after all three domains ran', () => {
    assert.equal(genericCoreDigest(), coreDigestBefore);
  });

  it('no model, inference service, agent framework or intelligence module is loaded', () => {
    const loaded = Object.keys(require.cache);
    assert.ok(loaded.length > 50);
    for (const id of loaded) assert.equal(/openai|anthropic|langchain|llama|transformers|onnx|inference|intelligence|[\\/]intel[\\/]/i.test(id), false, id);
  });
});

describe('CORE-08 §65 — the machine-checked domain matrix', () => {
  it('every cell is PASS, and read vs export was distinguished', () => {
    for (const domain of DOMAINS) for (const row of ROWS) assert.equal(MATRIX.get(`${domain}:${row}`), 'PASS', `${domain} × ${row}`);
    assert.equal(MATRIX.size, DOMAINS.length * ROWS.length);
    assert.equal(readExportDistinguished, true);
  });

  it('the qualification document claims exactly the matrix this suite proves', () => {
    const doc = readFileSync('docs/security/CORE-08-ACTION-NEUTRALITY-QUALIFICATION.md', 'utf8');
    const start = doc.indexOf('<!-- core08-domain-matrix:start -->');
    const end = doc.indexOf('<!-- core08-domain-matrix:end -->');
    assert.ok(start !== -1 && end > start, 'the document carries the machine-checked matrix block');
    const block = doc.slice(start, end);
    const header = block.split('\n').find((line) => line.startsWith('| Row |'));
    assert.ok(header !== undefined);
    assert.deepEqual(header.split('|').map((cell) => cell.trim()).filter(Boolean).slice(1), ['Treasury', 'DevOps', 'Data']);
    for (const row of ROWS) {
      const line = block.split('\n').find((candidate) => candidate.startsWith(`| ${row} |`));
      assert.ok(line !== undefined, `the document states row ${row}`);
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean).slice(1);
      assert.deepEqual(cells, DOMAINS.map((domain) => MATRIX.get(`${domain}:${row}`) ?? 'MISSING'), `row ${row}`);
    }
  });
});
