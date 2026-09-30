import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GRANT_EXERCISE_REASON_CODES as E, type GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import {
  ADAPTER_ID,
  ADMIN,
  AGENT,
  AGENT_KEY,
  AGENT_SUBJECT,
  DEPLOY,
  LEGACY_KEY,
  ORG,
  PAYABLES,
  PAYABLES_WORLD,
  PRODUCTION,
  READ,
  CUSTOMER_DATA,
  RISK_SIGNAL,
  SETTLE,
  TRUST_DOMAIN,
  Workspace,
  assertDenied,
  boot,
  call,
  createContextTable,
  governedFile,
  nextKey,
  policyPackProvider,
  provision,
  secureEnv,
  settle,
  storedGrant,
  type Booted,
  type ContextTable,
  type Reading,
  type Reply,
} from './core04-host-fixture.js';
import { APPROVAL, APPROVAL_RULES, LARGE, APPROVER_A, APPROVER_B, APPROVER_C, approvals, as, commandFor, describe as describeApproval, deploy, governanceWith, payablesWorld, provisionApprovers } from './core05-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * CORE-06 — Governance Core qualification on the **canonical composed Host**.
 *
 * Not a new mechanism: the integrated proof that the mechanisms CORE-01 …
 * CORE-05 and CORE-07 verified one by one compose into one boundary that a
 * customer cannot get around. Everything here runs through
 * `bootEnterpriseHost()` in the `production` secure profile — SQLite
 * everywhere, Ed25519-signed grants and authority state, the external
 * authority-state witness (CORE-07), durable approvals (CORE-05), durable
 * obligations and the Trusted Context Boundary (CORE-04), typed Governance
 * Profiles (CORE-03), durable emergency control, P7 exercise controls and P11
 * outcomes — over a real loopback listener, and through the one public
 * governed-action route.
 *
 * The one provider adapter counts its invocations. Every refusal asserts the
 * count did not move; the allowed cases assert it moved by exactly one and
 * that the adapter received exactly the validated action.
 *
 * **Mid-flight windows.** `bootEnterpriseHost()` deliberately exposes no seam
 * between the decision, the grant and the adapter inside one request. A window
 * is opened here the only way the canonical Host allows it: an
 * adapter-scoped emergency stop is honoured by the registry's checkpoint —
 * *after* issuance, the P7 reservation and every exercise-gate check — so the
 * request ends `withheld` with a genuine, issued, unexercised grant. What the
 * Host's own in-process exercise gate (`authorityControlledExecution`) then
 * does with that grant, after a state change, is the exercise-time
 * guarantee. The stranded grant is shown to be exercisable when nothing
 * changes, so every zero below is non-vacuous. Races inside one request are
 * qualified at the composition-root and orchestrator levels (see
 * `docs/security/CORE-06-GOVERNANCE-CORE-QUALIFICATION.md` §8).
 *
 * **No intelligence component.** The context provider is a static table and
 * the policy is data: no model, provider SDK, inference service or network
 * call exists anywhere in this composition (the structural half is
 * `core06-qualification-structure.test.ts`).
 *
 * Synthetic identifiers only.
 */

const UNBOUND_KEY = 'FRONTERA_CORE06_UNBOUND_KEY_SENTINEL_91c4e0';
const UNRECOGNIZED_KEY = 'FRONTERA_CORE06_UNRECOGNIZED_KEY_SENTINEL_5d2a7b';
const UNAUTHORIZED_KEY = 'FRONTERA_CORE06_UNAUTHORIZED_KEY_SENTINEL_0e8f33';
const UNRECOGNIZED = 'actor-core06-unrecognized';
const UNAUTHORIZED = 'actor-core06-unauthorized';

/** The approval rules minus the deploy approval: here deploy is gated by its blocking obligation alone. */
const RULES = APPROVAL_RULES.filter((rule) => rule.id !== 'deploy-requires-approval');

