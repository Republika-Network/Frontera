import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../../features/execution-runtime/index.js';
import type { GovernanceRecordSummary, GovernanceStoreCountQuery, GovernanceStoreQuery, GovernanceStoreQueryResult } from '../governance-store/contracts.js';
import { decodeDefinitiveExecutionSummary, isDefinitiveExecutionSummary } from '../governed-action/execution-summary.js';
import { deriveGovernedActionRequestId, governedActionIdempotencyScope, isGovernedActionIdempotencyClaim } from '../governed-action/identifiers.js';
import type { OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { createOperatorOperationsService, type OperatorOperationsDependencies } from '../operations/service.js';

/**
 * PROD-03-01 review fixes (PR #169) — the pure and service-level regressions:
 * the one execution-summary grammar behind `execution-open`, metrics derived
 * from one consistent read, and governed-path identity from durable evidence
 * rather than the request id's shape. The Host-level halves live in
 * `prod0301-operational-visibility-host.test.ts`; the console's in
 * `prod0301-web-operations.test.tsx`.
 */

describe('PROD-03-01 review fix A — a definitive outcome is only a form the execution ledger writes', () => {
  const grantCode = GRANT_EXERCISE_REASON_CODE_VALUES[0] ?? '';
  const emergencyCode = EMERGENCY_CONTROL_REASON_CODE_VALUES[0] ?? '';

  it('every form the ledger writes for a definitive answer decodes as one', () => {
    for (const recorded of [
      'executed',
      'executed@adapter-1',
      'execution-failed:PROVIDER_REJECTED',
      'execution-failed:ADAPTER_ERROR@adapter-1',
      `withheld:grant-exercise:${grantCode}`,
      `withheld:${grantCode}`,
      `withheld:emergency-control:${emergencyCode}`,
      'withheld:exercise-control:EXERCISE_CONTROL_LIMIT_EXCEEDED',
      'resolved:confirmed-completed',
      'resolved:confirmed-not-completed:PROVIDER_UNAVAILABLE',
    ]) {
      assert.equal(isDefinitiveExecutionSummary(recorded), true, recorded);
    }
    assert.deepEqual(decodeDefinitiveExecutionSummary('execution-failed:ADAPTER_ERROR@adapter-1'), { kind: 'execution-failed', failure: 'ADAPTER_ERROR', adapterId: 'adapter-1' });
    assert.deepEqual(decodeDefinitiveExecutionSummary(`withheld:${grantCode}`), { kind: 'withheld', layer: 'grant-exercise', reasonCodes: [grantCode] });
  });

  it('the claim, the unconfirmed answer and every malformed prefix-shaped row are not definitive', () => {
    for (const recorded of [
      undefined,
      'attempt',
      'execution-unconfirmed',
      'execution-unconfirmed@adapter-1',
      'withheld:not a reason',
      'withheld:',
      'withheld:exercise-control:NOT_A_CODE',
      `withheld:exercise-control:${grantCode}`,
      `withheld:grant-exercise:${grantCode},${grantCode}`,
      `withheld:grant-exercise:${grantCode}@adapter-1`,
      'resolved:garbage',
      'resolved:',
      'resolved:confirmed-not-completed:',
      'resolved:confirmed-not-completed:NOT_A_REASON',
      'execution-failed:',
      'execution-failed:not-a-reason',
      'execution-failed:not-a-reason@adapter-1',
      'executed@',
      'executedX',
      'EXECUTED',
    ]) {
      assert.equal(isDefinitiveExecutionSummary(recorded), false, String(recorded));
    }
  });
});

describe('PROD-03-01 review fix D — governed-path identity is the path’s own durable claim, never the request id’s shape', () => {
  const scope = governedActionIdempotencyScope({ organizationId: 'org-a', principalId: 'p-1' });
  const requestId = deriveGovernedActionRequestId({ organizationId: 'org-a', principalId: 'p-1', idempotencyKey: 'k-1' });

  it('only the governed-action scope of the record’s own organization, whose key derives the request id, is governed evidence', () => {
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope, idempotencyKey: 'k-1' }), true);
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope: 'org:org-a', idempotencyKey: 'k-1' }), false, 'the evaluate route’s scope');
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope: 'global', idempotencyKey: 'k-1' }), false);
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope, idempotencyKey: 'k-2' }), false, 'a key that derives another request id');
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-b', requestId, scope, idempotencyKey: 'k-1' }), false, 'another organization');
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: undefined, requestId, scope, idempotencyKey: 'k-1' }), false);
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope: 'governed-action:["org-a","p-1"] ', idempotencyKey: 'k-1' }), false, 'not the canonical scope text');
    assert.equal(isGovernedActionIdempotencyClaim({ organizationId: 'org-a', requestId, scope: 'governed-action:not json', idempotencyKey: 'k-1' }), false);
  });
});

