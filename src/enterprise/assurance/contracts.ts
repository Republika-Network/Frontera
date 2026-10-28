/**
 * Canonical model of the Soberanía Enterprise Assurance Runtime v1 (PR-007).
 *
 * The Assurance Runtime evaluates whether a subject satisfies explicit,
 * versioned Assurance controls with sufficient, verified evidence -- and
 * nothing more. Core principle:
 *
 *   The Kernel evaluates whether an action may proceed.
 *   The Governance Store preserves what happened.
 *   Evidence Bundles disclose relevant proof.
 *   The Agent Passport identifies and contextualizes an agent across time.
 *   The Assurance Runtime evaluates whether defined controls are satisfied
 *   by sufficient evidence.
 *
 * It is NOT a certification authority, a statutory auditor, a legal
 * opinion, a universal trust score, or an opaque AI judgment engine. Every
 * result is framework-bound and scope-bound; every score carries its own
 * calculation trace; every conclusion is reconstructable.
 *
 * See `docs/enterprise/AOC_ASSURANCE_RUNTIME.md` and
 * `docs/architecture/ADR-ASSURANCE-RUNTIME.md`.
 */

export const AOC_ASSURANCE_RUNTIME_VERSION = '1.0.0';

export const ASSURANCE_STORE_SCHEMA_VERSION = 'aoc.assurance-store.schema.v1';

/** Deterministic engine identities, carried in provenance so a result can name exactly which evaluator/scorer produced it. */
export const ASSURANCE_EVALUATOR_VERSION = 'aoc.assurance-evaluator.v1';
export const ASSURANCE_RESOLVER_VERSION = 'aoc.assurance-evidence-resolver.v1';
export const ASSURANCE_SCORING_VERSION = 'aoc.assurance-scoring.v1';
export const ASSURANCE_ELIGIBILITY_VERSION = 'aoc.assurance-eligibility.v1';

export const ASSURANCE_CONTRACT_IDS = {
  framework: 'aoc.assurance.framework.v1',
  domain: 'aoc.assurance.domain.v1',
  control: 'aoc.assurance.control.v1',
  scope: 'aoc.assurance.scope.v1',
  evidenceReference: 'aoc.assurance.evidence-reference.v1',
  controlEvaluation: 'aoc.assurance.control-evaluation.v1',
  finding: 'aoc.assurance.finding.v1',
  domainAssessment: 'aoc.assurance.domain-assessment.v1',
  score: 'aoc.assurance.score.v1',
  eligibility: 'aoc.assurance.eligibility.v1',
  assessment: 'aoc.assurance.assessment.v1',
  signal: 'aoc.assurance.signal.v1',
  report: 'aoc.assurance.report.v1',
  verification: 'aoc.assurance.verification.v1',
} as const;

// ---------------------------------------------------------------------------
// Framework model
// ---------------------------------------------------------------------------

export type AssuranceFrameworkStatus = 'draft' | 'active' | 'deprecated' | 'retired';

/**
 * A versioned Assurance framework. `frameworkId` + `frameworkVersion` are
 * immutable once activated: changed controls, weights, or thresholds always
 * require a new framework version (mission section 2). Framework versions
 * are deliberately independent of `AOC_ASSURANCE_RUNTIME_VERSION` -- the
 * package can ship a fix without re-versioning every framework, and a
 * framework can revise without a package release.
 */
