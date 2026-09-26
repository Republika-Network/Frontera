# Frontera Systems Host — Backup and Recovery (v1.0.0)

Backup strategy for the Enterprise Host's SQLite persistence. Applies
only to `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`; the `memory`
provider has nothing to back up and loses all state on restart.

**As of the v1.0.0 portability validation, the recommended way to take
and restore a backup is the automated tooling in**
`docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` **and**
`docs/operations/AOC_ENTERPRISE_RESTORE_V1.md` **(`npm run backup:v1`,
`npm run restore:v1`)** — it performs exactly the consistency-safe
SQLite copy, integrity check, and verification steps described below,
plus a versioned manifest, SHA-256 checksums, and fail-closed restore
validation, as a single command instead of the manual procedure. This
document remains accurate as the underlying mechanics and as a manual
fallback (e.g. no Node/npm available on the machine holding the backup
volume); read it for *why* the consistency model works, and the
automated docs for *how to run it* day to day.

## What to back up

Three independent database files (defaults shown; the deployed paths are
whatever the three `*_SQLITE_PATH` variables say):

| Store | Default path | Contents |
|---|---|---|
| Governance Store | `.data/enterprise-host.sqlite` | Requests, evaluations, traces, events, versions |
| Agent Passport Store | `.data/agent-passport.sqlite` | Passport event chains and projections |
| Assurance Store | `.data/assurance.sqlite` | Assessments, findings, reviews, signals, scores |

**Always back up all three files together as one consistent set.** The
stores are independent files but their records reference each other
(passports link governance records and Evidence Bundle references;
assurance assessments reference governance evidence). A backup set taken
at one moment keeps those references resolvable; mixing files from
different backup runs does not.

Also keep, alongside the databases (they are required to make a backup
restorable, cheap to capture, and not secret-free — protect the set):

- the deployed build identity (git tag / release artifact version) —
  the schema-version guard means a backup is only openable by a build
  generation that supports its recorded schema;
- the environment configuration (minus `AOC_ENTERPRISE_API_KEYS`, which
  belongs in your secret store).

## How to back up

Each live database is up to three files: `<db>`, `<db>-wal`, `<db>-shm`.
**Never plain-`cp` a live WAL database** — a copy taken mid-write, or a
database copied without its `-wal`, is a mixed-generation file set:
best case it is missing the newest commits, worst case it fails digest
verification after restore.

### Cold backup (recommended — the only cross-store-consistent option)

1. Stop the Host (`SIGTERM`; clean shutdown checkpoints the WAL and
   closes each store).
2. Copy the three database files (plus any remaining `-wal`/`-shm`
   sidecars, kept with their database) to the backup destination.
3. Restart the Host and run the health verification runbook
   (`RUNBOOKS_V1.md` section 12).

Downtime is seconds to low minutes. Because all writers are stopped, the
three files are a true point-in-time set — this is the only method that
guarantees cross-store consistency.

### Online backup (no downtime, per-file consistency only)

Use SQLite's online backup API, which is safe against a live writer:

```bash
sqlite3 /var/lib/aoc-enterprise/enterprise-host.sqlite ".backup '/backups/2026-07-12/enterprise-host.sqlite'"
sqlite3 /var/lib/aoc-enterprise/agent-passport.sqlite  ".backup '/backups/2026-07-12/agent-passport.sqlite'"
sqlite3 /var/lib/aoc-enterprise/assurance.sqlite       ".backup '/backups/2026-07-12/assurance.sqlite'"
```

Each `.backup` output is internally consistent and self-contained (no
sidecars needed on restore). But the three commands run at slightly
different instants against a live Host, so the **set** is not a single
point in time: a record written between the first and last command can
leave a cross-store reference dangling. Acceptable for routine backups;
use cold backups when strict cross-store consistency is required
(pre-upgrade, compliance snapshots).

Filesystem/volume snapshots are equivalent to a cold backup **only** if
they are atomic across the whole data directory and all three databases
live on the same volume; otherwise treat them as online backups.

## Frequency

- **Minimum:** daily online backup, plus a cold backup before every
  upgrade, migration, or restore (the upgrade runbook already mandates
  this).
- Because there is no point-in-time recovery, your **backup interval is
  your data-loss window** (see RPO below). Governance and assurance
  records are typically low-volume but high-value: if losing an hour of
  decisions is unacceptable, back up hourly (online backups are cheap —
  seconds per file).
- Retain by policy, not disk pressure. Suggested floor: 7 daily, 4
  weekly, 12 monthly, plus every pre-upgrade cold backup for as long as
  its build generation might be rolled back to. Governance records may
  carry their own retention obligations — retention governance is not
  automated in v1; enforce it in the backup system.
- Store backups off-host, access-controlled: they contain everything the
  live databases do.

## Verifying backups

An unverified backup is a hope, not a backup. For every backup run (or
at least a regular sample):

