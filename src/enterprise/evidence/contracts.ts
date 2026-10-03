import type { KernelDecisionStatus } from '../../kernel/index.js';
import type { AuthorityTraceVerification } from './trace-contracts.js';
import type { DisclosedAuthorityTrace, TraceComparisonResult } from './trace-disclosure.js';

/**
 * Canonical model of the Soberanía Enterprise Evidence Bundle v1 (PR-005). An
 * Evidence Bundle is a deliberate, disclosure-governed *projection* of one
 * Governance Store aggregate (`GovernanceRecord`, PR-004) — never a copy,
 * dump, backup, or SQL export of it. The Governance Store keeps the complete
 * truth; a Bundle discloses only the subset a `DisclosurePolicy` selects.
 *
 * Constitutional principle (RFC-005, now formalized for Enterprise):
 * `Truth ≠ Disclosure`. An organization can prove a decision was made
 * correctly without revealing everything it knows about how.
 *
 * See `docs/enterprise/AOC_EVIDENCE_BUNDLE.md` and
 * `docs/enterprise/EVIDENCE_PROJECTION_MODEL.md`.
 */

export const AOC_EVIDENCE_BUNDLE_VERSION = '1.0.0';

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 'evidence.bundle.v1';

/**
 * ASSURE-01: the trace-bearing bundle. A v2 bundle carries, beside every v1
 * section, the disclosed Unified Authority-to-Outcome Trace of its request and
 * that trace's digest. v1 bundles are never reinterpreted: their bytes, digests
 * and verification are exactly what they were (`verifier.ts`).
 */
export const EVIDENCE_BUNDLE_SCHEMA_VERSION_V2 = 'evidence.bundle.v2';

/** Projection engine identity, carried in every Bundle's provenance so the projection itself stays auditable. */
export const EVIDENCE_PROJECTION_ENGINE_VERSION = 'aoc.evidence-projector.v1';

export const EVIDENCE_CONTRACT_IDS = {
  bundle: 'aoc.evidence-bundle.v1',
  disclosurePolicy: 'aoc.evidence-disclosure-policy.v1',
} as const;

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

/** The five disclosure levels a Bundle may be projected at (mission: "Implementar al menos"). Each reveals a strictly different amount of the underlying Governance Record. */
export type DisclosureLevel = 'FULL' | 'AUDITOR' | 'PARTNER' | 'CUSTOMER' | 'PUBLIC';

/**
 * The complete, fixed vocabulary of fields an Evidence Bundle may disclose.
 * Every `DisclosurePolicy` classifies each of these into exactly one of
 * `visibleFields` / `hiddenFields` / `redactedFields` — there is no field a
 * bundle can carry that is not named here, so a policy can never leak a
 * field nobody classified.
 */
export const EVIDENCE_FIELD_KEYS = [
  'source.organizationId',
  'subject.actionType',
  'subject.resourceScope',
  'subject.description',
  'evidence.status',
  'evidence.summary',
  'evidence.reasonCodes',
  'evidence.trace',
  'evidence.events',
  'evidence.metadata',
] as const;

export type EvidenceFieldKey = (typeof EVIDENCE_FIELD_KEYS)[number];

/**
 * A Disclosure Policy: the true innovation of the Evidence Bundle (mission
 * section "Disclosure Policy"). Classifies every `EvidenceFieldKey` into
 * visible/hidden/redacted, and further splits the visible set into
 * required/optional. A field's classification is total and mutually
 * exclusive — `visibleFields` and `hiddenFields` partition
 * `EVIDENCE_FIELD_KEYS` between them, `redactedFields` is a subset of
 * `visibleFields` (the field name is disclosed, its value is not), and
 * `requiredFields`/`optionalFields` partition `visibleFields`.
 */
export interface DisclosurePolicy {
  readonly policyId: string;
  readonly level: DisclosureLevel;
  readonly version: string;
  readonly visibleFields: readonly EvidenceFieldKey[];
  readonly hiddenFields: readonly EvidenceFieldKey[];
  readonly redactedFields: readonly EvidenceFieldKey[];
  readonly requiredFields: readonly EvidenceFieldKey[];
  readonly optionalFields: readonly EvidenceFieldKey[];
}

