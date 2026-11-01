# Assurance Runtime Operations (PR-007)

## Configuration

| Environment variable | Default | Effect |
| --- | --- | --- |
| `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `.data/assurance.sqlite` | Assurance Store file when `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` (independent of every other store's file) |
| `AOC_ENTERPRISE_ASSURANCE_REQUIRED` | `false` | `true` makes the Assurance module `required`: an Assurance Store outage blocks Enterprise readiness. Default: Assurance degrades without blocking `POST /api/governance/evaluate` |
| `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS` | unset | ASSURE-REL-01D. Comma-separated built-in frameworks registered besides `aoc.saf@1.0.0`. Only `rn.sv@0.1.0` exists, registered exactly as frozen (`commercialUse: restricted`). An unknown entry refuses Host boot |
| `AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY` | `false` | ASSURE-REL-01D. `true`: every Assurance write over HTTP requires an Assurance reviewer credential; organization keys and the system context are refused (`401`). Reads unchanged. Set it on a Founding Assessment Host |

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

**Opening (ASSURE-REL-01A-R1).** The file is read before anything writes it.
It is refused, unchanged, if it is unreadable, holds objects without a version
ledger, has an unreadable ledger, records another schema version, or has
release-custody objects of another structure or only partly created. Only a
compatible or empty file is switched to WAL. It is then initialized (v1 DDL,
custody DDL and version row) in one IMMEDIATE transaction, kept whole or not
at all. Commercial releases require this store: the in-memory provider cannot
release.

## Access control assumptions

The Assurance Runtime does not authenticate. The Enterprise HTTP adapter
resolves the caller's `AssuranceAccessContext` from the same API-key
mechanism as governance reads; non-system callers are bound to their
organization on every surface (evidence resolution, assessments, findings,
reviews, signals, state, reassessment). System access is explicit
(`system: true`) and never the default.

## Operator workflow (ASSURE-REL-01D)

The supported way to run an `rn.sv@0.1.0` assessment against a Host. Every step
is an HTTP call with an **Assurance reviewer credential** as the bearer
(governed-action file `assuranceReviewers`, one secret per person, never
shared). The Host derives the organization, the actor and the roles from that
credential; nothing in a request body names who acted. Run it only on a private
network or loopback (see `docs/security/ASSURE-REL-01D-OPERATOR-INTERFACE.md`).

Host prerequisites: `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` (a release is
refused without durable custody), `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS=rn.sv@0.1.0`,
`AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY=true`, and at least two reviewer
credentials -- one `assure.reviewer` (the assessor) and one
`assure.report-release` (the approver), held by different people.

| Step | Who | Call |
| --- | --- | --- |
| 1. Create the assessment | reviewer | `POST /api/assurance/assessments` (`requestedBy` omitted: it is the credential) |
| 2. Submit the evidence set | reviewer | `POST /api/assurance/assessments/{id}/evidence` `{ manualEvidence }` -- once, from `created` |
| 3. Evaluate (reviews pending) | reviewer | `POST /api/assurance/assessments/{id}/evaluate` `{ "complete": false }` |
| 4. Review each control | reviewer | `POST /api/assurance/manual-reviews` (SV-01 ... SV-10, evidence-bound) |
| 5. Evaluate and complete | reviewer | `POST /api/assurance/assessments/{id}/evaluate` |
| 6. Draft and inspect | approver | `POST /api/assurance/assessments/{id}/commercial-report/draft` -- read `content.readiness` and the rendered `markdown` |
| 7. Approve the exact digest | approver | `POST /api/assurance/assessments/{id}/commercial-report/release` with `manifest.contentDigest` and both acknowledgements |
| 8. Retrieve the kept release | either | `GET /api/assurance/commercial-releases/{reportId}` |
| 9. Verify what is delivered | either | `POST /api/assurance/commercial-releases/verify`, and the independent `scripts/assurance/verify-commercial-package.mjs` |

Rules the Host enforces:

- **Separation of duties.** A credential that recorded any manual review of the
  assessment cannot release it (`403`, `reason: separation_of_duties`), even if
  it holds `assure.report-release`.
- **Exact approval.** The approved digest must be the one the store produces now
  (`409`, `reason: approved_digest_stale` otherwise: draft again). The approval
  date may not be after the report's `issuedOn`.
- **One release per report version.** The same approver repeating the same
  release gets the original back (`200`, `replayed`); anything else is `409`.
- **Concurrent writers.** A write computed from a state another writer changed
  is refused (`409 ASSURANCE_ASSESSMENT_CONFLICT`, nothing written): read the
  assessment again before retrying.
- **Inconclusive attempts.** End them with `POST .../terminate`
  (`assure.reviewer`); an ended attempt yields no report. Continue with
  `POST /api/assurance/subjects/{subjectId}/reassess`.

Every operator action writes one `enterprise.assurance.operator` log line
(`operatorId`, `operation`, `assessmentId` / `reportId`, `httpStatus`,
`errorCode`); no token, body, evidence or rationale is logged. The durable
attribution is in the store: the assessment's `provenance.requestedBy`, each
review's `reviewerId`, the termination record and the release record.