// -- the service over a scripted store -------------------------------------------------------

const ORG = 'org-a';
const T = '2026-10-07T00:00:00.000Z';

function summary(requestId: string, evaluationId: string): GovernanceRecordSummary {
  return { evaluationId, decisionId: `dec-${evaluationId}`, requestId, organizationId: ORG, actorId: 'actor-1', actionType: 'act', status: 'allowed', reasonCodes: ['CODE'], evaluatedAt: T, persistedAt: T, aggregateDigest: 'sha256:x' };
}

const authenticator: OperatorAuthenticator = {
  organizationId: ORG,
  authorize: () => ({}) as ReturnType<OperatorAuthenticator['authorize']>,
};

/** A store whose counts and pages read one mutable world; `onQuery` lets a test append between reads, as a concurrent governed action would. */
interface World {
  allowed: number;
  claims: number;
  open: GovernanceRecordSummary[];
  governed: Set<string>;
  records: GovernanceRecordSummary[];
}

function service(world: World, onQuery: () => void = () => {}): { readonly service: ReturnType<typeof createOperatorOperationsService>; readonly reads: string[] } {
  const reads: string[] = [];
  const governanceRecords: OperatorOperationsDependencies['governanceRecords'] = {
    async query(_context, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult> {
      reads.push(`query:${query.governedPath ?? 'all'}`);
      onQuery();
      if (query.governedPath === 'execution-open') return { records: [...world.open] };
      return { records: world.records.filter((record) => query.requestId === undefined || record.requestId === query.requestId) };
    },
    async count(_context, query: GovernanceStoreCountQuery): Promise<number> {
      reads.push(`count:${query.governedPath ?? query.status ?? 'all'}`);
      if (query.governedPath === 'governed-action') return query.evaluationId !== undefined && world.governed.has(query.evaluationId) ? 1 : 0;
      if (query.governedPath === 'execution-claimed') return world.claims;
      if (query.governedPath === 'execution-open') return world.open.length;
      if (query.governedPath === 'issuance-withheld') return 0;
      if (query.status === 'allowed') return world.allowed;
      if (query.status !== undefined) return 0;
      return world.allowed;
    },
  };
  return {
    reads,
    service: createOperatorOperationsService({
      authenticator,
      organizationId: ORG,
      governanceRecords,
      // No trace can be built here: each candidate is `trace-unavailable`, which states no outcome.
      traces: { build: async () => null },
      health: async () => {
        throw new Error('not read');
      },
      now: () => T,
    }),
  };
}

function assertPossible(metrics: Awaited<ReturnType<ReturnType<typeof createOperatorOperationsService>['metrics']>>): void {
  const { decisions } = metrics;
  for (const value of [decisions.total, decisions.allowed, decisions.denied, decisions.approvalRequired, decisions.indeterminate, metrics.issuanceWithheld, metrics.executionClaims, metrics.unresolvedExecutions, metrics.attentionRequired]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `a count is a non-negative integer: ${value}`);
  }
  assert.ok(decisions.allowed + decisions.denied + decisions.approvalRequired + decisions.indeterminate <= decisions.total, 'no status count exceeds the total');
  assert.ok(metrics.scan.examined <= metrics.executionClaims, 'never more claims examined than counted');
  if (metrics.confirmedOutcomes !== null) assert.ok(metrics.confirmedOutcomes >= 0 && metrics.confirmedOutcomes <= metrics.executionClaims, `confirmed outcomes within [0, claims]: ${metrics.confirmedOutcomes}`);
}

