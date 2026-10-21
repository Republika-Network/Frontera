import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { validateGovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import type { CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import type { GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import {
  GOVERNED_ACTION_REASON_CODES as R,
  deriveGovernedActionExecutionId,
  deriveGovernedActionRequestId,
  governedActionIdempotencyScope,
  type GovernedActionResult,
} from '../governed-action/index.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import {
  ALLOWED_INTENT,
  APPROVAL_INTENT,
  DENIED_ACTOR,
  DENIED_INTENT,
  EVALUATED_AT_POLICY,
  IDENTITY,
  NO_TEMPORAL_BOUND,
  ORG,
  PMFREAK_ACTOR_ID,
  TRUST_DOMAIN_ID,
  buildGovernedWorld,
  identityFor,
} from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01B0 — request-id cross-path isolation.
 *
 * The Governance Store holds one request-id space (`request_id` is globally
 * UNIQUE), shared by the advisory evaluate route and the governed-action path.
 * The governed path derives its request id from values an outsider can know
 * (organization, principal id, idempotency key), and the Store's idempotency
 * resolver fell back to a bare request-id lookup whenever the governed claim
 * was absent. An evaluate caller could therefore occupy a governed request
 * identity before its principal used it, and the governed path would refuse
 * (mismatched payload) or adopt (equivalent payload) the planted record.
 *
 * Two layers, each tested on its own here:
 *
 * - **L1 — ingress.** `POST /api/governance/evaluate` refuses a request id
 *   that is not a non-empty string, or that falls in the server-derived `aoc.`
 *   namespace (trimmed, any case). Tested at the contract and over HTTP.
 * - **L2 — provenance.** A probe that carries the governed-action path's own
 *   claim is answered by that claim alone: a record standing at the request id
 *   without it is never replayed or adopted, in either Store provider, on the
 *   pre-Kernel probe and inside the append transaction. Tested at the Store,
 *   and through the real orchestrator against records planted directly — the
 *   shape of records committed before L1 existed, which L1 cannot remove.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const PRINCIPAL = IDENTITY.principal.principalId;
const ENTERPRISE_CONTEXT = { enterpriseVersion: 'test', lifecycleState: 'ready', modules: [] } as const;
const GOVERNED_CONTEXT: GovernanceStoreAccessContext = { system: false, organizationId: ORG, actorId: PMFREAK_ACTOR_ID };

// ---------------------------------------------------------------------------
// Store providers: every L2 case runs against both.

interface Provider {
  readonly name: string;
  open(): Promise<GovernanceStore>;
}

const opened: GovernanceStore[] = [];
after(async () => {
  for (const store of opened) await store.close().catch(() => {});
});

const PROVIDERS: readonly Provider[] = [
  { name: 'in-memory', open: async () => track(createInMemoryGovernanceStore()) },
  { name: 'sqlite', open: async () => track(await createSqliteGovernanceStore(':memory:')) },
];

function track(store: GovernanceStore): GovernanceStore {
  opened.push(store);
  return store;
}

// ---------------------------------------------------------------------------
// Planting: an advisory record at a governed request identity.

interface Captured {
  readonly request: KernelEvaluationRequest;
  readonly result: KernelEvaluationResult;
}

/**
 * The exact Kernel request the governed path builds for `identity` + `intent`,
 * and the Kernel's answer to it — captured from a throwaway world. Its decision
 * ids start far from the victim world's, so a planted record never collides
 * with a decision the victim's Kernel could make.
 */
async function captureGovernedRequest(identity: typeof IDENTITY, intent: Record<string, unknown>): Promise<Captured> {
  const probe = buildGovernedWorld({ kernelIdStart: 900 });
  await probe.orchestrator.govern(identity, intent);
  const request = probe.kernelRequests[0];
  const result = probe.kernelResults[0];
  assert.ok(request !== undefined && result !== undefined, 'the probe world ran the Kernel once');
  return { request, result };
}

/** What the advisory evaluate Kernel returns: the same decision with no grant projection (it is composed without grants). */
function advisory(result: KernelEvaluationResult): KernelEvaluationResult {
  return Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'grants')) as unknown as KernelEvaluationResult;
}

/** Commits a record exactly as `POST /api/governance/evaluate` commits one: system context, the body's organization and actor, no governed claim. */
async function plant(store: GovernanceStore, request: KernelEvaluationRequest, result: KernelEvaluationResult): Promise<string> {
  const appended = await store.appendEvaluation({
    request,
    result: advisory(result),
    receivedAt: request.requestedAt,
    enterpriseContext: ENTERPRISE_CONTEXT,
    events: [],
    accessContext: { system: true, organizationId: ORG, actorId: request.actor.id },
  });
  assert.equal(appended.created, true, 'the advisory record was committed');
  return appended.evaluationId;
}

