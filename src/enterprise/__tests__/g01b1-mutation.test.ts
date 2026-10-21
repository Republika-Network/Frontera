import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import type { GovernanceRecord, GovernanceStoreAccessContext, GovernanceStoreQuery, GovernanceStoreQueryResult } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { toGovernanceRecordSummary } from '../governance-store/store-common.js';
import { deriveGovernedActionRequestId } from '../governed-action/index.js';
import { createInMemoryPaymentRefundLedger, paymentRefundOperationId, type PaymentRefundServiceOptions } from '../payment-settlement/index.js';
import { ALLOWED_INTENT, DENIED_ACTOR, DENIED_INTENT, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID, buildGovernedWorld, identityFor } from './governed-action-support.js';
import { BINDING, GOVERNED_ACCOUNT, IDENTITY, NOW, ORG, PAYMENT_ACTION, TEST_ASSETS, governed, payment, paymentWorld, settlementHarness } from './pay05-settlement-support.js';

/**
 * G-01B1 — mutation qualification of the governed-provenance gates. Each mutant
 * edits one compiled module at one site; its guard must hold for the shipped
 * module and must detect the mutant. Together they show that no consumer can
 * stop resolving governed provenance — and that the resolver cannot start
 * trusting a record, an answer for another evaluation or organization, or an
 * ambiguous answer — without a test failing:
 *
 * - the resolver (`governance-store/governed-provenance.js`);
 * - LAND-01: the pure assessment and the commit phase's read of the original;
 * - ASSURE-01: the trace's located record and a lineage's original;
 * - PAY-05: a refund's release basis.
 *
 * Every guard runs over the SQLite provider, whose predicate is evaluated in
 * SQL, so a mutant cannot pass by leaning on the in-memory implementation; the
 * resolver guards run over both.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${mutant.file}: ${search.slice(0, 100)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the mutation`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

const opened: GovernanceStore[] = [];
after(async () => {
  for (const store of opened) await store.close().catch(() => {});
});

async function sqlite(): Promise<GovernanceStore> {
  const store = await createSqliteGovernanceStore(':memory:');
  opened.push(store);
  return store;
}

const SYSTEM: GovernanceStoreAccessContext = { system: true };
const TENANT: GovernanceStoreAccessContext = { system: false, organizationId: ORG };
const ENTERPRISE_CONTEXT = { enterpriseVersion: 'test', lifecycleState: 'ready', modules: [] } as const;
const DENIED_IDENTITY = identityFor({ actorId: DENIED_ACTOR });
let sequence = 0;
const fresh = (label: string): string => `g01b1-mutation-${label}-${(sequence += 1)}`;

/** The governed path's Kernel request and answer for `identity` + `intent`, from a throwaway world. */
async function captureGoverned(identity: typeof IDENTITY, intent: Record<string, unknown>): Promise<{ readonly request: KernelEvaluationRequest; readonly result: KernelEvaluationResult }> {
  const probe = buildGovernedWorld({ kernelIdStart: 900 });
  await probe.orchestrator.govern(identity, intent);
  const request = probe.kernelRequests[0];
  const result = probe.kernelResults[0];
  assert.ok(request !== undefined && result !== undefined);
  return { request, result };
}

/** Commits the captured decision at `requestId` without the governed-action claim — a record planted before G-01B0. */
async function plant(store: GovernanceStore, identity: typeof IDENTITY, intent: Record<string, unknown>, requestId: string): Promise<GovernanceRecord> {
  const captured = await captureGoverned(identity, intent);
  const decisionId = `${captured.result.decisionId}-${fresh('decision')}`;
  const withoutGrants = Object.fromEntries(Object.entries(captured.result).filter(([key]) => key !== 'grants')) as unknown as KernelEvaluationResult;
  const appended = await store.appendEvaluation({
    request: { ...captured.request, requestId },
    result: { ...withoutGrants, requestId, decisionId, trace: { ...captured.result.trace, decisionId } },
    receivedAt: NOW,
    enterpriseContext: ENTERPRISE_CONTEXT,
    events: [],
    accessContext: { system: true, organizationId: ORG, actorId: captured.request.actor.id },
  });
  const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
  assert.ok(record !== null);
  return record;
}

