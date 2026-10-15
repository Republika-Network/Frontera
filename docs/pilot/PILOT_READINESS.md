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
- [ ] **REQUIRED** The readiness gate reports `pilot-ready` for the release, and its qualification record is stored (§5).
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

## 5. The readiness gate (PROD-03)

The checklist above is the human decision. The **readiness gate** is the
machine-checkable part of it: one command that evaluates a closed list of
checks against the running deployment and says, deterministically, how far the
deployment has got. It is read-only — HTTP `GET` to routes the Host already
serves, the same preflight as `config-check`, and the files it is given — and
it never prints a credential. Run it as the kit's tool (OPERATIONS_RUNBOOK.md
§9.1), or outside the kit as `npm run pilot:readiness -- …` in the Host's
environment.

### 5.1 Levels

Three cumulative levels, never one boolean:

| Result | Means |
| --- | --- |
| `deployment-ready` | the Host is safe to accept governed executions: identified release, secure configuration and posture, durable intact storage, witness and signer healthy, live, ready and healthy, no global or organization stop, diagnostics answering, no integrity or freshness failure |
| `organization-ready` | … and the organization is bootstrapped, a verified organization administrator exists, the required profiles are active, the approval path (when configured) and activity and evidence are readable |
| `pilot-ready` | … and **one and the same** agent holds an active identity, an active credential and bounded standing authority, a cold backup of this deployment and release exists that covers every store PROD-02's registry requires of this deployment, a restore of it is qualified, the **pilot owner's** acknowledgement exists for this release, and a verified operator can revoke and stop |
| `not-ready` | the deployment level fails |

A check that cannot be evaluated fails: an unreachable Host, an unreadable
answer, a missing preflight (`PREFLIGHT_NOT_EVALUATED`) are never "unknown but
fine". Optional features are not checked into readiness: approvals are
`not-applicable` when no profile declares them (unless `--require-approvals`),
and a degraded optional module passes only when named with
`--accept-degraded <module>`. The gate never overrides `/ready`: a Host that
is not ready fails `PR-06`.

Readiness and individual authority are different things. Revoking an agent's
authority leaves the deployment and organization levels unchanged; only the
pilot level reports that no agent holds authority (`PR-11`).

`PR-10` and `PR-11` are about the same agents: those whose identity and
credential are both active — the agents that can authenticate a governed
request today. `PR-11` needs one of **them** to hold active standing
authority. Authority held by an agent whose credential (or identity) is
revoked never stands in for it: a credential on one agent and authority on
another is `NO_STANDING_AUTHORITY`, because no agent can submit an authorized
request. In the other direction the check is broad and fails closed: an
unbounded active lineage on **any** agent whose identity is active —
credential or not — is `AUTHORITY_UNBOUNDED`, since that agent is one
credential issuance away from acting.

### 5.2 Checklist