function qualificationFile(): Record<string, unknown> {
  return governedFile({
    governance: governanceWith(APPROVAL, undefined),
    customerPrincipals: [
      { principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      { principalId: 'principal-unbound', externalSubject: { system: 'core04-app', subjectId: 'nobody' }, apiKeyEnv: 'FRONTERA_TEST_UNBOUND_KEY' },
      { principalId: 'principal-unrecognized', externalSubject: { system: 'core04-app', subjectId: 'unrecognized-1' }, apiKeyEnv: 'FRONTERA_TEST_UNRECOGNIZED_KEY' },
      { principalId: 'principal-unauthorized', externalSubject: { system: 'core04-app', subjectId: 'unauthorized-1' }, apiKeyEnv: 'FRONTERA_TEST_UNAUTHORIZED_KEY' },
    ],
    // Q19: every action is routed except the read — the one action the
    // organization authorizes and no adapter is configured for.
    routes: [SETTLE, DEPLOY, 'export-customer-records'].map((action) => ({ action, adapterId: ADAPTER_ID })),
  });
}

function qualificationEnv(dir: string): Record<string, string | undefined> {
  return {
    ...secureEnv(dir, qualificationFile()),
    FRONTERA_TEST_UNBOUND_KEY: UNBOUND_KEY,
    FRONTERA_TEST_UNRECOGNIZED_KEY: UNRECOGNIZED_KEY,
    FRONTERA_TEST_UNAUTHORIZED_KEY: UNAUTHORIZED_KEY,
  };
}

/** Two more bound actors: one the Kernel cannot recognize (no passport), one it recognizes but that holds no authority. */
async function provisionOutsiders(booted: Booted): Promise<void> {
  const service = booted.host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: UNRECOGNIZED, displayName: 'Unrecognized', externalSubject: { system: 'core04-app', subjectId: 'unrecognized-1' } });
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: UNAUTHORIZED, displayName: 'Unauthorized', externalSubject: { system: 'core04-app', subjectId: 'unauthorized-1' } });
  await service.provisionPassport(DURABLE_FIXTURE_OPERATOR, { ...payloads.passport, passportId: `passport-${UNAUTHORIZED}`, subjectActorId: UNAUTHORIZED });
}

const workspace = new Workspace();
let dir = '';
let booted: Booted;
let context: ContextTable;

before(async () => {
  dir = workspace.dir();
  context = createContextTable();
  booted = await boot(workspace, qualificationEnv(dir), { context, policy: policyPackProvider(RULES) });
  await provision(booted.host);
  await provisionApprovers(booted.host);
  await provisionOutsiders(booted);
});
after(() => workspace.cleanup());

const reasonCodes = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const as_ = (key: string) => `Bearer ${key}`;
const governAs = (key: string, intent: Record<string, unknown>, idempotencyKey = nextKey('core06')) =>
  call(booted.baseUrl, 'POST', '/api/governed-actions', { authorization: as_(key), body: { idempotencyKey, ...intent } });
const govern = (intent: Record<string, unknown>, idempotencyKey = nextKey('core06')) => governAs(AGENT_KEY, intent, idempotencyKey);
const admin = (method: string, path: string, body?: unknown) => call(booted.baseUrl, method, path, { authorization: ADMIN, ...(body !== undefined ? { body } : {}) });

/** Runs `work` and asserts the provider adapter was not invoked by it. */
async function noEffect<T>(label: string, work: () => Promise<T>): Promise<T> {
  const before = booted.calls.length;
  const result = await work();
  assert.equal(booted.calls.length, before, `${label}: the adapter must not be invoked`);
  return result;
}

function assertWithheld(reply: Reply, by: string, code?: string): void {
  assert.equal(reply.body['status'], 'withheld', reply.text);
  assert.equal(reply.body['withheldBy'], by, reply.text);
  if (code !== undefined) assert.ok(reasonCodes(reply).includes(code), `${code}: ${reply.text}`);
}

async function stop(body: Record<string, unknown>): Promise<void> {
  const reply = await admin('POST', '/api/admin/emergency-controls/activate', body);
  assert.equal(reply.status, 200, reply.text);
}
async function resume(body: Record<string, unknown>): Promise<void> {
  const reply = await admin('POST', '/api/admin/emergency-controls/release', body);
  assert.equal(reply.status, 200, reply.text);
}

