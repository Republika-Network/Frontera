import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TradingRiskAssessmentInput, TradingRiskAssessmentResult, TradingRiskReliance, TradingRiskRelianceExpectation, TradeReferenceRequirement, TradeReferenceSelection } from '../index.js';
import { AT, OTHER_ORG, market, profileData, proposal, riskInput, sell } from './trade-risk-fixture.js';
import { exposureReading } from './trade-risk-fixture.js';
import { parseTradingRiskProfile, sealTradeExposureSnapshot } from '../index.js';

/**
 * TRADE-03 mutation qualification: each material fail-closed check is
 * removed from the **compiled** module, the mutant is loaded beside the
 * original, and the guarding assertion must then fail. A test that still
 * passes against a mutant is not guarding that check. The original module is
 * never modified; every mutant file is removed after use.
 */

const POLICY_DIR = join(__dirname, '..', 'policy');
const load = createRequire(__filename);

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  /** `true` when the safety property holds for this module. */
  readonly guard: (module: M) => boolean;
}

function withMutant<M>(mutant: Mutant<M>, run: (original: M, mutated: M) => void): void {
  const path = join(POLICY_DIR, mutant.file);
  const source = readFileSync(path, 'utf8');
  assert.equal(source.split(mutant.search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}`);
  const mutantPath = join(POLICY_DIR, `${mutant.file.replace(/\.js$/, '')}.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source.replace(mutant.search, mutant.replace));
  try {
    run(load(path) as M, load(mutantPath) as M);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

function qualify<M>(mutant: Mutant<M>): void {
  withMutant(mutant, (original, mutated) => {
    assert.equal(mutant.guard(original), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(mutant.guard(mutated), false, `${mutant.id}: the guard detects the removed check`);
  });
}

type AssessmentModule = { readonly assessTradingRisk: (input: TradingRiskAssessmentInput) => TradingRiskAssessmentResult };
type RelianceModule = { readonly checkTradingRiskReliance: (evidence: unknown, expected: TradingRiskRelianceExpectation) => TradingRiskReliance };
type ReferenceModule = { readonly selectTradeReference: (candidates: readonly unknown[], requirement: TradeReferenceRequirement) => TradeReferenceSelection };

const outcome = (module: AssessmentModule, input: TradingRiskAssessmentInput): string => {
  const result = module.assessTradingRisk(input);
  return result.assessed ? result.evidence.outcome : `REFUSED:${result.refusal}`;
};

const controlOutcome = (module: AssessmentModule, input: TradingRiskAssessmentInput, control: string): string | undefined => {
  const result = module.assessTradingRisk(input);
  return result.assessed ? result.evidence.controls.find((entry) => entry.control === control)?.outcome : undefined;
};

const withoutFact = (key: 'delegation' | 'exposure'): TradingRiskAssessmentInput => {
  const input = riskInput();
  return { ...input, facts: { ...input.facts, [key]: undefined } };
};

describe('TRADE-03 mutation qualification — removing a mandatory check is detected', () => {
  it('M1 issuer identity: comparing currency codes only lets a wrong-issuer pair through', () => {
    const wrongIssuer = riskInput({ proposal: sell('100', '200000000', { takerGets: { currency: '524C555344000000000000000000000000000000', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', value: '100' } }) });
    qualify<AssessmentModule>({
      id: 'issuer',
      file: 'trade-risk-assessment.js',
      search: '(0, trade_asset_js_1.tradeAssetsEqual)(pair.base, base) && (0, trade_asset_js_1.tradeAssetsEqual)(pair.quote, quote)',
      replace: 'sameCode(pair.base, base) && sameCode(pair.quote, quote)',
      guard: (module) => outcome(module, wrongIssuer) === 'VIOLATED',
    });
  });

  it('M2 missing delegation: treating absent delegation evidence as verified is detected', () => {
    qualify<AssessmentModule>({
      id: 'delegation',
      file: 'trade-risk-assessment.js',
      search: "record('DELEGATION_VERIFIED', 'UNAVAILABLE', 'DELEGATION_EVIDENCE_MISSING')",
      replace: "record('DELEGATION_VERIFIED', 'SATISFIED', 'DELEGATION_EVIDENCE_MISSING')",
      guard: (module) => outcome(module, withoutFact('delegation')) !== 'SATISFIED',
    });
  });

  it('M3 reference freshness: accepting a stale market snapshot is detected', () => {
    const profile = parseTradingRiskProfile(profileData());
    assert.ok(profile.valid && profile.profile.marketReference.mode === 'enforce');
    if (!profile.valid || profile.profile.marketReference.mode !== 'enforce') return;
    const requirement: TradeReferenceRequirement = {
      organizationId: 'org-acme',
      network: 'xrp-ledger-testnet',
      base: { kind: 'issued', currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
      quote: { kind: 'xrp' },
      policy: profile.profile.marketReference,
      provenance: 'simulated-permitted',
      at: AT,
    };
    const stale = market({ observedAt: '2026-10-13T11:00:00.000Z' });
    qualify<ReferenceModule>({
      id: 'freshness',
      file: 'trade-market-reference.js',
      search: "if (freshness === 'fresh')",
      replace: 'if (true)',
      guard: (module) => module.selectTradeReference([stale], requirement).available === false,
    });
  });

  it('M4 exact sell floor: an off-by-one comparison at the boundary is detected', () => {
    const below = riskInput({ proposal: sell('100', '189999999') });
    qualify<AssessmentModule>({
      id: 'sell-floor',
      file: 'trade-risk-assessment.js',
      search: "order >= 0 ? 'SATISFIED' : 'VIOLATED', order >= 0 ? 'SELL_AT_OR_ABOVE_MINIMUM'",
      replace: "order >= -1 ? 'SATISFIED' : 'VIOLATED', order >= -1 ? 'SELL_AT_OR_ABOVE_MINIMUM'",
      // The control itself, not the overall outcome: this order also exceeds the deviation limit.
      guard: (module) => controlOutcome(module, below, 'LIMIT_PRICE_BOUND') === 'VIOLATED',
    });
  });

  it('M5 completeness: SATISFIED when only some controls are satisfied is detected', () => {
    qualify<AssessmentModule>({
      id: 'completeness',
      file: 'trade-risk-assessment.js',
      search: "controls.every((result) => result.outcome === 'SATISFIED' ||",
      replace: "controls.some((result) => result.outcome === 'SATISFIED' ||",
      guard: (module) => outcome(module, withoutFact('exposure')) !== 'SATISFIED',
    });
  });

  it('M6 exposure ceiling: a comparison that can never exceed is detected', () => {
    const over = riskInput({ facts: { exposure: sealTradeExposureSnapshot(exposureReading({ currentExposure: '99900' })) } });
    qualify<AssessmentModule>({
      id: 'exposure',
      file: 'trade-risk-assessment.js',
      search: 'const overCeiling = (0, trade_risk_exact_js_1.compareRationals)(projected, (0, trade_risk_exact_js_1.rationalOfDecimal)(exposurePolicy.ceiling)) > 0;',
      replace: 'const overCeiling = (0, trade_risk_exact_js_1.compareRationals)(projected, (0, trade_risk_exact_js_1.rationalOfDecimal)(exposurePolicy.ceiling)) > 1;',
      guard: (module) => outcome(module, over) === 'VIOLATED',
    });
  });

  it('M7 organization isolation: applying another organization’s profile is detected', () => {
    const foreign = riskInput({ profile: profileData({ organizationId: OTHER_ORG }) });
    qualify<AssessmentModule>({
      id: 'organization',
      file: 'trade-risk-assessment.js',
      search: 'if (profile.organizationId !== identity.organizationId)',
      replace: 'if (false)',
      guard: (module) => outcome(module, foreign).startsWith('REFUSED:'),
    });
  });

  it('M8 proposal binding: reusing evidence for a proposal with changed economics is detected', () => {
    const assessment = load(join(POLICY_DIR, 'trade-risk-assessment.js')) as AssessmentModule;
    const result = assessment.assessTradingRisk(riskInput());
    assert.ok(result.assessed);
    if (!result.assessed) return;
    const evidence = result.evidence;
    const changed = { proposal: sell('100', '200000001'), profile: profileData(), at: AT };
    qualify<RelianceModule>({
      id: 'proposal-binding',
      file: 'trade-risk-reliance.js',
      search: "copy['proposalDigest'] !== validation.accepted.digest ||",
      replace: '',
      guard: (module) => module.checkTradingRiskReliance(evidence, changed).reliable === false,
    });
    assert.equal((load(join(POLICY_DIR, 'trade-risk-reliance.js')) as RelianceModule).checkTradingRiskReliance(evidence, { proposal: proposal(), profile: profileData(), at: AT }).reliable, true, 'control');
  });
});
