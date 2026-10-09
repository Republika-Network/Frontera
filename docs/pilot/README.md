# Frontera Pilot Operations (PROD-03-04)

The entry point for an organization that runs a Frontera pilot: who owns
what, what must be true before go-live, how the Host is operated day to day,
what to do when something is wrong, and what proves the pilot is accepted.

Frontera is a governed-action boundary. It decides whether a machine action
may proceed (deny, withhold, require approval, grant), records the claim, the
provider outcome or an operator's resolution, and keeps durable evidence of
all of it. Nothing in these documents changes that model; every procedure
here preserves it.

## Where to go

| When | Read |
| --- | --- |
| Before deployment | [`docs/deployment/PILOT_DEPLOYMENT.md`](../deployment/PILOT_DEPLOYMENT.md) — the PROD-03-03 kit: build, configure, first start, configuration contract |
| Before go-live | [`PILOT_READINESS.md`](PILOT_READINESS.md) — readiness checklist, go-live gate, handoff checklist |
| Agreeing who does what | [`SHARED_RESPONSIBILITY.md`](SHARED_RESPONSIBILITY.md) — the shared-responsibility matrix |
| During operations | [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) — startup, shutdown, restart, backup, restore, upgrade, rollback, degraded states, operator resolution, emergency controls, approvals, credentials, witness |
| If something is wrong | [`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md) — severity, triage matrix, evidence preservation, escalation |
| Before acceptance | [`PILOT_ACCEPTANCE.md`](PILOT_ACCEPTANCE.md) — acceptance criteria A1–A17, evidence pack, acceptance status, qualification |

## The supported pilot operating model

One topology is supported: the PROD-03-03 Compose kit (`deploy/pilot/`) on a
Linux host, one Frontera Host in the secure `production` profile, its state on
the `frontera-state` volume, and the bundled reference authority-state witness
on the separate `frontera-witness` volume.

| The pilot organization runs | Frontera provides |
| --- | --- |
| A Linux x86_64 or arm64 host | The Host runtime (one OCI image built from the release) |
| Docker Engine and Compose 2.20 or later | The governance engine: authority, scope, limits, approvals, obligations, emergency controls |
| The Frontera image and kit, built from an approved release | The durable state model (SQLite stores, schema versions, signed and witness-anchored authority state) |
| Persistent local volumes (not NFS/SMB) | Liveness, readiness and health (`/live`, `/ready`, `/health`) |
| TLS termination and the reverse proxy | Release identity (`/version`) |
| DNS, firewalling, network exposure | Configuration validation (`config-check`, the launcher's preflight) |
| Secret storage and injection into `deploy/pilot/.env` | The operator plane: operational state, Attention, ASSURE traces, operator resolution |
| Scheduling, storing and protecting backups; running restores | Backup and restore tooling (`backup:v1` / `restore:v1`) and their integrity checks |
| Infrastructure monitoring and log retention | Structured logs (`enterprise.host.*`) |
| The governed-action policy it configures, and its operators | Deployment and acceptance qualification, evidence and trace semantics |

The full matrix, row by row, is [`SHARED_RESPONSIBILITY.md`](SHARED_RESPONSIBILITY.md).

## Rules that hold everywhere in these documents

1. **No governed action is ever retried, replayed or resent by an operator.**
   Frontera has no route that re-executes anything. Operator resolution
   records what happened; it performs nothing.
2. **Durable state is never edited by hand.** No `sqlite3`, no `UPDATE`, no
   `DELETE`, no copying store files while the Host runs. The supported tools are
   the Host itself, its operator plane, `backup:v1` and `restore:v1`.
3. **`docker compose down -v` is never part of operating a pilot.** It deletes
   both volumes: all Host state and the witness.
4. **The witness is never reset, re-enrolled or restored together with the
   Host's stores.** Doing so would make an old authority state look current.
5. **Evidence is preserved before any destructive remediation**
   ([`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md) §3).
6. **A failed `/ready` cannot be accepted away.** No human sign-off overrides
   it ([`PILOT_READINESS.md`](PILOT_READINESS.md) §2).
7. **No secret goes into a ticket, a log, a chat or an evidence pack.**

## Known limits of the pilot

These are intentionally unsupported in the pilot and are acknowledged as part
of acceptance (A17):

- Only the Docker Compose kit is supported: no Kubernetes, Helm, serverless or
  cloud-provider-specific deployment. The kit is cloud-neutral.
- One Host process per state volume: no replicas, no rolling upgrade, no
  high availability. RPO is the backup interval; there is no point-in-time
  recovery.
- No store schema downgrade. Rollback across a schema change means the
  previous release plus a backup taken with it.
- No automatic retry, replay or resend of governed actions, and none by hand.
- The authority signing key is in software custody (in the Host process).
  External custody and an external witness are Host features, not part of the
  qualified kit.
- The bundled witness is a reference witness, not an HSM, ledger or
  timestamping authority.
- Rotation of the authority signing key, the witness credential and the
  witness receipt key has no supported procedure in the pilot
  ([`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) §14).
- The CTRL-03 web console is not in the pilot image; the operator plane is the
  HTTP API under `/api/admin/...`.
- No payment rail is part of the pilot. Frontera governs the configured
  Generic HTTP actions only.
- Frontera provides no monitoring stack, alerting, log shipping, ticketing or
  support platform; those are the pilot organization's infrastructure.

## Reference documents

- Host internals and refusal codes: `docs/enterprise/AOC_ENTERPRISE_HOST.md`
- Operator plane API: `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`
- HTTP surface: `docs/enterprise/API_STABILITY_V1.md`
- Emergency controls: `docs/enterprise/AOC_EMERGENCY_CONTROL.md`
- Backup and restore tooling: `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`,
  `docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`,
  `docs/operations/BACKUP_RECOVERY_V1.md`
- Operator resolution design:
  `docs/architecture/ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md`

`docs/operations/RUNBOOKS_V1.md` and `docs/operations/DEPLOYMENT_GUIDE_V1.md`
describe a host-process (non-container) deployment. For the pilot, the
documents in this directory and the PROD-03-03 guide take precedence; the
older runbooks remain the reference for the recovery semantics they describe
(witness transitions, control-plane residuals after a restore).
