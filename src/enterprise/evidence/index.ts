/**
 * Soberanía Enterprise Evidence Bundle v1 (PR-005) -- portable, disclosure-
 * governed projections of Governance Store records. See
 * `docs/enterprise/AOC_EVIDENCE_BUNDLE.md`.
 */

export {
  AOC_EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION_V2,
  EVIDENCE_PROJECTION_ENGINE_VERSION,
  EVIDENCE_CONTRACT_IDS,
  EVIDENCE_FIELD_KEYS,
} from './contracts.js';
export type {
  DisclosureLevel,
  DisclosurePolicy,
  EvidenceFieldKey,
  EvidenceDisclosureMetadata,
  EvidenceSource,
  EvidenceSubject,
  EvidenceSubjectType,
  EvidenceTraceStep,
  EvidenceEventSummary,
  EvidenceContent,
  EvidenceIntegrityMetadata,
  EvidenceProvenance,
  EvidenceReference,
  EvidenceReferenceType,
  EvidenceBundle,
  EvidenceBundleState,
  EvidenceBundleRecord,
  EvidenceIntegrityFailure,
  EvidenceVerificationResult,
} from './contracts.js';

export { EvidenceError, isEvidenceError } from './errors.js';
export type { EvidenceErrorCode } from './errors.js';

export {
  FULL_DISCLOSURE_POLICY,
  AUDITOR_DISCLOSURE_POLICY,
  PARTNER_DISCLOSURE_POLICY,
  CUSTOMER_DISCLOSURE_POLICY,
  PUBLIC_DISCLOSURE_POLICY,
  getDisclosurePolicy,
  findDisclosurePolicyById,
  listDisclosurePolicies,
} from './disclosure-policies.js';

export {
  buildEvidenceBundle,
  buildEvidenceBundleV2,
  bundleDigestInput,
  bundleDigestInputV2,
  verificationDigestInput,
  verificationDigestInputV2,
  EVIDENCE_DISCLOSURE_REDACTED_VALUE,
  EVIDENCE_PROJECTION_ENGINE_VERSION_V2,
} from './projector.js';
export type { EvidenceProjectionDependencies } from './projector.js';

export { verifyEvidenceBundle } from './verifier.js';
export type { EvidenceBundleCurrentTrace, VerifyEvidenceBundleOptions } from './verifier.js';

export { createInMemoryEvidenceStore, EVIDENCE_STORE_LIST_LIMIT, EVIDENCE_STORE_MEMORY_SCHEMA_VERSION, isForwardEvidenceTransition } from './evidence-store.js';
export type { EvidenceStore, CreateEvidenceStoreOptions, EvidenceStoreHealth, StoreEvidenceBundleOptions } from './evidence-store.js';
export { createSqliteEvidenceStore, EVIDENCE_STORE_SCHEMA_VERSION, evidenceBundleRowDigest } from './sqlite-evidence-store.js';
export type { CreateSqliteEvidenceStoreOptions, DurableEvidenceStore } from './sqlite-evidence-store.js';

export { createEvidenceService } from './evidence-service.js';
export type { EvidenceService, EvidenceServiceDependencies, BuildEvidenceBundleInput, DisclosedAuthorityTraceView } from './evidence-service.js';

// ASSURE-01 — the Unified Authority-to-Outcome Trace.
export {
  AUTHORITY_TRACE_VERSION,
  AUTHORITY_TRACE_VERIFICATION_VERSION,
  AUTHORITY_TRACE_VERIFICATION_BOUNDARY,
  AUTHORITY_TRACE_LIMITS,
  AUTHORITY_TRACE_STAGE_NAMES,
  GOVERNED_REQUEST_ID_PATTERN,
} from './trace-contracts.js';
export type * from './trace-contracts.js';
export { buildAuthorityTrace, authorityTraceVerificationOf, validateTraceRequestId } from './trace-builder.js';
export type { AuthorityTraceSources, AuthorityTraceBuild } from './trace-builder.js';
export {
  TRACE_FIELD_KEYS,
  EVIDENCE_FIELD_KEYS_V2,
  FULL_DISCLOSURE_POLICY_V2,
  AUDITOR_DISCLOSURE_POLICY_V2,
  PARTNER_DISCLOSURE_POLICY_V2,
  CUSTOMER_DISCLOSURE_POLICY_V2,
  PUBLIC_DISCLOSURE_POLICY_V2,
  TRACE_DISCLOSURE_REDACTED_VALUE,
  getDisclosurePolicyV2,
  findDisclosurePolicyV2ById,
  listDisclosurePoliciesV2,
  discloseAuthorityTrace,
  discloseTraceVerification,
  disclosedTraceDigest,
  summarizeTrace,
  compareDisclosedTraces,
} from './trace-disclosure.js';
export type { TraceFieldKey, EvidenceFieldKeyV2, DisclosurePolicyV2, DisclosedAuthorityTrace, DisclosedAuthorityTraceSummary, TraceComparison, TraceComparisonResult } from './trace-disclosure.js';
