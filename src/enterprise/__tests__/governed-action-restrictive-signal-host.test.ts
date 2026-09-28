import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyPackValidationError } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-errors.js';
import {
  ADMIN,
  PAYABLES_WORLD,
  RISK_SIGNAL,
  RULES,
  Workspace,
  assertDenied,
  boot,
  call,
  createContextTable,
  govern,
  policyPackProvider,
  provision,
  rule,
  secureEnv,
  settle,
  storedGrant,
  type Reading,
} from './core04-host-fixture.js';

/**
 * CORE-04 §59 / §60 / §95 — the admitted RiskSignal contract, with **no AI**.
 *
 * A RiskSignal is, to CORE, a *restrict-only fact class* (`restrictiveFacts`
 * on the Governance Profile): a candidate reading from a configured source,
 * admitted by the same Trusted Context Boundary as every other fact — source
 * identity, fact-class authority, organization, provenance, freshness — and
 * then readable by deterministic policy only through the restrict-only
 * predicate, whose rules may only restrict. The "detector" here is a fixed
 * table: what is proven is the boundary and the monotonicity, not a model.
 *
 * Restrictiveness order used below: executed < withheld < denied.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

const RANK: Readonly<Record<string, number>> = { executed: 0, withheld: 1, denied: 2 };

async function host() {
  const context = createContextTable();
  const dir = workspace.dir();
  const booted = await boot(workspace, secureEnv(dir), { context });
  await provision(booted.host);
  return { ...booted, context, dir };
}

const signal = (value: string, sourceId = 'configured-risk-source', extra: Partial<Reading> = {}): Reading => ({ key: RISK_SIGNAL, value, sourceId, ...extra });

describe('CORE-04 §59 / §95 — an admitted signal restricts through deterministic policy; an unadmitted one cannot influence anything', () => {
  it('baseline, admitted high, admitted elevated, admitted low — and the same high signal from an unauthorized source', async () => {
    const { host: booted, calls, baseUrl, context } = await host();

    context.set(PAYABLES_WORLD);
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed', 'baseline: no signal');

    context.set([...PAYABLES_WORLD, signal('high')]);
    await assertDenied(booted, await govern(baseUrl, settle()), 'RESTRICTIVE_SIGNAL_HIGH');

    context.set([...PAYABLES_WORLD, signal('elevated')]);
    const review = await govern(baseUrl, settle());
    assert.equal(review.body['status'], 'withheld', review.text);
    assert.equal(review.body['withheldBy'], 'approval');

    context.set([...PAYABLES_WORLD, signal('low')]);
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed', 'a signal no rule restricts on changes nothing');

    // Same type, same severity — from sources with no authority to attest it.
    for (const sourceId of ['random-risk-api', 'erp-primary']) {
      context.set([...PAYABLES_WORLD, signal('high', sourceId)]);
      assert.equal((await govern(baseUrl, settle())).body['status'], 'executed', `${sourceId}: an unadmitted signal cannot affect authority`);
    }
    // Tampered provenance, another organization, from the future: not admitted either.
    for (const extra of [{ tamper: { value: 'critical' } }, { organizationId: 'org-other' }, { ageSeconds: -30 }] as const) {
      context.set([...PAYABLES_WORLD, signal('high', 'configured-risk-source', extra)]);
      assert.equal((await govern(baseUrl, settle())).body['status'], 'executed', JSON.stringify(extra));
    }
    assert.equal(calls.length, 7);
  });

  it('a stale signal has lapsed (baseline); two trusted signal sources disagreeing is ambiguous and denies — a second source can never suppress a restriction', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    context.set([...PAYABLES_WORLD, signal('high', 'configured-risk-source', { ageSeconds: 600 })]);
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed');
    context.set([...PAYABLES_WORLD, signal('high'), signal('low', 'configured-risk-source-2')]);
    await assertDenied(booted, await govern(baseUrl, settle()), 'CONTEXT_RESTRICTIVE_FACT_AMBIGUOUS');
    assert.equal(calls.length, 1);
  });

  it('§79 — model confidence is not trust: a reading’s self-assessment is not part of admission and never reaches policy', async () => {
    const { host: booted, calls, baseUrl, context } = await host();
    // An unauthorized producer claiming 0.99 confidence: refused, no restriction, no expansion.
    context.set([...PAYABLES_WORLD, signal('high', 'random-risk-api', { tamper: { confidence: '0.99', trustClass: 'attested', trusted: true } as never })]);
    assert.equal((await govern(baseUrl, settle())).body['status'], 'executed');
    // The configured producer with a low self-assessment: admitted all the same — admission judges the producer and its provenance, not the model's opinion of itself.
    context.set([...PAYABLES_WORLD, signal('high', 'configured-risk-source', { tamper: { confidence: '0.01' } as never })]);
    await assertDenied(booted, await govern(baseUrl, settle()), 'RESTRICTIVE_SIGNAL_HIGH');
    assert.equal(calls.length, 1);
  });
});

describe('CORE-04 §32 / §60 / §88 — a signal can never create or expand authority', () => {
  it('monotonicity on the real Host: for every signal value, the decision is equal to or more restrictive than the no-signal baseline', async () => {
    const { calls, baseUrl, context } = await host();
    context.set(PAYABLES_WORLD);
    const baseline = (await govern(baseUrl, settle())).body['status'] as string;
    for (const value of ['low', 'elevated', 'high', 'critical', 'unknown-type']) {
      for (const sourceId of ['configured-risk-source', 'random-risk-api']) {
        context.set([...PAYABLES_WORLD, signal(value, sourceId)]);
        const status = (await govern(baseUrl, settle())).body['status'] as string;
        assert.ok((RANK[status] ?? -1) >= (RANK[baseline] ?? 99), `${value} from ${sourceId}: ${status} must be at least as restrictive as baseline ${baseline}`);
      }
    }
    // And the one case the baseline itself is restrictive: a signal cannot relax it.
    context.set(PAYABLES_WORLD.slice(1));
    const restricted = (await govern(baseUrl, settle())).body['status'] as string;
    assert.equal(restricted, 'denied');
    for (const value of ['low', 'none', 'cleared']) {
      context.set([...PAYABLES_WORLD.slice(1), signal(value)]);
      assert.equal((await govern(baseUrl, settle())).body['status'], 'denied', `a '${value}' signal never relaxes a denial`);
    }
    assert.ok(calls.length >= 1);
  });

  it('an admitted signal changes no grant bound and no grant lifetime: signal or not, the same bounds are issued', async () => {
    const { baseUrl, context, dir } = await host();
    const grantOf = async (reply: { readonly body: Record<string, unknown> }) => {
      const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
      return storedGrant(dir, lookup.body['grantId'] as string);
    };
    context.set(PAYABLES_WORLD);
    const without = await grantOf(await govern(baseUrl, settle()));
    context.set([...PAYABLES_WORLD, signal('low')]);
    const withSignal = await grantOf(await govern(baseUrl, settle()));
    assert.deepEqual(withSignal.scope, without.scope, 'a signal adds no axis, widens no bound');
    assert.equal(Date.parse(withSignal.expiresAt) - Date.parse(withSignal.issuedAt) <= Date.parse(without.expiresAt) - Date.parse(without.issuedAt) + 1000, true, 'and never lengthens validity');
  });

  it('policy that would let a signal widen, allow or relax is refused before it can ever be composed (NB-008 writer path)', () => {
    const widening = [
      rule('signal-allows', { type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'equals', value: 'trusted-customer' }, { type: 'allow', reasonCode: 'SIGNAL_ALLOWS', reason: 'x' }),
      rule('absence-denies', { type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'not_exists' }, { type: 'deny', reasonCode: 'NO_SIGNAL_DENIES', reason: 'x' }),
      rule('negated-group', { type: 'group', operator: 'not', conditions: [{ type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'equals', value: 'cleared' }] }, { type: 'deny', reasonCode: 'NOT_CLEARED_DENIES', reason: 'x' }),
      rule('no-op-reader', { type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'exists' }, { type: 'no_op', reasonCode: 'NOOP', reason: 'x' }),
    ];
    for (const bad of widening) {
      assert.throws(() => policyPackProvider([...RULES, bad]), (error: unknown) => error instanceof PolicyPackValidationError, bad.id);
    }
  });
});
