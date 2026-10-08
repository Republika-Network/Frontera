# Frontera Pilot Operations Runbook (PROD-03-04)

Day-to-day operation of a Frontera pilot deployed with the PROD-03-03 kit
([`docs/deployment/PILOT_DEPLOYMENT.md`](../deployment/PILOT_DEPLOYMENT.md)).
Installation and the configuration contract are in that guide and are not
repeated here.

**Every command block in this runbook is executed** by the pilot acceptance
qualification (`scripts/deploy/qualify-pilot-acceptance.mjs`, CI job
`pilot-acceptance`) against a real Compose deployment, except blocks marked
*reference*, which say why they cannot run there. The qualification changes
only the published port, the Compose project name and the image tag.

## 1. Conventions

- Every command runs from `deploy/pilot/` of the checked-out release, on the
  machine that runs the kit, as the user that deployed it.
- The Host is reached at `http://127.0.0.1:8787` (the kit's default
  publication). If you publish elsewhere, substitute your address.
- `FRONTERA_IMAGE` selects the image, as in `compose.yaml`; unset, it is
  `frontera-host:pilot`.
- The Compose project is `frontera-pilot`, so the volumes are
  `frontera-pilot_frontera-state` and `frontera-pilot_frontera-witness`.
- `curl` and `sha256sum` are assumed on the machine; nothing else (no Node.js,
  no `jq`, no `sqlite3`).
- Blocks are written for an ordinary interactive shell: a step that depends on
  the previous one is chained with `&&`, so a failure stops the block there
  instead of running the next step on a wrong state. The qualification runs
  them the same way, without `set -e`.

### 1.1 Operator session

Operator-plane calls (`/api/admin/...`) need an operator credential. Load it
into the shell from your secret source without echoing it, and never paste it
into a ticket, a chat or an evidence file:

<!-- ref: interactive (reads credentials from the operator's terminal); the qualification sets the same two variables from its generated credentials -->
```bash
read -rsp 'organization-administrator credential: ' FRONTERA_ADMIN_KEY; echo
read -rsp 'observer credential: ' FRONTERA_OBSERVER_KEY; echo
export ADMIN="Authorization: Bearer $FRONTERA_ADMIN_KEY"
export OBSERVER="Authorization: Bearer $FRONTERA_OBSERVER_KEY"
```

Use the least-privileged role for each task: `observer` to read, `responder`
to declare an emergency stop, `organization-administrator` only for what
needs it (releasing a stop, recording a resolution). The roles and their
permissions are in `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`.
`GET /api/admin/organization` shows the role and permissions of the
credential you are using.

## 2. Startup

Starts a configured deployment. First-time installation (build, secret
generation, `.env`) is PILOT_DEPLOYMENT.md §8.

1. **Confirm the approved release.** You know the commit or tag the pilot
   owner approved, and the checkout is at it.
2. **Verify the image identity.** The image's revision label must be the
   approved commit:

   <!-- exec: startup-identity -->
   ```bash
   docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${FRONTERA_IMAGE:-frontera-host:pilot}"
   ```

   An empty value means the image was built without `FRONTERA_BUILD_COMMIT`
   (a `development` build): stop and rebuild it from the approved release.
3. **Confirm the configuration** — `.env` and `governed-actions.json` are the
   approved ones (your configuration management), with no `<required…>` value
   left.
4. **Run the configuration check** — it must print `RESULT: PASS` and exit 0:

   <!-- exec: startup-config-check -->
   ```bash
   docker compose run --rm config-check
   ```

5. **Verify the volumes** exist and are the deployment's own:

   <!-- exec: startup-volumes -->
   ```bash
   docker volume inspect -f '{{.Name}} {{.CreatedAt}}' frontera-pilot_frontera-state frontera-pilot_frontera-witness
   ```

6. **Start the stack**, 7. **wait for `/live`**, 8. **wait for `/ready`**:

   <!-- exec: startup-start -->
   ```bash
   docker compose up -d &&
     timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/live; do sleep 2; done' &&
     timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done'
   ```

   If `/ready` does not answer 200 within the timeout, the Host refused to
   start or a required module is failing: go to
   [`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md). Do not route traffic to it.
9. **Inspect health** and 10. **verify the version**:

   <!-- exec: startup-inspect -->
   ```bash
   docker compose ps
   curl -sS -w '\n' http://127.0.0.1:8787/health
   curl -fsS -w '\n' http://127.0.0.1:8787/version
   ```

   `docker compose ps` shows `frontera` as `healthy`. `/health` reports
   `"status":"healthy"` (or `degraded` — §9). In `/version`, `commit` is the
   approved commit and `build` is `release`.
11. **Record evidence** — capture the evidence bundle
    ([`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md) §3) and keep it with the
    change record.

## 3. Normal shutdown

1. **Stop new activity.** Tell agent owners and operators, and stop routing
   traffic at your proxy. The Host itself stops accepting on SIGTERM and
   drains in-flight requests.
