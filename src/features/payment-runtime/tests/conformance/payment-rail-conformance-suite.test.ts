import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_RAIL_CONFORMANCE_CASES,
  canonicalConformanceReportText,
  compareExactDecimal,
  comparePaymentRailConformanceReports,
  runPaymentRailConformanceSuite,
  type ConformanceScenario,
  type ConformanceSettlement,
  type ConformanceTrace,
  type ConformanceWorld,
  type PaymentRailConformanceHarness,
  type PaymentRailConformanceReport,
} from './payment-rail-conformance-suite.js';

/**
 * PAY-07 — the canonical suite judged against a synthetic reference harness.
 *
 * The harness below is NOT a rail and touches no payment code: it is an
 * in-memory model of the generic lifecycle the suite expects, so the suite's
 * own verdicts can be tested — the reference passes every case, and each
 * named mutation (a denied payment that moves money, a P12 call that sends
 * again, completion treated as settlement, a skipped trace, an MPP bypass, a
 * divergent disposition) is caught in the case and phase it belongs to.
 */

type Mutation =
  | 'denied-effect'
  | 'over-ceiling-effect'
  | 'revoked-effect'
  | 'p12-effect'
  | 'finality-effect'
  | 'completed-is-settled'
  | 'trace-unverified'
  | 'mpp-bypass'
  | 'over-ceiling-other-layer'
  | 'replay-resends'
  | 'amount-mutated'
  | 'provider-ref-reinterpreted'
  | 'rollback-accepted'
  | 'non-generic-status'
  | 'throws';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const UNIT = 'test:UNIT';

