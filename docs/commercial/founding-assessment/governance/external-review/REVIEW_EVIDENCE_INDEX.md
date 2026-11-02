# Review Evidence Index — Pinned Bundle for R1 (ASSURE-GOV-02)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — reviewer's
> evidence bundle.** It says where the evidence is and what kind of evidence it
> is. It extends [`../INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](../INDEPENDENT_REVIEW_EVIDENCE_INDEX.md)
> (GOV-01, pinned at `2e32eb15`) to the current baseline; **where they differ,
> this document is current** (§7). Nothing here is a review result. Results
> recorded by Republika must be reproduced by the reviewer (protocol §8).
> Synthetic evidence only. Labels: VERIFIED · PROPOSED · PENDING · BLOCKED.

## 1. Identity

| Item | Value | How verified |
| --- | --- | --- |
| Repository | `https://github.com/Republika-Network/Frontera` | `git remote -v` |
| Baseline commit | `48b90d734dd0c6b884ce2be3c0d398536353fafb` (ASSURE-CLAIMS-01, #256, 2026-11-02 11:12:44 -0600) | `git rev-parse origin/main` |
| `rn.sv@0.1.0` golden digest | `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58` | Test "matches the golden digest" (`assurance-rn-sv-framework.test.ts:403`), run in ASSURE-GOV-02; also pinned independently in `scripts/assurance/verify-commercial-package.mjs:46` |
| `aoc.saf@1.0.0` golden digest | `sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9` | Same suite |
| Digest function | `computeDigest`, `src/enterprise/governance-store/digest.ts` (canonical JSON `aoc.canonical-json.v1`, SHA-256) | Code reading |
| Current report generator | `aoc.assurance.commercial-report.v3` (`commercial-report.ts:58`); verifier knows v1, v2, v3 (`verify-commercial-package.mjs:58-61`) | Code reading; CLAIMS-01 suite |
| Framework opt-in | `ASSURANCE_OPTIONAL_FRAMEWORKS = ['rn.sv@0.1.0']` (`enterprise-configuration.ts:482`); composition map (`composition-root.ts:2588`) | Code reading |

The reviewer re-derives every value in this table at the commit pinned in the
engagement letter. If that commit is not the baseline, Republika re-verifies
§1–§5 first and records the delta in §7.

## 2. Evidence classes

Every item below is labelled with one class. The reviewer should weigh them
accordingly.

| Class | Meaning | Example |
| --- | --- | --- |
| **OBS** Observed fact | Readable directly in the source or a committed file at the pinned commit | A constant, a frozen string, a digest literal |
| **TEST** Test evidence | A named automated test that passed on synthetic data in a recorded run. Shows behaviour under the tested conditions only | "A10 KNOWN LIMITATION …" |
| **PROC** Procedural claim | A statement that something will be done by a person (a register kept, a backup held by SEC, a letter signed). **Nothing in the repository proves it happens** | B7 Option A A-1…A-5; credential register |
| **ASSUME** Unsupported assumption | Taken as true by the design or documents but not evidenced | One Host per customer actually used; engagement volume actually encrypted; weights meaningful |

## 3. Source and evidence map

| # | Topic | Source (pinned commit) | Design record | Tests | Class |
| --- | --- | --- | --- | --- | --- |
| 1 | Framework definition, restriction, ten controls, scoring model | `src/enterprise/assurance/frameworks/rn-sv-framework.ts` (controls L150–L300; domains L452–L492; `scoringModel` L494–L509; `commercialUse` L536–L550) | File header | `assurance-rn-sv-framework.test.ts` | OBS, TEST |
| 2 | Scoring implementation | `src/enterprise/assurance/scoring.ts` (domain blocking ~L108–L135; `computeOverallScore` ~L160–L190) | — | `assurance-scoring.test.ts` | OBS, TEST |
| 3 | Registry, lifecycle, resolution | `framework-registry.ts`; `service.ts:360-362` (`frameworkFor`, `allowRetired: true`) | REL-01D §8; GF-08, GF-09 | `assurance-framework.test.ts` | OBS |
| 4 | Evidence trust (B1, B2, B8) | `manual-evidence-trust.ts`, `metrics.ts` | [`ASSURE-SEC-01C`](../../../../security/ASSURE-SEC-01C-MANUAL-EVIDENCE-TRUST.md) | `assurance-sec-01c-manual-evidence-trust.test.ts` | TEST |
| 5 | Evidence-bound reviews (B9) | `manual-review-evidence.ts` | **None (GF-05)** | `assurance-sec-01a-evidence-bound-reviews.test.ts`; `assure-ops-01-terminal-review.test.ts` | TEST |
| 6 | Reviewer authentication (B3) | `orchestration/assurance-reviewer-credentials.ts`, `api/assurance-operator-access.ts` | [`SEC-01B`](../../../../security/ASSURE-SEC-01B-AUTHENTICATED-REVIEWERS.md), [`REL-01D`](../../../../security/ASSURE-REL-01D-OPERATOR-INTERFACE.md) | `assurance-sec-01b-authenticated-reviewers.test.ts`; `assure-rel-01d-operator-interface.test.ts`; `assure-ops-01-reviewer-privacy.test.ts` | TEST; per-person separation is PROC |
| 7 | Tenant isolation, bundles (B4, B5) | see record | [`SEC-01D`](../../../../security/ASSURE-SEC-01D-TENANT-BUNDLE-VERIFICATION.md) | `assurance-sec-01d-tenant-bundle-verification.test.ts` | TEST |
| 8 | Atomic completion, terminal immutability (B6) | `sqlite-assurance-store.ts` (`completeAssessment`) | [`SEC-01E`](../../../../security/ASSURE-SEC-01E-FINDING-EVENT-INTEGRITY.md) | `assurance-sec-01e-finding-event-integrity.test.ts`; `assure-ops-01-terminal-review.test.ts` | TEST |
| 9 | Commercial report, disclosures (GF-01, GF-06) | `commercial-report.ts`; `commercial-report-format.ts` (`DISCLOSURE_WORDING_V1_V2` L92, `DISCLOSURE_WORDING_V3` L104); `commercial-report-markdown.ts` | [`AOC_ASSURANCE_COMMERCIAL_REPORT.md`](../../../../enterprise/AOC_ASSURANCE_COMMERCIAL_REPORT.md); [`ASSURE-CLAIMS-01`](../../../../security/ASSURE-CLAIMS-01-REPORT-DISCLOSURE-INTEGRITY.md) | `assurance-rep-01-commercial-report.test.ts`; `assure-claims-01-commercial-disclosures.test.ts` | OBS, TEST |
| 10 | Report generator versions, historical fixtures | `docs/enterprise/examples/historical/rn-sv-founding-assessment.synthetic.v1.*`, `….v2.*`; current `docs/enterprise/examples/rn-sv-founding-assessment.synthetic.*`; test-side transform `src/enterprise/__tests__/commercial-report-historical.ts` | CLAIMS-01 §3, §5; [`REL-01C`](../../../../security/ASSURE-REL-01C-RELEASED-REPORT-CONSISTENCY.md) | CLAIMS-01 G01-05…G01-09; REP-01; `assure-rel-01c-released-report-consistency.test.ts` | OBS, TEST |
| 11 | Release custody, authoritative verification (B7, A10) | `service.ts` (`releaseCommercialReport` L1307, `replayOrRefuse` L329, `verifyCommercialRelease` L1471); `commercial-release-custody.ts`; `sqlite-assurance-store.ts` | [`REL-01A`](../../../../security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md) | `assure-rel-01a-durable-release.test.ts` (A10 at L484) | TEST |
| 12 | Contradiction recovery | see record | [`REL-01B`](../../../../security/ASSURE-REL-01B-CONTRADICTION-RECOVERY.md) | `assure-rel-01b-contradiction-recovery.test.ts` | TEST |
| 13 | Package export | `GET /api/assurance/commercial-releases/{reportId}/package`; `commercial-release-package.ts`; `scripts/assurance/materialize-commercial-package.mjs` | [`OPS-01`](../../../../security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md) | `assure-ops-01-customer-export.test.ts` (A10 export at L271) | TEST |
| 14 | Engagement isolation, encryption detection, sealed backups, offboarding (OPS-02) | `scripts/assurance/engagement-ops.mjs` | [`OPS-02`](../../../../security/ASSURE-OPS-02-SECURE-CUSTOMER-DATA.md) | `assure-ops-02-secure-customer-data.test.ts` | TEST; real-Host encryption is ASSUME (no Host exists) |
| 15 | Independent offline verifier | `scripts/assurance/verify-commercial-package.mjs` | REL-01A §11; [`PILOT-01`](../../../../enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md) §3–§4 | Verifier run in [`REPRODUCTION_GUIDE.md`](REPRODUCTION_GUIDE.md) §5 | TEST |
| 16 | Synthetic end-to-end | `scripts/assurance/run-pilot-01-dry-run.mjs`; REL-01D Host pilot P01; CLAIMS-01 H01 | PILOT-01 | `assure-pilot-01-commercial-dry-run.test.ts`; `assure-rel-01d-host-pilot.test.ts:73`; CLAIMS-01 H01 | TEST |
| 17 | Existing signing primitives (B7 Option B input) | `src/enterprise/authority-authenticity/` | [`AUTHORITY_ARTIFACT_AUTHENTICITY.md`](../../../../security/AUTHORITY_ARTIFACT_AUTHENTICITY.md) | Not used by Assurance | OBS |
| 18 | Governance and commercial pack | [`../`](../GOVERNANCE_READINESS.md), [`../../`](../../README.md) | — | CLAIMS-01 G06-01…G06-06 check wording | OBS, PROC |

## 4. Relevant security missions (PRs)

| Mission | PR | Addresses | Record |
| --- | --- | --- | --- |
| ASSURE-SEC-01A | #228 | B9 | none (GF-05) |
| ASSURE-SEC-01B | #229 | B3 | `docs/security/ASSURE-SEC-01B-*` |
| ASSURE-SEC-01C | #232 | B1, B2, B8 | `docs/security/ASSURE-SEC-01C-*` |
| ASSURE-SEC-01D | #233 | B4, B5 | `docs/security/ASSURE-SEC-01D-*` |
| ASSURE-SEC-01E | #235 | B6 | `docs/security/ASSURE-SEC-01E-*` |
| ASSURE-REP-01 | #237 | Commercial report generator (v1) | `docs/enterprise/AOC_ASSURANCE_COMMERCIAL_REPORT.md` |
| ASSURE-PILOT-01B | #238 | Dry run, independent verifier, F01–F04 pinned | `docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md` |
| ASSURE-REL-01A | #240 | F01, custody (B7 partial; A10 pinned) | `docs/security/ASSURE-REL-01A-*` |
| ASSURE-REL-01B | #242 | F02 contradiction recovery | `docs/security/ASSURE-REL-01B-*` |
| ASSURE-REL-01C | #244 | F03, generator v2 | `docs/security/ASSURE-REL-01C-*` |
| ASSURE-REL-01D | #248 | F04, operator interface, B3 | `docs/security/ASSURE-REL-01D-*` |
| ASSURE-REL-01E | #249 | Commercial readiness pack, launch gate | `../../README.md` |
| ASSURE-OPS-01 | #251 | export, R-02 (terminal), R-04 (reviewer IDs) | `docs/security/ASSURE-OPS-01-*` |
| ASSURE-OPS-02 | #253 | isolation, encryption detection, backups, offboarding | `docs/security/ASSURE-OPS-02-*` |
| ASSURE-GOV-01 | #254 | governance package | `../` |
| ASSURE-CLAIMS-01 | #256 | GF-01, GF-06, C9 | `docs/security/ASSURE-CLAIMS-01-*` |

PR numbers VERIFIED against `git log --oneline origin/main` at the baseline.
The reviewer can confirm each with `git log --oneline --grep <mission>`.

## 5. Findings and residuals the reviewer must see

| ID | What | Status | Canonical record |
| --- | --- | --- | --- |
| B1–B9 | The nine frozen `rn.sv@0.1.0` blockers | 8 technically CLOSED (B1, B3 with material residual); **B7 OPEN** | [`../B1_B9_BLOCKER_DISPOSITION.md`](../B1_B9_BLOCKER_DISPOSITION.md) |
| A10 | Issuer-controlled custody: a store writer who recomputes every digest is not detected | Residual, pinned by test | REL-01A; SR-04 |
| F01–F04 | PILOT-01 dry-run findings: forged approval / double release; contradiction deadlock; Markdown vs release record; no operational interface | F01 resolved under authoritative verification only (still passes offline); F02–F04 resolved by REL-01B/C/D | [PILOT-01 §5](../../../../enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md) |
| GF-01 | Cover wording equated internal approver with controlled review | IMPLEMENTED in generator v3; historical v1/v2 unchanged; D-02 PENDING | [`../GOVERNANCE_READINESS.md`](../GOVERNANCE_READINESS.md) §4, §4a |
| GF-02…GF-05, GF-07…GF-09 | Self-expiring restriction wording; unapproved "Accepted"; inconsistent data policy; no SEC-01A record; hard-binding to 0.1.0; deregistration; `deprecate()` | Recorded; not fixed | Same |
| GF-06 | Customer drafts claimed independence | IMPLEMENTED in drafts; LEG review PENDING | Same; [`../CUSTOMER_CLAIMS_REVIEW.md`](../CUSTOMER_CLAIMS_REVIEW.md) §7 |
| SR-01…SR-14 | Risk register | Every acceptance PENDING | [`../SECURITY_RISK_REGISTER.md`](../SECURITY_RISK_REGISTER.md) |
| R-C1…R-C7 | CLAIMS-01 residuals | Open | CLAIMS-01 §11 |

### Unresolved authenticity exposure (B7 and A10) — stated plainly

- **Offline:** anyone who edits a package and recomputes every digest produces
  a package that the offline verifier passes. The verifier says so:
  `external authenticity NOT DEMONSTRATED`.
- **Against custody:** custody is the issuer's own SQLite record. A store
  administrator who rewrites a row coherently is **not** detected; the export
  then reports `RELEASE_MATCHES_AUTHORITY` (A10; two pinned tests).
- **No signature, timestamp or anchor exists.** `externalSignature` is always
  `EXTERNAL_SIGNATURE_NOT_AVAILABLE`.
- **Mitigations are procedural only** (Option A, A-1…A-5): class PROC. None has
  been performed, because no engagement exists.

## 6. What the bundle excludes (by design)

No bearer secret, credential register, password-manager export, backup key,
volume recovery key, signing key, real customer evidence, real engagement
store, real engagement configuration, or operator personal data. All packages
are generated by the reviewer from synthetic scenarios. The pilot scenario's
credentials are test fixtures created in a temporary directory and destroyed
with it. If the reviewer finds anything resembling a real secret in the
repository, that is itself a Critical finding to report.

## 7. Drift since the GOV-01 index (VERIFIED at `48b90d7`)

ASSURE-CLAIMS-01 (#256) changed code after the GOV-01 index and several GOV-01
documents were written. The GOV-01 documents explicitly cite line numbers "at
`2e32eb15`", so they are not wrong for that commit; they are **stale for the
current one**. They are left unedited here (they are records of their mission).

| GOV-01 reference | At `2e32eb15` | At `48b90d7` |
| --- | --- | --- |
| Pinned commit (GOV-01 index §1) | `2e32eb15` | `48b90d7` |
| Generator version (candidate spec §6) | `COMMERCIAL_REPORT_GENERATOR_VERSION` = V2 | = **V3** (`commercial-report.ts:58`) |
| Report gate refusing non-0.1.0 (GF-07; spec §6) | `commercial-report.ts:473` | `:485-488` |
| Readiness `framework_exact` | `:521` | `:533-534` |
| Control-coverage list | `:59, :542` | `:64` (`RN_SV_CONTROL_IDS`), `:554-555` |
| Limitation and scope texts naming `rn.sv@0.1.0` | `:411, :416, :425` | `:423, :428, :437` |
| Cover commercial-use statement (GF-01) | `:787-791`, fixed text | `:799-802`, now `DISCLOSURE_WORDING_V3.commercialUseStatement` |
| Acknowledgement doc comment (GF-01) | `:286` | `:292` |
| Verifier 0.1.0 pin | `verify-commercial-package.mjs:45-46, 145-147` | `:45-46` (digest), `:153-154` (expected version/digest) |
| Evidence index §3 battery | 9 batches | Add **CLAIMS-01** suite and **REL-01B** (run in GOV-02) |
| Historical fixtures | v1 only | v1 **and v2** (`docs/enterprise/examples/historical/*.v2.*`, added by CLAIMS-01) |
| Unchanged and still correct | `rn-sv-framework.ts:536-539` (GF-02); `enterprise-configuration.ts:482`; `composition-root.ts:2588`; `service.ts:360-362`; `api/assurance-contract.ts:293`; all file paths in GOV-01 index §2 (each checked to exist) | — |

**Consequence for R-06 planning:** the impact table in
[`../RN_SV_0_2_0_CANDIDATE_SPEC.md`](../RN_SV_0_2_0_CANDIDATE_SPEC.md) §6 should be
re-pinned when R-06 starts. Not done here because creating or planning
`rn.sv@0.2.0` code is out of scope.

## 8. What the evidence shows, and what it does not

Unchanged from [`../INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](../INDEPENDENT_REVIEW_EVIDENCE_INDEX.md) §5,
with one addition: the tests show that generator v3 **text** separates
internal review, internal approval, external review (none) and commercial
authorization. They do not show that a reader will understand it, or that it
is lawful wording in any jurisdiction (LEG).

**FINAL COMMERCIAL DECISION: NO-GO.**