/** The disclosure metadata a Bundle actually carries: which policy was applied and what it revealed/withheld, so a consumer never has to guess. */
export interface EvidenceDisclosureMetadata {
  readonly level: DisclosureLevel;
  readonly policyId: string;
  readonly policyVersion: string;
  /** v1 bundles name only `EvidenceFieldKey`s; v2 bundles may also name the trace fields (`trace-disclosure.ts`). */
  readonly visibleFields: readonly string[];
  readonly hiddenFields: readonly string[];
  readonly redactedFields: readonly string[];
}

// ---------------------------------------------------------------------------
// Bundle sections
// ---------------------------------------------------------------------------

/**
 * Where this Bundle came from. Deliberately narrow -- never the complete
 * `GovernanceRecord`. `organizationId` is itself subject to disclosure (it
 * is redacted/hidden at PARTNER/CUSTOMER/PUBLIC levels) so it is projected
 * separately, not always carried.
 */
export interface EvidenceSource {
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly organizationId?: string;
  readonly kernelVersion: string;
  readonly enterpriseVersion: string;
  readonly schemaVersion: string;
}

/** What is being demonstrated by this Bundle -- what the mission calls the Subject (Action, Policy Decision, Payment, Approval, Execution, Vendor Validation, Passport Event). */
export type EvidenceSubjectType = 'policy_decision' | 'action' | 'payment' | 'approval' | 'execution' | 'vendor_validation' | 'passport_event';

export interface EvidenceSubject {
  readonly subjectType: EvidenceSubjectType;
  readonly actionType?: string;
  readonly resourceScope?: string;
  readonly description?: string;
}

/** One trace step as disclosed in a Bundle -- a bounded projection of `GovernanceTraceRecord`, never the full record (no `traceRecordId`, no `traceDigest`, no `traceContract`). */
export interface EvidenceTraceStep {
  readonly sequence: number;
  readonly operator: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
}

/** One event as disclosed in a Bundle -- type and timing only, never the event payload. */
export interface EvidenceEventSummary {
  readonly eventType: string;
  readonly occurredAt: string;
}

/**
 * The disclosed evidentiary content itself. Every field is optional because
 * disclosure policies decide, field by field, what actually appears --
 * absence of a field here means it was hidden by policy, not that it never
 * existed on the source record.
 */
