# ASSURE-REL-01E — Commercial Readiness Assessment

> **STATUS: DRAFT. Not a commercial authorization.** Final commercial
> decision: **NO-GO** ([`ASSURE_COMMERCIAL_GO_NO_GO.md`](ASSURE_COMMERCIAL_GO_NO_GO.md)).
> `rn.sv@0.1.0` keeps `commercialUse: restricted`. No product behaviour, framework,
> golden digest or historical report was changed by this mission.

## 1. Verified baseline

| Item | Value |
| --- | --- |
| Baseline | `origin/main` @ `5012246c9cf406bf4a0cfa3c288d2cf778211dbf` — "fix(assurance): secure Host operator interface (ASSURE-REL-01D) (#248)" |
| PR #248 contained in `origin/main` | Yes (`git merge-base --is-ancestor`) |
| Working tree before branching | Clean |
| Branch | `docs/assure-rel-01e-commercial-readiness`, created from `origin/main` |
| Concurrent work touching Assurance or Host | No open PR touches Assurance or Host (open: #164, #141, #96, all unrelated). Remote branches for already-merged Assurance missions remain |
| CI on baseline | `CI` workflow: success. `CodeQL`: success. **`Publishability`: failure** on the `#248` merge push, in "Validate Enterprise against the pinned tarball" (one failing test; the retrievable log is truncated and does not name it). The same workflow failed and then passed on the #248 PR branch, which suggests a flaky test. **Not verified**; recorded as backlog R-10 |

## 2. Scope of this mission

Documentation, governance analysis and **synthetic** verification only. No
merge, deployment, migration, customer onboarding, framework-policy change,
or paid assessment.

## 3. Framework restriction: summary

See [`FRAMEWORK_RESTRICTION_DISPOSITION.md`](FRAMEWORK_RESTRICTION_DISPOSITION.md).

- **Nine** known blockers are frozen in `rn.sv@0.1.0`.
- **Eight are technically closed with verified evidence** (SEC-01A, B, C, D,
  E; REL-01A, D): code, a passing regression test in this run, and a security
  document.
- **B7 (no external authenticity) is open.** Custody (REL-01A) only mitigates
  it for a party who asks the issuer.
- The residuals of **B1** (manual evidence never authenticated) and **B3**
  (static bearer credentials; credential ≠ person) are material for paid use.
- **Policy authorization: none.** The restriction is procedural and not read
  by any engine component. Its statement requires "controlled external
  review", and no external reviewer exists.
- **Recommendation:** authorize commercial use, if at all, through a new
  governed version (`rn.sv@0.2.0`). Do not mutate 0.1.0, which would break its
  golden digest and every historical report bound to it.

## 4. Findings from the REL-01D operator implementation

Read from `docs/security/ASSURE-REL-01D-OPERATOR-INTERFACE.md`, the code
(`assurance-operator-access.ts`, `assurance-contract.ts`,
`node-http-adapter.ts`, `enterprise-configuration.ts`,
`assurance-reviewer-credentials.ts`, `sqlite-assurance-store.ts`) and the tests.

**Works as documented (verified by passing tests in this run):**

- F-1. Every operator route resolves the caller through one function. The
  organization, actor and roles come only from the reviewer credential.
  Declared identity fields must equal it or be omitted.
- F-2. Reviewer-only mode refuses organization keys and the system context
  on every Assurance write (O13).
- F-3. Separation of duties is enforced in the service, for in-process
  callers too, before any draft is built (O07).
- F-4. Release requires durable SQLite custody. An in-memory Host refuses
  with `503` and keeps nothing (O14).
- F-5. Compare-and-set on non-terminal writes closes the last-writer-wins
  race that HTTP evidence submission would have exposed.
- F-6. Logs and error bodies carry no token, body, evidence, rationale or
  report content (planted-marker tests).
- F-7. Authoritative verification separates integrity from authority, and
  never claims a signature.

**Gaps relevant to commercial operation (not defects of REL-01D's stated
scope):**

- F-8. **[CLOSED by ASSURE-OPS-01 — see `docs/security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md`]** **No supported package export.** The six delivery files are assembled
  only by test code (`assure-pilot-01-scenario.ts` `writePilotPackage`,
  `pilotLimitationsExtract`, the verification-instructions text). An operator
  has the draft and release over HTTP, but no supported way to produce
  `limitations.md` and `verification-instructions.md`, or to guarantee
  byte-exact writing. → **R-05**
- F-9. **Evidence submitter is not in the stored assessment**, only in the
  operator log line. Log retention therefore becomes part of the engagement
  record. → R-07, retention D-04.
- F-10. **[CLOSED by ASSURE-OPS-01]** **Reviews are accepted after completion** (PILOT-01 rec. 5, still
  pinned). No released content changes, and separation of duties counts them.
  → **R-02**
- F-11. **[CLOSED by ASSURE-OPS-01]** **Reviewer IDs are not validated** against being emails or personal
  names, but they appear verbatim in delivered reports (PILOT-01 rec. 7). → **R-04**
- F-12. **Static bearer credentials**, no MFA or passkey for release, no rate
  limiting, rotation by restart. Acceptable only on a private network. → R-03
- F-13. **[PARTLY CLOSED by ASSURE-OPS-02]** **No encryption at rest** for the Assurance Store, and the backup tool
  does not encrypt. → process now; R-09. Engagement backups are now sealed; volume encryption is detected by the preflight, not enforced.
- F-14. **[ADDRESSED by ASSURE-OPS-02 as engagement disposition; approval of the policy still pending]** **No per-customer deletion.** Store and custody are append-only by
  design. Deletion requires one Host per customer plus destroying the store
  and its backups. → R-08 or a process
- F-15. **Restore loses later releases.** Documented in REL-01A §12. A backup
  after every release is mandatory.
- F-16. The REL-01D document header still says "implemented on
  `feat/assure-rel-01d-operator-interface`. Not deployed." after merge. This
  is cosmetic, and was left unchanged here to avoid editing a security
  record outside this mission's scope. → R-11

## 5. Validation performed (synthetic, bounded)

All commands ran with `timeout ≤ 590 s`. They used the Windows Node runtime
(`node.exe` 22.22.0), because the worktree's native `better-sqlite3` binding
is Windows-built. No real customer data was used. No full local test battery
was run.

| Check | Command | Result |
| --- | --- | --- |
| Build | `scripts/release/clear-release-identity.mjs` + `tsc -b` | exit 0 |
| HTTP pilot, reviewer-only, separation of duties, custody and restart, tenant boundary, leakage, framework opt-in, concurrency, PILOT-01, REL-01A, REL-01C, framework golden digest, SEC-01B, REP-01, SEC-01D | `node --test` on 10 compiled suites | **199 / 199 pass** |
| SEC-01A, SEC-01C, SEC-01E, REL-01B, verification | `node --test` on 5 compiled suites | **114 / 114 pass** |
| Independent verification | `run-pilot-01-dry-run.mjs` then `verify-commercial-package.mjs --store-copy … --renderer …` | `PASS (files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody); external authenticity NOT DEMONSTRATED`. The synthetic output was written to a temporary directory and then deleted |
| API freeze | `node scripts/check-api-freeze.mjs` | pass (44 frozen routes, no drift) |
| Release docs | `node scripts/check-release-docs.mjs` | pass |
| Release manifest | `node scripts/verify-release-manifest.mjs` | **Fails locally on the unchanged baseline**: the checksum of `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` differs. Cause: this Windows worktree has `core.autocrlf=true`, so checked-out docs are CRLF. CI (LF) passes this check on the same commit. Not caused by this mission, and this mission adds no file the manifest tracks |

Observed environment pitfall: the dry-run script cannot open SQLite on a
`\\wsl$` UNC path (`ASSURANCE_STORE_UNAVAILABLE`). Use a local Windows or
Linux path.

## 6. Proposed service definition

[`SERVICE_SPECIFICATION.md`](SERVICE_SPECIFICATION.md). In brief: a
human-reviewed, evidence-bound, point-in-time, sample-based assessment of a
declared scope against the ten `rn.sv@0.1.0` controls. PASS, PARTIAL, FAIL or
UNKNOWN per control, a 0–100 score with stated limitations, a remediation
roadmap with owners left to agree, and a verifiable package. It is explicitly
not a certification, audit, guarantee, compliance opinion or agent-safety
assurance.

## 7. Residual risks

| # | Risk | Likelihood / impact (qualitative) | Treatment | Owner |
| --- | --- | --- | --- | --- |
| RR-1 | A customer or third party treats the report as a certification | Medium / High | Notice G on every package; SOW language; the report's own disclaimers | FDR, LEG |
| RR-2 | Forged or altered package circulates; the holder cannot tell offline | Low / High | Second-channel digest confirmation; authoritative verification on request; R-01 signing | SEC |
| RR-3 | One person approves their own review using two credentials | Low / High | Credential register, attestation, post-release audit | FDR, OPS |
| RR-4 | Bearer secret leaked | Low–Medium / High | Private network, one holder, rotation, R-03 | OPS, SEC |
| RR-5 | Customer supplies unlawful or over-broad evidence (PII, secrets) | Medium / High | Drafts C and E; refusal and deletion procedure | OPS, LEG |
| RR-6 | Evidence artifacts mishandled (no defined store) | Medium / High | D-05 decision before any engagement | OPS |
| RR-7 | Store or backups read by an unauthorized party (plaintext) | Low / High | Encrypted volume and backups; host access control | OPS |
| RR-8 | Release lost to a restore and re-released differently | Low / Medium | Backup after every release; post-restore reconciliation | OPS |
| RR-9 | Reviewer judgement error on supplier evidence | Medium / Medium | Methodology, sampling, independent approval; disclosed limitation | GOV |
| RR-10 | PII exposure via reviewer IDs in reports | Medium / Low | Policy enforced since ASSURE-OPS-01 (R-04); role-style IDs for names (process) | OPS |
| RR-11 | Selling under `restricted` without the governance decision | Low / High | This gate; M1 | FDR |
| RR-12 | Liability exposure without reviewed terms or insurance | Medium / High | G-LEGAL | LEG |

## 8. Prioritized remediation backlog

Each item is a **separate mission**. None is implemented here.

| ID | Priority | Item | Gate | Type |
| --- | --- | --- | --- | --- |
| R-05 | ~~P0~~ **CLOSED** | Supported operator export of the delivery package (byte-exact; `limitations.md`; `verification-instructions.md`), with offline verification as part of export — ASSURE-OPS-01 | G-TECH | Code |
| R-06 | P0 (after D-01) | Governed `rn.sv@0.2.0`: new frozen file, digest and test; `commercialUse` recording the authorization; opt-in registration | G-FRAMEWORK | Code + governance |
| R-02 | ~~P1~~ **CLOSED** | Refuse manual reviews on terminal assessments (PILOT-01 rec. 5) — ASSURE-OPS-01 | G-TECH | Code |
| R-04 | ~~P1~~ **CLOSED** | Host configuration refuses reviewer IDs that look like emails or contain whitespace-separated names (PILOT-01 rec. 7) — ASSURE-OPS-01 (well-formed personal-name tokens stay procedural) | G-TECH / G-INFO | Code |
| R-01 | P1 | Issuer signature over `releaseDigest`, with key custody, verifier support, and reuse of the FV-P4B signed-verifier pattern (PILOT-01 rec. 2) — closes B7 | G-TECH / G-FRAMEWORK | Code + key management |
| R-03 | P1 | Passkey-bound release approval (AUTH-03 decision challenge); rate limiting | G-TECH | Code |
| R-09 | ~~P2~~ **CLOSED (backups) / PROCEDURAL (volume)** | Encrypted backup output, or documented integration with an encrypted volume — ASSURE-OPS-02 | G-INFO | Code or ops |
| R-07 | P2 | Record the evidence submitter in the stored assessment | G-TECH | Code (contract change) |
| R-08 | ~~P2~~ **TOOLING CLOSED; decision D-08 pending** | Per-customer export and purge tooling, or a formal decision that one Host per customer plus store destruction is the policy — ASSURE-OPS-02 | G-INFO | Code or decision |
| R-10 | P2 | Investigate the `Publishability` failure on main @ `5012246c` (tarball validation, one test) | — | CI |
| R-11 | P3 | Update the REL-01D status header after merge | — | Docs |

## 9. Decisions requiring founder approval

| ID | Decision | Options (recommendation first) |
| --- | --- | --- |
| D-01 | How commercial use is authorized | (a) a new governed `rn.sv@0.2.0` **(recommended)**; (b) an off-framework governance record for unpaid pilots only; (c) do not authorize yet |
| D-02 | Who performs the "controlled external review" that the restriction requires | (a) a named independent reviewer outside the delivery team, per release; (b) treat the release approver as that review (weak: internal); (c) defer until R-01 |
| D-03 | Accept security residuals for a private pilot: static bearer secrets, no MFA, no rate limit, no signature, credential ≠ person | Accept with conditions (private network, register, second-channel digest) / require R-01 and R-03 first |
| D-04 | Retention values (`CUSTOMER_DATA_GOVERNANCE.md` §10) | Approve the proposed values / amend after legal advice |
| D-05 | Evidence artifact storage, Host location and subprocessor list | Leave artifacts with the customer **(recommended)** / a per-engagement encrypted repository |
| D-06 | Pricing and packaging (draft J) | Choose among the scenarios; decide founding discount and terms |
| D-07 | Reassessment commercial terms | Included once within N months / separately priced |
| D-08 | One dedicated Host per customer | Approve **(recommended; enables deletion)** / shared Host (not supported: one Host serves one organization) |
| D-09 | Contracting entity, jurisdiction, insurance | LEG-led |

## 9a. Update — ASSURE-OPS-01

R-02, R-04 and R-05 were implemented and tested by ASSURE-OPS-01
(`docs/security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md`). The
residuals they do not touch are unchanged: B7, A10, static credentials,
encryption at rest, retention and deletion, legal review and framework
authorization. The final commercial decision stays **NO-GO**.

## 9b. Update — ASSURE-OPS-02

Engagement isolation, sealed backups, verify-by-restore, lifecycle and gated
offboarding are implemented and tested on synthetic engagements
(`docs/security/ASSURE-OPS-02-SECURE-CUSTOMER-DATA.md`). Not done: a real
engagement Host (none provisioned), proof of volume encryption on it (the
development machine is unencrypted), approved retention, legal review and
framework authorization. Final decision: **NO-GO**.

## 9c. Update — ASSURE-GOV-01

The governance package is in [`governance/`](governance/GOVERNANCE_READINESS.md).
It re-verifies the technical record on `2e32eb15`, records new governance
findings GF-01…GF-09, and proposes the review protocol, risk register, version
strategy and decision options. Nothing is approved. Final decision: **NO-GO**.
§10 below is historical: R-05, R-02 and R-04 were done by ASSURE-OPS-01. The
current recommendation is in `governance/GOVERNANCE_READINESS.md` §7.

## 10. Recommended next mission

**ASSURE-REL-01F — Supported delivery-package export (R-05)**, together with
the two small hardening items **R-02** and **R-04**. These are the remaining
*technical* items that an operator needs for a real engagement and that need
no governance decision first. In parallel, and outside engineering: founder
decisions D-01, D-02, D-03, D-05 and D-08, and legal review of drafts B, D, E
and G. R-06 (`rn.sv@0.2.0`) follows D-01.