/** The grant a governed request was issued, found the way an operator finds it: by the response's executionId. */
async function grantOf(reply: Reply): Promise<BoundedGrant> {
  const executionId = reply.body['executionId'];
  assert.equal(typeof executionId, 'string', reply.text);
  const lookup = await admin('GET', `/api/admin/authority/executions/${encodeURIComponent(executionId as string)}`);
  assert.equal(lookup.status, 200, lookup.text);
  return storedGrant(dir, lookup.body['grantId'] as string);
}

/**
 * A genuine, issued, never-exercised grant. The registry's adapter-scoped
 * checkpoint — the last one, after issuance, reservation and every
 * exercise-gate check — withholds the request; the stop is then released.
 */
async function strand(intent: Record<string, unknown>, readings: readonly Reading[] = PAYABLES_WORLD): Promise<{ readonly reply: Reply; readonly grant: BoundedGrant; readonly key: string }> {
  context.set(readings);
  const key = nextKey('core06-strand');
  await stop({ scope: 'adapter', value: ADAPTER_ID });
  try {
    const reply = await noEffect('stranded by the registry checkpoint', () => govern(intent, key));
    assertWithheld(reply, 'emergency-control');
    return { reply, grant: await grantOf(reply), key };
  } finally {
    await resume({ scope: 'adapter', value: ADAPTER_ID });
  }
}

const identityValue = (grant: BoundedGrant, key: 'governanceProfile' | 'actionClass' | 'resourceClass'): string => {
  const bound = grant.scope[key];
  assert.ok(bound !== undefined && bound.kind === 'identity', `${key} is an identity bound`);
  return bound.value;
};

/** Exactly what the orchestrator would ask of a settle grant, rebuilt from the grant — the attempt that is inside every bound. */
function settleAttempt(grant: BoundedGrant, executionId: string, invoiceTotal = 500, destination = 'supplier-x'): GrantExerciseRequest {
  return {
    boundedGrantId: grant.id,
    subject: AGENT,
    action: SETTLE,
    resource: PAYABLES,
    organization: ORG,
    governanceProfile: identityValue(grant, 'governanceProfile'),
    actionClass: identityValue(grant, 'actionClass'),
    resourceClass: identityValue(grant, 'resourceClass'),
    parameters: [
      { dimension: 'destination', type: 'token', value: destination },
      { dimension: 'invoiceTotal', type: 'integer', value: invoiceTotal },
    ],
    correlation: grant.correlation,
    executionId,
  };
}

const ace = () => {
  const service = booted.host.enterprise.authorityControlledExecution;
  assert.ok(service !== undefined);
  return service;
};

describe('CORE-06 §9 — the canonical Host composes the whole Governance Core', () => {
  it('posture: durable, authenticated, signed, witnessed, governed, interlocked, exercise-controlled; approvals and obligations durable', () => {
    const posture = booted.host.posture;
    assert.equal(posture.persistence, 'durable');
    assert.equal(posture.authentication, 'required');
    assert.equal(posture.governedActions, 'composed');
    assert.equal(posture.authorityStore, 'authenticated-durable');
    assert.equal(posture.kernelAuthority, 'composed');
    assert.equal(posture.emergencyControl, 'composed');
    assert.equal(posture.exerciseControls, 'composed');
    assert.equal(posture.authorityFreshness, 'external');
    assert.equal(posture.approvals, 'durable');
    assert.equal(posture.obligations, 'durable');
  });
});

