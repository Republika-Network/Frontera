# AOC Enterprise v1 — Portability Current-State Discovery (Phase 0)

> **Historical (v1.0.0, superseded for store coverage by PROD-02, 2026-10-02).**
> This document records the v1.0.0 portability validation, when the Host had
> three (later four) durable stores. The current store set — thirteen stores,
> one registry (`scripts/portability/store-registry.mjs`) — and its
> qualification are in `docs/security/PROD-02-COMPLETE-BACKUP-RESTORE-COVERAGE.md`.

Independent discovery pass performed before any portability/backup/restore
tooling was written, at commit `a9ded65ad086f88d3596d2f58a376e7c4f676f5e`
on branch `claude/aoc-v1-release-validation-5jl2ld`. This document records
what already exists; it is descriptive, not prescriptive — the design in
`AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` builds on these facts rather
than inventing new ones.

## Repository shape

- **Repository root:** `/home/user/AOC-Enterprise` (npm workspaces:
  `packages/*`, `apps/*`).
- **Package manager:** npm (`package-lock.json` present; `npm ci` used
  throughout CI/runbooks).
- **Node requirement:** `engines.node: ">=22"` (`package.json`). Verified
  installed: v22.22.2.
- **Build output:** `tsc -b` (project references) → `dist/`. `npm run
  build` == `npm run typecheck` (both run `tsc -b --pretty false`).
- **Test strategy:** `npm test` = build, then `node --test` over
  `dist/src/**/*.test.js` and `tests/**/*.test.mjs`, then
  `npm test --workspaces --if-present`. Baseline measured this session:
  **3302 tests / 516 suites, 0 failures** (`npm run test:root`).
- **Current release validation command:** `npm run validate:v1-release`
  (superset of the older `validate:release`) — typecheck, lint, full test
  suite, protocol/runtime/boundary checks, publishability, API freeze,
  release-manifest verification, release-doc checks, SDK surface check.
- **Current release manifest command:**
  `node scripts/generate-release-manifest.mjs` (writes
  `release/RELEASE_MANIFEST.json`; construction shared with
  `scripts/verify-release-manifest.mjs` via `scripts/lib-release-manifest.mjs`).
  Deterministic: sorted artifact list, SHA-256 checksums, no timestamps.

## Runtime being validated

The `@aoc-enterprise/runtime` package (`src/`) hosts:

- **AOC Kernel** (`src/kernel`) — stateless per the mission; not itself a
  store.
- **Enterprise Host** (`src/enterprise`) — composition root
  (`composition/composition-root.ts`), HTTP adapter, configuration,
  lifecycle, four independent domain runtimes below.
- **Governance Store** (`src/enterprise/governance-store`).
- **Evidence Bundle Runtime** (`src/enterprise/evidence`).
- **Agent Passport Runtime** (`src/enterprise/passport`).
- **Assurance Runtime** (`src/enterprise/assurance`).
- **Module Lifecycle/Registry** (`src/enterprise/registry`,
  `src/enterprise/lifecycle`, `src/enterprise/modules`).
- **Minimal SDK**: `packages/enterprise-host-sdk`.
- **Release hardening / manifest / threat model**: `docs/release/*`,
  `docs/security/*`, `release/RELEASE_MANIFEST.json`.
- **Runbooks**: `docs/operations/{DEPLOYMENT_GUIDE_V1,RUNBOOKS_V1,BACKUP_RECOVERY_V1}.md`.

## Database / store configuration

Configuration is centralized in
`src/enterprise/configuration/enterprise-configuration.ts`
(`loadEnterpriseConfiguration`). Persistence provider is `memory` (default)
or `sqlite` (`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`). The `memory`
provider has nothing to back up and loses all state on process exit — out
of scope for this drill.

| Store | Config variable | Default path | Independent file? |
|---|---|---|---|
| Governance Store | `AOC_ENTERPRISE_SQLITE_PATH` | `.data/enterprise-host.sqlite` | yes |
| Agent Passport Store | `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | `.data/agent-passport.sqlite` | yes |
| Assurance Store | `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `.data/assurance.sqlite` | yes |

**Evidence Bundle Store has no SQLite implementation in v1.**
`composition-root.ts` always constructs it via
`createInMemoryEvidenceStore(...)` regardless of
`persistence.provider` — there is no `createSqliteEvidenceStore`
anywhere in `src/enterprise/evidence/`. This is consistent with, not a
gap introduced by, the existing `docs/operations/BACKUP_RECOVERY_V1.md`,
which documents backup for exactly three database files and never
mentions a fourth for Evidence. By design (`evidence-service.ts`), a
Bundle is a deterministic, disclosure-scoped projection *of* a Governance
Record — it can always be rebuilt on demand from the (durable) Governance
Store and re-verified; only the already-issued `bundleId` and its
lifecycle bookkeeping (`GENERATED`/`VERIFIED`/`EXPORTED`) are lost on
restart. This is documented as a known v1 limitation in
`AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` rather than silently worked
around.

