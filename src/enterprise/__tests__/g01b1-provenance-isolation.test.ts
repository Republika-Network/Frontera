import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { buildAuthorityTrace } from '../evidence/trace-builder.js';
import {
  GOVERNANCE_ATTRIBUTION_VERSION,
  type GovernanceEvaluationAttribution,
  type GovernanceRecord,
  type GovernanceStoreAccessContext,
  type GovernanceStoreQuery,
  type GovernanceStoreQueryResult,
} from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { hasGovernedActionProvenance, resolveGovernedRecord, type GovernedProvenanceReader } from '../governance-store/governed-provenance.js';
import { toGovernanceRecordSummary } from '../governance-store/store-common.js';
import { GOVERNED_ACTION_REASON_CODES as R, deriveGovernedActionRequestId, type GovernedActionResult } from '../governed-action/index.js';
import { reconsiderationLinkReferenceId } from '../governed-action/identifiers.js';
import { AgentPassportError } from '../passport/errors.js';
import { createInMemoryPaymentRefundLedger, createPaymentRefundService, paymentRefundOperationId } from '../payment-settlement/index.js';
import { ALLOWED_INTENT, DENIED_ACTOR, DENIED_INTENT, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID, buildGovernedWorld, identityFor } from './governed-action-support.js';
import { BINDING, GOVERNED_ACCOUNT, IDENTITY, NOW, ORG, PAYMENT_ACTION, TEST_ASSETS, governed, payment, paymentWorld, settlementHarness } from './pay05-settlement-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01B1 — request namespace and provenance isolation.
 *
 * The Governance Store holds one request-id space written by two paths: the
 * advisory evaluate route (caller-chosen ids) and the governed-action path
 * (server-derived `aoc.gar:` ids, sealed with that path's own idempotency
 * claim in the same transaction). A record's id — even one in the `aoc.gar:`
 * shape — proves nothing about the path that wrote it: records planted before
 * G-01B0 sit at governed-looking ids, and advisory records carry any id and any
 * asserted actor. Only the governed-action claim (the PROD-03-01
 * `governed-action` predicate) proves governed provenance.
 *
 * Consumers that treat a record as a governed decision must therefore resolve
 * that claim, fail closed:
 *
 * - **P2-2** — a reconsideration's original must be a governed decision; an
 *   advisory, historical or pre-G-01B0 record is `RECONSIDERATION_TARGET_NOT_FOUND`.
 * - **ASSURE-01** — a trace is built only over a governed record (otherwise
 *   the existing not-found), and a lineage whose original is not governed fails
 *   `lineage.original-identity`.
 * - **PAY-05** — a refund's release basis is read only from a governed record;
 *   anything else leaves the reservation counted (`basis-unavailable`).
 * - **P2-3** — a Passport governance reference must state what the stored
 *   record states (request, decision, status), advisory records included.
 *
 * Hygiene: the in-memory idempotency index encodes (scope, key) unambiguously;
 * the evaluate route reads its body once; request-id and key conflicts answer
 * one text whatever their cause.
 *
 * **Residual (P2-1), characterized, not removed.** `request_id` stays unique
 * store-wide: a request id committed in one organization still answers another
 * organization's reuse with 409, and a deterministic id can be occupied first.
 * Removing that needs scoped request namespaces (a schema migration) — a later
 * milestone.
 */

const ENTERPRISE_CONTEXT = { enterpriseVersion: 'test', lifecycleState: 'ready', modules: [] } as const;
const SYSTEM: GovernanceStoreAccessContext = { system: true };
const TENANT: GovernanceStoreAccessContext = { system: false, organizationId: ORG };
const DENIED_IDENTITY = identityFor({ actorId: DENIED_ACTOR });
const DENIED_PRINCIPAL = DENIED_IDENTITY.principal.principalId;

// ---------------------------------------------------------------------------
// Store providers: every provenance case runs against both.

interface Provider {
  readonly name: string;
  open(): Promise<GovernanceStore>;
}

