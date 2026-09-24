# Soberanía Enterprise HTTP API -- v1 Stability Contract

> This document freezes the public HTTP surface of the Soberanía Enterprise Host
> for the v1.0.0 release. The implementation source of truth is
> `src/enterprise/adapters/node-http-adapter.ts` (routing) and
> `src/enterprise/api/` (wire contracts: `governance-evaluate-contract.ts`,
> `evidence-contract.ts`, `passport-contract.ts`, `assurance-contract.ts`,
> `governed-action-contract.ts`, `enterprise-http-errors.ts`). Anything documented here is contract;
> anything not documented here is not.

## 1. Versioning Policy

The API surface catalogued in section 2 is **FROZEN for v1.x**:

- **No breaking changes** within v1.x: no removed endpoints, no removed
  response fields, no changed HTTP status codes for existing behaviors.
- **Additive changes only** within v1.x: new endpoints, new *optional*
  request fields, new response fields. Clients MUST tolerate unknown
  response fields.
- **Breaking changes require a `/v2` path prefix** and a major version
  bump. The unprefixed v1 paths keep their v1 semantics for the life of
  the major version.

Error **codes** (`error.code`, section 3) are contract. Error **message
strings** (`error.message`) and validation `details` strings are *not*
contract -- they may be reworded in any release and MUST NOT be parsed.

The following schema version constants are **frozen identifiers**. They
appear inside stored records and wire responses (`metadata.schemaVersion`,
`integrity.canonicalizationVersion`, and equivalents) and will not change
meaning within v1.x; a new schema gets a new identifier:

| Identifier | Defined in |
| --- | --- |
| `aoc.governance-store.schema.v1` | `src/enterprise/governance-store/contracts.ts` |
| `evidence.bundle.v1` | `src/enterprise/evidence/contracts.ts` |
| `aoc.agent-passport.schema.v1` | `src/enterprise/passport/contracts.ts` |
| `aoc.assurance-store.schema.v1` | `src/enterprise/assurance/contracts.ts` |
| `aoc.canonical-json.v1` | `src/enterprise/governance-store/canonical-json.ts` |

## 2. Endpoint Catalog

Conventions used below:

- All request and response bodies are JSON (`content-type:
  application/json; charset=utf-8` on every response).
- "Required" means the HTTP-layer validator rejects the request with
  `400 INVALID_REQUEST` (envelope per section 3, with per-field `details`)
  when the field is missing, empty, or of the wrong shape. The owning
  service performs deeper domain validation on top of this and reports its
  own error codes (e.g. `PASSPORT_VALIDATION_ERROR`,
  `ASSURANCE_VALIDATION_ERROR`).
- Every route can additionally produce the cross-cutting errors of
  section 4 (body cap, malformed JSON, malformed percent-encoding) and,
  when authentication is enabled, `401 AUTHENTICATION_FAILED`. Store-backed
  routes can produce their store's `*_UNAVAILABLE` (503) and integrity
  (500) codes. These are not repeated in every row.
- Authentication (all `/api/*` routes **except** `POST /api/governed-actions`,
  section 2.6, which always requires a customer credential): when
  `AOC_ENTERPRISE_REQUIRE_AUTH=true`, a Bearer token matching a configured
  API key is required (401 otherwise). An organization-scoped key is
  confined to that organization's records (violations surface as the
  module's 403 `*_ACCESS_SCOPE_VIOLATION` code, or `403
  AUTHORIZATION_FAILED` on evaluate); an unscoped key has system scope.
  When authentication is disabled (the default), every caller has system
  scope. See `resolveGovernanceAccessContext` in
  `src/enterprise/orchestration/governance-read-service.ts`.

### 2.1 Health

| Method + Path | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /health` | Full health report (version, persistence, providers, configuration checksum). | `200` with `EnterpriseHealthReport` when `healthy`/`degraded` | `503` with the same report body when `unhealthy` |
| `GET /live` | Liveness probe. | `200` `{ "live": true, "lifecycleState": "..." }` | `503` `{ "live": false, "lifecycleState": "..." }` |
| `GET /ready` | Readiness probe. | `200` `{ "ready": true, "lifecycleState": "..." }` | `503` `{ "ready": false, "lifecycleState": "..." }` |

No request body, no authentication, no idempotency semantics. Note that
`/health`'s 503 carries the health report itself, not an error envelope.

### 2.2 Governance

#### `POST /api/governance/evaluate`

Evaluates a governance request through the Kernel and durably commits the
result as one Governance Store aggregate before responding.

Request fields (`GovernanceEvaluateRequestBody`):

- **Required:** `actor.id`, `actor.trustDomainId`, `action.type`,
  `action.resourceScope` (all non-empty strings).
- **Optional:** `requestId`, `correlationId` (non-empty string when
  present), `requestedAt`, `target`, `organization` (object with non-empty
  `id` when present), `context` (object), `idempotencyKey` (forwarded onto
  the `KernelEvaluationRequest`; distinct from the transport
  `Idempotency-Key` header below), `expiresAt`, `approvalProofId`,
  `approvalRequestId`, `approvalDecisionId`, `visaId`, `ingressGrantId`,
  `handshakeProofId`, `traceLevel` (`'basic' | 'full'`), `dryRun`
  (boolean). Omitted `requestId`/`requestedAt` are filled in by the Host.

Success statuses are derived from the Kernel's decision `status` -- a
governance denial is a successful evaluation, never an error envelope:

| Kernel `status` | HTTP |
| --- | --- |
| `allowed`, `approval_required` | `200` |
| `denied` | `422` |
| `indeterminate` (recognition-provider fault) | `503` |

