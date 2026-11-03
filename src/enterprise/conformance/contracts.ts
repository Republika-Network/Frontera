import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';

/**
 * RN-CONFORM-02 — closed contracts for the synthetic continuous-conformance
 * circuit. Starting point: `docs/architecture/continuous-conformance/INTEGRATION_CONTRACTS.md`.
 * Every deviation is recorded in `RN_CONFORM_02_IMPLEMENTATION.md` §4.
 *
 * Nothing here is a public API. It is not exported from a package entrypoint,
 * not composed into the Enterprise Host, and has no HTTP surface. Every record
 * carries `synthetic: true`; the store refuses anything else.
 */

export const SYNTHETIC_DESIGNATION = 'SYNTHETIC-NON-PRODUCTION' as const;

/** The literal statement every synthetic operator carries. It establishes nothing about real-world independence. */
export const SYNTHETIC_OPERATOR_STATEMENT =
  'Synthetic test operator. Not a legal entity, not independent of Republika, and not evidence that an independent validator operator exists.' as const;

export const CREDENTIAL_STATES = Object.freeze(['CANDIDATE', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'] as const);
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

export const CHALLENGE_TYPES = Object.freeze(['G01', 'G02', 'G05', 'G06', 'G07', 'G08'] as const);
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];

export const EXPECTED_OUTCOMES = Object.freeze(['denied', 'fail_closed', 'revoked_within_interval', 'deployment_digest_match'] as const);
export type ExpectedOutcome = (typeof EXPECTED_OUTCOMES)[number];

export const OBSERVED_OUTCOMES = Object.freeze(['denied', 'allowed', 'error', 'timeout', 'unreachable', 'digest_reported'] as const);
export type ObservedOutcome = (typeof OBSERVED_OUTCOMES)[number];

export const OUTCOME_CLASSES = Object.freeze(['conformant', 'violation', 'inconclusive'] as const);
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** What each supported challenge tests, which requirement it serves, and the outcome a conformant integration shows. Fixed by code; never taken from a validator. */
export const CHALLENGE_CATALOGUE: Readonly<Record<ChallengeType, { readonly controlId: string; readonly expectedOutcome: ExpectedOutcome; readonly title: string }>> = Object.freeze({
  G01: Object.freeze({ controlId: 'CR-01', expectedOutcome: 'denied', title: 'Unauthorized operation' }),
  G02: Object.freeze({ controlId: 'CR-02', expectedOutcome: 'revoked_within_interval', title: 'Post-revocation operation' }),
  G05: Object.freeze({ controlId: 'CR-05', expectedOutcome: 'denied', title: 'Stale cached authorization' }),
  G06: Object.freeze({ controlId: 'CR-06', expectedOutcome: 'denied', title: 'Cross-tenant access' }),
  G07: Object.freeze({ controlId: 'CR-07', expectedOutcome: 'fail_closed', title: 'Authorization dependency failure' }),
  G08: Object.freeze({ controlId: 'CR-08', expectedOutcome: 'deployment_digest_match', title: 'Unauthorized deployment/version change' }),
});

/** The operation a G08 digest challenge performs; every other challenge names a covered operation. */
export const DEPLOYMENT_ATTESTATION_OPERATION = 'deployment.read-attested-manifest' as const;

/** At most this many covered operations per integration version: evaluation is per (requirement, operation), so this bounds it. */
export const MAX_COVERED_OPERATIONS = 16;

/**
 * The operations a requirement served by `challengeType` must be verified for (finding 4).
 * An enforcement challenge (G01, G02, G05, G06, G07) is evaluated for **each** covered operation
 * separately: evidence for one operation never stands in for another. The G08 deployment-digest
 * comparison is operation-independent and is evaluated once, for `DEPLOYMENT_ATTESTATION_OPERATION`.
 */
export function requiredOperations(challengeType: string | null, coveredOperations: readonly string[]): readonly string[] {
  if (challengeType === 'G08') return Object.freeze([DEPLOYMENT_ATTESTATION_OPERATION]);
  return Object.freeze([...new Set(coveredOperations)].sort());
}

export interface PlatformRecord {
  readonly schema: 'rn.conformance.platform/1';
  readonly platformId: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly synthetic: true;
  readonly registeredAt: string;
}

export interface IntegrationVersionRecord {
  readonly schema: 'rn.conformance.integration-version/1';
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly platformId: string;
  readonly organizationId: string;
  readonly sdk: { readonly package: string; readonly version: string; readonly lockDigest: string };
  readonly adapter: { readonly name: string; readonly version: string; readonly digest: string };
  readonly deploymentDigest: string;
  readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
  readonly coveredOperations: readonly string[];
  readonly declaredExclusions: readonly { readonly operation: string; readonly reason: string }[];
  readonly testEndpoints: readonly { readonly endpointId: string; readonly environment: 'synthetic'; readonly fixtureRef: string }[];
  readonly synthetic: true;
  readonly registeredAt: string;
}

export interface ValidatorOperatorRecord {
  readonly schema: 'rn.conformance.validator-operator/1';
  readonly operatorId: string;
  readonly synthetic: true;
  readonly attestation: { readonly statement: typeof SYNTHETIC_OPERATOR_STATEMENT; readonly attestedAt: string };
  readonly registeredAt: string;
}

export interface ValidatorEnrollmentRecord {
  readonly schema: 'rn.conformance.validator-enrollment/1';
  readonly validatorId: string;
  readonly operatorId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly keyValidFrom: string;
  readonly keyValidUntil: string;
  readonly synthetic: true;
  readonly requestedAt: string;
}

export interface ChallengePayload {
  readonly schema: 'rn.conformance.challenge/1';
  readonly challengeId: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly organizationId: string;
  readonly platformId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly controlId: string;
  readonly challengeType: ChallengeType;
  readonly operation: string;
  readonly expectedOutcome: ExpectedOutcome;
  readonly fixtureRef: string;
  readonly issuedAt: string;
  readonly deadline: string;
  readonly assignedValidatorIds: readonly string[];
  readonly synthetic: true;
}

export interface SignedChallenge {
  readonly challenge: ChallengePayload;
  readonly coordinatorSignature: AuthoritySignature;
}

export interface ObservationPayload {
  readonly schema: 'rn.conformance.observation/1';
  readonly eventId: string;
  readonly challengeId: string;
  readonly challengeNonce: string;
  readonly validatorId: string;
  readonly validatorKeyId: string;
  readonly organizationId: string;
  readonly platformId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly observedDeploymentDigest: string | null;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly controlId: string;
  readonly operation: string;
  readonly expectedOutcome: ExpectedOutcome;
  readonly observedOutcome: ObservedOutcome;
  /** The validator's own classification. Recorded, compared, and never used: the engine recomputes it. */
  readonly outcomeClass: OutcomeClass;
  readonly evidenceDigest: string;
  readonly observedAt: string;
  readonly submittedAt: string;
}

export interface ObservationSubmission {
  readonly observation: ObservationPayload;
  readonly validatorSignature: AuthoritySignature;
}

/** An observation after acceptance: signature verified, bound, attributed to its operator, and classified by the engine. */
export interface AcceptedObservation {
  readonly eventId: string;
  readonly challengeId: string;
  readonly validatorId: string;
  readonly operatorId: string;
  readonly controlId: string;
  /** The exact operation the challenge exercised (signed by the coordinator and the validator). */
  readonly operation: string;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  /** Computed by the engine from the challenge's expected outcome and the observed outcome. */
  readonly outcomeClass: OutcomeClass;
  readonly validatorClaimMatches: boolean;
  readonly observedAt: string;
  readonly acceptedAt: string;
  readonly observationDigest: string;
}

export const HUMAN_DECISION_FORMAT = 'frontera.conformance-authority.v1' as const;

export const HUMAN_ACTIONS = Object.freeze(['credential.issue', 'credential.reinstate', 'credential.revoke', 'validator.enroll'] as const);
export type HumanAction = (typeof HUMAN_ACTIONS)[number];

export interface HumanDecisionPayload {
  readonly format: typeof HUMAN_DECISION_FORMAT;
  readonly decisionId: string;
  readonly principalId: string;
  /** Requester (`attest`) or approver (`approve`), inside the signed payload so roles cannot be swapped. */
  readonly role: 'attest' | 'approve';
  readonly action: HumanAction;
  readonly organizationId: string;
  /** The credential id or validator id the action is for. */
  readonly subjectRef: string;
  /** Digest of the exact proposed action (see `lifecycle.ts` / `validator-registry`). */
  readonly actionBindingDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly synthetic: true;
}

export interface SignedHumanDecision {
  readonly decision: HumanDecisionPayload;
  readonly signature: AuthoritySignature;
}

/** A durable reference to a consumed decision, stored in the record it authorized. */
export interface HumanDecisionRef {
  readonly format: typeof HUMAN_DECISION_FORMAT;
  readonly decisionId: string;
  readonly principalId: string;
  readonly role: 'attest' | 'approve';
  readonly decisionDigest: string;
  readonly actionBindingDigest: string;
}

export const RESULT_CATEGORIES = Object.freeze([
  'VERIFIED_SUCCESS',
  'VERIFIED_FAILURE',
  'INSUFFICIENT_EVIDENCE',
  'STALE_EVIDENCE',
  'CONFLICTING',
  'UNCONFIRMED_VIOLATION',
] as const);
export type ResultCategory = (typeof RESULT_CATEGORIES)[number];

export interface RequirementResult {
  readonly requirementId: string;
  readonly severity: 'critical' | 'significant' | 'informational';
  readonly category: ResultCategory;
  readonly reasonCodes: readonly string[];
  readonly conformantOperators: readonly string[];
  readonly violationOperators: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly latestSuccessAt: string | null;
  readonly freshUntil: string | null;
  readonly confirmedFailureAt: string | null;
  readonly investigationDeadline: string | null;
}

export const SUSPENSION_REASONS = Object.freeze(['CRITICAL_VIOLATION_CONFIRMED', 'EVIDENCE_STALE', 'CORROBORATION_UNAVAILABLE', 'CONFLICTING_EVIDENCE'] as const);
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export type EvaluationProposal =
  | { readonly kind: 'NONE'; readonly reasonCode: 'CONFORMANT' | 'UNDER_INVESTIGATION' | 'EVIDENCE_IN_GRACE' | 'NOT_ACTIVE' | 'NOT_ELIGIBLE' }
  | { readonly kind: 'SUSPEND'; readonly ruleId: 'SR-1' | 'SR-2' | 'SR-4'; readonly reasonCode: SuspensionReason }
  | { readonly kind: 'ELIGIBLE_FOR_ACTIVE'; readonly reasonCode: 'ALL_CRITICAL_VERIFIED' };

export interface EvaluationRecord {
  readonly schema: 'rn.conformance.evaluation/1';
  readonly evaluationId: string;
  readonly credentialId: string;
  readonly organizationId: string;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly evaluatedAt: string;
  readonly credentialState: CredentialState;
  readonly credentialStateVersion: number;
  /** Observations before this instant are not counted towards revalidation (the effective time of the last suspension), or `null`. */
  readonly revalidationSince: string | null;
  readonly requirementResults: readonly RequirementResult[];
  readonly proposal: EvaluationProposal;
  readonly criticalFailureConfirmed: boolean;
  readonly evidenceIds: readonly string[];
  readonly synthetic: true;
}

export const TRANSITION_CODES = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const);
export type TransitionCode = (typeof TRANSITION_CODES)[number];

