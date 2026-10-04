#!/usr/bin/env node
// Pre/post logical-equivalence comparison (Phase 14).
//
// Deliberately does NOT compare raw SQLite file bytes -- a restored file can
// have a different physical page layout than its source and still be
// logically identical (or vice versa: identical bytes but a corrupted
// logical read). Instead this opens both store sets through the real
// runtime store constructors and compares canonical, digest-bearing
// projections: decision ids/status, aggregate digests, bundle digests
// (Evidence Bundles are rebuilt deterministically -- see
// AOC_ENTERPRISE_V1_PORTABILITY_CURRENT_STATE.md for why), Passport
// state/digests, Assurance scores/findings/eligibility/digests, and -- for the
// Kernel Authority Store -- the *decisions* the restored authority world
// produces, not merely its rows. A restore that reproduced every row but
// hydrated into a world that decided differently would be a failed restore,
// and only evaluating proves it did not happen.
//
// Usage:
//   node scripts/portability/compare-portability-state.mjs \
//     --pre <dir> --post <dir> --fixture <fixture-manifest.json> --output <comparison.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnterpriseModule, stableJsonStringify } from './lib-portability.mjs';
import { targetStorePaths } from './store-registry.mjs';

const SYSTEM_CONTEXT = { system: true };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pre') args.pre = argv[++i];
    else if (arg === '--post') args.post = argv[++i];
    else if (arg === '--fixture') args.fixture = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.pre || !args.post || !args.fixture) throw new Error('Usage: compare-portability-state.mjs --pre <dir> --post <dir> --fixture <path> [--output <path>]');
  return args;
}

function storePaths(dir) {
  const paths = targetStorePaths(dir);
  return { governance: paths.governance, passport: paths['agent-passport'], assurance: paths.assurance, kernelAuthority: paths['kernel-authority'], evidence: paths['evidence-bundles'] };
}

/** ASSURE-01: the durable Evidence Bundle Store, opened through its own (verifying) factory. */
async function openEvidenceStore(path) {
  const module = await import(new URL('../../dist/src/enterprise/evidence/sqlite-evidence-store.js', import.meta.url).href);
  return module.createSqliteEvidenceStore(path, { now: () => '2026-01-01T00:00:00.000Z' });
}

async function openStores(enterprise, dir) {
  const paths = storePaths(dir);
  return {
    governance: await enterprise.createSqliteGovernanceStore(paths.governance),
    passport: await enterprise.createSqlitePassportStore(paths.passport),
    assurance: await enterprise.createSqliteAssuranceStore(paths.assurance),
    kernelAuthority: await enterprise.createSqliteKernelAuthorityStore(paths.kernelAuthority),
    evidence: await openEvidenceStore(paths.evidence),
  };
}

async function closeStores(stores) {
  await Promise.all([stores.governance.close(), stores.passport.close(), stores.assurance.close(), stores.kernelAuthority.close(), stores.evidence.close()]);
}

async function compareGovernance(enterprise, preStores, postStores, fixture) {
  const results = [];
  for (const key of ['allowed', 'denied', 'approvalRequired']) {
    const expected = fixture.record.governance[key];
    const [preRecord, postRecord] = await Promise.all([
      preStores.governance.getByEvaluationId(SYSTEM_CONTEXT, expected.evaluationId),
      postStores.governance.getByEvaluationId(SYSTEM_CONTEXT, expected.evaluationId),
    ]);
    const [preVerify, postVerify] = await Promise.all([
      preStores.governance.verify(SYSTEM_CONTEXT, expected.evaluationId),
      postStores.governance.verify(SYSTEM_CONTEXT, expected.evaluationId),
    ]);
    results.push({
      case: key,
      evaluationId: expected.evaluationId,
      statusMatches: preRecord?.evaluation.status === postRecord?.evaluation.status && postRecord?.evaluation.status === expected.status,
      aggregateDigestMatches: preRecord?.integrity.aggregateDigest === postRecord?.integrity.aggregateDigest && postRecord?.integrity.aggregateDigest === expected.aggregateDigest,
      preValid: preVerify.valid,
      postValid: postVerify.valid,
      traceStepCountMatches: preRecord?.trace.length === postRecord?.trace.length,
      reasonCodeCountMatches: preRecord?.reasons.length === postRecord?.reasons.length,
    });
  }
  const total = await postStores.governance.query(SYSTEM_CONTEXT, {});
  return { cases: results, equivalent: results.every((r) => r.statusMatches && r.aggregateDigestMatches && r.preValid && r.postValid && r.traceStepCountMatches && r.reasonCodeCountMatches), postRecordCount: total.records.length };
}

