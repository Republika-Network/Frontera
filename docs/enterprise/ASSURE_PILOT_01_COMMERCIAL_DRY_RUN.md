# ASSURE-PILOT-01 — Commercial dry run of the rn.sv Founding Assessment

> **This pilot does not authorize commercial use.** It is a rehearsal with
> fictional organizations, synthetic evidence and temporary credentials. It is
> not an audit, not a certification, and not a release of `rn.sv@0.1.0` for
> paying customers. Passing tests are not commercial authorization.

**Baseline:** `origin/main` @ `9c52eb9f` (ASSURE-REP-01, #237).
**Durable form (ASSURE-PILOT-01B):**

| Artifact | Role |
| --- | --- |
| `src/enterprise/__tests__/assure-pilot-01-scenario.ts` | The synthetic scenario. It drives the real service over SQLite: world, identities, evidence, review plan and package export |
| `src/enterprise/__tests__/assure-pilot-01-commercial-dry-run.test.ts` | The dry run as a repeatable test. It also pins the known limitations F01–F04 |
| `scripts/assurance/verify-commercial-package.mjs` | The independent package verifier. It contains no generator code |
| `scripts/assurance/run-pilot-01-dry-run.mjs` | Writes a synthetic delivery package and a store snapshot to a directory, for manual inspection |

No route, SDK method, API, schema, store, authentication rule, framework or
report-generator code was added or changed.

## 1. What was executed

The real `AssuranceService` ran over a temporary SQLite Assurance Store with
`rn.sv@0.1.0`. The scenario covers all of the following:

| Phase | What happens |
| --- | --- |
| Environment | A fictional cooperative and platform (`pilot-org-synthetic`, `pilot-ledger-system`) and a second, foreign tenant. Six reviewer credentials: preparer, evidence contributor, reviewer (`assure.reviewer`), approver (`assure.report-release`), and one reviewer and one approver of the foreign tenant. Their secrets are random per process, held in memory and never written. The independent verifier holds no credential |
| Assessment | Thirteen synthetic evidence references bound to requirements (see below), ten authenticated reviews, and mixed results derived from evidence and reviews. No score or snapshot is edited |
| Completion | A SQLite trigger aborts the third finding-event insert. The result is no false success and no partial state; the retry completes exactly once |
| Report | The REP-01 generator produces a `READY_FOR_RELEASE` draft that matches the assessment control by control |
| Release | A second identity holding `assure.report-release` approves the exact `contentDigest` and acknowledges `commercialUse: restricted` |
| Package | Report Markdown, JSON, manifest and release record, plus a limitations extract and verification instructions |
| Verification | The package is copied, then checked by a separate process with an empty environment. Tampered copies are checked the same way |

The adversarial evidence in the delivered assessment:

- a supplier claiming `verified: true` (SV-04);
- another tenant's artifact (SV-05);
- a post-cutoff artifact as the only SV-07 evidence;
- an attestation of the reserved Host metric `governance.pass_rate` (SV-09);
- a reference naming no requirement as the only SV-10 evidence.

Results:

| SV-01 | SV-02 | SV-03 | SV-04 | SV-05 | SV-06 | SV-07 | SV-08 | SV-09 | SV-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PASS | PASS | PARTIAL | PASS | PASS | FAIL | UNKNOWN | PASS | PARTIAL | UNKNOWN |

The normalized score is 60, with five findings.

## 2. Results

**ASSURE-PILOT-01 (scratch driver): 69 of 69 checks passed** across phases B–I.
The appendix lists them. The test file carries the same checks as assertions
grouped into steps, plus the tamper suite, the reproducibility check and the
known-limitation pins.

**Regression baseline at `9c52eb9f`** (related suites only, at most two per
batch, each with a timeout):

| Batch | Result |
| --- | --- |
| `assurance-rep-01-commercial-report` + `assurance-sec-01e-finding-event-integrity` | 69/69 |
| `assurance-sec-01a` + `assurance-sec-01b` | 52/52 |
| `assurance-sec-01c` + `assurance-sec-01d` | 49/49 |
| `assurance-store-contract` + `assurance-lifecycle` | 37/37 |

**Adversarial matrix:**

| # | Case | Outcome | Detected by |
| --- | --- | --- | --- |
| 1 | Incomplete assessment | Detected | Draft status gate (`ASSURANCE_ASSESSMENT_INCOMPLETE`) |
| 2 | Wrong framework (aoc.saf) | Detected | `ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED` |
| 3 | Unauthenticated reviewer (forged principal) | Detected | Reviewer authenticator |
| 4 | Reviewer without the role | Detected | `requiredReviewerRole` |
| 5 | Unbound evidence | Detected | Resolver `EVIDENCE_NOT_BOUND`; evidence-bound review |
| 6 | Another tenant's evidence | Detected | Resolver `EVIDENCE_WRONG_TENANT` |
| 7 | Rejected evidence cited | Detected | `MANUAL_REVIEW_EVIDENCE_REJECTED` |
| 8 | Self-verifying attestation | Detected | Kept as a supplier claim (`verified: false`) |
| 9 | Reserved metric injected | Detected | `EVIDENCE_METRIC_NOT_PERMITTED` |
| 10 | Finding event deleted at storage level | Detected | `finding_histories_consistent` → DRAFT; release refused |
| 11 | Persistence failure | Detected | Atomic completion (SEC-01E), `ASSURANCE_STORE_UNAVAILABLE` |
| 12 | Prohibited disclosure in the declaration | Detected | `disclosure_policy` → DRAFT; release refused |
| 13 | Release without `assure.report-release` | Detected | Release role check |
| 14 | Wrong approved digest; older draft; stale approval after a finding event | Detected | Draft re-derived at release (`ASSURANCE_INTEGRITY_FAILED`) |
| 15–16 | Report or manifest modified | Detected | Verifier |
| 17 | Release record modified | Detected. With every digest recomputed: detected against custody since ASSURE-REL-01A; **still not detected offline (F01)** | Verifier; `verifyCommercialRelease` |
| 18 | JSON and Markdown inconsistent | Detected with re-render or trusted source; **coherent forgeries pass offline** | Verifier |
| 19 | Evidence reused across controls | Detected | `MANUAL_REVIEW_EVIDENCE_NOT_BOUND` |
| 20 | Double release | Resolved by ASSURE-REL-01A: the kept release is returned; another approver or other content is refused | Release custody |

## 3. Reproducing it

```bash
npm ci && npm run build
node --test dist/src/enterprise/__tests__/assure-pilot-01-commercial-dry-run.test.js
# a package for inspection, then its independent verification
node scripts/assurance/run-pilot-01-dry-run.mjs --out /tmp/pilot-01
node scripts/assurance/verify-commercial-package.mjs /tmp/pilot-01/founding-assessment \
  --store-copy /tmp/pilot-01/trusted-source/assurance-store.snapshot.db \
  --renderer dist/src/enterprise/assurance/commercial-report-markdown.js
```

Pitfalls observed during the pilot:

- On Windows, `git archive` and checkouts under `core.autocrlf=true` convert
  text to CRLF. A CRLF `report.md` no longer matches its `markdownDigest`.
  Export with `-c core.autocrlf=false`, and deliver packages as an archive.
- The store runs in WAL mode. Copy it with SQLite's backup API
  (`snapshotPilotStore`), not by copying the file.

Two runs produce byte-identical packages, because the scenario's clock is
deterministic. With a real clock, only `approvedAt` and therefore
`releaseDigest` change.

## 4. What offline verification shows, and what it cannot

The verifier reports each dimension separately:

| Dimension | Meaning | Needs |
| --- | --- | --- |
| Artifact integrity | The four files are unchanged since their digests were computed | The package |
| Report consistency | Identifiers agree across the files; the framework is the published rn.sv@0.1.0 digest; Markdown and JSON agree on controls, statuses, counts, score and classification; `limitations.md` re-extracts | The package. `--renderer` adds a full re-render, which loads the generator's renderer and says so |
| Approval consistency | The release record names the manifest's three digests, the release role and both acknowledgements, and is dated no later than the issue | The package |
| Assessment consistency | The report matches the stored assessment: status, digest, every control, score and findings | `--store-copy`, a copy of the issuer's store |
| Release custody | The release record and manifest equal the release the issuer kept (ASSURE-REL-01A) | `--store-copy`. The copy is comparison material (`UNAUTHENTICATED_COPY`); only `AssuranceService.verifyCommercialRelease` against the Host's own store is authoritative |
| **External authenticity** | Who produced the package | **Never demonstrated.** No signature, timestamp or anchor exists |

A package verified offline is consistent and unchanged since its digests were
computed. It is **not** shown to come from the issuer. Anyone who edits a file
and recomputes every digest produces a package that verifies. Content
forgeries that keep JSON and Markdown coherent are caught only against the
issuer's store or by a re-render. The integrity of `report.json` is canonical,
so reformatting its whitespace changes nothing.

## 5. Findings

Each finding is pinned by a `KNOWN LIMITATION` test that asserts **current**
behaviour. A fix is expected to break that test. The assertion must then be
inverted, not deleted.

### F01 — Release approval forgery (and double release)

**As found:** changing `approvedBy` in `release-record.json` and recomputing
every digest yielded a package that verified in every mode, including against
the issuer's store. The issuer persisted no release record. A second release
of the same report was also accepted, yielding a second, distinct approval
record for identical content.

**Resolved under authoritative verification by ASSURE-REL-01A**
(`docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md`):

- The Host keeps every release in custody.
- The forged package fails against the issuer's store copy, and
  `verifyCommercialRelease` answers `RELEASE_MISMATCH` on `release.approvedBy`
  against the Host's own store. The kept record names the real approver, also
  after the store is closed and reopened.
- A second release of the same report returns the kept record.

The test cases were kept and inverted, not deleted.

**Remaining offline limitation:** the forged package is still self-consistent,
so offline it still verifies, and external authenticity remains
`NOT_DEMONSTRATED`. A customer holding only the package cannot tell who
approved it without asking the issuer. No signature exists.

### F02 — Contradiction deadlock

Two accepted references to the same artifact with different digests trigger
the `manual_review` contradiction policy. PASS and PARTIAL are refused, which
is correct. An authenticated FAIL review is accepted, but the control evaluator
applies the contradiction step **before** it reads reviews. The control
therefore stays `manual_review_required`. `rn.sv@0.1.0` allows no provisional
completion, so after that:

- `completeAssessment` fails with `ASSURANCE_MANUAL_REVIEW_REQUIRED`;
- collecting new evidence fails (`ASSURANCE_ASSESSMENT_IMMUTABLE`);
- reassessment fails (`ASSURANCE_ASSESSMENT_INCOMPLETE`).

No operation withdrew or abandoned the assessment. The engagement could only
continue with an unrelated new assessment, and the stuck one stayed open.

**Resolved by ASSURE-REL-01B**
(`docs/security/ASSURE-REL-01B-CONTRADICTION-RECOVERY.md`). The attempt still
cannot be concluded, by design: the engine, the contradiction policy and the
framework are unchanged, and no contradiction becomes PASS or FAIL. What is
new:

- An authenticated reviewer (`assure.reviewer`) can **end** the attempt as
  inconclusive with `terminateAssessment`. It becomes `failed`, carries a
  self-digested `termination` record, and keeps its evidence, contradiction
  and reviews.
- `requestReassessment` then starts a **linked** new attempt
  (`previousAssessmentId`, never `supersedesAssessmentId`). That attempt
  concludes on new evidence.

The F02 test was inverted, not deleted: it still reproduces the deadlock, then
ends the attempt and concludes in the new one.

### F03 — Markdown and release record disagree

The released `report.md` opens with "**READY FOR RELEASE** — not yet released"
and states "Not released by this document". Its release record, which names
exactly that Markdown's digest, says that an authenticated approver released
it. This is by design: the Markdown cannot contain the record that binds its
own digest. A customer who receives only the Markdown is nonetheless told that
it is unreleased.

### F04 — No operational interface

`buildCommercialReportDraft` and `releaseCommercialReport` have no HTTP route,
SDK method, app or operational script (REP-01 §1). The commercial flow can be
run only by in-process integration with the Assurance service over the store,
as this pilot does. A test scans `src`, `packages`, `apps` and `scripts`,
outside the Assurance module and this pilot's tooling, and pins that no caller
exists.

### Other observations

- A manual review is still accepted after completion. In the pilot it did not
  change the regenerated report.
- Reviewer and approver IDs appear verbatim in the report and the release
  record. They must never be emails or personal names.
- All evidence is supplied by the assessed organization. Evidence contributors
  are attributed only through supplier-declared provenance, not authenticated.

## 6. Commercial-use risks

| Dimension | Status |
| --- | --- |
| Evaluation engine | CONDITIONAL (F02 has a supported exit since ASSURE-REL-01B, by ending the attempt and starting a new one; a contradiction is still never resolved within an attempt) |
| Evidence and provenance | CONDITIONAL (supplier-provided only) |
| Authenticated reviewers | READY (technical); credential lifecycle is procedural |
| Persistence and integrity | READY |
| Report generation | READY |
| Confidentiality | CONDITIONAL (reviewer IDs disclosed; customer-confidential terms that look harmless rest on the approver) |
| Human approval | READY (technical) |
| Release-record custody | CONDITIONAL (ASSURE-REL-01A: durable, authenticated, unique custody; issuer-controlled, no signature, offline authenticity not demonstrated) |
| Reproducibility | CONDITIONAL |
| Customer delivery | CONDITIONAL (no signature; CRLF fragility; F03) |
| Commercial-use policy | **BLOCKED** (`commercialUse: restricted`; needs a governance decision and a new framework version) |
| Host operation | **BLOCKED** (F04) |
| Customer data handling | **BLOCKED** (no retention, deletion or location policy) |
| Contract documentation | **BLOCKED** |

## 7. Recommendations for REL-01 (not implemented here)

1. ~~Persist release records, append-only and unique per `reportId`. Refuse a
   second release, and let the verifier consult the record (F01).~~ Done in
   ASSURE-REL-01A.
2. Sign the `releaseDigest` with an issuer key. Consider reusing the signed
   verifier pattern of FV-P4B (#234). Until then, customers must confirm the
   digests over an independent channel.
3. Provide a supported operator path to draft and release against the Host's
   store with its configured credentials (F04).
4. ~~Give contradicted controls a way out (F02).~~ Done in ASSURE-REL-01B, by
   explicit termination of the attempt and a linked new attempt. A review
   still never concludes a contradicted control.
5. Refuse manual reviews on terminal assessments.
6. Reword the released Markdown's banner so that it is valid only together
   with a matching release record (F03).
7. Validate in the Host configuration that reviewer IDs are not emails.
8. Take the governance decision on `commercialUse: restricted`.

## 8. Provenance of this material

The scenario, verifier and tamper cases were **recovered** from the
ASSURE-PILOT-01 working files. They were not reconstructed. They were adapted
in the following ways:

- The driver became a TypeScript scenario module plus a test.
- The tamper suite became test cases.
- The verifier resolves `better-sqlite3` from its own location; the earlier
  `--sqlite-module` flag is gone.
- The `limitations.md` extract wording became generic.

No SQLite store, `node_modules`, log, credential or generated package from
the pilot is committed.

## Appendix — the 69 checks of the ASSURE-PILOT-01 run

Copied from the pilot driver log (`pilot-log.json`, run 2). The run had 69 checks and 0 failures. Phase letters follow the mission: B environment, C assessment, D completion, E report, F release, H package, I adversarial.

| # | Phase | Check | Result |
| --- | --- | --- | --- |
| 1 | B | rn.sv@0.1.0 golden digest | PASS |
| 2 | B | organization API key context authenticates no reviewer | PASS |
| 3 | C | foreign-tenant evidence rejected EVIDENCE_WRONG_TENANT | PASS |
| 4 | C | post-cutoff evidence rejected | PASS |
| 5 | C | reserved-metric attestation rejected | PASS |
| 6 | C | unbound evidence not accepted for SV-10 | PASS |
| 7 | C | supplier self-verification kept as a claim (verified=false) | PASS |
| 8 | C | no evidence accepted for a requirement it does not name | PASS |
| 9 | C | Unauthenticated reviewer (forged principal object) is refused | PASS |
| 10 | C | Organization API-key context claiming assure.reviewer is refused | PASS |
| 11 | C | System context review is refused | PASS |
| 12 | C | Authenticated reviewer without assure.reviewer (preparer credential) is refused | PASS |
| 13 | C | Evidence contributor credential cannot review is refused | PASS |
| 14 | C | Other-tenant reviewer is refused | PASS |
| 15 | C | Review attributed to someone else (reviewerId in body) is refused | PASS |
| 16 | C | PASS citing evidence with no requirement binding is refused | PASS |
| 17 | C | PASS citing rejected (post-cutoff) evidence is refused | PASS |
| 18 | C | PASS citing the other tenant's evidence is refused | PASS |
| 19 | C | Evidence reuse: SV-02 PASS citing SV-01 evidence is refused | PASS |
| 20 | C | PASS with no evidence cited (insufficient evidence) is refused | PASS |
| 21 | C | mixed results derived from evidence + authenticated reviews | PASS |
| 22 | C | contradiction recorded (same artifact, two digests) | PASS |
| 23 | C | Favourable conclusion over contradictory evidence is refused | PASS |
| 24 | D | injected persistence failure: no false success, nothing partial | PASS |
| 25 | D | failure message leaks no driver detail or path | PASS |
| 26 | D | 1. status completed | PASS |
| 27 | D | 2. assessment verification valid (digest) | PASS |
| 28 | D | 3. framework digest is the published rn.sv@0.1.0 | PASS |
| 29 | D | 4. ten control evaluations | PASS |
| 30 | D | 5. one finding per non-PASS control, on that control | PASS |
| 31 | D | 6/7. exactly one opening event per finding, history intact | PASS |
| 32 | D | 8. no duplicate finding events (rows == findings) | PASS |
| 33 | D | 8b. no duplicate published service events; one AssuranceAssessmentCompleted | PASS |
| 34 | D | 9. verification satisfactory after reload | PASS |
| 35 | D | 10a. collectEvidence on a completed assessment is refused | PASS |
| 36 | D | 10b. evaluateAssessment on a completed assessment is refused | PASS |
| 37 | D | 10c. store.saveAssessment overwriting a completed assessment is refused | PASS |
| 38 | D | 10d. completing twice is refused | PASS |
| 39 | D | other tenant cannot read the assessment | PASS |
| 40 | D | other tenant cannot draft its report is refused | PASS |
| 41 | E | all release gates pass (READY_FOR_RELEASE) | PASS |
| 42 | E | report has cover + all required sections | PASS |
| 43 | E | ten controls in report | PASS |
| 44 | E | every control status equals the assessment (no silent difference) | PASS |
| 45 | E | score equals the assessment | PASS |
| 46 | E | finding count equals the assessment | PASS |
| 47 | E | manifest binds assessment digest | PASS |
| 48 | E | not released automatically | PASS |
| 49 | I | Report from an incomplete assessment is refused | PASS |
| 50 | I | Report under a different framework (aoc.saf) is refused | PASS |
| 51 | I | hostile declaration is withheld and blocks release | PASS |
| 52 | F | Release of a draft with prohibited disclosure is refused | PASS |
| 53 | F | Release by credential without assure.report-release (reviewer) is refused | PASS |
| 54 | F | Release by preparer credential is refused | PASS |
| 55 | F | Release by organization context claiming the role is refused | PASS |
| 56 | F | Release by system context is refused | PASS |
| 57 | F | Release by other-tenant approver is refused | PASS |
| 58 | F | Release with a modified approved digest is refused | PASS |
| 59 | F | Approval of an older draft (v0.9 digest) for the v1.0 release is refused | PASS |
| 60 | F | Release without acknowledging commercialUse: restricted is refused | PASS |
| 61 | F | approver can see scope/exclusions/limitations/commercial-use statement in the draft | PASS |
| 62 | F | release record binds exactly the approved draft | PASS |
| 63 | F | release record names the approver and role, not the reviewer | PASS |
| 64 | H | package contains no secret, tenant id, supplier identifier, planted marker or local path | PASS |
| 65 | H | report states its confidentiality classification | PASS |
| 66 | H | report says it is not a certification | PASS |
| 67 | H | all names are visibly fictional | PASS |
| 68 | I | Release from the tampered store is refused | PASS |
| 69 | F | Approval made stale by a later finding event is refused | PASS |
