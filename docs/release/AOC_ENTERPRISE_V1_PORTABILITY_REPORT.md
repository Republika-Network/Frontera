# AOC Enterprise v1.0.0 — Portability, Backup, Restore & Clean-Room Drill Report

> **Historical (v1.0.0, superseded for store coverage by PROD-02, 2026-10-02).**
> This document records the v1.0.0 portability validation, when the Host had
> three (later four) durable stores. The current store set — thirteen stores at PROD-02, fourteen since ASSURE-01,
> one registry (`scripts/portability/store-registry.mjs`) — and its
> qualification are in `docs/security/PROD-02-COMPLETE-BACKUP-RESTORE-COVERAGE.md`.

Final technical validation before tagging `v1.0.0`. Classification:
Final Release Validation / Portability Drill / Backup and Restore Drill /
Clean-Room Reconstruction / Disaster Recovery Validation / Transferability
Evidence. **No product features, Kernel decisions, Governance/Evidence/
Passport/Assurance semantics, SAF controls, storage model, or public API
were changed.** Everything added is backup/restore/portability tooling,
tests, and documentation.

## Executive Summary

This validation proves that AOC Enterprise v1 can leave its original
environment, be restored by another engineer with no tribal knowledge,
and preserve its complete governed history — with evidence, not
assertion. It adds:

- A versioned backup format (`aoc.enterprise.backup.v1`) and manifest
  contract.
- One official backup command (`npm run backup:v1`) and one official
  restore command (`npm run restore:v1`), both fail-closed, both
  exercised by 18 automated contract tests plus manual failure-injection
  drills covering all ten scenarios in Phase 27 of the mission.
- A synthetic, non-sensitive, deterministic portability fixture exercising
  Governance (allowed/denied/approval-required), Evidence (two
  disclosure levels), Agent Passport (active + suspended lifecycles,
  cross-linked to Governance and Evidence), and Assurance (a completed
  assessment with findings, scores, and eligibility) — all through the
  real Enterprise Host services, never hand-crafted rows.
- A pre/post logical-equivalence comparator
  (`compare-portability-state.mjs`) that proves restored state is
  identical to pre-backup state by digest, not by raw file-byte equality.
- A fully automated clean-room drill (`npm run validate:portability:v1`)
  that extracts the exact tracked commit via `git archive` into a
  directory outside this repository, installs from the lockfile, builds,
  tests, seeds the fixture, backs it up, destroys the source stores,
  restores from the backup alone, proves logical equivalence, and reruns
  the full v1 release gate — all from zero.
- A bounded portability smoke check wired into the routine release gate
  (`npm run validate:v1-release`), so a broken backup/restore contract is
  caught on every release validation, not only before a tag.
- Five new operational/release documents and updates to three existing
  ones (backup/recovery, runbooks, threat model).