2. **Stop the stack**, then confirm the clean exit and that both volumes are
   still there:

   <!-- exec: shutdown -->
   ```bash
   docker compose stop
   docker compose ps -a
   docker compose logs --no-color frontera | grep -c enterprise.host.shutdown_complete
   docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -a -q frontera)"
   docker volume inspect -f '{{.Name}}' frontera-pilot_frontera-state frontera-pilot_frontera-witness
   ```

   The `shutdown_complete` count is at least 1 and the exit code is `0`.

`docker compose stop` (and `restart`, and `down`) sends SIGTERM. The Host stops
accepting, closes its listener, shuts modules down in reverse order, closes
every store and exits 0 within 30 s; Compose waits 45 s before it would send
SIGKILL. Do not `kill -9` or `docker kill` the Host except as a last resort
when it does not exit, and record it if you do: a killed Host leaves WAL
sidecars, so the next cold backup is refused until the Host has been started
and stopped cleanly once.

| Command | Containers | Volumes | Use |
| --- | --- | --- | --- |
| `docker compose stop` | stopped, kept | kept | routine shutdown, before a cold backup |
| `docker compose down` | removed | kept | before an upgrade or recreating containers |
| `docker compose down -v` | removed | **deleted** — all Host state and the witness | **never** in a pilot |

**DO NOT use `docker compose down -v`** during routine shutdown or at any
other point of operating a pilot. It deletes the `frontera-state` and
`frontera-witness` volumes: every governed record, all evidence and the
witness that anchors authority state. It cannot be undone from Frontera.

## 4. Restart

A routine restart keeps the same release, the same configuration and the same
volumes.

<!-- exec: restart -->
```bash
docker compose restart frontera &&
  timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done' &&
  curl -fsS -w '\n' http://127.0.0.1:8787/version
```

After a full shutdown (§3), start again with §2 steps 6–10.
`docker compose restart` does not apply a changed `.env` or image; to apply a
configuration change run the configuration check and then
`docker compose up -d`, which recreates the containers.

Verify:

- [ ] `/ready` answers 200.
- [ ] `/version` shows the same `release` and `commit` as before the restart.
- [ ] `GET /api/admin/operations/metrics` (observer) shows the same decision
      and execution counts as before the restart.
- [ ] Attention (`GET /api/admin/operations/attention`) lists the same
      executions as before.
- [ ] Active emergency stops (`GET /api/admin/emergency-controls`) are the
      same.

A restart never re-initializes a store, and nothing that was decided,
claimed or resolved is executed again.

## 5. Backup

The technical boundary is PILOT_DEPLOYMENT.md §14. This is the operator
procedure, using the existing `backup:v1` tool inside the Host's own image,
with the Host's own configuration and volume.

### 5.1 Prerequisites

- A backup destination outside the repository checkout, writable by you,
  access-controlled and later copied off-host and encrypted by your backup
  system. Backups contain governed records, approval subjects and credential
  verifiers — sensitive, though never a secret value.
- The Host **stopped**. The backup is taken cold (`--cold`): the only backup
  that is consistent across all stores. The tool refuses if it sees a store
  still in use (a non-empty WAL sidecar).
- A maintenance window: governed actions are not served while the Host is
  stopped. The witness keeps running.

### 5.2 Take the backup

<!-- ref: sets the operator's destination; the qualification uses a scratch directory -->
```bash
export BACKUP_DIR=/path/to/protected/backup/staging
```

<!-- exec: backup-take -->
```bash
BACKUP_FILE="$BACKUP_DIR/frontera-state-$(date -u +%Y%m%dT%H%M%SZ).tar"
docker compose stop frontera &&
  [ -z "$(docker compose ps -q --status running frontera)" ] &&
  ( umask 077 && docker compose run --rm -T config-check sh -c 'node scripts/portability/backup-enterprise-v1.mjs --cold --output /tmp/frontera-backup >&2 && tar -C /tmp -cf - frontera-backup' > "$BACKUP_FILE" ) ||
  { echo 'BACKUP FAILED: no usable archive was produced' >&2; rm -f "$BACKUP_FILE"; }
docker compose up -d
timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done'
```

The backup runs only once the Host is confirmed stopped: if
`docker compose stop` fails or `frontera` is still running, nothing is
backed up. The archive is created with mode `600`. The command runs `backup:v1` in a throw-away container with the Host's
configuration and the state volume, writes the backup set inside that
container and streams it out as one tar file; nothing is written to the state
volume. Its report goes to the terminal (stderr): the `backupId`, the commit of
the release that took it, `coverageComplete: true`, `consistency:
cold-attested`, and each store with its schema version, checksum and record
count. `BACKUP FAILED` means there is no usable backup (the partial file is
removed) and the Host is started again: read the message above it (the Host
could not be stopped, a missing required store, a store in use, an integrity
failure) and escalate if you cannot explain it. You may run the backup again
after fixing the cause.

### 5.3 Verify the backup

<!-- exec: backup-verify -->
```bash
VERIFY_DIR="$(mktemp -d)"
tar -C "$VERIFY_DIR" -xf "$BACKUP_FILE"
(cd "$VERIFY_DIR/frontera-backup" && sha256sum -c --quiet checksums.sha256)
grep -E '"(backupId|commit|complete|operatorAttestedStopped)":' "$VERIFY_DIR/frontera-backup/backup-manifest.json"
rm -rf "$VERIFY_DIR"
(cd "$(dirname "$BACKUP_FILE")" && sha256sum "$(basename "$BACKUP_FILE")" > "$(basename "$BACKUP_FILE").sha256" && sha256sum -c "$(basename "$BACKUP_FILE").sha256")
```