function referenceHarness(options: { readonly mutation?: Mutation; readonly implementationId?: string; readonly digest?: string; readonly closed?: string[] } = {}): PaymentRailConformanceHarness {
  const mutation = options.mutation;
  const economics = { ceiling: { value: '100', unit: UNIT }, withinCeiling: { value: '2.5', unit: UNIT }, overCeiling: { value: '100.001', unit: UNIT } };
  return {
    implementationId: options.implementationId ?? 'reference-model',
    coreManifestDigest: options.digest ?? DIGEST,
    economics,
    async open(scenario: ConformanceScenario): Promise<ConformanceWorld> {
      if (mutation === 'throws') throw new Error('harness exploded');
      let effects = 0;
      let presented = 0;
      let external: 'completed' | 'not-completed' | undefined;
      let resolved: 'confirmed-completed' | 'confirmed-not-completed' | undefined;
      let settled = false;
      const instructions: ReturnType<ConformanceWorld['railInstructions']>[number][] = [];
      const amount = mutation === 'amount-mutated' ? { value: '2.50', unit: UNIT } : scenario.amount === 'within-ceiling' ? economics.withinCeiling : economics.overCeiling;
      const destination = { kind: 'test-destination', reference: 'payee-1' };
      const denied = scenario.principal === 'unrecognized';
      const over = scenario.amount === 'over-ceiling';
      const revoked = scenario.revokeAfterClaim;
      const executes = !denied && !over && !revoked;
      const requestId = 'aoc.gar:00000000000000000000000000000001';
      const executionId = denied || over ? undefined : 'aoc.exec:1';
      const providerRef = 'opaque-ref-1';
      const initial = (): string | undefined => (!executes ? undefined : scenario.behaviour === 'complete' ? 'confirmed-completed' : scenario.behaviour === 'fail' ? 'confirmed-not-completed' : 'unconfirmed');
      const status = (): string => {
        if (mutation === 'non-generic-status') return 'ledger-validated';
        if (denied) return 'denied';
        if (over || revoked) return 'withheld';
        return { 'confirmed-completed': 'executed', 'confirmed-not-completed': 'execution_failed', unconfirmed: 'execution_unconfirmed' }[initial() as string] ?? 'system_error';
      };
      const completedBasis = (): boolean => initial() === 'confirmed-completed' || resolved === 'confirmed-completed';
      const settlementState = (): string =>
        settled || (mutation === 'completed-is-settled' && completedBasis())
          ? 'settled'
          : initial() === 'confirmed-not-completed' || resolved === 'confirmed-not-completed'
            ? 'not-settleable'
            : initial() === 'unconfirmed' && resolved === undefined
              ? 'execution-uncertain'
              : 'awaiting-finality';
      const finalState = (): string => {
        if (denied) return 'denied';
        if (over) return 'not-executed';
        if (revoked) return 'withheld-at-exercise';
        if (resolved !== undefined) return `resolved-${resolved}`;
        return `executed-${initial()}`;
      };
      const governed = () => {
        presented += 1;
        if (executes && (presented === 1 || mutation === 'replay-resends')) {
          effects += 1;
          instructions.push({ executionId: executionId!, requestId, amount, sourceAccountId: 'account-1', destination, purpose: 'vendor-payment' });
        }
        if (denied && mutation === 'denied-effect') effects += 1;
        if (over && mutation === 'over-ceiling-effect') effects += 1;
        if (revoked && mutation === 'revoked-effect') effects += 1;
        return {
          ingress: 'governed',
          status: status(),
          requestId,
          ...(executionId !== undefined ? { executionId } : {}),
          reasonCodes: over ? ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'] : revoked ? ['GRANT_EXERCISE_REVOKED'] : [],
          ...(over ? { withheldBy: mutation === 'over-ceiling-other-layer' ? 'grant' : 'authority-binding' } : revoked ? { withheldBy: 'exercise' } : {}),
          ...(status() === 'executed' ? { providerRef, replayed: presented > 1 } : {}),
        };
      };
      const settlement = (): ConformanceSettlement => {
        const state = settlementState();
        if (state !== 'settled') return { outcome: state === 'awaiting-finality' ? 'not-final' : 'not-eligible', state };
        return {
          outcome: 'settled',
          state,
          basis: initial() === 'confirmed-completed' ? 'provider-confirmed-completed' : 'resolution-confirmed-completed',
          railId: 'reference-adapter',
          providerRef: mutation === 'provider-ref-reinterpreted' ? providerRef.toUpperCase() : providerRef,
          amount,
          method: 'model.finality.v1',
          factNames: ['model.a', 'model.b'],
          receiptValid: true,
          receiptFormat: 'frontera.payment-receipt.v1',
          receiptRefersToSettlement: true,
        };
      };
      const trace = (): ConformanceTrace => {
        const allowed = !denied;
        const presence: Record<string, string> = {
          request: 'recorded',
          decision: 'recorded',
          approval: 'not-applicable',
          obligations: 'not-composed',
          authority: !allowed ? 'not-applicable' : over ? 'recorded' : 'recorded',
          execution: !allowed ? 'not-applicable' : over ? 'not-reached' : 'recorded',
          parameters: !allowed || over ? 'not-applicable' : 'recorded',
          reservation: !allowed || over ? 'not-applicable' : 'recorded',
          outcome: !allowed ? 'not-applicable' : over ? 'not-reached' : 'recorded',
          resolution: resolved !== undefined ? 'recorded' : initial() === 'unconfirmed' ? 'unresolved' : !allowed ? 'not-applicable' : 'not-applicable',
          events: 'recorded',
        };
        return {
          found: true,
          verified: mutation !== 'trace-unverified',
          failedChecks: mutation === 'trace-unverified' ? ['completeness:skipped:'] : [],
          requestId,
          ...(executionId !== undefined ? { executionId } : {}),
          path: denied ? 'denied' : 'allowed',
          finalState: finalState(),
          presence,
          ...(executes ? { outcomeKind: 'provider', outcomeCertainty: initial()!, providerRef } : revoked ? { outcomeKind: 'withheld' } : {}),
          ...(resolved !== undefined ? { resolutionCertainty: resolved } : {}),
          grantRecorded: !denied && !over,
          grantRevoked: revoked,
          claimRecorded: !denied && !over,
          ...(executes ? { parametersAmount: amount } : {}),
        };
      };
      return {
        presentRequirement: async () => governed(),
        replayRequirement: async () => governed(),
        externalEffects: () => effects,
        railInstructions: () => [...instructions],
        ingress: async () => ({
          protocolId: mutation === 'mpp-bypass' ? 'none' : 'mpp',
          intentAmount: amount,
          intentDestination: destination,
          governedIntents: mutation === 'mpp-bypass' ? 0 : presented,
          kernelEvaluations: presented > 0 ? 1 : 0,
          kernelAmount: amount,
          grantsIssued: !denied && !over ? 1 : 0,
        }),
        observation: async () => (executes ? { kind: 'provider', certainty: initial()!, providerRef, adapterId: 'reference-adapter', amount } : revoked ? { kind: 'withheld', amount } : undefined),
        resolveExternally: async (outcome) => {
          external = outcome;
        },
        reconcile: async () => {
          if (mutation === 'p12-effect') effects += 1;
          if (initial() !== 'unconfirmed') return { outcome: 'not-eligible', recorded: false };
          if (external === undefined) return { outcome: 'unresolved', recorded: false };
          const first = resolved === undefined;
          resolved = external === 'completed' ? 'confirmed-completed' : 'confirmed-not-completed';
          return { outcome: first ? 'resolved' : 'existing', certainty: resolved, providerRef, boundToAttempt: true, boundToObservation: true, recorded: true };
        },
        readSettlement: async () => ({ outcome: 'status', state: settlementState() }),
        verifySettlement: async () => {
          if (mutation === 'finality-effect') effects += 1;
          if (completedBasis()) settled = true;
          return settlement();
        },
        receipt: async () => (settlementState() === 'settled' ? { outcome: 'receipt', receiptPresent: true, receiptValid: true, receiptStable: true, receiptRefersToSettlement: true, receiptFormat: 'frontera.payment-receipt.v1' } : { outcome: 'no-receipt', receiptPresent: false }),
        trace: async () => trace(),
        restart: async () => undefined,
        rollbackRefused: async () => (mutation === 'rollback-accepted' ? { refused: false } : { refused: true, code: 'ROLLBACK_DETECTED' }),
        close: async () => {
          options.closed?.push(scenario.behaviour);
        },
      };
    },
  };
}

