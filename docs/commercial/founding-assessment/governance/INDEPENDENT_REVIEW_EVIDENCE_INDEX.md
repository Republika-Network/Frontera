# Independent Review Evidence Index (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — reviewer's pack.**
> It lists where the evidence is and how to reproduce it. The results in §4 were
> recorded by Republika's engineering agent. **They are not independent
> evidence**, and the reviewer must reproduce them (protocol §8). No review
> result exists. Labels: VERIFIED · PROPOSED · PENDING · BLOCKED.

## 1. Pinned identity

| Item | Value |
| --- | --- |
| Repository | `Republika-Network/Frontera` |
| Commit for this pack | `origin/main` @ `2e32eb159a02675e5e37f1d0d47f446339bb5706` (the engagement letter pins the commit actually reviewed) |
| `rn.sv@0.1.0` golden digest | `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58` |
| `aoc.saf@1.0.0` golden digest | `sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9` |
| Digest function | `computeDigest` in `src/enterprise/governance-store/digest.ts` |

## 2. Source map (read in this order)

| # | Topic | Source files | Design record |
| --- | --- | --- | --- |
| 1 | Framework definition and restriction | `src/enterprise/assurance/frameworks/rn-sv-framework.ts` | Header comment of that file |
| 2 | Registry, lifecycle, resolution | `src/enterprise/assurance/framework-registry.ts`; opt-in in `src/enterprise/configuration/enterprise-configuration.ts` (`ASSURANCE_OPTIONAL_FRAMEWORKS`) and `src/enterprise/composition/composition-root.ts` | REL-01D §8 |
| 3 | Evidence trust (B1, B2, B8) | `src/enterprise/assurance/manual-evidence-trust.ts`, `metrics.ts` | `docs/security/ASSURE-SEC-01C-MANUAL-EVIDENCE-TRUST.md` |
| 4 | Evidence-bound reviews (B9) | `src/enterprise/assurance/manual-review-evidence.ts` | **None (GF-05)**; framework header "Review finding F01" |
| 5 | Reviewer identity (B3) | `src/enterprise/orchestration/assurance-reviewer-credentials.ts`, `src/enterprise/api/assurance-operator-access.ts` | `docs/security/ASSURE-SEC-01B-AUTHENTICATED-REVIEWERS.md`, `ASSURE-REL-01D-OPERATOR-INTERFACE.md` |
| 6 | Tenant attribution, bundles (B4, B5) | see design record | `docs/security/ASSURE-SEC-01D-TENANT-BUNDLE-VERIFICATION.md` |
| 7 | Atomic completion (B6) | `AssuranceStore.completeAssessment`, `sqlite-assurance-store.ts` | `docs/security/ASSURE-SEC-01E-FINDING-EVENT-INTEGRITY.md` |
| 8 | Commercial report, disclosure, readiness | `src/enterprise/assurance/commercial-report.ts`, `commercial-report-format.ts`, `commercial-report-markdown.ts` | `docs/enterprise/AOC_ASSURANCE_COMMERCIAL_REPORT.md` |
| 9 | Release custody, verification (B7, A10) | `src/enterprise/assurance/service.ts` (release ~L1300–1400, `verifyCommercialRelease` ~L1471), `sqlite-assurance-store.ts` | `docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md` |
| 10 | Contradiction recovery, released-report consistency | see design records | `ASSURE-REL-01B-…`, `ASSURE-REL-01C-…` |
| 11 | Package export | `GET /api/assurance/commercial-releases/{reportId}/package`; `scripts/assurance/materialize-commercial-package.mjs` | `docs/security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md` |
| 12 | Engagement isolation, encryption detection, backups, offboarding | `scripts/assurance/engagement-ops.mjs` | `docs/security/ASSURE-OPS-02-SECURE-CUSTOMER-DATA.md` |
| 13 | Independent offline verifier | `scripts/assurance/verify-commercial-package.mjs` | REL-01A §11; `docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md` §3–§4 |
| 14 | Existing signing primitives (for B7 Option B) | `src/enterprise/authority-authenticity/` | `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` |
| 15 | Commercial governance pack | `docs/commercial/founding-assessment/` | this directory |

## 3. Reproduction instructions

Synthetic data only. Never point these commands at a real engagement store.

```bash
git clone https://github.com/Republika-Network/Frontera && cd Frontera
git checkout <pinned commit>
npm ci
npm run build            # clear-release-identity + tsc -b
```

Run suites **one or two at a time** (the full battery is not needed):