export interface EvidenceContent {
  readonly status?: KernelDecisionStatus;
  readonly summary?: string;
  readonly reasonCodes?: readonly string[];
  readonly trace?: readonly EvidenceTraceStep[];
  readonly events?: readonly EvidenceEventSummary[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Integrity metadata (mission section "Integrity"). `recordDigest` is
 * carried verbatim from `GovernanceRecord.integrity.aggregateDigest` --
 * never recomputed here, because a Bundle projects a decision, it never
 * recalculates one. `bundleDigest` is a digest of the Bundle's own projected
 * content, distinct from `recordDigest` by construction (mission: "Bundle
 * Digest ... Separado del Aggregate Digest", since the projection changes
 * from bundle to bundle while the source record does not).
 * `verificationDigest` binds `bundleDigest`, `recordDigest`, and the applied
 * disclosure policy identity together, so swapping any one of the three
 * without the others is independently detectable.
 */
export interface EvidenceIntegrityMetadata {
  readonly algorithm: 'sha256';
  readonly canonicalizationVersion: string;
  readonly bundleDigest: string;
  readonly recordDigest: string;
  /** v2 only: the digest of the disclosed trace this bundle carries. Absent on every v1 bundle. */
  readonly traceDigest?: string;
  readonly verificationDigest: string;
}

/** Provenance of the projection itself (mission: "la proyección también debe ser auditable"). */
export interface EvidenceProvenance {
  readonly createdBy: string;
  readonly generatedAt: string;
  readonly projectionVersion: string;
  readonly projectionPolicy: string;
  readonly projectionEngine: string;
}

/** A reserved forward-reference from this Bundle to a future Passport/Assurance/external-audit artifact. No such runtime exists yet -- this is structure only, per the mission's Non Goals. */
export type EvidenceReferenceType = 'passport' | 'assurance' | 'external_audit';

export interface EvidenceReference {
  readonly referenceType: EvidenceReferenceType;
  readonly externalId?: string;
  readonly note?: string;
}

/**
 * The Evidence Bundle itself. Immutable once built: there is deliberately no
 * update operation anywhere in this module, and none may be added. A change
 * in disclosure policy, or a request for different content, always produces
 * a *new* Bundle with its own `bundleId` and `bundleDigest` -- never a
 * mutation of an existing one (mission: "Supersession").
 */
export interface EvidenceBundle {
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly createdAt: string;
  readonly source: EvidenceSource;
  readonly subject: EvidenceSubject;
  readonly disclosure: EvidenceDisclosureMetadata;
  readonly integrity: EvidenceIntegrityMetadata;
  readonly evidence: EvidenceContent;
  readonly verification: EvidenceProvenance;
  readonly references: readonly EvidenceReference[];
  /** v2 only (ASSURE-01): the disclosed Unified Authority-to-Outcome Trace of `source.requestId`. Absent on every v1 bundle. */
  readonly trace?: DisclosedAuthorityTrace;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A Bundle's lifecycle state, tracked by the Bundle Store -- never on the immutable `EvidenceBundle` value itself. */
export type EvidenceBundleState = 'GENERATED' | 'VERIFIED' | 'EXPORTED' | 'SUPERSEDED';

/** One Bundle Store entry: the immutable bundle plus its mutable lifecycle bookkeeping. */
export interface EvidenceBundleRecord {
  readonly bundle: EvidenceBundle;
  readonly state: EvidenceBundleState;
  readonly storedAt: string;
  /**
   * The organization that owns the Bundle (its source record's), kept by the
   * store apart from the Bundle's disclosed content — so a Bundle whose policy
   * hides the organization is still readable by that organization, and only by
   * it. Never serialized onto the wire.
   */
  readonly organizationId?: string;
  /** Present only when `state === 'SUPERSEDED'` -- the bundleId of the replacement Bundle a changed disclosure policy produced. */
  readonly supersededBy?: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface EvidenceIntegrityFailure {
  readonly check: string;
  readonly message: string;
}

/**
 * Result of `verifyEvidenceBundle` (mission's "Verification Flow"):
 * recomputes the Bundle's own digest, checks it against the linked
 * Governance Record when available, checks the disclosure policy the Bundle
 * claims against the canonical policy definition, and checks completeness
 * against the policy's `requiredFields`.
 */
export interface EvidenceVerificationResult {
  readonly bundleId: string;
  readonly valid: boolean;
  readonly checks: {
    readonly bundleDigest: boolean;
    readonly verificationDigest: boolean;
    /** Absent when no source `GovernanceRecord` was supplied to verify against -- the Bundle is still structurally checked, but "does it match the Record" is left explicitly unanswered rather than assumed true. */
    readonly recordDigest?: boolean;
    readonly policyMatch: boolean;
    readonly versionSupported: boolean;
    readonly complete: boolean;
    /** v2 only: the carried trace recomputes to `integrity.traceDigest`. */
    readonly traceDigest?: boolean;
    /** v2 only: the carried trace is not contradicted by the canonical records now (it may have progressed). Absent when no canonical trace could be rebuilt. */
    readonly traceConsistent?: boolean;
    /** v2 only: the canonical trace rebuilt now verifies (integrity, correlation, completeness). */
    readonly sourceTraceVerified?: boolean;
  };
  readonly verifiedAt: string;
  readonly failures: readonly EvidenceIntegrityFailure[];
  /**
   * v2 only. Freshness, reported apart from integrity: `current` when the
   * carried trace is exactly what the canonical records disclose now,
   * `superseded-by-later-facts` when the request has since moved on without
   * contradicting anything the bundle states.
   */
  readonly freshness?: 'current' | 'superseded-by-later-facts' | 'unknown';
  /** v2 only: the stage-by-stage comparison against the canonical trace rebuilt now. */
  readonly traceComparison?: TraceComparisonResult;
  /** v2 only: the structured verification of the canonical trace rebuilt now. */
  readonly sourceTrace?: AuthorityTraceVerification;
}
