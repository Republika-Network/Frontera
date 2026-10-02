#!/usr/bin/env node
// Synthetic, non-sensitive, deterministic portability fixture (Phase 10).
//
// Seeds a fresh SQLite store set (governance + agent-passport + assurance +
// kernel-authority)
// under `--target` with a real, representative slice of governed history --
// built through the actual Enterprise Host services (never hand-crafted
// rows), so a backup/restore drill exercises the same code paths production
// traffic does. Contains no production or personal data: every actor,
// organization, and agent id below is a fixture literal.
//
// Usage:
//   node scripts/portability/generate-portability-fixture.mjs --target <dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { loadEnterpriseModule, stableJsonStringify } from './lib-portability.mjs';
import { targetStorePaths as registryTargetPaths } from './store-registry.mjs';

const FIXTURE_ORG = 'org-portability-fixture';
const FIXTURE_NOW = '2026-01-01T00:00:00.000Z';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') args.target = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.target) throw new Error('Usage: generate-portability-fixture.mjs --target <dir>');
  return args;
}

/** The fixture's four stores, at the registry's own target filenames (no second list). */
export function targetStorePaths(targetDir) {
  const paths = registryTargetPaths(targetDir);
  return { governance: paths.governance, passport: paths['agent-passport'], assurance: paths.assurance, kernelAuthority: paths['kernel-authority'] };
}

async function loadAuthorityFixture() {
  // The same generic, application-neutral authority fixture the runtime's own
  // durable-authority suite uses -- not a second, parallel fixture that could
  // drift from what the tests actually prove.
  return import(resolve(new URL('../..', import.meta.url).pathname, 'dist/src/enterprise/kernel-authority/fixtures/durable-authority.fixture.js'));
}

async function loadTestSupport() {
  // Reuses the exact fixture the Enterprise Host's own integration test
  // suite runs against (`bridgeRecognitionRuntime` over the "Datasys Agent
  // Republic" world seeded in `datasys-enforcement.fixture.ts`) instead of
  // inventing a second decision-engine fixture -- see
  // `src/enterprise/__tests__/support.ts`.
  return import(resolve(new URL('../..', import.meta.url).pathname, 'dist/src/enterprise/__tests__/support.js'));
}

