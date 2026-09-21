/**
 * Wire types for the Soberanía Enterprise Host HTTP API (v1, frozen surface).
 *
 * These are structural mirrors of the Host's request/response contracts
 * (see docs/enterprise/API_STABILITY_V1.md). The SDK owns no business
 * logic: every decision, digest, and validation happens server-side.
 */

/** The uniform error envelope returned for enveloped error responses. */
export interface EnterpriseErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
    readonly [key: string]: unknown;
  };
}

// -- health ------------------------------------------------------------------

export interface LivenessResponse {
  readonly live: boolean;
  readonly lifecycleState: string;
}

export interface ReadinessResponse {
  readonly ready: boolean;
  readonly lifecycleState: string;
}

export interface HealthReport {
  readonly status: 'healthy' | 'degraded' | 'unhealthy' | string;
  readonly [key: string]: unknown;
}

// -- governance --------------------------------------------------------------

export interface GovernanceEvaluateRequest {
  readonly actor: {
    readonly id: string;
    readonly trustDomainId: string;
    readonly principalId?: string;
    readonly [key: string]: unknown;
  };
  readonly action: {
    readonly type: string;
    readonly resourceScope: string;
    readonly capability?: string;
    readonly sideEffectType?: string;
    readonly riskLevel?: string;
    readonly [key: string]: unknown;
  };
  readonly organization?: { readonly id: string; readonly [key: string]: unknown };
  readonly context?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export interface GovernanceEvaluateResponse {
  readonly requestId: string;
  readonly decisionId: string;
  readonly status: 'allowed' | 'denied' | 'approval_required' | 'indeterminate' | string;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly trace: { readonly steps: readonly Readonly<Record<string, unknown>>[]; readonly [key: string]: unknown };
  readonly evaluatedAt: string;
  readonly kernelVersion: string;
  readonly correlationId?: string;
  readonly governanceRecord?: { readonly evaluationId: string; readonly aggregateDigest: string };
}

/** A durable governance record as returned by the read endpoints. */
export type GovernanceRecord = Readonly<Record<string, unknown>>;

export type GovernanceVerificationResult = Readonly<Record<string, unknown>> & { readonly valid?: boolean };

// -- governed actions ----------------------------------------------------------

/** A quantity the caller intends to move. */
export interface GovernedActionAmount {
  readonly value: number;
  readonly currency: string;
}

/**
 * Body of `POST /api/governed-actions`: what the caller *intends*, and nothing
 * else.
 *
 * Deliberately **closed** — no index signature — so an object literal carrying
 * `actorId`, `organizationId`, `system`, `adapterId`, `provider`, `url`, a grant
 * or a credential fails to compile. The Host rejects those at runtime too.
 * Actor and organization come from the credential the client was built with,
 * never from this body; the provider that runs is chosen server-side.
 */
export interface GovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly counterparty?: string;
  readonly amount?: GovernedActionAmount;
  /** Evidence the caller *asserts* (e.g. a passport id). The Host verifies it; submitting it does not make it trusted. */
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  /** Required. Scoped server-side to the calling principal: a retry with the same key replays the recorded result. */
  readonly idempotencyKey: string;
}

/** The committed Kernel decision a governed-action result stands on. `status` is the Kernel's closed vocabulary. */
export interface GovernedActionDecisionRef {
  readonly decisionId: string;
  readonly evaluationId: string;
  readonly status: 'allowed' | 'denied' | 'approval_required' | 'indeterminate';
  readonly reasonCodes: readonly string[];
}

/** Why the provider behind the adapter failed — a structural mirror of the Host's closed execution-failure vocabulary. */
export type GovernedActionExecutionFailure = 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_RESPONSE_INVALID' | 'ADAPTER_ERROR';

/** Which gate withheld an allowed-or-pending action. */
export type GovernedActionWithheldBy = 'approval' | 'obligations' | 'grant' | 'authority-binding' | 'grant-terms' | 'exercise' | 'emergency-control';

export type GovernedActionResultStatus = 'executed' | 'denied' | 'indeterminate' | 'withheld' | 'execution_failed' | 'execution_unconfirmed' | 'rejected' | 'system_error';

interface GovernedActionResultBase {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly decision?: GovernedActionDecisionRef;
  readonly executionId?: string;
  readonly reasonCodes: readonly string[];
}

/**
 * What a governed action produced — a domain result, returned by
 * `governAction()` when its wire shape and mapped HTTP status are valid. It
 * never carries a grant, a grant digest, an adapter id or a credential.
 */
