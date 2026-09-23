import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXERCISE_CONTROL_REASON_CODES as X,
  createExerciseControlGate,
  createInMemoryExerciseControlLedger,
  exerciseReservationId,
  type ExerciseControlPolicy,
  type ExerciseControlQuery,
} from '../../features/exercise-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, assessBoundedGrantExercise } from '../../features/execution-runtime/index.js';
import {
  boundedGrantDigest,
  boundedGrantId,
  isWellFormedGrantScope,
  type BoundedGrant,
  type GrantCorrelation,
  type GrantScope,
} from '../../features/grant-runtime/index.js';
import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import { createSqliteBoundedGrantStore } from '../bounded-grant-store/index.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/sqlite-exercise-control-ledger.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { GOVERNED_ACTION_REASON_CODES as R, deriveGovernedActionRequestId, governedActionIdempotencyScope, validateGovernedActionIntent } from '../governed-action/index.js';
import { buildGovernedActionKernelRequest } from '../governed-action/kernel-request.js';
import {
  ALLOWED_INTENT,
  DRAFTING_IS_FINANCIAL,
  IDENTITY,
  NOW,
  NO_TEMPORAL_BOUND,
  ORG,
  PMFREAK_ACTOR_ID,
  TEST_MONETARY,
  buildGovernedWorld,
} from './governed-action-support.js';

/**
 * P9 — canonical monetary semantics and host-trusted financial classification,
 * measured on the real governed-action spine:
 *
 * ```
 * intent -> classification + exact amount -> Kernel -> committed decision
 *   -> grant ceiling -> exercise -> P7 reservation -> adapter
 * ```
 *
 * `DRAFTING_IS_FINANCIAL` is a test host that classifies the one action the
 * Datasys fixture's Kernel allows as financial, so an exact amount can be
 * driven end to end through a real ALLOW. `TEST_MONETARY` classifies nothing as
 * financial. Both recognize USD and EUR at scale 2.
 */

const FINANCIAL_INTENT = Object.freeze({ ...ALLOWED_INTENT, amount: Object.freeze({ value: '250', currency: 'USD' }) });

/** Beyond 2^53: not representable as a JavaScript number, so any float round trip would change it. */
const BEYOND_DOUBLE = '9007199254740993.01';

let keySequence = 0;
const fresh = (intent: Record<string, unknown>): Record<string, unknown> => ({ ...intent, idempotencyKey: `p9-${(keySequence += 1)}` });

