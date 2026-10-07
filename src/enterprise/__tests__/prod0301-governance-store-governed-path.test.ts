import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelDecisionStatus } from '../../kernel/index.js';
import type { AppendGovernanceEvaluationInput, GovernanceGovernedPathFilter, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { GovernanceStoreError } from '../governance-store/errors.js';
import { createInMemoryGovernanceStore, type CreateGovernanceStoreOptions } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';

/**
 * PROD-03-01 — the Governance Store's additive governed-path filter and count,
 * on both shipped providers: they must select exactly the same records, stay
 * tenant-scoped, page deterministically, and read without writing.
 */

const SYSTEM: GovernanceStoreAccessContext = { system: true };
const ORG_A: GovernanceStoreAccessContext = { system: false, organizationId: 'org-a' };
const ORG_B: GovernanceStoreAccessContext = { system: false, organizationId: 'org-b' };
const T = '2026-10-07T00:00:00.000Z';

function options(): CreateGovernanceStoreOptions {
  let tick = 0;
  let id = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, 0, (tick += 1))).toISOString(), nextId: (prefix) => `${prefix}-${(id += 1)}` };
}

function input(requestId: string, organizationId: string, status: KernelDecisionStatus): AppendGovernanceEvaluationInput {
  const decisionId = `dec-${requestId}`;
  return {
    request: { requestId, actor: { id: 'actor-1', trustDomainId: 'td', type: 'agent' }, action: { type: 'act', resourceScope: 'res', domain: 'general' }, organization: { id: organizationId }, requestedAt: T },
    result: {
      requestId,
      decisionId,
      status,
      reasonCodes: ['CODE'],
      summary: status,
      recognition: { performed: true, recognized: true },
      authority: { performed: false },
      policies: [],
      approval: { performed: false, status: 'not_applicable' },
      evidence: [],
      trace: { steps: [{ sequence: 1, operator: 'recognition', status: 'passed', reasonCodes: ['CODE'] }], decisionId, kernelVersion: '1.0.0' },
      evaluatedAt: T,
      kernelVersion: '1.0.0',
    },
    receivedAt: T,
    enterpriseContext: { enterpriseVersion: '1.0.0', lifecycleState: 'ready', modules: [], providers: [], environment: 'test' },
    events: [],
    accessContext: SYSTEM,
  };
}

