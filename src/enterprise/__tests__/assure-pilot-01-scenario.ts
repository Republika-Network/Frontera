import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createAssuranceService, type AssuranceService, type RecordManualReviewInput } from '../assurance/service.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import { createAssuranceFrameworkRegistry, type AssuranceFrameworkRegistry } from '../assurance/framework-registry.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION, RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { COMMERCIAL_REPORT_RELEASE_ROLE, type CommercialEngagementDeclaration, type CommercialReportDraft, type CommercialReportRelease } from '../assurance/commercial-report.js';
import { computeDigest } from '../governance-store/digest.js';
import { createInProcessEventPublisher, type EnterpriseEvent } from '../events/enterprise-events.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import type { AssuranceReviewerCredential } from '../assurance/reviewer-identity.js';
import type { AssuranceAccessContext, AssuranceAssessment, AssuranceEvidenceReference, AssuranceManualReviewOutcome } from '../assurance/contracts.js';

/**
 * ASSURE-PILOT-01 -- the synthetic commercial dry run, as a reusable scenario.
 *
 * Drives the real Assurance service over a temporary SQLite store: a fictional
 * cooperative and platform, synthetic evidence and five separate identities.
 * Reviewer and approver secrets are random per process, held in memory only
 * and never written. Supplier- and reviewer-controlled text carries a planted
 * marker that must never reach the delivery package.
 *
 * Used by `assure-pilot-01-commercial-dry-run.test.ts` and by
 * `scripts/assurance/run-pilot-01-dry-run.mjs`. See
 * docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md.
 */

export const PILOT_ORG = 'pilot-org-synthetic';
export const PILOT_OTHER_ORG = 'pilot-org-other-synthetic';
export const PILOT_SUBJECT = 'pilot-ledger-system';
export const PILOT_MARKER = 'PILOT01-PLANTED-MARKER';
export const PILOT_CUTOFF = '2026-10-27T00:00:00.000Z';
export const PILOT_ISSUE = { issuedOn: '2026-10-28', reportVersion: '1.0' } as const;
export const PILOT_CONTROLS = ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-10'] as const;
export const pilotRequirementId = (controlId: string): string => `rn.sv.req.${controlId.toLowerCase()}`;
export const pilotEvidenceId = (id: string): string => `pilot-${id}-${PILOT_MARKER}`;

export const PILOT_ORG_CONTEXT: AssuranceAccessContext = { organizationId: PILOT_ORG, system: false };
export const PILOT_OTHER_ORG_CONTEXT: AssuranceAccessContext = { organizationId: PILOT_OTHER_ORG, system: false };
export const PILOT_SYSTEM_CONTEXT: AssuranceAccessContext = { system: true };

export const PILOT_ENGAGEMENT: CommercialEngagementDeclaration = {
  organizationName: 'Cooperativa Andina de Servicios Digitales (fictional)',
  systemName: 'Pilot Ledger Member Platform (fictional)',
  systemDescription: 'A synthetic platform invented for the ASSURE-PILOT-01 commercial dry run. It does not exist and no real organization was assessed.',
  purpose: 'Commercial dry run of a Founding Assessment; synthetic data only, not an audit.',
  inScope: ['Member consent service', 'Decision and execution pipeline', 'Tenant data partitioning'],
  exclusions: ['Payment processor internals (third party)', 'End-user devices', 'Physical security'],
  dependencies: ['Managed identity provider operated by a third party'],
  accessLimitations: ['Evidence was supplied by the assessed organization; no production access was granted.'],
  confidentiality: 'CONFIDENTIAL',
};

export type PilotIdentity = 'preparer' | 'contributor' | 'reviewer' | 'approver' | 'otherReviewer' | 'otherApprover';

const secret = (): string => `pilot-${randomBytes(24).toString('hex')}`;

/** Separate identities; only the reviewer and the approver hold Assurance roles. The independent verifier holds none. */
export const PILOT_CREDENTIALS: Readonly<Record<PilotIdentity, AssuranceReviewerCredential>> = {
  preparer: { reviewerId: 'pilot-preparer', organizationId: PILOT_ORG, roles: ['assure.preparer'], key: secret() },
  contributor: { reviewerId: 'pilot-evidence-contributor', organizationId: PILOT_ORG, roles: ['assure.evidence-contributor'], key: secret() },
  reviewer: { reviewerId: 'pilot-reviewer', organizationId: PILOT_ORG, roles: [RN_SV_REVIEWER_ROLE], key: secret() },
  approver: { reviewerId: 'pilot-approver', organizationId: PILOT_ORG, roles: [COMMERCIAL_REPORT_RELEASE_ROLE], key: secret() },
  otherReviewer: { reviewerId: 'other-reviewer', organizationId: PILOT_OTHER_ORG, roles: [RN_SV_REVIEWER_ROLE], key: secret() },
  otherApprover: { reviewerId: 'other-approver', organizationId: PILOT_OTHER_ORG, roles: [COMMERCIAL_REPORT_RELEASE_ROLE], key: secret() },
};

