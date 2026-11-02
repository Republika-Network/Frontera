# Reproduction Guide — Running the Evidence Yourself (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT.** These commands let
> a reviewer reproduce the important guarantees, and the important
> *limitations*, on their own machine with synthetic data. The results in §6
> were recorded by Republika's AI engineering agent. **A result reproduced by
> an AI agent, including a second internal agent, is not independent
> validation.** The reviewer runs the commands and records their own output.

## 1. Rules

- Synthetic data only. Never point any command at a real engagement store,
  backup or configuration.
- Each command is bounded: wrap it in `timeout 590` (Linux) and stop if it
  exceeds 600 seconds. In the recorded runs no test batch exceeded 20 seconds.
- Run one or two suites per command; the full battery is not needed.
- No secrets are needed. The suites create their own throw-away fixtures.

## 2. Environment

### 2.1 Linux (recommended; the clean-environment path)

| Assumption | Value used in the recorded clean run |
| --- | --- |
| OS | Linux (recorded on WSL2 kernel 6.18; CI uses `ubuntu-24.04`) |
| Node | 22.x (recorded: 22.23.1; `package.json` requires `>=22`) |
| npm | 10.x (recorded: 10.9.8) |
| Git | Any; **LF line endings** (default on Linux) |
| Temp directory | On a **persistent** filesystem (ext4 etc.). If `/tmp` is `tmpfs`, some secure-profile suites refuse durable stores (`STORAGE_NOT_PERSISTENT`); set `TMPDIR` to a disk-backed directory. (Source: `.github/workflows/ci.yml` comment on the runner pin) |
| Network | Needed only for `git clone` and `npm ci` |

### 2.2 Windows (supported with caveats)

| Caveat | Effect | Workaround |
| --- | --- | --- |
| `core.autocrlf=true` | `verify-release-manifest.mjs` fails on `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` (CRLF working copy; the committed LF blob matches the manifest) | Clone with `git -c core.autocrlf=false clone …`, or use Linux |
| `new URL(...).pathname` in some scripts | Under Windows Node, `check-release-docs.mjs`, `check-api-freeze.mjs`, `verify-release-manifest.mjs` resolve `C:\C:\…` | Run those three with Linux Node |
| Native `better-sqlite3` binding | Must be built for the Node that runs the tests | Run `npm ci` and tests with the same Node |
| `\\wsl$` UNC paths | SQLite cannot open stores there | Use a local path |

## 3. Setup

```bash
git clone https://github.com/Republika-Network/Frontera.git && cd Frontera
git checkout 48b90d734dd0c6b884ce2be3c0d398536353fafb   # or the commit pinned in the engagement letter
git rev-parse HEAD                                      # record this
node --version && npm --version && uname -sr            # record these
timeout 590 npm ci --no-audit --no-fund
timeout 590 npm run build                               # clear-release-identity + tsc -b
export T=dist/src/enterprise/__tests__
```

## 4. Guarantees and limitations, with commands