const opened: GovernanceStore[] = [];
const enterprises: AocEnterprise[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
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

let sequence = 0;
const fresh = (label: string): string => `g01b1-${label}-${(sequence += 1)}`;

// ---------------------------------------------------------------------------
// Records that did not come through the governed path.

interface Captured {
  readonly request: KernelEvaluationRequest;
  readonly result: KernelEvaluationResult;
}

/** The exact Kernel request and answer the governed path produces for `identity` + `intent`, from a throwaway world. */
async function captureGoverned(identity: typeof IDENTITY, intent: Record<string, unknown>): Promise<Captured> {
  const probe = buildGovernedWorld({ kernelIdStart: 900 });
  await probe.orchestrator.govern(identity, intent);
  const request = probe.kernelRequests[0];
  const result = probe.kernelResults[0];
  assert.ok(request !== undefined && result !== undefined, 'the probe world ran the Kernel once');
  return { request, result };
}

type PlantKind = 'pre-G-01A advisory (unattributed)' | 'G-01A advisory (legacy-asserted)' | 'pre-G-01B0 at a governed-looking id';
const PLANT_KINDS: readonly PlantKind[] = ['pre-G-01A advisory (unattributed)', 'G-01A advisory (legacy-asserted)', 'pre-G-01B0 at a governed-looking id'];

function legacyAttribution(request: KernelEvaluationRequest): GovernanceEvaluationAttribution {
  return { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'organization', organizationId: ORG, evaluatedActorId: request.actor.id, salt: '0123456789abcdef0123456789abcdef' };
}

/**
 * Commits `captured` at `requestId` exactly as a non-governed path commits a
 * record: no governed-action claim. Decision ids are made unique so several
 * plants can share one Store. The advisory Kernel never projects grants.
 */
async function plant(store: GovernanceStore, captured: Captured, requestId: string, kind: PlantKind): Promise<GovernanceRecord> {
  const label = fresh('plant');
  const request: KernelEvaluationRequest = { ...captured.request, requestId };
  const decisionId = `${captured.result.decisionId}-${label}`;
  const withoutGrants = Object.fromEntries(Object.entries(captured.result).filter(([key]) => key !== 'grants')) as unknown as KernelEvaluationResult;
  const result: KernelEvaluationResult = { ...withoutGrants, requestId, decisionId, trace: { ...captured.result.trace, decisionId } };
  const appended = await store.appendEvaluation({
    request,
    result,
    receivedAt: request.requestedAt,
    enterpriseContext: ENTERPRISE_CONTEXT,
    events: [],
    accessContext: kind === 'G-01A advisory (legacy-asserted)' ? { system: false, organizationId: ORG, actorId: request.actor.id } : { system: true, organizationId: ORG, actorId: request.actor.id },
    ...(kind === 'G-01A advisory (legacy-asserted)' ? { attribution: legacyAttribution(request) } : {}),
  });
  assert.equal(appended.created, true, 'the non-governed record was committed');
  const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
  assert.ok(record !== null);
  assert.equal((await store.verify(SYSTEM, appended.evaluationId)).valid, true, 'the planted record is structurally valid: integrity alone proves nothing about its path');
  return record;
}

/** The request id a plant of `kind` stands at: a caller-chosen id, or — before G-01B0 — the governed id of a key the principal had not used yet. */
function plantedRequestId(kind: PlantKind, principalId: string): string {
  return kind === 'pre-G-01B0 at a governed-looking id' ? deriveGovernedActionRequestId({ organizationId: ORG, principalId, idempotencyKey: fresh('squatted-key') }) : fresh('advisory-request');
}

function reconsider(of: string): Record<string, unknown> {
  return { ...DENIED_INTENT, idempotencyKey: fresh('reconsideration-key'), reconsideration: { of, reason: 'context-changed' } };
}

function assertTargetNotFound(result: GovernedActionResult, world: ReturnType<typeof buildGovernedWorld>, kernelRuns: number): void {
  assert.equal(result.status, 'rejected', `a non-governed record is not an original governed decision: ${JSON.stringify(result)}`);
  assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND], 'the existing refusal code, no new public code');
  assert.equal(world.kernelRequests.length, kernelRuns, 'refused before anything is evaluated');
  assert.equal(world.adapter.callCount, 0, 'nothing executes');
}

// ---------------------------------------------------------------------------
// The shared resolver — identical semantics on both providers.

