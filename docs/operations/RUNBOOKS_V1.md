# Soberanía Enterprise Host — Operational Runbooks (v1.0.0)

One runbook per operational situation. Prerequisite reading:
`docs/operations/DEPLOYMENT_GUIDE_V1.md` (configuration, architecture),
`docs/operations/BACKUP_RECOVERY_V1.md` (backup/restore mechanics).
`$BASE` below is the Host's base URL; authenticated deployments add
`-H "Authorization: Bearer <key>"` to every API call.

## 1. Deployment (fresh install)

**When:** first installation on a new machine or tenant.

1. Provision Node.js >= 22, the service user, and the data directory
   (owned by the service user, mode `0700`, local disk).
2. Install and build:
   ```bash
   npm ci && npm run build
   ```
3. Configure the environment (see the deployment guide). A production
   Host needs the secure profile in `docs/enterprise/AOC_ENTERPRISE_HOST.md`
   §"Secure production host (PROD-01)": `AOC_ENTERPRISE_ENV=production`,
   `sqlite` persistence with every `*_SQLITE_PATH` on the data volume,
   `AOC_ENTERPRISE_REQUIRE_AUTH=true`, the durable Kernel Authority source,
   the authority signing key and trusted set, and
   `AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE`. It refuses to start otherwise,
   printing `refused to start [CODE]`.
4. Start the service (`systemctl start aoc-enterprise` or
   `npm run start:enterprise`). First boot creates the three databases
   and records their schema versions.
5. Run the health verification runbook (section 12).
6. Seed governance data (actors, trust domains) via the
   recognition/authority runtimes — the Host boots fail-closed with zero
   registered actors.
7. Take an initial backup (it captures the empty, schema-stamped store
   set — the baseline for later comparisons).

## 2. Upgrade

**When:** deploying a new build over an existing store set.

1. Announce/schedule; the Host will be unavailable for the duration.
2. Stop the Host cleanly (`SIGTERM`; systemd `stop`). Confirm the
   process exited — a clean close checkpoints the WAL.
3. **Back up all three database files** (see
   `BACKUP_RECOVERY_V1.md`). Do not skip this: it is the only rollback
   path if the new build migrates or re-stamps the schema.
4. Deploy the new build (`git checkout <tag>`, `npm ci`,
   `npm run build` — or unpack the release artifact).
5. Start the Host.
6. Verify: section 12, plus check `GET /health` reports the expected
   `enterpriseVersion` and each store module's `migrationState`.
7. If startup fails with a schema-version error, the database is from a
   different generation than the build — see Rollback.

## 3. Rollback

**When:** a new build must be backed out.

1. Stop the Host.
2. Redeploy the previous build (previous tag/artifact; `npm ci`,
   `npm run build`).
3. Start the Host and run section 12.
4. **Schema-version guard:** each store refuses to open a database
   recorded under a schema version the running build does not support
   (Governance Store: startup aborts with
   `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED`; Passport/Assurance stores:
   `PASSPORT_STORE_UNAVAILABLE` / `ASSURANCE_STORE_UNAVAILABLE` naming
   the mismatched version). If the upgraded build wrote a newer schema
   version, the older runtime will therefore **refuse the database** —
   this is fail-closed by design, never data loss. In that case restore
   the pre-upgrade backup taken in the upgrade runbook (all three
   databases together, as a set) and start the old build against it.
   Records written between the upgrade and the rollback exist only in
   the newer-schema files; preserve those files for later re-upgrade or
   review.

## 4. Backup

**Preferred:** `npm run backup:v1 -- --output <dir>` (see
`docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`) — a single command that
performs the consistency-safe SQLite copy, `PRAGMA integrity_check`,
checksums, and a versioned manifest, and refuses to produce a partial
backup on any failure.

Manual fallback (see `docs/operations/BACKUP_RECOVERY_V1.md` for the full
strategy):

- Stop the Host, copy the three database files, restart.
- Online: `sqlite3 <db> ".backup '<dest>'"` per database file (SQLite's
  online backup API — safe against a live writer). Never plain-`cp` a
  live WAL database.
- Always back up all three stores together as one consistent set, and
  verify the backup (integrity check + spot verification) before
  trusting it.

## 5. Restore

**When:** replacing the live store set with a backup.

**Preferred:** `npm run restore:v1 -- --backup <dir> --target <dir>`
(see `docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`) — validates the
backup's format, checksums, SQLite integrity, and schema compatibility
before touching `--target`; refuses to overwrite existing stores without
`--force`; takes a pre-restore safety copy; and rolls back on any
post-restore verification failure. Point
`AOC_ENTERPRISE_*_SQLITE_PATH` at the restored files afterward.

