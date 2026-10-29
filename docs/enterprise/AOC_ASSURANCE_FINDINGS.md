# Assurance Findings (PR-007)

## Types

`control_failure` (a failed control), `evidence_gap` (partial/unknown
results and signal-reported missing evidence), `integrity_issue`
(contradictory evidence / digest mismatches), `scope_issue`,
`configuration_issue`, `manual_review` (a pending human review being
tracked). `pass` and `not_applicable` never produce findings.

## Severity — rule-based, never arbitrary (`deriveFindingSeverity`)

1. The control's framework-defined `severityMapping[status]` wins when
   present.
2. Otherwise the documented default rule applies:

| Status | blocking control | mandatory | recommended | optional |
| --- | --- | --- | --- | --- |
| fail | critical | high | medium | low |
| partial | — | medium | low | low |
| unknown | high (mandatory+blocking) | medium | low | low |
| manual_review_required | informational | informational | informational | informational |

Severity inputs are therefore control criticality, blocking status, and the
status kind — all attributable to the framework definition.

## Remediation guidance

Every finding carries structured `AssuranceRemediationGuidance` (objective
from the control, recommended actions from the control's
`remediationGuidance` or a status-specific default, required evidence from
the control's requirement list, priority derived from severity:
critical→immediate, high→high, medium→normal, low/informational→low). The
Runtime **recommends** remediation; it never executes it.

## Append-only lifecycle

Findings evolve exclusively through `AssuranceFindingEvent`s (each with an
actor, optional rationale, contiguous sequence, and a SHA-256 event digest):

```
(created) ──AssuranceFindingCreated──► open
open ──Accepted──► accepted
open|accepted ──RemediationPlanned──► remediation_planned
open|accepted|remediation_planned ──Remediated──► remediated
remediated|accepted ──Closed──► closed
open|accepted|remediation_planned|remediated ──Superseded──► superseded
closed|remediated|superseded ──Reopened──► open
```

Any other transition is `ASSURANCE_INVALID_FINDING_TRANSITION`. The current
status is always the fold of the ordered event history — history is never
overwritten, and a later passing assessment never silently deletes or closes
an earlier finding: closure is an explicit, attributable event.

## Storage

Finding rows persist at the assessment's terminal save (the working findings
set may be replaced by re-evaluation before completion). Since ASSURE-SEC-01E,
completion is one store unit (`AssuranceStore.completeAssessment`): the
completed assessment, its findings, one `AssuranceFindingCreated` event per
finding and the supersession of a replaced assessment persist together, or
nothing does. A failed completion is reported (`ASSURANCE_STORE_UNAVAILABLE`,
retryable) and leaves the assessment completable. A second completion is
refused (`ASSURANCE_ASSESSMENT_IMMUTABLE`). Post-completion,
signal-driven findings (`control_evidence_missing`) append via
`saveFinding` + a Created event — the completed assessment's frozen content
is never touched (its digests cover the evaluation-time findings).