const failed = (report: PaymentRailConformanceReport): readonly string[] => report.cases.filter((entry) => !entry.passed).map((entry) => `${entry.caseId}:${entry.phase}:${entry.reason}`);

describe('PAY-07 canonical suite — the reference model passes every case, deterministically', () => {
  it('every closed case passes; the report is complete, ordered and byte-identical across runs', async () => {
    const first = await runPaymentRailConformanceSuite(referenceHarness());
    assert.deepEqual(failed(first), []);
    assert.equal(first.passed, true);
    assert.deepEqual(first.cases.map((entry) => entry.caseId), PAYMENT_RAIL_CONFORMANCE_CASES.map((entry) => entry.caseId));
    const second = await runPaymentRailConformanceSuite(referenceHarness());
    assert.equal(canonicalConformanceReportText(second), canonicalConformanceReportText(first));
  });

  it('two implementations that behave identically are equivalent: implementation ids are the only permitted difference', async () => {
    const a = await runPaymentRailConformanceSuite(referenceHarness({ implementationId: 'model-a' }));
    const b = await runPaymentRailConformanceSuite(referenceHarness({ implementationId: 'model-b' }));
    assert.deepEqual(comparePaymentRailConformanceReports(a, b), { equivalent: true, differences: [] });
  });

  it('every world the suite opens is closed, even when a case fails', async () => {
    const closed: string[] = [];
    await runPaymentRailConformanceSuite(referenceHarness({ mutation: 'p12-effect', closed }));
    assert.equal(closed.length, PAYMENT_RAIL_CONFORMANCE_CASES.length - 1, 'every case but the CORE-manifest one opens exactly one world');
  });
});