export interface CredentialRecord {
  readonly schema: 'rn.conformance.credential/1';
  readonly credentialId: string;
  readonly organizationId: string;
  readonly platformId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly coveredOperations: readonly string[];
  readonly declaredExclusions: readonly string[];
  readonly createdAt: string;
  readonly candidateUntil: string;
  readonly validUntil: string;
  readonly designation: typeof SYNTHETIC_DESIGNATION;
  readonly synthetic: true;
}

export interface TransitionRecord {
  readonly schema: 'rn.conformance.transition/1';
  readonly transitionId: string;
  readonly credentialId: string;
  readonly organizationId: string;
  readonly stateVersion: number;
  readonly previousTransitionDigest: string | null;
  readonly from: CredentialState | null;
  readonly to: CredentialState;
  readonly transitionCode: TransitionCode;
  readonly reasonCode: string;
  readonly ruleId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly integrationDigest: string;
  readonly evaluationId: string | null;
  readonly evaluationDigest: string | null;
  readonly evidenceIds: readonly string[];
  readonly humanDecisions: readonly HumanDecisionRef[];
  readonly actionBindingDigest: string | null;
  /** Digest of the platform's remediation declaration, for a reinstatement after a confirmed violation; otherwise `null`. */
  readonly remediationDigest: string | null;
  readonly effectiveAt: string;
  readonly synthetic: true;
}

