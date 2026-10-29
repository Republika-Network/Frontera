# ASSURE-SEC-01E — Finding event integrity and atomic completion

**Invariant:** no assessment is reported as completed unless its completion
and the opening event of every finding were persisted together.

## Before

`AssuranceService.completeAssessment` made three separate writes:

1. `saveAssessment(completed)`: the terminal row, findings and projections, in one SQLite transaction;
2. for each finding, `appendFindingEvent(AssuranceFindingCreated)` **`.catch(() => {})`**;
3. for a reassessment, `markSuperseded(previous)`.

- A failure in step 2 was swallowed. The caller got a completed assessment
  whose findings had no history (`listFindings` showed them with their
  initial status), with no error and no signal.
- A failure in the middle of step 2 left some events written and others not.
- The completed assessment was immutable, so a retry was refused, and the
  history could not be repaired.
- Step 3 ran after the commit. If it failed, for example when reassessing an
  assessment that was already superseded, the caller got an error for a
  completion that had in fact persisted.

No verifier read finding events. `verifyAssuranceAssessment` checks the
assessment snapshot, and the events live in a separate table.

## After

**Alternative A, one atomic store operation.**

`AssuranceStore.completeAssessment(context, { assessment, findingEvents })`
persists the following together, or persists nothing:

- the `completed` assessment, its findings and its projections;
- one `AssuranceFindingCreated` event per finding;
- for a reassessment, the supersession of the replaced assessment.

| | SQLite | In memory |
| --- | --- | --- |
| Unit | one `BEGIN IMMEDIATE` transaction (`db.transaction(...).immediate()`). Any failure, including at `COMMIT`, rolls back. | every check runs before the first map update, and no `await` separates them |
| Validation | `assertCompletionCommit` (shared, pure); no earlier history for the findings; event id not stored | same |
| Concurrency | the write lock is taken before the status is read; the second completion sees `completed` and is refused | the second completion sees `completed` and is refused |
| Supersession | `completed` → `superseded`; already `superseded` → left as recorded | same |
| Driver errors | become `ASSURANCE_STORE_UNAVAILABLE` (`retryable: true`), with no message, path or SQL | n/a |

`assertCompletionCommit` refuses a commit in which:

- a finding has no opening event, or has two;
- an event names a finding the assessment does not contain;
- an event names another assessment or organization;
- an event is not `Created` with sequence 1;
- an event digest does not recompute (same algorithm as `buildFindingEvent`);
- an event id is repeated.

The service builds the events, calls the store once, and reports any failure.
It never swallows one.

| Condition | Code | Retry |
| --- | --- | --- |
| store or I/O failure, failed transaction | `ASSURANCE_STORE_UNAVAILABLE` | yes: nothing was recorded |
| already completed (by this or a concurrent attempt) | `ASSURANCE_ASSESSMENT_IMMUTABLE` | no: read the assessment |
| inconsistent event set, existing history, repeated id | `ASSURANCE_INVALID_FINDING_TRANSITION` | no: defect |
| wrong tenant | `ASSURANCE_ACCESS_SCOPE_VIOLATION` | no |

The failure is logged (`assurance.assessment.completion_failed`, with
`assessmentId` and `errorCode`). The log line is best-effort and is not a
second mandatory write. No completion telemetry and no
`AssuranceAssessmentCompleted` event is emitted for a failed attempt.

The store keeps a single event system. Later lifecycle events are still
appended one at a time through `appendFindingEvent`, which checks sequence
contiguity, transitions and organization.

## Historical data

Nothing is migrated, repaired or rewritten, and there is no schema change.
Assessments completed before this change may have findings with no opening
event. They stay completed and immutable.
`findingHistoryViolations(finding, organizationId, events)` (in
`assurance/finding-history.ts`) is a read-only diagnostic. It reads through
the existing `listFindings` and `listFindingEvents` and reports:

- `missing_opening_event`;
- sequence gaps;
- `duplicate_event_id`;
- `wrong_attribution`;
- `digest_mismatch`;
- `impossible_transition_*`.

Diagnostic procedure (read-only): for each completed assessment, list its
findings, list each finding's events, and run the diagnostic. Report what it
finds; do not append events to complete an old history.

## Compatibility

- **Changed for embedders:** `AssuranceStore` (an exported embedder type)
  gains the required method `completeAssessment`. A custom store fails to
  compile until it implements the method, which is preferable to a silent
  non-atomic completion. The repository has no other implementation.
- **Unchanged:**
  - HTTP routes, the SDK, and the store schema;
  - `saveAssessment`, `appendFindingEvent` and `markSuperseded`;
  - the result of a successful completion;
  - the `rn.sv` and `aoc.saf` golden digests.
- **Changed behaviour:**
  - a completion whose finding events could not be written now fails instead
    of reporting success;
  - completing a reassessment of an already superseded assessment now
    succeeds, where before it failed after persisting.
- The in-memory store now refuses a finding event id that is already stored,
  as the SQLite primary key already did.

## Residual risks

- **Signal-driven findings:** they are still saved and then given their
  opening event in two writes (`processSignal`). Neither failure is
  swallowed, but a failure between the two leaves a finding with no history.
  This path was not part of this mission.
- **Evaluation failure marker:** the `failed`-status save in
  `evaluateAssessment` is still best-effort (`.catch(() => {})`). The original
  error still reaches the caller.
- **Custom stores:** atomicity is a contract that each `AssuranceStore`
  implementation must honour. The service cannot enforce it for a store it
  did not write.
- **History verification** is a diagnostic, not part of
  `verifyAssuranceAssessment` or of an HTTP route.
