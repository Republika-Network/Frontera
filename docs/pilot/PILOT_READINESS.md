# Pilot Readiness and Go-Live (PROD-03-04)

The one canonical pre-go-live checklist, the go-live decision, and the
handoff checklist. A pilot is not ready until every **REQUIRED** item is
satisfied. Record the result (who checked, when, how) in the acceptance
evidence pack ([`PILOT_ACCEPTANCE.md`](PILOT_ACCEPTANCE.md) §3).

## 1. Readiness checklist

### Platform

- [ ] **REQUIRED** Linux x86_64 or arm64 host, patched, with a named owner.
- [ ] **REQUIRED** Docker Engine and Docker Compose 2.20 or later (`docker compose version`).
- [ ] **REQUIRED** Disk for both volumes on a local disk or block volume (not NFS/SMB), with headroom for the stores' growth and for local backup staging; disk usage monitored.
- [ ] **REQUIRED** The `frontera-state` and `frontera-witness` volumes exist (OPERATIONS_RUNBOOK.md §2 step 5).
- [ ] **REQUIRED** Host clock synchronized (NTP or equivalent): grants, approvals and traces carry timestamps and validity windows.
- [ ] **REQUIRED** The reverse proxy / TLS boundary is in place and understood: the Host speaks plain HTTP on `127.0.0.1:8787` (or a private interface) and is never published on a public interface without the proxy (PILOT_DEPLOYMENT.md §15).

### Configuration

- [ ] **REQUIRED** `deploy/pilot/.env` prepared from `.env.example`, mode `600`, with no `<required…>` placeholder left.
- [ ] **REQUIRED** `governed-actions.json` finalized: the provider origin, routes, mapping and operators are the approved ones.
- [ ] **REQUIRED** `AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID` is the pilot organization's id.
- [ ] **REQUIRED** Operators defined, one per person or function, each with the least role that fits; at least one `organization-administrator` and one `observer`.
- [ ] **REQUIRED** Authority configured: the generator ran exactly once; signing key, key id and verification set present.
- [ ] **REQUIRED** Witness configured: the bundled witness (`COMPOSE_PROFILES=reference-witness`) with its generated id, credential and pinned public key.
- [ ] **REQUIRED** Provider credential configured: issued by the provider, single-quoted in `.env`.
- [ ] **REQUIRED** `docker compose run --rm config-check` prints `RESULT: PASS` and exits 0.

### Security

- [ ] **REQUIRED** No secret in Git: `.env` is untracked (`git status` does not list it) and `governed-actions.json` holds variable names only.
- [ ] **REQUIRED** Provider credentials come from the provider, never from the Frontera generator.
- [ ] **REQUIRED** Authority key custody understood and accepted: software custody, its risk and who can read `.env` and the container (OPERATIONS_RUNBOOK.md §15).
- [ ] **REQUIRED** Operator credentials distributed to their holders through a secure channel, never by email or chat in clear.
- [ ] **REQUIRED** Administrative access restricted: who can log in to the machine, who is in the `docker` group, who can reach `/api/admin/...` at the proxy.
- [ ] **REQUIRED** The Host port is not exposed publicly without the TLS/proxy boundary.
- [ ] **REQUIRED** Backup storage access restricted to the backup owner (backups are checksummed, not encrypted).

### Runtime

- [ ] **REQUIRED** `/live` answers 200.
- [ ] **REQUIRED** `/ready` answers 200.
- [ ] **REQUIRED** `/health` read and understood: `status`, which modules are required, the witness state (OPERATIONS_RUNBOOK.md §9).
- [ ] **REQUIRED** `/version` shows the release being installed: the approved `commit`, `build: release`.
- [ ] **REQUIRED** Every module with `"required": true` is `healthy`, including `aoc.enterprise.execution-resolutions` (P12 is required).
- [ ] **REQUIRED** No unexpected degradation: `status` is `healthy`, or every degraded module is optional and explicitly accepted (§2).

### Durability

