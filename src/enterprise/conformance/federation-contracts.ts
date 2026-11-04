import type { ChallengeType } from './contracts.js';

/**
 * RN-CONFORM-05 — federated validator operations: contracts.
 *
 * A validator WITNESSES an authorized challenge and signs an observation. It never decides conformance: classification,
 * corroboration and every credential transition stay with the RN-CONFORM-02 engine and lifecycle, unchanged.
 *
 * Everything here is SYNTHETIC. An operator record names an administrative identity; it does not — and cannot — assert
 * legal or organizational independence. Independence is an administrative fact established by an onboarding process that
 * does not exist yet (CC-D-02 remains open for production). Two processes, two keys or two validator ids under one
 * operator are one corroboration source.
 */

export const FEDERATION_DESIGNATION = 'SYNTHETIC-FEDERATION-NON-PRODUCTION' as const;

/** What every synthetic operator record says about itself, verbatim. */
export const FEDERATION_OPERATOR_STATEMENT =
  'Synthetic federation operator. An administrative test identity only: not a contracted legal entity, not verified as independent of Republika, and not evidence that an independent validator operator exists.' as const;

/**
 * Provisional operational defaults, in ONE place. They are engineering defaults for the synthetic federation, not
 * production SLOs. Heartbeat values follow CREDENTIAL_LIFECYCLE.md §4 (≤ 60 s interval; 5 min missing → unhealthy).
 */
export const FEDERATION_TIMING = Object.freeze({
  heartbeatIntervalSeconds: 60,
  /** No accepted heartbeat for this long → UNREACHABLE (not counted for assignment). */
  heartbeatUnreachableAfterSeconds: 300,
  /** One missed interval → DEGRADED (still assignable). */
  heartbeatDegradedAfterSeconds: 120,
  /** A heartbeat older than this on arrival is refused (replay / delay window). */
  heartbeatMaxAgeSeconds: 120,
  /** A heartbeat dated further ahead than this is refused. */
  clockSkewSeconds: 5,
  /** A presented clock this far behind the store's durable high-water mark is refused (clock regression). */
  clockRegressionToleranceSeconds: 5,
  leaseSeconds: 120,
  maxAttempts: 5,
  backoffBaseSeconds: 5,
  backoffMaxSeconds: 300,
  jitterMaxSeconds: 3,
  /** Routine challenge deadline; ≤ the protocol's 15-minute routine ceiling (coordinator MAX 900 s). */
  routineDeadlineSeconds: 600,
  /** Investigation deadline; ≤ 900 s and inside the engine's 30-minute T_confirm. */
  investigationDeadlineSeconds: 900,
  requalificationDeadlineSeconds: 600,
  /** Routine cadence: one routine job per (requirement, operation) per window. */
  routineWindowSeconds: 3_600,
  /** Bounded queue (F-10). */
  maxOpenJobs: 512,
  /** Authenticated protocol violations by one validator within the window that trigger automatic quarantine. */
  protocolViolationThreshold: 3,
  protocolViolationWindowSeconds: 3_600,
  maxEventDetailBytes: 2_048,
});

// ---------------------------------------------------------------------------
// Operators.
// ---------------------------------------------------------------------------

export const OPERATOR_STATES = Object.freeze(['REGISTERED', 'APPROVED', 'ACTIVE', 'QUARANTINED', 'REVOKED'] as const);
export type OperatorState = (typeof OPERATOR_STATES)[number];

/** Who runs it, administratively. `REPUBLIKA` is Republika's own; `CANDIDATE_EXTERNAL` is a placeholder for a future contracted operator. */
export const OPERATOR_CLASSES = Object.freeze(['REPUBLIKA', 'CANDIDATE_EXTERNAL'] as const);
export type OperatorClass = (typeof OPERATOR_CLASSES)[number];

/** Independence verification. Only `NOT_VERIFIED` exists until an onboarding process is approved (CC-D-02). */
export const INDEPENDENCE_VERIFICATION = 'NOT_VERIFIED' as const;

export interface FederationOperatorRecord {
  readonly schema: 'rn.conformance.federation-operator/1';
  readonly operatorId: string;
  readonly operatorClass: OperatorClass;
  /** An opaque administrative owner reference (no personal data). */
  readonly administrativeOwnerRef: string;
  readonly designation: typeof FEDERATION_DESIGNATION;
  readonly independenceVerification: typeof INDEPENDENCE_VERIFICATION;
  readonly statement: typeof FEDERATION_OPERATOR_STATEMENT;
  readonly registeredAt: string;
  readonly synthetic: true;
}