export type GovernedActionResult =
  | (GovernedActionResultBase & { readonly status: 'executed'; readonly providerRef?: string; readonly replayed: boolean; readonly outcomeRecorded: boolean })
  | (GovernedActionResultBase & { readonly status: 'denied' })
  | (GovernedActionResultBase & { readonly status: 'indeterminate' })
  | (GovernedActionResultBase & { readonly status: 'withheld'; readonly withheldBy: GovernedActionWithheldBy })
  | (GovernedActionResultBase & { readonly status: 'execution_failed'; readonly failure: GovernedActionExecutionFailure; readonly replayed: boolean; readonly outcomeRecorded: boolean })
  | (GovernedActionResultBase & { readonly status: 'execution_unconfirmed' })
  | (GovernedActionResultBase & { readonly status: 'rejected' })
  | (GovernedActionResultBase & { readonly status: 'system_error' });

// -- evidence ----------------------------------------------------------------

export interface EvidenceBuildRequest {
  readonly evaluationId: string;
  readonly level: 'FULL' | 'AUDITOR' | 'PARTNER' | 'CUSTOMER' | 'PUBLIC' | string;
  readonly createdBy?: string;
}

export type EvidenceBundleResponse = Readonly<Record<string, unknown>>;

export type EvidenceVerificationResult = Readonly<Record<string, unknown>> & { readonly valid?: boolean };

// -- passports ---------------------------------------------------------------

export type AgentPassportSubjectType = 'autonomous_agent' | 'assistant_agent' | 'workflow_agent' | 'decision_agent' | 'service_agent' | 'external_agent';

/** Mirrors `POST /api/passports`'s actual wire shape (nested `subject`/`organization`, top-level `actorId`) -- see `validateIssuePassportRequestBody`. */
export interface IssuePassportRequest {
  readonly subject: {
    readonly agentId: string;
    readonly agentType: AgentPassportSubjectType;
    readonly [key: string]: unknown;
  };
  readonly organization: {
    readonly organizationId: string;
    readonly recognizedBy: string;
    readonly [key: string]: unknown;
  };
  readonly actorId: string;
  readonly actorType?: string;
  readonly activateImmediately?: boolean;
  readonly idempotencyKey?: string;
  readonly [key: string]: unknown;
}

export type AgentPassport = Readonly<Record<string, unknown>>;
export type PassportVerificationResult = Readonly<Record<string, unknown>> & { readonly valid?: boolean };

export type PassportVerifyMode = 'STRUCTURAL' | 'REFERENTIAL' | 'FULL_INTERNAL';

// -- assurance ---------------------------------------------------------------

export interface CreateAssessmentRequest {
  readonly subject: {
    readonly subjectId: string;
    readonly subjectType: string;
    readonly organizationId: string;
  };
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly requestedBy: string;
  readonly [key: string]: unknown;
}

export type AssuranceAssessment = Readonly<Record<string, unknown>> & {
  readonly assessmentId?: string;
  readonly status?: string;
};

export type AssuranceVerificationResult = Readonly<Record<string, unknown>> & { readonly valid?: boolean };

export interface ManualReviewRequest {
  readonly assessmentId: string;
  readonly controlId: string;
  readonly reviewerId: string;
  readonly outcome: 'pass' | 'partial' | 'fail' | 'insufficient_evidence';
  readonly rationale: string;
  readonly reviewerRole?: string;
  readonly evidenceReferenceIds?: readonly string[];
}

export interface AssuranceSignalRequest {
  readonly subjectId: string;
  readonly subjectType: string;
  readonly organizationId: string;
  readonly signalType: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly [key: string]: unknown;
}

export interface ReassessRequest {
  readonly organizationId: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly [key: string]: unknown;
}

// -- client options ------------------------------------------------------------

/** Structural subset of the WHATWG fetch API used by the client (matches Node.js >= 18 global fetch). */
export type FetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: unknown;
  },
) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface EnterpriseHostClientOptions {
  /** Base URL of the Enterprise Host, e.g. `http://127.0.0.1:8080` (no trailing slash required). */
  readonly baseUrl: string;
  /**
   * Bearer token sent as `Authorization: Bearer <apiKey>`. Needed on the legacy
   * routes when the Host runs with AOC_ENTERPRISE_REQUIRE_AUTH=true, and
   * **always** needed for `governAction()`: the governed-action route admits
   * only a customer credential, whatever that flag says.
   */
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds. Default: 30000. The request is aborted and an EnterpriseHostTimeoutError is thrown. */
  readonly timeoutMs?: number;
  /** Custom fetch implementation (testing, instrumentation). Default: globalThis.fetch. */
  readonly fetch?: FetchLike;
}