- [ ] **REQUIRED** All expected persistent stores present: the configuration check reports every composed store at a supported schema.
- [ ] **REQUIRED** A backup was created and verified (OPERATIONS_RUNBOOK.md §5).
- [ ] **REQUIRED** The restore procedure was tested on this deployment or an identical one (OPERATIONS_RUNBOOK.md §6), and the Host came back ready with its records.
- [ ] **REQUIRED** A restart preserves state (OPERATIONS_RUNBOOK.md §4 verification).
- [ ] **REQUIRED** The witness volume has its own backup schedule and storage (OPERATIONS_RUNBOOK.md §5.4).

### Operations

- [ ] **REQUIRED** An operator can read operational state (`/api/admin/operations/metrics`, `…/executions`, `…/health`).
- [ ] **REQUIRED** Operators understand Attention and unresolved executions (OPERATIONS_RUNBOOK.md §10).
- [ ] **REQUIRED** An administrator can perform a supported resolution and knows the refusals.
- [ ] **REQUIRED** Every operator knows the rule: **no retry, replay or resend** of a governed action, by anyone, for any reason.
- [ ] **REQUIRED** Emergency controls understood: who activates, who releases, what a stop does and does not do (OPERATIONS_RUNBOOK.md §12).
- [ ] **REQUIRED** Incident triage, severity and escalation agreed (INCIDENT_TRIAGE.md).

### Acceptance

- [ ] **REQUIRED** The acceptance qualification passed for the release (PILOT_ACCEPTANCE.md §4).
- [ ] **REQUIRED** The acceptance evidence pack is stored.
- [ ] **REQUIRED** The known limitations are acknowledged (README.md §"Known limits of the pilot").
- [ ] **REQUIRED** The shared-responsibility matrix is accepted, with a name for every pilot-side row.

## 2. Go-live gate

The go-live decision is a checklist result, recorded by the pilot owner. It
is not a Host state and no API reports it.

| Decision | Condition |
| --- | --- |
| **READY** | every REQUIRED item is satisfied and `/health` is `healthy` |
| **READY WITH ACCEPTED DEGRADATION** | every REQUIRED item is satisfied except that `/health` is `degraded` **only** because of modules with `"required": false` (or the witness after startup, which degrades but keeps readiness), `/ready` is 200, and the pilot owner has accepted that specific degradation in writing, naming the module and the reason |
| **NOT READY** | any other case: a required module unhealthy, `/ready` not 200, storage not durable, authority or witness not configured, the configuration check failing, release identity unknown or not the approved one, backup or restore never tested, any REQUIRED item open |

Human acceptance never overrides a failed `/ready`, an unhealthy required
module, a failing configuration check or an unidentified release. Those are
always **NOT READY**.

## 3. Go-live record

Record, in the evidence pack: the decision, the date (UTC), the pilot owner
who made it, the `/version` `release` and `commit`, the evidence bundle
captured at go-live (INCIDENT_TRIAGE.md §3), and any accepted degradation.

## 4. Handoff checklist

Completed when the deployment is handed to the organization that will
operate it.

- [ ] The deployment guide delivered: `docs/deployment/PILOT_DEPLOYMENT.md`.
- [ ] The runbooks delivered: this directory (`docs/pilot/`).
- [ ] The release identified: `release` and `commit` from `/version`, matching the approved release.
- [ ] The shared-responsibility matrix reviewed and accepted, with a named owner per row.
- [ ] Operator and administrator access created; each holder has received their credential securely and confirmed it with `GET /api/admin/organization`.
- [ ] Secrets transferred securely into the pilot's secret source; no copy left on laptops, tickets or chat.
- [ ] Backup owner assigned, schedule and storage agreed for both backup sets.
- [ ] Incident contact defined on both sides, with the escalation channel and the SEV-1 / SEV-2 response expectations.
- [ ] Upgrade owner defined, and how releases are approved.
- [ ] Known limitations reviewed with the pilot owner.
- [ ] Acceptance evidence archived where both parties can retrieve it.