/** Allowed operator transitions. REVOKED is terminal; an identity is never reused. */
export const OPERATOR_TRANSITIONS: Readonly<Record<OperatorState, readonly OperatorState[]>> = Object.freeze({
  REGISTERED: ['APPROVED', 'REVOKED'],
  APPROVED: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['QUARANTINED', 'REVOKED'],
  QUARANTINED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
});

// ---------------------------------------------------------------------------
// Validators and key generations.
// ---------------------------------------------------------------------------

/**
 * A logical validator is pinned forever to one operator. Its signing keys are GENERATIONS; each generation is its own
 * immutable RN-CONFORM-02 validator identity (`<validatorId>.k<n>`) enrolled under the same operator — so a rotation
 * adds no corroboration vote, every historical observation stays attributable to the generation (and key) that signed
 * it, and a quarantined or revoked generation can never come back.
 */
export const VALIDATOR_STATES = Object.freeze(['ENROLLED', 'ACTIVE', 'QUARANTINED', 'REVOKED'] as const);
export type ValidatorState = (typeof VALIDATOR_STATES)[number];

export const VALIDATOR_TRANSITIONS: Readonly<Record<ValidatorState, readonly ValidatorState[]>> = Object.freeze({
  ENROLLED: ['ACTIVE', 'QUARANTINED', 'REVOKED'],
  ACTIVE: ['QUARANTINED', 'REVOKED'],
  QUARANTINED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
});

export const GENERATION_STATES = Object.freeze(['PENDING', 'ACTIVE', 'RETIRED', 'REVOKED', 'QUARANTINED'] as const);
export type GenerationState = (typeof GENERATION_STATES)[number];

/** The conformance-store identity of generation `n` of `validatorId`. */
export const generationIdentity = (validatorId: string, generation: number): string => `${validatorId}.k${generation}`;

