import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyPackRuntimeContext } from '../../runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime, PolicyPackRuntime } from '../../services/policy-pack-runtime.js';
import {
  buildGlobalLegalBaselineDemoPolicyPackRuntime,
  buildQuietGlobalLegalBaselineInput,
  GLOBAL_LEGAL_BASELINE_DEMO_NOW,
} from '../../fixtures/global-legal-baseline-policy-demo.fixture.js';
import {
  GLOBAL_LEGAL_BASELINE_POLICY_PACK,
  GLOBAL_LEGAL_BASELINE_POLICY_PACK_ID,
  GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID,
  GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1,
} from '../../packs/global-legal-baseline.policy-pack.js';

/** NB-008: the trusted policy author these tests write as. */
const POLICY_WRITER = { system: true, actorId: 'operator:policy-pack-test' } as const;

/** Phrases that would constitute a compliance/completeness overclaim -- never allowed in this pack's own text. */
const PROHIBITED_OVERCLAIM_PHRASES = [
  'legally compliant',
  'legal compliance passed',
  'complies with costa rica',
  'complies with eu law',
  'complies with us law',
  'complies with panama law',
  'banking compliant',
  'healthcare compliant',
  'labor compliant',
  'commercial compliant',
  'civil compliant',
  'criminal compliant',
  'certified compliant',
  'guaranteed compliant',
  'legal advice',
  'jurisdictionally valid',
  'jurisdictionally compliant',
  'approved by law',
];

/**
 * Safe disclaimer phrasing that legitimately contains a "prohibited" phrase
 * as a negation (e.g. "not legal advice", "does not claim ... legal
 * advice"). Stripped before scanning so the negative/disclaiming usage the
 * spec explicitly allows never registers as an overclaim.
 */
const SAFE_NEGATED_PHRASINGS = [/not[\s_]+legal advice/g, /no legal advice/g, /does not (constitute|provide) legal advice/g];