function governedClaim(idempotencyKey: string): { readonly scope: string; readonly idempotencyKey: string } {
  return { scope: governedActionIdempotencyScope({ organizationId: ORG, principalId: PRINCIPAL }), idempotencyKey };
}

async function evaluationAt(store: GovernanceStore, requestId: string): Promise<string | undefined> {
  return (await store.getByRequestId({ system: true }, requestId))?.evaluation.evaluationId;
}

function assertRefusedWithoutAdopting(result: GovernedActionResult, planted: string, world: ReturnType<typeof buildGovernedWorld>, kernelRuns: number): void {
  assert.equal(result.status, 'rejected', `the planted record is not this request's decision: ${JSON.stringify(result)}`);
  assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT], 'the existing idempotency-conflict semantics, no new public code');
  assert.notEqual(result.decision?.evaluationId, planted, 'the planted decision is never surfaced as this request’s');
  assert.equal(world.kernelRequests.length, kernelRuns);
  assert.equal(world.log.indexOf('grantStore.issue'), -1, 'no grant is issued');
  assert.equal(world.adapter.callCount, 0, 'nothing executes');
  assert.ok(!world.events.some((event) => event.type === 'GovernanceRecordCommitted'), 'nothing is committed for this request');
}

// ---------------------------------------------------------------------------
// L1 — the evaluate contract.