describe('P9 classification — the host decides whether an action is financial, and a caller cannot say otherwise', () => {
  it('a trusted financial action with an exact amount executes, and the adapter receives canonical text', async () => {
    const world = buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL });
    const result = await world.orchestrator.govern(IDENTITY, fresh({ ...FINANCIAL_INTENT, amount: { value: '250.00', currency: 'USD' } }));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.deepEqual(world.adapter.calls[0]?.amount, { value: '250', unit: 'USD' });
  });

  for (const [name, intent] of [
    ['financial action, amount omitted', { ...ALLOWED_INTENT }],
    ['financial action, caller says financial: false', { ...FINANCIAL_INTENT, financial: false }],
    ['financial action, caller supplies an arbitrary actionClass', { ...FINANCIAL_INTENT, actionClass: 'non-financial' }],
    ['financial action, classification smuggled in asserted context', { ...FINANCIAL_INTENT, assertedContext: { ...ALLOWED_INTENT.assertedContext, financial: false } }],
    ['financial action, class smuggled in asserted context', { ...FINANCIAL_INTENT, assertedContext: { ...ALLOWED_INTENT.assertedContext, actionClass: 'non-financial' } }],
    ['financial action, amount as a JSON number', { ...FINANCIAL_INTENT, amount: { value: 250, currency: 'USD' } }],
    ['financial action, precision beyond the asset scale', { ...FINANCIAL_INTENT, amount: { value: '250.001', currency: 'USD' } }],
    ['financial action, caller-supplied scale', { ...FINANCIAL_INTENT, amount: { value: '250.001', currency: 'USD', scale: 3 } }],
    ['financial action, zero amount', { ...FINANCIAL_INTENT, amount: { value: '0', currency: 'USD' } }],
    ['financial action, negative amount', { ...FINANCIAL_INTENT, amount: { value: '-250', currency: 'USD' } }],
    ['financial action, scientific notation', { ...FINANCIAL_INTENT, amount: { value: '2.5e2', currency: 'USD' } }],
    ['financial action, unknown asset', { ...FINANCIAL_INTENT, amount: { value: '250', currency: 'XAU' } }],
    ['financial action, asset scale smuggled in asserted context', { ...FINANCIAL_INTENT, assertedContext: { ...ALLOWED_INTENT.assertedContext, scale: 6 } }],
  ] as const) {
    it(`${name} → rejected before the Kernel; nothing issued, nothing executed`, async () => {
      const world = buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL });
      const result = await world.orchestrator.govern(IDENTITY, fresh(intent));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
      assert.equal(world.kernelRequests.length, 0);
      assert.equal(world.issueOutcomes.length, 0);
      assert.equal(world.adapter.callCount, 0);
    });
  }

  for (const [name, intent] of [
    ['non-financial action carrying an amount', { ...ALLOWED_INTENT, amount: { value: '250', currency: 'USD' } }],
    ['non-financial action, caller says financial: true', { ...ALLOWED_INTENT, financial: true }],
    ['non-financial action, caller supplies actionClass: financial', { ...ALLOWED_INTENT, actionClass: 'financial' }],
  ] as const) {
    it(`${name} → rejected; a caller cannot move money under an action the host did not classify as financial`, async () => {
      const world = buildGovernedWorld({ monetary: TEST_MONETARY });
      const result = await world.orchestrator.govern(IDENTITY, fresh(intent));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.equal(world.kernelRequests.length, 0);
      assert.equal(world.adapter.callCount, 0);
    });
  }

  it('a trusted non-financial action is unchanged: no amount, no monetary field, executed as before', async () => {
    const world = buildGovernedWorld({ monetary: TEST_MONETARY });
    const result = await world.orchestrator.govern(IDENTITY, fresh({ ...ALLOWED_INTENT }));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(world.kernelRequests[0]?.action.amount, undefined);
    assert.equal(world.adapter.calls[0]?.amount, undefined);
  });

  it('the classification survives validation as a typed, unambiguous arm', () => {
    const financial = validateGovernedActionIntent(fresh({ ...FINANCIAL_INTENT, amount: { value: '10.50', currency: 'USD' } }), DRAFTING_IS_FINANCIAL);
    assert.ok(financial.valid);
    if (financial.valid) {
      assert.equal(financial.intent.actionClass, 'financial');
      assert.deepEqual(financial.intent.amount, { value: '10.5', unit: 'USD' });
      assert.ok(Object.isFrozen(financial.intent));
    }
    const plain = validateGovernedActionIntent(fresh({ ...ALLOWED_INTENT }), TEST_MONETARY);
    assert.ok(plain.valid);
    if (plain.valid) {
      assert.equal(plain.intent.actionClass, 'non-financial');
      assert.equal(Object.hasOwn(plain.intent, 'amount'), false);
    }
  });

  it('the same action is classified by the host configuration alone — swap the host, the class follows; the intent is identical', () => {
    const raw = fresh({ ...ALLOWED_INTENT });
    const underFinancialHost = validateGovernedActionIntent(raw, DRAFTING_IS_FINANCIAL);
    const underPlainHost = validateGovernedActionIntent(raw, TEST_MONETARY);
    assert.equal(underFinancialHost.valid, false, 'a financial action without an amount is not a governed action at all');
    assert.equal(underPlainHost.valid, true);
  });
});