All four carry the same body (`GovernanceEvaluateResponseBody`):
`requestId`, `decisionId`, `status`, `summary`, `reasonCodes`, `trace`,
`evaluatedAt`, `kernelVersion`, plus optional `correlationId` and
`governanceRecord` (`{ evaluationId, aggregateDigest }`).

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Shape validation failure, Kernel validation failure, malformed JSON, body over 1 MiB |
| 401 | `AUTHENTICATION_FAILED` | Auth enabled and token missing/unrecognized |
| 403 | `AUTHORIZATION_FAILED` | Org-scoped key used for a request naming a different `organization.id` |
| 409 | `CONCURRENCY_CONFLICT` | Same `requestId` resubmitted with a different payload |
| 409 | `GOVERNANCE_IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` reused with a different payload |
| 413 | `GOVERNANCE_RECORD_TOO_LARGE` | Store-level payload/trace/event caps exceeded |
| 500 | `INFRASTRUCTURE_FAILURE`, `GOVERNANCE_STORE_TRANSACTION_FAILED`, `GOVERNANCE_STORE_VALIDATION_ERROR`, `GOVERNANCE_RECORD_CORRUPTED` | Kernel/commit/store faults |
| 503 | `ENTERPRISE_NOT_READY` (with `lifecycleState` in the error body), `GOVERNANCE_STORE_UNAVAILABLE` | Lifecycle not ready; store unreachable |

**Idempotency:** the `Idempotency-Key` **header** is this route's
transport idempotency mechanism. Keys are scoped per organization
(`org:{id}`, or a shared `global` scope when the request names no
organization). Replaying the same key with an equivalent payload returns
the originally persisted decision without re-running the Kernel; the same
key with a different payload is `409 GOVERNANCE_IDEMPOTENCY_CONFLICT`. No
successful response is ever returned unless the Governance Store commit
succeeded.

#### Governance reads

| Method + Path | Purpose | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/governance/evaluations/{id}` | Fetch the `GovernanceRecord` by `evaluationId`. | `200` `GovernanceRecord` | `404 GOVERNANCE_RECORD_NOT_FOUND`; `403 GOVERNANCE_ACCESS_SCOPE_VIOLATION`; `500 GOVERNANCE_RECORD_CORRUPTED`; `503 GOVERNANCE_STORE_UNAVAILABLE` |
| `GET /api/governance/evaluations/{id}/verify` | Re-verify a stored record's digests. | `200` `GovernanceRecordVerificationResult` (`evaluationId`, `valid`, `checks.*`, `verifiedAt`, `failures`). **Always 200 when the record exists -- `valid: false` is reported in the body, not via status code.** | Same as above |
| `GET /api/governance/decisions/{id}` | Fetch by `decisionId`. | `200` `GovernanceRecord` | Same as above |
| `GET /api/governance/requests/{id}` | Fetch by `requestId`. | `200` `GovernanceRecord` | Same as above |

No request bodies, no idempotency semantics (reads).

### 2.3 Evidence Bundles

| Method + Path | Purpose | Request fields | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /api/evidence/build` | Build and store an Evidence Bundle from a stored evaluation. | Required: `evaluationId`, `level`. Optional: `createdBy`. | `201` `{ bundle, state, storedAt, supersededBy? }` | `400 INVALID_REQUEST` / `EVIDENCE_VALIDATION_ERROR` / `EVIDENCE_DISCLOSURE_POLICY_UNKNOWN`; `403 EVIDENCE_ACCESS_SCOPE_VIOLATION` / `EVIDENCE_TENANT_SCOPE_REQUIRED`; `404 EVIDENCE_SOURCE_RECORD_NOT_FOUND`; `409 EVIDENCE_BUNDLE_ALREADY_EXISTS`; `503 EVIDENCE_STORE_UNAVAILABLE` |
| `POST /api/evidence/verify` | Re-verify a stored Bundle's digests. | Required: `bundleId`. | `200` `EvidenceVerificationResult` (`bundleId`, `valid`, `checks.*`, `verifiedAt`, `failures`). **Always 200 when the Bundle exists; `valid: false` is in the body.** | `400 INVALID_REQUEST`; `404 EVIDENCE_BUNDLE_NOT_FOUND`; `403`; `503` as above |
| `GET /api/evidence/{bundleId}` | Fetch a stored Bundle. | -- | `200` `{ bundle, state, storedAt, supersededBy? }` | `404 EVIDENCE_BUNDLE_NOT_FOUND`; `403`; `503` as above |

No idempotency semantics.

### 2.4 Agent Passports

#### `POST /api/passports` -- issue

Request fields:

- **Required:** `subject.agentId`; `subject.agentType` (one of
  `autonomous_agent`, `assistant_agent`, `workflow_agent`,
  `decision_agent`, `service_agent`, `external_agent`);
  `organization.organizationId`; `organization.recognizedBy`; `actorId`.
- **Optional:** `actorType`, `activateImmediately` (boolean),
  `capabilities` (array), `authorities` (array), `delegations` (array),
  `sourceIdentityRecord`, `idempotencyKey` (non-empty string).

Success: `201` when a new Passport was issued, `200` when an identical
prior issuance was replayed. Body: `{ passport, created }` (`created:
false` on replay).

**Idempotency:** the body `idempotencyKey` field, scoped to the issuing
organization. Same key + equivalent input replays (`200`, `created:
false`); same key + different input is `409
PASSPORT_IDEMPOTENCY_CONFLICT`. Duplicate issuance without a key is `409
PASSPORT_ALREADY_EXISTS`.

Errors: `400 INVALID_REQUEST` / `PASSPORT_VALIDATION_ERROR`; `403
PASSPORT_TENANT_SCOPE_REQUIRED` / `PASSPORT_ACCESS_SCOPE_VIOLATION`;
`409` as above; `422 PASSPORT_VERSION_UNSUPPORTED`; `500
PASSPORT_INTEGRITY_FAILED`; `503 PASSPORT_STORE_UNAVAILABLE`.

#### Passport reads

