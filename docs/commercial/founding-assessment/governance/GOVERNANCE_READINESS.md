# ASSURE-GOV-01 — Framework Commercial Authorization: Governance Readiness

> **FINAL COMMERCIAL DECISION: NO-GO.**
>
> **STATUS: DRAFT — governance package for review. Not an approval, not an
> authorization, not an independent review.** It was prepared by an AI
> engineering agent at the founder's instruction to *prepare* the work. That
> instruction is not an approval to launch, and nothing here can become one.
> `rn.sv@0.1.0` keeps `commercialUse: restricted`. `rn.sv@0.2.0` does not exist.

## Status vocabulary (used in every document of this package)

| Label | Meaning |
| --- | --- |
| **VERIFIED** | Checked in ASSURE-GOV-01 against code, tests or documents at baseline `2e32eb15`. The method is stated (test run, code reading, document reading). |
| **PROPOSED** | A recommendation of this package. It has no effect until a named, authorized person approves it. |
| **PENDING** | Awaits a decision or approval by a named, authorized human. None has been given. |
| **BLOCKED** | Cannot proceed until a named prerequisite exists. |

"Approved" never appears without an attributable approval record. **No approval
record exists in this repository, and none was provided to this mission.**

## 1. Verified baseline

| Item | Value | Status |
| --- | --- | --- |
| Repository / worktree | `Republika-Network/Frontera`, `C:\Users\Usuario\Republika-worktrees\ASSURE\frontera` | VERIFIED |
| Working tree before branching | Clean (on `feat/assure-ops-02-secure-customer-data`, `57792162`) | VERIFIED |
| ASSURE-OPS-02 merge `000c0d2033e4f0c892f455ee196fa81b9449184d` (#253) in `origin/main` | Yes (`git merge-base --is-ancestor`) | VERIFIED |
| Baseline (`origin/main`) | `2e32eb159a02675e5e37f1d0d47f446339bb5706` — FV-P4C-2B3C-1 (#252) | VERIFIED |
| Changes after OPS-02 | #252 only: dedicated executor under `src/enterprise/sovereign-status-history/`, its tests and docs, `CHANGELOG.md`. No Assurance, framework, report or custody file touched | VERIFIED (`git diff --stat`) |
| Open PRs overlapping Assurance | None (#164, #141, #96 are unrelated) | VERIFIED |
| Branch | `docs/assure-gov-01-framework-authorization` from `origin/main` | VERIFIED |

## 2. The six layers that must not be conflated

Commercial authorization is the **last** of six separate layers. A layer never
substitutes for a later one.

| # | Layer | Who can provide it | Current state |
| --- | --- | --- | --- |
| L1 | **Technical implementation** | ENG, through merged code and passing tests | 8 of 9 blockers technically closed; B7 open. Re-verified in this mission ([`B1_B9_BLOCKER_DISPOSITION.md`](B1_B9_BLOCKER_DISPOSITION.md)) — VERIFIED |
| L2 | **Independent validation** | A qualified person independent of the implementation | Protocol PROPOSED ([`INDEPENDENT_REVIEW_PROTOCOL.md`](INDEPENDENT_REVIEW_PROTOCOL.md)). **No reviewer identified. No review performed** — BLOCKED (D-02) |
| L3 | **Security risk acceptance** | SEC + FDR (M2), after L2 | Register PROPOSED ([`SECURITY_RISK_REGISTER.md`](SECURITY_RISK_REGISTER.md)); every acceptance PENDING |
| L4 | **Framework governance decision** | GOV + FDR (M1) | Version strategy and candidate spec PROPOSED ([`FRAMEWORK_VERSION_STRATEGY.md`](FRAMEWORK_VERSION_STRATEGY.md), [`RN_SV_0_2_0_CANDIDATE_SPEC.md`](RN_SV_0_2_0_CANDIDATE_SPEC.md)); D-01 PENDING |
| L5 | **Legal and operational approvals** | LEG (M3, M4); FDR + SEC + OPS (M5) | Claims review PROPOSED ([`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md)); D-04, D-05, D-08 PENDING; no counsel engaged; no engagement Host provisioned — BLOCKED |
| L6 | **Final commercial authorization** | FDR + a second role holder, by the procedure in [`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) | **NO-GO** |

**Rule.** No AI agent, merged PR, passing test run or CI result grants L2–L6.
This package, its author included, cannot act as the independent reviewer.

## 3. Documents in this package

| # | Document | Purpose | Status |
| --- | --- | --- | --- |
| 1 | `GOVERNANCE_READINESS.md` (this) | Baseline, layers, new findings, remaining gates | DRAFT |
| 2 | [`B1_B9_BLOCKER_DISPOSITION.md`](B1_B9_BLOCKER_DISPOSITION.md) | Each original blocker: defect, mitigation, evidence, residual, required validation and policy decision | DRAFT |
| 3 | [`B7_AUTHENTICITY_OPTIONS.md`](B7_AUTHENTICITY_OPTIONS.md) | Threat model of report authenticity; options A/B/C; recommendation | DRAFT |
| 4 | [`INDEPENDENT_REVIEW_PROTOCOL.md`](INDEPENDENT_REVIEW_PROTOCOL.md) | How a real, qualified, independent person reviews the system, the framework and each release | DRAFT |
| 5 | [`INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](INDEPENDENT_REVIEW_EVIDENCE_INDEX.md) | The reviewer's evidence pack: sources, tests, reproduction | DRAFT |
| 6 | [`FRAMEWORK_VERSION_STRATEGY.md`](FRAMEWORK_VERSION_STRATEGY.md) | Versioning, registry lifecycle, authorization binding, suspension, prior reports | DRAFT |
| 7 | [`RN_SV_0_2_0_CANDIDATE_SPEC.md`](RN_SV_0_2_0_CANDIDATE_SPEC.md) | Candidate `rn.sv@0.2.0` delta and migration impact. **Not created, registered or active** | DRAFT |
| 8 | [`SECURITY_RISK_REGISTER.md`](SECURITY_RISK_REGISTER.md) | Residual risks, each with owner, approver, expiry and invalidation conditions | DRAFT; all PENDING |
| 9 | [`FOUNDER_DECISION_RECORD.md`](FOUNDER_DECISION_RECORD.md) | D-01, D-02, D-03, D-04, D-05, D-08: options, tradeoffs, recommendations | DRAFT; all PENDING |
| 10 | [`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) | The ordered procedure and the approval-record format | DRAFT |
| 11 | [`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md) | Claims that must not be made; proposed wording; claims needing legal approval | DRAFT — legal review |

This package **references** and does not restate the existing pack
(`../ASSURE_COMMERCIAL_GO_NO_GO.md`, `../FRAMEWORK_RESTRICTION_DISPOSITION.md`,
`../COMMERCIAL_READINESS_ASSESSMENT.md`, `../SERVICE_SPECIFICATION.md`,
`../CUSTOMER_DATA_GOVERNANCE.md`) or the security records in `docs/security/`.
When they disagree, code and tests win; discrepancies found are listed in §4.

## 4. New governance findings (this mission)

Previous documentation was **not** assumed to be complete or current. Reading the
code and documents found the following. None is a defect in the scope of the
mission that introduced it. Each needs an owner's action; none is fixed in code
here.

| ID | Finding | Evidence | Consequence | Proposed treatment | Status |
| --- | --- | --- | --- | --- | --- |
| GF-01 | The delivered report's cover **hard-codes** the statement that the release approver acts as the framework's "controlled review". This pre-empts founder decision D-02, which is open | `src/enterprise/assurance/commercial-report.ts:787-791` (cover `commercialUse.statement`); `:286` (the acknowledgement's doc comment) | Every report v2 already tells the customer that an internal approver is the controlled review | D-02 must decide it explicitly. If D-02 ≠ option (b), the wording changes in a new generator version (R-06 scope); historical reports stay unchanged | VERIFIED (code reading). **ASSURE-CLAIMS-01:** treatment IMPLEMENTED in generator v3 (§4a); D-02 still PENDING |
| GF-02 | The frozen restriction is phrased as **self-expiring**: "…until ASSURE-SEC-01 resolves the known blockers". It can be misread as lifted now that 8 of 9 blockers are closed | `rn-sv-framework.ts:536-539` | Risk of an informal "the restriction has lapsed" reading | Record here and in the strategy: the restriction lapses only by a governance decision for a new version, never by technical closure. A successor must not use self-expiring conditions | VERIFIED; treatment PROPOSED |
| GF-03 | An engineering security record states an acceptance that no one approved: REL-01D §10 lists static bearer secrets as "**Accepted** for a private pilot" | `docs/security/ASSURE-REL-01D-OPERATOR-INTERFACE.md` §10 | Technical documentation reads as policy acceptance | Read it as PROPOSED. Acceptance exists only through M2 / SR-02. A one-line correction is backlog R-11 (with the stale status header) | VERIFIED; treatment PROPOSED |
| GF-04 | `CUSTOMER_DATA_GOVERNANCE.md` contradicts itself after OPS-02: §3, §13 and the gap summary still say backups are not encrypted and no per-customer deletion exists, while the OPS-02 notes in the same file say otherwise | `../CUSTOMER_DATA_GOVERNANCE.md` §3, §13, "Summary of gaps"; `docs/security/ASSURE-OPS-02-SECURE-CUSTOMER-DATA.md` §4, §10 | A legal reviewer would read an inconsistent policy | The policy owner (LEG + OPS) corrects it while reviewing M3. Not edited here: it is a policy under legal review | VERIFIED; PENDING |
| GF-05 | No ASSURE-SEC-01A security document exists. B9's closure is evidenced by code, test, the framework header and commit only | `git log` over `docs/security/ASSURE-SEC-01A*` returns nothing | An external reviewer lacks a design record for B9 | Evidence index points to the code and test directly; a short SEC-01A record is a documentation backlog item | VERIFIED |
| GF-06 | Customer-facing drafts claim **independence** that the service does not have: "an independent, evidence-based view" (draft A, `SERVICE_SPECIFICATION.md` §1), "Independent sign-off" (draft A), "approver, independent of the reviewers" (draft H); and "…and prove it" (draft A headline) | `../drafts/A_ONE_PAGE_OFFER.md:8,11,25`; `../drafts/H_CUSTOMER_HANDOFF_VERIFICATION.md:21`; `../SERVICE_SPECIFICATION.md` §1 | Overclaim: Republika authors the framework, runs the tooling and performs the review | Replacement wording in [`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md) §3. Drafts not edited here (LEG-owned) | VERIFIED; PROPOSED. **ASSURE-CLAIMS-01:** drafts corrected (§4a); LEG review PENDING |
| GF-07 | The report generator, its readiness check, its limitation texts and the offline verifier are **hard-bound to `rn.sv@0.1.0`**. A successor version is not a metadata-only change in effect: it needs a code mission | `commercial-report.ts:11,58-59,411,425,473,521,542`; `scripts/assurance/verify-commercial-package.mjs:45-46,145-147`; `enterprise-configuration.ts:482`; `composition-root.ts:2588` | Planning must treat R-06 as code + governance | Impact analysis in [`RN_SV_0_2_0_CANDIDATE_SPEC.md`](RN_SV_0_2_0_CANDIDATE_SPEC.md) §6 | VERIFIED |
| GF-08 | Every assessment read and draft path resolves its framework through the registry (`frameworkFor`, `allowRetired: true`). A version taken out of `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS` is not registered, so its historical assessments could no longer be drafted or evaluated on that Host | `service.ts:360-362`; `composition-root.ts:2588-2596` | "Suspending" a version by deregistering it would break historical access | Suspension is a separate commercial-authorization gate, never deregistration ([`FRAMEWORK_VERSION_STRATEGY.md`](FRAMEWORK_VERSION_STRATEGY.md) §6). Behaviour under deregistration is **not tested**; R-06 must test it | VERIFIED (code reading); not tested |
| GF-09 | The registry's `deprecate()` has no frozen check (unlike `register`/`activate`) and no runtime caller outside tests | `framework-registry.ts` `deprecate`; `grep` for `.deprecate(` outside tests: none | No supported operator path to stop new assessments on a version | R-06 defines the lifecycle path explicitly | VERIFIED |

## 4a. ASSURE-CLAIMS-01 update (GF-01, GF-06, C9)

ASSURE-CLAIMS-01 corrected the report generator (new generator version
`aoc.assurance.commercial-report.v3`; v1/v2 reports and fixtures byte-identical)
and the customer-facing drafts A, D, F, G, H and the service specification.
Record: `docs/security/ASSURE-CLAIMS-01-REPORT-DISCLOSURE-INTEGRITY.md`.

| Item | Status after ASSURE-CLAIMS-01 |
| --- | --- |
| GF-01 / GF-06 remediation | IMPLEMENTED. Technically VERIFIED only when `assure-claims-01-commercial-disclosures.test.ts` and the historical-compatibility suites pass on the PR head; local results are in the CLAIMS-01 record |
| Independent R1/R2 review | PENDING. No reviewer is engaged; nothing in CLAIMS-01 is an independent review |
| Legal review of the corrected wording (L1–L9) | PENDING |
| B7 external authenticity | OPEN. Disclosed in the v3 report text; no signature implemented |
| Security risk acceptance (M2, SR-12, SR-13) | PENDING |
| `rn.sv@0.1.0` | Commercially restricted; frozen; golden digest unchanged |
| `rn.sv@0.2.0` | Not created |
| Six mandatory commercial approvals (M1–M6) | All missing |
| D-01, D-02, D-03 | PENDING; not decided by CLAIMS-01 |
| Final commercial decision | **NO-GO** |

## 5. Synthetic validation summary

Full detail and commands: [`INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](INDEPENDENT_REVIEW_EVIDENCE_INDEX.md) §4.
All runs on 2026-11-02, baseline `2e32eb15`, Windows Node 22.22.0 (the native
SQLite binding in this worktree is Windows-built), each command under a
590-second timeout, at most two suites per batch, synthetic data only.

| Check | Result | Status |
| --- | --- | --- |
| Frozen `rn.sv@0.1.0` golden digest, `aoc.saf` compatibility, REL-01C historical v1/v2 | 32 / 32 pass | VERIFIED |
| REP-01 commercial report incl. historical v1 example | 30 / 30 pass | VERIFIED |
| OPS-01 customer export + OPS-02 secure customer data | 23 / 23 pass | VERIFIED |
| REL-01A custody (incl. `A10 KNOWN LIMITATION`) + REL-01D Host pilot (P01) | 30 / 30 pass | VERIFIED |
| SEC-01A + SEC-01C | 45 / 45 pass | VERIFIED |
| SEC-01B + OPS-01 terminal review | 38 / 38 pass | VERIFIED |
| SEC-01D + SEC-01E | 67 / 67 pass | VERIFIED |
| REL-01D operator interface + OPS-01 reviewer privacy | 39 / 39 pass | VERIFIED |
| PILOT-01 dry run (incl. F01 offline limitation) | 25 / 25 pass | VERIFIED |
| Independent offline verifier on a fresh synthetic package | `PASS (files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody); external authenticity NOT DEMONSTRATED` | VERIFIED (output deleted afterwards) |
| Release docs / API freeze | pass (24 documents) / pass (45 frozen routes, no drift) | VERIFIED |
| Release manifest | Local mismatch on `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` only; cause: CRLF checkout (`core.autocrlf=true`); the committed LF blob hashes to the manifest value exactly | VERIFIED (not a regression) |

**Total: 329 focused tests, 0 failures.** These results show that the code
behaves as documented on synthetic data. They are **not** independent
validation, risk acceptance or authorization.

## 6. Remaining launch gates

| Gate (`../ASSURE_COMMERCIAL_GO_NO_GO.md`) | Status | What unblocks it |
| --- | --- | --- |
| G-TECH | CONDITIONAL | M2 acceptance of SR-02 / SR-03 / SR-04 after independent review R1 (or R-01 / R-03 implemented first) |
| G-OPS | BLOCKED | Named operators; credential register adopted; an engagement Host passing preflight E13 on a real encrypted volume; restore drill witnessed by SEC |
| G-INFO | BLOCKED | D-04, D-05, D-08; corrected and approved data-governance policy (GF-04); subprocessor inventory |
| G-LEGAL | BLOCKED | Counsel engaged; drafts B, D, E, G, H, I reviewed; claims in `CUSTOMER_CLAIMS_REVIEW.md` approved or amended; insurance; contracting entity |
| G-FRAMEWORK | BLOCKED | D-01, D-02; independent review R1; R-06 code mission; a framework authorization record binding the exact `rn.sv@0.2.0` digest |
| G-CUST | BLOCKED | A named founding customer; D-06; signed SOW |
| **Final** | **NO-GO** | All of the above, then the procedure in `COMMERCIAL_AUTHORIZATION_PROCEDURE.md` |

## 7. Recommended next executable mission

**Founder decision session (non-engineering), then ASSURE-GOV-02 — Independent
reviewer engagement (R1).** Engineering cannot unblock anything further without
D-01 and D-02. In parallel, legal counsel can start on drafts and claims. R-06
(`rn.sv@0.2.0` code mission) should begin **only after** D-01 and after the
methodology part of R1, so that the reviewer reviews the definition before its
bytes are frozen ([`FRAMEWORK_VERSION_STRATEGY.md`](FRAMEWORK_VERSION_STRATEGY.md) §5).