export interface PilotWorld {
  readonly dbPath: string;
  readonly store: AssuranceStore;
  readonly registry: AssuranceFrameworkRegistry;
  readonly service: AssuranceService;
  /** Every enterprise event the service published, in order. */
  readonly events: EnterpriseEvent[];
}

/**
 * A service over a SQLite store at `dbPath` with rn.sv@0.1.0 and aoc.saf
 * registered. The clock and id counter start at `startTick`/`startId`, so a
 * world opened over a copy of another store continues after it.
 */
export async function buildPilotWorld(dbPath: string, options: { readonly startTick?: number; readonly startId?: number } = {}): Promise<PilotWorld> {
  let tick = options.startTick ?? 0;
  const now = (): string => new Date(Date.UTC(2026, 9, 28, 9, 0, 0, tick++)).toISOString();
  let counter = options.startId ?? 0;
  const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  const store = await createSqliteAssuranceStore(dbPath, { now });
  const registry = createAssuranceFrameworkRegistry();
  registry.register(RN_SV_FRAMEWORK_V0_1);
  registry.register(AOC_SAF_FRAMEWORK_V1);
  const events: EnterpriseEvent[] = [];
  const eventPublisher = createInProcessEventPublisher();
  eventPublisher.subscribe((event) => events.push(event));
  const service = createAssuranceService({
    store,
    registry,
    evidenceSources: {},
    now,
    nextId,
    eventPublisher,
    enterpriseVersion: 'assure-pilot-01',
    moduleSnapshot: () => [{ moduleId: 'assurance', version: '0.1.0', status: 'ready' }],
    reviewers: Object.values(PILOT_CREDENTIALS),
  });
  return { dbPath, store, registry, service, events };
}