The first `sha256sum -c` prints nothing when every file in the set matches.
The manifest shows the backup id, the source commit (the release that took
it), `"complete": true` and `"operatorAttestedStopped": true`. The archive's
own checksum file names the archive by its base name, so it stays valid
beside the archive wherever both are copied (`sha256sum -c <archive>.tar.sha256`
from that directory). Record the `backupId` in your backup log.

What the backup **includes**: every Host store the deployment composes
(fourteen at most; the example configuration composes twelve), each copied
with SQLite's backup API and integrity-checked, plus a manifest, checksums
and restore instructions.

What it **excludes**, by design:

| Excluded | Why | How it is preserved |
| --- | --- | --- |
| `.env` (every secret, the authority private key) | never read by the tool | your secret manager |
| `governed-actions.json` | configuration, not data (its SHA-256 is recorded) | your configuration management |
| The witness volume | a different restore domain (CORE-07) | §5.4, separately |

The backup is checksummed, not signed and not encrypted. Protect the storage.

### 5.4 Witness volume (a separate backup set)

The `frontera-witness` volume holds the witness's state **and its private
receipt key**. It is backed up on a different schedule, to different
storage, and is never restored together with a Host backup. Frontera provides
no witness backup tool; this is one supported way to take a consistent copy
with the witness stopped:

<!-- exec: witness-backup -->
```bash
docker compose stop authority-witness &&
  ( umask 077 && docker compose run --rm -T --entrypoint sh witness-init -c 'tar -C /var/lib/frontera-witness -cf - .' > "$BACKUP_DIR/frontera-witness-$(date -u +%Y%m%dT%H%M%SZ).tar" ) ||
  echo 'WITNESS BACKUP FAILED' >&2
docker compose start authority-witness
```

While the witness is stopped the Host is `degraded` (§9): revocations,
obligation discharges and approval verdicts are refused with nothing written.
The archive is created with mode `600`; treat it as key material.

