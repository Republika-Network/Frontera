# Assurance Runtime Operations (PR-007)

## Configuration

| Environment variable | Default | Effect |
| --- | --- | --- |
| `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `.data/assurance.sqlite` | Assurance Store file when `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` (independent of every other store's file) |
| `AOC_ENTERPRISE_ASSURANCE_REQUIRED` | `false` | `true` makes the Assurance module `required`: an Assurance Store outage blocks Enterprise readiness. Default: Assurance degrades without blocking `POST /api/governance/evaluate` |

## Module

`aoc.enterprise.assurance` — optional dependencies on
`aoc.enterprise.governance-store` and `aoc.enterprise.events`; capabilities
`assurance.frameworks/assess/evidence.resolve/controls.evaluate/findings/
scoring/eligibility/signals/verify/reassess/report`. Initialization checks
store writability, freezes the framework registry, and requires at least one
registered framework. Health reports store status, schema version, migration
state, and registered framework count. Shutdown closes the store.

## Error taxonomy → HTTP mapping

| HTTP | Codes |
| --- | --- |
| 400 | `ASSURANCE_SCOPE_INVALID`, `ASSURANCE_FRAMEWORK_INVALID`, `ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED`, `ASSURANCE_SIGNAL_INVALID`, `ASSURANCE_EVIDENCE_INVALID`, `ASSURANCE_MANUAL_REVIEW_INVALID`, `ASSURANCE_VALIDATION_ERROR` |
| 403 | `ASSURANCE_TENANT_SCOPE_REQUIRED`, `ASSURANCE_ACCESS_SCOPE_VIOLATION`, `ASSURANCE_EVIDENCE_WRONG_TENANT` |
| 404 | `ASSURANCE_FRAMEWORK_NOT_FOUND`, `ASSURANCE_ASSESSMENT_NOT_FOUND`, `ASSURANCE_FINDING_NOT_FOUND`, `ASSURANCE_SUBJECT_NOT_FOUND`, `ASSURANCE_CONTROL_NOT_FOUND` |
| 409 | `ASSURANCE_ASSESSMENT_IMMUTABLE`, `ASSURANCE_ASSESSMENT_INCOMPLETE`, `ASSURANCE_INVALID_FINDING_TRANSITION` |
| 422 | `ASSURANCE_EVIDENCE_INSUFFICIENT`, `ASSURANCE_EVIDENCE_CONTRADICTORY`, `ASSURANCE_MANUAL_REVIEW_REQUIRED`, `ASSURANCE_ELIGIBILITY_NOT_SATISFIED` |
| 500 | `ASSURANCE_INTEGRITY_FAILED`, `ASSURANCE_CONTROL_EVALUATION_FAILED` |
| 503 | `ASSURANCE_STORE_UNAVAILABLE` |

A failed control is a valid assessment result (HTTP 200), never an error.

## Telemetry (flat counters, `EnterpriseMetricsSnapshot`)

`assurance_assessments_created/completed/failed_total`,
`assurance_assessment_duration_ms` (average),
`assurance_controls_evaluated_total` with
`pass/partial/fail/unknown/manual_review` breakdowns,
`assurance_findings_created_total` with `critical/high/medium/low`
breakdowns, `assurance_findings_closed_total`,
`assurance_evidence_resolutions/rejections/insufficient/contradictions_total`,
`assurance_eligibility_evaluations/pass/fail/provisional_total`,
`assurance_signals_received_total`,
`assurance_assessments_marked_stale_total`,
`assurance_reassessments_requested_total`,
`assurance_integrity_verifications/failures_total`.

## Structured logging

Closed field set only (`EnterpriseLogContext`): assessment/framework/
subject/organization/control/domain/finding ids, statuses, severities,
normalized scores, durations, error codes, evaluator version, and the
`reportId` of a commercial release (ASSURE-REL-01A). Never logged:
full Evidence Bundles, full Governance Records, sensitive Passport details,
raw external artifact payloads, credentials, secrets, arbitrary context.

## Events (operational notifications; the Assurance Store stays canonical)

`AssuranceAssessmentCreated`, `AssuranceEvidenceCollectionStarted`,
`AssuranceEvidenceResolved`, `AssuranceControlEvaluated`,
`AssuranceFindingCreated`, `AssuranceManualReviewRequested`,
`AssuranceManualReviewCompleted`, `AssuranceDomainEvaluated`,
`AssuranceScoreCalculated`, `AssuranceEligibilityEvaluated`,
`AssuranceAssessmentCompleted`, `AssuranceAssessmentFailed`,
`AssuranceAssessmentSuperseded`, `AssuranceAssessmentMarkedStale`,
`AssuranceSignalReceived`, `AssuranceReassessmentRequested`.

## SQLite schema (`aoc.assurance-store.schema.v1`)

Tables: `assurance_store_versions`, `assurance_frameworks` (PK
framework_id+version), `assurance_assessments` (PK assessment_id; canonical
`assessment_json`; org/subject/framework/status/score columns + indexes),
`assurance_evidence_references`, `assurance_control_evaluations` (UNIQUE
assessment+control), `assurance_domain_assessments` (UNIQUE
assessment+domain), `assurance_scores`, `assurance_eligibility_results` (PK
assessment+profile) — all FK'd to `assurance_assessments` and written once
at the terminal save as queryable projections; `assurance_findings` (FK to
assessments), `assurance_finding_events` (FK to findings; UNIQUE
finding+sequence), `assurance_manual_reviews` (FK to assessments),
`assurance_signals` (indexed by org+subject), and `assurance_commercial_releases`
(ASSURE-REL-01A: release custody; PK report_id; FK to assessments; append-only
triggers; added at open time without changing the schema identifier). WAL journal, `synchronous =
FULL`, foreign keys ON, busy timeout, prepared statements, transactions
around every multi-row write. No general UPDATE/DELETE surface exists; the
only UPDATEs are non-terminal snapshot upserts and the supersession marker.

## Access control assumptions

The Assurance Runtime does not authenticate. The Enterprise HTTP adapter
resolves the caller's `AssuranceAccessContext` from the same API-key
mechanism as governance reads; non-system callers are bound to their
organization on every surface (evidence resolution, assessments, findings,
reviews, signals, state, reassessment). System access is explicit
(`system: true`) and never the default.