for (const provider of PROVIDERS) {
  describe(`G-01B1 resolver — ${provider.name} Store: governed provenance is the governed-action claim, nothing else`, () => {
    it('a governed record is governed; every non-governed shape is not; an unknown id is absent', async () => {
      const store = await provider.open();
      const world = buildGovernedWorld({ store });
      const executed = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      const governedResolution = await resolveGovernedRecord(store, SYSTEM, executed.requestId ?? '');
      assert.equal(governedResolution.kind, 'governed');
      assert.equal((await resolveGovernedRecord(store, TENANT, executed.requestId ?? '')).kind, 'governed', 'in the tenant scope too');
      const captured = await captureGoverned(IDENTITY, ALLOWED_INTENT);
      for (const kind of PLANT_KINDS) {
        const planted = await plant(store, captured, plantedRequestId(kind, IDENTITY.principal.principalId), kind);
        for (const context of [SYSTEM, TENANT]) {
          const resolution = await resolveGovernedRecord(store, context, planted.request.requestId);
          assert.equal(resolution.kind, 'not-governed', `${kind}: a structurally valid record without the claim`);
          assert.equal(await hasGovernedActionProvenance(store, context, planted), false, kind);
        }
      }
      assert.equal((await resolveGovernedRecord(store, SYSTEM, fresh('unknown'))).kind, 'absent');
      assert.equal((await resolveGovernedRecord(store, { system: false, organizationId: 'org-g01b1-elsewhere' }, executed.requestId ?? '')).kind, 'absent', 'another organization’s governed record is not visible at all');
    });

    it('fails closed on a Store that cannot answer the predicate truthfully', async () => {
      const store = await provider.open();
      const world = buildGovernedWorld({ store });
      const executed = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      const record = await store.getByRequestId(SYSTEM, executed.requestId ?? '');
      assert.ok(record !== null);
      const summary = toGovernanceRecordSummary(record);
      const answering = (answer: () => Promise<GovernanceStoreQueryResult>): GovernedProvenanceReader => ({ getByRequestId: (context, requestId) => store.getByRequestId(context, requestId), query: answer });
      const cases: readonly (readonly [string, () => Promise<GovernanceStoreQueryResult>])[] = [
        ['no hit', async () => ({ records: [] })],
        ['a hit for another evaluation', async () => ({ records: [{ ...summary, evaluationId: `${summary.evaluationId}-other` }] })],
        ['a hit for another request id', async () => ({ records: [{ ...summary, requestId: `${summary.requestId}-other` }] })],
        ['a hit in another organization', async () => ({ records: [{ ...summary, organizationId: 'org-g01b1-elsewhere' }] })],
        ['two hits', async () => ({ records: [summary, summary] })],
        ['a malformed answer', async () => ({}) as unknown as GovernanceStoreQueryResult],
      ];
      for (const [label, answer] of cases) assert.equal((await resolveGovernedRecord(answering(answer), SYSTEM, record.evaluation.requestId)).kind, 'not-governed', label);
      await assert.rejects(resolveGovernedRecord(answering(async () => { throw new Error('store down'); }), SYSTEM, record.evaluation.requestId), /store down/, 'a Store failure propagates; it is never read as governed');
      assert.equal((await resolveGovernedRecord(answering(async () => ({ records: [summary] })), SYSTEM, record.evaluation.requestId)).kind, 'governed', 'the honest answer');
    });
  });
}

// ---------------------------------------------------------------------------
// P2-2 — reconsideration requires a governed original.