describe('G-01B0 L1 — the evaluate contract refuses caller request ids in the server-derived namespace', () => {
  const refuses = (requestId: unknown, label: string): void => {
    assert.throws(
      () => validateGovernanceEvaluateRequestBody({ ...buildAllowedRequestBody(), requestId }),
      (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400 && error.code === 'INVALID_REQUEST',
      `${label} is refused with 400 INVALID_REQUEST`,
    );
  };
  const accepts = (requestId: string | undefined, label: string): void => {
    const body = validateGovernanceEvaluateRequestBody({ ...buildAllowedRequestBody(), ...(requestId !== undefined ? { requestId } : {}) });
    assert.equal(body.requestId, requestId, `${label} is accepted unchanged`);
  };

  it('refuses every governed and server-derived identifier shape', () => {
    const governed = deriveGovernedActionRequestId({ organizationId: ORG, principalId: PRINCIPAL, idempotencyKey: 'k' });
    refuses(governed, 'a derived governed request id');
    refuses(deriveGovernedActionExecutionId({ requestId: governed, decisionId: 'decision-1' }), 'a derived execution id');
    for (const id of ['aoc.gar:x', 'aoc.exec:x', 'aoc.intent:x', 'aoc.grant:x', 'aoc.aes:x', 'aoc.', 'aoc.anything']) refuses(id, id);
  });

  it('refuses case and whitespace variants of the reserved prefix', () => {
    for (const id of ['AOC.gar:x', 'Aoc.Gar:x', 'aOC.exec:x', ' aoc.gar:x', '\taoc.gar:x', '\naoc.gar:x', ' aoc.gar:x', '﻿aoc.gar:x', '  AOC.gar:x  ']) refuses(id, JSON.stringify(id));
  });

  it('refuses a JSON-escaped reserved prefix: validation sees the decoded string', () => {
    const decoded = (JSON.parse('{"requestId":"\\u0061oc.gar:x"}') as { requestId: unknown }).requestId;
    refuses(decoded, 'an escaped prefix');
  });

  it('refuses a request id that is not a non-empty string', () => {
    for (const value of [123, 0, true, false, null, '', ['aoc.gar:x'], { id: 'aoc.gar:x' }]) refuses(value, JSON.stringify(value));
  });

  it('accepts ordinary request ids, near-miss lookalikes and an omitted id', () => {
    for (const id of ['req-1', 'aoc', 'aoc:x', 'aocx.gar:x', 'xaoc.gar:x', 'aoc-gar:x', 'my.aoc.gar:x', 'ａｏｃ.gar:x']) accepts(id, JSON.stringify(id));
    accepts(undefined, 'an omitted request id');
  });

  it('every identifier the governed path derives lies in the reserved namespace', () => {
    const governed = deriveGovernedActionRequestId({ organizationId: ORG, principalId: PRINCIPAL, idempotencyKey: 'k' });
    assert.ok(governed.startsWith('aoc.'), governed);
    assert.ok(deriveGovernedActionExecutionId({ requestId: governed, decisionId: 'd' }).startsWith('aoc.'));
  });
});

// ---------------------------------------------------------------------------
// L2 — the Store resolver, both providers.

for (const provider of PROVIDERS) {
  describe(`G-01B0 L2 — ${provider.name} Store: a governed probe never resolves to a record without its own claim`, () => {
    it('an equivalent planted record is a conflict, never a replay — on the pre-Kernel probe', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      await plant(store, request, result);
      const resolution = await store.resolveIdempotency(GOVERNED_CONTEXT, {
        requestId: request.requestId,
        payloadDigest: computeGovernanceRequestPayloadDigest(request),
        idempotency: governedClaim(ALLOWED_INTENT.idempotencyKey),
      });
      assert.deepEqual(resolution, { kind: 'conflict', conflictKind: 'request-id' });
    });

    it('unchanged: a mismatched planted record is a conflict', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      await plant(store, { ...request, action: { ...request.action, resourceScope: 'project:planted' } }, result);
      const resolution = await store.resolveIdempotency(GOVERNED_CONTEXT, {
        requestId: request.requestId,
        payloadDigest: computeGovernanceRequestPayloadDigest(request),
        idempotency: governedClaim(ALLOWED_INTENT.idempotencyKey),
      });
      assert.deepEqual(resolution, { kind: 'conflict', conflictKind: 'request-id' });
    });

    it('inside the append transaction the planted record is a conflict, never an idempotent replay', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      const planted = await plant(store, request, result);
      await assert.rejects(
        store.appendEvaluation({ request, result, receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], idempotency: governedClaim(ALLOWED_INTENT.idempotencyKey), accessContext: GOVERNED_CONTEXT }),
        (error: unknown) => (error as { code?: string }).code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT',
      );
      assert.equal(await evaluationAt(store, request.requestId), planted, 'the planted record is untouched');
    });

    it('unchanged: an evaluate-route probe (no claim, or an org-scoped claim) still replays an equivalent record', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      const planted = await plant(store, request, result);
      const payloadDigest = computeGovernanceRequestPayloadDigest(request);
      const evaluateContext: GovernanceStoreAccessContext = { system: true, organizationId: ORG, actorId: PMFREAK_ACTOR_ID };
      const bare = await store.resolveIdempotency(evaluateContext, { requestId: request.requestId, payloadDigest });
      assert.equal(bare.kind, 'replay');
      assert.equal(bare.kind === 'replay' ? bare.record.evaluation.evaluationId : undefined, planted);
      const scoped = await store.resolveIdempotency(evaluateContext, { requestId: request.requestId, payloadDigest, idempotency: { scope: `org:${ORG}`, idempotencyKey: 'caller-key' } });
      assert.equal(scoped.kind, 'replay');
    });

    it('unchanged: the governed path’s own claim still replays its own record, on the probe and in the transaction', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      const claim = governedClaim(ALLOWED_INTENT.idempotencyKey);
      const first = await store.appendEvaluation({ request, result, receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], idempotency: claim, accessContext: GOVERNED_CONTEXT });
      assert.equal(first.created, true);
      const probe = await store.resolveIdempotency(GOVERNED_CONTEXT, { requestId: request.requestId, payloadDigest: computeGovernanceRequestPayloadDigest(request), idempotency: claim });
      assert.equal(probe.kind, 'replay');
      const again = await store.appendEvaluation({ request, result, receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], idempotency: claim, accessContext: GOVERNED_CONTEXT });
      assert.equal(again.idempotentReplay, true);
      assert.equal(again.evaluationId, first.evaluationId);
    });
  });

  // -------------------------------------------------------------------------
  // L2 — through the real orchestrator: planted decisions of every kind.

  describe(`G-01B0 L2 — ${provider.name} Store: the governed path never adopts a planted advisory decision`, () => {
    const cases: readonly { readonly label: string; readonly identity: typeof IDENTITY; readonly intent: Record<string, unknown>; readonly status: string }[] = [
      { label: 'denied', identity: identityFor({ actorId: DENIED_ACTOR }), intent: DENIED_INTENT, status: 'denied' },
      { label: 'allowed', identity: IDENTITY, intent: ALLOWED_INTENT, status: 'allowed' },
      { label: 'approval_required', identity: IDENTITY, intent: APPROVAL_INTENT, status: 'approval_required' },
    ];

    for (const scenario of cases) {
      it(`an equivalent planted ${scenario.label} record is refused before the Kernel, never replayed`, async () => {
        const store = await provider.open();
        const { request, result } = await captureGovernedRequest(scenario.identity, scenario.intent);
        assert.equal(result.status, scenario.status, 'the planted decision is the kind under test');
        const planted = await plant(store, request, result);
        const world = buildGovernedWorld({ store });
        const governed = await world.orchestrator.govern(scenario.identity, scenario.intent);
        assert.equal(governed.requestId, request.requestId, 'the planted record stood at exactly this governed request identity');
        assertRefusedWithoutAdopting(governed, planted, world, 0);
        assert.equal(await evaluationAt(store, request.requestId), planted, 'the planted record is untouched');
      });
    }

    it('unchanged: a mismatched planted record is refused before the Kernel', async () => {
      const store = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      const planted = await plant(store, { ...request, action: { ...request.action, resourceScope: 'project:planted' } }, result);
      const world = buildGovernedWorld({ store });
      assertRefusedWithoutAdopting(await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT), planted, world, 0);
    });

    it('race: a record planted between the probe and the append is refused, and this call’s transient decision is discarded', async () => {
      const inner = await provider.open();
      const { request, result } = await captureGovernedRequest(IDENTITY, ALLOWED_INTENT);
      let planted: string | undefined;
      const store = new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          if (property === 'appendEvaluation') {
            return async (...args: unknown[]) => {
              if (planted === undefined) planted = await plant(target, request, result);
              return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
            };
          }
          return (value as (...inner: unknown[]) => unknown).bind(target);
        },
      });
      const world = buildGovernedWorld({ store });
      const governed = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.ok(planted !== undefined, 'the record was planted inside the window');
      assertRefusedWithoutAdopting(governed, planted, world, 1);
      assert.equal(await evaluationAt(inner, request.requestId), planted);
    });

    it('unchanged: a retry of the same key replays the committed decision without re-running the Kernel', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      const second = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(first.status, 'executed');
      assert.equal(second.status, 'executed');
      assert.equal(second.decision?.evaluationId, first.decision?.evaluationId);
      assert.equal(world.kernelRequests.length, 1);
      assert.equal(world.adapter.callCount, 1);
    });

    it('unchanged: concurrent calls for one key commit one decision and execute at most once', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const [a, b] = await Promise.all([world.orchestrator.govern(IDENTITY, ALLOWED_INTENT), world.orchestrator.govern(IDENTITY, ALLOWED_INTENT)]);
      assert.equal(a.requestId, b.requestId);
      assert.ok(a.decision?.evaluationId !== undefined && a.decision.evaluationId === b.decision?.evaluationId, 'one committed decision answers both');
      assert.ok(world.adapter.callCount <= 1, 'at most one execution');
    });

    it('unchanged: the same key under another principal is an independent request', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      const other = await world.orchestrator.govern(identityFor({ principalId: 'principal-pmfreak-ops' }), ALLOWED_INTENT);
      assert.notEqual(other.requestId, first.requestId);
      assert.equal(first.status, 'executed');
      assert.equal(other.status, 'executed');
      assert.notEqual(other.decision?.evaluationId, first.decision?.evaluationId);
    });

    it('unchanged: the same key with a different payload is the existing idempotency conflict', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      const conflict = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, resource: 'project:other' });
      assert.equal(conflict.status, 'rejected');
      assert.deepEqual([...conflict.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
      assert.equal(world.kernelRequests.length, 1);
    });
  });
}