| # | What is checked | Command | Expected result | Key test names to look for |
| --- | --- | --- | --- | --- |
| R01 | **Frozen framework digest**; `aoc.saf` untouched; historical v1 release still valid | `timeout 590 node --test $T/assurance-rn-sv-framework.test.js $T/assure-rel-01c-released-report-consistency.test.js` | 32 pass, 0 fail | "matches the golden digest"; "registers alongside aoc.saf without replacing it" |
| R02 | **Historical report compatibility** (v1, v2 bytes and digests pinned); **CLAIMS-01 disclosures** (v3 wording; no independence/proof claims; restriction visible) | `timeout 590 node --test $T/assurance-rep-01-commercial-report.test.js $T/assure-claims-01-commercial-disclosures.test.js` | 51 pass, 0 fail | G01-01…G01-12, G06-01…G06-06, H01 |
| R03 | **Exported package integrity**; restart and byte-identical re-export; **OPS-02 isolation**, encryption preflight, sealed backup, cross-customer restore refused | `timeout 590 node --test $T/assure-ops-01-customer-export.test.js $T/assure-ops-02-secure-customer-data.test.js` | 23 pass, 0 fail | "R05-13 … A10 KNOWN LIMITATION" (a coherent forgery in custody **is** exported) |
| R04 | **Durable custody**; **A10 limitation**; **synthetic end-to-end over HTTP** (P01) | `timeout 590 node --test $T/assure-rel-01a-durable-release.test.js $T/assure-rel-01d-host-pilot.test.js` | 30 pass, 0 fail | "A10 KNOWN LIMITATION -- a writer who rewrites a row and recomputes every digest is not detected"; "P01 create, evidence, reviews, …" |
| R05 | **Evidence binding** (B9, B8) and manual-evidence trust (B1, B2) | `timeout 590 node --test $T/assurance-sec-01a-evidence-bound-reviews.test.js $T/assurance-sec-01c-manual-evidence-trust.test.js` | 45 pass, 0 fail | — |
| R06 | **Reviewer authentication** (B3); **terminal immutability** (reviews refused on terminal assessments) | `timeout 590 node --test $T/assurance-sec-01b-authenticated-reviewers.test.js $T/assure-ops-01-terminal-review.test.js` | 38 pass, 0 fail | — |
| R07 | **Tenant isolation** (B4, B5); atomic completion (B6) | `timeout 590 node --test $T/assurance-sec-01d-tenant-bundle-verification.test.js $T/assurance-sec-01e-finding-event-integrity.test.js` | 67 pass, 0 fail | — |
| R08 | Operator interface: forged principals refused, reviewer-only mode, leakage, reviewer-ID policy | `timeout 590 node --test $T/assure-rel-01d-operator-interface.test.js $T/assure-ops-01-reviewer-privacy.test.js` | 39 pass, 0 fail | — |
| R09 | PILOT-01 dry run, F01–F04 pinned | `timeout 590 node --test $T/assure-pilot-01-commercial-dry-run.test.js` | 25 pass, 0 fail | "F01 RESOLVED UNDER AUTHORITATIVE VERIFICATION … still passes offline integrity, but custody rejects it" |
| R10 | **Scoring consistency**; contradiction recovery | `timeout 590 node --test $T/assurance-scoring.test.js $T/assure-rel-01b-contradiction-recovery.test.js` | 29 pass, 0 fail | — |

Scoring note: `assurance-scoring.test.ts` tests the scoring engine generally;
the `rn.sv`-specific weights and blocking controls are fixed by the golden
digest (R01). The questions in [`REVIEWER_BRIEFING.md`](REVIEWER_BRIEFING.md) §4
(Q-S1…Q-S3) are about methodology, not about whether the code computes what it
says.

## 5. Independent offline verifier and tamper check

Use a directory the reviewer controls; it must not exist or must be empty.

```bash
OUT="$HOME/frontera-review-pilot"          # choose any fresh path
timeout 590 node scripts/assurance/run-pilot-01-dry-run.mjs --out "$OUT"

# V1 — with the store copy and renderer (full check)
timeout 590 node scripts/assurance/verify-commercial-package.mjs "$OUT/founding-assessment" \
  --store-copy "$OUT/trusted-source/assurance-store.snapshot.db" \
  --renderer dist/src/enterprise/assurance/commercial-report-markdown.js

# V2 — package only (what a customer can do offline)
timeout 590 node scripts/assurance/verify-commercial-package.mjs "$OUT/founding-assessment"

# V3 — tamper: change one byte of the report, verify again
printf '\nTampered line.\n' >> "$OUT/founding-assessment/report.md"
timeout 590 node scripts/assurance/verify-commercial-package.mjs "$OUT/founding-assessment"; echo "exit=$?"

rm -r "$OUT"                                # synthetic output; delete afterwards
```