**Restoring the witness is not a self-service procedure.** A witness copy is
consistent with the Host only if the witness recorded no authority transition
after the copy was taken. If the Host's stores are ahead of a restored
witness, the Host refuses to start (`AUTHORITY_FRESHNESS_FORK_DETECTED`), and
that refusal must never be worked around: not by rolling the Host's stores
back to match, and not by resetting or re-enrolling the witness. If the
witness volume is lost or damaged, stop changes, preserve evidence and
escalate as SEV-1 ([`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md)); any use of
this archive is decided under that escalation, never as a routine restore.

## 6. Restore

Replaces the Host's state with a backup. Use it to recover lost or damaged
state, never to "undo" a governed decision.

1. **Stop the Host:** `docker compose stop frontera`.
2. **Check release compatibility.** Restore with the release that took the
   backup whenever possible. Compare the backup's source commit with the
   image you will run:

   <!-- exec: restore-compatibility -->
   ```bash
   docker compose stop frontera
   tar -xOf "$BACKUP_FILE" frontera-backup/backup-manifest.json | grep -E '"(backupId|commit)":'
   docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${FRONTERA_IMAGE:-frontera-host:pilot}"
   ```

   If they differ, the restore tool and the configuration check still refuse
   any store at a schema version the image does not open, but no cross-release
   restore is qualified: prefer the backup's own release (§8).
3. **Preserve the current state** before replacing it: if the state volume
   is readable, take a backup of it first (§5.2). The restore tool also moves
   every existing store aside into a `.pre-restore-safety-…` directory on the
   volume before promoting the backup.
4. **Restore** with the supported tool, in the Host's configuration:

   <!-- exec: restore-run -->
   ```bash
   [ -z "$(docker compose ps -q --status running frontera)" ] &&
     docker compose run --rm -T config-check sh -c 'mkdir -p /tmp/restore && tar -C /tmp/restore -xf - && node scripts/portability/restore-enterprise-v1.mjs --backup /tmp/restore/frontera-backup --target /var/lib/frontera --force' < "$BACKUP_FILE" ||
     echo 'RESTORE NOT COMPLETED: the Host is still running, or restore:v1 refused (the volume is unchanged)' >&2
   ```

   The restore runs only while `frontera` is not running.

   `restore:v1` validates the whole backup before it touches the volume —
   manifest, organization, coverage, checksums, SQLite integrity, schema
   versions, the signed heads under your trusted verification keys — and
   rolls the volume back on any failure. Its report ends with
   `"status": "restored"`. Any refusal leaves the volume as it was.
5. **Ownership and permissions** need no step: the restore runs as the same
   non-root user as the Host, inside the Host's own volume. If the state
   volume was lost, the command above restores into the new, empty volume
   Docker creates.
6. **Start and verify** — 7. `/live`, 8. `/ready`, 9. `/version`,
   10. health:

   <!-- exec: restore-start -->
   ```bash
   docker compose run --rm config-check &&
     docker compose up -d &&
     timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/live; do sleep 2; done' &&
     timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done' &&
     curl -fsS -w '\n' http://127.0.0.1:8787/version &&
     curl -sS -w '\n' http://127.0.0.1:8787/health
   ```

11. **Confirm the expected durable records**: the operations metrics,
    Attention and the traces of executions you know predate the backup
    (`GET /api/admin/operations/executions`, `…/traces/{requestId}`) are
    present.

If the Host refuses to start after a restore:

| Refusal | Meaning | Action |
| --- | --- | --- |
| `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED` | the backup predates an authority transition the witness recorded (a revocation, a discharge, an approval verdict) | restore a newer backup. **Never** reset or re-enroll the witness to make an old backup start |
| `AUTHORITY_FRESHNESS_PENDING_RECOVERY` | the witness holds a prepared transition the restored store lacks | escalate (SEV-1); `docs/operations/RUNBOOKS_V1.md` §5.3 |
| `AUTHORITY_FRESHNESS_BINDING_MISMATCH` | a store from another deployment | restore this deployment's own backup |
| `SCHEMA_INCOMPATIBLE` | the backup is from a release this image does not open | use the backup's release |

After a successful restore of anything older than the latest state, everything
after the backup is gone, and state that is not witness-anchored (emergency
stops, agent credential revocations, profile retirements, exercise
consumption, Kernel Authority changes) is as of the backup. Re-apply those
from your change records: `docs/operations/RUNBOOKS_V1.md` §5.2. In
particular, **re-activate every emergency stop declared since the backup**
and revoke again every agent credential revoked since.

If a restore is interrupted and leaves a `.restore-in-progress` marker on the
volume, do not start the Host; escalate (`docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`
§"Replacement and rollback").

## 7. Upgrade

Each store records its schema version; a release opens only the versions it
was built for and migrates forward in place, inside one transaction, where a
store's schema moved (PILOT_DEPLOYMENT.md §12). There is no separate
migration command and no backward migration.

1. **Read the release notes** of the new release (`CHANGELOG.md`) and its
   `release/RELEASE_MANIFEST.json`.
2. **Verify compatibility**: the new release opens the current store schema
   versions — the configuration check of step 7 says so before anything
   starts.
3. **Record the current release** (step 4 below) and **back up** (§5) — the
   pre-upgrade backup, taken with the current release, is the only way back
   across a schema change.
4. **Record evidence and keep the current image** under a second tag, for
   rollback:

   <!-- exec: upgrade-prepare -->
   ```bash
   curl -fsS -w '\n' http://127.0.0.1:8787/version > "$BACKUP_DIR/pre-upgrade-version.json"
   docker image tag "${FRONTERA_IMAGE:-frontera-host:pilot}" frontera-host:previous
   ```

5. **Stop the Host:** `docker compose stop frontera`.
6. **Obtain and build the approved new release:**

   <!-- ref: needs a git checkout and a second release; the qualification runs the same build from its export -->
   ```bash
   git fetch --tags origin
   git checkout <new-release-tag-or-commit>
   export FRONTERA_BUILD_COMMIT="$(git rev-parse HEAD)"
   ```

7. **Build, check, start, verify** — 8. schema verification and any forward
   migration happen as the Host opens its stores; 9. readiness; 10. the new
   version:

   <!-- exec: upgrade-apply -->
   ```bash
   docker compose stop frontera &&
     docker compose build &&
     docker compose run --rm config-check &&
     docker compose up -d &&
     timeout 300 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done' &&
     curl -fsS -w '\n' http://127.0.0.1:8787/version
   ```

   A failing step stops the chain: a configuration check that refuses never
   reaches `docker compose up`.

11. **Verify operational state**: metrics, Attention and emergency stops as
    in §4.
12. **Record upgrade evidence**: the pre- and post-upgrade `/version`, the
    pre-upgrade `backupId`, the configuration check result and the evidence
    bundle ([`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md) §3).

**Stop conditions** — stop the upgrade, leave the new release stopped, and
roll back (§8) or escalate, if:

- the configuration check fails (any code, including `SCHEMA_INCOMPATIBLE`);
- the Host logs `refused to start [CODE]` or `/ready` is not 200 within the
  timeout;
- `/version` does not show the approved new commit with `build: release`;
- operational state after the upgrade does not match the state before it.

Do not start the old release on stores the new release has already migrated:
it refuses (`SCHEMA_INCOMPATIBLE`), and the way back is §8.

## 8. Rollback

There is **no store schema downgrade**. An older release that finds a store
at a schema version it does not know refuses to start, in the configuration
check and in the Host itself, rather than reading it.

**When rollback to the previous image is allowed:** only when the previous
release opens the current store files — that is, no store's schema version
moved between the two releases. The previous image's configuration check is
the decision: `RESULT: PASS` means it opens them.

<!-- exec: rollback-image -->
```bash
docker compose stop frontera &&
  export FRONTERA_IMAGE=frontera-host:previous &&
  docker compose run --rm config-check &&
  docker compose up -d &&
  timeout 180 sh -c 'until curl -fsS -w "\n" http://127.0.0.1:8787/ready; do sleep 2; done' &&
  curl -fsS -w '\n' http://127.0.0.1:8787/version
```

