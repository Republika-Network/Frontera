import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, describe, it } from 'node:test';

import type { TransitionRecord } from '../conformance/contracts.js';
import { RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1 } from '../conformance/profile.js';
import { verifyCredentialHistory } from '../conformance/verifier.js';
import { ORG_A } from './conformance-support.js';
import { BYPASS_VARIANTS, REFERENCE_DEPLOYMENT_DIGEST, REFERENCE_OPERATIONS } from './conformance-reference-pep.js';
import {
  REFERENCE_DECLARED_EXCLUSIONS,
  activeReferenceCredential,
  assertionOf,
  buildReferenceCircuit,
  cleanupReferenceCircuits,
  issueReference,
  observeReference,
  referenceApprovals,
  referenceCoverage,
  referenceStatus,
  runReferenceBaseline,
} from './conformance-reference-support.js';

/**
 * RN-CONFORM-04 / WP-13 — the reproducible synthetic demonstration.
 *
 * One run of the whole story — conformant reference PEP, introduced export bypass, two independent signed observations,
 * automatic suspension, signed SUSPENDED status, remediation, full revalidation, two-person reinstatement, signed ACTIVE
 * status, verified history — as `rn.conformance.reference-demo-report/1`. Written only when
 * `FRONTERA_RN_CONFORM_04_REPORT_OUT` names a path (the CI job uploads it); otherwise it runs inside `npm test` and writes
 * nothing. A SYNTHETIC TECHNICAL DEMONSTRATION — NOT A FILEVERSE CERTIFICATION.
 */

after(() => cleanupReferenceCircuits());

const nonce = () => randomBytes(32).toString('base64url');