| Method + Path | Success | Errors |
| --- | --- | --- |
| `GET /api/passports/{id}` | `200` with the raw `AgentPassportLoadResult` (`status: 'complete'`, `passport`, `missingComponents`, `integrityFailures`) | `404 PASSPORT_NOT_FOUND`; **`500` with the raw load result body (`status: 'incomplete' | 'corrupted'`) -- see section 3, non-enveloped responses**; `403`; `503` |
| `GET /api/passports/{id}/events` | `200` `{ passportId, events }` (the full event chain) | `404 PASSPORT_NOT_FOUND`; `403`; `503` |
| `GET /api/passports/{id}/history` | `200` `AgentPassportHistorySummary` (referenced-decision/evidence counters, suspensions, revocations, `lastGovernedActivityAt?`) | `404 PASSPORT_NOT_FOUND`; `403`; `503` |

#### `POST /api/passports/{id}/{action}` -- lifecycle, linking, verification, views

All nine actions share the common Passport errors: `404
PASSPORT_NOT_FOUND`, `403 PASSPORT_ACCESS_SCOPE_VIOLATION` /
`PASSPORT_TENANT_SCOPE_REQUIRED`, `409
PASSPORT_INVALID_STATE_TRANSITION` (lifecycle actions), `500
PASSPORT_INTEGRITY_FAILED`, `503 PASSPORT_STORE_UNAVAILABLE`. None have
idempotency semantics.

| Action | Request fields | Success | Action-specific errors |
| --- | --- | --- | --- |
| `activate` | Required: `actorId`. | `200` updated `AgentPassport` | `409 PASSPORT_INVALID_STATE_TRANSITION` |
| `suspend` | Required: `suspendedBy`. Optional: `reason`, `expectedReviewAt`, `evidenceBundleId`. | `200` `AgentPassport` | `409 PASSPORT_INVALID_STATE_TRANSITION` |
| `reactivate` | Required: `reactivatedBy`. | `200` `AgentPassport` | `409 PASSPORT_INVALID_STATE_TRANSITION` |
| `revoke` | Required: `reasonCode`, `reason`, `revokedBy`. Optional: `evidenceBundleId`. | `200` `AgentPassport` | `409 PASSPORT_ALREADY_REVOKED` |
| `retire` | Required: `retiredBy`. Optional: `reason`. | `200` `AgentPassport` | `409 PASSPORT_INVALID_STATE_TRANSITION` |
| `verify` | Optional: `mode` (`'STRUCTURAL' | 'REFERENTIAL' | 'FULL_INTERNAL'`). Empty body allowed. | `200` `AgentPassportVerificationResult` (`passportId`, `valid`, `status`, `mode`, `checks.*`, `failures`, ...) when `valid: true` | **`409` with the same raw result body when `valid: false` -- see section 3, non-enveloped responses** |
| `evidence` | Required: `reference` (object), `actorId`. | `200` `AgentPassport` | `400 PASSPORT_REFERENCE_INVALID`; `404 PASSPORT_EVIDENCE_NOT_FOUND` |
| `governance` | Required: `reference` (object), `actorId`. | `200` `AgentPassport` | `400 PASSPORT_REFERENCE_INVALID`; `404 PASSPORT_GOVERNANCE_RECORD_NOT_FOUND` |
| `views` | Required: `viewType`, `generatedBy` (non-empty strings; the service further constrains `viewType` to `INTERNAL`/`AUDITOR`/`PARTNER`/`CUSTOMER`/`PUBLIC`). | `201` `AgentPassportView` (derived disclosure projection with its own `integrity.viewDigest`) | `400 PASSPORT_VALIDATION_ERROR` for an unknown view type |

### 2.5 Assurance

For every `/api/assurance/*` path, the access context is resolved *before*
route matching: with authentication enabled, an unauthenticated request to
any path under `/api/assurance/` returns `401` even if the path matches no
route. All routes share `403 ASSURANCE_ACCESS_SCOPE_VIOLATION` /
`ASSURANCE_TENANT_SCOPE_REQUIRED`, `500 ASSURANCE_INTEGRITY_FAILED`, and
`503 ASSURANCE_STORE_UNAVAILABLE`. No Assurance route has idempotency
semantics.