| Check | Level | Evaluates | Fails with (examples) |
| --- | --- | --- | --- |
| PR-01 release-identity | deployment | `/version`: a `release` build with a full commit (and `--expect-commit`) | `RELEASE_NOT_IDENTIFIED`, `RELEASE_COMMIT_MISMATCH` |
| PR-02 secure-configuration | deployment | the preflight's release, placeholder and configuration checks, and the composed secure posture in `/health` | `PREFLIGHT_NOT_EVALUATED`, `CONFIG_PLACEHOLDER_VALUE`, `POSTURE_NOT_SECURE` |
| PR-03 data-directories | deployment | the preflight's storage check (writable, persistent, intact, supported schema) | `STORAGE_NOT_WRITABLE`, `STORAGE_UNAVAILABLE`, `SCHEMA_INCOMPATIBLE` |
| PR-04 freshness-witness | deployment | `/health` `authorityFreshness`: the witness ready, every anchored store ready | `WITNESS_UNAVAILABLE`, `FRESHNESS_REGRESSED` |
| PR-05 authority-signer | deployment | `/health` `authoritySigner` ready (and external, with `--require-external-custody`) | `SIGNER_UNAVAILABLE`, `SIGNER_SOFTWARE_CUSTODY_NOT_ACCEPTED` |
| PR-06 host-ready | deployment | `/live` 200, `/ready` 200, `/health` healthy (or degraded only by accepted optional modules) | `HOST_NOT_READY`, `HEALTH_DEGRADED` |
| PR-07 organization | organization | the organization view; an active trust domain and root issuer | `ORGANIZATION_NOT_BOOTSTRAPPED` |
| PR-08 operators | organization | every given operator credential authenticates; one is an organization administrator | `ADMINISTRATOR_NOT_VERIFIED`, `OPERATOR_CREDENTIAL_INVALID` |
| PR-09 governance-profile | organization | each `--require-profile` (or at least one profile) has an active version | `PROFILE_NOT_ACTIVE` |
| PR-10 pilot-agent | pilot | an agent whose identity and credential are both active | `NO_PILOT_AGENT` |
| PR-11 bounded-authority | pilot | one of **those** agents holds active standing authority; every active lineage of every identity-active agent carries P10 constraints or typed bounds | `NO_STANDING_AUTHORITY`, `AUTHORITY_UNBOUNDED` |
| PR-12 approval-path | organization | the approval inbox readable, when approvals are composed | `APPROVALS_NOT_CONFIGURED`, `APPROVAL_INBOX_UNREADABLE` |
| PR-13 emergency-controls | deployment | the stop list readable; no `global` or `organization` stop active (narrower stops are reported, not blocking) | `EMERGENCY_STOP_ACTIVE` |
| PR-14 activity-evidence | organization | activity, metrics and the latest decision's trace readable | `ACTIVITY_UNREADABLE`, `EVIDENCE_UNREADABLE` |
| PR-15 backup | pilot | `--backup <set>` (§5.6): the store inventory and coverage judged by PROD-02's own validators against **this** deployment's store requirements (needs `--preflight`), never by the manifest's `complete` flag; exactly the declared store files, each matching the manifest's checksum and a `checksums.sha256` entry; this organization, cold, no secret flag and no held credential in any file, this release, younger than `--backup-max-age-hours` (default 168) | `BACKUP_INCOMPLETE`, `BACKUP_COVERAGE_NOT_VERIFIABLE`, `BACKUP_MANIFEST_INVALID`, `BACKUP_STORE_FILE_MISSING`, `BACKUP_CHECKSUM_MISSING`, `BACKUP_CHECKSUM_MISMATCH`, `BACKUP_UNEXPECTED_FILE`, `BACKUP_STALE`, `BACKUP_CONTAINS_CREDENTIAL` |
| PR-16 restore-drill | pilot | `--restore-report <file>`: a completed, verified, complete `restore:v1` of **that** backup | `RESTORE_OF_ANOTHER_BACKUP`, `RESTORE_DRILL_NOT_EVIDENCED` |
| PR-17 diagnostics | deployment | the operator health view answers with its operations section | `DIAGNOSTICS_UNREADABLE` |
| PR-18 acknowledgement | pilot | `--acknowledgement <file>` (§5.4) by the **pilot owner**, for this organization and release | `ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER`, `ACKNOWLEDGEMENT_STALE`, `ACKNOWLEDGEMENT_INCOMPLETE` |
| PR-19 revocation-path | pilot | a verified operator holds `authority.revoke`, `agent-credential.revoke` and `emergency.stop` | `REVOCATION_PATH_NOT_OPERABLE` |
| PR-20 integrity-freshness | deployment | persistence connected; no required module unhealthy; no anchored store regressed, forked, pending recovery or unbound | `REQUIRED_MODULE_UNHEALTHY`, `FRESHNESS_FORKED` |

Every failing line names its remediation section. `--json` prints the full
report (`frontera.pilot-readiness.v1`): each check's id, status, bounded reason
token and remediation reference, the release, the organization and the
deployment fingerprint — no secret, no stack. Exit status: 0 when the level
named by `--require` (default `pilot`) is reached, 1 when it is not, 2 on a
usage error. `--diagnose` evaluates the same checks and requires only the
deployment level: it is the read-only diagnostic of INCIDENT_TRIAGE.md §2.

### 5.3 The qualification record