for (const provider of PROVIDERS) {
  describe(`G-01B1 P2-2 — ${provider.name} Store: only a governed decision can be reconsidered`, () => {
    for (const kind of PLANT_KINDS) {
      it(`a ${kind} record with the same actor and business intent is not an original: RECONSIDERATION_TARGET_NOT_FOUND`, async () => {
        const store = await provider.open();
        const captured = await captureGoverned(DENIED_IDENTITY, DENIED_INTENT);
        assert.equal(captured.result.status, 'denied', 'the planted record is withheld, the only kind a reconsideration may follow');
        const original = await plant(store, captured, plantedRequestId(kind, DENIED_PRINCIPAL), kind);
        const world = buildGovernedWorld({ store });
        const result = await world.orchestrator.govern(DENIED_IDENTITY, reconsider(original.request.requestId));
        assertTargetNotFound(result, world, 0);
        assert.equal(await store.getByRequestId(SYSTEM, result.requestId ?? ''), null, 'nothing is committed for the refused reconsideration');
      });
    }

    it('unchanged: a genuine denied governed original is reconsidered, linked and freshly evaluated', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const original = await world.orchestrator.govern(DENIED_IDENTITY, DENIED_INTENT);
      assert.equal(original.status, 'denied', JSON.stringify(original));
      const reconsideration = await world.orchestrator.govern(DENIED_IDENTITY, reconsider(original.requestId ?? ''));
      assert.equal(reconsideration.status, 'denied', `accepted, evaluated afresh and still denied: ${JSON.stringify(reconsideration)}`);
      assert.ok(!reconsideration.reasonCodes.includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND));
      assert.equal(world.kernelRequests.length, 2);
      const record = await world.rawStore.getByRequestId(SYSTEM, reconsideration.requestId ?? '');
      const link = record?.references.find((entry) => entry.referenceId === reconsiderationLinkReferenceId(reconsideration.requestId ?? ''));
      assert.equal(link?.externalId, original.requestId, 'the lineage names the governed original');
    });

    it('unchanged: another actor’s genuine governed original is still RECONSIDERATION_TARGET_OTHER_ACTOR (same-actor rule retained)', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const original = await world.orchestrator.govern(DENIED_IDENTITY, DENIED_INTENT);
      const other = await world.orchestrator.govern(identityFor({ principalId: 'principal-g01b1-other', actorId: PMFREAK_ACTOR_ID }), reconsider(original.requestId ?? ''));
      assert.equal(other.status, 'rejected');
      assert.deepEqual([...other.reasonCodes], [R.GOVERNED_ACTION_RECONSIDERATION_TARGET_OTHER_ACTOR]);
    });
  });
}

// ---------------------------------------------------------------------------
// ASSURE-01 — a governed trace needs a governed record.