export async function generateFixture({ target }) {
  const enterprise = await loadEnterpriseModule();
  const support = await loadTestSupport();
  const authorityFixture = await loadAuthorityFixture();

  const targetPath = resolve(target);
  mkdirSync(targetPath, { recursive: true });
  const paths = targetStorePaths(targetPath);

  const configuration = enterprise.loadEnterpriseConfiguration({
    AOC_ENTERPRISE_ENV: 'test',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: paths.governance,
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: paths.passport,
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: paths.assurance,
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: paths.kernelAuthority,
  });

  const kernelProviders = support.buildTestKernelProviders();
  const app = await enterprise.createEnterprise({ configuration, kernelProviders });

  const record = {};

  try {
    const context = { organizationId: FIXTURE_ORG, system: false };

    // -- One allowed, one denied, one approval-required Governance evaluation --
    const allowed = await app.evaluate(support.buildAllowedRequestBody({ requestId: 'fixture-req-allowed', organization: { id: FIXTURE_ORG } }));
    const denied = await app.evaluate(support.buildDeniedRequestBody({ requestId: 'fixture-req-denied', organization: { id: FIXTURE_ORG } }));
    const approvalRequired = await app.evaluate(support.buildApprovalRequiredRequestBody({ requestId: 'fixture-req-approval', organization: { id: FIXTURE_ORG } }));

    const allowedRecord = await app.persistence.getByRequestId({ system: true }, 'fixture-req-allowed');
    const deniedRecord = await app.persistence.getByRequestId({ system: true }, 'fixture-req-denied');
    const approvalRecord = await app.persistence.getByRequestId({ system: true }, 'fixture-req-approval');

    record.governance = {
      organizationId: FIXTURE_ORG,
      allowed: { requestId: 'fixture-req-allowed', httpStatus: allowed.httpStatus, evaluationId: allowedRecord.evaluation.evaluationId, decisionId: allowedRecord.evaluation.decisionId, status: allowedRecord.evaluation.status, aggregateDigest: allowedRecord.integrity.aggregateDigest },
      denied: { requestId: 'fixture-req-denied', httpStatus: denied.httpStatus, evaluationId: deniedRecord.evaluation.evaluationId, decisionId: deniedRecord.evaluation.decisionId, status: deniedRecord.evaluation.status, aggregateDigest: deniedRecord.integrity.aggregateDigest },
      approvalRequired: { requestId: 'fixture-req-approval', httpStatus: approvalRequired.httpStatus, evaluationId: approvalRecord.evaluation.evaluationId, decisionId: approvalRecord.evaluation.decisionId, status: approvalRecord.evaluation.status, aggregateDigest: approvalRecord.integrity.aggregateDigest },
    };

    // -- Two Evidence Bundles from the allowed record, at different disclosure levels --
    const auditorBundle = await app.evidence.build(undefined, { evaluationId: allowedRecord.evaluation.evaluationId, level: 'AUDITOR' });
    const customerBundle = await app.evidence.build(undefined, { evaluationId: allowedRecord.evaluation.evaluationId, level: 'CUSTOMER' });
    record.evidence = {
      sourceEvaluationId: allowedRecord.evaluation.evaluationId,
      auditor: { level: 'AUDITOR', bundleId: auditorBundle.bundle.bundleId, disclosurePolicy: auditorBundle.bundle.disclosure.policyId, bundleDigest: auditorBundle.bundle.integrity.bundleDigest },
      customer: { level: 'CUSTOMER', bundleId: customerBundle.bundle.bundleId, disclosurePolicy: customerBundle.bundle.disclosure.policyId, bundleDigest: customerBundle.bundle.integrity.bundleDigest },
    };

    // -- One active Passport, linked to the Governance Record and an Evidence Bundle --
    const { passport: activePassport } = await app.passports.issuePassport(context, {
      subject: { agentId: 'fixture-agent-active', agentType: 'autonomous_agent', displayName: 'Portability Fixture Agent (Active)' },
      organization: { organizationId: FIXTURE_ORG, recognizedBy: `${FIXTURE_ORG}-registry` },
      actorId: 'fixture-actor-1',
      activateImmediately: true,
    });
    await app.passports.linkGovernanceRecord(
      context,
      activePassport.passportId,
      {
        evaluationId: allowedRecord.evaluation.evaluationId,
        decisionId: allowedRecord.evaluation.decisionId,
        requestId: allowedRecord.request.requestId,
        status: allowedRecord.evaluation.status,
        occurredAt: allowedRecord.evaluation.evaluatedAt,
        governanceRecordDigest: allowedRecord.integrity.aggregateDigest,
      },
      'fixture-actor-1',
    );
    await app.passports.linkEvidenceBundle(
      context,
      activePassport.passportId,
      {
        bundleId: auditorBundle.bundle.bundleId,
        bundleVersion: auditorBundle.bundle.bundleVersion,
        bundleDigest: auditorBundle.bundle.integrity.bundleDigest,
        disclosurePolicy: auditorBundle.bundle.disclosure.policyId,
        subjectType: auditorBundle.bundle.subject.subjectType,
        createdAt: auditorBundle.bundle.createdAt,
      },
      'fixture-actor-1',
    );

    // -- One suspended Passport (issue -> activate -> suspend event sequence) --
    const { passport: suspendedPassport } = await app.passports.issuePassport(context, {
      subject: { agentId: 'fixture-agent-suspended', agentType: 'autonomous_agent', displayName: 'Portability Fixture Agent (Suspended)' },
      organization: { organizationId: FIXTURE_ORG, recognizedBy: `${FIXTURE_ORG}-registry` },
      actorId: 'fixture-actor-1',
      activateImmediately: true,
    });
    await app.passports.suspendPassport(context, suspendedPassport.passportId, { suspendedBy: 'fixture-actor-2', reason: 'Portability fixture: scheduled review.' });

    record.passport = {
      organizationId: FIXTURE_ORG,
      active: { passportId: activePassport.passportId, agentId: 'fixture-agent-active' },
      suspended: { passportId: suspendedPassport.passportId, agentId: 'fixture-agent-suspended' },
    };

    // -- One Assurance Assessment with multiple control evaluations, >=1 finding, scores, and eligibility --
    const created = await app.assurance.createAssessment(context, {
      subject: { subjectType: 'agent', subjectId: 'fixture-agent-active', organizationId: FIXTURE_ORG, passportId: activePassport.passportId },
      frameworkId: enterprise.AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: enterprise.AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'fixture-assessor-1',
      evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
    });
    await app.assurance.evaluateAssessment(context, created.assessmentId);
    await app.assurance.recordManualReview(context, {
      assessmentId: created.assessmentId,
      controlId: 'saf.ops.independent-review',
      reviewerId: 'fixture-reviewer-1',
      reviewerRole: 'assurance-reviewer',
      outcome: 'insufficient_evidence',
      rationale: 'Portability fixture: deliberately incomplete review, to guarantee at least one finding.',
      evidenceReferenceIds: ['fixture-manual-note-1'],
    });
    const completed = await app.assurance.completeAssessment(context, created.assessmentId);

    record.assurance = {
      organizationId: FIXTURE_ORG,
      assessmentId: completed.assessmentId,
      subjectId: 'fixture-agent-active',
      status: completed.status,
      normalizedScore: completed.score.normalizedScore,
      findingCount: completed.findings.length,
      eligibilityProfileIds: completed.eligibility.map((e) => e.profileId),
      assessmentDigest: completed.integrity.assessmentDigest,
    };

    // -- One operator-provisioned Kernel Authority world, plus one revocation --
    //
    // Seeded through the real public operator surface, never by writing rows,
    // and deliberately containing BOTH live and revoked authority: a restore
    // that silently dropped the revocation would restore an actor to authority
    // an operator had already withdrawn, which is the one direction a
    // backup/restore cycle must never move in.
    const authorityStore = await enterprise.createSqliteKernelAuthorityStore(paths.kernelAuthority);
    try {
      const provisioning = enterprise.createKernelAuthorityProvisioningService({ store: authorityStore, organizationId: FIXTURE_ORG });
      const authorityIds = await authorityFixture.provisionDurableAuthorityFixture(provisioning, { trustDomainId: 'trust-domain-portability-fixture' });
      await provisioning.provisionCapabilityToken(authorityFixture.DURABLE_FIXTURE_OPERATOR, {
        ...authorityFixture.buildDurableAuthorityPayloads(FIXTURE_ORG, 'trust-domain-portability-fixture').capabilityToken,
        capabilityTokenId: 'cap-agent-revoked',
      });
      await provisioning.revoke(authorityFixture.DURABLE_FIXTURE_OPERATOR, {
        entityKind: 'capability-token',
        entityId: 'cap-agent-revoked',
        reason: 'Portability fixture: withdrawn before backup, must stay withdrawn after restore.',
      });

      const authorityRecords = await provisioning.listRecords(authorityFixture.DURABLE_FIXTURE_OPERATOR);
      record.kernelAuthority = {
        organizationId: FIXTURE_ORG,
        trustDomainId: authorityIds.trustDomainId,
        agentActorId: authorityIds.agentActorId,
        ownerActorId: authorityIds.ownerActorId,
        action: authorityIds.action,
        resourceScope: authorityIds.resourceScope,
        capability: authorityIds.capability,
        activeCapabilityTokenId: authorityIds.capabilityTokenId,
        revokedCapabilityTokenId: 'cap-agent-revoked',
        recordCount: authorityRecords.length,
        externalSubject: { system: 'example-app', subjectId: 'external-user-42' },
        recordDigests: authorityRecords.map((entry) => `${entry.entityKind}:${entry.entityId}:${entry.status}:${entry.latestEventDigest}`).sort(),
      };
    } finally {
      await authorityStore.close();
    }

    const fixture = {
      fixtureVersion: 'aoc.enterprise.portability-fixture.v1',
      generatedAt: FIXTURE_NOW,
      organizationId: FIXTURE_ORG,
      record,
    };
    // Written here (not left to callers) so every consumer -- the CLI, the
    // in-process smoke check, the clean-room drill -- can always find
    // `fixture-manifest.json` next to the stores it describes.
    writeFileSync(join(targetPath, 'fixture-manifest.json'), stableJsonStringify(fixture));
    return fixture;
  } finally {
    await app.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = await generateFixture(args);
  console.log(`Portability fixture generated at ${resolve(args.target)}`);
  console.log(JSON.stringify(fixture, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    console.error(`[fixture:portability:v1] ${error.message}`);
    process.exitCode = 1;
  });
}