```bash
T=dist/src/enterprise/__tests__
node --test $T/assurance-rn-sv-framework.test.js $T/assure-rel-01c-released-report-consistency.test.js
node --test $T/assurance-rep-01-commercial-report.test.js
node --test $T/assure-ops-01-customer-export.test.js $T/assure-ops-02-secure-customer-data.test.js
node --test $T/assure-rel-01a-durable-release.test.js $T/assure-rel-01d-host-pilot.test.js
node --test $T/assurance-sec-01a-evidence-bound-reviews.test.js $T/assurance-sec-01c-manual-evidence-trust.test.js
node --test $T/assurance-sec-01b-authenticated-reviewers.test.js $T/assure-ops-01-terminal-review.test.js
node --test $T/assurance-sec-01d-tenant-bundle-verification.test.js $T/assurance-sec-01e-finding-event-integrity.test.js
node --test $T/assure-rel-01d-operator-interface.test.js $T/assure-ops-01-reviewer-privacy.test.js
node --test $T/assure-pilot-01-commercial-dry-run.test.js
```

Independent verifier on a fresh synthetic package:

```bash
OUT=$(mktemp -d)/pilot     # must not exist or be empty
node scripts/assurance/run-pilot-01-dry-run.mjs --out "$OUT"
node scripts/assurance/verify-commercial-package.mjs "$OUT/founding-assessment" \
  --store-copy "$OUT/trusted-source/assurance-store.snapshot.db" \
  --renderer dist/src/enterprise/assurance/commercial-report-markdown.js
rm -rf "$OUT"
```

Documentation and coherence:

```bash
node scripts/check-release-docs.mjs
node scripts/check-api-freeze.mjs
node scripts/verify-release-manifest.mjs
```

**Environment pitfalls (observed):**

- Windows checkout with `core.autocrlf=true` makes `verify-release-manifest.mjs`
  fail on `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` (CRLF). The committed
  LF blob matches. Use an LF checkout or Linux.
- Under Windows Node, scripts that use `new URL(...).pathname` resolve
  `C:\C:\…` and report every file missing (`check-release-docs.mjs`,
  `check-api-freeze.mjs`, `verify-release-manifest.mjs`). Run them with Linux
  Node; they do not need the SQLite binding.
- The native `better-sqlite3` binding must match the Node used to run tests
  (here: Windows-built, so `node.exe`).
- SQLite cannot open stores on a `\\wsl$` UNC path; use a local path.

## 4. Results recorded by Republika (not independent)

Recorded 2026-11-02 at `2e32eb15`, Windows Node 22.22.0 (tests) and Linux Node
22.23.1 (doc checks), each under a 590-second timeout.

| Batch | Suites | Result | Key tests to reproduce |
| --- | --- | --- | --- |
| 1 | rn-sv framework + REL-01C | 32/32 | "matches the golden digest"; "registers alongside aoc.saf without replacing it"; "leaves the aoc.saf definition … byte-identical"; C13 v1 report stays valid; C18–C20 restriction preserved |
| 2 | REP-01 | 30/30 | historical v1 example verifies and re-renders exactly |
| 3 | OPS-01 export + OPS-02 | 23/23 | export, restart, byte-identical re-export; preflight; sealed backup; cross-customer restore refused |
| 4 | REL-01A + REL-01D Host pilot | 30/30 | `A10 KNOWN LIMITATION …`; P01 end-to-end over HTTP with restart and independent verification |
| 5 | SEC-01A + SEC-01C | 45/45 | evidence-bound reviews; manual evidence trust |
| 6 | SEC-01B + OPS-01 terminal review | 38/38 | credential binding; terminal-state refusal |
| 7 | SEC-01D + SEC-01E | 67/67 | tenant attribution; atomic completion |
| 8 | REL-01D operator interface + OPS-01 reviewer privacy | 39/39 | forged principals; reviewer-only; leakage; reviewer-ID policy |
| 9 | PILOT-01 dry run | 25/25 | "F01 RESOLVED UNDER AUTHORITATIVE VERIFICATION … still passes offline integrity" |
| — | Independent verifier | `PASS (files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody); external authenticity NOT DEMONSTRATED` | — |
| — | `check-release-docs` / `check-api-freeze` | pass / pass (45 frozen routes) | — |
| — | `verify-release-manifest` | CRLF-only local mismatch (see pitfalls) | — |

**Not run in this mission:** REL-01B contradiction recovery
(`assure-rel-01b-contradiction-recovery.test.js`), REL-01D concurrency, the
`assure01-*` trace suites, workspace packages, and the full battery. The
reviewer may run them.

## 5. What the evidence shows, and what it does not

| Shows (on synthetic data) | Does not show |
| --- | --- |
| The defects worded in B1–B6, B8, B9 no longer reproduce | That customer evidence is genuine (B1) |
| Credentials bind reviewer identity and role; separation of duties holds per credential | That two credentials are two people (B3) |
| Custody detects edited rows and package/custody mismatches | That custody cannot be rewritten coherently by its administrator (A10) |
| The offline verifier detects inconsistent packages | That a consistent package is authentic (B7) |
| The framework definition is byte-identical to its golden digest | That the framework is a good measure of "sovereignty posture" |
| The preflight detects an unencrypted volume | That any real engagement volume is encrypted (no engagement Host exists) |