export interface AssuranceFramework {
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly name: string;
  readonly description: string;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly status: AssuranceFrameworkStatus;
  readonly domains: readonly AssuranceDomainDefinition[];
  readonly controls: readonly AssuranceControlDefinition[];
  readonly evidenceRequirements: readonly AssuranceEvidenceRequirement[];
  readonly scoringModel: AssuranceScoringModel;
  readonly eligibilityProfiles: readonly AssuranceEligibilityProfile[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AssuranceFrameworkSummary {
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly name: string;
  readonly status: AssuranceFrameworkStatus;
  readonly domainCount: number;
  readonly controlCount: number;
}

/**
 * One Assurance domain: a named grouping of controls with one weight in the
 * framework's overall score. `weight` uses the framework's single documented
 * scale (all domain weights must sum to 1, within floating-point tolerance
 * -- enforced by `validateAssuranceFramework`).
 */
export interface AssuranceDomainDefinition {
  readonly domainId: string;
  readonly name: string;
  readonly description: string;
  readonly controlIds: readonly string[];
  readonly weight: number;
  /** Normalized 0..100 threshold below which the domain is `unhealthy` regardless of other signals. */
  readonly minimumScore?: number;
  /** Controls whose `fail` overrides this domain's numeric average (mission section 30) -- averages never hide critical failures. */
  readonly blockingControlIds?: readonly string[];
  readonly tags?: readonly string[];
}

export type AssuranceControlType = 'preventive' | 'detective' | 'corrective' | 'governance' | 'evidence';

export type AssuranceControlCriticality = 'mandatory' | 'recommended' | 'optional';

export type AssuranceEvaluationMethod = 'boolean' | 'threshold' | 'composite' | 'evidence_presence' | 'manual_review';

/**
 * Structured applicability rule for `not_applicable` (mission section 62):
 * a control may be excluded only when the framework itself defines when,
 * with a structured justification -- callers can never mark controls N/A
 * freely.
 */
export interface AssuranceControlApplicability {
  /** Subject types this control applies to. A subject outside this list evaluates to `not_applicable` with a deterministic, rule-attributed justification. */
  readonly subjectTypes: readonly AssuranceSubjectType[];
  readonly justification: string;
}

export interface AssuranceControlDefinition {
  readonly controlId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly domainId: string;
  readonly title: string;
  readonly description: string;
  readonly objective: string;
  readonly controlType: AssuranceControlType;
  readonly criticality: AssuranceControlCriticality;
  readonly evaluationMethod: AssuranceEvaluationMethod;
  readonly evidenceRequirementIds: readonly string[];
  readonly criteria: AssuranceControlCriteria;
  readonly scoring: AssuranceControlScoring;
  readonly severityMapping?: AssuranceSeverityMapping;
  readonly remediationGuidance?: string;
  /** Framework-defined N/A rule (mission section 62). Absent means the control applies to every subject in scope. */
  readonly applicability?: AssuranceControlApplicability;
  readonly tags?: readonly string[];
}

/** Per-control scoring parameters. `weight` uses the framework's documented scale (relative weights within one domain). */
export interface AssuranceControlScoring {
  readonly weight: number;
  readonly maximumScore: number;
}

/** Framework-defined severity per failed/degraded status (mission section 23) -- severity is rule-based, never arbitrarily assigned. */
export type AssuranceSeverityMapping = Readonly<Partial<Record<AssuranceControlStatus, AssuranceFindingSeverity>>>;

// ---------------------------------------------------------------------------
// Control criteria (discriminated union; never executable code)
// ---------------------------------------------------------------------------

export interface AssuranceBooleanCriteria {
  readonly type: 'boolean';
  readonly expected: boolean;
  readonly metric: string;
}

export type AssuranceThresholdOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq';

export interface AssuranceThresholdCriteria {
  readonly type: 'threshold';
  readonly metric: string;
  readonly operator: AssuranceThresholdOperator;
  readonly value: number;
}

export interface AssuranceEvidencePresenceCriteria {
  readonly type: 'evidence_presence';
  readonly requirementIds: readonly string[];
  readonly minimumSatisfied: number;
  readonly allMandatory: boolean;
}

export type AssuranceCompositeOperator = 'all' | 'any' | 'minimum';

export interface AssuranceCompositeCriteria {
  readonly type: 'composite';
  readonly operator: AssuranceCompositeOperator;
  readonly minimum?: number;
  readonly criteria: readonly AssuranceControlCriteria[];
}

export interface AssuranceManualReviewCriteria {
  readonly type: 'manual_review';
  readonly questions: readonly string[];
  readonly requiredReviewerRole?: string;
  readonly requiredEvidenceRequirementIds?: readonly string[];
}

/**
 * The complete criteria vocabulary. Deliberately a closed data union --
 * framework definitions are data, never executable JavaScript (mission
 * section 76: no `eval`, no functions in framework payloads).
 */
export type AssuranceControlCriteria =
  | AssuranceBooleanCriteria
  | AssuranceThresholdCriteria
  | AssuranceCompositeCriteria
  | AssuranceEvidencePresenceCriteria
  | AssuranceManualReviewCriteria;

// ---------------------------------------------------------------------------
// Control statuses
// ---------------------------------------------------------------------------

/**
 * The six control statuses (mission section 7). `unknown` is never silently
 * converted to `fail`, and `manual_review_required` is never silently
 * converted to `pass` -- the framework's scoring model decides their
 * numeric impact explicitly (`unknownPolicy`/`manualReviewPolicy`).
 */
export type AssuranceControlStatus = 'pass' | 'partial' | 'fail' | 'unknown' | 'not_applicable' | 'manual_review_required';

export const ASSURANCE_CONTROL_STATUSES: readonly AssuranceControlStatus[] = [
  'pass',
  'partial',
  'fail',
  'unknown',
  'not_applicable',
  'manual_review_required',
];

// ---------------------------------------------------------------------------
// Subject and scope
// ---------------------------------------------------------------------------

export type AssuranceSubjectType = 'enterprise' | 'organization' | 'workspace' | 'agent' | 'passport' | 'system' | 'process' | 'solution';

export const ASSURANCE_SUBJECT_TYPES: readonly AssuranceSubjectType[] = [
  'enterprise',
  'organization',
  'workspace',
  'agent',
  'passport',
  'system',
  'process',
  'solution',
];

/** Exactly one primary subject per assessment (mission section 8). */
export interface AssuranceSubject {
  readonly subjectType: AssuranceSubjectType;
  readonly subjectId: string;
  readonly organizationId: string;
  readonly displayName?: string;
  readonly passportId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The immutable assessment scope (mission section 9). Once evaluation
 * begins the scope is frozen -- changing subject, controls, period,
 * framework, evidence cutoff, or purpose requires a NEW assessment.
 * `evidenceCutoffAt` is also the deterministic reference instant for every
 * evidence-age check, so re-running the same assessment inputs later
 * produces byte-identical results.
 */
export interface AssuranceScope {
  readonly scopeId: string;
  readonly subject: AssuranceSubject;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly domainIds?: readonly string[];
  readonly controlIds?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly evidenceCutoffAt: string;
  readonly includeHistoricalEvidence: boolean;
  readonly jurisdictionReferences?: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly purpose?: string;
}

// ---------------------------------------------------------------------------
// Evidence requirements, types, references, provenance
// ---------------------------------------------------------------------------

export type AssuranceEvidenceContradictionPolicy = 'fail' | 'manual_review' | 'unknown';

export interface AssuranceEvidenceRequirement {
  readonly requirementId: string;
  readonly description: string;
  readonly acceptedEvidenceTypes: readonly AssuranceEvidenceType[];
  readonly minimumCount?: number;
  /** Maximum age in days, measured against the scope's `evidenceCutoffAt` (never wall clock) so resolution stays deterministic. */
  readonly maximumAgeDays?: number;
  readonly mustBeVerified?: boolean;
  readonly mustBeOrganizationBound?: boolean;
  readonly mustReferenceSubject?: boolean;
  readonly requiredDisclosureLevels?: readonly string[];
  readonly manualEvidenceAllowed?: boolean;
  readonly contradictionPolicy?: AssuranceEvidenceContradictionPolicy;
}

/** Only these types are valid Assurance evidence (mission section 11) -- arbitrary JSON is never evidence. */
export type AssuranceEvidenceType =
  | 'governance_record'
  | 'evidence_bundle'
  | 'agent_passport'
  | 'passport_view'
  | 'enterprise_health'
  | 'module_health'
  | 'lifecycle_event'
  | 'control_attestation'
  | 'external_artifact_reference';

export const ASSURANCE_EVIDENCE_TYPES: readonly AssuranceEvidenceType[] = [
  'governance_record',
  'evidence_bundle',
  'agent_passport',
  'passport_view',
  'enterprise_health',
  'module_health',
  'lifecycle_event',
  'control_attestation',
  'external_artifact_reference',
];

/** Provenance of one evidence reference (mission section 13). `chainOfCustodyReference` stays absent unless custody controls actually exist -- v1 never populates it. */
export interface AssuranceEvidenceProvenance {
  readonly sourceSystem: string;
  readonly sourceType: string;
  readonly sourceVersion?: string;
  readonly collectedBy: string;
  readonly collectedAt: string;
  readonly originalDigest?: string;
  readonly disclosurePolicy?: string;
  readonly chainOfCustodyReference?: string;
}

/**
 * A *reference* to evidence -- never a copy (mission section 12). Complete
 * Governance Records, Evidence Bundles, and Passport aggregates are never
 * duplicated into the Assurance Store; `externalId` + `digest` are enough
 * to re-fetch and re-verify the original from its own store.
 */
export interface AssuranceEvidenceReference {
  readonly evidenceReferenceId: string;
  readonly evidenceType: AssuranceEvidenceType;
  readonly externalId: string;
  readonly organizationId: string;
  readonly subjectId?: string;
  readonly digest?: string;
  readonly version?: string;
  readonly occurredAt?: string;
  readonly collectedAt: string;
  readonly verified: boolean;
  readonly verificationReference?: string;
  readonly provenance: AssuranceEvidenceProvenance;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Explicit association of manually supplied evidence with the framework
   * evidence requirements it is offered for (ASSURE-SEC-01A). Under the
   * `control_bound` manual-review policy, manual evidence supports a
   * definitive conclusion only for the requirements named here. It is a
   * declaration by the supplier, not proof of authenticity.
   */
  readonly requirementIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Evidence resolution
// ---------------------------------------------------------------------------

/** Stable evidence rejection reason codes (mission section 16). Every rejected reference carries one or more of these. */
export type AssuranceEvidenceRejectionCode =
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_TYPE_NOT_ACCEPTED'
  | 'EVIDENCE_TOO_OLD'
  | 'EVIDENCE_UNVERIFIED'
  | 'EVIDENCE_WRONG_TENANT'
  | 'EVIDENCE_WRONG_SUBJECT'
  | 'EVIDENCE_DISCLOSURE_INSUFFICIENT'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'EVIDENCE_VERSION_UNSUPPORTED'
  | 'EVIDENCE_INCOMPLETE'
  | 'EVIDENCE_CONTRADICTORY'
  | 'EVIDENCE_SOURCE_UNAVAILABLE';

export interface AssuranceRejectedEvidence {
  readonly evidenceReference: AssuranceEvidenceReference;
  readonly reasonCodes: readonly AssuranceEvidenceRejectionCode[];
  readonly detail?: string;
}

export interface AssuranceEvidenceContradiction {
  readonly evidenceReferenceIds: readonly string[];
  readonly reason: string;
  readonly affectedCriteria?: string;
  readonly appliedPolicy: AssuranceEvidenceContradictionPolicy;
}

export type AssuranceEvidenceResolutionStatus = 'satisfied' | 'partially_satisfied' | 'unsatisfied' | 'unavailable';

export interface AssuranceEvidenceResolution {
  readonly requirementId: string;
  readonly status: AssuranceEvidenceResolutionStatus;
  readonly acceptedEvidence: readonly AssuranceEvidenceReference[];
  readonly rejectedEvidence: readonly AssuranceRejectedEvidence[];
  readonly missingEvidence: readonly string[];
  readonly contradictions: readonly AssuranceEvidenceContradiction[];
  readonly resolvedAt: string;
  readonly resolverVersion: string;
}

// ---------------------------------------------------------------------------
// Control evaluation
// ---------------------------------------------------------------------------

/**
 * Deterministic evidence-quality confidence (mission section 19) -- derived
 * from documented rules over the evidence set, never from ungoverned
 * probabilistic AI confidence.
 */
export type AssuranceConfidence = 'high' | 'medium' | 'low';

/** One evaluated criterion, traced. `satisfied: null` means the criterion could not be decided (missing metric/evidence), which is distinct from `false` (evidence demonstrates it is unmet). */
export interface AssuranceCriteriaResult {
  readonly criteriaType: AssuranceControlCriteria['type'];
  readonly description: string;
  readonly satisfied: boolean | null;
  readonly metric?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly reasonCodes: readonly string[];
}

export interface AssuranceManualReviewRequirement {
  readonly reviewType: string;
  readonly questions: readonly string[];
  readonly requiredReviewerRole?: string;
  readonly requiredEvidenceReferenceIds?: readonly string[];
  readonly reason: string;
}

export interface AssuranceControlEvaluation {
  readonly controlEvaluationId: string;
  readonly assessmentId: string;
  readonly controlId: string;
  readonly controlVersion: string;
  readonly domainId: string;
  readonly status: AssuranceControlStatus;
  readonly score: number;
  readonly maximumScore: number;
  readonly confidence: AssuranceConfidence;
  readonly evidenceReferenceIds: readonly string[];
  readonly rejectedEvidenceReferenceIds: readonly string[];
  readonly criteriaResults: readonly AssuranceCriteriaResult[];
  readonly reasonCodes: readonly string[];
  readonly summary: string;
  readonly evaluatedAt: string;
  readonly evaluatorVersion: string;
  readonly manualReview?: AssuranceManualReviewRequirement;
}

// ---------------------------------------------------------------------------
// Manual review
// ---------------------------------------------------------------------------

export type AssuranceManualReviewOutcome = 'pass' | 'partial' | 'fail' | 'insufficient_evidence';

/** An attributable manual review record (mission section 21) -- no anonymous toggles: reviewer identity, rationale, and a digest are mandatory. */
export interface AssuranceManualReviewRecord {
  readonly reviewId: string;
  readonly assessmentId: string;
  readonly controlId: string;
  readonly reviewerId: string;
  readonly reviewerRole?: string;
  readonly outcome: AssuranceManualReviewOutcome;
  readonly rationale: string;
  readonly evidenceReferenceIds: readonly string[];
  readonly reviewedAt: string;
  /**
   * ASSURE-SEC-01B: how `reviewerId`/`reviewerRole` were established.
   * `assurance_reviewer_credential` -- derived from an authenticated reviewer
   * credential. Absent -- recorded before SEC-01B from caller-declared fields;
   * such a review is kept as history but resolves no control.
   */
  readonly reviewerAuthentication?: 'assurance_reviewer_credential';
  readonly reviewDigest: string;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type AssuranceFindingType = 'control_failure' | 'evidence_gap' | 'integrity_issue' | 'scope_issue' | 'configuration_issue' | 'manual_review';

export type AssuranceFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export const ASSURANCE_FINDING_SEVERITIES: readonly AssuranceFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'informational'];

export type AssuranceFindingStatus = 'open' | 'accepted' | 'remediation_planned' | 'remediated' | 'closed' | 'superseded';

export type AssurancePriority = 'immediate' | 'high' | 'normal' | 'low';

/** The Runtime recommends remediation; it never executes it (mission section 25). */
export interface AssuranceRemediationGuidance {
  readonly objective: string;
  readonly recommendedActions: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly priority: AssurancePriority;
  readonly targetDate?: string;
}

export interface AssuranceFinding {
  readonly findingId: string;
  readonly assessmentId: string;
  readonly controlId: string;
  readonly domainId: string;
  readonly findingType: AssuranceFindingType;
  readonly severity: AssuranceFindingSeverity;
  readonly status: AssuranceFindingStatus;
  readonly title: string;
  readonly description: string;
  readonly reasonCodes: readonly string[];
  readonly evidenceReferenceIds: readonly string[];
  readonly remediation: AssuranceRemediationGuidance;
  readonly createdAt: string;
  readonly dueAt?: string;
  readonly ownerReference?: string;
}

/** Append-only finding lifecycle events (mission section 24). Finding history is never overwritten; a later passing assessment never silently closes an earlier finding. */
export type AssuranceFindingEventType =
  | 'AssuranceFindingCreated'
  | 'AssuranceFindingAccepted'
  | 'AssuranceRemediationPlanned'
  | 'AssuranceFindingRemediated'
  | 'AssuranceFindingClosed'
  | 'AssuranceFindingSuperseded'
  | 'AssuranceFindingReopened';

export interface AssuranceFindingEvent {
  readonly findingEventId: string;
  readonly findingId: string;
  readonly assessmentId: string;
  readonly organizationId: string;
  readonly eventType: AssuranceFindingEventType;
  readonly sequence: number;
  readonly actorId: string;
  readonly rationale?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly eventDigest: string;
}

// ---------------------------------------------------------------------------
// Domain assessment and scoring
// ---------------------------------------------------------------------------

export type AssuranceDomainStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'not_applicable';

export interface AssuranceDomainAssessment {
  readonly domainAssessmentId: string;
  readonly assessmentId: string;
  readonly domainId: string;
  readonly status: AssuranceDomainStatus;
  readonly score: number;
  readonly maximumScore: number;
  readonly normalizedScore: number;
  readonly controlEvaluationIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly blockingFindingIds: readonly string[];
  /** Per-control calculation trace (mission section 29) -- every domain score is reconstructable from this. */
  readonly contributions: readonly AssuranceScoreContribution[];
  readonly summary: string;
  readonly evaluatedAt: string;
}

export type AssuranceUnknownPolicy = 'zero' | 'exclude' | 'manual_review';
export type AssuranceManualReviewPolicy = 'zero' | 'exclude' | 'provisional';
export type AssuranceBlockingRule = 'domain_override' | 'eligibility_only' | 'both';

/**
 * The framework-owned scoring model (mission section 27) -- the framework
 * owns scoring; no UI or caller may re-map statuses to numbers.
 * `statusScores` maps each control status to a 0..1 multiplier or `null`
 * ("policy decides": `unknown` → `unknownPolicy`, `manual_review_required`
 * → `manualReviewPolicy`, `not_applicable` is always excluded from the
 * denominator).
 */
export interface AssuranceScoringModel {
  readonly methodologyId: string;
  readonly methodologyVersion: string;
  readonly statusScores: Readonly<Record<AssuranceControlStatus, number | null>>;
  readonly domainWeights: Readonly<Record<string, number>>;
  readonly controlWeights: Readonly<Record<string, number>>;
  readonly unknownPolicy: AssuranceUnknownPolicy;
  readonly manualReviewPolicy: AssuranceManualReviewPolicy;
  readonly blockingRule: AssuranceBlockingRule;
}

/** One control's contribution to its domain score -- the calculation trace entry (mission section 29). */
export interface AssuranceScoreContribution {
  readonly controlId: string;
  readonly status: AssuranceControlStatus;
  readonly rawValue: number | null;
  readonly weight: number;
  readonly weightedValue: number | null;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
}

/** One domain's contribution to the overall score. */
export interface AssuranceDomainScoreContribution {
  readonly domainId: string;
  readonly status: AssuranceDomainStatus;
  readonly normalizedScore: number;
  readonly weight: number;
  readonly weightedValue: number | null;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
}

export interface AssuranceDomainScoreReference {
  readonly domainId: string;
  readonly domainAssessmentId: string;
  readonly normalizedScore: number;
  readonly status: AssuranceDomainStatus;
}

/**
 * The overall assessment score. Framework-bound and scope-bound by
 * construction (mission section 32): it is meaningless without the
 * framework ID/version, subject, scope, and evidence cutoff carried on the
 * enclosing assessment -- it is never a universal trust score.
 */
export interface AssuranceScore {
  readonly rawScore: number;
  readonly maximumScore: number;
  readonly normalizedScore: number;
  readonly domainScores: readonly AssuranceDomainScoreReference[];
  readonly calculationTrace: readonly AssuranceDomainScoreContribution[];
  readonly methodologyId: string;
  readonly methodologyVersion: string;
  readonly calculatedAt: string;
}

// ---------------------------------------------------------------------------
// Eligibility (distinct from certification -- mission sections 33-35)
// ---------------------------------------------------------------------------

export interface AssuranceEligibilityProfile {
  readonly profileId: string;
  readonly name: string;
  readonly description?: string;
  readonly minimumOverallScore?: number;
  readonly minimumDomainScores?: Readonly<Record<string, number>>;
  readonly mandatoryControlIds?: readonly string[];
  readonly prohibitedOpenSeverities?: readonly AssuranceFindingSeverity[];
  readonly minimumVerifiedEvidenceRate?: number;
  readonly maximumEvidenceAgeDays?: number;
  readonly manualReviewRequired: boolean;
}

export interface AssuranceEligibilityResult {
  readonly profileId: string;
  readonly eligible: boolean;
  readonly provisional: boolean;
  readonly blockingControlIds: readonly string[];
  readonly blockingFindingIds: readonly string[];
  readonly minimumScoreSatisfied: boolean;
  readonly domainThresholdsSatisfied: boolean;
  readonly evidenceRequirementsSatisfied: boolean;
  readonly manualReviewRequired: boolean;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
}

/** An eligibility *candidate* (mission section 35) -- deliberately never called a certificate. */
export interface AssuranceEligibilityCandidate {
  readonly assessmentId: string;
  readonly profileId: string;
  readonly subjectId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly eligibility: AssuranceEligibilityResult;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Assessment aggregate
// ---------------------------------------------------------------------------

export type AssuranceAssessmentStatus = 'created' | 'collecting_evidence' | 'evaluating' | 'manual_review' | 'completed' | 'failed' | 'superseded';

/** Statuses in which an assessment's content may no longer change. `superseded` is store-level lifecycle bookkeeping layered over a completed assessment -- content and digests stay frozen. */
export const ASSURANCE_TERMINAL_STATUSES: readonly AssuranceAssessmentStatus[] = ['completed', 'failed', 'superseded'];

export interface AssuranceModuleSnapshot {
  readonly moduleId: string;
  readonly version: string;
  readonly status: string;
}

export interface AssuranceAssessmentProvenance {
  readonly requestedBy: string;
  readonly organizationId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly evidenceCutoffAt: string;
  readonly evaluatorVersion: string;
  readonly scoringVersion: string;
  readonly eligibilityVersion: string;
  readonly enterpriseVersion: string;
  readonly kernelVersion: string;
  readonly governanceStoreVersion: string;
  readonly evidenceRuntimeVersion: string;
  readonly passportRuntimeVersion?: string;
  readonly moduleSnapshot: readonly AssuranceModuleSnapshot[];
  readonly createdAt: string;
}

/**
 * Integrity metadata: SHA-256 over `aoc.canonical-json.v1` serialization,
 * reusing the Governance Store's digest primitive verbatim. This detects
 * post-completion tampering; it is NOT a signature, NOT external
 * attestation, and NOT non-repudiation (mission section 38).
 *
 * Digests cover the assessment's *content sections*; the mutable
 * store-level lifecycle overlay (`completed` → `superseded`) is
 * deliberately outside every digest, so supersession bookkeeping never
 * invalidates a frozen assessment.
 */
export interface AssuranceAssessmentIntegrity {
  readonly algorithm: 'sha256';
  readonly canonicalizationVersion: string;
  readonly scopeDigest: string;
  readonly evidenceDigest: string;
  readonly controlEvaluationsDigest: string;
  readonly findingsDigest: string;
  readonly domainAssessmentsDigest: string;
  readonly scoreDigest: string;
  readonly eligibilityDigest: string;
  readonly assessmentDigest: string;
}

export interface AssuranceAssessment {
  readonly assessmentId: string;
  readonly assessmentVersion: string;
  readonly subject: AssuranceSubject;
  readonly scope: AssuranceScope;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly status: AssuranceAssessmentStatus;
  readonly evidenceReferences: readonly AssuranceEvidenceReference[];
  readonly evidenceResolutions: readonly AssuranceEvidenceResolution[];
  readonly controlEvaluations: readonly AssuranceControlEvaluation[];
  readonly findings: readonly AssuranceFinding[];
  readonly domainAssessments: readonly AssuranceDomainAssessment[];
  readonly score: AssuranceScore;
  readonly eligibility: readonly AssuranceEligibilityResult[];
  readonly provenance: AssuranceAssessmentProvenance;
  readonly integrity: AssuranceAssessmentIntegrity;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
  readonly reassessmentReason?: string;
  readonly previousAssessmentId?: string;
  readonly supersedesAssessmentId?: string;
  /** Present only when a later assessment superseded this one (store-level bookkeeping, outside every digest). */
  readonly supersededByAssessmentId?: string;
}

// ---------------------------------------------------------------------------
// Continuous Assurance signals and derived state
// ---------------------------------------------------------------------------

/** Only signals with real Assurance relevance (mission section 42) -- never every log line. */
export type AssuranceSignalType =
  | 'governance_decision_denied'
  | 'governance_integrity_failed'
  | 'evidence_bundle_verification_failed'
  | 'passport_suspended'
  | 'passport_revoked'
  | 'passport_integrity_failed'
  | 'enterprise_module_unhealthy'
  | 'enterprise_readiness_lost'
  | 'control_evidence_expired'
  | 'control_evidence_missing'
  | 'finding_reopened'
  | 'remediation_evidence_added'
  | 'framework_version_changed';

export const ASSURANCE_SIGNAL_TYPES: readonly AssuranceSignalType[] = [
  'governance_decision_denied',
  'governance_integrity_failed',
  'evidence_bundle_verification_failed',
  'passport_suspended',
  'passport_revoked',
  'passport_integrity_failed',
  'enterprise_module_unhealthy',
  'enterprise_readiness_lost',
  'control_evidence_expired',
  'control_evidence_missing',
  'finding_reopened',
  'remediation_evidence_added',
  'framework_version_changed',
];

export type AssuranceSignalSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export interface AssuranceSignal {
  readonly signalId: string;
  readonly organizationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly signalType: AssuranceSignalType;
  readonly severity: AssuranceSignalSeverity;
  readonly sourceType: AssuranceEvidenceType;
  readonly sourceId: string;
  readonly sourceDigest?: string;
  readonly affectedControlIds: readonly string[];
  readonly affectedDomainIds: readonly string[];
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signalDigest: string;
}

/** What processing one signal decided. A signal never rewrites a completed assessment (mission section 43) -- these outcomes are forward-looking only. */
export type AssuranceSignalOutcome =
  | 'record_only'
  | 'mark_assessment_stale'
  | 'open_finding'
  | 'reopen_finding'
  | 'request_reassessment'
  | 'change_eligibility'
  | 'require_manual_review';

export interface AssuranceSignalProcessingResult {
  readonly signalId: string;
  readonly outcomes: readonly AssuranceSignalOutcome[];
  readonly affectedAssessmentIds: readonly string[];
  readonly detail: string;
  readonly processedAt: string;
}

export type ContinuousAssuranceStateKind = 'current' | 'stale' | 'degraded' | 'critical' | 'unknown';

/** Derived current state (mission section 44). Always recomputed from immutable assessments + appended signals + finding events -- never a mutable row of record. */
export interface ContinuousAssuranceState {
  readonly subjectId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly latestCompletedAssessmentId?: string;
  readonly state: ContinuousAssuranceStateKind;
  readonly openFindingCounts: Readonly<Record<string, number>>;
  readonly activeSignalIds: readonly string[];
  readonly eligibilityState?: string;
  readonly staleReasons: readonly string[];
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface AssuranceVerificationFailure {
  readonly check: string;
  readonly message: string;
}

export interface AssuranceAssessmentVerificationResult {
  readonly assessmentId: string;
  readonly valid: boolean;
  readonly checks: {
    readonly framework: boolean;
    readonly scope: boolean;
    readonly evidence: boolean;
    readonly controls: boolean;
    readonly findings: boolean;
    readonly domains: boolean;
    readonly score: boolean;
    readonly eligibility: boolean;
    readonly integrity: boolean;
  };
  readonly failures: readonly AssuranceVerificationFailure[];
  readonly verifiedAt: string;
}

// ---------------------------------------------------------------------------
// Reports (canonical JSON only in v1)
// ---------------------------------------------------------------------------

export type AssuranceReportView = 'INTERNAL' | 'AUDITOR' | 'CUSTOMER' | 'PUBLIC';

export const ASSURANCE_REPORT_VIEWS: readonly AssuranceReportView[] = ['INTERNAL', 'AUDITOR', 'CUSTOMER', 'PUBLIC'];

export interface AssuranceExecutiveSummary {
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly subjectId: string;
  readonly subjectType: AssuranceSubjectType;
  readonly scopeId: string;
  readonly evidenceCutoffAt: string;
  readonly assessedAt: string;
  readonly overallNormalizedScore: number;
  readonly domainCount: number;
  readonly controlCount: number;
  readonly openFindingCount: number;
  readonly highestOpenSeverity?: AssuranceFindingSeverity;
  readonly narrative: string;
}

export interface AssuranceDomainReport {
  readonly domainId: string;
  readonly name: string;
  readonly status: AssuranceDomainStatus;
  readonly normalizedScore: number;
  readonly controlCount: number;
  readonly findingCount: number;
  readonly summary: string;
}

export interface AssuranceControlReport {
  readonly controlId: string;
  readonly title: string;
  readonly domainId: string;
  readonly status: AssuranceControlStatus;
  readonly confidence: AssuranceConfidence;
  readonly score: number;
  readonly maximumScore: number;
  readonly reasonCodes: readonly string[];
  readonly summary: string;
  /** Absent in CUSTOMER/PUBLIC views (projection layer). */
  readonly criteriaResults?: readonly AssuranceCriteriaResult[];
  readonly evidenceReferenceIds?: readonly string[];
}

export interface AssuranceFindingReport {
  readonly findingId: string;
  readonly controlId: string;
  readonly domainId: string;
  readonly findingType: AssuranceFindingType;
  readonly severity: AssuranceFindingSeverity;
  readonly status: AssuranceFindingStatus;
  readonly title: string;
  /** Absent in CUSTOMER/PUBLIC views. */
  readonly description?: string;
  readonly remediation?: AssuranceRemediationGuidance;
  readonly evidenceReferenceIds?: readonly string[];
}

export interface AssuranceEvidenceIndexEntry {
  readonly evidenceReferenceId: string;
  readonly evidenceType: AssuranceEvidenceType;
  readonly externalId: string;
  readonly verified: boolean;
  readonly collectedAt: string;
  readonly digest?: string;
}

export interface AssuranceReportProvenance {
  readonly assessmentId: string;
  readonly assessmentDigest: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly reportEngineVersion: string;
  readonly view: AssuranceReportView;
}

/** Report digest is deliberately distinct from the assessment digest (mission section 68): many reports may derive from one assessment. */
export interface AssuranceReportIntegrity {
  readonly algorithm: 'sha256';
  readonly canonicalizationVersion: string;
  readonly reportDigest: string;
  readonly assessmentDigest: string;
}

export interface AssuranceReport {
  readonly reportId: string;
  readonly assessmentId: string;
  readonly view: AssuranceReportView;
  readonly executiveSummary: AssuranceExecutiveSummary;
  readonly domainResults: readonly AssuranceDomainReport[];
  readonly controlResults: readonly AssuranceControlReport[];
  readonly findings: readonly AssuranceFindingReport[];
  readonly eligibility: readonly AssuranceEligibilityResult[];
  readonly evidenceIndex: readonly AssuranceEvidenceIndexEntry[];
  readonly provenance: AssuranceReportProvenance;
  readonly integrity: AssuranceReportIntegrity;
}

// ---------------------------------------------------------------------------
// Access context, queries, health
// ---------------------------------------------------------------------------

/**
 * The authorization scope the Enterprise Host resolved for an Assurance
 * call. The Assurance Runtime does not authenticate anyone (mission section
 * 53) -- same shape and enforcement model as `PassportAccessContext` /
 * `GovernanceStoreAccessContext`.
 *
 * `actorId` and `roles` are NOT an authenticated identity -- every caller can
 * set them, and no manual review is attributed from them. A manual review
 * requires `reviewer`, a principal issued by the service's reviewer
 * authenticator from a configured Assurance reviewer credential
 * (ASSURE-SEC-01B, `reviewer-identity.ts`).
 */
export interface AssuranceAccessContext {
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly roles?: readonly string[];
  readonly system: boolean;
  /** ASSURE-SEC-01B: the authenticated reviewer. Recognised only if the same service's authenticator issued it. */
  readonly reviewer?: AssuranceReviewerPrincipal;
}

/**
 * An authenticated Assurance reviewer (ASSURE-SEC-01B): identity, tenant and
 * roles come from a configured reviewer credential, never from a request.
 * The shape alone proves nothing; see `AssuranceAccessContext.reviewer`.
 */
export interface AssuranceReviewerPrincipal {
  readonly credentialClass: 'assurance-reviewer';
  readonly reviewerId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

export interface AssuranceAssessmentQuery {
  readonly subjectId?: string;
  readonly frameworkId?: string;
  readonly frameworkVersion?: string;
  readonly status?: AssuranceAssessmentStatus;
  readonly limit?: number;
}

export interface AssuranceAssessmentSummary {
  readonly assessmentId: string;
  readonly subjectId: string;
  readonly subjectType: AssuranceSubjectType;
  readonly organizationId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly status: AssuranceAssessmentStatus;
  readonly normalizedScore: number;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface AssuranceAssessmentQueryResult {
  readonly assessments: readonly AssuranceAssessmentSummary[];
  readonly total: number;
}

export interface AssuranceSignalQuery {
  readonly subjectId?: string;
  readonly signalType?: AssuranceSignalType;
  readonly since?: string;
  readonly limit?: number;
}

export interface AssuranceStoreHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly migrationState: string;
  readonly checkedAt: string;
}

// ---------------------------------------------------------------------------
// Framework validation
// ---------------------------------------------------------------------------

export interface AssuranceFrameworkValidationIssue {
  readonly check: string;
  readonly message: string;
}

export interface AssuranceFrameworkValidationResult {
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly valid: boolean;
  readonly issues: readonly AssuranceFrameworkValidationIssue[];
}