describe('P9 precision — exact from the wire to the adapter, with no number anywhere in between', () => {
  it(`${BEYOND_DOUBLE} USD reaches the Kernel request, the grant ceiling, the P7 query and reservation, and the adapter unchanged`, async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'aoc-p9-precision-'));
    try {
      const ledgerPath = join(workDir, 'ledger.sqlite');
      const ledger = await createSqliteExerciseControlLedger(ledgerPath, { now: () => NOW });
      const queries: ExerciseControlQuery[] = [];
      const spendLimit: ExerciseControlPolicy = (query) => {
        queries.push(query);
        return [{ limitId: 'spend', scopeKey: `actor:${query.subject}`, metric: 'amount', maximum: '100000000000000000', unit: 'USD', window: { kind: 'lifetime' } }];
      };
      const world = buildGovernedWorld({
        monetary: DRAFTING_IS_FINANCIAL,
        exerciseControls: { policy: spendLimit, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, reservationLedger: ledger },
      });

      const result = await world.orchestrator.govern(IDENTITY, fresh({ ...FINANCIAL_INTENT, amount: { value: `${BEYOND_DOUBLE}0`, currency: 'USD' } }));
      assert.equal(result.status, 'executed', JSON.stringify(result));

      assert.equal(world.kernelRequests[0]?.action.amount, BEYOND_DOUBLE);
      assert.equal(world.kernelRequests[0]?.action.currency, 'USD');

      const issued = world.issueOutcomes.find((outcome) => outcome.outcome === 'issued');
      assert.ok(issued !== undefined && issued.outcome === 'issued');
      assert.deepEqual(issued.grant.scope.amount, { kind: 'ceiling', limit: BEYOND_DOUBLE, unit: 'USD' });

      assert.ok(queries.length > 0);
      for (const query of queries) {
        assert.deepEqual(query.amount, { value: BEYOND_DOUBLE, unit: 'USD' });
        assert.equal(query.actionClass, 'financial', 'P7 receives the host-trusted class');
      }

      assert.deepEqual(world.adapter.calls[0]?.amount, { value: BEYOND_DOUBLE, unit: 'USD' });

      // The reservation's usage, read back from a freshly opened durable ledger.
      await ledger.close();
      const reopened = await createSqliteExerciseControlLedger(ledgerPath, { now: () => NOW });
      const view = await reopened.read(exerciseReservationId({ boundedGrantId: issued.grant.id, executionId: String(result.executionId) }));
      assert.ok(view !== undefined);
      assert.equal(view.state, 'settled');
      assert.deepEqual(
        view.reservation.rules.map((rule) => rule.usage),
        [BEYOND_DOUBLE],
      );
      await reopened.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('semantically equal spellings produce one Kernel request payload and one digest', () => {
    const scope = { organizationId: 'org', principalId: 'principal', actorId: PMFREAK_ACTOR_ID };
    const digests = ['10.5', '10.50', '10.500'].map((value) => {
      const validation = validateGovernedActionIntent({ ...FINANCIAL_INTENT, amount: { value, currency: 'USD' } }, DRAFTING_IS_FINANCIAL);
      assert.ok(validation.valid, value);
      if (!validation.valid) return '';
      const request = buildGovernedActionKernelRequest({ scope, intent: validation.intent, trustDomainId: 'td', requestId: 'req-1', requestedAt: NOW });
      assert.equal(request.action.amount, '10.5');
      return computeGovernanceRequestPayloadDigest(request);
    });
    assert.equal(new Set(digests).size, 1);
  });

  it('an amount above the grant ceiling by the smallest representable unit is refused exactly', async () => {
    const world = buildGovernedWorld({
      monetary: DRAFTING_IS_FINANCIAL,
      grantPolicy: (query) => ({ grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + 60_000).toISOString(), requestedBounds: { amount: { kind: 'ceiling', limit: '9007199254740993', unit: 'USD' } } }),
    });
    const result = await world.orchestrator.govern(IDENTITY, fresh({ ...FINANCIAL_INTENT, amount: { value: BEYOND_DOUBLE, currency: 'USD' } }));
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.ok(result.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED));
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('P9 in P7 — the gate relies on the host-trusted class and on exact text', () => {
  const BINDING = `sha256:${'b'.repeat(64)}`;
  const grant = (action: string) => ({
    id: 'aoc.grant:p9',
    subject: 'agent-A',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    correlation: { requestId: 'req-1', decisionId: 'dec-1', action, resourceScope: 'vendor/V123' },
    authorityBindingDigest: BINDING,
  });
  function gate() {
    const ledger = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:05.000Z' });
    let reserves = 0;
    const queries: ExerciseControlQuery[] = [];
    const built = createExerciseControlGate({
      policy: (query) => (queries.push(query), []),
      authorityBinding: () => BINDING,
      reservationLedger: { ...ledger, reserve: (request) => ((reserves += 1), ledger.reserve(request)) },
      actionClassifier: createFinancialActionClassifier({ financialActions: ['payment'] }),
      now: () => '2026-01-01T00:00:05.000Z',
    });
    return { built, queries, reserves: () => reserves };
  }
  const admit = (g: ReturnType<typeof gate>, action: string, attempt: Record<string, unknown>, executionId: string) =>
    g.built.admit({ grant: grant(action), attempt: { action, resource: 'vendor/V123', ...attempt }, executionId, at: '2026-01-01T00:00:05.000Z' });

  it('a financial exercise with an exact amount is admitted, and the policy sees the class and the text', async () => {
    const g = gate();
    assert.equal((await admit(g, 'payment', { amount: { value: '0.3', unit: 'USD' } }, 'e-1')).kind, 'admitted');
    assert.equal(g.queries[0]?.actionClass, 'financial');
    assert.deepEqual(g.queries[0]?.amount, { value: '0.3', unit: 'USD' });
  });

  it('a financial exercise with no amount is withheld before any reservation', async () => {
    const g = gate();
    assert.deepEqual(await admit(g, 'payment', {}, 'e-2'), { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_ACTION_CLASS_MISMATCH] });
    assert.equal(g.reserves(), 0);
  });

  it('a non-financial exercise carrying an amount is withheld before any reservation', async () => {
    const g = gate();
    assert.deepEqual(await admit(g, 'draft', { amount: { value: '1', unit: 'USD' } }, 'e-3'), { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_ACTION_CLASS_MISMATCH] });
    assert.equal(g.reserves(), 0);
  });

  it('an amount that reaches the gate as a number is withheld — never converted', async () => {
    const g = gate();
    assert.deepEqual(await admit(g, 'payment', { amount: { value: 0.3, unit: 'USD' } }, 'e-4'), { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_AMOUNT_REQUIRED] });
    assert.equal(g.reserves(), 0);
  });

  it('the class is read from the grant’s action, not from the attempt', async () => {
    const g = gate();
    const outcome = await g.built.admit({
      grant: grant('draft'),
      attempt: { action: 'payment', resource: 'vendor/V123', amount: { value: '1', unit: 'USD' } },
      executionId: 'e-5',
      at: '2026-01-01T00:00:05.000Z',
    });
    assert.deepEqual(outcome, { kind: 'withheld', reasonCodes: [X.EXERCISE_CONTROL_ACTION_CLASS_MISMATCH] }, 'an attempt naming a financial action does not make a non-financial grant financial');
  });

  it('a gate cannot be composed without the host classifier', () => {
    const ledger = createInMemoryExerciseControlLedger({ now: () => NOW });
    assert.throws(() => createExerciseControlGate({ policy: () => [], authorityBinding: () => BINDING, reservationLedger: ledger, now: () => NOW } as unknown as Parameters<typeof createExerciseControlGate>[0]), TypeError);
  });
});