/** One record per governed-path shape, in organization A, plus one claimed-open record in organization B. */
const WORLD: readonly { readonly requestId: string; readonly organizationId: string; readonly status: KernelDecisionStatus; readonly rows: readonly (readonly [string, string, string?])[] }[] = [
  { requestId: 'r1-executed', organizationId: 'org-a', status: 'allowed', rows: [['execution_record', 'x1', 'attempt'], ['execution_record', 'x1', 'executed@a']] },
  { requestId: 'r2-denied', organizationId: 'org-a', status: 'denied', rows: [] },
  { requestId: 'r3-withheld', organizationId: 'org-a', status: 'allowed', rows: [['issuance_record', 'r3-withheld', 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED']] },
  { requestId: 'r4-pending', organizationId: 'org-a', status: 'approval_required', rows: [] },
  { requestId: 'r5-unconfirmed', organizationId: 'org-a', status: 'allowed', rows: [['execution_record', 'x5', 'attempt'], ['execution_record', 'x5', 'execution-unconfirmed@a']] },
  { requestId: 'r6-claimed', organizationId: 'org-a', status: 'allowed', rows: [['execution_record', 'x6', 'attempt']] },
  { requestId: 'r7-resolved', organizationId: 'org-a', status: 'allowed', rows: [['execution_record', 'x7', 'attempt'], ['execution_record', 'x7', 'execution-unconfirmed'], ['execution_record', 'x7', 'resolved:confirmed-completed']] },
  { requestId: 'r8-exercise-withheld', organizationId: 'org-a', status: 'allowed', rows: [['execution_record', 'x8', 'attempt'], ['execution_record', 'x8', 'withheld:exercise-control:EXERCISE_CONTROL_LIMIT_EXCEEDED']] },
  { requestId: 'r9-other-org-claimed', organizationId: 'org-b', status: 'allowed', rows: [['execution_record', 'x9', 'attempt']] },
];

async function populated(build: () => Promise<GovernanceStore>): Promise<GovernanceStore> {
  const store = await build();
  for (const entry of WORLD) {
    const appended = await store.appendEvaluation(input(entry.requestId, entry.organizationId, entry.status));
    let index = 0;
    for (const [referenceType, externalId, externalVersion] of entry.rows) {
      index += 1;
      await store.appendReference(SYSTEM, {
        referenceId: `ref-${entry.requestId}-${index}`,
        evaluationId: appended.evaluationId,
        referenceType: referenceType as 'execution_record',
        externalId,
        ...(externalVersion !== undefined ? { externalVersion } : {}),
        createdAt: T,
      });
    }
  }
  return store;
}

const VARIANTS: readonly { readonly name: string; readonly build: () => Promise<GovernanceStore> }[] = [
  { name: 'in-memory', build: async () => createInMemoryGovernanceStore(options()) },
  { name: 'sqlite', build: () => createSqliteGovernanceStore(':memory:', options()) },
];

const EXPECTED: Readonly<Record<GovernanceGovernedPathFilter, readonly string[]>> = {
  // Newest first (chain order), organization A only.
  'execution-claimed': ['r8-exercise-withheld', 'r7-resolved', 'r6-claimed', 'r5-unconfirmed', 'r1-executed'],
  'execution-open': ['r6-claimed', 'r5-unconfirmed'],
  'issuance-withheld': ['r3-withheld'],
};

async function requestIds(store: GovernanceStore, context: GovernanceStoreAccessContext, filter: GovernanceGovernedPathFilter, limit = 50): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(context, { governedPath: filter, limit, ...(cursor !== undefined ? { cursor } : {}) });
    out.push(...page.records.map((record) => record.requestId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

for (const variant of VARIANTS) {
  describe(`PROD-03-01 — Governance Store governed-path filter and count (${variant.name})`, () => {
    it('each filter selects exactly the records carrying that evidence, newest first, within the caller’s organization', async () => {
      const store = await populated(variant.build);
      for (const [filter, expected] of Object.entries(EXPECTED) as [GovernanceGovernedPathFilter, readonly string[]][]) {
        assert.deepEqual(await requestIds(store, ORG_A, filter), expected, filter);
        assert.deepEqual(await requestIds(store, ORG_A, filter, 1), expected, `${filter}, one per page`);
      }
      assert.deepEqual(await requestIds(store, ORG_B, 'execution-open'), ['r9-other-org-claimed']);
      await store.close();
    });

    it('count agrees with the query under every filter, and is tenant-scoped', async () => {
      const store = await populated(variant.build);
      const count = store.count?.bind(store);
      assert.ok(count !== undefined, 'both shipped providers implement count');
      assert.equal(await count(ORG_A, {}), 8);
      assert.equal(await count(ORG_B, {}), 1);
      assert.equal(await count(SYSTEM, {}), 9);
      assert.equal(await count(ORG_A, { status: 'allowed' }), 6);
      assert.equal(await count(ORG_A, { status: 'denied' }), 1);
      assert.equal(await count(ORG_A, { status: 'approval_required' }), 1);
      for (const [filter, expected] of Object.entries(EXPECTED) as [GovernanceGovernedPathFilter, readonly string[]][]) assert.equal(await count(ORG_A, { governedPath: filter }), expected.length, filter);
      assert.equal(await count(ORG_A, { governedPath: 'execution-open', status: 'denied' }), 0);
      await assert.rejects(count(ORG_A, { organizationId: 'org-b' }), (error: unknown) => error instanceof GovernanceStoreError && error.code === 'GOVERNANCE_ACCESS_SCOPE_VIOLATION');
      await store.close();
    });

    it('reading through the filter and count writes nothing', async () => {
      const store = await populated(variant.build);
      const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all(WORLD.map(async (entry) => store.getByRequestId(SYSTEM, entry.requestId))));
      const before = await snapshot();
      for (const filter of Object.keys(EXPECTED) as GovernanceGovernedPathFilter[]) {
        await requestIds(store, ORG_A, filter);
        await store.count?.(ORG_A, { governedPath: filter });
      }
      assert.equal(await snapshot(), before);
      await store.close();
    });
  });
}
