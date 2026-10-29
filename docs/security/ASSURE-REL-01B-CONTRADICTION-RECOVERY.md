# ASSURE-REL-01B — Contradiction Recovery and Safe Assessment Termination

**Closes:** ASSURE-PILOT-01 finding F02, the contradiction deadlock.

**Does not change:**

- the control evaluator or the contradiction policy;
- the `rn.sv@0.1.0` or `aoc.saf` definitions and their golden digests;
- the frozen `AssuranceAssessmentStatus` union;
- any HTTP route, SDK method or public error code;
- `commercialUse: restricted`;
- findings F03 and F04.

> A recovery must make an assessment operable without lowering the confidence
> of any conclusion. A contradiction is resolved only when the evidence
> changes, never because someone wants the attempt to be over.

## 1. Root cause of F02

The deadlock is the conjunction of five rules, each intended on its own. It
was reproduced on the baseline (`3ff82590`, synthetic data):

| # | Rule | Effect on the contradicted attempt |
| --- | --- | --- |
| 1 | `control-evaluator.ts` applies the requirement's contradiction policy (`manual_review` in rn.sv) **before** it reads manual reviews | SV-08 stays `manual_review_required`, reason codes `CONTROL_EVIDENCE_CONTRADICTORY` and `CONTROL_MANUAL_REVIEW_PENDING`, even after an accepted, authenticated FAIL review |
| 2 | A favourable review must rest on uncontradicted evidence (SEC-01A) | PASS and PARTIAL are refused with `MANUAL_REVIEW_EVIDENCE_CONTRADICTED` |
| 3 | rn.sv allows no provisional completion | `completeAssessment` fails with `ASSURANCE_MANUAL_REVIEW_REQUIRED` |
| 4 | `manual_review` cannot go back to `collecting_evidence` | collecting new evidence fails with `ASSURANCE_ASSESSMENT_IMMUTABLE` |
| 5 | `requestReassessment` required a completed predecessor, and no operation produced the terminal `failed` except an evaluation crash | reassessment fails with `ASSURANCE_ASSESSMENT_INCOMPLETE`, and the attempt can never be ended |

## 2. States involved

`created → collecting_evidence → evaluating → manual_review → (evaluating | completed | failed)`.

`failed` is terminal and was already reachable from every non-terminal state.
REL-01B uses it for an attempt **ended as inconclusive**, marked by a
`termination` record. No status was added: `failed` is already in the frozen
union, and every consumer already treats it safely. Reports and the commercial
report refuse it, continuous state ignores it, and it cannot be completed.

## 3. The contradiction model

A contradiction is **deterministic and narrow**: two *accepted* references to
the same artifact (`evidenceType` + `externalId`) carrying different digests.
Every other evidence problem is a rejection, an evidence gap or a refusal, and
already had an exit:

| Condition | How the engine treats it | Exit before REL-01B |
| --- | --- | --- |
| Same artifact, different digests | **Contradiction** → `manual_review_required` | **None (F02)** |
| Another tenant's reference | Rejected `EVIDENCE_WRONG_TENANT`; never accepted | `insufficient_evidence` → UNKNOWN |
| Outside the period / after the cutoff | Rejected `EVIDENCE_INCOMPLETE` / `EVIDENCE_TOO_OLD` | UNKNOWN |
| Not bound to the requirement | Rejected `EVIDENCE_NOT_BOUND` | UNKNOWN |
| Reserved metric in an attestation | Rejected `EVIDENCE_METRIC_NOT_PERMITTED` | UNKNOWN |
| Too little evidence | Requirement unsatisfied | UNKNOWN (an evidence gap, not a failure) |
| Digest of a verified source fails | Rejected at resolution; never validated by a reviewer | UNKNOWN |
| Rejected reference cited by a review | Review refused (`MANUAL_REVIEW_EVIDENCE_REJECTED`) | — |

A contradiction is **not correctable inside the attempt**. Accepted evidence is
never withdrawn from an attempt, so the conflicting copies stay accepted and
keep conflicting. Nothing in the evidence policy lets a reviewer declare one
digest authentic: manual evidence is supplier-provided and unverified
(SEC-01C).

## 4. Decision and operations