/** Challenge types a validator may execute: G01–G08. G09/G10 are engine-derived conditions, never network probes. */
export const EXECUTABLE_CHALLENGE_TYPES: readonly ChallengeType[] = Object.freeze(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08']);

export interface ValidatorCapabilities {
  readonly challengeTypes: readonly ChallengeType[];
  readonly profiles: readonly { readonly profileId: string; readonly profileVersion: string }[];
}

export interface FederationValidatorRecord {
  readonly schema: 'rn.conformance.federation-validator/1';
  readonly validatorId: string;
  readonly operatorId: string;
  readonly capabilities: ValidatorCapabilities;
  readonly registeredAt: string;
  readonly synthetic: true;
}

/** The statement a validator signs to prove possession of the private key it asks to enroll. */
export interface KeyPossessionStatement {
  readonly schema: 'rn.conformance.validator-key-possession/1';
  readonly requestId: string;
  readonly validatorId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly keyId: string;
  readonly nonce: string;
  readonly synthetic: true;
}

export const ENROLLMENT_REQUEST_KINDS = Object.freeze(['ENROLL', 'ROTATE', 'REINSTATE'] as const);
export type EnrollmentRequestKind = (typeof ENROLLMENT_REQUEST_KINDS)[number];

// ---------------------------------------------------------------------------
// Heartbeats and health.
// ---------------------------------------------------------------------------

export const HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNREACHABLE', 'QUARANTINED', 'REVOKED'] as const);
export type HealthState = (typeof HEALTH_STATES)[number];

export interface ValidatorHeartbeat {
  readonly schema: 'rn.conformance.validator-heartbeat/1';
  readonly validatorId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly keyId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly emittedAt: string;
  readonly operationalState: 'READY' | 'DRAINING';
  readonly capabilities: ValidatorCapabilities;
  readonly synthetic: true;
}

export const HEARTBEAT_REFUSALS = Object.freeze([
  'MALFORMED_HEARTBEAT',
  'UNKNOWN_VALIDATOR',
  'VALIDATOR_REVOKED',
  'VALIDATOR_QUARANTINED',
  'OPERATOR_NOT_ACTIVE',
  'OPERATOR_MISMATCH',
  'GENERATION_NOT_ACTIVE',
  'KEY_MISMATCH',
  'KEY_NOT_ELIGIBLE',
  'SIGNATURE_INVALID',
  'SESSION_MISMATCH',
  'CAPABILITY_MISMATCH',
  'SEQUENCE_REPLAYED',
  'EQUIVOCATION',
  'STALE_HEARTBEAT',
  'FUTURE_DATED',
  'CLOCK_ROLLBACK',
] as const);
export type HeartbeatRefusal = (typeof HEARTBEAT_REFUSALS)[number];

// ---------------------------------------------------------------------------
// Scheduling.
// ---------------------------------------------------------------------------

export const JOB_STATES = Object.freeze(['PENDING', 'LEASED', 'DISPATCHED', 'COMPLETED', 'RETRY_PENDING', 'EXPIRED', 'FAILED_FINAL', 'CANCELLED'] as const);
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze(['COMPLETED', 'EXPIRED', 'FAILED_FINAL', 'CANCELLED']);

export const JOB_PURPOSES = Object.freeze(['ROUTINE', 'INVESTIGATION', 'DISPUTE', 'REQUALIFICATION'] as const);
export type JobPurpose = (typeof JOB_PURPOSES)[number];

/** A signed-off, time-boxed authorization to challenge one synthetic integration. Without one, nothing is scheduled. */
export interface TestingAuthorization {
  readonly schema: 'rn.conformance.testing-authorization/1';
  readonly authorizationId: string;
  readonly organizationId: string;
  readonly integrationDigest: string;
  /**
   * `CONFORMANCE`: challenges whose evidence counts for the integration's credential. `REQUALIFICATION`: probation
   * challenges for a reinstating validator, allowed only against a fixture integration that has NO credential, so a
   * still-untrusted generation's observation can never become a vote on a real credential (review P1-2).
   */
  readonly purpose: 'CONFORMANCE' | 'REQUALIFICATION';
  readonly environment: 'synthetic';
  readonly fixtureRefs: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly synthetic: true;
}

export interface JobAssignment {
  readonly validatorId: string;
  readonly generation: number;
  readonly conformanceValidatorId: string;
  readonly operatorId: string;
}

export interface ScheduledJob {
  readonly jobId: string;
  readonly purpose: JobPurpose;
  readonly organizationId: string;
  readonly integrationDigest: string;
  readonly challengeType: ChallengeType;
  readonly operation: string;
  readonly fixtureRef: string;
  readonly authorizationId: string;
  readonly assignments: readonly JobAssignment[];
  readonly requiredOperators: number;
  readonly deadlineSeconds: number;
  readonly state: JobState;
  readonly attempts: number;
  readonly nextAttemptMs: number;
  readonly challengeId: string | null;
  /** The issued challenge's deadline, write-once with `challengeId`. A retry never moves it. */
  readonly challengeDeadlineMs: number | null;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresMs: number | null;
  readonly createdMs: number;
  readonly updatedMs: number;
  readonly lastError: string | null;
}

/** What a lease holder presents to commit anything about its job. */
export interface JobLease {
  readonly jobId: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly expiresMs: number;
}

// ---------------------------------------------------------------------------
// Operational events.
// ---------------------------------------------------------------------------

export const FEDERATION_EVENT_KINDS = Object.freeze([
  'OPERATOR_REGISTERED',
  'OPERATOR_APPROVED',
  'OPERATOR_ACTIVATED',
  'OPERATOR_QUARANTINED',
  'OPERATOR_REINSTATED',
  'OPERATOR_REVOKED',
  'VALIDATOR_REGISTERED',
  'KEY_POSSESSION_VERIFIED',
  'KEY_POSSESSION_REFUSED',
  'KEY_REGISTERED',
  'KEY_ACTIVATED',
  'VALIDATOR_ENROLLED',
  'VALIDATOR_ACTIVATED',
  'KEY_ROTATION_STARTED',
  'KEY_ROTATION_COMPLETED',
  'KEY_REVOKED',
  'HEARTBEAT_ACCEPTED',
  'HEARTBEAT_REFUSED',
  'HEARTBEAT_MISSED',
  'JOB_SCHEDULED',
  'LEASE_ACQUIRED',
  'LEASE_EXPIRED',
  'LEASE_FENCED',
  'CHALLENGE_DISPATCHED',
  'DISPATCH_RETRY',
  'JOB_COMPLETED',
  'JOB_EXPIRED',
  'JOB_FAILED',
  'JOB_CANCELLED',
  'OBSERVATION_ACCEPTED',
  'OBSERVATION_REJECTED',
  'VALIDATOR_QUARANTINED',
  'REQUALIFICATION_SCHEDULED',
  'REQUALIFICATION_PASSED',
  'VALIDATOR_REINSTATED',
  'VALIDATOR_REVOKED',
  'QUORUM_INSUFFICIENT',
  'INVESTIGATION_SCHEDULED',
  'DISPUTE_ESCALATED',
  'QUEUE_FULL',
  'REGISTRY_DIVERGENCE',
] as const);
export type FederationEventKind = (typeof FEDERATION_EVENT_KINDS)[number];

/** A bounded, redacted internal event: identifiers and reason codes only — never keys, content or personal data. */
export interface FederationEvent {
  readonly seq: number;
  readonly kind: FederationEventKind;
  readonly atMs: number;
  readonly subjectKind: 'operator' | 'validator' | 'job' | 'federation';
  readonly subjectId: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}