async function compareEvidence(enterprise, preStores, postStores, fixture) {
  const evidence = fixture.record.evidence;
  const results = [];
  for (const level of ['auditor', 'customer']) {
    const expected = evidence[level];
    const policy = enterprise.getDisclosurePolicy(expected.level);
    // Deterministic, injected now/nextId so the *rebuild* is byte-reproducible
    // across both the pre and post store -- Evidence Bundles are in-memory
    // only in v1 (see the current-state doc), so this is what "the Evidence
    // Bundle survives restore" means here: the same source Governance
    // Record, re-projected under the same policy, digests identically.
    const deterministicNow = () => '2026-01-01T00:00:00.000Z';
    const deterministicNextId = (prefix) => `${prefix}-comparison-fixed`;

    const [preRecord, postRecord] = await Promise.all([
      preStores.governance.getByEvaluationId(SYSTEM_CONTEXT, evidence.sourceEvaluationId),
      postStores.governance.getByEvaluationId(SYSTEM_CONTEXT, evidence.sourceEvaluationId),
    ]);
    const preBundle = enterprise.buildEvidenceBundle(preRecord, policy, { now: deterministicNow, nextId: deterministicNextId });
    const postBundle = enterprise.buildEvidenceBundle(postRecord, policy, { now: deterministicNow, nextId: deterministicNextId });

    // ASSURE-01: the issued bundle itself is durable — restored byte for byte, with its lifecycle.
    const [preStored, postStored] = await Promise.all([preStores.evidence.getByBundleId(SYSTEM_CONTEXT, expected.bundleId), postStores.evidence.getByBundleId(SYSTEM_CONTEXT, expected.bundleId)]);

    results.push({
      level,
      disclosurePolicy: expected.disclosurePolicy,
      rebuiltDigestMatches: preBundle.integrity.bundleDigest === postBundle.integrity.bundleDigest,
      sourceRecordDigestUnchanged: preRecord?.integrity.aggregateDigest === postRecord?.integrity.aggregateDigest,
      storedBundleRestored: preStored !== null && postStored !== null && JSON.stringify(preStored) === JSON.stringify(postStored) && postStored.bundle.integrity.bundleDigest === expected.bundleDigest,
    });
  }
  return {
    cases: results,
    equivalent: results.every((r) => r.rebuiltDigestMatches && r.sourceRecordDigestUnchanged && r.storedBundleRestored),
    distinctBundleDigestsAcrossLevels: new Set(results.map((r) => r.disclosurePolicy)).size === results.length,
  };
}

async function comparePassport(enterprise, preStores, postStores, fixture) {
  const results = [];
  for (const key of ['active', 'suspended']) {
    const expected = fixture.record.passport[key];
    const [preLoad, postLoad] = await Promise.all([
      preStores.passport.reconstruct(SYSTEM_CONTEXT, expected.passportId),
      postStores.passport.reconstruct(SYSTEM_CONTEXT, expected.passportId),
    ]);
    const [preVerify, postVerify] = await Promise.all([
      preStores.passport.verify(SYSTEM_CONTEXT, expected.passportId),
      postStores.passport.verify(SYSTEM_CONTEXT, expected.passportId),
    ]);
    const [preEvents, postEvents] = await Promise.all([
      preStores.passport.listEvents(SYSTEM_CONTEXT, expected.passportId),
      postStores.passport.listEvents(SYSTEM_CONTEXT, expected.passportId),
    ]);
    results.push({
      case: key,
      passportId: expected.passportId,
      statusMatches: preLoad.passport?.status === postLoad.passport?.status,
      eventSequenceLengthMatches: preEvents.length === postEvents.length,
      integrityDigestMatches: preLoad.passport?.integrity.chainDigest === postLoad.passport?.integrity.chainDigest,
      preValid: preVerify.valid,
      postValid: postVerify.valid,
    });
  }
  return { cases: results, equivalent: results.every((r) => r.statusMatches && r.eventSequenceLengthMatches && r.integrityDigestMatches && r.preValid && r.postValid) };
}

