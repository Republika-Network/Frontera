import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCoreSourceManifest } from './pay07-core-source-manifest.js';
import {
  PAYMENT_RAIL_CONFORMANCE_CASES,
  PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION,
  canonicalConformanceReportText,
  comparePaymentRailConformanceReports,
  runPaymentRailConformanceSuite,
  type PaymentRailConformanceReport,
} from '../../features/payment-runtime/tests/conformance/payment-rail-conformance-suite.js';
import { closeAllWitnesses } from './core07-freshness-fixture.js';
import { cleanupPay07Directories, createGovernedPaymentHarness } from './pay07-governed-payment-world.js';
import { LIGHTNING_EDGE } from './pay07-lightning-edge.js';
import { STRIPE_EDGE } from './pay07-stripe-edge.js';
import { XRPL_EDGE } from './pay07-xrpl-edge.js';

/**
 * PAY-07 — Multi-Rail Qualification (§11.2 CORE PROVEN).
 *
 * ONE canonical suite (`runPaymentRailConformanceSuite`), ONE shared governed
 * world (`pay07-governed-payment-world.ts`), TWO rail edges. Each run computes
 * the CORE source manifest from the tree it executes and embeds its digest in
 * its report; the two reports must carry the same digest, the same case ids,
 * the same verdicts, the same external-effect counts and the same generic
 * lifecycle signatures.
 *
 * Criterion map (§11.2):
 *
 * 1. MPP → PaymentIntent → envelope → authority / policy / ceiling → grant →
 *    rail → settlement → evidence, end to end on both rails ........ MRC-01, MRC-06, MRC-07, MRC-11, MRC-13
 * 2. CORE byte-identical between the runs ............................ MRC-16 + report digest equality (here) + `pay07-multi-rail-structure.test.ts`
 * 3. Unconfirmed → resolved through P12 on both rails ............... MRC-03, MRC-04 (after restart), MRC-05
 * 4. The ASSURE-01 trace verifies for both ........................... MRC-01/02/03/04/05/08/09/10/11
 * 5. Denied, over-ceiling, revoked-mid-flight identical on both ...... MRC-08, MRC-09, MRC-10 + report comparison
 */

after(async () => {
  await closeAllWitnesses();
  cleanupPay07Directories();
});

const reports: { xrpl?: PaymentRailConformanceReport; lightning?: PaymentRailConformanceReport; stripe?: PaymentRailConformanceReport } = {};
const failures = (report: PaymentRailConformanceReport | undefined): string =>
  JSON.stringify((report?.cases ?? []).filter((entry) => !entry.passed).map((entry) => ({ caseId: entry.caseId, phase: entry.phase, reason: entry.reason, effects: entry.externalEffects })));