const governedLookingId = (principalId: string): string => deriveGovernedActionRequestId({ organizationId: ORG, principalId, idempotencyKey: fresh('squatted') });

// ---------------------------------------------------------------------------
// The resolver.

type ProvenanceModule = typeof import('../governance-store/governed-provenance.js');
const PROVENANCE = 'governance-store/governed-provenance.js';

describe('G-01B1 mutations — the governed-provenance resolver', () => {
  /** A governed record in a real Store, and a reader over it whose `query` answers what a test names. */
  async function governedFixture(store: GovernanceStore): Promise<{ readonly record: GovernanceRecord; readonly answering: (records: GovernanceStoreQueryResult['records']) => { getByRequestId: GovernanceStore['getByRequestId']; query: (context: GovernanceStoreAccessContext, query: GovernanceStoreQuery) => Promise<GovernanceStoreQueryResult> } }> {
    const world = buildGovernedWorld({ store });
    const executed = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, idempotencyKey: fresh('key') });
    const record = await store.getByRequestId(SYSTEM, executed.requestId ?? '');
    assert.ok(record !== null);
    return { record, answering: (records) => ({ getByRequestId: (context, requestId) => store.getByRequestId(context, requestId), query: async () => ({ records }) }) };
  }

  const mutants: readonly Mutant<ProvenanceModule>[] = [
    {
      id: 'resolver-trusts-the-record',
      file: PROVENANCE,
      replacements: [["return (await hasGovernedActionProvenance(reader, context, record)) ? { kind: 'governed', record } : { kind: 'not-governed', record };", "return { kind: 'governed', record };"]],
      guard: async (m) => {
        const results: boolean[] = [];
        for (const store of [await sqlite(), createInMemoryGovernanceStore()]) {
          const planted = await plant(store, IDENTITY, ALLOWED_INTENT, governedLookingId(IDENTITY.principal.principalId));
          results.push((await m.resolveGovernedRecord(store, SYSTEM, planted.request.requestId)).kind === 'not-governed');
          results.push((await m.resolveGovernedRecord(store, TENANT, planted.request.requestId)).kind === 'not-governed');
        }
        return results.every(Boolean);
      },
    },
    {
      id: 'provenance-accepts-an-ambiguous-answer',
      file: PROVENANCE,
      replacements: [['if (records.length !== 1) return false;', 'if (records.length === 0) return false;']],
      guard: async (m) => {
        const { record, answering } = await governedFixture(await sqlite());
        const summary = toGovernanceRecordSummary(record);
        return (await m.hasGovernedActionProvenance(answering([summary, summary]), SYSTEM, record)) === false;
      },
    },
    {
      id: 'provenance-ignores-the-evaluation',
      file: PROVENANCE,
      replacements: [['hit.evaluationId === record.evaluation.evaluationId && ', '']],
      guard: async (m) => {
        const { record, answering } = await governedFixture(await sqlite());
        return (await m.hasGovernedActionProvenance(answering([{ ...toGovernanceRecordSummary(record), evaluationId: 'evaluation-other' }]), SYSTEM, record)) === false;
      },
    },
    {
      id: 'provenance-ignores-the-organization',
      file: PROVENANCE,
      replacements: [[' && hit.organizationId === organizationId;', ';']],
      guard: async (m) => {
        const { record, answering } = await governedFixture(await sqlite());
        return (await m.hasGovernedActionProvenance(answering([{ ...toGovernanceRecordSummary(record), organizationId: 'org-other' }]), SYSTEM, record)) === false;
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ---------------------------------------------------------------------------
// LAND-01 — reconsideration.

type LineageModule = typeof import('../governed-action/reconsideration-lineage.js');
type CommitModule = typeof import('../governed-action/decision-commit.js');

describe('G-01B1 mutations — a reconsideration original must be governed', () => {
  it('reconsideration-accepts-a-non-governed-original', async () => {
    const store = await sqlite();
    const planted = await plant(store, DENIED_IDENTITY, DENIED_INTENT, fresh('advisory-original'));
    const scope = { organizationId: ORG, principalId: DENIED_IDENTITY.principal.principalId, actorId: DENIED_ACTOR };
    await qualify<LineageModule>({
      id: 'reconsideration-accepts-a-non-governed-original',
      file: 'governed-action/reconsideration-lineage.js',
      replacements: [['if (input.originalGoverned !== true)', 'if (false)']],
      guard: (m) => {
        const verdict = m.assessReconsiderationTarget({
          original: planted,
          originalVerified: true,
          originalGoverned: false,
          scope,
          requestId: governedLookingId(scope.principalId),
          reconsideration: { of: planted.request.requestId, reason: 'context-changed' },
          requestPayload: planted.request.requestPayload,
        });
        return !verdict.ok && verdict.refusal === 'RECONSIDERATION_TARGET_NOT_FOUND';
      },
    });
  });

  it('reconsideration-read-skips-provenance', async () => {
    const store = await sqlite();
    const planted = await plant(store, DENIED_IDENTITY, DENIED_INTENT, governedLookingId(DENIED_IDENTITY.principal.principalId));
    await qualify<CommitModule>({
      id: 'reconsideration-read-skips-provenance',
      file: 'governed-action/decision-commit.js',
      replacements: [['const originalGoverned = await ', 'const originalGoverned = true || await ']],
      guard: async (m) => {
        const committer = m.createDecisionCommitter({
          store,
          issuance: {} as never,
          trustDomainId: TRUST_DOMAIN_ID,
          now: () => NOW,
          enterpriseContext: () => ENTERPRISE_CONTEXT as never,
          events: { enabled: false, publisher: { publish: async () => {} }, nextId: (prefix: string) => `${prefix}-x` } as never,
          traceLevel: 'basic',
        });
        const read = await committer.readReconsiderationOriginal({
          scope: { organizationId: ORG, principalId: DENIED_IDENTITY.principal.principalId, actorId: DENIED_ACTOR },
          intent: { action: DENIED_INTENT.action, resource: DENIED_INTENT.resource, idempotencyKey: fresh('key') } as never,
          requestId: governedLookingId(DENIED_IDENTITY.principal.principalId),
          accessContext: { system: false, organizationId: ORG, actorId: DENIED_ACTOR },
          originalRequestId: planted.request.requestId,
        });
        return read.original !== null && read.originalVerified && read.originalGoverned === false;
      },
    });
  });
});

// ---------------------------------------------------------------------------
// ASSURE-01 — traces.

type TraceModule = typeof import('../evidence/trace-builder.js');
const TRACE = 'evidence/trace-builder.js';

/** A Store whose `query` claims the governed-action predicate for one more record — used only to commit a lineage to a non-governed original. */
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

describe('G-01B1 mutations — a governed trace needs a governed record', () => {
  it('trace-built-over-a-non-governed-record', async () => {
    const store = await sqlite();
    const planted = await plant(store, IDENTITY, ALLOWED_INTENT, governedLookingId(IDENTITY.principal.principalId));
    await qualify<TraceModule>({
      id: 'trace-built-over-a-non-governed-record',
      file: TRACE,
      replacements: [['context, located))) return null;', 'context, located)) && false) return null;']],
      guard: async (m) => (await m.buildAuthorityTrace({ governance: store }, SYSTEM, planted.request.requestId)) === null && (await m.buildAuthorityTrace({ governance: store }, TENANT, planted.request.requestId)) === null,
    });
  });

  it('lineage-original-provenance-unchecked', async () => {
    const store = await sqlite();
    const original = await plant(store, DENIED_IDENTITY, DENIED_INTENT, fresh('advisory-original'));
    const world = buildGovernedWorld({ store: claimingGoverned(store, original) });
    const reconsideration = await world.orchestrator.govern(DENIED_IDENTITY, { ...DENIED_INTENT, idempotencyKey: fresh('key'), reconsideration: { of: original.request.requestId, reason: 'context-changed' } });
    assert.equal(reconsideration.status, 'denied', JSON.stringify(reconsideration));
    await qualify<TraceModule>({
      id: 'lineage-original-provenance-unchecked',
      file: TRACE,
      replacements: [["check('lineage.original-identity', 'correlation', originalGoverned && ", "check('lineage.original-identity', 'correlation', "]],
      guard: async (m) => (await m.buildAuthorityTrace({ governance: store }, SYSTEM, reconsideration.requestId ?? ''))?.checks.find((check) => check.check === 'lineage.original-identity')?.status === 'fail',
    });
  });
});

// ---------------------------------------------------------------------------
// PAY-05 — refunds.

type RefundModule = typeof import('../payment-settlement/refund-service.js');

/** A settled original, a refund reserved before a crash, and a denied record planted at the refund's governed request id. */
async function plantedRefund(): Promise<{ readonly options: PaymentRefundServiceOptions; readonly refundOperationId: string }> {
  const pw = paymentWorld({ store: await sqlite() });
  const original = await pw.world.orchestrator.govern(IDENTITY, governed(payment()));
  assert.equal(original.status, 'executed', JSON.stringify(original));
  const harness = settlementHarness(pw.world);
  assert.equal((await harness.service.verifySettlement({ organizationId: ORG, executionId: original.executionId ?? '' })).outcome, 'settled');
  const ledger = createInMemoryPaymentRefundLedger({ now: () => NOW });
  const base = {
    organizationId: ORG,
    settlements: harness.service,
    ledger,
    counterparties: () => ({ source: { accountId: GOVERNED_ACCOUNT }, destination: { kind: 'account', reference: 'payer-refunds-0001' } as const }),
    binding: BINDING,
    assets: TEST_ASSETS,
    governance: pw.world.rawStore,
    outcomes: pw.world.outcomes,
    resolutions: harness.resolutions,
    allowVolatileLedger: true as const,
  };
  const { createPaymentRefundService } = await import('../payment-settlement/index.js');
  const crashing = createPaymentRefundService({ ...base, orchestrator: { govern: async () => { throw new Error('crashed before governance'); } } });
  const refundKey = fresh('refund');
  await assert.rejects(crashing.requestRefund(IDENTITY, { originalExecutionId: original.executionId ?? '', refundKey, amount: { value: '40', unit: 'USD' }, envelope: { assertedContext: ALLOWED_INTENT.assertedContext } }));
  const receipt = await harness.service.receipt({ organizationId: ORG, executionId: original.executionId ?? '' });
  const refundOperationId = paymentRefundOperationId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, originalSettlementId: receipt?.settlementId ?? '', refundKey });
  const reservation = await ledger.readOperation(ORG, refundOperationId);
  assert.ok(reservation !== undefined);
  const refundRequestId = reservation.reserve.refundRequestId;
  const decisionId = fresh('planted-refund-decision');
  const request: KernelEvaluationRequest = { requestId: refundRequestId, actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID }, organization: { id: ORG }, action: { type: PAYMENT_ACTION, resourceScope: GOVERNED_ACCOUNT }, requestedAt: NOW };
  const result = {
    requestId: refundRequestId,
    decisionId,
    status: 'denied',
    reasonCodes: ['DOMAIN_POLICY_DENIED'],
    summary: 'Denied.',
    recognition: { performed: true, recognized: true },
    authority: { performed: false },
    policies: [],
    approval: { performed: false, status: 'not_applicable' },
    evidence: [],
    trace: { steps: [{ sequence: 1, operator: 'policy_chain', status: 'failed', reasonCodes: ['DOMAIN_POLICY_DENIED'] }], decisionId, kernelVersion: '1.0.0' },
    evaluatedAt: NOW,
    kernelVersion: '1.0.0',
  } as unknown as KernelEvaluationResult;
  await pw.world.rawStore.appendEvaluation({ request, result, receivedAt: NOW, enterpriseContext: ENTERPRISE_CONTEXT, events: [], accessContext: { system: true, organizationId: ORG, actorId: PMFREAK_ACTOR_ID } });
  return { options: { ...base, orchestrator: pw.world.orchestrator }, refundOperationId };
}

describe('G-01B1 mutations — a refund is released only on a governed decision', () => {
  it('refund-basis-read-from-a-non-governed-record', () =>
    qualify<RefundModule>({
      id: 'refund-basis-read-from-a-non-governed-record',
      file: 'payment-settlement/refund-service.js',
      replacements: [["if (resolution.kind === 'not-governed') return { kind: 'unavailable' };", "if (false) return { kind: 'unavailable' };"]],
      guard: async (m) => {
        const { options, refundOperationId } = await plantedRefund();
        const reconciled = await m.createPaymentRefundService(options).reconcileRefund(refundOperationId);
        return reconciled.outcome === 'basis-unavailable';
      },
    }));
});
