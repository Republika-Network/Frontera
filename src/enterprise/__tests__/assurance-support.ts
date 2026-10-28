import { createAssuranceFrameworkRegistry, type AssuranceFrameworkRegistry } from '../assurance/framework-registry.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { createAssuranceService, type AssuranceService } from '../assurance/service.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import type { AssuranceEvidenceSources } from '../assurance/evidence-resolver.js';
import type { AssuranceReviewerCredential } from '../assurance/reviewer-identity.js';
import type {
  AssuranceAccessContext,
  AssuranceEvidenceReference,
  AssuranceFramework,
  AssuranceScope,
  AssuranceSubject,
} from '../assurance/contracts.js';

/** Deterministic ticking clock: strictly increasing ISO timestamps from a fixed epoch. */
export function buildAssuranceClock(startTick = 0): () => string {
  let tick = startTick;
  return () => new Date(Date.UTC(2026, 5, 1, 0, 0, 0, tick++)).toISOString();
}

export function buildAssuranceIdGenerator(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => `${prefix}-${(counter += 1)}`;
}

export const ASSURANCE_ORG = { organizationId: 'org-1', system: false } as const;
export const ASSURANCE_ORG_2 = { organizationId: 'org-2', system: false } as const;
export const ASSURANCE_SYSTEM = { system: true } as const;

export const ASSURANCE_CUTOFF = '2026-06-15T00:00:00.000Z';

/**
 * ASSURE-SEC-01B: synthetic Assurance reviewer credentials (test-only
 * secrets). Identity, tenant and roles come from here, never from a review body.
 */
export const TEST_REVIEWERS: readonly AssuranceReviewerCredential[] = [
  { reviewerId: 'human-1', organizationId: 'org-1', roles: ['reviewer'], key: 'test-only-assurance-reviewer-secret-human-1' },
  { reviewerId: 'reviewer-1', organizationId: 'org-1', roles: ['assure.reviewer', 'assurance-reviewer'], key: 'test-only-assurance-reviewer-secret-reviewer-1' },
  { reviewerId: 'reviewer-2', organizationId: 'org-1', roles: ['assure.reviewer'], key: 'test-only-assurance-reviewer-secret-reviewer-2' },
  { reviewerId: 'intern-1', organizationId: 'org-1', roles: ['intern'], key: 'test-only-assurance-reviewer-secret-intern-1' },
  { reviewerId: 'reviewer-org-2', organizationId: 'org-2', roles: ['assure.reviewer', 'reviewer'], key: 'test-only-assurance-reviewer-secret-org-2' },
];

export function testReviewerSecret(reviewerId: string): string {
  const credential = TEST_REVIEWERS.find((candidate) => candidate.reviewerId === reviewerId);
  if (credential === undefined) throw new Error(`No test reviewer '${reviewerId}'.`);
  return credential.key;
}