Other relevant environment variables (all parsed with safe fallbacks in
`enterprise-configuration.ts`): `AOC_ENTERPRISE_ENV`,
`AOC_ENTERPRISE_VERSION`, `AOC_ENTERPRISE_LOG_LEVEL`,
`AOC_ENTERPRISE_STORE_BUSY_TIMEOUT_MS`,
`AOC_ENTERPRISE_STORE_MAX_{REQUEST,RESULT,EVENT}_PAYLOAD_BYTES`,
`AOC_ENTERPRISE_STORE_MAX_TRACE_STEPS`, `AOC_ENTERPRISE_EVENTS_ENABLED`,
`AOC_ENTERPRISE_TELEMETRY_ENABLED`, `AOC_ENTERPRISE_API_KEYS` (secret),
`AOC_ENTERPRISE_TRACE_LEVEL`, `AOC_ENTERPRISE_REQUIRE_AUTH`,
`AOC_ENTERPRISE_HTTP_PORT`/`_HOST`,
`AOC_ENTERPRISE_{STARTUP,SHUTDOWN,HEALTH_CHECK}_TIMEOUT_MS`,
`AOC_ENTERPRISE_PASSPORT_REQUIRED`, `AOC_ENTERPRISE_ASSURANCE_REQUIRED`.

### Schema versions and version tables (read directly from source)

| Store | Version table | Constant | Guard behavior |
|---|---|---|---|
| Governance | `governance_store_versions` (`schema_version`, `migration_state`, `recorded_at`) | `GOVERNANCE_STORE_SCHEMA_VERSION` | `sqlite-governance-store.ts` throws `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` on mismatch, without creating its own tables in a foreign store. |
| Agent Passport | `agent_passport_store_versions` | `AGENT_PASSPORT_SCHEMA_VERSION` | `sqlite-passport-store.ts` throws `PASSPORT_STORE_UNAVAILABLE`, same no-mutation guarantee (asserted by `sqlite-store-version-guard.test.ts`). |
| Assurance | `assurance_store_versions` | `ASSURANCE_STORE_SCHEMA_VERSION` | throws `ASSURANCE_STORE_UNAVAILABLE`, same guarantee. |

All three constants, plus `AOC_CANONICALIZATION_VERSION` and
`canonicalSerialize` (the Governance Store's deterministic JSON
canonicalization, `src/enterprise/governance-store/canonical-json.ts`),
are re-exported from the package's public `./enterprise` subpath
(`src/enterprise/index.ts`) and are already consumed this way by
`scripts/lib-release-manifest.mjs`. The new portability tooling reuses
this exact surface — no new canonicalization implementation was created.

## Migrations

There is no separate migration-runner directory; each SQLite store
self-initializes its schema on open (`CREATE TABLE IF NOT EXISTS ...`)
and stamps/verifies its own version table before doing anything else. A
store recorded under an unsupported schema version is refused, not
migrated — see `docs/enterprise/MIGRATION_REVIEW_V1.md` for the full
policy.

## Generated / ignored / runtime-state paths (`.gitignore`)

Already ignored: `node_modules`, `.next`, `dist`, `dist-test`, `build`,
`coverage`, `.env`, `.env.local`, `.env.*`, `.vercel`, `turbo`,
`.DS_Store`, `*.log`, `*.tsbuildinfo`, `.claude/worktrees/`,
`apps/agent-passport-web/.data/`, `.data/`, `*.tgz`.

`apps/agent-passport-web` has its own SQLite data directory
(`AGENT_PASSPORT_DB_PATH`, default `.data/agent-passport.sqlite`) and its
own `.env.example`. It is a separate Next.js product with its own
database and is explicitly **out of scope** per
`docs/security/THREAT_MODEL_V1.md` §9 ("The `apps/agent-passport-web`
SaaS app ... separate surfaces"). This drill covers the
`@aoc-enterprise/runtime` package's three Enterprise Host stores only.

## Backup/restore documentation and tooling already present

- `docs/operations/BACKUP_RECOVERY_V1.md` — **already documents** a
  manual cold-backup (stop host, copy 3 files) and online-backup
  (`sqlite3 <db> ".backup ..."`) procedure, verification steps
  (`PRAGMA integrity_check` + throwaway-host + record-sample verify
  endpoints), RPO/RTO ("RPO = backup interval", "RTO = minutes"), and
  limitations (no PITR, no cross-store transactional snapshot while
  running, schema-version coupling). No automated backup/restore
  **command** existed before this work — the procedure was operator-run
  shell commands.
- `docs/operations/RUNBOOKS_V1.md` §4/§5 — short-form
  backup/restore runbooks pointing at the above.
- `docs/security/THREAT_MODEL_V1.md` §7.16 — "Store corruption, backup
  corruption & recovery risks" already covers corrupted-row handling,
  schema-version refusal, and the missing-store-file-is-recreated-empty
  behavior.
- No `backup:*`/`restore:*` npm scripts, no backup manifest format, no
  synthetic portability fixture, and no clean-room validation script
  existed prior to this work — these are what Phases 2–15 of this drill
  add.

## Current release/deployment assumptions

- Single-writer SQLite, single host per tenant, no replication/HA
  (documented and accepted, `THREAT_MODEL_V1.md` §9).
- `better-sqlite3@^12.11.1` ships prebuilt binaries for common platforms;
  falls back to source compilation (`python3`, `make`, a C/C++ toolchain)
  otherwise (`DEPLOYMENT_GUIDE_V1.md`).
- Local disk or block volume required for the data directory; NFS/SMB
  explicitly called out as unreliable for SQLite locking.
- `npm ci && npm run build` is the documented install/build path; `npm
  run validate:v1-release` is the documented pre-tag gate.