describe('PAY-07 — the one canonical suite, run against both rails', () => {
  before(async () => {
    // Each run measures the CORE it executes, independently: the same tree must give the same digest.
    reports.xrpl = await runPaymentRailConformanceSuite(createGovernedPaymentHarness(XRPL_EDGE, buildCoreSourceManifest().digest));
    reports.lightning = await runPaymentRailConformanceSuite(createGovernedPaymentHarness(LIGHTNING_EDGE, buildCoreSourceManifest().digest));
    // PAY-09: the first fiat rail, through the SAME suite, the SAME world and the SAME assertions — nothing skipped or weakened.
    reports.stripe = await runPaymentRailConformanceSuite(createGovernedPaymentHarness(STRIPE_EDGE, buildCoreSourceManifest().digest));
  });

  it('XRPL / RLUSD (PAY-02 / PAY-03) passes every required case', () => {
    assert.equal(reports.xrpl?.implementationId, 'xrpl-rlusd');
    assert.equal(reports.xrpl?.passed, true, failures(reports.xrpl));
  });

  it('Lightning / BTC (PAY-06) passes every required case', () => {
    assert.equal(reports.lightning?.implementationId, 'lightning-btc');
    assert.equal(reports.lightning?.passed, true, failures(reports.lightning));
  });

  it('Stripe / USD (PAY-09) passes every required case', () => {
    assert.equal(reports.stripe?.implementationId, 'stripe-usd');
    assert.equal(reports.stripe?.passed, true, failures(reports.stripe));
  });

  it('every report ran exactly the closed case set, in order, under the same suite version — no rail skipped a case', () => {
    const expected = PAYMENT_RAIL_CONFORMANCE_CASES.map((entry) => entry.caseId);
    for (const report of [reports.xrpl, reports.lightning, reports.stripe]) {
      assert.equal(report?.suiteVersion, PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION);
      assert.deepEqual(report?.cases.map((entry) => entry.caseId), expected);
    }
  });

  it('§11.2 criterion 2: both runs executed against the byte-identical CORE — the same manifest digest, recomputed now', () => {
    const now = buildCoreSourceManifest().digest;
    assert.match(now, /^sha256:[0-9a-f]{64}$/);
    assert.equal(reports.xrpl?.coreManifestDigest, now);
    assert.equal(reports.lightning?.coreManifestDigest, now);
    assert.equal(reports.stripe?.coreManifestDigest, now);
    assert.equal(reports.xrpl?.coreManifestDigest, reports.lightning?.coreManifestDigest);
    assert.equal(reports.xrpl?.coreManifestDigest, reports.stripe?.coreManifestDigest);
  });

  it('parity: every case has the same verdict, external-effect count and generic lifecycle on both rails', () => {
    for (const other of [reports.lightning!, reports.stripe!]) {
      const comparison = comparePaymentRailConformanceReports(reports.xrpl!, other);
      assert.deepEqual(comparison.differences, [], other.implementationId);
      assert.equal(comparison.equivalent, true, other.implementationId);
    }
  });

  it('§36 external-effect counts: success 1, uncertain 1 (P12, finality and trace add 0), denied / over-ceiling / revoked 0 — on both rails', () => {
    const expected: Record<string, number> = {
      'MRC-01': 1,
      'MRC-02': 1,
      'MRC-03': 1,
      'MRC-04': 1,
      'MRC-05': 1,
      'MRC-06': 1,
      'MRC-07': 1,
      'MRC-08': 0,
      'MRC-09': 0,
      'MRC-10': 0,
      'MRC-11': 1,
      'MRC-12': 1,
      'MRC-13': 1,
      'MRC-14': 1,
      'MRC-15': 1,
      'MRC-16': 0,
    };
    for (const report of [reports.xrpl!, reports.lightning!, reports.stripe!]) {
      assert.deepEqual(Object.fromEntries(report.cases.map((entry) => [entry.caseId, entry.externalEffects])), expected, report.implementationId);
    }
  });

  it('§11.2 criterion 5: denied, over-ceiling and revoked-mid-flight produce the identical generic disposition on both rails', () => {
    for (const caseId of ['MRC-08', 'MRC-09', 'MRC-10']) {
      const x = reports.xrpl!.cases.find((entry) => entry.caseId === caseId);
      const l = reports.lightning!.cases.find((entry) => entry.caseId === caseId);
      const s = reports.stripe!.cases.find((entry) => entry.caseId === caseId);
      assert.deepEqual(x?.lifecycle, l?.lifecycle, caseId);
      assert.deepEqual(x?.lifecycle, s?.lifecycle, caseId);
      assert.equal(x?.externalEffects, 0);
      assert.equal(l?.externalEffects, 0);
      assert.equal(s?.externalEffects, 0);
    }
    assert.equal(reports.xrpl!.cases.find((entry) => entry.caseId === 'MRC-08')?.lifecycle['status'], 'denied');
    assert.equal(reports.xrpl!.cases.find((entry) => entry.caseId === 'MRC-09')?.lifecycle['withheldBy'], 'authority-binding');
    assert.match(reports.xrpl!.cases.find((entry) => entry.caseId === 'MRC-09')?.lifecycle['reasons'] ?? '', /FINANCIAL_AUTHORITY_CEILING_EXCEEDED/);
    assert.equal(reports.xrpl!.cases.find((entry) => entry.caseId === 'MRC-10')?.lifecycle['withheldBy'], 'exercise');
  });

  it('the reports are deterministic: a second run of the same suite on the same rails produces byte-identical canonical reports', async () => {
    const digest = buildCoreSourceManifest().digest;
    const again = {
      xrpl: await runPaymentRailConformanceSuite(createGovernedPaymentHarness(XRPL_EDGE, digest)),
      lightning: await runPaymentRailConformanceSuite(createGovernedPaymentHarness(LIGHTNING_EDGE, digest)),
      stripe: await runPaymentRailConformanceSuite(createGovernedPaymentHarness(STRIPE_EDGE, digest)),
    };
    assert.equal(canonicalConformanceReportText(again.xrpl), canonicalConformanceReportText(reports.xrpl!));
    assert.equal(canonicalConformanceReportText(again.lightning), canonicalConformanceReportText(reports.lightning!));
    assert.equal(canonicalConformanceReportText(again.stripe), canonicalConformanceReportText(reports.stripe!));
  });

  it('the reports are closed qualification evidence: bounded tokens only, no provider reference, digest or secret, and canonical text is stable', () => {
    for (const report of [reports.xrpl!, reports.lightning!, reports.stripe!]) {
      const text = canonicalConformanceReportText(report);
      assert.equal(text, canonicalConformanceReportText(JSON.parse(JSON.stringify(report)) as PaymentRailConformanceReport));
      // No 64-hex value (a transaction hash, a payment hash, a preimage) except the CORE manifest digest itself.
      assert.deepEqual([...text.matchAll(/[0-9a-fA-F]{64}/g)].map((match) => match[0]), [report.coreManifestDigest.slice('sha256:'.length)]);
      assert.equal(/lnbc|lntb|lnbcrt|preimage|macaroon|seed|tx_blob|signed|BEGIN|\/tmp\/|\\\\|[A-Z]:\\|\d{4}-\d{2}-\d{2}T/i.test(text), false, text);
      assert.equal(/pi_|ch_|acct_|cus_|pm_card|sk_test|client_secret/.test(text), false, text);
      for (const entry of report.cases) for (const value of Object.values(entry.lifecycle)) assert.match(value, /^[A-Za-z0-9.,:=_-]{1,400}$/, `${entry.caseId}: ${value}`);
    }
  });
});
