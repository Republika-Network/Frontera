# Soberanía Governance Store — Operations Guide

Operating the Governance Store v1 in the Frontera Systems Host.

## Initialization

The composition root (`createEnterprise()`) builds the store from
configuration and wraps it in the required
`aoc.enterprise.governance-store` module. Initialization order:

1. open the database (SQLite) or allocate state (memory);
2. apply pragmas: `foreign_keys = ON`, `journal_mode = WAL`,
   `synchronous = FULL`, `busy_timeout = <configured>`;
3. create the v1 schema (`CREATE TABLE IF NOT EXISTS`, transactional);
4. validate the recorded schema version (`governance_store_versions`) —
   an unknown/future version aborts startup with
   `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED`;
5. migrate any PR-002 data (see below), inside the same transaction;
6. module `initialize()` verifies connectivity **and writability** —
   a read-only store fails startup, because evaluations must be durably
   recordable before the Host reports ready.

## Environment configuration

| Variable | Default | Effect |
|---|---|---|
| `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` | `memory` | `memory` or `sqlite` |
| `AOC_ENTERPRISE_SQLITE_PATH` | `.data/enterprise-host.sqlite` | database file (`:memory:` supported) |
| `AOC_ENTERPRISE_STORE_BUSY_TIMEOUT_MS` | `5000` | `PRAGMA busy_timeout` |
| `AOC_ENTERPRISE_STORE_MAX_REQUEST_PAYLOAD_BYTES` | `262144` | enforced append limit |
| `AOC_ENTERPRISE_STORE_MAX_RESULT_PAYLOAD_BYTES` | `524288` | enforced append limit |
| `AOC_ENTERPRISE_STORE_MAX_EVENT_PAYLOAD_BYTES` | `65536` | enforced append limit |
| `AOC_ENTERPRISE_STORE_MAX_TRACE_STEPS` | `500` | enforced append limit |

Limits are validated at startup; invalid values fall back to defaults at
parse time and non-positive programmatic values are rejected.

### Pragma tradeoffs (documented decision)

- `journal_mode = WAL`: readers do not block the writer; PR-002 already
  used WAL. WAL creates `-wal`/`-shm` sidecar files next to the database.
- `synchronous = FULL`: every commit is fsynced. This is the
  correctness-over-throughput choice appropriate for a governance record
  store; if append latency ever becomes a problem, `NORMAL` (with WAL) is
  the documented relaxation, at the cost of possibly losing the most
  recent commits on power failure (never corruption).
- `busy_timeout`: bounded waiting on a locked file instead of an
  immediate `SQLITE_BUSY` throw when another process holds the write lock.

## Database files

For an on-disk store expect: `<path>`, `<path>-wal`, `<path>-shm`. All
three belong together — copy or back up only when the Host is stopped, or
use SQLite-native backup tooling. Health output and logs never print the
full path.

## Backup

- **Cold backup (recommended for v1):** stop the Host (reverse-order
  module shutdown closes the store cleanly, checkpointing the WAL), copy
  the database file, restart.
- **Warm backup:** `sqlite3 <path> ".backup <target>"` uses SQLite's
  online backup API and is safe against a live writer.
- Verify a restored backup by opening it with the Host and spot-running
  `GET /api/governance/evaluations/:id/verify` on recent records.

## Health

`GovernanceStore.health()` → surfaced through the module into
`GET /health`:

```json
"modules": {
  "aoc.enterprise.governance-store": {
    "state": "ready",
    "health": {
      "status": "healthy",
      "details": {
        "provider": "sqlite",
        "writable": true,
        "readable": true,
        "schemaVersion": "aoc.governance-store.schema.v1",
        "migrationState": "fresh"
      }
    }
  }
}
```

`migrationState` values: `fresh` (new database),
`migrated-from-pr-002`, `not-applicable` (memory provider), `unknown`
(version row unreadable — investigate). Readiness (`GET /ready`) is false
whenever the store is unavailable, unwritable, or its schema is
incompatible.

## Verification

- Per record: `GET /api/governance/evaluations/:evaluationId/verify`
  recomputes every digest from stored payloads and checks chain linkage.
  `valid: false` lists the failed checks.
- Verification requires organization scope (or a system credential) and
  implies no external cryptographic attestation.
- There is no bulk re-verification job in v1; sweeping the store is a
  loop over `query()` + `verify()` at the service layer.

## Corruption response

If `verify` reports failures or `reconstruct` returns
`incomplete`/`corrupted`:

1. **Do not repair in place.** v1 has no automated repair by design;
   rows must not be rewritten to "fix" digests — that would be
   indistinguishable from tampering.
2. Capture the structured result (failed checks, missing components) and
   the surrounding chain positions.
3. Compare against the most recent backup; determine whether the database
   was modified outside the Host.
4. Preserve the corrupted file for review; restore service from backup if
   necessary.
5. Future PRs add the sanctioned path: quarantine markers, appended
   correction/supersession records, and Assurance review — never
   in-place mutation.

Corrupted records are counted in telemetry
(`governance_store_corrupted_records_total` via
`storeCorruptedRecordCount`).

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| startup fails `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` | database written by a newer build | run the newer build, or restore the matching backup |
| startup fails with migration error | unreadable legacy rows | nothing was changed (transactional rollback); inspect the legacy tables, fix/back up, retry |
| 503 `GOVERNANCE_STORE_UNAVAILABLE` on evaluate | file locked, deleted, or store closed | check disk, locks (`busy_timeout`), health endpoint |
| 409 `GOVERNANCE_IDEMPOTENCY_CONFLICT` | caller reused an Idempotency-Key with a different payload | caller-side bug; the stored original is untouched |
| 409 `CONCURRENCY_CONFLICT` | requestId reused with different payload | same as above, PR-002-compatible signal |
| 413 `GOVERNANCE_RECORD_TOO_LARGE` | oversized context/result | raise the configured limit deliberately, or trim caller context |
| `verify` fails after a restore | mixed generations of files (db without its `-wal`) | restore all sidecar files together |

## Safe shutdown

`enterprise.close()` runs reverse-dependency module shutdown; the
Governance Store module's `shutdown()` closes the connection (WAL
checkpoint on clean close). Lifecycle events emitted after the store has
closed are dropped silently (documented best-effort). After `close()`,
every store call fails with `GOVERNANCE_STORE_UNAVAILABLE`.

## Migration

See `docs/enterprise/GOVERNANCE_STORE_MIGRATION_V1.md`. Operationally:
take a backup before first boot of a PR-004 build on a PR-002 database;
the migration runs automatically, transactionally, and idempotently, and
never modifies the legacy tables.