/** The access context an authenticated reviewer acts under: the principal comes from the service's own authenticator. */
export function reviewerContext(harness: AssuranceTestHarness, reviewerId = 'reviewer-1'): AssuranceAccessContext {
  const reviewer = harness.service.authenticateReviewer(testReviewerSecret(reviewerId));
  if (reviewer === undefined) throw new Error(`Test reviewer '${reviewerId}' is not configured on this harness.`);
  return { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
}

/**
 * A small, fully valid test framework exercising every criteria kind:
 * boolean, threshold, evidence presence, composite, and manual review, plus
 * an agent-only applicability rule and one blocking control.
 */
export function buildTestFramework(overrides: Partial<AssuranceFramework> = {}): AssuranceFramework {
  const framework: AssuranceFramework = {
    frameworkId: 'test.framework',
    frameworkVersion: '1.0.0',
    name: 'Test Assurance Framework',
    description: 'Deterministic test framework covering every criteria kind.',
    issuer: 'test-suite',
    issuedAt: '2026-06-01T00:00:00.000Z',
    status: 'active',
    domains: [
      {
        domainId: 'd.core',
        name: 'Core',
        description: 'Boolean/threshold controls.',
        controlIds: ['c.bool', 'c.threshold'],
        weight: 0.6,
        minimumScore: 40,
        blockingControlIds: ['c.bool'],
      },
      {
        domainId: 'd.review',
        name: 'Review',
        description: 'Evidence presence, manual review, and agent-only controls.',
        controlIds: ['c.presence', 'c.manual', 'c.agent-only'],
        weight: 0.4,
      },
    ],
    controls: [
      {
        controlId: 'c.bool',
        frameworkId: 'test.framework',
        frameworkVersion: '1.0.0',
        domainId: 'd.core',
        title: 'Boolean control',
        description: 'metric test.bool must be true',
        objective: 'Demonstrate the boolean condition holds.',
        controlType: 'preventive',
        criticality: 'mandatory',
        evaluationMethod: 'boolean',
        evidenceRequirementIds: ['req.attest'],
        criteria: { type: 'boolean', metric: 'test.bool', expected: true },
        scoring: { weight: 2, maximumScore: 100 },
        severityMapping: { fail: 'critical' },
        remediationGuidance: 'Make test.bool true.',
      },
      {
        controlId: 'c.threshold',
        frameworkId: 'test.framework',
        frameworkVersion: '1.0.0',
        domainId: 'd.core',
        title: 'Threshold control',
        description: 'metric test.count must be >= 2',
        objective: 'Demonstrate the count threshold holds.',
        controlType: 'detective',
        criticality: 'recommended',
        evaluationMethod: 'threshold',
        evidenceRequirementIds: ['req.attest'],
        criteria: { type: 'threshold', metric: 'test.count', operator: 'gte', value: 2 },
        scoring: { weight: 1, maximumScore: 100 },
      },
      {
        controlId: 'c.presence',
        frameworkId: 'test.framework',
        frameworkVersion: '1.0.0',
        domainId: 'd.review',
        title: 'Evidence presence control',
        description: 'req.attest must be satisfied',
        objective: 'Demonstrate attested evidence exists.',
        controlType: 'evidence',
        criticality: 'mandatory',
        evaluationMethod: 'evidence_presence',
        evidenceRequirementIds: ['req.attest'],
        criteria: { type: 'evidence_presence', requirementIds: ['req.attest'], minimumSatisfied: 1, allMandatory: true },
        scoring: { weight: 1, maximumScore: 100 },
      },
      {
        controlId: 'c.manual',
        frameworkId: 'test.framework',
        frameworkVersion: '1.0.0',
        domainId: 'd.review',
        title: 'Manual review control',
        description: 'requires an attributable human review',
        objective: 'Preserve the human-review discipline.',
        controlType: 'governance',
        criticality: 'recommended',
        evaluationMethod: 'manual_review',
        evidenceRequirementIds: ['req.attest'],
        criteria: {
          type: 'manual_review',
          questions: ['Did the subject operate within scope?'],
          requiredReviewerRole: 'reviewer',
          requiredEvidenceRequirementIds: ['req.attest'],
        },
        scoring: { weight: 1, maximumScore: 100 },
      },
      {
        controlId: 'c.agent-only',
        frameworkId: 'test.framework',
        frameworkVersion: '1.0.0',
        domainId: 'd.review',
        title: 'Agent-only control',
        description: 'applies only to agent subjects',
        objective: 'Demonstrate framework-defined applicability.',
        controlType: 'governance',
        criticality: 'optional',
        evaluationMethod: 'boolean',
        evidenceRequirementIds: ['req.attest'],
        criteria: { type: 'boolean', metric: 'test.agent', expected: true },
        scoring: { weight: 1, maximumScore: 100 },
        applicability: { subjectTypes: ['agent', 'passport'], justification: 'Applies to agent subjects only.' },
      },
    ],
    evidenceRequirements: [
      {
        requirementId: 'req.attest',
        description: 'A control attestation supporting the test controls.',
        acceptedEvidenceTypes: ['control_attestation'],
        minimumCount: 1,
        manualEvidenceAllowed: true,
        contradictionPolicy: 'manual_review',
      },
    ],
    scoringModel: {
      methodologyId: 'test.scoring',
      methodologyVersion: '1.0.0',
      statusScores: { pass: 1, partial: 0.5, fail: 0, unknown: null, not_applicable: null, manual_review_required: null },
      domainWeights: {},
      controlWeights: {},
      unknownPolicy: 'zero',
      manualReviewPolicy: 'provisional',
      blockingRule: 'both',
    },
    eligibilityProfiles: [
      {
        profileId: 'baseline',
        name: 'Baseline',
        minimumOverallScore: 50,
        prohibitedOpenSeverities: ['critical'],
        manualReviewRequired: false,
      },
      {
        profileId: 'strict',
        name: 'Strict',
        minimumOverallScore: 90,
        minimumDomainScores: { 'd.core': 90 },
        mandatoryControlIds: ['c.bool'],
        prohibitedOpenSeverities: ['critical', 'high'],
        minimumVerifiedEvidenceRate: 0.5,
        manualReviewRequired: false,
      },
    ],
    ...overrides,
  };
  // Keep every control bound to the framework's (possibly overridden) identity.
  return {
    ...framework,
    controls: framework.controls.map((control) => ({ ...control, frameworkId: framework.frameworkId, frameworkVersion: framework.frameworkVersion })),
  };
}

export function buildTestSubject(overrides: Partial<AssuranceSubject> = {}): AssuranceSubject {
  return {
    subjectType: 'agent',
    subjectId: 'agent-under-test',
    organizationId: 'org-1',
    displayName: 'Agent Under Test',
    ...overrides,
  };
}

export function buildTestScope(overrides: Partial<AssuranceScope> = {}): AssuranceScope {
  return {
    scopeId: 'scope-1',
    subject: buildTestSubject(),
    frameworkId: 'test.framework',
    frameworkVersion: '1.0.0',
    evidenceCutoffAt: ASSURANCE_CUTOFF,
    includeHistoricalEvidence: true,
    requestedBy: 'assessor-1',
    requestedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

let attestationCounter = 0;

/** A verified `control_attestation` evidence reference asserting one metric value. */
export function buildAttestation(
  metric: string,
  value: number | boolean,
  overrides: Partial<AssuranceEvidenceReference> = {},
): AssuranceEvidenceReference {
  attestationCounter += 1;
  return {
    evidenceReferenceId: `attest-${attestationCounter}`,
    evidenceType: 'control_attestation',
    externalId: `attestation-${metric}-${attestationCounter}`,
    organizationId: 'org-1',
    subjectId: 'agent-under-test',
    digest: `sha256:${'0'.repeat(63)}${attestationCounter % 10}`,
    occurredAt: '2026-06-10T00:00:00.000Z',
    collectedAt: '2026-06-14T00:00:00.000Z',
    verified: true,
    provenance: {
      sourceSystem: 'test-suite',
      sourceType: 'control_attestation',
      collectedBy: 'assessor-1',
      collectedAt: '2026-06-14T00:00:00.000Z',
    },
    metadata: { metric, value },
    ...overrides,
  };
}

export interface AssuranceTestHarness {
  readonly service: AssuranceService;
  readonly store: AssuranceStore;
  readonly registry: AssuranceFrameworkRegistry;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

/** A service over the in-memory store with the test framework registered and no external evidence sources beyond manual attestations. */
export function buildAssuranceHarness(
  options: { framework?: AssuranceFramework; sources?: AssuranceEvidenceSources; store?: AssuranceStore; reviewers?: readonly AssuranceReviewerCredential[] } = {},
): AssuranceTestHarness {
  const now = buildAssuranceClock();
  const nextId = buildAssuranceIdGenerator();
  const framework = options.framework ?? buildTestFramework();
  const registry = createAssuranceFrameworkRegistry();
  registry.register(framework);
  const store = options.store ?? createInMemoryAssuranceStore({ now });
  const service = createAssuranceService({
    store,
    registry,
    evidenceSources: options.sources ?? {},
    now,
    nextId,
    enterpriseVersion: 'test-1.0.0',
    moduleSnapshot: () => [{ moduleId: 'test.module', version: '1.0.0', status: 'ready' }],
    reviewers: options.reviewers ?? TEST_REVIEWERS,
  });
  return { service, store, registry, now, nextId };
}

/** Seeds the harness store with the framework definition (system scope) so store-level verification can resolve it. */
export async function persistHarnessFramework(harness: AssuranceTestHarness, framework?: AssuranceFramework): Promise<void> {
  await harness.store.saveFramework(ASSURANCE_SYSTEM, framework ?? buildTestFramework());
}