1. **Structural check** — per file, against the backup copy:
   ```bash
   sqlite3 /backups/2026-07-12/enterprise-host.sqlite "PRAGMA integrity_check;"   # expect: ok
   ```
2. **Start a throwaway Host against the copy** (never against the
   originals) on a scratch machine or port:
   ```bash
   AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite \
   AOC_ENTERPRISE_HTTP_HOST=127.0.0.1 AOC_ENTERPRISE_HTTP_PORT=18787 \
   AOC_ENTERPRISE_SQLITE_PATH=/restore-test/enterprise-host.sqlite \
   AOC_ENTERPRISE_PASSPORT_SQLITE_PATH=/restore-test/agent-passport.sqlite \
   AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH=/restore-test/assurance.sqlite \
   npm run start:enterprise
   ```
   A ready Host (`GET /ready` 200, `GET /health` modules ready with the
   expected `schemaVersion`) proves the files open, the schema version
   matches the build, and the stores pass their writability checks.
   Use the same build generation that produced the backup.
3. **Verify a sample of records** through the digest-verification
   endpoints:
   ```bash
   curl -s http://127.0.0.1:18787/api/governance/evaluations/<id>/verify
   curl -s -X POST http://127.0.0.1:18787/api/assurance/assessments/<id>/verify
   curl -s -X POST http://127.0.0.1:18787/api/evidence/verify \
        -H 'content-type: application/json' -d '{"bundleId":"<id>"}'
   curl -s -X POST http://127.0.0.1:18787/api/passports/<id>/verify \
        -H 'content-type: application/json' -d '{"mode":"FULL_INTERNAL"}'
   ```
   Every stored record carries SHA-256 digests recomputed by these
   endpoints, so tampering or corruption in the backup chain is
   **detectable, not silent**. Sample recent records (the ones a restore
   would most need) plus a few old ones. Any `valid: false` disqualifies
   the backup and is an integrity incident (`RUNBOOKS_V1.md` section 8).
4. Tear the throwaway Host down and discard the scratch copies.

## Restore procedure

Full steps in `RUNBOOKS_V1.md` section 5. Summary:

1. Stop the Host.
2. Move the current files aside (preserve; do not delete).
3. Copy in all three databases from one verified backup set. Keep any
   sidecars with their database; never combine a database from one run
   with sidecars or siblings from another.
4. Fix ownership and permissions (service user, directory `0700`).
5. Start the **matching build generation**, run health verification, and
   spot-run the verify endpoints.
6. Communicate the recovery point: all writes after the backup are lost.

## Disaster recovery (host lost entirely)

1. Provision a replacement host per
   `DEPLOYMENT_GUIDE_V1.md` (Node >= 22, service user, data volume).
2. Deploy the **same build generation** as the backup (this is why the
   build identity is stored with the backup — a newer-schema or
   older-schema build will refuse the files, fail closed).
3. Restore configuration from your config management and API keys from
   the secret store.
4. Restore the backup set into the data directory and start the Host.
5. Run health verification and record-sample verification.
6. Repoint DNS / the reverse proxy; confirm callers reconnect.
7. Take an immediate fresh backup of the recovered instance.

Practice this path. The measured time of steps 1–6 is your real RTO.

## RPO and RTO

- **RPO = your backup interval.** The runtime has **no replication**, no
  streaming changelog, and no secondary. Everything written after the
  last backup is unrecoverable if the volume is lost. Hourly backups →
  up to one hour of accepted loss.
- **RTO = minutes.** Recovery is copy-files-and-start: restore three
  SQLite files, start one process, wait for `/ready` (startup is bounded
  by `AOC_ENTERPRISE_STARTUP_TIMEOUT_MS`, default 30 s). On an existing
  standby host this is single-digit minutes; a full rebuild adds the
  provisioning time of the disaster-recovery runbook.

## Limitations

- **No point-in-time recovery.** There is no WAL archiving or changelog
  replay; you can restore only to the discrete moments at which backups
  were taken. If finer granularity matters, shorten the interval.
- **No cross-store transactional snapshot while the Host runs.** Each
  store is an independent SQLite file with its own transactions; online
  backups of the three files are taken at slightly different instants.
  **Stopped (cold) backups are the recommendation wherever strict
  cross-store consistency matters.**
- **Single copy by design.** No replication, no failover pair in v1;
  availability during restore is zero for that instance. Per-tenant
  instances fail independently — one tenant's restore does not affect
  another's.
- **Schema-version coupling.** A backup is restorable only by a build
  generation whose stores support its recorded schema versions (the
  stores fail closed on mismatch). Keep pre-upgrade backups until you
  would no longer roll back to their build.
- **Backups are not access-controlled by the runtime.** The digests make
  alteration detectable after the fact, but confidentiality of backup
  copies is entirely the backup system's job.