/** The access context of an authenticated identity: the principal comes from the service's own authenticator. */
export function pilotContext(world: PilotWorld, identity: PilotIdentity): AssuranceAccessContext {
  const reviewer = world.service.authenticateReviewer(PILOT_CREDENTIALS[identity].key);
  if (reviewer === undefined) throw new Error(`Pilot identity '${identity}' is not configured.`);
  return { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
}

/** A consistent snapshot of the world's store (it runs in WAL mode: a file copy would miss the log). */
export async function snapshotPilotStore(world: PilotWorld, path: string): Promise<void> {
  const raw = new Database(world.dbPath);
  try {
    await raw.backup(path);
  } finally {
    raw.close();
  }
}

/** A new world over a snapshot of `world`'s store, optionally altered first at the storage level. */
export async function copyPilotWorld(world: PilotWorld, path: string, alter?: (raw: Database.Database) => void): Promise<PilotWorld> {
  await snapshotPilotStore(world, path);
  if (alter !== undefined) {
    const raw = new Database(path);
    try {
      alter(raw);
    } finally {
      raw.close();
    }
  }
  return buildPilotWorld(path, { startTick: 1_000_000, startId: 100_000 });
}

// ---------------------------------------------------------------------------
// Synthetic evidence
// ---------------------------------------------------------------------------

export function pilotArtifact(id: string, controlId: string, overrides: Partial<AssuranceEvidenceReference> = {}): AssuranceEvidenceReference {
  return {
    evidenceReferenceId: pilotEvidenceId(id),
    evidenceType: 'external_artifact_reference',
    externalId: `https://internal.pilot-coop.invalid/${id}?token=${PILOT_MARKER}`,
    organizationId: PILOT_ORG,
    subjectId: PILOT_SUBJECT,
    digest: computeDigest({ pilot01: id }),
    occurredAt: '2026-10-20T00:00:00.000Z',
    collectedAt: '2026-10-25T00:00:00.000Z',
    verified: false,
    requirementIds: [pilotRequirementId(controlId)],
    provenance: { sourceSystem: `pilot ${PILOT_MARKER}`, sourceType: 'external_artifact_reference', collectedBy: PILOT_CREDENTIALS.contributor.reviewerId, collectedAt: '2026-10-25T00:00:00.000Z' },
    metadata: { note: `${PILOT_MARKER} contributor note; password=PilotSynthetic123` },
    ...overrides,
  };
}

/**
 * The delivered assessment's evidence: one bound artifact per control plus the
 * adversarial references -- a self-verification claim (SV-04), another
 * tenant's artifact (SV-05), a post-cutoff artifact (SV-07, its only one), a
 * reserved Host metric (SV-09) and a reference naming no requirement (SV-10,
 * its only one).
 */
export function pilotEvidence(): AssuranceEvidenceReference[] {
  const { requirementIds: _unbound, ...unbound } = pilotArtifact('sv10-unbound', 'SV-10');
  return [
    pilotArtifact('sv01-attest', 'SV-01', {
      evidenceType: 'control_attestation',
      provenance: { sourceSystem: 'pilot', sourceType: 'control_attestation', collectedBy: PILOT_CREDENTIALS.contributor.reviewerId, collectedAt: '2026-10-25T00:00:00.000Z' },
      metadata: { metric: 'pilot.sv01.inventory_reviewed', value: true },
    }),
    pilotArtifact('sv02', 'SV-02'),
    pilotArtifact('sv03', 'SV-03'),
    pilotArtifact('sv04-selfverified', 'SV-04', { verified: true, verificationReference: `https://verifier.pilot-coop.invalid/${PILOT_MARKER}` }),
    pilotArtifact('sv05', 'SV-05'),
    pilotArtifact('sv05-foreign', 'SV-05', { organizationId: PILOT_OTHER_ORG, digest: computeDigest({ pilot01: 'sv05-foreign' }) }),
    pilotArtifact('sv06', 'SV-06'),
    pilotArtifact('sv07-late', 'SV-07', { occurredAt: '2026-10-27T12:00:00.000Z' }),
    pilotArtifact('sv08', 'SV-08'),
    pilotArtifact('sv09', 'SV-09'),
    pilotArtifact('sv09-reserved-metric', 'SV-09', { evidenceType: 'control_attestation', metadata: { metric: 'governance.pass_rate', value: 1 }, digest: computeDigest({ pilot01: 'sv09-reserved' }) }),
    unbound,
  ];
}

/** Two references to the same artifact with different digests: a contradiction on SV-08 (used on a separate assessment). */
export function pilotContradictoryEvidence(subjectId: string): AssuranceEvidenceReference[] {
  return [
    pilotArtifact('sv08-a', 'SV-08', { subjectId, externalId: 'https://internal.pilot-coop.invalid/sv08-runbook', digest: computeDigest({ pilot01: 'sv08', copy: 'a' }) }),
    pilotArtifact('sv08-b', 'SV-08', { subjectId, externalId: 'https://internal.pilot-coop.invalid/sv08-runbook', digest: computeDigest({ pilot01: 'sv08', copy: 'b' }) }),
  ];
}

export function pilotReviewInput(assessmentId: string, controlId: string, outcome: AssuranceManualReviewOutcome, evidence?: readonly string[]): RecordManualReviewInput {
  return {
    assessmentId,
    controlId,
    reviewerRole: RN_SV_REVIEWER_ROLE,
    outcome,
    // Reviewer free text is never reproduced in the commercial report.
    rationale: `${PILOT_MARKER} reviewer rationale (never disclosed).`,
    ...(evidence !== undefined ? { evidenceReferenceIds: evidence.map(pilotEvidenceId) } : {}),
  };
}

/** Each control's authenticated review: an outcome and the bound evidence it rests on. */
export const PILOT_REVIEW_PLAN: Readonly<Record<string, readonly [AssuranceManualReviewOutcome, (readonly string[])?]>> = {
  'SV-01': ['pass', ['sv01-attest']],
  'SV-02': ['pass', ['sv02']],
  'SV-03': ['partial', ['sv03']],
  'SV-04': ['pass', ['sv04-selfverified']],
  'SV-05': ['pass', ['sv05']],
  'SV-06': ['fail', ['sv06']],
  'SV-07': ['insufficient_evidence'],
  'SV-08': ['pass', ['sv08']],
  'SV-09': ['partial', ['sv09']],
  'SV-10': ['insufficient_evidence'],
};

export const PILOT_EXPECTED_STATUSES: Readonly<Record<string, string>> = {
  'SV-01': 'pass',
  'SV-02': 'pass',
  'SV-03': 'partial',
  'SV-04': 'pass',
  'SV-05': 'pass',
  'SV-06': 'fail',
  'SV-07': 'unknown',
  'SV-08': 'pass',
  'SV-09': 'partial',
  'SV-10': 'unknown',
};

/** Creates the assessment, offers the synthetic evidence and evaluates it (pending manual review). */
export async function preparePilotAssessment(world: PilotWorld): Promise<AssuranceAssessment> {
  const created = await world.service.createAssessment(PILOT_ORG_CONTEXT, {
    subject: { subjectType: 'system', subjectId: PILOT_SUBJECT, organizationId: PILOT_ORG, displayName: 'Pilot Ledger (fictional)' },
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    requestedBy: PILOT_CREDENTIALS.preparer.reviewerId,
    evidenceCutoffAt: PILOT_CUTOFF,
    purpose: 'ASSURE-PILOT-01 synthetic dry run',
  });
  await world.service.collectEvidence(PILOT_ORG_CONTEXT, created.assessmentId, { manualEvidence: pilotEvidence() });
  return world.service.evaluateAssessment(PILOT_ORG_CONTEXT, created.assessmentId);
}

/** Records the plan's ten authenticated reviews and re-evaluates. */
export async function reviewPilotAssessment(world: PilotWorld, assessmentId: string): Promise<AssuranceAssessment> {
  const reviewer = pilotContext(world, 'reviewer');
  for (const controlId of PILOT_CONTROLS) {
    const planned: readonly [AssuranceManualReviewOutcome, (readonly string[])?] = PILOT_REVIEW_PLAN[controlId] ?? ['insufficient_evidence'];
    const [outcome, evidence] = planned;
    await world.service.recordManualReview(reviewer, pilotReviewInput(assessmentId, controlId, outcome, evidence));
  }
  return world.service.evaluateAssessment(PILOT_ORG_CONTEXT, assessmentId);
}

export const PILOT_ACKNOWLEDGEMENTS = { limitationsReviewed: true, commercialUseRestrictionAcknowledged: true } as const;

/** Drafts the report as the preparer and releases it as the approver, approving the exact draft digest. */
export async function releasePilotReport(world: PilotWorld, assessmentId: string): Promise<{ readonly draft: CommercialReportDraft; readonly release: CommercialReportRelease }> {
  const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
  return world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, {
    engagement: PILOT_ENGAGEMENT,
    issue: PILOT_ISSUE,
    approvedContentDigest: draft.manifest.contentDigest,
    acknowledgements: PILOT_ACKNOWLEDGEMENTS,
  });
}

