# AOC Enterprise v1 — Clean-Room Portability Drill (`validate:portability:v1`)

> **PROD-02.** The drill now runs, inside the clean-room checkout, the three
> PROD-02 Host drills (step `prod02-host-drills`): a production-shaped secure
> Host composing every store, cold-backed-up, its data directory destroyed,
> restored from the backup alone and booted against the surviving
> separate-process freshness witness (software and external custody); the
> stale-backup drill; and the tamper/rollback matrix. Those are the official
> PROD-02 exit proof (`docs/security/PROD-02-COMPLETE-BACKUP-RESTORE-COVERAGE.md`).
> The synthetic four-store fixture cycle below remains the logical-equivalence
> check for Governance, Evidence, Passport, Assurance and Kernel Authority.

The full disaster-recovery/portability proof: an isolated checkout of the
exact tracked source, built and tested from nothing, seeded with a
synthetic fixture, backed up, had its source stores destroyed, restored
from the backup alone, and proven logically equivalent — then still
passing the full v1 release gate. This is the evidence behind
`docs/release/AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md`'s recommendation.

## Command

```bash
npm run validate:portability:v1 [-- --keep] [-- --skip-release-gate]
```

- `--keep` — do not delete the clean-room working directory on success
  (useful for inspecting `clean-room-drill-report.json` and the
  intermediate `pre`/`backup`/`post` directories afterward). On
  **failure**, the working directory is always kept regardless of this
  flag, so the failing state can be inspected.
- `--skip-release-gate` — skip the final `npm run validate:v1-release`
  step (only for iterating on the drill script itself; never use this
  when the drill's result is going to inform a tagging decision).

Takes several minutes: it runs a fresh `npm ci`, a full build, lint, and
the complete test suite (3300+ tests) inside the clean-room checkout,
**in addition to** the fixture/backup/restore/compare cycle.

## Why two commands (`validate:portability:v1` vs. the routine release gate)

`npm run validate:v1-release` already includes `check:portability-smoke`
— a bounded, in-process backup/restore/compare check that runs in
seconds against the already-built `dist/`. That check is what runs on
every routine validation; it's what would catch a broken backup or
restore *contract* immediately.

`validate:portability:v1` is deliberately **not** part of
`validate:v1-release` — embedding it there would have this drill's own
final step (`npm run validate:v1-release`, run inside the clean-room
checkout) recurse into itself. It is also simply too expensive to run on
every commit: a fresh `npm ci` plus a full build and test suite, on top
of the backup/restore cycle. It is a deliberate, pre-tag step, documented
in `docs/release/AOC_ENTERPRISE_V1_TAGGING_RUNBOOK.md` as
"run both, in this order, before tagging":

```bash
npm run validate:portability:v1   # the full clean-room drill (this document)
npm run validate:v1-release       # the routine release gate (includes the bounded smoke check)
```

## What the drill actually proves, step by step

1. **`clean-source-extraction`** — records whether the source worktree is
   clean (`git status --porcelain`; a dirty worktree is *recorded*, not
   blocking, since the drill validates the last commit, not uncommitted
   work), then runs a local `git clone` of this repository into a fresh
   directory **outside this repository** (`mkdtemp` under the OS temp
   directory), followed by an explicit `git checkout <commit>` to pin it
   to the exact validated commit. A clone only ever materializes tracked
   files — no `node_modules`, no `dist`, no untracked files, no `.env`,
   nothing from this Codespace's ambient state — while (unlike
   `git archive`, which was tried first and rejected) still producing a
   real `.git` directory. That matters: the existing release-manifest
   tooling (`scripts/lib-release-manifest.mjs`) shells out to
   `git rev-parse HEAD`, so the "run the full release gate inside the
   clean room" step (below) requires the checkout to actually be a git
   repository. `git clone` is one of the mission's explicitly acceptable
   clean-source mechanisms. The drill asserts `node_modules`/`dist`/
   `.data` are all absent from the fresh checkout before proceeding —
   checked, not assumed. A plain recursive copy of the working directory
   would **not** prove any of this — it would carry over untracked files,
   `.env`, and any local build cruft silently (see
   `AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md`, "Clean-Room Method").