| Alternative | Decision | Why |
| --- | --- | --- |
| A. More evidence in the same attempt | **Rejected** | The contradictory references stay accepted, so the contradiction persists. Removing or replacing them in place would be silent replacement |
| B. Explicit termination as inconclusive | **Implemented** | The minimal exit. It reuses the existing terminal `failed` and adds an attributed record. No result changes |
| C. A linked new attempt | **Implemented, by extending `requestReassessment`** | The existing operation already copies the scope and starts with no evidence. It now also follows an ended attempt, linked and never superseding it |
| D. A reviewer resolves the contradiction | **Rejected** | No evidential basis exists to prefer one copy. It would launder a contradiction |

**`terminateAssessment(context, assessmentId, { reasonCode, rationale })`**

- Ends a **non-terminal** attempt. The assessment becomes `failed` with
  `failureReason: "Ended as inconclusive (<reasonCode>)."` and a `termination`
  record.
- Its content, results, digests, reviews and evidence are unchanged. Only the
  lifecycle overlay changes.
- `reasonCode` is one of:
  - `unresolved_contradiction`, accepted only when the stored evidence does
    contradict itself;
  - `engagement_withdrawn`.
- `rationale` is required, 1–2000 characters, and is never logged.

**`requestReassessment` on an ended attempt** creates a new assessment with the
same subject, framework and scope:

- `previousAssessmentId` = the ended attempt;
- **no `supersedesAssessmentId`**: an inconclusive attempt is followed, not
  superseded;
- no evidence: it is collected afresh.

The termination record must verify, or the request fails with
`ASSURANCE_INTEGRITY_FAILED`. An attempt that `failed` without being ended
(an evaluation crash) is neither continued nor ended after the fact.

## 5. Authorized roles

Ending an attempt is a privileged human decision. It requires an
**authenticated Assurance reviewer credential** (SEC-01B) holding
**`assure.reviewer`**, in the assessment's organization, with identity and role
taken from the credential.

| Caller | Outcome |
| --- | --- |
| Forged principal | `ASSURANCE_REVIEWER_UNAUTHORIZED` |
| Organization context declaring the role | `ASSURANCE_REVIEWER_UNAUTHORIZED` |
| `system` | `ASSURANCE_REVIEWER_UNAUTHORIZED` |
| Release approver (`assure.report-release`) | `ASSURANCE_REVIEWER_UNAUTHORIZED` |
| Another tenant's reviewer | `ASSURANCE_ASSESSMENT_NOT_FOUND` |

Continuing with `requestReassessment` is an ordinary preparer action, as
creating an assessment is.

## 6. Evidence required

Ending requires none. It concludes nothing. **A conclusion requires new
evidence in the new attempt**: an artifact with its own identity, bound to the
requirement, from the assessed organization. That evidence goes through every
rule of SEC-01A–D. In the tests:

- one authoritative runbook supports **PASS**;
- a FAIL review bound to it gives an observed **FAIL** (the negative case);
- two new conflicting copies leave the new attempt **inconclusive** again;
- another tenant's reference is rejected and supports nothing.

## 7. History and provenance

The `termination` record (`aoc.assurance.assessment-termination.v1`) keeps:

- `outcome: 'inconclusive'`, `reasonCode` and `rationale`;
- `terminatedBy`, `terminatorRole` and `authentication`, all from the
  credential;
- `terminatedAt` and `statusAtTermination`;
- `assessmentDigest`: the content the decision was taken on;
- `unresolvedContradictions`, **derived from the stored evidence**, never
  declared;
- `terminationDigest` over all of the above.

`verifyAssessment` checks the record under `integrity`:

- the digest recomputes;
- it is bound to the current content;
- its contradictions equal the stored ones;
- the status is `failed`;
- the attribution is a reviewer credential.

A tampered record fails verification and can no longer be continued.
`AssuranceAssessmentFailed` is published after the save, with `termination`,
`terminatedBy` and `outcome: inconclusive` in its detail, and
`assurance.assessment.terminated` is logged. The chain of attempts is the
chain of `previousAssessmentId` links.

## 8. The no-laundering rule

- A contradiction never becomes PASS: favourable reviews stay refused, before
  and after the end.
- A FAIL review does not settle a contradicted control; the engine is
  unchanged.
- Ending records **no** control result. SV-08 stays `manual_review_required`.
- An ended attempt gets **no finding rows**, **no eligibility**
  (`evaluateEligibility` refuses `failed`), **no report**, **no commercial
  report** and **no release**.
- The contradictory evidence stays in the ended attempt. The new attempt never
  inherits it.