// ---------------------------------------------------------------------------
// End to end: a composed Host, both routes, real HTTP.

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const VICTIM = 'G01B0_VICTIM_PRINCIPAL_SENTINEL';
const OTHER_PRINCIPAL = 'G01B0_OTHER_PRINCIPAL_SENTINEL';
const LEGACY = 'G01B0_LEGACY_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [
  { key: VICTIM, organizationId: ORG, customerIdentity: { principalId: PRINCIPAL, externalSubject: SUBJECT } },
  { key: OTHER_PRINCIPAL, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak-ops', externalSubject: SUBJECT } },
  { key: LEGACY, organizationId: ORG },
];

const servers: EnterpriseServer[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => {})));
});

let appends = 0;

function configuration(): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
  });
  return { ...base, authentication: { apiKeys: KEYS } };
}

function countingStore(): GovernanceStore {
  const raw = createInMemoryGovernanceStore();
  return new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'appendEvaluation') {
        return (...args: unknown[]) => {
          appends += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
}

function adapter(): RecordingExecutionAdapter {
  const inner = createRecordingExecutionAdapter(async () => ({ outcome: 'completed', providerRef: 'provider-ref-g01b0' }));
  return {
    adapterId: 'adapter-g01b0',
    calls: inner.calls,
    get callCount(): number {
      return inner.callCount;
    },
    execute: (action: ValidatedExecutionAction) => inner.execute(action),
  };
}

async function hostOptions(): Promise<CreateEnterpriseOptions> {
  const authority = createInMemoryKernelAuthorityStore();
  await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor({ system: true, actorId: 'operator-g01b0' }, { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT });
  return {
    configuration: configuration(),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: authority,
    persistence: countingStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: createInMemoryBoundedGrantStore(),
      executionAdapterRouting: { adapters: [adapter()], selectAdapter: () => 'adapter-g01b0' },
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [] },
    emergencyControl: { enabled: true, store: createInMemoryEmergencyControlStore() },
    executionOutcomes: { store: createInMemoryExecutionOutcomeStore({ now: () => new Date().toISOString() }) },
  };
}