describe('RN-CONFORM-04 — reproducible synthetic demonstration', () => {
  it('produces the structured execution report', async () => {
    const c = buildReferenceCircuit({ seed: 'rn-conform-04-demo' });
    const s = referenceStatus(c);
    const { lifecycle } = c.services();
    const verifier = s.verifierStore('demo-verifier');
    const online = (id: string) => {
      const n = nonce();
      const v = s.verify(assertionOf(s.registry.issueOnline(s.onlineRequest(id, n))), id, { kind: 'online', nonce: n }, { store: verifier });
      return { result: v.result, state: v.state, stateVersion: v.stateVersion, statusSequence: v.sequence, issuedAt: v.issuedAt, validUntil: v.validUntil, evidenceFreshUntil: v.evidenceFreshUntil };
    };

    // Initial conformant result.
    const id = await activeReferenceCredential(c);
    const initialCoverage = referenceCoverage(c, id);
    const initialStatus = online(id);

    // Introduced bypass and independent signed observations.
    c.clock.advance(2 * 3600);
    c.deployment.defects.add('BYPASS-01');
    c.deployment.defectOperations.add('document.export');
    const g01 = issueReference(c, 'G01', [c.validators.A, c.validators.B], 'document.export');
    const obsA = await observeReference(c, c.validators.A, g01);
    const afterA = lifecycle.evaluate(ORG_A, id);
    c.clock.advance(5 * 60);
    const obsB = await observeReference(c, c.validators.B, g01);
    const confirmed = lifecycle.evaluate(ORG_A, id);
    const suspendedStatus = online(id);

    // Remediation, full revalidation, two-person reinstatement.
    c.clock.advance(3600);
    c.deployment.defects.clear();
    c.deployment.defectOperations.clear();
    const revalidation = await runReferenceBaseline(c, [c.validators.A, c.validators.B]);
    c.clock.advance(1);
    const remediation = { statement: 'document.export now routes through the reference PEP; all critical challenges re-run.', declaredBy: 'platform-synthetic-alpha', declaredAt: c.clock.now() };
    const reinstatement = lifecycle.prepare('reinstate', { organizationId: ORG_A, credentialId: id, remediation });
    const approvals = referenceApprovals(c, reinstatement, c.humans.carol, c.humans.bob);
    const reinstated = lifecycle.commit(reinstatement, approvals);
    const reinstatedStatus = online(id);
    const history = verifyCredentialHistory(c.store, ORG_A, id, { registryPublicKeyPem: c.registryPublicKeyPem, humans: c.humansDirectory });

    const report = {
      schema: 'rn.conformance.reference-demo-report/1',
      designation: 'SYNTHETIC TECHNICAL DEMONSTRATION — NOT A FILEVERSE CERTIFICATION. Fixture behaviour is mocked; engine, lifecycle and status results are measured.',
      boundaries: { fileverseContacted: false, networkUsed: false, realCustomerData: false, ledgerUsed: false, independentOperators: false, note: 'Validators and operators are synthetic labels under Republika control (VALIDATOR_PROTOCOL §1).' },
      '1_integration': { integrationId: c.integration.integrationId, integrationVersion: c.integration.integrationVersion, integrationDigest: c.integration.integrationDigest, deploymentDigest: REFERENCE_DEPLOYMENT_DIGEST, kind: 'MOCKED_FIXTURE: synthetic Fileverse-inspired reference PEP' },
      '2_profile': { profileId: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileId, profileVersion: RN_CONFORMANCE_DOCUMENT_USE_REFERENCE_PROFILE_V0_1.profileVersion, profileDigest: c.profileDigest, normative: false, commercialActivation: false },
      '3_coveredOperations': { covered: [...REFERENCE_OPERATIONS], declaredExclusions: REFERENCE_DECLARED_EXCLUSIONS.map((e) => e.operation) },
      '4_challengeCoverage': initialCoverage.map((r) => ({ requirementId: r.requirementId, challengeType: r.challengeType, operation: r.operation, coverageStatus: r.coverageStatus, classification: r.classification, engineCategory: r.engineCategory })),
      '5_initialResult': { measured: true, state: 'ACTIVE', status: initialStatus },
      '6_introducedBypass': { measured: false, variant: 'BYPASS-01', operation: 'document.export', title: BYPASS_VARIANTS['BYPASS-01'].title },
      '7_signedObservations': [obsA, obsB].map((o, i) => ({ measured: true, validatorId: i === 0 ? 'validator-a' : 'validator-b', operatorId: i === 0 ? 'op-synthetic-a' : 'op-synthetic-b', accepted: o.result.accepted, observedOutcome: o.probe.observedOutcome, engineOutcomeClass: o.result.accepted ? o.result.observation.outcomeClass : null })),
      '8_confirmedViolation': {
        measured: true,
        afterFirstValidator: { category: afterA.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, proposal: afterA.evaluation.proposal, transition: afterA.protectiveTransition === null ? null : 'unexpected' },
        afterSecondOperator: { category: confirmed.evaluation.requirementResults.find((r) => r.requirementId === 'CR-01')?.category, criticalFailureConfirmed: confirmed.evaluation.criticalFailureConfirmed },
      },
      '9_automaticSuspension': { measured: true, transition: confirmed.protectiveTransition === null ? null : { code: confirmed.protectiveTransition.record.transitionCode, reasonCode: confirmed.protectiveTransition.record.reasonCode, humans: confirmed.protectiveTransition.record.humanDecisions.length } },
      '10_signedSuspendedStatus': { measured: true, status: suspendedStatus },
      '11_remediation': { measured: false, statement: remediation.statement, declaredBy: remediation.declaredBy },
      '12_revalidation': { measured: true, observations: revalidation.length, allAccepted: revalidation.every((r) => r.accepted) },
      '13_twoPersonApproval': { measured: true, approvers: approvals.map((d) => ({ principalId: d.decision.principalId, role: d.decision.role })) },
      '14_reinstatedStatus': { measured: true, state: reinstated.state, stateVersion: reinstated.stateVersion, status: reinstatedStatus },
      '15_verifiedHistory': { measured: true, valid: history.valid, transitions: history.valid ? history.transitions.map((r: TransitionRecord) => `${r.stateVersion}:${r.transitionCode}:${r.from ?? '∅'}→${r.to}:${r.reasonCode}`) : [] },
    };

    // The report is evidence of the story above, so its load-bearing claims are asserted, not just printed.
    assert.ok(initialCoverage.filter((r) => r.challengeType !== null).every((r) => r.coverageStatus === 'COVERED' && r.classification === 'ACCEPTED'));
    assert.equal(initialStatus.result, 'CONFORMANT');
    assert.equal(afterA.protectiveTransition, null);
    assert.equal(report['9_automaticSuspension'].transition?.code, 'T4');
    assert.equal(report['9_automaticSuspension'].transition?.humans, 0, 'suspension needed no human');
    assert.deepEqual([suspendedStatus.result, suspendedStatus.state], ['NOT_CONFORMANT', 'SUSPENDED']);
    assert.deepEqual([reinstatedStatus.result, reinstatedStatus.state, reinstated.stateVersion], ['CONFORMANT', 'ACTIVE', 4]);
    assert.ok(history.valid);
    assert.equal(JSON.stringify(report).includes('RN-CONFORM-04-SENTINEL'), false, 'no protected content in the report');

    const out = process.env['FRONTERA_RN_CONFORM_04_REPORT_OUT'];
    if (out !== undefined && out.length > 0) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      const summary = [
        '# RN-CONFORM-04 synthetic reference PEP demonstration',
        '',
        'SYNTHETIC TECHNICAL DEMONSTRATION — NOT A FILEVERSE CERTIFICATION. No Fileverse system, network, ledger or customer data was used.',
        '',
        `- Integration ${report['1_integration'].integrationId} v${report['1_integration'].integrationVersion}, profile ${report['2_profile'].profileId}@${report['2_profile'].profileVersion}`,
        `- Covered: ${REFERENCE_OPERATIONS.join(', ')}; excluded: ${report['3_coveredOperations'].declaredExclusions.join(', ')}`,
        `- Initial: ACTIVE, online status ${initialStatus.result}`,
        `- Bypass (fixture): ${report['6_introducedBypass'].title} on document.export`,
        `- After validator A: ${report['8_confirmedViolation'].afterFirstValidator.category} (no transition)`,
        `- After validator B (distinct operator): ${report['8_confirmedViolation'].afterSecondOperator.category} → automatic ${report['9_automaticSuspension'].transition?.code} ${report['9_automaticSuspension'].transition?.reasonCode}`,
        `- Signed online status: ${suspendedStatus.result} / ${suspendedStatus.state}`,
        `- Revalidation: ${revalidation.length} observations; reinstatement by ${approvals.map((d) => d.decision.principalId).join(' + ')}`,
        `- Final: ${reinstated.state} v${reinstated.stateVersion}, online status ${reinstatedStatus.result}; history ${history.valid ? 'verified' : 'INVALID'}`,
        '',
      ].join('\n');
      writeFileSync(`${out.replace(/\.json$/, '')}.summary.md`, summary);
    }
    s.close();
  });
});