export interface SignedTransition {
  readonly record: TransitionRecord;
  readonly transitionDigest: string;
  readonly registrySignature: AuthoritySignature;
}

/** The committed head of one credential, as the store projects it. Derived only from committed transitions. */
export interface CredentialHead {
  readonly credentialId: string;
  readonly state: CredentialState;
  readonly stateVersion: number;
  readonly headTransitionDigest: string;
  readonly reasonCode: string;
  readonly effectiveAt: string;
}

// ---------------------------------------------------------------------------
// Structural helpers shared by every closed parser.
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

/** RFC 3339 UTC with millisecond precision, in its one canonical spelling. */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b`. Both must be `isSemver`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function toMs(timestamp: string): number {
  return Date.parse(timestamp);
}

export function toTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export type ClosedRead =
  | { readonly ok: true; readonly record: { readonly [key: string]: unknown } }
  | { readonly ok: false; readonly reason: 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'MALFORMED_FIELD'; readonly field: string };

/** Reads a plain object with exactly the `required` keys (plus optionally `optional`). Unknown keys and missing keys are refused by name. */
export function readClosed(value: unknown, required: readonly string[], optional: readonly string[] = []): ClosedRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'MALFORMED_FIELD', field: '$' };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { ok: false, reason: 'MALFORMED_FIELD', field: '$' };
  const record = value as { readonly [key: string]: unknown };
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) return { ok: false, reason: 'UNKNOWN_FIELD', field: key };
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) return { ok: false, reason: 'MISSING_FIELD', field: key };
  return { ok: true, record };
}