Keep `FRONTERA_IMAGE` set for every later command in that shell (or tag the
previous image as `frontera-host:pilot` again). Confirm that `/version` shows
the previous release's `commit`, and verify operational state as in §4.

**When a restore is required:** if the previous image's configuration check
refuses with `SCHEMA_INCOMPATIBLE`, the stores have moved forward. Rolling
back then means the previous release **plus** the pre-upgrade backup taken
with it (§6, with `FRONTERA_IMAGE` set to the previous image), accepting the
loss of everything recorded since that backup. If anchored authority state
changed after the backup (a revocation, a discharge, an approval verdict),
the Host refuses with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`; that is a
SEV-1 escalation, never a reason to reset the witness.

The witness is never rolled back or restored as part of a rollback.

## 9. Health, readiness and degraded states

| Probe | Answers | Use it for |
| --- | --- | --- |
| `GET /live` | the process and its lifecycle are up | restart decisions (restart only when `/live` fails) |
| `GET /ready` | 200 when ready **and** not `unhealthy`; 503 otherwise | traffic decisions; the image health check |
| `GET /health` | the full report: `status` (`healthy` / `degraded` / `unhealthy`), `modules` (each with `required` and `health.status`), `posture`, `authoritySigner`, `authorityFreshness` | diagnosis |
| `GET /api/admin/operations/health` (observer) | the same report plus `operations`: `unresolvedExecutions`, `attentionRequired`, `scan` | operator view |

`status` is `unhealthy` when persistence is disconnected, the Host is not
ready, or any module with `"required": true` is not healthy; `degraded` when
only an optional module is impaired. In the pilot, the required modules are
`aoc.kernel`, `aoc.enterprise.governance-store`, `aoc.enterprise.providers`,
`aoc.enterprise.authority-controlled-execution`,
`aoc.enterprise.exercise-control`,
`aoc.enterprise.governed-action-orchestrator`,
`aoc.enterprise.execution-outcomes`, `aoc.enterprise.execution-resolutions`
(P12) and `aoc.enterprise.kernel-authority`. Optional: telemetry, events,
evidence bundles, the authority event stream, agent passports and assurance
(the last two can be made required in `.env`).

Inspect a degraded or failing Host with:

<!-- exec: health-inspect -->
```bash
curl -sS -w '\n/ready HTTP %{http_code}\n' http://127.0.0.1:8787/ready
curl -sS -w '\n' http://127.0.0.1:8787/health
docker compose ps
docker compose logs --no-color --tail 200 frontera authority-witness
```

| State | How it shows | Traffic? | `/ready` | Inspect | Allowed | Forbidden | Escalate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Required module unhealthy | `status: unhealthy`; a `required: true` module not `healthy` | no | 503 | `/health` modules, logs | preserve evidence; if `/live` also fails, restart; fix the named cause | routing traffic to it; editing stores | SEV-2, SEV-1 if integrity is in doubt |
| Optional module degraded | `status: degraded`; a `required: false` module not `healthy` | yes | 200 | `/health`, logs | continue; investigate | restarting in a loop to clear it | SEV-3 |
| Storage issue | `persistence.connected: false` (unhealthy); at startup `STORAGE_NOT_WRITABLE`, `STORAGE_NOT_PERSISTENT`, `STORAGE_UNAVAILABLE` | no | 503 / never ready | disk space, the volume mount, logs | fix the mount or disk; restore from backup if a store is damaged (§6) | copying or editing store files | SEV-2; SEV-1 if a store is corrupt |
| Witness unavailable after startup | `status: degraded`; `authorityFreshness.witness.state: unavailable` | yes | 200 | `docker compose ps`, `docker compose logs authority-witness` | bring the witness back (`docker compose start authority-witness`); the Host recovers by itself | resetting or re-enrolling the witness | SEV-3; SEV-2 if revocations or approvals are needed meanwhile |
| Witness freshness failure | `authorityFreshness.stores[].status` is `regressed`, `forked`, `pending-recovery` or `unbound` (unhealthy) | no | 503 | `/health`, logs | preserve evidence; stop changes | resetting the witness; restoring the witness | **SEV-1** |
| Unresolved execution (P12) | Attention lists it: `unresolved: true`, reason `EXECUTION_CLAIMED_NO_OUTCOME` or `EXECUTION_OUTCOME_UNCONFIRMED` | yes | unaffected | §10 | operator resolution (§10) | retrying, replaying or resending the action | SEV-3; SEV-2 if the real outcome cannot be established |
| Capacity reconciliation pending | a resolution answered `capacity: pending` | yes | unaffected | §11 | resubmit the identical resolution (§11) | anything else | SEV-3 |
| Startup refusal | logs `refused to start [CODE]`; container restarts and refuses again | no | never ready | the code (PILOT_DEPLOYMENT.md §16) | fix the cause, configuration check, start | editing stores; deleting volumes | SEV-2 |
| Configuration refusal | `config-check` exits 1, `RESULT: FAIL` with codes and variable names | not started | — | the named checks | fix `.env` / `governed-actions.json` and run the check again | starting anyway | none unless the cause is unclear |

A `degraded` Host is still ready and still serves existing authority. While
the witness is away, every authority mutation that must be anchored —
revocation, obligation discharge, approval verdict — is refused with nothing
written (`AUTHORITY_FRESHNESS_UNAVAILABLE`); submit that operator command
again once the witness is back. No human acceptance overrides `/ready` 503.

## 10. Operator resolution of unconfirmed executions

**Operator resolution is not a retry.** It records, durably and attributed to
you, what actually happened to a governed execution whose provider outcome
Frontera never received (the Host stopped mid-call, or the provider's answer
was unconfirmed). It calls no adapter and no provider and performs no action.
Every response says so: `"effect": "resolution-recorded-no-action-performed"`.
Frontera has no route that retries, replays, resends or re-executes a
governed action, and none may be improvised.

Who: an `organization-administrator` (permission `operations.resolve`).
Observers and responders can read and investigate.

1. **Locate** unresolved claimed executions:

   <!-- exec: resolution-list -->
   ```bash
   curl -sS -w '\n' -H "$OBSERVER" 'http://127.0.0.1:8787/api/admin/operations/attention?limit=50'
   ```

   Each entry is an execution view: `requestId`, `executionId`,
   `classification` (`claimed-no-outcome`, `claimed-outcome-unconfirmed`, or
   a trace problem), `outcome.status` (`none` or `unconfirmed`),
   `resolvable` and `capacityReconcilable`. Pages hold at most 50; follow
   `nextCursor`.
2. **Inspect all available evidence** — the execution view and its ASSURE
   trace:

   <!-- exec: resolution-inspect -->
   ```bash
   curl -sS -w '\n' -H "$OBSERVER" "http://127.0.0.1:8787/api/admin/operations/executions?requestId=$REQUEST_ID"
   curl -sS -w '\n' -H "$OBSERVER" "http://127.0.0.1:8787/api/admin/operations/traces/$REQUEST_ID?level=AUDITOR"
   ```

3. **Determine the actual outcome externally**, with the provider, using the
   execution id (`executionId`, which the kit's example adapter sends to the
   provider) and the claim time. Record how you established it in your
   change record. If you cannot establish it, do not resolve: escalate.
4. **Choose the answer**: `confirmed-completed` (the provider performed it)
   or `confirmed-not-completed` (it did not).
5. **With `confirmed-not-completed` only**, give the failure reason that
   matches what the provider told you: `PROVIDER_REJECTED`,
   `PROVIDER_UNAVAILABLE`, `PROVIDER_RESPONSE_INVALID` or `ADAPTER_ERROR`. A
   confirmed completion carries no failure reason.
6. **Attestation identity** is your credential: the Host records
   `attestedBy: operator:<operatorId>` from it. The request cannot name
   anyone else.
7. **Submit**, stating the outcome state you reviewed (`observedOutcome`:
   the view's `outcome.status`, `none` or `unconfirmed`):

   <!-- exec: resolution-submit -->
   ```bash
   curl -sS -w '\n' -X POST -H "$ADMIN" -H 'content-type: application/json' \
     -d '{"resolution":"confirmed-not-completed","failure":"PROVIDER_UNAVAILABLE","observedOutcome":"none"}' \
     "http://127.0.0.1:8787/api/admin/operations/executions/$EXECUTION_ID/resolution"
   ```

   For a completion the body is
   `{"resolution":"confirmed-completed","observedOutcome":"none"}`.
8. **Verify the durable resolution**: the response is `200` with
   `"outcome": "recorded"`, the `resolution` (`resolvedBy:
   operator-attestation`, `attestedBy`, `certainty`, `failure`,
   `resolutionDigest`) and `capacity`. The execution leaves Attention.
9. **Verify the ASSURE trace** (step 2 again): its `resolution` stage holds
   the attestation and its final state is `resolved-confirmed-completed` or
   `resolved-confirmed-not-completed`.
10. **Inspect the capacity result** — §11.

What the Host guarantees, and what each refusal means (nothing is recorded
and no action is performed on any refusal):

| Response | Meaning | What to do |
| --- | --- | --- |
| `200`, `outcome: replayed` | the identical resolution was already recorded; nothing new written | nothing |
| `409 EXECUTION_OUTCOME_ALREADY_DEFINITIVE` | the provider's definitive outcome arrived first; it wins and cannot be overwritten | nothing; the provider outcome is the record |
| `409 EXECUTION_IN_FLIGHT` | the governed path still holds the execution | wait, read the view again |
| `409 EXECUTION_RESOLUTION_BASIS_CHANGED` | the outcome is no longer the state you reviewed | review again from step 1 |
| `409 EXECUTION_ALREADY_RESOLVED` | a different resolution (or the same answer from another operator) stands | nothing; it cannot be changed. Escalate if you believe it is wrong |
| `409 EXECUTION_NOT_RESOLVABLE` | claimed but never able to reach a provider (withheld at exercise), or never claimed | nothing to resolve |
| `409 EXECUTION_RESOLUTION_AUTHORITY_MISMATCH` / `EXECUTION_RESOLUTION_NOT_AVAILABLE` | bound to another resolution authority / this Host composes none | escalate |
| `404 EXECUTION_NOT_FOUND` | no execution with that id is recorded for this organization — also the answer for a decision that never became an execution (denied, issuance withheld, approval pending, withheld before preparation) | check the id; nothing to resolve |
| `403 OPERATOR_PERMISSION_DENIED` | the credential's role lacks `operations.resolve` | use an administrator |
| `503 EXECUTION_RESOLUTION_UNAVAILABLE` | the resolution could not be recorded now | submit the same resolution again later; it is idempotent |
| `500 AUTHORITY_STATE_INTEGRITY_FAILED` | the basis is corrupt or inconsistent | **SEV-1**; preserve evidence, escalate |

Never resend the governed action itself, ask the agent to submit it again, or
call the provider to "redo" it as part of resolving.

## 11. Capacity reconciliation after a resolution

A resolution stands on its own; `capacity` reports, separately, what became
of the execution's reserved exercise capacity (P7):

| `capacity` | Meaning | Operator action |
| --- | --- | --- |
| `adjusted` | reconciled: for `confirmed-not-completed` the reservation no longer consumes capacity; for `confirmed-completed` it stays consumed | none |
| `no-reservation` | the execution held no reservation; nothing to adjust | none |
| `pending` | the ledger could not be reached; capacity stays conservatively consumed | run capacity reconciliation again (below) |
| `not-composed` | this deployment's ledger offers no reconciliation; capacity stays conservatively consumed | none possible |
| `conflict` | the ledger already holds a different resolution | escalate (SEV-2); never re-run |
| `inconsistent` | the ledger's own history contradicts the resolution; reported, never repaired | escalate (SEV-1 if integrity is in doubt) |

**Run capacity reconciliation again** — only when the execution view shows
`capacityReconcilable: true` (a `pending` result): the **same operator**
submits the **identical** resolution again (§10 step 7, same body). The Host
answers `outcome: replayed`, writes no new resolution, and re-runs only the
capacity step; `capacity` becomes `adjusted` once the ledger is reachable.
This re-runs a bookkeeping step, not the governed action: it is not a retry
and calls no adapter or provider. There is no separate route for it.

## 12. Emergency controls

An emergency stop withholds governed actions at every checkpoint before the
adapter is called (admission, grant commit, exercise, adapter selection). The
caller sees `withheld` by `emergency-control`.

- **Who:** `responder` may activate; `organization-administrator` may
  activate and release.
- **Scopes:** `global` (no value), `organization`, `actor`, `adapter`,
  `resource` (each with an exact `value`; no wildcards).
- **What it does not do:** it revokes no grant, cancels no provider call
  already under way, and rewrites no past outcome. Releasing it restores
  execution under the untouched grants. It applies to the governed-action
  path only. It is per Host, not cluster-wide.
- **Readiness:** an active stop does not change `/ready` or `/health`.

Activate, verify, release (a resource stop shown; `STOP_SCOPE` and
`STOP_VALUE` are yours):

<!-- exec: emergency-activate -->
```bash
curl -sS -w '\n' -X POST -H "$ADMIN" -H 'content-type: application/json' \
  -d "{\"scope\":\"$STOP_SCOPE\",\"value\":\"$STOP_VALUE\"}" \
  http://127.0.0.1:8787/api/admin/emergency-controls/activate