/** The whole flow without adversarial steps: prepare, review, complete, draft, release. */
export async function runPilotHappyPath(world: PilotWorld): Promise<{ readonly assessment: AssuranceAssessment; readonly draft: CommercialReportDraft; readonly release: CommercialReportRelease }> {
  const prepared = await preparePilotAssessment(world);
  await reviewPilotAssessment(world, prepared.assessmentId);
  const assessment = await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
  const { draft, release } = await releasePilotReport(world, prepared.assessmentId);
  return { assessment, draft, release };
}

// ---------------------------------------------------------------------------
// Delivery package
// ---------------------------------------------------------------------------

export const PILOT_PACKAGE_FILES = ['integrity-manifest.json', 'limitations.md', 'release-record.json', 'report.json', 'report.md', 'verification-instructions.md'] as const;

/** Must equal `limitationsExtract` in scripts/assurance/verify-commercial-package.mjs, which regenerates and compares it. */
export function pilotLimitationsExtract(content: CommercialReportDraft['content']): string {
  return `# Limitations — ${content.reportId}\n\nExtracted from report.json \`limitations\`; report.json is authoritative. This file is not separately digested.\n\n${content.limitations.map((line) => `- ${line}`).join('\n')}\n`;
}

const VERIFICATION_INSTRUCTIONS = `# How to verify this report package

SYNTHETIC DRY RUN (ASSURE-PILOT-01). Every organization, system and piece of
evidence in this package is fictional. This is not an audit and not a
certification.

- report.md: SHA-256 of its exact bytes (LF line endings) is \`markdownDigest\`. Copy it byte for byte; never re-save it.
- report.json: SHA-256 of its canonical JSON (aoc.canonical-json.v1) is \`contentDigest\`. Whitespace does not matter; values do.
- integrity-manifest.json: binds the assessment, the framework, \`contentDigest\` and \`markdownDigest\`; \`manifestDigest\` covers the rest of it.
- release-record.json: the human approval of those three digests; \`releaseDigest\` covers the rest of it.
- limitations.md: an extract of report.json \`limitations\`, not separately digested.
- This file: informational, covered by no digest.

Run: node scripts/assurance/verify-commercial-package.mjs <this directory>

A successful verification shows that the files are mutually consistent and
unchanged since the digests were computed. It does NOT show who produced them:
the digests are not a signature, and anyone who edits a file and recomputes
every digest produces a package that verifies. Confirm the digests with the
issuer over an independent channel.
`;

/** Writes the generator's and the approval's own output -- nothing composed by hand -- into `dir`. */
export function writePilotPackage(dir: string, draft: CommercialReportDraft, release: CommercialReportRelease): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), draft.markdown, 'utf8');
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(draft.content, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'integrity-manifest.json'), `${JSON.stringify(draft.manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'release-record.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'limitations.md'), pilotLimitationsExtract(draft.content), 'utf8');
  writeFileSync(join(dir, 'verification-instructions.md'), VERIFICATION_INSTRUCTIONS, 'utf8');
}