describe('CORE-06 §10 — Q1 … Q20 on the canonical Host: every refusal reaches no adapter', () => {
  it('Q20 — a valid complete action executes exactly once, with exactly the validated action, and never twice', async () => {
    context.set(PAYABLES_WORLD);
    const before = booted.calls.length;
    const key = nextKey('core06-q20');
    const reply = await govern(settle(), key);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body['status'], 'executed');
    assert.equal(booted.calls.length, before + 1);
    const action = booted.calls.at(-1);
    assert.ok(action !== undefined);
    assert.equal(action.subject, AGENT, 'the subject is the bound actor, from the stored grant');
    assert.equal(action.action, SETTLE);
    assert.equal(action.resource, PAYABLES);
    assert.equal(action.organization, ORG);
    assert.equal(action.correlation.executionId, reply.body['executionId']);
    // The same request again is answered from the durable record.
    const replay = await noEffect('Q20 replay', () => govern(settle(), key));
    assert.equal(replay.body['status'], 'executed');
    assert.equal(replay.body['replayed'], true);
  });

  it('Q20 / T9 — concurrent identical requests produce one decision, one claim and one effect', async () => {
    context.set(PAYABLES_WORLD);
    const before = booted.calls.length;
    const key = nextKey('core06-t9');
    const replies = await Promise.all([govern(settle(), key), govern(settle(), key), govern(settle(), key)]);
    assert.equal(booted.calls.length, before + 1, `exactly one effect: ${replies.map((r) => r.text).join(' | ')}`);
    assert.equal(replies.filter((r) => r.body['status'] === 'executed' && r.body['replayed'] !== true).length, 1);
    const executionIds = new Set(replies.map((r) => r.body['executionId']).filter((id) => id !== undefined));
    assert.equal(executionIds.size, 1, 'one execution identity');
  });

  it('Q1 — no credential, a wrong credential, a legacy key and an unbound principal are refused at admission', async () => {
    context.set(PAYABLES_WORLD);
    await noEffect('Q1', async () => {
      assert.equal((await call(booted.baseUrl, 'POST', '/api/governed-actions', { body: { idempotencyKey: nextKey(), ...settle() } })).status, 401);
      assert.equal((await governAs('not-a-configured-key', settle())).status, 401);
      assert.ok([401, 403].includes((await governAs(LEGACY_KEY, settle())).status), 'a legacy org key is not a customer principal');
      const unbound = await governAs(UNBOUND_KEY, settle());
      assert.equal(unbound.status, 403, unbound.text);
      assert.equal(unbound.body['decision'], undefined, 'no decision was made for an unbound principal');
    });
  });

  it('Q2 / M14 — the caller cannot name an organization, actor, principal, grant, approval, obligation result, adapter, provider or destination', async () => {
    context.set(PAYABLES_WORLD);
    const smuggled: readonly [string, unknown][] = [
      ['organizationId', 'org-attacker'],
      ['organization', 'org-attacker'],
      ['actorId', UNAUTHORIZED],
      ['principalId', 'principal-other'],
      ['subject', 'actor-owner'],
      ['grantId', 'grant-attacker'],
      ['boundedGrantId', 'grant-attacker'],
      ['grant', { scope: {} }],
      ['approvalProofId', 'approval-proof-attacker'],
      ['approval', { approved: true }],
      ['obligationsSatisfied', true],
      ['adapterId', ADAPTER_ID],
      ['adapter', { execute: true }],
      ['destinationUrl', 'https://attacker.example/'],
      ['url', 'https://attacker.example/'],
      ['providerCredential', 'sk_live_attacker'],
      ['executionId', 'exec-attacker'],
      ['expiresAt', '2999-01-01T00:00:00.000Z'],
      ['emergencyControl', { scope: 'global' }],
      ['governanceProfile', { id: 'invoice-settlement', version: 1 }],
      ['witnessCheckpoint', { sequence: 0 }],
    ];
    await noEffect('Q2 / M14', async () => {
      for (const [field, value] of smuggled) {
        const reply = await govern({ ...settle(), [field]: value });
        assert.equal(reply.status, 400, `${field}: ${reply.text}`);
        assert.equal(reply.body['decision'], undefined, `${field}: nothing was decided`);
      }
      // Inside the asserted-context channel too: trusted facts, obligation
      // satisfaction and approval are server-side. A caller assertion that
      // names them never supplies what the gate needs.
      context.set(PAYABLES_WORLD.filter((reading) => reading.key !== 'invoice.exists'));
      const fact = await govern({ ...settle(), assertedContext: { 'invoice.exists': true } });
      assert.ok(fact.status === 400 || fact.body['status'] === 'denied', `asserted material fact: ${fact.text}`);
      context.set([]);
      for (const assertedContext of [{ obligationsSatisfied: true }, { 'change.approval': 'discharged' }]) {
        const obligation = await govern({ ...deploy(), assertedContext });
        assert.ok(obligation.status === 400 || obligation.body['withheldBy'] === 'obligations', `asserted obligation: ${obligation.text}`);
      }
      context.set(payablesWorld(LARGE));
      for (const assertedContext of [{ approved: true }, { approvalProofId: 'proof-attacker' }]) {
        const approval = await govern({ ...settle(LARGE), assertedContext });
        assert.ok(approval.status === 400 || approval.body['withheldBy'] === 'approval', `asserted approval: ${approval.text}`);
      }
    });
  });

  it('Q3 — a bound actor the Kernel does not recognize is denied by the Kernel', async () => {
    context.set(PAYABLES_WORLD);
    const reply = await noEffect('Q3', () => governAs(UNRECOGNIZED_KEY, settle()));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.ok(reasonCodes(reply).some((code) => code.startsWith('RECOGNITION_')), reply.text);
  });

  it('Q4 — a recognized actor with no live authority is denied by the Kernel', async () => {
    context.set(PAYABLES_WORLD);
    const reply = await noEffect('Q4', () => governAs(UNAUTHORIZED_KEY, settle()));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.ok(!reasonCodes(reply).some((code) => code.startsWith('RECOGNITION_')), `recognized, but without authority: ${reply.text}`);
  });

  it('Q5 — the organization’s deterministic policy denies', async () => {
    context.set(PAYABLES_WORLD);
    const reply = await noEffect('Q5', () => govern(settle(499)));
    await assertDenied(booted.host, reply, 'INVOICE_AMOUNT_MISMATCH');
  });

  it('Q6 — what the trusted Governance Profile does not allow the envelope to say is rejected before any decision', async () => {
    context.set(PAYABLES_WORLD);
    await noEffect('Q6', async () => {
      for (const intent of [
        { action: SETTLE, resource: PAYABLES, parameters: { invoiceTotal: 500 } },
        { action: SETTLE, resource: PAYABLES, parameters: { invoiceTotal: '500', destination: 'supplier-x' } },
        { ...settle(), parameters: { invoiceTotal: 500, destination: 'supplier-x', recordCount: 1 } },
        { ...settle(), expectedGovernanceProfile: { id: 'invoice-settlement', version: 2 } },
        { ...settle(), expectedGovernanceProfile: { id: 'customer-data-export', version: 1 } },
      ]) {
        const reply = await govern(intent);
        assert.equal(reply.status, 400, `${JSON.stringify(intent)}: ${reply.text}`);
        assert.equal(reply.body['decision'], undefined);
      }
    });
  });

  it('Q6 — a malformed Governance Profile refuses the Host: it never starts, nothing listens', async () => {
    const broken = workspace.dir();
    const governance = governanceWith(APPROVAL, undefined);
    const file = governedFile({
      governance: { ...governance, profiles: [{ ...(governance.profiles ?? [])[0], parameters: [{ dimension: 'undeclaredDimension', required: true }] }, ...(governance.profiles ?? []).slice(1)] },
    });
    await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(secureEnv(broken, file)), policyPackProvider: policyPackProvider(RULES) }));
  });

  it('Q7 — a required material fact missing fails closed at the Trusted Context Boundary', async () => {
    context.set(PAYABLES_WORLD.filter((reading) => reading.key !== 'invoice.exists'));
    const reply = await noEffect('Q7', () => govern(settle()));
    await assertDenied(booted.host, reply, 'CONTEXT_REQUIRED_FACT_UNRESOLVED');
  });

  it('Q8 — a stale, future-dated or unauthorized-source fact is inadmissible', async () => {
    const stale = PAYABLES_WORLD.map((reading) => (reading.key === 'invoice.amount' ? { ...reading, ageSeconds: 901 } : reading));
    const future = PAYABLES_WORLD.map((reading) => (reading.key === 'invoice.amount' ? { ...reading, ageSeconds: -60 } : reading));
    const wrongSource = PAYABLES_WORLD.map((reading) => (reading.key === 'invoice.amount' ? { ...reading, sourceId: 'support-desk' } : reading));
    for (const [label, readings, code] of [
      ['stale', stale, 'CONTEXT_REQUIRED_FACT_STALE'],
      ['future-dated', future, 'CONTEXT_REQUIRED_FACT_TIME_INVALID'],
      ['source not authorized for the fact class', wrongSource, 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
    ] as const) {
      context.set(readings);
      const reply = await noEffect(`Q8 ${label}`, () => govern(settle()));
      await assertDenied(booted.host, reply, code, label);
    }
  });

  it('Q9 — an admitted restrictive RiskSignal restricts; a benign one widens nothing, satisfies no approval and lifts no denial', async () => {
    const signal = (value: string): Reading => ({ key: RISK_SIGNAL, value, sourceId: 'configured-risk-source' });
    context.set([...PAYABLES_WORLD, signal('high')]);
    await assertDenied(booted.host, await noEffect('Q9 high', () => govern(settle())), 'RESTRICTIVE_SIGNAL_HIGH');
    context.set([...PAYABLES_WORLD, signal('elevated')]);
    assertWithheld(await noEffect('Q9 elevated', () => govern(settle())), 'approval');
    // A benign signal cannot lift a policy denial ...
    context.set([...PAYABLES_WORLD, signal('low')]);
    await assertDenied(booted.host, await noEffect('Q9 low + mismatch', () => govern(settle(499))), 'INVOICE_AMOUNT_MISMATCH');
    // ... nor satisfy an approval requirement.
    context.set([...payablesWorld(LARGE), signal('low')]);
    assertWithheld(await noEffect('Q9 low + large', () => govern(settle(LARGE))), 'approval', 'GOVERNED_ACTION_APPROVAL_PENDING');
  });

  it('Q10 — a blocking obligation withholds; a self-reported discharge and a caller assertion do not satisfy it; a verified discharge does, exactly once', async () => {
    context.set([]);
    const key = nextKey('core06-q10');
    const first = await noEffect('Q10', () => govern(deploy(), key));
    assertWithheld(first, 'obligations');
    const discharges = booted.host.enterprise.obligationDischarges;
    assert.ok(discharges !== undefined);
    const record = (sourceId: string) =>
      discharges.record(
        { system: true, actorId: 'operator:change-board' },
        {
          correlation: { requestId: first.body['requestId'] as string, action: DEPLOY, resourceScope: PRODUCTION },
          obligationType: 'change.approval',
          sourceId,
          outcome: 'discharged',
          observedAt: new Date(Date.now() - 1000).toISOString(),
          reference: `${sourceId}:cab-1`,
          subjectId: AGENT,
        },
      );
    await record('ticket-notes');
    assertWithheld(await noEffect('Q10 self-reported', () => govern(deploy(), key)), 'obligations');
    const before = booted.calls.length;
    await record('change-approvals');
    assert.equal((await govern(deploy(), key)).body['status'], 'executed');
    assert.equal(booted.calls.length, before + 1);
    assert.equal((await noEffect('Q10 replay', () => govern(deploy(), key))).body['status'], 'executed');
  });

  it('Q11 / Q12 — approval pending withholds; a completed approval revoked before use releases nothing; a standing one executes exactly once', async () => {
    context.set(payablesWorld(LARGE));
    const revokedKey = nextKey('core06-q12');
    const pending = await noEffect('Q11', () => govern(settle(LARGE), revokedKey));
    assertWithheld(pending, 'approval', 'GOVERNED_ACTION_APPROVAL_PENDING');
    const view = await describeApproval(booted.host, pending);
    await approvals(booted.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted.host).approve(as(APPROVER_B), commandFor(view));
    await approvals(booted.host).revoke(as(APPROVER_C), { ...commandFor(view), reason: 'core06-qualification' });
    assertWithheld(await noEffect('Q12', () => govern(settle(LARGE), revokedKey)), 'approval', 'GOVERNED_ACTION_APPROVAL_REVOKED');

    // Control: the same flow without the revocation executes exactly once.
    const key = nextKey('core06-q11');
    const second = await govern(settle(LARGE), key);
    const approved = await describeApproval(booted.host, second);
    await approvals(booted.host).approve(as(APPROVER_A), commandFor(approved));
    await approvals(booted.host).approve(as(APPROVER_B), commandFor(approved));
    const before = booted.calls.length;
    assert.equal((await govern(settle(LARGE), key)).body['status'], 'executed');
    assert.equal(booted.calls.length, before + 1);
  });

  it('Q16 — an emergency stop active before the request withholds; its release restores only what was never revoked', async () => {
    context.set(PAYABLES_WORLD);
    for (const scope of [{ scope: 'global' }, { scope: 'organization', value: ORG }, { scope: 'actor', value: AGENT }, { scope: 'resource', value: PAYABLES }]) {
      await stop(scope);
      assertWithheld(await noEffect(`Q16 ${JSON.stringify(scope)}`, () => govern(settle())), 'emergency-control');
      await resume(scope);
    }
    const before = booted.calls.length;
    assert.equal((await govern(settle())).body['status'], 'executed');
    assert.equal(booted.calls.length, before + 1);
  });

  it('Q16 / T6 — an adapter-scoped stop is honoured at the registry: after issuance and the reservation, before the provider', async () => {
    const { reply, grant, key } = await strand(settle());
    assert.ok(grant.id.length > 0, 'a grant was issued before the registry checkpoint');
    assert.equal((reply.body['decision'] as { readonly status?: string } | undefined)?.status, 'allowed');
    // Replay of the withheld request stays withheld with the stop cleared: the
    // recorded outcome is what happened, and nothing re-executes (M22).
    context.set(PAYABLES_WORLD);
    const replay = await noEffect('T6 replay', () => govern(settle(), key));
    assertWithheld(replay, 'emergency-control');
  });

  it('Q19 — an authorized action with no configured route reaches no adapter', async () => {
    context.set([{ key: 'supportCase.open', value: true, sourceId: 'support-desk' }]);
    const reply = await noEffect('Q19', () => govern({ action: READ, resource: CUSTOMER_DATA, parameters: { recordCount: 5 } }));
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assert.equal((reply.body['decision'] as { readonly status?: string } | undefined)?.status, 'allowed', 'the Kernel authorized it; routing still found no adapter');
  });

  it('T10 — a different request under a committed idempotency key is refused; the committed decision is never substituted', async () => {
    context.set(PAYABLES_WORLD);
    const key = nextKey('core06-t10');
    assert.equal((await govern(settle(), key)).body['status'], 'executed');
    await noEffect('T10', async () => {
      for (const intent of [settle(500, 'supplier-y'), { ...settle(), resource: CUSTOMER_DATA }, deploy()]) {
        const reply = await govern(intent, key);
        // 409: the same key names a different committed request. 400: the substitute is not even a valid envelope.
        assert.ok(reply.status === 409 || reply.status === 400, `${JSON.stringify(intent)}: ${reply.text}`);
        assert.notEqual(reply.body['status'], 'executed');
      }
    });
  });
});