curl -sS -w '\n' -H "$OBSERVER" http://127.0.0.1:8787/api/admin/emergency-controls
```

The response is `"outcome": "activated"`; the list shows the stop under
`active`. A governed action within its scope is now withheld. For a global
stop the body is `{"scope":"global"}`.

<!-- exec: emergency-release -->
```bash
curl -sS -w '\n' -X POST -H "$ADMIN" -H 'content-type: application/json' \
  -d "{\"scope\":\"$STOP_SCOPE\",\"value\":\"$STOP_VALUE\"}" \
  http://127.0.0.1:8787/api/admin/emergency-controls/release
curl -sS -w '\n' -H "$OBSERVER" http://127.0.0.1:8787/api/admin/emergency-controls
```

The response is `"outcome": "released"`. Release is the only recovery path;
there is no reset. Activation and release are idempotent.

**Evidence:** each activation and release is a hash-chained event attributed
to `operator:<operatorId>`, logged as `enterprise.admin.authority`; every
withheld execution records `withheld` by `emergency-control` in its trace.

**After a restore**, stops declared after the backup are gone (the emergency
control store is not witness-anchored): re-activate them (§6).

## 13. Approvals

Approvals exist only when a Governance Profile in the deployment declares
`approval`; `/health` then reports `posture.approvals` as composed, and the
approval routes are served. On the kit's example configuration they are not:

<!-- exec: approvals-list -->
```bash
curl -sS -w '\n' -H "$OBSERVER" 'http://127.0.0.1:8787/api/admin/approvals?view=pending'
```

answers `404` (`No route for GET /api/admin/approvals.`) until approvals are
configured. With approvals configured it lists pending requests; the verdict
routes (`…/approve`, `…/reject`, `…/request-changes`, `…/escalate`,
`…/revoke`) and their bodies are in
`docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`.

- **Who:** `approver` and `organization-administrator` approve;
  `responder`, `approver` and `organization-administrator` reject, request
  changes, escalate or revoke. The role is not enough on its own: the
  operator must also hold a live authority grant for the profile's approver
  action over the request's resource (`APPROVAL_APPROVER_INELIGIBLE`
  otherwise).
- **Approval does not bypass anything.** After approval, the emergency
  controls, the grant terms, the obligations and the exercise limits are all
  evaluated again. The decision stays `approval_required`; an approval is not
  an execution — the original requester submits its governed action again
  with the **same idempotency key**, which resumes that one decision and
  never creates a second action.
- **Expiry:** verdicts are accepted only before the request expires, and an
  approval is usable only within its validity window
  (`APPROVAL_REQUEST_EXPIRED`, `APPROVAL_EXPIRED`); a stale subject digest is
  refused (`APPROVAL_SUBJECT_MISMATCH`). Nothing extends a grant.
- **Witness:** approval verdicts are witness-anchored; while the witness is
  unavailable they are refused with nothing written.
- **Evidence:** each verdict is a signed, digest-chained record attributed to
  the operator, and appears in the request's trace.

## 14. Credential operations

| Credential | Where | Supported rotation | Restart | Changes trust identity | Invalidates prior verification | Coordinated update |
| --- | --- | --- | --- | --- | --- | --- |
| Operator / administrator credential (`apiKeyEnv`) | `.env` | **yes**: generate a new value (`docker compose run --rm -T witness-init --secrets-only --secret NAME`), replace the variable in `.env`, configuration check, `docker compose up -d` | yes (recreate) | no — the recorded identity is `operator:<operatorId>`, not the credential | no | hand the new value to the operator; the old one stops working at restart |
| Agent credential | issued through the operator plane | **yes**: `POST /api/admin/agents/{actorId}/credentials/{credentialId}/rotate` (or `/revoke`) | no | no | no | hand the one-time value to the agent's owner |
| Provider credential (`tokenEnv` / `valueEnv`) | `.env` | **yes**: replace the value issued by your provider, configuration check, `docker compose up -d` | yes (recreate) | no | no | with the provider; never generated by Frontera |
| Authority signing key | `.env` (`…_SIGNING_KEY_PEM`, `…_KEY_ID`, `…_VERIFICATION_KEYS`) | **no supported procedure in the pilot.** The Host can verify artifacts under retired keys kept in `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`, but the kit provides no tool to generate a successor key, and the generator refuses to run twice | — | yes | removing a key that signed live state makes that state unreadable | escalate to Frontera before any change |
| Witness credential (`…_FRESHNESS_TOKEN`) | `.env` (the witness receives it from there) | **no supported procedure in the pilot** | — | — | — | escalate |
| Witness receipt key | `frontera-witness` volume; public half pinned in `.env` | **no supported procedure in the pilot**; a new key breaks trust in the existing anchors | — | yes | yes | escalate |

Never run `witness-init` without `--secrets-only` on an initialized
deployment: it refuses, because a new authority or witness key would break
trust in everything the current ones signed.

## 15. Authority key custody

The qualified kit uses **software custody**: the authority private key is in
`deploy/pilot/.env` (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`) and in the
Host process's memory. External custody
(`AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external`) is supported by the Host
but is not part of the qualified pilot kit.