describe('P9 persistence — exact round trip, and pre-P9 numeric ceilings refused rather than re-spelled', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'aoc-p9-grants-'));
  after(() => rmSync(workDir, { recursive: true, force: true }));
  const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment', resourceScope: 'vendor/V123' };
  const EXPIRES = '2026-01-01T01:00:00.000Z';

  function grantWith(scope: GrantScope): BoundedGrant {
    const unsealed = {
      id: boundedGrantId({ correlation: CORRELATION, subject: 'agent-A', scope, expiresAt: EXPIRES }),
      correlation: CORRELATION,
      subject: 'agent-A',
      scope,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: EXPIRES,
      sourceDigest: `sha256:${'0'.repeat(64)}`,
    };
    return { ...unsealed, digest: boundedGrantDigest(unsealed) };
  }

  async function writeThenReopen(grant: BoundedGrant, name: string): Promise<BoundedGrant | undefined> {
    const path = join(workDir, `${name}.sqlite`);
    const first = await createSqliteBoundedGrantStore(path);
    assert.equal((await first.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) })).outcome, 'issued');
    await first.close();
    const second = await createSqliteBoundedGrantStore(path);
    const read = await second.read(grant.id);
    await second.close();
    return read.grant;
  }

  it('a canonical ceiling beyond 2^53 survives a restart byte-exact, as text, with its asset', async () => {
    const grant = grantWith({ action: { kind: 'identity', value: 'payment' }, amount: { kind: 'ceiling', limit: BEYOND_DOUBLE, unit: 'USD' }, resources: { kind: 'set', values: ['vendor/V123'] } });
    const read = await writeThenReopen(grant, 'canonical');
    assert.deepEqual(read, grant);
    assert.equal(typeof (read?.scope.amount as { limit?: unknown } | undefined)?.limit, 'string');
  });

  it('a pre-P9 grant whose ceiling is a JSON number is read back unchanged, is not well formed, and covers no amount', async () => {
    const legacyScope = { action: { kind: 'identity', value: 'payment' }, amount: { kind: 'ceiling', limit: 10000, unit: 'USD' }, resources: { kind: 'set', values: ['vendor/V123'] } } as unknown as GrantScope;
    const legacy = grantWith(legacyScope);
    const read = await writeThenReopen(legacy, 'legacy');
    assert.ok(read !== undefined, 'the historical record is preserved, not deleted');
    assert.equal((read.scope.amount as unknown as { limit: unknown }).limit, 10000, 'never re-spelled into text by the store');
    assert.equal(isWellFormedGrantScope(read.scope), false);
    for (const value of ['10000', '1', '0.01']) {
      const assessment = assessBoundedGrantExercise({
        grant: read,
        request: { boundedGrantId: read.id, subject: 'agent-A', action: 'payment', resource: 'vendor/V123', amount: { value, unit: 'USD' }, correlation: CORRELATION, executionId: `legacy-${value}` },
        at: '2026-01-01T00:00:05.000Z',
      });
      assert.equal(assessment.usable, false, value);
      assert.ok(assessment.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED), value);
    }
  });
});

