# Pilot Incident Triage (PROD-03-04)

What to do when a Frontera pilot misbehaves: classify, preserve evidence,
act within what is allowed, escalate. Conventions and the operator session are
those of [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) §1; the blocks
marked as executed are run by the pilot acceptance qualification.

The first rule: **preserve evidence before any destructive remediation**
(§3). The second: **nothing in an incident justifies retrying, replaying or
resending a governed action, editing a store, deleting a volume, or
resetting the witness.**

## 1. Severity

| Severity | Meaning | Examples | Response |
| --- | --- | --- | --- |
| **SEV-1** | governed actions may be unsafe, or the integrity of authority or evidence is uncertain | witness freshness failure (`regressed`, `forked`, `pending-recovery`), a lost witness volume, `AUTHORITY_FRESHNESS_FORK_DETECTED`, `AUTHORITY_STATE_INTEGRITY_FAILED`, `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED` you cannot explain, a corrupt store, suspected exposure of the authority key or an operator credential, capacity `inconsistent` | activate an emergency stop if actions must not proceed; preserve evidence; escalate to Frontera immediately |
| **SEV-2** | a required capability is unavailable, integrity is preserved | `/ready` 503, startup refusal, failed upgrade or restore, a governed provider unavailable for all actions, an execution whose real outcome cannot be established | preserve evidence; work the runbook; escalate if not restored within the pilot's agreed time |
| **SEV-3** | optional or degraded capability; the boundary still holds | `/health` degraded by an optional module or the witness, an unresolved execution with a known outcome, capacity `pending` | handle with the runbook in working hours |

Severity is the pilot organization's call; when two classes fit, take the
higher one.

## 2. Triage matrix

Causes are listed as likely classes, not certainties: several symptoms have
more than one cause, and the logs decide.

| Symptom | Likely class | Immediate action | Forbidden | Escalate? |
| --- | --- | --- | --- | --- |
| `/live` fails | process down, crashing or not started | §3 evidence; `docker compose ps`, `docker compose logs frontera`; Compose restarts it (`restart: unless-stopped`); if it stays down, start with OPERATIONS_RUNBOOK.md §2 | `down -v`; editing stores | SEV-2 if not recovered by a start |
| `/ready` 503 | startup refusal, required module unhealthy, storage or witness freshness failure | §3 evidence; OPERATIONS_RUNBOOK.md §9 inspection; read `status` and modules | routing traffic to it; repeated restarts to "clear" it | SEV-2; SEV-1 if freshness or integrity |
| `/health` `degraded` | optional module impaired, or witness unavailable after startup | OPERATIONS_RUNBOOK.md §9; bring back the witness if it is that | restarting the Host to clear it | SEV-3 |
| Configuration check fails | placeholder, invalid variable, missing secret, storage or schema problem | read the named codes and variables; fix; run the check again (PILOT_DEPLOYMENT.md §16) | starting anyway; pasting `.env` into a ticket | only if the code is unclear |
| Storage unwritable / unavailable (`STORAGE_NOT_WRITABLE`, `STORAGE_NOT_PERSISTENT`, `STORAGE_UNAVAILABLE`) | volume missing, read-only, disk full, damaged store | §3 evidence; check the mount and disk; restore from backup only if a store is damaged (OPERATIONS_RUNBOOK.md §6) | `sqlite3` repairs; copying files in or out of the volume | SEV-2; SEV-1 if a store is corrupt |
| `SCHEMA_INCOMPATIBLE` | stores from another release (wrong image, or a downgrade attempt) | stop; confirm the image (`docker image inspect`, `/version` of the intended release); follow the upgrade or rollback runbook | forcing an older image onto migrated stores | SEV-2 |
| Witness unavailable | witness stopped or failing | `docker compose ps`, `docker compose logs authority-witness`; `docker compose start authority-witness` | resetting, re-enrolling or restoring the witness | SEV-3; SEV-1 for a freshness failure |
| Witness volume lost or damaged | disk or volume failure, accidental deletion | stop changes (emergency stop if actions must not proceed); §3 evidence | restoring a witness copy without the escalation's decision; resetting or re-enrolling the witness; rolling Host stores back to match it | **SEV-1** |
| Provider unavailable | the provider or the network to it is down; actions fail or end unconfirmed | check the provider out of band; consider an emergency stop on the `adapter` scope if failures must stop | resending actions to the provider by hand | SEV-2 if all actions fail |
| Unresolved execution in Attention | the Host stopped mid-call, or the provider's answer was unconfirmed | OPERATIONS_RUNBOOK.md §10 | retrying, replaying or resending the action | SEV-3; SEV-2 if the outcome cannot be established |
| Capacity reconciliation warning (`pending`, `conflict`, `inconsistent`) | ledger unreachable, or contradictory ledger history | OPERATIONS_RUNBOOK.md §11 | anything but resubmitting the identical resolution for `pending` | `conflict` SEV-2; `inconsistent` SEV-1 |
| Operator authentication failure (`401 AUTHENTICATION_FAILED`, `403 OPERATOR_PERMISSION_DENIED`) | wrong or rotated credential, wrong role, Host not ready (`503 ENTERPRISE_NOT_READY`) | check `GET /api/admin/organization` with a known-good credential; check the credential's role | sharing credentials between operators | only if a credential may be compromised (then SEV-1) |
| Release identity mismatch (`/version` ≠ approved release, `build: development`, `RELEASE_IDENTITY_INVALID`) | wrong image or a build without `FRONTERA_BUILD_COMMIT` | stop the change; rebuild from the approved release | running an unidentified build in the pilot | SEV-2 |
| Secret exposure suspicion | `.env`, a credential or the authority key seen where it must not be | contain the exposure; rotate what has a supported rotation (OPERATIONS_RUNBOOK.md §14); preserve evidence without copying the secret | posting the secret to confirm it; deleting logs before preserving evidence | SEV-1 for the authority key, witness material or an administrator credential |
| Failed upgrade | config check refusal, refusal to start, wrong `/version` after upgrade | OPERATIONS_RUNBOOK.md §7 stop conditions, then §8 | starting the old image on migrated stores | SEV-2 |
| Failed restore | `restore:v1` refusal, freshness refusal after restore, `.restore-in-progress` marker | read the refusal; the volume is unchanged on a refusal; OPERATIONS_RUNBOOK.md §6 table | resetting the witness; `--allow-incomplete` outside forensics; starting on a marked volume | SEV-2; SEV-1 for `PENDING_RECOVERY` |