| Step | Expected verdict | Exit |
| --- | --- | --- |
| V1 | `PASS (files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody); external authenticity NOT DEMONSTRATED` | 0 |
| V2 | `PASS (files, artifactIntegrity, reportConsistency, approvalConsistency); external authenticity NOT DEMONSTRATED` | 0 |
| V3 | `FAIL: artifactIntegrity` | 1 |

**What V3 does not show.** Editing a file *and recomputing every digest*
produces a package that passes V2. That is the B7 limitation, reproduced by
R09 ("F01 … still passes offline integrity"). The reviewer may construct such a
forgery to confirm it; it is expected to pass offline.

The JSON output also states `reviewDisclosure` (v3: internal review and
internal approval, no external review recorded) and
`storeCopy: UNAUTHENTICATED_COPY`.

## 6. Documentation and coherence checks (Linux Node)

```bash
timeout 590 node scripts/check-release-docs.mjs     # expect: 24 documents present, versions consistent
timeout 590 node scripts/check-api-freeze.mjs       # expect: 45 frozen routes, 77 endpoints, no drift
timeout 590 node scripts/verify-release-manifest.mjs # expect: committed manifest matches the build (LF checkout)
```

## 7. Results recorded by Republika (NOT independent)

Recorded 2026-11-02 by the ASSURE-GOV-02 AI engineering agent at
`48b90d734dd0c6b884ce2be3c0d398536353fafb`, synthetic data, each command under
`timeout 590`.

| # | Run A — clean Linux clone (`git clone`, `npm ci`, `npm run build`; Node 22.23.1, npm 10.9.8) | Run B — existing Windows worktree (Windows Node 22.22.0, `tsc -b`) |
| --- | --- | --- |
| R01 | 32 / 32 | 32 / 32 |
| R02 | 51 / 51 | 51 / 51 |
| R03 | 23 / 23 | 23 / 23 |
| R04 | 30 / 30 | 30 / 30 |
| R05 | 45 / 45 | 45 / 45 |
| R06 | 38 / 38 | 38 / 38 |
| R07 | 67 / 67 | 67 / 67 |
| R08 | 39 / 39 | 39 / 39 |
| R09 | 25 / 25 | 25 / 25 |
| R10 | 29 / 29 | 29 / 29 |
| **Total** | **379 / 379, 0 fail** | **379 / 379, 0 fail** |
| V1 | PASS … `releaseCustody`; external authenticity NOT DEMONSTRATED | Same |
| V2 | PASS (4 groups); external authenticity NOT DEMONSTRATED | not run |
| V3 | `FAIL: artifactIntegrity`, exit 1 | not run |
| `check-release-docs` | pass (24) | pass (24; Linux Node on the Windows checkout) |
| `check-api-freeze` | pass (45 routes, 77 endpoints) | pass |
| `verify-release-manifest` | **pass** (9 artifacts, v1.6.0) | fail on `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` only: CRLF working copy hashes `sha256:34ab644f…`; committed blob hashes `sha256:bd160198…`, equal to the manifest. Environment artefact, not a regression |

The clean-clone run was in a session scratch directory and was deleted
afterwards. CI on the PR runs the full battery on `ubuntu-24.04`; its result is
recorded in the PR.

**Not run by Republika in this mission:** REL-01D concurrency
(`assure-rel-01d-concurrency.test.js`), the `assure01-*` trace suites, other
`assurance-*` engine suites, workspace packages, and the full `npm test`
battery locally (CI runs it). The reviewer may run any of them.

## 8. Recording template for the reviewer

Copy into [`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md) §3:

```text
Commit: ________  OS: ________  Node: ________  npm: ________  Clean clone: yes/no
R01 __/__  R02 __/__  R03 __/__  R04 __/__  R05 __/__  R06 __/__  R07 __/__
R08 __/__  R09 __/__  R10 __/__   V1 ____  V2 ____  V3 ____
Docs checks: ____  Deviations and explanation: ____________________
```

**FINAL COMMERCIAL DECISION: NO-GO.**