The backup, the restore drill and the acknowledgement are historical facts:
the gate verifies them when it is given the files (`PR-15`, `PR-16`,
`PR-18`). `--write-record <file>` writes, mode 600, a
`frontera.pilot-qualification-record.v1`: the result, every check's status,
the evidence digests (backup id and manifest digest, restore report digest,
acknowledgement digest) and the **deployment fingerprint** — organization,
release (version, commit, build), configuration checksum, posture digest,
signer custody and key id, witness id, the active profile versions and
digests, and, with `--preflight`, the governed-action file's digest and the
time of the last restore into the state directory. A later run given
`--record <file>` accepts the record for those three checks **only** while the
fingerprint is identical and the record has not expired (`--record-validity-days`,
default 30, at most 90).

Any material change invalidates it, and the gate names what changed
(`RECORD_INVALIDATED`): a new release, a configuration change (an operator
added or removed, a secret rotated, the file edited), a signer custody or key
change, a different witness, a profile promoted or replaced, a restore. Then
run the gate again with fresh evidence.

The record is **operational evidence, not authority**: it issues nothing,
satisfies no live check (a record cannot make an unavailable witness ready),
clears no stop and is not signed — it is protected only by the access control
of the directory that holds it. Keep it with the acceptance evidence pack.

### 5.4 The acknowledgement

The human part of readiness, in a file the gate checks for form and binding
(it cannot check that a person meant it):

```json
{
  "schema": "frontera.pilot-acknowledgement.v1",
  "organizationId": "<AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID>",
  "release": { "commit": "<the /version commit acknowledged>" },
  "documents": ["shared-responsibility", "security-posture", "known-limits"],
  "acknowledgedBy": [{ "name": "<pilot owner>", "role": "pilot-owner", "acknowledgedAt": "<UTC timestamp>" }]
}
```

`shared-responsibility` is SHARED_RESPONSIBILITY.md, `security-posture` is
SECURITY_POSTURE.md (including the software-custody acceptance of its §4), and
`known-limits` is README.md §"Known limits of the pilot". An acknowledgement
names one release: a new release needs a new one.

Only the **pilot owner's** entry satisfies `PR-18`: at least one entry must
have `"role": "pilot-owner"`, a name and a valid `acknowledgedAt`; others may
co-sign, and their entries are recorded but never sufficient
(`ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER`). `pilot-owner` is an operational role —
the person accountable for the pilot on the organization's side
(SHARED_RESPONSIBILITY.md) — not an operator-plane role: holding
`organization-administrator`, `approver` or any other operator role does not
make anyone the pilot owner, and the gate does not accept those role names in
its place.

### 5.5 The gate and the go-live decision

`pilot-ready` is necessary for **READY** (§2), not sufficient: the platform,
security and operations items above are people's facts the gate cannot see.
A gate result below `pilot-ready` is always **NOT READY**, except that
**READY WITH ACCEPTED DEGRADATION** may rest on a gate run that accepted a
named optional module (`--accept-degraded`). Record the gate's JSON report in
the go-live record (§3).

### 5.6 What a verified backup means

`PR-15` and `restore:v1` share one reading of a backup set: PROD-02's store
registry (`scripts/portability/store-registry.mjs`), whose pure validators
check the manifest's store inventory (closed store names, registry filenames,
no duplicates) and its coverage. Coverage is judged two ways and never by
the manifest's own `coverage.complete`: every store the backup's recorded
deployment requires under this build's conditions, and every store **this**
deployment requires — derived by the preflight from the Host's own
environment and governed-action file, exactly as `backup:v1` and
`restore:v1` derive it. A backup that omits a required store fails
(`BACKUP_INCOMPLETE`, naming the stores) whatever its manifest says, including
a manifest that records the store as not required or misdescribes the source
deployment. Without `--preflight` the deployment's requirements are unknown
and the check fails (`BACKUP_COVERAGE_NOT_VERIFIABLE`). The gate reads and
hashes files only: it opens no store, restores nothing and never touches the
witness. SQLite integrity and signed heads are verified by `restore:v1`,
which `PR-16` evidences.
