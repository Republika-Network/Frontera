import type { GovernanceRecord } from '../governance-store/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import { redactSensitiveValues } from '../governance-store/redaction.js';
import { AOC_CANONICALIZATION_VERSION } from '../governance-store/canonical-json.js';
import type { AuthorityTrace } from './trace-contracts.js';
import { discloseAuthorityTrace, disclosedTraceDigest, type DisclosurePolicyV2 } from './trace-disclosure.js';
import {
  AOC_EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION_V2,
  EVIDENCE_FIELD_KEYS,
  EVIDENCE_PROJECTION_ENGINE_VERSION,
  type DisclosurePolicy,
  type EvidenceBundle,
  type EvidenceContent,
  type EvidenceEventSummary,
  type EvidenceFieldKey,
  type EvidenceIntegrityMetadata,
  type EvidenceProvenance,
  type EvidenceReference,
  type EvidenceSource,
  type EvidenceSubject,
  type EvidenceSubjectType,
  type EvidenceTraceStep,
} from './contracts.js';

/**
 * The Evidence Projector (mission section "Projection Engine"): the single
 * place that turns a `GovernanceRecord` plus a `DisclosurePolicy` into an
 * `EvidenceBundle`. This is the only direction the projection ever runs --
 * `GovernanceRecord -> Disclosure Policy -> EvidenceBundle`, never the
 * reverse, and the Bundle never carries enough information to reconstruct
 * the full Governance Record.
 */

/** A value visible-by-policy but forced to a generic placeholder instead of its real content -- distinct from `GOVERNANCE_REDACTED_VALUE` (secret redaction), which this projector also applies as an independent, unconditional pass. */
export const EVIDENCE_DISCLOSURE_REDACTED_VALUE = '[REDACTED-BY-DISCLOSURE-POLICY]' as const;

export interface EvidenceProjectionDependencies {
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  /** Identity stamped into `verification.createdBy` -- the caller/service that requested this projection, for provenance auditing. Defaults to the projection engine itself when omitted (e.g. system-initiated projections). */
  readonly createdBy?: string;
  readonly references?: readonly EvidenceReference[];
}

function deriveSubjectType(record: GovernanceRecord): EvidenceSubjectType {
  const domain = record.request.actionDomain?.toLowerCase();
  if (domain === 'payment' || domain === 'payments') return 'payment';
  if (domain === 'approval' || domain === 'approvals') return 'approval';
  if (domain === 'execution') return 'execution';
  if (domain === 'vendor_validation' || domain === 'vendor-validation') return 'vendor_validation';
  if (domain === 'passport_event' || domain === 'passport-event') return 'passport_event';
  return 'policy_decision';
}

function deriveDescription(record: GovernanceRecord): string {
  return `${record.request.actionType} on ${record.request.resourceScope}`;
}

function boundedTrace(record: GovernanceRecord): readonly EvidenceTraceStep[] {
  return [...record.trace]
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => ({ sequence: step.sequence, operator: step.operator, status: step.status, reasonCodes: [...step.reasonCodes] }));
}

function boundedEvents(record: GovernanceRecord): readonly EvidenceEventSummary[] {
  return record.events.map((event) => ({ eventType: event.eventType, occurredAt: event.occurredAt }));
}

/** Bounded, non-sensitive derived metadata -- never the raw `GovernanceRecordMetadata` (no provider/module snapshots, no build/environment strings). Even the FULL disclosure level never carries a copy of the Governance Record. */
function boundedMetadata(record: GovernanceRecord): Readonly<Record<string, unknown>> {
  return {
    lifecycleState: record.metadata.lifecycleState,
    moduleCount: record.metadata.moduleSnapshot.length,
    traceStepCount: record.trace.length,
    eventCount: record.events.length,
  };
}

/** The complete (pre-disclosure) projected view, keyed by the fixed field vocabulary. Every value here is already a bounded projection of the Governance Record -- disclosure filtering happens strictly on top of this, never on the raw record. */
function buildFullFieldView(record: GovernanceRecord): Readonly<Record<EvidenceFieldKey, unknown>> {
  return {
    'source.organizationId': record.request.organizationId,
    'subject.actionType': record.request.actionType,
    'subject.resourceScope': record.request.resourceScope,
    'subject.description': deriveDescription(record),
    'evidence.status': record.evaluation.status,
    'evidence.summary': record.evaluation.summary,
    'evidence.reasonCodes': [...record.evaluation.reasonCodes],
    'evidence.trace': boundedTrace(record),
    'evidence.events': boundedEvents(record),
    'evidence.metadata': boundedMetadata(record),
  };
}