describe('PAY-07 canonical suite — mutations are caught in the case and phase they belong to (M3 … M10)', () => {
  const caught: readonly [Mutation, string, RegExp][] = [
    ['denied-effect', 'M3 a denied payment triggers one rail effect', /^MRC-08:rail:external-effects-1-expected-0$/],
    ['over-ceiling-effect', 'M4 an over-ceiling payment triggers one rail effect', /^MRC-09:rail:external-effects-1-expected-0$/],
    ['revoked-effect', 'a revoked payment triggers one rail effect', /^MRC-10:rail:external-effects-1-expected-0$/],
    ['p12-effect', 'M5 the P12 callback increments the effect count', /^MRC-03:p12:external-effects-2-expected-1$/],
    ['finality-effect', 'finality verification increments the effect count', /^MRC-01:settlement:external-effects-2-expected-1$/],
    ['completed-is-settled', 'M10 P11 completion is treated as settlement', /^MRC-06:completed-not-settled:state-settled$/],
    ['trace-unverified', 'M9 ASSURE verification fails / is skipped for one rail', /^MRC-01:trace:trace-not-verified:/],
    ['mpp-bypass', 'M1 / M2 the representative flow bypasses MPP', /^MRC-01:ingress:protocol-not-mpp$/],
    ['over-ceiling-other-layer', 'M6 one rail produces a different generic disposition', /^MRC-09:governance:withheld-by-grant$/],
    ['replay-resends', 'a business-operation replay sends again', /^MRC-02:replay:external-effects-2-expected-1$/],
    ['amount-mutated', 'an amount re-encoded across a boundary', /^MRC-09:ingress:over-ceiling-amount-not-presented$|^MRC-13:protocol:intent-amount-mutated$/],
    ['provider-ref-reinterpreted', 'a provider reference reinterpreted (case-folded) downstream', /^MRC-14:settlement:settlement-provider-ref-mismatch$/],
    ['rollback-accepted', 'a stale restore accepted', /^MRC-15:rollback:stale-state-accepted$/],
    ['non-generic-status', 'a rail token leaks into a generic answer', /:vocabulary:non-generic-status$|:governance:status-ledger-validated$/],
  ];
  for (const [mutation, label, expected] of caught) {
    it(label, async () => {
      const report = await runPaymentRailConformanceSuite(referenceHarness({ mutation }));
      assert.equal(report.passed, false);
      assert.ok(failed(report).some((entry) => expected.test(entry)), `${mutation}: ${JSON.stringify(failed(report))}`);
      // Parity is lost too: a mutated rail is never equivalent to the reference.
      const comparison = comparePaymentRailConformanceReports(await runPaymentRailConformanceSuite(referenceHarness()), report);
      assert.equal(comparison.equivalent, false);
    });
  }

  it('a harness that throws fails every opened case as harness-error — bounded, no message leaks into the report', async () => {
    const report = await runPaymentRailConformanceSuite(referenceHarness({ mutation: 'throws' }));
    for (const entry of report.cases.filter((item) => item.caseId !== 'MRC-16')) assert.deepEqual([entry.passed, entry.phase, entry.reason], [false, 'harness', 'harness-error']);
    assert.equal(canonicalConformanceReportText(report).includes('exploded'), false);
  });

  it('M8 the CORE digest is compared: equal behaviour over different CORE is not parity', async () => {
    const a = await runPaymentRailConformanceSuite(referenceHarness());
    const b = await runPaymentRailConformanceSuite(referenceHarness({ digest: `sha256:${'b'.repeat(64)}` }));
    assert.deepEqual(comparePaymentRailConformanceReports(a, b).differences, ['core-manifest-digest']);
    const malformed = await runPaymentRailConformanceSuite(referenceHarness({ digest: 'md5:abc' }));
    assert.deepEqual(failed(malformed), ['MRC-16:core:core-manifest-digest-malformed']);
  });

  it('M6 / Q12 two passing reports that differ in one generic outcome or one effect count are not parity', async () => {
    const a = await runPaymentRailConformanceSuite(referenceHarness());
    const differ = (caseId: string, change: (entry: PaymentRailConformanceReport['cases'][number]) => PaymentRailConformanceReport['cases'][number]): PaymentRailConformanceReport => ({
      ...a,
      cases: a.cases.map((entry) => (entry.caseId === caseId ? change(entry) : entry)),
    });
    assert.deepEqual(comparePaymentRailConformanceReports(a, differ('MRC-09', (entry) => ({ ...entry, lifecycle: { ...entry.lifecycle, withheldBy: 'grant' } }))).differences, ['MRC-09:lifecycle.withheldBy']);
    assert.deepEqual(comparePaymentRailConformanceReports(a, differ('MRC-10', (entry) => ({ ...entry, lifecycle: { ...entry.lifecycle, extra: 'x' } }))).differences, ['MRC-10:lifecycle.extra']);
    assert.deepEqual(comparePaymentRailConformanceReports(a, differ('MRC-04', (entry) => ({ ...entry, externalEffects: 2 }))).differences, ['MRC-04:external-effects']);
  });

  it('a report missing a required case is not parity (Q12: no rail silently skips one)', async () => {
    const a = await runPaymentRailConformanceSuite(referenceHarness());
    const b: PaymentRailConformanceReport = { ...a, cases: a.cases.filter((entry) => entry.caseId !== 'MRC-10') };
    assert.ok(comparePaymentRailConformanceReports(a, b).differences.includes('case-set'));
  });
});

describe('PAY-07 canonical suite — exact decimal comparison (no float)', () => {
  it('compares canonical decimals exactly at any scale, and refuses non-canonical text', () => {
    assert.equal(compareExactDecimal('0.000025', '0.001'), -1);
    assert.equal(compareExactDecimal('0.00100001', '0.001'), 1);
    assert.equal(compareExactDecimal('1000.01', '1000'), 1);
    assert.equal(compareExactDecimal('25', '25'), 0);
    assert.equal(compareExactDecimal('0.1', '0.10000000000000000001'), -1, 'beyond float precision');
    for (const bad of ['1e3', '01', '1.50', '-1', ' 1', '1.', 'NaN']) assert.equal(compareExactDecimal(bad, '1'), undefined, bad);
  });
});