function scanForOverclaim(text: string): string | undefined {
  let sanitized = text;
  for (const pattern of SAFE_NEGATED_PHRASINGS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return PROHIBITED_OVERCLAIM_PHRASES.find((phrase) => sanitized.includes(phrase));
}

/** Portable equivalent of `assert.doesNotMatch` (not declared in every pinned `@types/node` version). */
function assertDoesNotMatch(text: string, pattern: RegExp): void {
  assert.equal(pattern.test(text), false, `expected "${text}" not to match ${pattern}`);
}

function collectPackText(): string {
  const parts: string[] = [
    GLOBAL_LEGAL_BASELINE_POLICY_PACK.name,
    GLOBAL_LEGAL_BASELINE_POLICY_PACK.description,
    GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.version,
  ];
  for (const source of GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.sources) {
    parts.push(source.title, source.description ?? '');
  }
  for (const rule of GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.rules) {
    parts.push(rule.name, rule.description, rule.effect.reason);
    for (const obligation of rule.obligations) parts.push(obligation.description);
    for (const evidence of rule.evidenceRequirements) parts.push(evidence.description);
    for (const approval of rule.approvalRequirements) parts.push(approval.description);
  }
  return parts.join(' \n ').toLowerCase();
}

describe('global-legal-baseline policy pack', () => {
  it('1. is registered and evaluated through the Domain Policy Pack Runtime, with no separate legal engine', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();

    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_ID, 'aoc.global_legal_baseline.v1');
    assert.ok(runtime instanceof PolicyPackRuntime);

    const packs = runtime.listActivePolicyPacks();
    assert.ok(packs.some((pack) => pack.id === 'aoc.global_legal_baseline.v1'));

    const versions = runtime.listActivePolicyPackVersions();
    assert.ok(versions.some((version) => version.id === GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID));

    // Every decision comes back out of the same evaluatePolicy() entry point every other pack uses.
    const result = runtime.evaluatePolicy(buildQuietGlobalLegalBaselineInput({ id: 'glb-test-1', action: 'demo_action' }));
    assert.ok(result.decision.applicablePackVersionIds.includes(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID));
  });

  it('2. every evaluation resolves an applicable pack version whose metadata preserves not_legal_advice', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(buildQuietGlobalLegalBaselineInput({ id: 'glb-test-2', action: 'demo_action' }));

    assert.ok(result.decision.applicablePackVersionIds.includes(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID));
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.requiredDisclaimer, 'not_legal_advice');
    assert.equal((GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.legalAdvice as boolean), false);
  });

  it('3. partial_policy_model is preserved on the pack version', () => {
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.legalCompleteness, 'partial_policy_model');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.policyModelStatus, 'partial_policy_model');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.completenessClaimed, false);
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.demoOnly, true);
  });

  it('4. no compliance overclaim appears anywhere in the pack\'s own rule/description/reason text', () => {
    const text = collectPackText();
    assert.equal(scanForOverclaim(text), undefined);
  });

  it('5. jurisdiction unknown on a legally sensitive action triggers legal review, not a jurisdictional conclusion', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-5',
        action: 'draft_agreement',
        sideEffectType: 'legal',
        // jurisdiction intentionally omitted -- this is the scenario under test.
        // principal is identified so this isolates jurisdiction-unknown from the separate
        // principal-not-identified authority-boundary rule (higher decision precedence).
        principalActorId: 'principal-known-1',
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-jurisdiction-unknown'));
    assertDoesNotMatch(result.decision.reason.toLowerCase(), /complies with|compliant|legal advice/);
  });

  it('6. a regulated-action detection with missing counsel review requires review, and is never itself an approval', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-6',
        action: 'process_regulated_transaction',
        metadata: { regulatedActionDetected: true, counselReviewStatus: 'missing' },
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-counsel-review-missing-for-regulated-action'));
    assert.ok(result.decision.approvalRequirements.some((requirement) => requirement.type === 'legal_review'));
    assertDoesNotMatch(result.decision.reason.toLowerCase(), /compliant|approved|passed/);
  });

  it('7. a demo-baseline policy source cannot pass as counsel-reviewed', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-7',
        action: 'sign_contract',
        metadata: { validationStatus: 'demo_baseline', requiresCounselReview: true },
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-demo-baseline-cannot-satisfy-counsel-review'));
  });

  it('8. a customer-provided policy source does not automatically satisfy a counsel-reviewed requirement', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-8',
        action: 'sign_contract',
        metadata: { validationStatus: 'customer_provided', requiresCounselReview: true },
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-customer-provided-cannot-auto-satisfy-counsel-review'));
  });

  it('9. a contractual action missing acceptance evidence holds with a structured evidence requirement', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-9',
        action: 'execute_contract',
        sideEffectType: 'contractual',
        hasRequiredEvidence: false,
        // jurisdiction and principal are known so this isolates the contract-acceptance-evidence
        // rule from the separate jurisdiction-unknown and principal-not-identified rules (both of
        // which take decision precedence over require_evidence).
        jurisdiction: 'demo-jurisdiction-a',
        principalActorId: 'principal-known-1',
      }),
    );

    assert.equal(result.decision.type, 'requires_evidence');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-contract-acceptance-evidence'));
    assert.ok(result.decision.evidenceRequirements.some((requirement) => requirement.type === 'contract'));
  });

  it('10. a legal-risk decision carries pack id, version, rule ids, and safe-framing labels the export layer can package', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({ id: 'glb-test-10', action: 'sign_contract', metadata: { highValueContract: true } }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.ok(result.decision.applicablePackVersionIds.includes(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_ID));
    assert.ok(result.decision.matchedRuleIds.length > 0);
    assert.ok(result.proof, 'evaluation must produce a proof exportable in a verifiable export package');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.requiredDisclaimer, 'not_legal_advice');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.policyModelStatus, 'partial_policy_model');
    const text = `${result.decision.reason}`.toLowerCase();
    assert.equal(scanForOverclaim(text), undefined);
  });

  it('11. binding a principal without authority proof denies with an authority-boundary flag, not a legal conclusion', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-11',
        action: 'bind_principal_to_agreement',
        principalActorId: 'principal-1',
        hasAuthorityProof: false,
      }),
    );

    assert.equal(result.decision.type, 'denied');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-authority-missing-proof-binds-principal'));
    assertDoesNotMatch(result.decision.reason.toLowerCase(), /legally authorized|power of attorney|complies with/);
  });

  it('12. a regulated-action pattern detection escalates to compliance review without interpreting or certifying compliance', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-12',
        action: 'process_payment_services_transaction',
        metadata: { regulatedActionPattern: 'payment_services_pattern' },
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-regulated-action-pattern-detected'));
    assert.ok(result.decision.approvalRequirements.some((requirement) => requirement.type === 'compliance_review'));
    const reason = result.decision.reason.toLowerCase();
    assertDoesNotMatch(reason, /compliant|compliance passed|definitively applies/);
  });

  it('13. a contract template modified after attestation requires re-review; the old attestation cannot be reused', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-13',
        action: 'use_contract_template',
        metadata: { contractTemplateModifiedAfterAttestation: true },
      }),
    );

    assert.equal(result.decision.type, 'requires_approval');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-modified-contract-template-re-review'));
    assert.ok(result.decision.obligations.some((obligation) => obligation.type === 'require_review'));
  });

  it('14. an active dispute blocks payment/contract execution', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-14',
        action: 'settle_event_payment',
        sideEffectType: 'financial',
        // jurisdiction is known so this isolates active-dispute-blocks-execution (deny) from the
        // separate jurisdiction-unknown rule (a lower-precedence require_approval that would not
        // change the asserted decision type here, but this keeps the isolation deliberate).
        jurisdiction: 'demo-jurisdiction-a',
        metadata: { activeDispute: true },
      }),
    );

    assert.equal(result.decision.type, 'denied');
    assert.equal(result.decision.allowed, false);
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-active-dispute-blocks-execution'));
  });

  it('15. evaluation is deterministic across independently built runtimes (no network/LLM/OCR/PDF/web lookup)', () => {
    const runtimeA = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const runtimeB = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const input = buildQuietGlobalLegalBaselineInput({ id: 'glb-test-15', action: 'sign_contract', metadata: { highValueContract: true } });

    const resultA = runtimeA.evaluatePolicy(input);
    const resultB = runtimeB.evaluatePolicy(input);

    assert.deepEqual(resultA.decision, resultB.decision);
    assert.equal(resultA.proof?.proofHash, resultB.proof?.proofHash);
  });

  it('16. pack identity is aoc.global_legal_baseline.v1, versioned, global, and not jurisdiction-specific', () => {
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK.id, 'aoc.global_legal_baseline.v1');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.version, '1.0.0');
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.scope.jurisdictions, undefined);
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.scope.countries, undefined);
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.jurisdictionSpecific, false);
    assert.equal(GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.complianceCertification, false);
  });

  it('17. required safe-framing labels are present in pack version metadata', () => {
    const labels = GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata?.safeFramingLabels as readonly string[];
    for (const label of [
      'not_legal_advice',
      'partial_policy_model',
      'baseline_legal_awareness',
      'requires_customer_validation',
      'requires_counsel_review_when_applicable',
      'not_jurisdiction_specific',
      'not_compliance_certification',
    ]) {
      assert.ok(labels.includes(label), `missing required framing label: ${label}`);
    }
  });

  it('18. future jurisdiction-pack extension hooks exist but are never pre-populated with a compliance claim', () => {
    const metadata = GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.requiredJurisdictionPackIds, []);
    assert.deepEqual(metadata.jurisdictionSpecificPolicyRefs, []);
    assert.deepEqual(metadata.counselReviewedPolicyRefs, []);
    assert.equal(metadata.jurisdictionPackStatus, 'not_registered');
  });

  it('19. registering this pack demoOnly with legalCompleteness=verified_by_counsel is rejected by the runtime validator', () => {
    const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(GLOBAL_LEGAL_BASELINE_DEMO_NOW));
    runtime.registerPolicyPack(POLICY_WRITER, { ...GLOBAL_LEGAL_BASELINE_POLICY_PACK, id: 'aoc.global_legal_baseline.v1-test-invalid' });

    assert.throws(() =>
      runtime.registerPolicyPackVersion(POLICY_WRITER, {
        ...GLOBAL_LEGAL_BASELINE_POLICY_PACK_VERSION_V1,
        id: 'aoc.global_legal_baseline.v1-test-invalid-r1',
        policyPackId: 'aoc.global_legal_baseline.v1-test-invalid',
        legalCompleteness: 'verified_by_counsel',
      }),
    );
  });

  it('20. a prohibited-action baseline pattern is denied as an operational safety rule', () => {
    const runtime = buildGlobalLegalBaselineDemoPolicyPackRuntime();
    const result = runtime.evaluatePolicy(
      buildQuietGlobalLegalBaselineInput({
        id: 'glb-test-20',
        action: 'execute_without_audit_trail',
        metadata: { prohibitedActionPattern: 'execute_without_audit_trail' },
      }),
    );

    assert.equal(result.decision.type, 'denied');
    assert.ok(result.decision.matchedRuleIds.includes('global-legal-baseline-rule-prohibited-action-pattern'));
  });
});