describe('P9 persistence — a pre-P9 Governance Record with a numeric amount is never rewritten and never replayed as text', () => {
  it('replaying its idempotency key with the canonical amount is an idempotency conflict: no Kernel run, no grant, no adapter, record untouched', async () => {
    const world = buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL });
    // A real committed decision to borrow a genuine Kernel result shape from.
    const seed = await world.orchestrator.govern(IDENTITY, fresh({ ...FINANCIAL_INTENT }));
    assert.equal(seed.status, 'executed', JSON.stringify(seed));
    const [seedRequest] = world.kernelRequests;
    const [seedResult] = world.kernelResults;
    assert.ok(seedRequest !== undefined && seedResult !== undefined);

    // Plant the record exactly as a pre-P9 Host committed it: the amount a JSON number.
    const principalId = IDENTITY.principal.principalId;
    const legacyKey = 'p9-legacy-record';
    const requestId = deriveGovernedActionRequestId({ organizationId: ORG, principalId, idempotencyKey: legacyKey });
    const legacyRequest = { ...seedRequest, requestId, action: { ...seedRequest.action, amount: 250 as unknown as string } };
    const accessContext = { system: false, organizationId: ORG, actorId: PMFREAK_ACTOR_ID } as const;
    await world.rawStore.appendEvaluation({
      request: legacyRequest,
      result: { ...seedResult, requestId, decisionId: 'pre-p9-decision-1' },
      receivedAt: NOW,
      enterpriseContext: { enterpriseVersion: 'pre-p9', lifecycleState: 'ready', modules: [], environment: 'test' },
      events: [],
      idempotency: { idempotencyKey: legacyKey, scope: governedActionIdempotencyScope({ organizationId: ORG, principalId }) },
      accessContext,
    });
    const before = await world.rawStore.getByRequestId(accessContext, requestId);
    assert.ok(before !== null);

    const kernelCalls = world.kernelRequests.length;
    const adapterCalls = world.adapter.callCount;
    const replay = await world.orchestrator.govern(IDENTITY, { ...FINANCIAL_INTENT, idempotencyKey: legacyKey });
    assert.equal(replay.status, 'rejected', JSON.stringify(replay));
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    assert.equal(world.kernelRequests.length, kernelCalls, 'the Kernel was not re-run');
    assert.equal(world.adapter.callCount, adapterCalls, 'no second effect');

    const after = await world.rawStore.getByRequestId(accessContext, requestId);
    assert.deepEqual(after, before, 'the historical record is untouched');
    assert.equal((after?.request.requestPayload as { action?: { amount?: unknown } } | undefined)?.action?.amount, 250, 'its amount is still the number it was committed as — never re-spelled');
  });
});