/** A Store that claims the governed-action predicate holds for one extra request id — so a lineage to a non-governed original can be committed and then traced over the honest Store. */
function claimingGoverned(inner: GovernanceStore, forged: GovernanceRecord): GovernanceStore {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'query') {
        return async (context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult> =>
          query.governedPath === 'governed-action' && query.requestId === forged.request.requestId ? { records: [toGovernanceRecordSummary(forged)] } : target.query(context, query);
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
}

for (const provider of PROVIDERS) {
  describe(`G-01B1 ASSURE-01 — ${provider.name} Store: a trace is built only over a governed record`, () => {
    for (const kind of PLANT_KINDS.filter((candidate) => candidate === 'pre-G-01B0 at a governed-looking id')) {
      it(`a ${kind} record is not a governed request: the existing not-found, in system and tenant scope`, async () => {
        const store = await provider.open();
        const captured = await captureGoverned(IDENTITY, ALLOWED_INTENT);
        const planted = await plant(store, captured, plantedRequestId(kind, IDENTITY.principal.principalId), kind);
        assert.match(planted.request.requestId, /^aoc\.gar:[0-9a-f]{32}$/, 'the planted record has exactly the governed id shape');
        assert.equal(await buildAuthorityTrace({ governance: store }, SYSTEM, planted.request.requestId), null);
        assert.equal(await buildAuthorityTrace({ governance: store }, TENANT, planted.request.requestId), null);
      });
    }

    it('unchanged: a genuine governed record is traced', async () => {
      const world = buildGovernedWorld({ store: await provider.open() });
      const executed = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(executed.status, 'executed', JSON.stringify(executed));
      const build = await buildAuthorityTrace({ governance: world.rawStore }, SYSTEM, executed.requestId ?? '');
      assert.ok(build !== null, 'a governed request has a trace');
      assert.equal(build.record.evaluation.evaluationId, executed.decision?.evaluationId);
    });

    it('a lineage whose original is not a governed decision fails lineage.original-identity; a governed lineage passes', async () => {
      const store = await provider.open();
      const captured = await captureGoverned(DENIED_IDENTITY, DENIED_INTENT);
      const advisoryOriginal = await plant(store, captured, fresh('advisory-original'), 'G-01A advisory (legacy-asserted)');
      // The orchestrator is handed a Store that lies about the predicate, so the lineage is committed; the trace reads the honest Store.
      const world = buildGovernedWorld({ store: claimingGoverned(store, advisoryOriginal) });
      const forged = await world.orchestrator.govern(DENIED_IDENTITY, reconsider(advisoryOriginal.request.requestId));
      assert.equal(forged.status, 'denied', `the lineage was committed through the lying Store: ${JSON.stringify(forged)}`);
      const forgedTrace = await buildAuthorityTrace({ governance: store }, SYSTEM, forged.requestId ?? '');
      assert.ok(forgedTrace !== null, 'the reconsideration itself is governed and has a trace');
      assert.equal(forgedTrace.checks.find((check) => check.check === 'lineage.original-identity')?.status, 'fail', 'its original is not a governed decision');

      const original = await world.orchestrator.govern(DENIED_IDENTITY, DENIED_INTENT);
      const genuine = await world.orchestrator.govern(DENIED_IDENTITY, reconsider(original.requestId ?? ''));
      const genuineTrace = await buildAuthorityTrace({ governance: store }, SYSTEM, genuine.requestId ?? '');
      assert.equal(genuineTrace?.checks.find((check) => check.check === 'lineage.original-identity')?.status, 'pass', 'a governed lineage is unchanged');
    });
  });
}

// ---------------------------------------------------------------------------
// PAY-05 — a refund's release basis is read only from a governed record.

const BENEFICIARY = { kind: 'account', reference: 'payer-refunds-0001' } as const;
const ENVELOPE = { assertedContext: ALLOWED_INTENT.assertedContext };

function refundResult(requestId: string, decisionId: string, status: 'denied' | 'allowed'): KernelEvaluationResult {
  const reasonCodes = status === 'denied' ? ['DOMAIN_POLICY_DENIED'] : [];
  return {
    requestId,
    decisionId,
    status,
    reasonCodes,
    summary: status === 'denied' ? 'Denied.' : 'Allowed.',
    recognition: { performed: true, recognized: true },
    authority: { performed: false },
    policies: [],
    approval: { performed: false, status: 'not_applicable' },
    evidence: [],
    trace: { steps: [{ sequence: 1, operator: 'policy_chain', status: status === 'denied' ? 'failed' : 'passed', reasonCodes }], decisionId, kernelVersion: '1.0.0' },
    evaluatedAt: NOW,
    kernelVersion: '1.0.0',
  } as unknown as KernelEvaluationResult;
}

for (const provider of PROVIDERS) {
  describe(`G-01B1 PAY-05 — ${provider.name} Store: a refund reservation is released only on a governed decision`, () => {
    for (const status of ['denied', 'allowed'] as const) {
      it(`a pre-G-01B0 ${status} record at the refund's governed request id is no basis: the reservation stays counted`, async () => {
        const pw = paymentWorld({ store: await provider.open() });
        const original = await pw.world.orchestrator.govern(IDENTITY, governed(payment()));
        assert.equal(original.status, 'executed', JSON.stringify(original));
        const harness = settlementHarness(pw.world);
        assert.equal((await harness.service.verifySettlement({ organizationId: ORG, executionId: original.executionId ?? '' })).outcome, 'settled');
        const ledger = createInMemoryPaymentRefundLedger({ now: () => NOW });
        const options = {
          organizationId: ORG,
          settlements: harness.service,
          ledger,
          counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: BENEFICIARY }),
          binding: BINDING,
          assets: TEST_ASSETS,
          governance: pw.world.rawStore,
          outcomes: pw.world.outcomes,
          resolutions: harness.resolutions,
          allowVolatileLedger: true as const,
        };
        // A crash after the reservation and before governance: the refund's governed request id is reserved, and still free.
        const crashing = createPaymentRefundService({ ...options, orchestrator: { govern: async () => { throw new Error('crashed before governance'); } } });
        const refundKey = fresh('refund');
        await assert.rejects(crashing.requestRefund(IDENTITY, { originalExecutionId: original.executionId ?? '', refundKey, amount: { value: '40', unit: 'USD' }, envelope: ENVELOPE }));
        const service = createPaymentRefundService({ ...options, orchestrator: pw.world.orchestrator });
        const receipt = await harness.service.receipt({ organizationId: ORG, executionId: original.executionId ?? '' });
        const refundOperationId = paymentRefundOperationId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, originalSettlementId: receipt?.settlementId ?? '', refundKey });
        const reservation = await ledger.readOperation(ORG, refundOperationId);
        assert.ok(reservation !== undefined);
        const refundRequestId = reservation.reserve.refundRequestId;
        assert.equal((await service.refundBalance(original.executionId ?? ''))?.balance.remaining.value, '60', 'reserved');

        // The governed id was occupied without the governed-action claim (the shape G-01B0 refuses at ingress, still present in history).
        const request: KernelEvaluationRequest = { requestId: refundRequestId, actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID }, organization: { id: ORG }, action: { type: PAYMENT_ACTION, resourceScope: GOVERNED_ACCOUNT }, requestedAt: NOW };
        await pw.world.rawStore.appendEvaluation({ request, result: refundResult(refundRequestId, fresh('planted-refund-decision'), status), receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], accessContext: { system: true, organizationId: ORG, actorId: PMFREAK_ACTOR_ID } });

        assert.deepEqual(await service.reconcileRefund(refundOperationId), { outcome: 'basis-unavailable' }, 'a record without governed provenance is never read as the refund’s decision');
        assert.equal((await service.refundBalance(original.executionId ?? ''))?.balance.remaining.value, '60', 'the reservation remains accounted for');
        assert.equal((await ledger.readOperation(ORG, refundOperationId))?.release, undefined, 'nothing was released');
      });
    }
  });
}