2. **`npm-ci`** — installs dependencies from `package-lock.json` alone,
   inside the clean-room checkout.
3. **`build`** / **`typecheck`** / **`lint`** — `tsc -b`, then the lint
   suite, from the clean-room checkout's own `node_modules`.
4. **`compiled-tests`** — `npm run test:root` (the full compiled + `.mjs`
   test suite) from the clean-room checkout.
5. **`synthetic-fixture-generation`** — seeds a fresh four-store SQLite
   set with the deterministic, non-sensitive fixture described in
   `AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` §"Portability Evidence,"
   using the clean-room checkout's own build.
6. **`full-backup`** — runs `backup:v1` against those fixture stores.
7. **`pre-reference-capture`** — copies the fixture's store directory
   aside as a read-only reference *purely for the comparison step*. This
   is not a second backup and is never restored from; it exists because a
   drill needs something to compare the restore against, captured before
   the simulated disaster (see "Why a reference copy" below).
8. **`source-store-destruction`** — deletes every registry store file from the fixture
   files outright, simulating total loss of the original stores.
9. **`full-restore`** — runs `restore:v1` against the backup from step 6,
   into a fresh target directory. At this point the *only* copy of the
   data that still exists anywhere is the backup and the (untouched, only
   ever read) reference copy from step 7.
10. **`logical-comparison`** — runs
    `compare-portability-state.mjs` against the reference copy and the
    restored copy, and asserts full logical equivalence across
    Governance, Evidence, Passport, and Assurance (see
    `AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` for exactly what "logical
    equivalence" checks). Any mismatch fails the drill.
11. **`prod02-host-drills`** — `node --test` over
    `prod02-disaster-recovery-host`, `prod02-stale-restore-host` and
    `prod02-backup-integrity-host` from the clean-room build; any failure
    fails the drill.
12. **`clean-room-release-gate`** — runs `npm run validate:v1-release`
    (skippable via `--skip-release-gate`) inside the clean-room checkout,
    proving the exact commit still passes the full v1 release gate from a
    from-scratch build.

A `clean-room-drill-report.json` is written with every step's name,
status, and duration, plus the full `portability-comparison.json`.

### Why a reference copy, not "just trust the backup"

A drill that only checks "restore succeeded, no errors" would not catch a
backup that silently omitted data it should have captured. Capturing a
reference *before* destroying the source, and comparing the restore
against that reference (not against the backup's own manifest, which
could share the same blind spot), is what actually tests recoverability
rather than merely tests-that-the-restore-command-ran.

## Interpreting a failure

The clean-room working directory (path printed on failure, and always
retained on failure regardless of `--keep`) contains:

- `checkout/` — the clean-room source tree, with its own `dist/` and
  `node_modules/`.
- `drill-data/pre/`, `drill-data/pre-reference/`, `drill-data/backup/`,
  `drill-data/post/` — every intermediate store set.
- `drill-data/portability-comparison.json` — the detailed pre/post
  comparison (present even on a comparison failure).
- `clean-room-drill-report.json` — which step failed, and the captured
  error message.

## Limitations

- Runs on this machine's OS/architecture only — it proves portability
  *away from this Codespace's ambient state*, not cross-platform
  portability (see "Dependency and Platform Portability" in the
  portability report for what is and isn't verified there).
- `npm ci` requires network access to the configured npm registry; a
  fully air-gapped clean-room run would need a local registry mirror or a
  vendored `node_modules` — not implemented or tested here.
- The synthetic fixture is small (a handful of records per store); this
  drill proves correctness of the mechanism, not performance at
  production scale — see "Known Limitations" in the portability report
  for the explicit distinction between demonstrated-synthetic and
  recommended-operational RPO/RTO.