| Method + Path | Purpose | Request fields | Success | Route-specific errors |
| --- | --- | --- | --- | --- |
| `POST /api/assurance/assessments` | Create an assessment. | Required: `subject.subjectId`; `subject.subjectType` (one of `enterprise`, `organization`, `workspace`, `agent`, `passport`, `system`, `process`, `solution`); `subject.organizationId`; `frameworkId`; `frameworkVersion`; `requestedBy`. Optional: `domainIds[]`, `controlIds[]`, `from`, `to`, `evidenceCutoffAt`, `includeHistoricalEvidence` (boolean), `purpose`. | `201` `AssuranceAssessment` | `400 ASSURANCE_SCOPE_INVALID` / `ASSURANCE_FRAMEWORK_INVALID` / `ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED` / `ASSURANCE_VALIDATION_ERROR`; `404 ASSURANCE_FRAMEWORK_NOT_FOUND` |
| `POST /api/assurance/assessments/{id}/evaluate` | Run control evaluation; by default also attempt completion. | Optional: `complete` (boolean, default `true`; when completing, assessments with pending manual reviews stay in `manual_review`). Empty body allowed. | `200` `AssuranceAssessment` | `404 ASSURANCE_ASSESSMENT_NOT_FOUND` / `ASSURANCE_CONTROL_NOT_FOUND`; `409 ASSURANCE_ASSESSMENT_IMMUTABLE` / `ASSURANCE_ASSESSMENT_INCOMPLETE`; `422 ASSURANCE_EVIDENCE_INSUFFICIENT` / `ASSURANCE_EVIDENCE_CONTRADICTORY` / `ASSURANCE_MANUAL_REVIEW_REQUIRED` / `ASSURANCE_ELIGIBILITY_NOT_SATISFIED`; `500 ASSURANCE_CONTROL_EVALUATION_FAILED` |
| `POST /api/assurance/assessments/{id}/verify` | Re-verify a stored assessment. Request body is ignored. | -- | `200` `AssuranceAssessmentVerificationResult` (`assessmentId`, `valid`, `checks.*`, `failures`, `verifiedAt`) when `valid: true` | **`409` with the same raw result body when `valid: false` -- see section 3**; `404 ASSURANCE_ASSESSMENT_NOT_FOUND` |
| `GET /api/assurance/assessments/{id}/findings` | List an assessment's findings. | -- | `200` `{ assessmentId, findings }` (full collection) | `404 ASSURANCE_ASSESSMENT_NOT_FOUND` |
| `GET /api/assurance/assessments/{id}` | Fetch an assessment. | -- | `200` `AssuranceAssessment` | `404 ASSURANCE_ASSESSMENT_NOT_FOUND` |
| `POST /api/assurance/findings/{id}/events` | Append a finding lifecycle event. | Required: `eventType` (one of `AssuranceFindingCreated`, `AssuranceFindingAccepted`, `AssuranceRemediationPlanned`, `AssuranceFindingRemediated`, `AssuranceFindingClosed`, `AssuranceFindingSuperseded`, `AssuranceFindingReopened`); `actorId`. Optional: `rationale`, `payload` (object). | `201` `AssuranceFindingEvent` | `404 ASSURANCE_FINDING_NOT_FOUND`; `409 ASSURANCE_INVALID_FINDING_TRANSITION` |
| `POST /api/assurance/manual-reviews` | Record a manual control review. | Required: `assessmentId`, `controlId`, `reviewerId`, `rationale`, `outcome` (one of `pass`, `partial`, `fail`, `insufficient_evidence`). Optional: `reviewerRole`, `evidenceReferenceIds[]`. | `201` `AssuranceManualReviewRecord` | `400 ASSURANCE_MANUAL_REVIEW_INVALID`; `404 ASSURANCE_ASSESSMENT_NOT_FOUND` / `ASSURANCE_CONTROL_NOT_FOUND`; `409 ASSURANCE_ASSESSMENT_IMMUTABLE` |
| `POST /api/assurance/signals` | Ingest a continuous-assurance signal. | Required: `organizationId`, `subjectId`, `subjectType`, `signalType` (a supported `AssuranceSignalType`, see `ASSURANCE_SIGNAL_TYPES` in `src/enterprise/assurance/contracts.ts`), `sourceType` (an `AssuranceEvidenceType`, see `ASSURANCE_EVIDENCE_TYPES` there), `sourceId`, `occurredAt`. Optional: `observedAt` (defaults to `occurredAt`), `sourceDigest`, `affectedControlIds[]`, `affectedDomainIds[]`, `payload` (object). | `201` `AssuranceSignalProcessingResult` (`signalId`, `outcomes`, `affectedAssessmentIds`, `detail`, `processedAt`) | `400 ASSURANCE_SIGNAL_INVALID`; `403 ASSURANCE_ACCESS_SCOPE_VIOLATION` for a cross-org `organizationId` |
| `GET /api/assurance/subjects/{id}/state?frameworkId=&frameworkVersion=` | Derived continuous-assurance state. Both query parameters optional (latest completed assessment used when omitted). | -- | `200` `ContinuousAssuranceState` (`subjectId`, `frameworkId`, `frameworkVersion`, `latestCompletedAssessmentId?`, `state`, `openFindingCounts`, `activeSignalIds`, `eligibilityState?`, `staleReasons`, `updatedAt`) | -- |
| `POST /api/assurance/subjects/{id}/reassess` | Request a reassessment (creates a new assessment). | Required: `reason`, `requestedBy`. Optional: `assessmentId`, `evidenceCutoffAt`. | `201` `AssuranceAssessment` | `404 ASSURANCE_ASSESSMENT_NOT_FOUND` / `ASSURANCE_SUBJECT_NOT_FOUND` / `ASSURANCE_FRAMEWORK_NOT_FOUND` |

### 2.6 Governed Actions (capability-gated; added in 1.3.0)

#### `POST /api/governed-actions`

The customer-facing entry to the canonical governed-execution path:

```
Authorization: Bearer <customer credential>
  -> customer identity admission -> BoundCustomerIdentity
  -> Governed Action Orchestrator: Kernel decision -> committed Governance Record
     -> bounded grant -> exercise -> trusted server-side adapter routing -> provider
```

The route exposes the **top** of that path and nothing below it. A caller can
never receive, name or exercise a bounded grant, choose an adapter or
provider, or read or change an emergency control.

**1.4.0 (P6) adds no endpoint and no request field.** A deployment may compose
Generic HTTP Execution Adapters (`executionAdapterRouting.genericHttpAdapters`,
see `AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`) as server-side registry children;
the destination, method, headers, credential and payload of that outbound
request are operator configuration and are never expressible in this request.
The frozen surface stays 28 endpoints. The only wire-visible change is one
additional `reasonCodes` value on the existing `execution_unconfirmed` status
(below); the SDK needs no change and stays `1.1.0`.

**1.5.0 (P7) adds no endpoint, no request field, no status and no `withheldBy`
value.** A deployment may compose aggregate / velocity exercise controls
(`authorityControlledExecution.exerciseControls`, see `AOC_EXERCISE_CONTROLS.md`).
A refusal by them is reported on the existing `withheld` status with the
existing `withheldBy: "exercise"` and `EXERCISE_CONTROL_*` reason codes; no
limit, bucket, reservation or remaining quota is ever returned. The intent's
declared fields are unchanged; the list of reserved `assertedContext` keys grows
by the P7 names (`limit`, `quota`, `budget`, `window`, `reservationId`,
`exerciseControls`, `authorityBindingDigest`, …), which were never meaningful
there and are now rejected rather than ignored. The frozen surface stays 28
endpoints; the SDK stays `1.1.0`.