## 3. Evidence preservation

Operational incidents preserve evidence **before** any destructive
remediation: before a restore, a rollback, removing a container, replacing a
volume or rotating a credential.

Capture the evidence bundle (the Host may be degraded or down; every command
still runs, and failures are part of the evidence):

<!-- exec: evidence-capture -->
```bash
EVIDENCE_DIR="frontera-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
curl -sS -o "$EVIDENCE_DIR/version.json" http://127.0.0.1:8787/version
curl -sS -o "$EVIDENCE_DIR/live.json" http://127.0.0.1:8787/live
curl -sS -o "$EVIDENCE_DIR/ready.json" http://127.0.0.1:8787/ready
curl -sS -o "$EVIDENCE_DIR/health.json" http://127.0.0.1:8787/health
curl -sS -o "$EVIDENCE_DIR/operations-health.json" -H "$OBSERVER" http://127.0.0.1:8787/api/admin/operations/health
curl -sS -o "$EVIDENCE_DIR/attention.json" -H "$OBSERVER" 'http://127.0.0.1:8787/api/admin/operations/attention?limit=50'
docker compose ps -a > "$EVIDENCE_DIR/compose-ps.txt"
docker compose logs --no-color --timestamps > "$EVIDENCE_DIR/compose-logs.txt"
docker compose run --rm config-check > "$EVIDENCE_DIR/config-check.txt" 2>&1
```

Then add, by hand, to the same record:

- the relevant `requestId` and `executionId`, and each one's ASSURE trace
  (`GET /api/admin/operations/traces/{requestId}?level=AUDITOR`, saved to a
  file);
- timestamps (UTC) of when the symptom started and of every action taken;
- the `backupId` of the latest good backup, and of any backup taken during the
  incident;
- the release (`version.json` holds `release` and `commit`).

None of these outputs contains a secret: the Host never returns or logs a
credential, the configuration check prints names and codes but never values,
and this is checked by the deployment and acceptance qualifications. **Never**
add `.env`, `docker inspect` or `docker compose config` output, a credential
or a key to the evidence. Store the bundle with the pilot's incident record,
with the same access control as backups.

## 4. Escalation

Escalate to the Frontera contact agreed at handoff
([`PILOT_READINESS.md`](PILOT_READINESS.md) §4) when:

- the incident is SEV-1, immediately;
- a SEV-2 is not restored within the time the pilot agreed;
- a runbook step refuses with a code this documentation does not explain;
- a procedure would require editing a store, resetting the witness, or any
  action this documentation forbids — stop and escalate instead.

Escalate with the evidence bundle and the timeline; never with secrets. The
pilot organization owns its own internal escalation and communication.