## 9. Behaviour on errors

- A persistence failure while ending (`ASSURANCE_STORE_UNAVAILABLE`,
  `retryable: true`, no SQL or path) leaves the attempt exactly as it was, with
  no event and no log. A retry ends it once.
- Ending a completed or already-failed assessment fails with
  `ASSURANCE_ASSESSMENT_IMMUTABLE` (`reason: assessment_terminal`).
- An invalid reason or rationale fails with `ASSURANCE_VALIDATION_ERROR`.

## 10. Retries and concurrency

- The same reviewer repeating the same termination gets the kept one back
  (`outcome: 'replayed'`). Nothing is written and no second event is published.
- A different termination (other rationale, reason or reviewer) is refused:
  `ASSURANCE_ASSESSMENT_IMMUTABLE`, `reason: assessment_already_terminated`.
- SQLite saves now run in an **IMMEDIATE** transaction. The second of two
  concurrent terminations, through two connections to one file, sees the first
  one's terminal status and is refused. The end is a single transition.
- An end racing a non-terminal evaluation leaves a coherent state: `failed`,
  bound to the stored content, which verifies.

**Limit.** Non-terminal saves stay last-writer-wins, as they were between two
concurrent evaluations. An end can overwrite a concurrent evaluation's
snapshot with the one it read. The result is coherent, but that evaluation's
output is not kept.

## 11. Evaluation afterwards

An ended attempt cannot be evaluated, reviewed into a result, completed or
reported. All further work happens in the new attempt, which is evaluated by
the unchanged engine on its own evidence.

## 12. Historical data and compatibility

- **No schema change, no migration.** `termination` is an optional field of the
  assessment JSON. Older assessments have none and verify as before.
- **SEC-01E gap closed (B-13).** Both stores used to insert finding rows on any
  terminal save, including `failed`, while only `completeAssessment` writes
  their opening events. A failed attempt could therefore leave findings
  without history. Finding rows are now inserted only for `completed`
  assessments. Rows written before this change are left as they are, and none
  is fabricated or deleted.
- `evaluateEligibility` now refuses `failed` assessments
  (`ASSURANCE_ASSESSMENT_INCOMPLETE`, already the route's code for an
  unevaluated assessment).
- `AssuranceService` gains `terminateAssessment`. `AssuranceAssessment` gains an
  optional `termination` field. `AssuranceStore` is unchanged.

## 13. Cases that must end inconclusive

An attempt with an unresolved contradiction cannot be concluded, whatever the
reviews say. The same holds for an attempt withdrawn by the customer before a
conclusion (`engagement_withdrawn`). Ending is the honest outcome. The
attempt then states no compliance, no failure and no score that a customer
could read as one.

## 14. Limitations

- **No in-attempt resolution.** Fixing evidence always means a new attempt.
- **Concurrent non-terminal saves** are last-writer-wins (§10).
- **No operational interface (F04).** `terminateAssessment` is reachable
  in-process only; no route was added.
- **Evaluation-crash `failureReason`** still carries the error message, which
  can name internal detail. This predates REL-01B and is out of its scope.
- **Mutation testing:** 15 non-equivalent mutants were applied. 14 were killed
  by the REL-01B suite. Running saves outside an IMMEDIATE transaction
  survives, and is **equivalent for correctness**: in WAL mode a deferred
  writer that read before another writer committed gets `SQLITE_BUSY_SNAPSHOT`
  instead of overwriting, which the store maps to `ASSURANCE_STORE_UNAVAILABLE`.
  IMMEDIATE changes that error into waiting under `busy_timeout`. It cannot be
  told apart in-process with a synchronous driver.

## 15. Safe operating procedure

1. Confirm the deadlock. The attempt is `manual_review`, and SV-x carries
   `CONTROL_EVIDENCE_CONTRADICTORY`. Do **not** record reviews to "close" it.
2. An authenticated reviewer with `assure.reviewer` calls
   `terminateAssessment(…, { reasonCode: 'unresolved_contradiction', rationale })`.
   The rationale should state which copies conflict and why neither can be
   preferred.
3. Ask the customer for one authoritative artifact with its own identity.
4. `requestReassessment({ assessmentId: <ended>, reason, requestedBy })`, then
   collect the new evidence, evaluate, review and complete as usual.
5. Report only on the completed new attempt. The ended attempt is part of the
   engagement record, never of the customer report.