**1.6.0 (P8) adds no endpoint, no request field, no response field, no status,
no reason code and no `withheldBy` value.** When governed actions are composed,
the Host also records each governed action's lifecycle as a canonical authority
event stream (`AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md`) — internal evidence,
readable only by trusted in-process code through
`AocEnterprise.authorityEventStream`, and never read by anything that decides. No
route, webhook, SSE or SDK method exposes it, and the governed-action result is
byte-identical with or without it. The frozen surface stays 28 endpoints; the
SDK stays `1.1.0`.

**P9 (unreleased) adds no endpoint, no request field, no response field, no
status and no `withheldBy` value, and keeps every v1 request spelling.**
`amount.value` may be written, as in v1, as a JSON number — or, additively, as
decimal text. Either way the Host reads it **exactly**: for this route and for
`action.amount` on `POST /api/governance/evaluate` the body is parsed with the
platform's JSON source-text access, so the characters the client wrote become
canonical decimal text without ever passing through an IEEE-754 double
(`9007199254740993` stays `9007199254740993`; `7.5e3` is `7500`). The SDK's
`GovernedActionAmount.value` widens additively to `string | number`. What P9
adds is **validation of the amount against host configuration**: the currency
must be an asset the Host's `monetary.assets` recognizes, the value may not
exceed that asset's scale (refused, never rounded), and only an action the
Host's `monetary.financialActions` lists may carry an amount (and must) — each a
`400` `rejected` / `GOVERNED_ACTION_INTENT_INVALID`, the status and code the
route has always used for an invalid intent. A deployment adopting P9 states its
assets and financial actions; without them no amount is valid. `financial`,
`actionClass`, `classification`, `scale` and `assetScale` join the reserved
`assertedContext` keys; one exercise-control reason code is added
(`EXERCISE_CONTROL_ACTION_CLASS_MISMATCH`, reported on the existing
`withheld` / `withheldBy: "exercise"`). The only form that has no exact meaning —
an in-process `AocEnterprise.governAction` call handing over an already-parsed
JavaScript number, for which no source text exists — is refused. The frozen
surface stays 28 endpoints.

**P11 (unreleased) adds no endpoint, no request field, no response field, no
status, no reason code and no `withheldBy` value.** Every governed execution's
exact context and initial provider observation become durable in an internal
execution outcome store (`docs/architecture/ADR-DURABLE-MONETARY-OUTCOMES.md`),
readable only by trusted in-process code through `AocEnterprise.executionOutcomes`.
Three wire-visible consequences follow, all inside the existing contract:

- A **replayed** `executed` result now carries the `providerRef` its original
  observation recorded, through the existing optional field. Before P11,
  replay omitted it.
- `outcomeRecorded` keeps its shape. It now means the canonical outcome
  observation is durable, so a lost Governance summary row alone no longer
  reports `false`. A replay whose canonical record cannot be read or verified is
  the existing `execution_unconfirmed` / `GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED`.
  A preparation that cannot be written before the claim is the existing
  `system_error` / `GOVERNED_ACTION_EXECUTION_CLAIM_FAILED`.
- `providerRef`, `providerStatus`, `providerCertainty`, `certainty`,
  `executionOutcome`, `executionStatus` and `outcomeRecorded` join the reserved
  `assertedContext` keys (`400` `rejected` / `GOVERNED_ACTION_INTENT_INVALID`). A
  caller can never report a provider result.

A `providerRef` shaped like a credential, JWT, PEM block, URL, cookie or
authorization header is no longer returned: it is omitted, and the status is
unchanged. `execution_failed` and `execution_unconfirmed` keep their v1 shapes.
The references P11 keeps for them are internal. The SDK needs no change.

**P12 (unreleased) adds no endpoint, no request field, no response field, no
status, no reason code and no `withheldBy` value.** An optional, host-composed
execution reconciliation (`docs/architecture/ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md`)
lets a trusted resolution authority later establish whether an execution the
first observation left uncertain completed; it is reachable only by trusted
in-process code (`AocEnterprise.executionReconciliation`,
`AocEnterprise.executionResolutions`). Wire-visible consequences, all inside
the existing contract and only when a deployment enables it:

- A **replayed** result for an execution that was `execution_unconfirmed` may
  now be `executed` (with `providerRef`) or `execution_failed` (with one of the
  existing four `failure` values) once a definitive resolution is on record.
  Nothing is re-executed to learn it, and replay never contacts a provider.
- `outcomeRecorded` keeps its type and shape. Its truthful meaning widens:
  `true` means the result replayed here is backed by a canonical durable
  execution fact — the P11 initial observation **or** a P12 definitive
  resolution.
- A new governed execution whose resolution authority cannot be durably bound
  is the existing `system_error` / `GOVERNED_ACTION_EXECUTION_CLAIM_FAILED`,
  before any claim or provider call — the same answer as a failed P11
  preparation, and equally safe to retry.
- `resolution`, `resolved`, `reconciled`, `reconciliation`,
  `resolutionAuthority`, `resolutionAuthorityId`, `providerResolution`,
  `providerOutcome`, `finalOutcome`, `confirmedCompleted` and
  `confirmedNotCompleted` join the reserved `assertedContext` keys (`400`
  `rejected` / `GOVERNED_ACTION_INTENT_INVALID`). A caller can never report a
  resolution.

No resolution authority id, resolution digest, reservation or budget
correction is ever part of a response. The SDK needs no change.

**P13 (unreleased) adds no endpoint, no request field, no response field, no
status, no reason code and no `withheldBy` value.** An optional, host-composed
MPP challenge adapter (`docs/architecture/ADR-MPP-CHALLENGE-AND-BUSINESS-IDEMPOTENCY.md`)
turns a merchant's `402` `Payment` challenge into an ordinary governed action for
a stable business operation; it is reachable only by trusted in-process code
(`AocEnterprise.mppChallengePayments`, `AocEnterprise.mppChallengeContexts`) and
calls the same orchestrator this route does. The frozen surface stays 28
endpoints, the governed-action request body is unchanged (`businessOperationId`,
`mppChallenge` and every other P13 name are undeclared properties, refused as
they always were), and the SDK needs no change. One wire-visible consequence,
inside the existing contract:

- `businessOperationId`, `challenge`, `challengeId`, `mppChallenge`,
  `mppMethod`, `mppIntent`, `mppRealm`, `paymentChallenge`,
  `paymentCredential` and `merchantRealm` join the reserved `assertedContext`
  keys (`400` `rejected` / `GOVERNED_ACTION_INTENT_INVALID`). A caller can never
  present a challenge or name a business operation through this route.

**Mounting (capability-gated).** The route exists only when the Host composes
**both** `customerIdentityAdmission` and `governedActionOrchestrator`. Otherwise
it behaves exactly like an unmounted route: `404 NOT_FOUND`, no fallback.
`release/api-surface.v1.json` freezes it under `capabilityGatedProbes`;
`scripts/check-api-freeze.mjs` proves it is **unmounted** on the default Host,
and `src/enterprise/__tests__/governed-action-api-endpoint.test.ts` proves it is
mounted under full composition.

**Authentication.** Always the customer plane, whatever
`AOC_ENTERPRISE_REQUIRE_AUTH` says. The bearer credential must be a configured
key carrying an `organizationId` **and** `customerIdentity` metadata, and its
external subject must be bound to an active actor in the Kernel Authority
store. Actor, organization, principal and system context come from that
binding — never from the request.

Request body — the `GovernedActionIntent`, validated **closed** (any undeclared
property is rejected, never ignored):

```json
{
  "action": "payment.create",
  "resource": "invoice:INV-100",
  "counterparty": "vendor:V123",
  "amount": { "value": 7500.00, "currency": "USD" },
  "assertedContext": { "passportId": "passport-..." },
  "correlationId": "order-123",
  "idempotencyKey": "pay-invoice-INV-100-v1"
}
```

- **Required:** `action`, `resource`, `idempotencyKey` — canonical identifiers
  (non-empty, trim-stable, no control characters, at most 256 characters).
- **Optional:** `counterparty`, `correlationId` (canonical identifiers);
  `amount` (`{ value: JSON number or decimal text, currency: asset identifier }`,
  nothing else — see "Amounts" below); `assertedContext` (plain JSON object, at most 64
  keys per level, depth 8).
- **Amounts (exact since P9).** `amount.value` is a non-negative JSON number
  (the v1 form — read from its exact source characters, never re-parsed through
  a double) or decimal **text** (`"7500"`, `"10.50"`: no sign, exponent,
  separator, whitespace or leading zero). Both become the same canonical decimal
  text; trailing fractional zeros are dropped (`7500.50` and `"7500.50"` are
  `"7500.5"`), so the two spellings of one amount are one request. `currency` must be an asset the Host's trusted
  `monetary.assets` configuration recognizes, and the value may state no more
  fractional digits than that asset's configured scale — excess precision is
  rejected, never rounded. Whether the action moves money is the Host's
  `monetary.financialActions` classification, never the caller's: a financial
  action **requires** a strictly positive amount and a non-financial action
  **may not** carry one. See `docs/architecture/ADR-CANONICAL-MONETARY-SEMANTICS.md`.
- `assertedContext` is **asserted** evidence. It reaches the Kernel as request
  context and is verified there by the canonical context and authority
  machinery; submitting it does not make it trusted, and it never reaches an
  adapter. Identity-, authority- and routing-shaped keys (`actorId`,
  `organizationId`, `system`, `grant`, `adapterId`, `url`, `authorization`, …)
  are rejected in it.
- There is no field for an actor, organization, principal, external subject,
  system flag, trust domain, request/decision/execution id, grant, grant
  expiry, authority binding, adapter, provider, URL, host, destination,
  endpoint, headers, credential, provider payload, signer or workflow. Sending
  any of them is `400` `rejected`.

**Idempotency.** `idempotencyKey` in the body is the only idempotency source;
the `Idempotency-Key` header is **not** read on this route. The key is scoped
to (organization, principal): replaying the same key with the same intent
returns the recorded result without re-running the Kernel or the adapter (an
`executed` replay carries `"replayed": true`); the same key with a different
intent is `409` `rejected` / `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT` with no
second effect; another principal may use the same raw key without collision.

**Response body — a `GovernedActionResult`, whatever the status.** Once the
caller is admitted, every outcome is a **domain result body**, never an error
envelope:

| `status` | HTTP | Meaning |
| --- | --- | --- |
| `executed` | `200` | The provider effect happened (or is on record as having happened: `replayed: true`). |
| `denied` | `422` | The Kernel denied the action. Committed, no effect. |
| `indeterminate` | `503` | The Kernel could not decide (provider fault). Committed, no effect. |
| `withheld` | `409` | Allowed or pending, but a gate held it; `withheldBy` is one of `approval`, `obligations`, `grant`, `authority-binding`, `grant-terms`, `exercise`, `emergency-control`. No effect. Since 1.5.0, `exercise` also carries the `EXERCISE_CONTROL_*` codes of an aggregate / velocity limit or exercise-time authority-binding revalidation (same status, same shape). |
| `execution_failed` | `502` | The provider behind the adapter failed (`failure`: `PROVIDER_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RESPONSE_INVALID`, `ADAPTER_ERROR`). |
| `execution_unconfirmed` | `409` | The outcome is not known and the adapter is **not** invoked again; reconcile. `GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED`: attempted, no outcome on record. `GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED` (1.4.0): the adapter reported the provider contacted and its result lost — e.g. a Generic HTTP 5xx or a connection lost after sending. Same status and shape; one additional reason-code value. |
| `rejected` | `409` | `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`. |
| `rejected` | `403` | `GOVERNED_ACTION_IDENTITY_INVALID` — unreachable from an admitted request; fails closed if it ever occurs. |
| `rejected` | `400` | Any other rejection, e.g. `GOVERNED_ACTION_INTENT_INVALID`. Nothing was evaluated. |
| `system_error` | `500` | An orchestration fault; no effect beyond what the reason codes state. |