let host: Promise<string> | undefined;
function baseUrl(): Promise<string> {
  host ??= (async () => {
    const server = await createEnterpriseServer(await hostOptions());
    servers.push(server);
    const { port } = await server.listen();
    return `http://127.0.0.1:${port}`;
  })();
  return host;
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function post(path: string, secret: string, body: unknown): Promise<Reply> {
  const response = await fetch(`${await baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];
let keySequence = 0;
const freshKey = (label: string): string => `g01b0-${label}-${(keySequence += 1)}`;

describe('G-01B0 — end to end: an evaluate caller cannot occupy a governed request identity', () => {
  for (const [label, attacker] of [
    ['an org-scoped legacy key', LEGACY],
    ['another customer principal of the same organization', OTHER_PRINCIPAL],
  ] as const) {
    it(`${label}: the pre-squat is refused at ingress and the victim's governed action proceeds`, async () => {
      const idempotencyKey = freshKey('victim');
      const victimRequestId = deriveGovernedActionRequestId({ organizationId: ORG, principalId: PRINCIPAL, idempotencyKey });
      const before = appends;
      const squat = await post('/api/governance/evaluate', attacker, buildAllowedRequestBody({ requestId: victimRequestId, organization: { id: ORG } }));
      assert.equal(squat.status, 400, squat.text);
      assert.equal(errorCode(squat), 'INVALID_REQUEST');
      assert.equal(appends, before, 'nothing was committed');

      const governed = await post('/api/governed-actions', VICTIM, { ...ALLOWED_INTENT, idempotencyKey });
      assert.equal(governed.body['requestId'], victimRequestId, 'the squat targeted exactly this governed request identity');
      assert.equal(governed.body['status'], 'executed', governed.text);
      assert.ok(!(governed.body['reasonCodes'] as string[]).includes(R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT));
    });
  }

  it('reserved variants and invalid request id types are refused over HTTP and commit nothing', async () => {
    const before = appends;
    const raw = (requestIdJson: string): string => {
      const body = buildAllowedRequestBody({ organization: { id: ORG } }) as unknown as Record<string, unknown>;
      return JSON.stringify(body).replace(/^\{/, `{"requestId":${requestIdJson},`);
    };
    for (const requestIdJson of ['"aoc.gar:x"', '"AOC.GAR:x"', '" aoc.exec:x"', '"\\u0061oc.gar:x"', '"aoc."', '123', '["aoc.gar:x"]', 'null', '""', '{"id":"aoc.gar:x"}']) {
      const reply = await post('/api/governance/evaluate', LEGACY, raw(requestIdJson));
      assert.equal(reply.status, 400, `${requestIdJson}: ${reply.text}`);
      assert.equal(errorCode(reply), 'INVALID_REQUEST', requestIdJson);
    }
    assert.equal(appends, before, 'no refused request reached the Governance Store');
  });

  it('unchanged: ordinary and lookalike request ids evaluate, and a repeated id replays its decision', async () => {
    for (const requestId of [`g01b0-ordinary-${freshKey('id')}`, `aocx.gar:${freshKey('id')}`, `ａｏｃ.gar:${freshKey('id')}`]) {
      const first = await post('/api/governance/evaluate', LEGACY, buildAllowedRequestBody({ requestId, organization: { id: ORG } }));
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body['requestId'], requestId);
      const again = await post('/api/governance/evaluate', LEGACY, buildAllowedRequestBody({ requestId, organization: { id: ORG } }));
      assert.equal(again.status, 200, again.text);
      const evaluationOf = (reply: Reply): unknown => (reply.body['governanceRecord'] as Record<string, unknown> | undefined)?.['evaluationId'];
      assert.equal(evaluationOf(again), evaluationOf(first), 'the same request id replays the recorded decision');
    }
    const generated = await post('/api/governance/evaluate', LEGACY, buildAllowedRequestBody({ organization: { id: ORG } }));
    assert.equal(generated.status, 200, generated.text);
    assert.match(String(generated.body['requestId']), /^enterprise-request-/, 'a generated id stays outside the reserved namespace');
  });
});