Manual fallback:

1. Stop the Host.
2. Move the current database files (all of `<db>`, `<db>-wal`,
   `<db>-shm` for each store) aside — never delete them; they may be
   evidence.
3. Copy the backup set into place; restore all three stores from the
   **same** backup run. `.backup`-produced files have no sidecars; a
   cold-copy backup must be restored with whatever sidecars it was taken
   with, together.
4. Fix ownership/permissions (service user, `0700` directory).
5. Start the Host; run section 12; spot-run the verify endpoints on
   recent records (section 8's commands) to confirm digest integrity.
6. Announce the recovery point: everything written after the backup was
   taken is gone (see RPO in `BACKUP_RECOVERY_V1.md`).

## 6. Incident response (triage)

**Symptoms:** elevated errors, 503s, latency, or an alert.

1. Probe the three health surfaces:
   ```bash
   curl -si $BASE/live
   curl -si $BASE/ready
   curl -s  $BASE/health | jq .
   ```
   - `/live` 503 or connection refused → process-level problem: check
     the service manager and stdout logs; restart if dead.
   - `/live` 200 but `/ready` 503 → started-but-not-ready: the body's
     `lifecycleState` and `/health`'s per-module states say which module
     is failing (commonly a store: unavailable, unwritable, or
     schema-incompatible).
   - Both 200 but API errors → read the error envelopes (every error is
     `{ "error": { "code", "message", ... } }`) and match the code
     against the runbooks below.
2. Check logs (structured JSON on stdout): filter `level=error` and
   group by `errorCode` and `route`.
3. Common codes:
   - `ENTERPRISE_NOT_READY` (503) — lifecycle not ready; see section 13.
   - `GOVERNANCE_STORE_UNAVAILABLE` / `ASSURANCE_STORE_UNAVAILABLE` /
     `PASSPORT_STORE_UNAVAILABLE` (503) — file locked, deleted, disk
     full, or store closed; check disk space, mount, permissions.
   - `GOVERNANCE_RECORD_CORRUPTED` (500) — section 7.
   - `AUTHENTICATION_FAILED` (401) / `AUTHORIZATION_FAILED` (403) —
     caller credential problem, not a Host fault; check key
     configuration and organization scoping.
4. If the store is implicated, capture `PRAGMA integrity_check` output
   (section 7) before restarting anything.

## 7. Database corruption

**Symptoms:** `GOVERNANCE_RECORD_CORRUPTED` errors on reads, a verify
endpoint returning `valid: false`, SQLite `SQLITE_CORRUPT` in logs,
`migrationState: "unknown"` in `/health`, or a store failing writability
checks at startup.

**Diagnosis:**

```bash
# With the Host STOPPED, per affected database:
sqlite3 /var/lib/aoc-enterprise/enterprise-host.sqlite "PRAGMA integrity_check;"
```

`ok` means the file is structurally sound and the problem is at the
record level (failed digests — treat per section 8). Anything else is
file-level corruption.

**Steps:**

1. **Do not repair in place.** The stores never auto-repair, rewrite, or
   wipe data by design — rows must not be rewritten to "fix" digests;
   that would be indistinguishable from tampering. Do not run recovery
   tools that rewrite the file, do not delete sidecars to "unstick" it.
2. Stop the Host; preserve the corrupted file set (db + `-wal` + `-shm`)
   read-only for review.
3. Capture the structured evidence: the failing error envelopes, verify
   results (failed checks, missing components), `integrity_check`
   output, and the telemetry counter
   `governance_store_corrupted_records_total`.
4. Determine cause: disk/volume fault (check kernel logs, SMART), a copy
   of the database taken/restored without its `-wal`, or out-of-band
   modification of the file.
5. Restore from the most recent verified backup (section 5). Compare
   the corrupted file against the backup to bound what was lost or
   altered.
6. Record the incident; failed digests are an integrity event, not just
   an availability event (section 8).

## 8. Verification failures

**Symptoms:** a verify endpoint reports `valid: false` / failed checks:

```bash
curl -s $BASE/api/governance/evaluations/<evaluationId>/verify
curl -s -X POST $BASE/api/assurance/assessments/<assessmentId>/verify   # 409 when invalid
curl -s -X POST $BASE/api/evidence/verify -H 'content-type: application/json' \
     -d '{"bundleId":"<bundleId>"}'
curl -s -X POST $BASE/api/passports/<passportId>/verify -H 'content-type: application/json' \
     -d '{"mode":"FULL_INTERNAL"}'                                      # 409 when invalid
```

Verification recomputes SHA-256 digests from the stored payloads (and
chain/reference linkage where applicable). The runtime never writes a
record whose digests do not match — **a failed verification means the
data was altered outside the runtime or the storage layer corrupted
it.** There is no benign explanation.

**Steps:**

1. Treat as an **integrity incident**, not a bug report. Open an
   incident record immediately.
2. Preserve the store files; capture the full verify response (it lists
   the failed checks) and surrounding records' verify results to bound
   the blast radius (one record vs. a range).
3. Run `PRAGMA integrity_check` (section 7) to separate storage
   corruption from targeted alteration. Check the classic operational
   cause first: a restore that mixed file generations (database without
   its `-wal`).
4. Review access to the database files (who/what can write to the data
   directory) — the Host is the only legitimate writer.
5. **Verify your backups**: run the same verify calls against a
   throwaway Host started on a backup copy. Establish the most recent
   backup whose records verify clean; that is your recovery point.
6. Restore per section 5 if the live data cannot be trusted. Never
   "fix" digests in place (see section 7, step 1).

## 9. Assessment failures

**Symptoms:** an assurance assessment ends in status `failed`, or
`assurance_assessments_failed_total` climbs.

A `failed` assessment is a **recorded terminal state**, not a lost one:
the assessment row persists with `status: "failed"` and a
`failureReason`. (Note: a failed *control* is a valid assessment result
— HTTP 200, findings created — never an error; this runbook is about the
assessment itself failing to evaluate.)

**Diagnosis:**

```bash
curl -s $BASE/api/assurance/assessments/<assessmentId> | jq '.status, .failureReason'
curl -s $BASE/api/assurance/assessments/<assessmentId>/findings | jq .
```

Read the `failureReason`, the findings recorded before the failure, and
the error envelope the triggering call returned (its `code` maps the
cause: e.g. 422 `ASSURANCE_EVIDENCE_INSUFFICIENT` /
`ASSURANCE_EVIDENCE_CONTRADICTORY`, 500
`ASSURANCE_CONTROL_EVALUATION_FAILED`, 503
`ASSURANCE_STORE_UNAVAILABLE`).

**Steps:**

1. Fix the underlying cause (evidence availability, store availability,
   framework/control configuration).
2. A terminal assessment is immutable — do not attempt to re-evaluate it
   (409 `ASSURANCE_ASSESSMENT_IMMUTABLE`). Re-run via the reassessment
   endpoint, which creates a **new** assessment for the subject:
   ```bash
   curl -s -X POST $BASE/api/assurance/subjects/<subjectId>/reassess \
        -H 'content-type: application/json' \
        -d '{"reason":"<why>","requestedBy":"<actor>"}'
   ```
   `reason` and `requestedBy` are required non-empty strings; optional
   `assessmentId` names the assessment being superseded and optional
   `evidenceCutoffAt` bounds the evidence window.
3. Confirm the new assessment reaches `completed` and verify it
   (section 8).

## 10. Signal failures

**Symptoms:** `POST /api/assurance/signals` returns 4xx.

A 4xx on the signal endpoint means the **signal payload is malformed or
mis-scoped** — the Host validated and rejected it before any state
change; nothing was recorded.

**Diagnosis:** read the error envelope. `400 ASSURANCE_SIGNAL_INVALID`
(or `ASSURANCE_VALIDATION_ERROR`) carries `details` listing every field
violation; `403` codes (`ASSURANCE_TENANT_SCOPE_REQUIRED`,
`ASSURANCE_ACCESS_SCOPE_VIOLATION`) mean the caller's key is not scoped
to the signal's organization; `404 ASSURANCE_SUBJECT_NOT_FOUND` means
the subject is unknown.

**Steps:**

1. Fix the producer's payload/credential per the `details` array and
   resubmit — the endpoint records the signal (201) and, where the
   framework's staleness rules apply, marks affected assessments stale.
2. If signals from a previously-working producer suddenly all fail,
   suspect a producer-side deploy or a rotated/rescoped API key — this
   is a caller-side bug, not Host state; there is nothing to clean up on
   the Host.
3. 5xx (`ASSURANCE_STORE_UNAVAILABLE`) is a different failure class —
   triage per section 6.

## 11. Manual review workflow

**When:** controls evaluate to `manual_review_required` and an
assessment is parked in `manual_review` status.

1. List what needs review: fetch the assessment and its control
   evaluations; each control in `manual_review_required` needs exactly
   one recorded review.
2. Record each review:
   ```bash
   curl -s -X POST $BASE/api/assurance/manual-reviews \
        -H 'content-type: application/json' \
        -d '{
              "assessmentId": "<assessmentId>",
              "controlId": "<controlId>",
              "reviewerId": "<who reviewed>",
              "rationale": "<why this outcome>",
              "outcome": "<outcome>"
            }'
   ```
   `assessmentId`, `controlId`, `reviewerId`, `rationale`, and `outcome`
   are all required; `outcome` must be one of `pass`, `partial`, `fail`,
   `insufficient_evidence` (400 `ASSURANCE_MANUAL_REVIEW_INVALID` lists
   what is missing).
3. **Completion is blocked while reviews are pending** — completing an
   assessment with unresolved manual reviews fails 422
   `ASSURANCE_MANUAL_REVIEW_REQUIRED` — **unless** the framework's
   scoring model sets `manualReviewPolicy: 'provisional'`, in which case
   the assessment may complete with eligibility results flagged
   `provisional` (reason code `ELIGIBILITY_PROVISIONAL`) until the
   reviews land.
4. After recording reviews, re-run evaluation/completion and confirm the
   assessment reaches `completed` with the expected eligibility flags.

## 12. Health verification (after any operation)

Run after every deploy, upgrade, rollback, restore, or restart:

```bash
curl -si $BASE/live      # expect 200 {"live":true,...}
curl -si $BASE/ready     # expect 200 {"ready":true,...}
curl -s  $BASE/health | jq '.status, .enterpriseVersion, .kernelVersion, .modules'
# expect status "healthy"; every module "ready"; each sqlite store
# writable:true with the expected schemaVersion and migrationState.

# One real read against each store you depend on, e.g.:
curl -si $BASE/api/governance/evaluations/<known-evaluationId>
curl -si $BASE/api/assurance/assessments/<known-assessmentId>
curl -si $BASE/api/passports/<known-passportId>
```

A probe answering 200 proves routing; the read proves the store opens,
the schema matched, and tenant scoping resolves. After a restore,
additionally spot-run the verify endpoints (section 8).

## 13. Startup validation

**Symptoms:** the process is running but API calls return 503
`ENTERPRISE_NOT_READY`; `/ready` is 503.

**Behavior:** the module lifecycle starts every module in dependency
order and the Host does not report ready — and rejects all API traffic
with `ENTERPRISE_NOT_READY` (the error body includes the current
`lifecycleState`) — until startup completes. Startup as a whole is
bounded by `AOC_ENTERPRISE_STARTUP_TIMEOUT_MS` (default 30000 ms); a
module that cannot initialize fails startup rather than serving in a
half-open state. Store initialization verifies connectivity **and
writability** — a read-only database file fails startup by design.

**Steps:**

1. `curl -s $BASE/ready` — note `lifecycleState`.
2. `curl -s $BASE/health | jq .modules` — find the module that is not
   `ready` and its health details.
3. Typical causes and fixes:
   - Store schema mismatch → rollback runbook (section 3, step 4).
   - Store file unwritable → volume mount, ownership, disk space,
     read-only filesystem.
   - Startup timeout on slow disk → raise
     `AOC_ENTERPRISE_STARTUP_TIMEOUT_MS` deliberately; investigate the
     disk.
   - Assurance module: no registered framework → wrong build/composition
     (section 14); the module requires at least one framework at
     initialize.
4. Fix, restart, re-run section 12. Do not route traffic to an instance
   whose `/ready` is 503 — the load balancer should already exclude it.

## 14. Framework registration

Assurance frameworks are **data registered in code at composition
time**: the framework registry is populated while the Enterprise Host
composes and is **frozen when startup completes**. After that, any
`register()`/`activate()` attempt throws
`ASSURANCE_FRAMEWORK_INVALID` ("registry is frozen"). There is no
runtime registration API, deliberately.

Consequences:

- A framework version is **register-once and immutable**: a
  `frameworkId@version` pair, once shipped, never changes behavior.
  Completed assessments always remain reproducible against the exact
  framework version that scored them (verification depends on this).
- **Changing a framework = shipping a new framework version = a new
  deployment.** Add the new version in code, deploy via the upgrade
  runbook, and leave the old version registered so existing assessments
  still verify and reports still resolve.
- `400 ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED` / `404
  ASSURANCE_FRAMEWORK_NOT_FOUND` from clients after a deploy means the
  build does not register the version callers expect — verify the
  deployed build's registered frameworks via `/health` (the assurance
  module reports its registered framework count) and the release notes.