Fields: `status`, `reasonCodes` (always); `requestId`, `correlationId`,
`decision` (`{ decisionId, evaluationId, status, reasonCodes }` — the committed
Kernel decision), `executionId` when known; `withheldBy` on `withheld`;
`providerRef`, `replayed`, `outcomeRecorded` on `executed`; `failure`,
`replayed`, `outcomeRecorded` on `execution_failed`. A result **never** carries
a bounded grant, grant id, grant digest, grant scope, authority binding,
adapter identity, provider credential, store handle or system context.

Examples:

```jsonc
// 200
{ "status": "executed", "requestId": "aoc.gar:…", "correlationId": "order-123",
  "decision": { "decisionId": "…", "evaluationId": "…", "status": "allowed", "reasonCodes": [] },
  "executionId": "aoc.exec:…", "reasonCodes": [], "providerRef": "…", "replayed": false, "outcomeRecorded": true }

// 422
{ "status": "denied", "requestId": "…",
  "decision": { "decisionId": "…", "evaluationId": "…", "status": "denied", "reasonCodes": ["…"] },
  "reasonCodes": ["…"] }

// 409
{ "status": "withheld", "withheldBy": "emergency-control", "requestId": "…", "decision": { … },
  "reasonCodes": ["EMERGENCY_CONTROL_ACTIVE"] }

// 502
{ "status": "execution_failed", "failure": "PROVIDER_REJECTED", "requestId": "…", "decision": { … },
  "executionId": "…", "reasonCodes": ["PROVIDER_REJECTED"], "replayed": false, "outcomeRecorded": true }

// 409
{ "status": "execution_unconfirmed", "requestId": "…", "decision": { … }, "executionId": "…",
  "reasonCodes": ["GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED"] }
```

**Errors — the Enterprise envelope (section 3), before the orchestrator:**

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed JSON, body over 1 MiB |
| 401 | `AUTHENTICATION_FAILED` | Missing, non-Bearer, or unrecognized credential |
| 403 | `AUTHORIZATION_FAILED` | Legacy key without `customerIdentity`, unscoped key, malformed identity, organization not served, unbound subject, revoked actor |
| 404 | `NOT_FOUND` | Route not mounted (capabilities not composed), or any other method on the path |
| 500 | `INFRASTRUCTURE_FAILURE` | Unexpected host fault |
| 503 | `INFRASTRUCTURE_FAILURE` | The subject-binding source could not be read or was inconsistent |
| 503 | `ENTERPRISE_NOT_READY` | Lifecycle not ready |

The specific `CUSTOMER_*` admission reason is logged server-side and is not
returned. No response, error or log line carries the credential.

**Distinguishing the two shapes.** An error envelope has a top-level `error`
object; a result has a top-level `status` and `reasonCodes`. They never mix.
The SDK's `governAction()` returns `GovernedActionResult` domain responses;
Enterprise error envelopes and invalid/unrecognized protocol responses —
including a well-formed result under an HTTP status other than the one this
table pairs with it — throw.

## 3. Error Taxonomy

Every error the Host raises itself is delivered as this envelope:

```jsonc
{
  "error": {
    "code": "GOVERNANCE_RECORD_NOT_FOUND",  // contract (section 1)
    "message": "...",                        // human-readable, NOT contract
    "details": ["..."]                       // optional string list, NOT contract
  }
}
```

Some codes merge additional structured fields into the `error` object
(e.g. `lifecycleState` for `ENTERPRISE_NOT_READY`, or module-supplied
`details` objects on Passport/Assurance errors). Clients may rely on
`code` and the HTTP status; nothing else in the envelope is parsed
contract.

Complete `EnterpriseHttpErrorCode` table (from
`src/enterprise/api/enterprise-http-errors.ts`):