async function compareAssurance(enterprise, preStores, postStores, fixture) {
  const expected = fixture.record.assurance;
  const [preAssessment, postAssessment] = await Promise.all([
    preStores.assurance.getAssessment(SYSTEM_CONTEXT, expected.assessmentId),
    postStores.assurance.getAssessment(SYSTEM_CONTEXT, expected.assessmentId),
  ]);
  const [preFindings, postFindings] = await Promise.all([
    preStores.assurance.listFindings(SYSTEM_CONTEXT, expected.assessmentId),
    postStores.assurance.listFindings(SYSTEM_CONTEXT, expected.assessmentId),
  ]);
  const [preVerify, postVerify] = await Promise.all([
    preStores.assurance.verifyAssessment(SYSTEM_CONTEXT, expected.assessmentId),
    postStores.assurance.verifyAssessment(SYSTEM_CONTEXT, expected.assessmentId),
  ]);

  const preFindingIds = preFindings.map((f) => f.findingId).sort();
  const postFindingIds = postFindings.map((f) => f.findingId).sort();
  const preEligibility = (preAssessment?.eligibility ?? []).map((e) => `${e.profileId}:${e.eligible}`).sort();
  const postEligibility = (postAssessment?.eligibility ?? []).map((e) => `${e.profileId}:${e.eligible}`).sort();

  const result = {
    assessmentId: expected.assessmentId,
    scoreMatches: preAssessment?.score.normalizedScore === postAssessment?.score.normalizedScore && postAssessment?.score.normalizedScore === expected.normalizedScore,
    findingIdsMatch: JSON.stringify(preFindingIds) === JSON.stringify(postFindingIds) && postFindingIds.length === expected.findingCount,
    eligibilityMatches: JSON.stringify(preEligibility) === JSON.stringify(postEligibility),
    assessmentDigestMatches: preAssessment?.integrity.assessmentDigest === postAssessment?.integrity.assessmentDigest && postAssessment?.integrity.assessmentDigest === expected.assessmentDigest,
    preValid: preVerify.valid,
    postValid: postVerify.valid,
  };
  return { case: result, equivalent: result.scoreMatches && result.findingIdsMatch && result.eligibilityMatches && result.assessmentDigestMatches && result.preValid && result.postValid };
}

/**
 * Compares the restored authority world against the original by *deciding*
 * with both.
 *
 * Row equality is checked too (record digests), but the load-bearing assertion
 * is the decision matrix: the same request must be allowed before and after,
 * the revoked credential must stay denied before and after, and the external
 * principal must still resolve to the same actor. Those are the three
 * properties a disaster recovery actually has to preserve.
 */