describe('PROD-03-01 review fix B — metrics come from one consistent read, or say they could not', () => {
  it('a claim recorded between the counters and the scan is re-read, never published as a negative count', async () => {
    const claimed = summary('aoc.gar:00000000000000000000000000000001', 'evaluation-1');
    const world: World = { allowed: 0, claims: 0, open: [], governed: new Set(['evaluation-1']), records: [] };
    let appended = false;
    // Before the fix: claims counted 0, then the scan saw 1 open claim — `0 - 1 + 0 = -1` confirmed outcomes.
    const { service: operations } = service(world, () => {
      if (appended) return;
      appended = true;
      world.allowed = 1;
      world.claims = 1;
      world.open = [claimed];
      world.records = [claimed];
    });
    const metrics = await operations.metrics('Bearer x', {});
    assertPossible(metrics);
    assert.equal(metrics.consistent, true, 'the second read found the counters unchanged');
    assert.equal(metrics.executionClaims, 1);
    assert.equal(metrics.decisions.total, 1);
    assert.equal(metrics.scan.examined, 1);
    assert.equal(metrics.confirmedOutcomes, 0, 'the open claim is not a confirmed outcome');
  });

  it('a store that moves under every attempt is reported as such: no derived value, nothing impossible', async () => {
    const world: World = { allowed: 0, claims: 0, open: [], governed: new Set(), records: [] };
    let n = 0;
    const { service: operations, reads } = service(world, () => {
      n += 1;
      const record = summary(`aoc.gar:${String(n).padStart(32, '0')}`, `evaluation-${n}`);
      world.governed.add(record.evaluationId);
      world.allowed += 1;
      world.claims += 1;
      world.open = [...world.open, record];
    });
    const metrics = await operations.metrics('Bearer x', {});
    assertPossible(metrics);
    assert.equal(metrics.consistent, false);
    assert.equal(metrics.confirmedOutcomes, null, 'a derivation over a moving store is not stated');
    assert.equal(reads.filter((read) => read === 'query:execution-open').length, 3, 'a bounded number of attempts');
  });

  it('a store that does not move is read once', async () => {
    const claimed = summary('aoc.gar:00000000000000000000000000000001', 'evaluation-1');
    const { service: operations, reads } = service({ allowed: 1, claims: 1, open: [claimed], governed: new Set(['evaluation-1']), records: [claimed] });
    const metrics = await operations.metrics('Bearer x', {});
    assertPossible(metrics);
    assert.equal(metrics.consistent, true);
    assert.equal(metrics.confirmedOutcomes, 0);
    assert.equal(reads.filter((read) => read === 'query:execution-open').length, 1);
  });
});

describe('PROD-03-01 review fix D — the execution list classifies by governed-path evidence', () => {
  it('a governed-shaped request id without the governed path’s claim is evaluation-only; with it, its trace is read', async () => {
    const spoofed = summary('aoc.gar:0123456789abcdef0123456789abcdef', 'evaluation-spoofed');
    const governed = summary('aoc.gar:fedcba9876543210fedcba9876543210', 'evaluation-governed');
    const { service: operations } = service({ allowed: 2, claims: 0, open: [], governed: new Set(['evaluation-governed']), records: [spoofed, governed] });
    const page = await operations.listExecutions('Bearer x', {});
    const byId = new Map(page.executions.map((view) => [view.requestId, view]));
    assert.equal(byId.get(spoofed.requestId)?.classification, 'evaluation-only');
    assert.equal(byId.get(spoofed.requestId)?.attentionRequired, false);
    // No trace can be built in this world, so a governed record is `trace-unavailable` — it was sent to the trace builder.
    assert.equal(byId.get(governed.requestId)?.classification, 'trace-unavailable');
  });
});
