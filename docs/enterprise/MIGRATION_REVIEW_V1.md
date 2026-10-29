# Migration & Schema Review — v1.0.0 (Consolidated)

Consolidated pre-release review of the three durable `better-sqlite3` stores:

| Store | Implementation | Per-store migration doc |
| --- | --- | --- |
| Governance Store | `src/enterprise/governance-store/sqlite-governance-store.ts` | `docs/enterprise/GOVERNANCE_STORE_MIGRATION_V1.md` |
| Agent Passport Store | `src/enterprise/passport/sqlite-passport-store.ts` | `docs/enterprise/AGENT_PASSPORT_MIGRATION_V1.md` |
| Assurance Store | `src/enterprise/assurance/sqlite-assurance-store.ts` | `docs/enterprise/ASSURANCE_STORE_MIGRATION_V1.md` |

This document is the cross-store summary. Per-store data-mapping details,
field-by-field migration analysis, and historical-honesty rules live in the
three per-store documents above and are not duplicated here.

## At a glance

| | Governance | Passport | Assurance |
| --- | --- | --- | --- |
| Schema version identifier | `aoc.governance-store.schema.v1` | `aoc.agent-passport.schema.v1` | `aoc.assurance-store.schema.v1` |
| Constant | `GOVERNANCE_STORE_SCHEMA_VERSION` | `AGENT_PASSPORT_SCHEMA_VERSION` | `ASSURANCE_STORE_SCHEMA_VERSION` |
| Version ledger table | `governance_store_versions` | `agent_passport_store_versions` | `assurance_store_versions` |
| Fresh-install ledger state | `fresh` (or `migrated-from-pr-002`) | `current` | `current` |
| Upgrade path into v1 | Automatic PR-002 legacy migration | None — v1 is the first schema | None — v1 is the first schema |
| Opening a DB recorded under another schema version | **Refuses to open**: throws `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` | **Refuses to open**: throws `PASSPORT_STORE_UNAVAILABLE` | **Refuses to open**: throws `ASSURANCE_STORE_UNAVAILABLE` |
| Corruption surfaced as | `GOVERNANCE_RECORD_CORRUPTED` on read | `reconstruct` returns `status: 'incomplete'` with `integrityFailures` | verification result failures |
| Auto-repair / wipe / recreate | Never | Never | Never |

All three stores share the same connection discipline (documented in the
factory of each implementation): `better-sqlite3` loaded lazily, hand-written
SQL (no ORM), and pragmas `foreign_keys = ON`, `journal_mode = WAL`,
`synchronous = FULL`, `busy_timeout` (default 5 000 ms, must be a positive
safe integer).

---

## Governance Store (`aoc.governance-store.schema.v1`)

### Schema summary

Defined in `SCHEMA_V1` of `sqlite-governance-store.ts`. The PR-002
CamelCase tables (`GovernanceRequests`, `GovernanceEvaluations`,
`GovernanceTraces`, `RuntimeEvents`) coexist untouched alongside the v1
snake_case tables; only `RuntimeVersions` (the boot-version ledger) is
carried forward as a live v1 table.

| Table | Primary key | Uniqueness | Foreign keys | Indexes |
| --- | --- | --- | --- | --- |
| `governance_store_versions` | `id` (autoincrement) | — | — | — |
| `governance_requests` | `record_id` | `request_id` UNIQUE | — | correlation; (org, requested_at); (actor, requested_at); (action, requested_at) |
| `governance_evaluations` | `record_id` | `evaluation_id` UNIQUE, `decision_id` UNIQUE | `request_id` → `governance_requests(request_id)` | request; correlation; (status, evaluated_at); kernel_version; enterprise_version |
| `governance_trace_steps` | `trace_record_id` | `UNIQUE(evaluation_id, sequence)` | `evaluation_id` → `governance_evaluations(evaluation_id)` | — |
| `governance_reason_codes` | `reason_record_id` | `UNIQUE(evaluation_id, sequence)` | `evaluation_id` → evaluations | reason_code; (evaluation_id, reason_code) |
| `governance_events` | `event_id` | `UNIQUE(aggregate_type, aggregate_id, sequence)` | — | aggregate; request; correlation; causation; (type, occurred_at) |
| `governance_record_metadata` | `metadata_id` | `evaluation_id` UNIQUE | `evaluation_id` → evaluations | — |
| `governance_integrity` | `integrity_id` | `evaluation_id` UNIQUE; **`chain_position` UNIQUE** | `evaluation_id` → evaluations | — |
| `governance_idempotency` | `(scope, idempotency_key)` composite | (primary key itself) | `evaluation_id` → evaluations | — |
| `governance_references` | `reference_id` | — | `evaluation_id` → evaluations | evaluation |
| `RuntimeVersions` (legacy name, live) | `boot_id` | — | — | — |