async function compareKernelAuthority(enterprise, preStores, postStores, fixture) {
  const kernelModule = await import(resolve(new URL('../..', import.meta.url).pathname, 'dist/src/kernel/index.js'));
  const expected = fixture.record.kernelAuthority;
  const context = { system: true };

  async function inspect(store) {
    const records = await store.listRecords(context, { organizationId: expected.organizationId });
    const providers = await enterprise.createDurableKernelProviders({ store, organizationId: expected.organizationId });
    const kernel = kernelModule.createAocKernel({
      recognitionProvider: providers.recognitionProvider,
      clock: providers.clock,
      idGenerator: providers.idGenerator,
    });

    const evaluate = async (requestId, capabilityTokenId) => {
      const decision = await kernel.evaluate({
        requestId,
        actor: { id: expected.agentActorId, principalId: expected.ownerActorId, trustDomainId: expected.trustDomainId, type: 'agent' },
        action: { type: expected.action, resourceScope: expected.resourceScope, capability: expected.capability },
        organization: { id: expected.organizationId },
        requestedAt: fixture.generatedAt,
        ...(capabilityTokenId !== undefined ? { context: { capabilityTokenId } } : {}),
      });
      return decision.status;
    };

    const externalActor = await store.findActorByExternalSubject(context, expected.organizationId, expected.externalSubject);

    return {
      recordDigests: records.map((entry) => `${entry.entityKind}:${entry.entityId}:${entry.status}:${entry.latestEventDigest}`).sort(),
      allowedDecision: await evaluate('portability-authority-allowed'),
      revokedDecision: await evaluate('portability-authority-revoked', expected.revokedCapabilityTokenId),
      externalSubjectActorId: externalActor?.entityId ?? null,
    };
  }

  const pre = await inspect(preStores.kernelAuthority);
  const post = await inspect(postStores.kernelAuthority);

  const result = {
    organizationId: expected.organizationId,
    recordDigestsMatch: JSON.stringify(pre.recordDigests) === JSON.stringify(post.recordDigests) && JSON.stringify(post.recordDigests) === JSON.stringify(expected.recordDigests),
    recordCountMatches: post.recordDigests.length === expected.recordCount,
    allowedSurvivesRestore: pre.allowedDecision === 'allowed' && post.allowedDecision === 'allowed',
    revocationSurvivesRestore: pre.revokedDecision === 'denied' && post.revokedDecision === 'denied',
    externalSubjectBindingMatches: pre.externalSubjectActorId === post.externalSubjectActorId && post.externalSubjectActorId === expected.ownerActorId,
    preDecisions: { allowed: pre.allowedDecision, revoked: pre.revokedDecision },
    postDecisions: { allowed: post.allowedDecision, revoked: post.revokedDecision },
  };

  return {
    case: result,
    equivalent:
      result.recordDigestsMatch &&
      result.recordCountMatches &&
      result.allowedSurvivesRestore &&
      result.revocationSurvivesRestore &&
      result.externalSubjectBindingMatches,
  };
}

export async function comparePortabilityState({ pre, post, fixture }) {
  const enterprise = await loadEnterpriseModule();
  const fixtureData = JSON.parse(readFileSync(resolve(fixture), 'utf8'));

  const preStores = await openStores(enterprise, resolve(pre));
  const postStores = await openStores(enterprise, resolve(post));

  try {
    const governance = await compareGovernance(enterprise, preStores, postStores, fixtureData);
    const evidence = await compareEvidence(enterprise, preStores, postStores, fixtureData);
    const passport = await comparePassport(enterprise, preStores, postStores, fixtureData);
    const assurance = await compareAssurance(enterprise, preStores, postStores, fixtureData);
    const kernelAuthority = await compareKernelAuthority(enterprise, preStores, postStores, fixtureData);

    const comparison = {
      comparedAt: fixtureData.generatedAt,
      fixtureVersion: fixtureData.fixtureVersion,
      governance,
      evidence,
      passport,
      assurance,
      kernelAuthority,
      overallEquivalent: governance.equivalent && evidence.equivalent && passport.equivalent && assurance.equivalent && kernelAuthority.equivalent,
    };
    return comparison;
  } finally {
    await closeStores(preStores);
    await closeStores(postStores);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comparison = await comparePortabilityState(args);
  if (args.output) writeFileSync(resolve(args.output), stableJsonStringify(comparison));
  console.log(JSON.stringify(comparison, null, 2));
  if (!comparison.overallEquivalent) {
    console.error('[compare:portability:v1] Pre/post state is NOT logically equivalent.');
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    console.error(`[compare:portability:v1] ${error.message}`);
    process.exitCode = 1;
  });
}