// ---------------------------------------------------------------------------
// P2-3 — a Passport governance reference states what its record states.

function enterpriseConfiguration(apiKeys: readonly EnterpriseApiKey[] = []): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_REQUIRE_AUTH: apiKeys.length > 0 ? 'true' : 'false',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
  });
  return apiKeys.length > 0 ? { ...base, authentication: { apiKeys, legacyKeyMode: 'compat' } } : base;
}

async function boot(store: GovernanceStore, apiKeys: readonly EnterpriseApiKey[] = []): Promise<AocEnterprise> {
  const enterprise = await createEnterprise({ configuration: enterpriseConfiguration(apiKeys), kernelProviders: buildTestKernelProviders(), persistence: store });
  enterprises.push(enterprise);
  return enterprise;
}

const PASSPORT_SCOPE = { organizationId: ORG, system: false } as const;

for (const provider of PROVIDERS) {
  describe(`G-01B1 P2-3 — ${provider.name} Store: a Passport governance reference must match its stored record`, () => {
    async function linkable(): Promise<{ readonly enterprise: AocEnterprise; readonly passportId: string; readonly record: GovernanceRecord }> {
      const enterprise = await boot(await provider.open());
      const { passport } = await enterprise.passports.issuePassport(PASSPORT_SCOPE, {
        subject: { agentId: fresh('agent'), agentType: 'autonomous_agent' },
        organization: { organizationId: ORG, recognizedBy: 'org-registry' },
        actorId: 'user-1',
      });
      const requestId = fresh('passport-advisory');
      await enterprise.evaluate(buildAllowedRequestBody({ requestId, organization: { id: ORG } }));
      const record = await enterprise.persistence.getByRequestId(SYSTEM, requestId);
      assert.ok(record !== null);
      return { enterprise, passportId: passport.passportId, record };
    }

    const reference = (record: GovernanceRecord) => ({
      evaluationId: record.evaluation.evaluationId,
      decisionId: record.evaluation.decisionId,
      requestId: record.request.requestId,
      status: record.evaluation.status,
      occurredAt: record.evaluation.evaluatedAt,
      governanceRecordDigest: record.integrity.aggregateDigest,
    });

    it('unchanged: an advisory record is linked as advisory evidence when every field matches', async () => {
      const { enterprise, passportId, record } = await linkable();
      const linked = await enterprise.passports.linkGovernanceRecord(PASSPORT_SCOPE, passportId, reference(record), 'user-1');
      assert.equal(linked.governanceReferences.length, 1);
      assert.equal(linked.governanceReferences[0]?.status, record.evaluation.status);
    });

    const forgeries: readonly (readonly [string, (record: GovernanceRecord) => Record<string, unknown>])[] = [
      ['an asserted status the record does not hold', (record) => ({ ...reference(record), status: record.evaluation.status === 'allowed' ? 'denied' : 'allowed' })],
      ['another decision id', (record) => ({ ...reference(record), decisionId: `${record.evaluation.decisionId}-forged` })],
      ['a governed-looking request id', (record) => ({ ...reference(record), requestId: deriveGovernedActionRequestId({ organizationId: ORG, principalId: 'principal-g01b1', idempotencyKey: 'forged' }) })],
      ['another request id', (record) => ({ ...reference(record), requestId: `${record.request.requestId}-forged` })],
    ];
    for (const [label, forge] of forgeries) {
      it(`${label} is PASSPORT_REFERENCE_INVALID, and nothing is linked`, async () => {
        const { enterprise, passportId, record } = await linkable();
        await assert.rejects(
          enterprise.passports.linkGovernanceRecord(PASSPORT_SCOPE, passportId, forge(record) as never, 'user-1'),
          (error: unknown) => error instanceof AgentPassportError && error.code === 'PASSPORT_REFERENCE_INVALID',
        );
        const loaded = await enterprise.passports.getPassport(PASSPORT_SCOPE, passportId);
        assert.equal(loaded.passport?.governanceReferences.length, 0, 'the forged reference was not appended');
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Hygiene — the in-memory idempotency index.

for (const provider of PROVIDERS) {
  describe(`G-01B1 hygiene — ${provider.name} Store: (scope, key) is one unambiguous index entry`, () => {
    it('a key in one organization never collides with a shifted key in an organization whose id extends it', async () => {
      const store = await provider.open();
      const first: KernelEvaluationRequest = { requestId: fresh('collision-a'), actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID }, organization: { id: 'org-acme' }, action: { type: 'act', resourceScope: 'res' }, requestedAt: NOW };
      await store.appendEvaluation({ request: first, result: refundResult(first.requestId, fresh('decision'), 'denied'), receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], idempotency: { scope: 'org:org-acme', idempotencyKey: '-eu:K' }, accessContext: { system: false, organizationId: 'org-acme' } });
      const second: KernelEvaluationRequest = { ...first, requestId: fresh('collision-b'), organization: { id: 'org-acme-eu' } };
      const context: GovernanceStoreAccessContext = { system: false, organizationId: 'org-acme-eu' };
      const idempotency = { scope: 'org:org-acme-eu', idempotencyKey: ':K' };
      assert.deepEqual(await store.resolveIdempotency(context, { requestId: second.requestId, payloadDigest: computeGovernanceRequestPayloadDigest(second), idempotency }), { kind: 'new' }, 'another organization’s claim is not this one');
      const appended = await store.appendEvaluation({ request: second, result: refundResult(second.requestId, fresh('decision'), 'denied'), receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], idempotency, accessContext: context });
      assert.equal(appended.created, true);
    });
  });
}

// ---------------------------------------------------------------------------
// Hygiene — the evaluate route validates and evaluates one snapshot.

describe('G-01B1 hygiene — the evaluate route reads its body once', () => {
  it('a body whose request id changes between reads is evaluated exactly as it validated, never at a reserved id', async () => {
    const store = await PROVIDERS[0]!.open();
    const enterprise = await boot(store);
    const validated = fresh('snapshot');
    const reserved = deriveGovernedActionRequestId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, idempotencyKey: fresh('snapshot-key') });
    let reads = 0;
    const body = buildAllowedRequestBody({ organization: { id: ORG } }) as unknown as Record<string, unknown>;
    Object.defineProperty(body, 'requestId', {
      enumerable: true,
      get: () => {
        reads += 1;
        // Validation reads the field three times; the fourth read is the one the Kernel request was built from.
        return reads <= 3 ? validated : reserved;
      },
    });
    const response = await enterprise.evaluate(body as never);
    assert.equal(response.body.requestId, validated, 'the evaluated request is the validated one');
    assert.equal(await store.getByRequestId(SYSTEM, reserved), null, 'nothing was committed at the server-derived id');
    assert.equal(reads, 1, 'the body was read once');
  });
});

// ---------------------------------------------------------------------------
// Hygiene — one refusal text per conflict, whatever its cause.

const UNSCOPED_KEY = 'G01B1_UNSCOPED_LEGACY_KEY_0123456789abcd';
const SCOPED_KEY = 'G01B1_SCOPED_LEGACY_KEY_0123456789abcdef';
const OTHER_ORG = 'org-g01b1-other';
const OTHER_ORG_KEY = 'G01B1_OTHER_ORG_LEGACY_KEY_0123456789ab';
const KEYS: readonly EnterpriseApiKey[] = [{ key: UNSCOPED_KEY }, { key: SCOPED_KEY, organizationId: ORG }, { key: OTHER_ORG_KEY, organizationId: OTHER_ORG }];

async function refusal(pending: Promise<unknown>): Promise<EnterpriseHttpError> {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof EnterpriseHttpError, String(error));
    return error;
  }
  assert.fail('expected a refusal');
}