/** Applies a `DisclosurePolicy` over the full field view: hidden fields are omitted entirely, redacted fields keep their key but lose their value, visible fields pass through unchanged. */
function applyDisclosurePolicy(fullView: Readonly<Record<EvidenceFieldKey, unknown>>, policy: Pick<DisclosurePolicy, 'hiddenFields' | 'redactedFields'> | Pick<DisclosurePolicyV2, 'hiddenFields' | 'redactedFields'>): Partial<Record<EvidenceFieldKey, unknown>> {
  const hidden = new Set<string>(policy.hiddenFields);
  const redacted = new Set<string>(policy.redactedFields);
  const disclosed: Partial<Record<EvidenceFieldKey, unknown>> = {};
  for (const field of EVIDENCE_FIELD_KEYS) {
    if (hidden.has(field)) continue;
    const value = fullView[field];
    if (value === undefined) continue;
    disclosed[field] = redacted.has(field) ? EVIDENCE_DISCLOSURE_REDACTED_VALUE : value;
  }
  return disclosed;
}

function toSource(record: GovernanceRecord, disclosed: Partial<Record<EvidenceFieldKey, unknown>>): EvidenceSource {
  return {
    evaluationId: record.evaluation.evaluationId,
    decisionId: record.evaluation.decisionId,
    requestId: record.evaluation.requestId,
    ...('source.organizationId' in disclosed ? { organizationId: disclosed['source.organizationId'] as string } : {}),
    kernelVersion: record.evaluation.kernelVersion,
    enterpriseVersion: record.evaluation.enterpriseVersion,
    schemaVersion: record.metadata.schemaVersion,
  };
}

function toSubject(record: GovernanceRecord, disclosed: Partial<Record<EvidenceFieldKey, unknown>>): EvidenceSubject {
  return {
    subjectType: deriveSubjectType(record),
    ...('subject.actionType' in disclosed ? { actionType: disclosed['subject.actionType'] as string } : {}),
    ...('subject.resourceScope' in disclosed ? { resourceScope: disclosed['subject.resourceScope'] as string } : {}),
    ...('subject.description' in disclosed ? { description: disclosed['subject.description'] as string } : {}),
  };
}

function toEvidenceContent(disclosed: Partial<Record<EvidenceFieldKey, unknown>>): EvidenceContent {
  return {
    ...('evidence.status' in disclosed ? { status: disclosed['evidence.status'] as Exclude<EvidenceContent['status'], undefined> } : {}),
    ...('evidence.summary' in disclosed ? { summary: disclosed['evidence.summary'] as string } : {}),
    ...('evidence.reasonCodes' in disclosed ? { reasonCodes: disclosed['evidence.reasonCodes'] as readonly string[] } : {}),
    ...('evidence.trace' in disclosed ? { trace: disclosed['evidence.trace'] as readonly EvidenceTraceStep[] } : {}),
    ...('evidence.events' in disclosed ? { events: disclosed['evidence.events'] as readonly EvidenceEventSummary[] } : {}),
    ...('evidence.metadata' in disclosed ? { metadata: disclosed['evidence.metadata'] as Readonly<Record<string, unknown>> } : {}),
  };
}

/** Digest input for `integrity.bundleDigest`: every projected section except the integrity block itself. Recomputing this from a Bundle's own content is exactly what `verifyEvidenceBundle` does. */
export function bundleDigestInput(bundle: Omit<EvidenceBundle, 'integrity'>): Readonly<Record<string, unknown>> {
  const { bundleId, bundleVersion, createdAt, source, subject, disclosure, evidence, verification, references } = bundle;
  return { bundleId, bundleVersion, createdAt, source, subject, disclosure, evidence, verification, references };
}

/** Digest input for `integrity.verificationDigest`: binds the bundle digest, the source record digest, and the disclosure policy identity together so no two of the three can be swapped independently without detection. */
export function verificationDigestInput(parts: { readonly bundleDigest: string; readonly recordDigest: string; readonly policyId: string; readonly policyVersion: string; readonly bundleVersion: string }): Readonly<Record<string, unknown>> {
  return { ...parts };
}

/**
 * Builds one immutable `EvidenceBundle` from a `GovernanceRecord` under a
 * `DisclosurePolicy`. Pure over its inputs (given the injected clock/id
 * values): identical `(record, policy)` produce identical disclosed content
 * and digests, differing only in `bundleId`/`createdAt`/`verification`
 * across separate calls -- exactly the "same Record, multiple Bundles"
 * shape the mission requires.
 */