| HTTP status | Codes |
| --- | --- |
| 400 | `INVALID_REQUEST`, `EVIDENCE_VALIDATION_ERROR`, `EVIDENCE_DISCLOSURE_POLICY_UNKNOWN`, `PASSPORT_VALIDATION_ERROR`, `PASSPORT_REFERENCE_INVALID`, `ASSURANCE_SCOPE_INVALID`, `ASSURANCE_FRAMEWORK_INVALID`, `ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED`, `ASSURANCE_SIGNAL_INVALID`, `ASSURANCE_EVIDENCE_INVALID`, `ASSURANCE_MANUAL_REVIEW_INVALID`, `ASSURANCE_VALIDATION_ERROR` |
| 401 | `AUTHENTICATION_FAILED` |
| 403 | `AUTHORIZATION_FAILED`, `GOVERNANCE_ACCESS_SCOPE_VIOLATION`, `EVIDENCE_ACCESS_SCOPE_VIOLATION`, `EVIDENCE_TENANT_SCOPE_REQUIRED`, `PASSPORT_TENANT_SCOPE_REQUIRED`, `PASSPORT_ACCESS_SCOPE_VIOLATION`, `ASSURANCE_TENANT_SCOPE_REQUIRED`, `ASSURANCE_ACCESS_SCOPE_VIOLATION`, `ASSURANCE_EVIDENCE_WRONG_TENANT` |
| 404 | `NOT_FOUND`, `GOVERNANCE_RECORD_NOT_FOUND`, `EVIDENCE_SOURCE_RECORD_NOT_FOUND`, `EVIDENCE_BUNDLE_NOT_FOUND`, `PASSPORT_NOT_FOUND`, `PASSPORT_EVIDENCE_NOT_FOUND`, `PASSPORT_GOVERNANCE_RECORD_NOT_FOUND`, `ASSURANCE_FRAMEWORK_NOT_FOUND`, `ASSURANCE_ASSESSMENT_NOT_FOUND`, `ASSURANCE_FINDING_NOT_FOUND`, `ASSURANCE_SUBJECT_NOT_FOUND`, `ASSURANCE_CONTROL_NOT_FOUND` |
| 409 | `CONCURRENCY_CONFLICT`, `GOVERNANCE_IDEMPOTENCY_CONFLICT`, `EVIDENCE_BUNDLE_ALREADY_EXISTS`, `PASSPORT_ALREADY_EXISTS`, `PASSPORT_IDEMPOTENCY_CONFLICT`, `PASSPORT_INVALID_STATE_TRANSITION`, `PASSPORT_ALREADY_REVOKED`, `PASSPORT_EXPIRED`, `ASSURANCE_ASSESSMENT_IMMUTABLE`, `ASSURANCE_ASSESSMENT_INCOMPLETE`, `ASSURANCE_INVALID_FINDING_TRANSITION` |
| 413 | `GOVERNANCE_RECORD_TOO_LARGE` |
| 422 | `PASSPORT_VERSION_UNSUPPORTED`, `ASSURANCE_EVIDENCE_INSUFFICIENT`, `ASSURANCE_EVIDENCE_CONTRADICTORY`, `ASSURANCE_MANUAL_REVIEW_REQUIRED`, `ASSURANCE_ELIGIBILITY_NOT_SATISFIED` |
| 500 | `INFRASTRUCTURE_FAILURE`, `GOVERNANCE_STORE_TRANSACTION_FAILED`, `GOVERNANCE_STORE_VALIDATION_ERROR`, `GOVERNANCE_RECORD_CORRUPTED`, `PASSPORT_INTEGRITY_FAILED`, `ASSURANCE_INTEGRITY_FAILED`, `ASSURANCE_CONTROL_EVALUATION_FAILED` |
| 503 | `PROVIDER_UNAVAILABLE`, `ENTERPRISE_NOT_READY`, `GOVERNANCE_STORE_UNAVAILABLE`, `EVIDENCE_STORE_UNAVAILABLE`, `PASSPORT_STORE_UNAVAILABLE`, `ASSURANCE_STORE_UNAVAILABLE` |

A governance `denied` (422) or `indeterminate` (503) evaluation response
is **not** an error envelope -- it is a successful evaluation carrying the
full `GovernanceEvaluateResponseBody` (section 2.2).

### Non-enveloped responses (frozen as-is for v1)

Four routes deliberately return a domain result body -- not the error
envelope -- on a non-2xx status. These are frozen exactly as implemented:

1. `GET /api/passports/{id}` returns the raw `AgentPassportLoadResult`
   with **500** when the load is `incomplete` or `corrupted` (the body
   carries `status`, `missingComponents`, `integrityFailures`).
2. `POST /api/passports/{id}/verify` returns the raw
   `AgentPassportVerificationResult` with **409** when `valid: false`.
3. `POST /api/assurance/assessments/{id}/verify` returns the raw
   `AssuranceAssessmentVerificationResult` with **409** when
   `valid: false`.
4. `POST /api/governed-actions` (1.3.0, capability-gated) returns the
   `GovernedActionResult` on **422**, **409**, **502**, **503**, **403**,
   **400** or **500** for an admitted caller, per the table in section 2.6.

(By contrast, `POST /api/evidence/verify` and
`GET /api/governance/evaluations/{id}/verify` always return **200** for an
existing record, reporting `valid: false` in the body.)

## 4. Request Handling Guarantees

These transport behaviors are contract for v1:

- **1 MiB body cap.** Any request body over 1,048,576 bytes is rejected
  with `400 INVALID_REQUEST` and the connection destroyed.
- **Store-level payload caps.** Independent of the transport cap, the
  Governance Store's record/trace/event size limits surface as
  `413 GOVERNANCE_RECORD_TOO_LARGE`.
- **Malformed JSON** in a request body is `400 INVALID_REQUEST`. An
  **empty body** is treated as `{}` (relevant to the routes whose fields
  are all optional, e.g. passport verify and assessment evaluate).
- **Malformed percent-encoding** in a path segment is
  `400 INVALID_REQUEST` (never an uncaught exception).
- **Unauthenticated requests** are `401 AUTHENTICATION_FAILED` on every
  `/api/*` route when `AOC_ENTERPRISE_REQUIRE_AUTH=true`; authentication
  is disabled by default (local/dev posture, system scope).
  `POST /api/governed-actions` is the exception: it has no unauthenticated
  mode, and answers `401`/`403` whatever that flag says.
- **Cross-organization keys** on `POST /api/governance/evaluate` are
  `403 AUTHORIZATION_FAILED`; on other routes tenant scoping is enforced
  by the owning module and surfaces as its 403
  `*_ACCESS_SCOPE_VIOLATION` / `*_TENANT_SCOPE_REQUIRED` code.
- **Unknown routes** (any method + path not in section 2) are
  `404 NOT_FOUND`. So is a capability-gated route (section 2.6) on a Host
  that did not compose its capabilities.
- **Content-Type is not enforced.** Request bodies are parsed as JSON
  regardless of the `Content-Type` header. This leniency is documented,
  observable v1 behavior; clients should nevertheless send
  `application/json`.

## 5. Known v1 Limitations (frozen; candidates for additive v1.x work)

The following are deliberate v1 boundaries. Addressing any of them must be
additive (new endpoints, new optional parameters) -- never a change to the
behaviors above:

- **No pagination, sorting, or filtering** on collection responses:
  `GET /api/passports/{id}/events` and
  `GET /api/assurance/assessments/{id}/findings` return their full
  collections in one response.
- **No HTTP-exposed governance query endpoint.** The
  `GovernanceReadService.query()` capability exists in-process but is not
  routed; only the by-id read/verify endpoints of section 2.2 are public.
- **No in-process rate limiting.** Deploy behind an external rate
  limiter if needed.
- **No per-field length caps** beyond the 1 MiB transport body cap and
  the Governance Store's own record-size limits.