describe('G-01B1 hygiene — a conflict’s text does not say whether another requester sent the same payload', () => {
  it('request id: another requester’s equivalent request and a different payload answer the same 409 text', async () => {
    const enterprise = await boot(await PROVIDERS[0]!.open(), KEYS);
    const requestId = fresh('uniform-rid');
    const body = buildAllowedRequestBody({ requestId, organization: { id: ORG }, requestedAt: NOW });
    await enterprise.evaluate(body, { authorizationHeader: `Bearer ${UNSCOPED_KEY}` });
    const otherRequester = await refusal(enterprise.evaluate(body, { authorizationHeader: `Bearer ${SCOPED_KEY}` }));
    const otherPayload = await refusal(enterprise.evaluate({ ...body, correlationId: 'different' }, { authorizationHeader: `Bearer ${SCOPED_KEY}` }));
    assert.deepEqual([otherRequester.httpStatus, otherRequester.code], [409, 'CONCURRENCY_CONFLICT']);
    assert.deepEqual([otherPayload.httpStatus, otherPayload.code], [409, 'CONCURRENCY_CONFLICT']);
    assert.equal(otherRequester.message, otherPayload.message);
  });

  it('Idempotency-Key: another requester’s equivalent request and a different payload answer the same 409 text', async () => {
    const enterprise = await boot(await PROVIDERS[0]!.open(), KEYS);
    const idempotencyKey = fresh('uniform-key');
    const body = buildAllowedRequestBody({ requestId: fresh('uniform-key-rid'), organization: { id: ORG }, requestedAt: NOW });
    await enterprise.evaluate(body, { authorizationHeader: `Bearer ${UNSCOPED_KEY}`, idempotencyKey });
    const otherRequester = await refusal(enterprise.evaluate(body, { authorizationHeader: `Bearer ${SCOPED_KEY}`, idempotencyKey }));
    const otherPayload = await refusal(enterprise.evaluate({ ...body, requestId: fresh('uniform-key-rid') }, { authorizationHeader: `Bearer ${SCOPED_KEY}`, idempotencyKey }));
    assert.deepEqual([otherRequester.httpStatus, otherRequester.code], [409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT']);
    assert.deepEqual([otherPayload.httpStatus, otherPayload.code], [409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT']);
    assert.equal(otherRequester.message, otherPayload.message);
  });
});

// ---------------------------------------------------------------------------
// Residual P2-1 — characterized, NOT removed by G-01B1.

for (const provider of PROVIDERS) {
  describe(`G-01B1 residual P2-1 (characterized, not removed) — ${provider.name} Store: request ids are unique store-wide`, () => {
    it('another organization’s committed request id still answers 409: a cross-tenant existence signal', async () => {
      const enterprise = await boot(await provider.open(), KEYS);
      const requestId = fresh('cross-tenant');
      await enterprise.evaluate(buildAllowedRequestBody({ requestId, organization: { id: OTHER_ORG }, requestedAt: NOW }), { authorizationHeader: `Bearer ${OTHER_ORG_KEY}` });
      const reused = await refusal(enterprise.evaluate(buildAllowedRequestBody({ requestId, organization: { id: ORG }, requestedAt: NOW }), { authorizationHeader: `Bearer ${SCOPED_KEY}` }));
      assert.deepEqual([reused.httpStatus, reused.code], [409, 'CONCURRENCY_CONFLICT']);
      // An unused id evaluates normally: the difference is the signal.
      await enterprise.evaluate(buildAllowedRequestBody({ requestId: fresh('cross-tenant-unused'), organization: { id: ORG }, requestedAt: NOW }), { authorizationHeader: `Bearer ${SCOPED_KEY}` });
      // The other organization's record is still invisible to this one.
      assert.equal(await enterprise.persistence.getByRequestId(TENANT, requestId), null);
    });

    it('a deterministic request id occupied first by another organization refuses its owner (squatting)', async () => {
      const enterprise = await boot(await provider.open(), KEYS);
      const deterministic = fresh('invoice');
      await enterprise.evaluate(buildAllowedRequestBody({ requestId: deterministic, organization: { id: OTHER_ORG }, requestedAt: NOW }), { authorizationHeader: `Bearer ${OTHER_ORG_KEY}` });
      const owner = await refusal(enterprise.evaluate(buildAllowedRequestBody({ requestId: deterministic, organization: { id: ORG }, requestedAt: NOW }), { authorizationHeader: `Bearer ${SCOPED_KEY}` }));
      assert.equal(owner.httpStatus, 409, 'the owner’s first submission is refused; nothing of the squatter’s record is disclosed or replayed');
    });
  });
}