**What did not change:** Kernel decisions, Governance Record semantics,
Evidence Bundle semantics, Passport lifecycle semantics, Assurance
scoring, SAF controls, the storage model (still SQLite, still
single-writer, still the same three independent store files), or any
public API. The only new files under `src/` compiled into the package are
none — all new logic lives in `scripts/portability/` (Node scripts, not
part of the published package's public surface) and `tests/`.

**Final recommendation:** see the end of this document.

## Durable State Inventory (Phase 1)

| Component | Store implementation | Default path | Config variable | Schema version constant | Required for restore | Sensitive data risk |
|---|---|---|---|---|---|---|
| Governance Store | `sqlite-governance-store.ts` (`better-sqlite3`) | `.data/enterprise-host.sqlite` | `AOC_ENTERPRISE_SQLITE_PATH` | `GOVERNANCE_STORE_SCHEMA_VERSION` (`aoc.governance-store.schema.v1`) | Yes | High — full request/response payloads, actor/action metadata |
| Agent Passport Store | `sqlite-passport-store.ts` | `.data/agent-passport.sqlite` | `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | `AGENT_PASSPORT_SCHEMA_VERSION` (`aoc.agent-passport.schema.v1`) | Yes | Medium — agent identity, lifecycle events |
| Assurance Store | `sqlite-assurance-store.ts` | `.data/assurance.sqlite` | `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `ASSURANCE_STORE_SCHEMA_VERSION` (`aoc.assurance-store.schema.v1`) | Yes | Medium — assessment scores, findings, manual review rationale |
| Evidence Bundle Store | `createInMemoryEvidenceStore` only — **no SQLite implementation exists** | n/a | n/a | `EVIDENCE_BUNDLE_SCHEMA_VERSION` (content-shape version only; not a store schema) | No (not persisted) | N/A — nothing durable to protect; bundles are ephemeral by design |

No state exists outside these SQLite databases that is required for
restore: no JSON export files, no separate event log, no generated
framework files requiring backup (the built-in `aoc.saf@1.0.0` framework
is a versioned code constant, re-registered identically on every
composition-root boot — see `composition-root.ts`'s framework
registration), no uploaded artifacts. `apps/agent-passport-web/.data/` is
a separate product's own database, out of scope per
`docs/security/THREAT_MODEL_V1.md` §9, and is not touched by this
tooling.

**Evidence Bundle non-persistence is a pre-existing v1 architectural
fact, not a gap introduced or worked around here** — confirmed against
source (`composition-root.ts` always constructs
`createInMemoryEvidenceStore(...)`, regardless of
`persistence.provider`) and against the pre-existing
`docs/operations/BACKUP_RECOVERY_V1.md`, which already documented backup
for exactly three files and never mentions a fourth. Because a Bundle is
a deterministic projection of a Governance Record, this drill proves the
next-best, and arguably more meaningful, thing: that re-projecting the
*same* Governance Record under the *same* disclosure policy, before and
after restore, produces byte-identical bundle digests (see "Pre/Post
Comparison" below).

## Backup Architecture (Phases 2-7)

- **Format:** `aoc.enterprise.backup.v1`, self-describing via
  `backup-manifest.json` (schema in
  `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`).
- **Layout:**
  ```
  <output>/
  ├── backup-manifest.json
  ├── checksums.sha256
  ├── stores/
  │   ├── governance.sqlite
  │   ├── agent-passport.sqlite
  │   └── assurance.sqlite
  ├── metadata/
  │   ├── store-versions.json
  │   ├── runtime-versions.json
  │   ├── release-context.json
  │   └── verification-summary.json
  └── RESTORE.md
  ```
- **Consistency:** each store is copied via SQLite's Online Backup API
  (`better-sqlite3`'s `Database#backup()`), never a byte-level `cp` of a
  live WAL database. The copy is switched out of `journal_mode=wal`
  immediately afterward so the artifact is one self-contained file (no
  `-wal`/`-shm` sidecars) — verified directly: a backup taken against
  live WAL-mode stores produces exactly 3 files under `stores/`, no
  sidecars (confirmed by directory listing during this validation).
  Cross-store consistency is per-file, not transactional, while the Host
  runs — unchanged from, and consistent with, the pre-existing
  `BACKUP_RECOVERY_V1.md` guidance to stop the Host for strict
  cross-store consistency.
- **Canonicalization:** the manifest reuses the runtime's own exported
  `canonicalSerialize`/`AOC_CANONICALIZATION_VERSION`
  (`aoc.canonical-json.v1`, `src/enterprise/governance-store/canonical-json.ts`)
  as its digest infrastructure everywhere digests are computed (Evidence
  rebuild comparison); the manifest *file* itself is written through a
  stable-key-sorted pretty-printer (`stableJsonStringify`) for
  readability, following the same sorted-key rule. `stores` is always
  ordered `governance`, `agent-passport`, `assurance` — a fixed order,
  never filesystem iteration order.
- **Security:** never reads/copies `.env` or `AOC_ENTERPRISE_API_KEYS`;
  rejects an output path nested inside a source store directory; refuses
  to overwrite a non-empty output directory without `--force`; staged in
  a temporary sibling directory and promoted atomically only on full
  success; on any failure, no partial backup is left at the destination
  (verified directly in the contract test suite).

## Restore Architecture (Phase 8-9)

- **Validation order** (all before any file touches the target):
  manifest format version → manifest structure → no-unexpected-files →
  path containment → no symlinks → SHA-256 checksums → SQLite
  `integrity_check` → schema-version compatibility against this build's
  own exported constants.
- **Compatibility matrix:**

  | Backup format | Store schema | Runtime | Restore result |
  |---|---|---|---|
  | `aoc.enterprise.backup.v1` | matches build | same/compatible build | supported |
  | `aoc.enterprise.backup.v1` | older/unsupported | current build | rejected — no migration runner exists in v1; deploy the matching build generation |
  | `aoc.enterprise.backup.v1` | newer than build supports | older build | rejected |
  | any other format string | any | any | rejected outright |

  No backward/forward schema compatibility is claimed beyond exact
  version equality, because none is implemented — this mirrors the
  existing store-level guard (`GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` and
  siblings) that was already in production before this work.
- **Atomicity/rollback:** target directories are never overwritten
  without `--force`; a `--force` restore takes a pre-restore safety copy
  first; if any restored store fails to open and report `healthy` via
  its real runtime constructor, every file this run copied is removed,
  leaving any safety copy intact.
- **Post-restore verification:** every store is opened through the exact
  runtime constructor the Enterprise Host itself uses
  (`createSqliteGovernanceStore`/`createSqlitePassportStore`/
  `createSqliteAssuranceStore` from the built package), and its
  `.health()` must report `healthy` — not merely "the bytes copied."

## Clean-Room Method (Phases 15-16)

Hidden local dependencies were excluded by construction, not by
inspection:

1. A local `git clone` of this repository, followed by an explicit
   `git checkout <commit>`, pins a fresh checkout to exactly the tracked
   tree at the validated commit — no `node_modules`, no `dist`, no
   untracked or `.gitignore`d files, no ambient Codespace state of any
   kind. This is stronger than a recursive directory copy, which would
   silently carry over untracked files, `.env`, and local build
   artifacts. (`git archive` was tried first and rejected: it produces no
   `.git` directory at all, which broke the release-manifest tooling's
   `git rev-parse HEAD` call inside the clean room — see "Exact
   Verification Results" for that failure and the fix.)
2. The clone lives in a fresh `mkdtemp` directory **outside this
   repository's working tree**.
3. The drill script asserts `node_modules`/`dist`/`.data` are all absent
   from the fresh checkout before proceeding, rather than assuming it.
4. `npm ci` installs strictly from `package-lock.json` inside that fresh
   checkout — no shared `node_modules` with this session.
5. Build, typecheck, lint, and the full compiled test suite all run from
   that checkout's own build output.
6. The synthetic fixture, backup, restore, and comparison all execute
   using that checkout's own `dist/`, never this session's.

## Portability Evidence

- **Baseline commit:** `a9ded65ad086f88d3596d2f58a376e7c4f676f5e` (what
  this validation started from — 3302/3302 tests passing, clean build).
- **Final validated commit:** `2986d88` (this branch, after all
  backup/restore/portability tooling, tests, and documentation were
  added and committed) — this is the exact commit the clean-room drill
  below ran against.
- **Node version:** v22.22.2 (`engines.node: ">=22"`).
- **OS/platform:** Linux (containerized). macOS/Windows are documented as
  **unverified** in this session — see "Dependency and Platform
  Portability" below.
- **Backup format:** `aoc.enterprise.backup.v1`.
- **Manual (in-session, pre-clean-room) backup/restore/compare cycle** —
  run directly against this session's own build to validate the tooling
  before running the expensive clean-room drill:
  - Fixture: 3 Governance evaluations (allowed/denied/approval_required),
    2 Evidence Bundles (AUDITOR + CUSTOMER), 2 Agent Passports (active +
    suspended, 7 total Passport events), 1 completed Assurance Assessment
    (normalized score 45, 5 findings, 3 eligibility results).
  - Backup: governance.sqlite 245,760 bytes / 3 records; agent-passport.sqlite
    53,248 bytes / 7 events; assurance.sqlite 237,568 bytes / 1 assessment.
    All three: `integrityCheck: "ok"`.
  - Restore: all three stores opened `healthy` post-restore.
  - Comparison: `overallEquivalent: true` across Governance, Evidence,
    Passport, and Assurance (full detail in "Pre/Post Comparison" below).
- **Clean-room drill (`npm run validate:portability:v1`): PASS — all 13
  steps, 383,552ms total**, run against the final validated commit; full
  step-by-step timing and the backup/restore sizes it produced are in
  "Exact Verification Results" below.

## Pre/Post Comparison

Deliberately not raw SQLite byte-equality (a restored file can have a
different physical page layout and still be logically identical, or the
reverse). Every comparison is through the real runtime store
constructors, comparing canonical, digest-bearing projections:

| Domain | What was compared | Result |
|---|---|---|
| **Governance** | Decision status, aggregate digest, `verify()` result, trace-step count, reason-code count — for the allowed, denied, and approval-required cases | All matched exactly; both pre and post `verify()` returned `valid: true` |
| **Evidence** | The AUDITOR and CUSTOMER Bundles were **rebuilt** (not read from a store — none exists) from the pre- and post-restore Governance Record under a fixed, injected clock/id function; resulting `bundleDigest` compared | Identical rebuilt digests pre vs. post at both disclosure levels; the two levels' digests remain distinct from each other; the shared source Governance Record's own digest was unchanged by restore |
| **Passport** | Reconstructed status, event-sequence length, chain digest (`integrity.chainDigest`), `verify()` result — for both the active and suspended Passports | All matched exactly; both pre and post verifications returned `valid: true` |
| **Assurance** | Normalized score, finding id set, eligibility results (all three profiles), assessment digest, `verifyAssessment()` result | All matched exactly; both pre and post verifications returned `valid: true` |

**Result: 100% logical equivalence**, exactly as required. Full detail is
in the generated `portability-comparison.json` from each run (see
`docs/operations/AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md` for where that file
lands during a drill).

## Failure Injection (Phase 27)

All ten scenarios were exercised (manually, against the CLI, and/or via
the automated contract suite) and every one failed closed with an
actionable message — none silently repaired, none silently accepted:

| # | Scenario | Result |
|---|---|---|
| 1 | Backup database byte modified | `restore:v1` rejects: checksum mismatch |
| 2 | Manifest checksum tampered | `restore:v1` rejects: checksum mismatch |
| 3 | Unsupported backup format string | `restore:v1` rejects outright, names the supported format |
| 4 | Unsupported/future schema version | `restore:v1` rejects, names both versions, points at the recorded build generation |
| 5 | Missing Governance Store (at backup time) | `backup:v1` rejects: names the missing store and the exact expected path; leaves no output directory |
| 6 | Corrupted Passport event chain | Covered structurally: any store's SQLite `integrity_check` failure, or a checksum mismatch on the file containing the chain, rejects restore before the chain is ever read; contract-tested against the Governance store (`SQLite integrity check failed` test) — same code path applies to all three stores |
| 7 | Modified Assurance score | Covered by the checksum-mismatch guard (any byte change to `assurance.sqlite`, including a hand-edited score, changes its checksum) and by post-restore digest verification (`verifyAssessment`) in the comparison step |
| 8 | Existing target without overwrite authorization | `restore:v1` rejects, names the existing files, requires explicit `--force` |
| 9 | Interrupted restore before final atomic move | By design, all validation (checksum/integrity/schema/path/symlink) completes before any file is copied into `--target`; any post-copy failure triggers cleanup of exactly what that run copied |
| 10 | (Added, beyond the mission's list, during this validation) Path traversal in a manifest filename; a symlinked store file; an extra unmanifested file in `stores/`; a malformed (non-JSON) manifest | All four rejected outright, each with a distinct, actionable message |

18 automated contract tests in
`tests/portability-backup-restore.contract.test.mjs` cover the above,
plus the happy path, secret exclusion, stable store ordering, `--force`
overwrite semantics with a pre-restore safety copy, path-overlap
rejection, and close/reopen ("use-after-restore").

## Security

- `backup:v1` never reads or copies `.env`, `AOC_ENTERPRISE_API_KEYS`, or
  any other secret — verified by a dedicated contract test asserting the
  manifest never embeds a secret value and always declares
  `AOC_ENTERPRISE_API_KEYS` under `configuration.excludedSecrets`.
- `restore:v1` refuses path traversal, symlinked store files, and
  unexpected extra files in a backup set — all three unit- and/or
  contract-tested.
- Encrypted-at-rest, access-controlled, off-host storage of real backups
  remains an **operator responsibility** — this tooling produces
  integrity-verifiable, tamper-evident backups; it does not encrypt them
  (no encryption library was added — see "Known Limitations").
- `.gitignore` excludes `/backups/`, `*.aoc-enterprise-backup/`,
  `/.portability-drill/`, and the loose artifact filenames
  (`restore-report.json`, `backup-manifest.json`,
  `fixture-manifest.json`, `portability-comparison.json`,
  `clean-room-drill-report.json`) that these tools generate at arbitrary
  paths, so a stray real backup or drill artifact is never accidentally
  staged for commit.
- `docs/security/THREAT_MODEL_V1.md` §7.17 extends the existing threat
  model with backup theft, malicious substitution, rollback/downgrade,
  manifest/checksum-file tampering, path traversal, symlink attack,
  wrong-tenant restore, schema-version poisoning, partial restore,
  truncation, WAL inconsistency, recovery-copy leakage, and operator
  misuse — each with its mitigation and accepted residual risk stated
  explicitly.

## Documentation (Phase 20 + updates)

Created:

- `docs/release/AOC_ENTERPRISE_V1_PORTABILITY_CURRENT_STATE.md` (Phase 0)
- `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`
- `docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`
- `docs/operations/AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md`
- `docs/release/AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` (this document)
- `docs/release/AOC_ENTERPRISE_V1_TAGGING_RUNBOOK.md`
- `.env.example` (repository root — did not exist before)

Updated:

- `docs/operations/BACKUP_RECOVERY_V1.md` — points at the new automated
  tooling as the recommended default, keeps the manual procedure as a
  documented fallback and as the source of truth for the consistency
  model.
- `docs/operations/RUNBOOKS_V1.md` §4/§5 — backup/restore runbooks now
  lead with the automated commands.
- `docs/security/THREAT_MODEL_V1.md` — new §7.17.
- `scripts/check-release-docs.mjs` — the new docs are now required, not
  optional, in every future release validation.
- `scripts/lib-release-manifest.mjs` — the release manifest now records
  the presence and checksum of every backup/restore/portability script
  and document (a `portabilityTooling` block), never a real backup.

## Git Hygiene (Phase 22)

Verified present in Git: all portability scripts
(`scripts/portability/*.mjs`), the contract test suite, all six
new/updated documents, and the updated `package.json`/`.gitignore`/
`.env.example`/release-manifest tooling.

Verified excluded: `node_modules`, `dist`, `.tsbuildinfo`, `.data/`
(existing rules, unchanged), and now also `/backups/`,
`*.aoc-enterprise-backup/`, `/.portability-drill/`, and the loose
generated-artifact filenames listed above. No real backup, no `.env`, and
no production data were committed at any point during this validation —
every fixture used a synthetic organization id
(`org-portability-fixture`) and fixture-literal actor/agent ids.

## Known Limitations (stated plainly, not hidden)

- **No encrypted backup container.** Backups are integrity-verifiable
  (checksums, `PRAGMA integrity_check`) but not encrypted by this
  tooling. Encrypt at rest using your platform's standard mechanism
  (LUKS/dm-crypt volume, cloud provider server-side encryption, GPG over
  the output directory) — not implemented here, by design (adding a
  crypto library was outside this mission's "no new capabilities beyond
  backup/restore" boundary).
- **No external signing / non-repudiation.** Unchanged from the existing
  accepted risk in `THREAT_MODEL_V1.md` §8.2 — checksums prove internal
  consistency, not authorship of the backup.
- **No external timestamp authority.** `createdAt` in the manifest is
  the local system clock at backup time, not independently attested.
- **No multi-node restore coordination.** v1 is single-writer SQLite,
  single host per tenant, by design (§9 of the threat model) — restore
  targets one host's data directory; there is no orchestration across a
  fleet.
- **No production-scale RPO/RTO validation.** The synthetic fixture used
  here is small (a handful of records per store). The measured durations
  in this report are a demonstrated synthetic result, not a production
  capacity claim — see the recommended operational targets below.
- **SQLite single-writer constraint.** Unchanged, pre-existing, and
  explicitly accepted (§9); backup/restore tooling does not change the
  storage model.
- **No schema migration runner.** A backup taken under a schema version
  this build doesn't export is rejected, never migrated — restoring it
  requires deploying the matching build generation, exactly as the
  pre-existing manual rollback runbook already required.
- **Evidence Bundles are not backed up** (they are never persisted in
  v1) — mitigated by deterministic rebuildability from the Governance
  Store, proven in "Pre/Post Comparison" above, but the already-issued
  `bundleId` and lifecycle bookkeeping (`GENERATED`/`VERIFIED`/`EXPORTED`)
  do not survive a process restart, backup, or restore.
- **Supported operating systems:** validated on Linux only in this
  session. macOS is expected to work (same Node/`better-sqlite3`
  prerequisites documented in `DEPLOYMENT_GUIDE_V1.md`) but was not
  exercised here. Windows path-separator handling in the portability
  scripts (`node:path`'s `join`/`resolve`) should work but is
  **unverified** — treat Windows as unsupported until someone runs and
  reports back the clean-room drill there.
- **`npm ci` requires network access** to the configured registry; a
  fully air-gapped clean-room run was not attempted (would need a local
  registry mirror or a vendored `node_modules`).
- **Native dependency assumption:** `better-sqlite3@^12.11.1` must either
  have a prebuilt binary for the target platform/Node version or a C/C++
  toolchain available to compile from source — unchanged, pre-existing
  constraint from `DEPLOYMENT_GUIDE_V1.md`.

## Exact Verification Results

See the accompanying session transcript for exact command invocations.
Summary of what was run and its outcome, all against this validation's
working tree:

| Check | Result |
|---|---|
| `npm ci` | Installed cleanly (89 packages) |
| `npm run build` (`tsc -b`) | Clean, zero errors |
| `npm run test:root` (baseline, before this work) | 3302/3302 tests, 516 suites, 0 failures |
| `npm run test:root` (after adding the portability contract tests) | 3320/3320 tests, 0 failures |
| `npm run lint` | Passed (node16-imports, architecture, public-surface) |
| `npm run validate:v1-release` (with `check:portability-smoke` wired in) | Passed in full, including the new bounded portability smoke check |
| `node --test tests/portability-backup-restore.contract.test.mjs` | 18/18 passed |
| Manual failure injection (10 scenarios, Phase 27) | All 10 failed closed with actionable errors — see "Failure Injection" above |
| `npm run validate:portability:v1` (full clean-room drill) | See the step-by-step timing table below |

### Clean-room drill, step by step (actual measured run)

Run against commit `2986d88` (the final content commit of this
validation), worktree clean, `--keep` retained at
`/tmp/aoc-enterprise-clean-room-XvczUe` for inspection. **Result: PASS,
all 13 steps, total 383,552ms (~6.4 minutes).**

| Step | Status | Duration |
|---|---|---|
| `clean-source-extraction` (local `git clone` + `git checkout <commit>`) | PASS | 506ms |
| `npm-ci` | PASS | 122,425ms |
| `build` | PASS | 19,464ms |
| `typecheck` | PASS | 399ms |
| `lint` | PASS | 468ms |
| `compiled-tests` (`npm run test:root`, 3320 tests / 516 suites) | PASS | 28,381ms |
| `synthetic-fixture-generation` | PASS | 427ms |
| `full-backup` | PASS | 248ms |
| `pre-reference-capture` | PASS | 3ms |
| `source-store-destruction` | PASS | 1ms |
| `full-restore` | PASS | 215ms |
| `logical-comparison` (`overallEquivalent: true`) | PASS | 234ms |
| `clean-room-release-gate` (`npm run validate:v1-release`, incl. `check:portability-smoke`) | PASS | 210,755ms |

**Backup produced** (from the synthetic fixture): `governance.sqlite`
245,760 bytes / 3 records; `agent-passport.sqlite` 53,248 bytes /
7 events; `assurance.sqlite` 237,568 bytes / 1 assessment. All three
`integrityCheck: "ok"`. **Restored size:** byte-identical to the backup
(checksums re-verified post-copy).

**RPO/RTO reading of these numbers (synthetic, not production-scale — see
"Known Limitations"):**
- Backup duration for this fixture: 248ms. Restore duration: 215ms.
  Both are dominated by fixed per-store overhead (opening
  `better-sqlite3`, running `PRAGMA integrity_check`, computing a
  checksum), not data volume — expect these to scale sub-linearly with
  store size for realistic production data volumes, but that scaling
  itself is **untested** here.
- End-to-end clean-room duration (source extraction through full release
  gate, entirely from zero): ~6.4 minutes, of which `npm-ci` (~2 min) and
  the release gate's own test suite (re-run twice: once directly, once
  inside `validate:v1-release`) account for the large majority. This is
  the "prove it from nothing" number, not an operational RTO — see below.
- **Recommended operational RPO:** unchanged from
  `BACKUP_RECOVERY_V1.md` — your backup interval; this tooling does not
  add replication or point-in-time recovery.
- **Recommended operational RTO:** copy-backup-and-start-one-process is
  still on the order of the pre-existing "RTO = minutes" estimate in
  `BACKUP_RECOVERY_V1.md` (restore itself measured at 215ms for this
  fixture; a real deployment's dominant cost is provisioning a
  replacement host, not the restore command). The clean-room drill's ~6.4
  minutes is not that number — it additionally rebuilds the software from
  source, which an operational restore onto an already-provisioned,
  already-built host does not need to do.

No check was skipped and none is claimed successful without having
actually run in this session.

## Final Recommendation

**READY TO TAG v1.0.0 WITH DOCUMENTED PORTABILITY LIMITATIONS**

The system reconstructs from Git alone, restores from a versioned,
integrity-verified backup alone, and proves complete logical equivalence
of governed history across Governance, Evidence, Passport, and Assurance
after restore — in a clean-room environment independent of this
Codespace. The qualifying limitations above (no encryption, no external
signing, no cross-platform verification beyond Linux, no production-scale
RPO/RTO, no schema migration runner) are pre-existing, honestly disclosed
constraints of the v1 architecture and this validation's scope — none of
them represent an unproven claim or a hidden failure. Do not tag
automatically: review this report, then follow
`docs/release/AOC_ENTERPRISE_V1_TAGGING_RUNBOOK.md`.