export function buildEvidenceBundle(record: GovernanceRecord, policy: DisclosurePolicy, deps: EvidenceProjectionDependencies): EvidenceBundle {
  const fullView = buildFullFieldView(record);
  const disclosed = applyDisclosurePolicy(fullView, policy);

  const source = toSource(record, disclosed);
  const subject = redactSensitiveValues(toSubject(record, disclosed));
  const evidence = redactSensitiveValues(toEvidenceContent(disclosed));

  const createdAt = deps.now();
  const bundleId = deps.nextId('evidence-bundle');

  const provenance: EvidenceProvenance = {
    createdBy: deps.createdBy ?? EVIDENCE_PROJECTION_ENGINE_VERSION,
    generatedAt: createdAt,
    projectionVersion: AOC_EVIDENCE_BUNDLE_VERSION,
    projectionPolicy: policy.policyId,
    projectionEngine: EVIDENCE_PROJECTION_ENGINE_VERSION,
  };

  const withoutIntegrity: Omit<EvidenceBundle, 'integrity'> = {
    bundleId,
    bundleVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    createdAt,
    source,
    subject,
    disclosure: {
      level: policy.level,
      policyId: policy.policyId,
      policyVersion: policy.version,
      visibleFields: policy.visibleFields,
      hiddenFields: policy.hiddenFields,
      redactedFields: policy.redactedFields,
    },
    evidence,
    verification: provenance,
    references: deps.references ?? [],
  };

  const bundleDigest = computeDigest(bundleDigestInput(withoutIntegrity));
  const recordDigest = record.integrity.aggregateDigest;
  const verificationDigest = computeDigest(
    verificationDigestInput({ bundleDigest, recordDigest, policyId: policy.policyId, policyVersion: policy.version, bundleVersion: withoutIntegrity.bundleVersion }),
  );

  const integrity: EvidenceIntegrityMetadata = {
    algorithm: 'sha256',
    canonicalizationVersion: AOC_CANONICALIZATION_VERSION,
    bundleDigest,
    recordDigest,
    verificationDigest,
  };

  return { ...withoutIntegrity, integrity };
}

// ---------------------------------------------------------------------------
// v2 (ASSURE-01): the trace-bearing bundle
// ---------------------------------------------------------------------------

/** Projection engine identity for v2 bundles. */
export const EVIDENCE_PROJECTION_ENGINE_VERSION_V2 = 'aoc.evidence-projector.v2';

/** v2 digest input: every v1 section plus the disclosed trace. */
export function bundleDigestInputV2(bundle: Omit<EvidenceBundle, 'integrity'>): Readonly<Record<string, unknown>> {
  const { bundleId, bundleVersion, createdAt, source, subject, disclosure, evidence, verification, references, trace } = bundle;
  return { bundleId, bundleVersion, createdAt, source, subject, disclosure, evidence, verification, references, trace: trace ?? null };
}

/** v2 binding: bundle digest, record digest, trace digest and policy identity — none can be swapped without the others. */
export function verificationDigestInputV2(parts: {
  readonly bundleDigest: string;
  readonly recordDigest: string;
  readonly traceDigest: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly bundleVersion: string;
}): Readonly<Record<string, unknown>> {
  return { ...parts };
}

/**
 * Builds one immutable v2 bundle: the v1 projection of the request's
 * Governance Record under the v2 policy's v1 fields, plus the trace disclosed
 * under the same policy. The trace must be the one built for this record.
 */
export function buildEvidenceBundleV2(record: GovernanceRecord, trace: AuthorityTrace, policy: DisclosurePolicyV2, deps: EvidenceProjectionDependencies): EvidenceBundle {
  if (trace.evaluationId !== record.evaluation.evaluationId || trace.requestId !== record.request.requestId || trace.decisionId !== record.evaluation.decisionId) {
    throw new Error('buildEvidenceBundleV2: the trace does not belong to this Governance Record.');
  }
  const fullView = buildFullFieldView(record);
  const disclosed = applyDisclosurePolicy(fullView, policy);
  const source = toSource(record, disclosed);
  const subject = redactSensitiveValues(toSubject(record, disclosed));
  const evidence = redactSensitiveValues(toEvidenceContent(disclosed));
  const disclosedTrace = discloseAuthorityTrace(trace, policy);

  const createdAt = deps.now();
  const bundleId = deps.nextId('evidence-bundle');
  const withoutIntegrity: Omit<EvidenceBundle, 'integrity'> = {
    bundleId,
    bundleVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION_V2,
    createdAt,
    source,
    subject,
    disclosure: {
      level: policy.level,
      policyId: policy.policyId,
      policyVersion: policy.version,
      visibleFields: policy.visibleFields,
      hiddenFields: policy.hiddenFields,
      redactedFields: policy.redactedFields,
    },
    evidence,
    verification: {
      createdBy: deps.createdBy ?? EVIDENCE_PROJECTION_ENGINE_VERSION_V2,
      generatedAt: createdAt,
      projectionVersion: AOC_EVIDENCE_BUNDLE_VERSION,
      projectionPolicy: policy.policyId,
      projectionEngine: EVIDENCE_PROJECTION_ENGINE_VERSION_V2,
    },
    references: deps.references ?? [],
    trace: disclosedTrace,
  };
  const bundleDigest = computeDigest(bundleDigestInputV2(withoutIntegrity));
  const recordDigest = record.integrity.aggregateDigest;
  const traceDigest = disclosedTraceDigest(disclosedTrace);
  const verificationDigest = computeDigest(
    verificationDigestInputV2({ bundleDigest, recordDigest, traceDigest, policyId: policy.policyId, policyVersion: policy.version, bundleVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION_V2 }),
  );
  return { ...withoutIntegrity, integrity: { algorithm: 'sha256', canonicalizationVersion: AOC_CANONICALIZATION_VERSION, bundleDigest, recordDigest, traceDigest, verificationDigest } };
}