- **The risk:** anyone who can read `.env`, the Host container's environment
  or the Host process can sign authority that verifies perfectly (finding
  AA-001, rated high for software custody).
- **Protect:** `.env` at mode `600`, owned by the deploying user; the machine
  account and Docker access (anyone in the `docker` group can read a
  container's environment); your secret manager's copy.
- **Back up** the key only in your secret manager, never in a data backup:
  `backup:v1` never reads it, and the witness archive does not contain it.
- **Never** copy the private key, `.env`, `docker inspect` output or
  `docker compose config` output into a ticket, chat, log or evidence pack.
  The public verification keys and the key id are not secret.
- A suspected exposure of the key is a SEV-1 incident
  ([`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md)).

## 16. Witness operations

- **Bundled reference witness:** the `authority-witness` service (Compose
  profile `reference-witness`), reachable by the Host over loopback only. It
  is a reference implementation, not an HSM, ledger or timestamping
  authority.
- **External witness:** pointing the Host at your own `https://` witness is a
  Host feature but not part of the qualified kit (PILOT_DEPLOYMENT.md §1).
- **At startup** the Host does not start without its witness
  (`AUTHORITY_FRESHNESS_UNAVAILABLE`); Compose starts the Host only after the
  witness is healthy.
- **At runtime** losing the witness makes the Host `degraded` but ready (§9):
  existing authority keeps being served, and anchored mutations are refused
  with nothing written until it returns.
- **Persistence:** `witness.sqlite` and the receipt key pair live on the
  `frontera-witness` volume — a separate restore domain from the Host's
  state.
- **Backup:** a separate set and schedule (§5.4). Restoring it is
  escalation-only: never together with, or to match, a Host backup.
- **Identity:** the Host pins the witness id and its public receipt key from
  `.env`; trust is never learned from the witness. A different witness, or a
  witness with a new key, is refused.
- **Never** reset the witness database, re-enroll it, or restore it to make
  an older Host backup start. That is exactly the rollback the witness exists
  to detect.