### Version ledger

`governance_store_versions` is append-only: `schema_version`,
`migration_state` (`fresh` \| `migrated-from-pr-002`), `details_json`
(e.g. `{"migratedEvaluations": N}`), `recorded_at`. `initSchemaAndMigrate`
reads the latest row and appends a new row on first open or when a legacy
migration ran.

### Fresh install

`initSchemaAndMigrate` runs inside **one transaction**: `db.exec(SCHEMA_V1)`
(every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS`, so re-running is a no-op), then, if no version row exists, inserts
one with `migration_state = 'fresh'`. The whole sequence is idempotent —
opening the same file repeatedly changes nothing after the first open.

### Upgrade path (PR-002 → v1)

`migrateFromPr002` runs inside the same construction transaction:

- **Trigger** — only if the legacy `GovernanceRequests` and
  `GovernanceEvaluations` tables exist and contain rows; otherwise it
  returns immediately with 0 migrated.
- **Copy, never mutate** — legacy tables are read-only inputs; they are
  never renamed, altered, or dropped.
- **Idempotent** — a legacy evaluation whose `request_id` already exists in
  `governance_requests` is skipped, and a legacy `RuntimeEvents` row whose
  `event_id` already exists in `governance_events` is skipped, so
  re-opening the same database migrates nothing twice.
- **Transactional** — schema creation, migration, and version-row insert
  commit or roll back together. On failure the store throws
  `GOVERNANCE_STORE_TRANSACTION_FAILED` and the file is left exactly as
  PR-002 wrote it.
- Migrated aggregates are rebuilt through the live projection pipeline
  (`buildGovernanceAggregate`), stamped
  `migrationSource: 'pr-002-governance-store'`, re-sealed with recomputed
  digests, and appended to the integrity chain at the next
  `chain_position`. Unavailable historical fields carry honest
  `'unrecorded'` defaults — see `GOVERNANCE_STORE_MIGRATION_V1.md`.

### Downgrade / version mismatch

If the latest `governance_store_versions` row records any schema version
other than `aoc.governance-store.schema.v1`, construction throws
`GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` and the store **refuses to open**.
No rewrite, no downgrade-in-place. Rolling back across schema versions
means restoring the pre-upgrade backup of the database file.

### Corruption

Corruption is surfaced on **read**, never repaired on write: if a stored
aggregate is structurally incomplete or contains invalid JSON (or a record
whose per-record `metadata.schema_version` is unsupported), reads throw
`GOVERNANCE_RECORD_CORRUPTED` carrying `missingComponents` and
`integrityFailures`. Hash-chain and digest tampering is detected by the
verification API (`verifyGovernanceRecordIntegrity`). The store never
auto-repairs, wipes, or recreates data; recovery is restoring from backup.

---

## Agent Passport Store (`aoc.agent-passport.schema.v1`)

### Schema summary

Three tables plus the version ledger. `agent_passport_events` is canonical;
`agent_passports` is a reconstructable projection cache (the only table any
store UPDATEs — every column on it is re-derivable from the events).

| Table | Primary key | Uniqueness | Foreign keys | Indexes |
| --- | --- | --- | --- | --- |
| `agent_passport_store_versions` | `id` (autoincrement) | — | — | — |
| `agent_passports` | `passport_id` | **partial UNIQUE** `(organization_id, agent_id) WHERE current_status IN ('draft','active','suspended')` — one non-terminal Passport per (org, agent), enforced at the DB layer | — | organization_id |
| `agent_passport_events` | `event_id` | `UNIQUE(passport_id, sequence)` | `passport_id` → `agent_passports(passport_id)` | (passport_id, sequence) |
| `agent_passport_idempotency` | `(scope, idempotency_key)` composite | (primary key itself) | — | — |

Events form a per-passport hash chain: each row carries `event_digest` and
`previous_event_digest`, with contiguous `sequence` enforced by the append
transaction plus the `UNIQUE(passport_id, sequence)` constraint.

### Version ledger, fresh install, upgrade

`agent_passport_store_versions` records `schema_version`,
`migration_state`, `recorded_at`. On open: `db.exec(SCHEMA_V1)` (all
`IF NOT EXISTS`, idempotent), then if no version row exists one is inserted
with `migration_state = 'current'`. **v1 is the first schema — there is no
upgrade migration and no legacy data to import.** The relationship to the
pre-existing Passport SaaS product (deliberately *not* migrated) is
documented in `AGENT_PASSPORT_MIGRATION_V1.md`.

### Downgrade / version mismatch

If the latest ledger row records a different schema version, the factory
closes the database handle and throws `PASSPORT_STORE_UNAVAILABLE`
("Refusing to open the store."). Rollback across schema versions requires
restoring the pre-upgrade backup.

### Corruption

`reconstruct` returns `status: 'incomplete'` with the reconstruction
failure listed in `integrityFailures` instead of fabricating a passport;
`verify` runs structural verification over the event chain. The store
never auto-repairs, wipes, or recreates; recovery is restoring from backup.

---

## Assurance Store (`aoc.assurance-store.schema.v1`)

### Schema summary

The assessment aggregate is canonical in
`assurance_assessments.assessment_json`; the normalized child tables are
write-once queryable projections written at the terminal save
(`INSERT OR IGNORE`), never a second source of truth.

| Table | Primary key | Uniqueness | Foreign keys | Indexes |
| --- | --- | --- | --- | --- |
| `assurance_store_versions` | `id` (autoincrement) | — | — | — |
| `assurance_frameworks` | `(framework_id, framework_version)` composite | (primary key — framework versions are immutable) | — | — |
| `assurance_assessments` | `assessment_id` | — | — | organization; (org, subject) |
| `assurance_evidence_references` | `evidence_reference_id` | — | `assessment_id` → assessments | assessment |
| `assurance_control_evaluations` | `control_evaluation_id` | `UNIQUE(assessment_id, control_id)` | `assessment_id` → assessments | — |
| `assurance_domain_assessments` | `domain_assessment_id` | `UNIQUE(assessment_id, domain_id)` | `assessment_id` → assessments | — |
| `assurance_scores` | `assessment_id` | (primary key) | `assessment_id` → assessments | — |
| `assurance_eligibility_results` | `(assessment_id, profile_id)` composite | (primary key) | `assessment_id` → assessments | — |
| `assurance_findings` | `finding_id` | — | `assessment_id` → assessments | assessment |
| `assurance_finding_events` | `finding_event_id` | `UNIQUE(finding_id, sequence)` | `finding_id` → `assurance_findings(finding_id)` | — |
| `assurance_manual_reviews` | `review_id` | — | `assessment_id` → assessments | assessment |
| `assurance_signals` | `signal_id` | — | — | (org, subject) |
| `assurance_commercial_releases` (ASSURE-REL-01A) | `report_id` | (primary key — one release per report version) | `assessment_id` → assessments | assessment |

`assurance_commercial_releases` is created at open time on an existing v1
database, without changing the schema identifier or any existing row, and
carries a per-row `custody_version`. `BEFORE UPDATE` and `BEFORE DELETE`
triggers make it append-only. See
`docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md` §13.

Mutations are tightly bounded: the assessment row may be upserted only
until it reaches a terminal status (a terminal assessment throws
`ASSURANCE_ASSESSMENT_IMMUTABLE` on re-save), and the only other UPDATE is
the supersession overlay (`status = 'superseded'`, `superseded_by`) on a
completed assessment. Findings, finding events, manual reviews, and
signals are append-only — duplicate inserts are rejected with explicit
"append-only" errors.

### Version ledger, fresh install, upgrade

`assurance_store_versions` records `schema_version`, `migration_state`,
`recorded_at`. On open: `db.exec(SCHEMA_V1)` (all `IF NOT EXISTS`,
idempotent), then a `migration_state = 'current'` row is inserted if none
exists. **v1 is the first schema — the preliminary audit found no existing
Assurance data anywhere in the repository to migrate** (see
`ASSURANCE_STORE_MIGRATION_V1.md`, which also fixes the labeling rules for
any future manual import).

### Downgrade / version mismatch

If the latest ledger row records a different schema version, the factory
closes the handle and throws `ASSURANCE_STORE_UNAVAILABLE` ("Refusing to
open the store."). Rollback across schema versions requires restoring the
pre-upgrade backup.

### Corruption

`verifyAssessment` re-verifies a stored assessment against its persisted
framework definition and reports failures in the verification result. The
store never auto-repairs, wipes, or recreates; recovery is restoring from
backup.

---

## Shared operational behavior

### Missing store file

All three factories resolve the path and create the parent directory
(`mkdirSync(..., { recursive: true })`); SQLite then creates the database
file. A missing store is therefore **auto-created empty and initialized as
a deliberately fresh install** (schema + version row) — it is not an error
condition. Operationally this cuts both ways: if you *expected* data at
that path (wrong mount, renamed volume, restored host), the store will not
warn you — it will happily start a new empty ledger. If history was
expected and health reports a fresh `migration_state`, stop the host and
restore the real database file from backup before appending anything.
(`':memory:'` is also accepted for ephemeral stores.)

### Store recreation and backup/restore

- **Recreation is never automatic.** No code path drops or rewrites
  tables; deleting the file and reopening is the only way to get a clean
  store, and doing so discards governed history — it is an operator
  decision, not a runtime behavior.
- **Backup unit is the database file.** With `journal_mode = WAL`, a
  consistent backup must be taken after `close()` (or a WAL checkpoint),
  or must include the `-wal`/`-shm` sidecar files.
- **Restore is the universal recovery path**: for downgrade (a database
  stamped with a newer schema version will simply refuse to open under an
  older build), for corruption (`GOVERNANCE_RECORD_CORRUPTED` /
  incomplete reconstructions), and for an unexpectedly fresh store.
  After restoring a pre-upgrade governance backup, the next open under a
  newer build re-runs the idempotent init/migration transaction.
- `synchronous = FULL` means a committed append is durable at the OS/disk
  boundary — restoring a backup loses only what was appended after the
  backup was taken, never a torn transaction.

## Verified invariants (checked against the v1.0.0 sources)

- [x] **Append-only governance tables** — the governance store contains no
  `UPDATE`, `DELETE`, or `DROP` statement at all; passport `UPDATE` is
  limited to the reconstructable `agent_passports` projection cache;
  assurance `UPDATE` is limited to pre-terminal assessment upsert and the
  supersession overlay. Finding/passport/governance event history is
  strictly append-only.
- [x] **Hash chain anchored by `chain_position` UNIQUE** — every
  governance aggregate links `previous_aggregate_digest` to the prior
  chain head, and the `governance_integrity.chain_position INTEGER NOT
  NULL UNIQUE` constraint makes forks or rewrites a constraint violation.
  Passport events chain via `previous_event_digest` +
  `UNIQUE(passport_id, sequence)`; assurance finding events enforce
  contiguous sequences + `UNIQUE(finding_id, sequence)`.
- [x] **Prepared statements only** — every INSERT/UPDATE/SELECT goes
  through `db.prepare(...)` with `?` or `@named` bound parameters.
- [x] **No string-interpolated SQL values** — dynamic SQL is limited to
  composing WHERE clauses from fixed code fragments with `?`
  placeholders; user-supplied values are always bound, never concatenated
  into SQL text. (The single interpolation, `busy_timeout = ${...}`, is a
  validated positive safe integer from construction options, not stored
  data.)
- [x] **Schema version enforced on open** — all three stores read their
  version ledger before serving traffic and refuse to open a database
  recorded under a different schema version.
- [x] **Idempotent initialization** — `CREATE TABLE IF NOT EXISTS`
  everywhere; version row inserted only when absent; governance legacy
  migration skips already-migrated rows.