describe('CORE-06 §11 — exercise-time guarantees over a genuine issued grant (grant → exercise binding)', () => {
  it('control: a stranded grant is exercisable when nothing has changed — so every zero below is load-bearing', async () => {
    const { grant } = await strand(settle());
    assert.equal((await ace().assessExercise(settleAttempt(grant, 'exec-core06-control'))).usable, true);
    const before = booted.calls.length;
    const outcome = await ace().exercise(settleAttempt(grant, 'exec-core06-control'));
    assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
    assert.equal(booted.calls.length, before + 1);
  });

  it('Q18 — every substitution of a genuine grant is withheld before the adapter: actor, action, resource, organization, profile, classes, parameters', async () => {
    const { grant } = await strand(settle());
    const genuine = settleAttempt(grant, 'exec-core06-q18');
    const cases: readonly [string, GrantExerciseRequest, string][] = [
      ['different actor', { ...genuine, subject: 'actor-owner' }, E.GRANT_EXERCISE_SUBJECT_MISMATCH],
      ['different action', { ...genuine, action: DEPLOY }, E.GRANT_EXERCISE_ACTION_OUT_OF_SCOPE],
      ['different resource', { ...genuine, resource: PRODUCTION }, E.GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE],
      ['different organization', { ...genuine, organization: 'org-attacker' }, E.GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE],
      ['wider parameter', settleAttempt(grant, 'x', 501), E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
      ['different destination', settleAttempt(grant, 'x', 500, 'supplier-attacker'), E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
      ['smuggled extra dimension', { ...genuine, parameters: [...(genuine.parameters ?? []), { dimension: 'recordCount', type: 'integer', value: 1 }] }, E.GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE],
      ['different semantic profile', { ...genuine, governanceProfile: `${genuine.governanceProfile ?? ''}x` }, E.GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH],
      ['different action class', { ...genuine, actionClass: 'deploy' }, E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH],
      ['different resource class', { ...genuine, resourceClass: 'production_environment' }, E.GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH],
      ['altered correlation (source lineage)', { ...genuine, correlation: { ...genuine.correlation, decisionId: 'decision-attacker' } }, E.GRANT_EXERCISE_CORRELATION_INVALID],
    ];
    await noEffect('Q18', async () => {
      for (const [name, attempt, code] of cases) {
        const request = { ...attempt, executionId: `exec-core06-q18-${name.replace(/\W+/g, '-')}` };
        const assessment = await ace().assessExercise(request);
        assert.equal(assessment.usable, false, name);
        assert.ok(assessment.reasonCodes.includes(code as never), `${name}: ${JSON.stringify(assessment.reasonCodes)}`);
        assert.equal((await ace().exercise(request)).status, 'withheld', name);
      }
    });
  });

  it('Q13 / T2 — a grant revoked through the administration API after issuance is withheld at exercise, and the request never re-executes', async () => {
    const { grant, key } = await strand(settle());
    const revoked = await admin('POST', `/api/admin/authority/grants/${encodeURIComponent(grant.id)}/revoke`, { reason: 'security-incident' });
    assert.equal(revoked.status, 200, revoked.text);
    await noEffect('Q13', async () => {
      const outcome = await ace().exercise(settleAttempt(grant, 'exec-core06-q13'));
      assert.equal(outcome.status, 'withheld', JSON.stringify(outcome));
      assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_REVOKED));
      // The original request, retried by its caller, is answered from its record.
      assert.notEqual((await govern(settle(), key)).body['status'], 'executed');
    });
  });

  it('T5 — an emergency stop activated after issuance is honoured by the exercise gate', async () => {
    const { grant } = await strand(settle());
    await stop({ scope: 'global' });
    try {
      const outcome = await noEffect('T5', () => ace().exercise(settleAttempt(grant, 'exec-core06-t5')));
      assert.equal(outcome.status, 'withheld');
      assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control', JSON.stringify(outcome));
    } finally {
      await resume({ scope: 'global' });
    }
  });

  it('T7 — a grant never outlives its trusted context: once the earliest material fact is stale, the grant is expired at exercise', async () => {
    // invoice.amount is admitted with 6 s of its 900 s freshness left.
    const nearlyStale = PAYABLES_WORLD.map((reading) => (reading.key === 'invoice.amount' ? { ...reading, ageSeconds: 894 } : reading));
    const { grant } = await strand(settle(), nearlyStale);
    const remaining = Date.parse(grant.expiresAt) - Date.now();
    assert.ok(remaining <= 6_000, `the grant is capped at the context's validity (${remaining} ms left)`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 250));
    const outcome = await noEffect('T7', () => ace().exercise(settleAttempt(grant, 'exec-core06-t7')));
    assert.ok(outcome.status === 'withheld' && outcome.assessment.reasonCodes.includes(E.GRANT_EXERCISE_EXPIRED), JSON.stringify(outcome));
  });

  it('Q14 / T2 — authority lineage revoked after issuance: the exercise gate re-resolves it and withholds (run last: it revokes the agent’s delegation)', async () => {
    const { grant } = await strand(settle());
    const revoked = await admin('POST', `/api/admin/authority/entities/delegation-grant/${encodeURIComponent('delegation-agent')}/revoke`, { reason: 'core06-qualification' });
    assert.equal(revoked.status, 200, revoked.text);
    const outcome = await noEffect('Q14', () => ace().exercise(settleAttempt(grant, 'exec-core06-q14')));
    assert.equal(outcome.status, 'withheld', JSON.stringify(outcome));
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'exercise-control', JSON.stringify(outcome));
    // And through the public route, the Kernel now denies.
    context.set(PAYABLES_WORLD);
    assert.equal((await noEffect('Q14 new request', () => govern(settle()))).body['status'], 'denied');
  });
});
