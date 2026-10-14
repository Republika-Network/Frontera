# Pilot Shared-Responsibility Matrix (PROD-03)

Who owns each part of a Frontera pilot. "Frontera" means what the release
(image, kit, tooling and documentation) does or provides; it does not mean
that Frontera operates anything in the pilot organization's environment.
Frontera runs no service on the pilot's behalf, holds none of its secrets and
has no access to its machines.

- **Frontera** — provided by the release and its documented behaviour.
- **Pilot organization** — the organization running the pilot, its
  infrastructure and its people.
- **Shared** — Frontera provides the mechanism; the pilot organization
  decides, operates or keeps it.

The pilot organization names a person or role for every "Pilot organization"
and "Shared" row before go-live ([`PILOT_READINESS.md`](PILOT_READINESS.md)
§4, handoff).

## Parties

"Pilot organization" is several people, and some rows belong to parties
outside it. Name each one:

| Party | Owns |
| --- | --- |
| **Frontera software** (the release) | what it enforces: deterministic governance, authority checks and bounds, revocation, approvals, exercise controls, outcomes and resolutions, evidence, store integrity checks, the freshness boundary when configured, configuration and readiness truth ([`SECURITY_POSTURE.md`](SECURITY_POSTURE.md) §1). Not networks, IAM, machines or targets |
| **Pilot operators** | the operator-plane work: bootstrap, profiles, onboarding, authority, approvals, stops, revocations, resolutions, readiness ([`ONBOARDING_RUNBOOK.md`](ONBOARDING_RUNBOOK.md) §1) |
| **Deployment owner / infrastructure administrator** | the machine, OS, Docker, filesystem permissions, volume durability, TLS and the reverse proxy, firewall, secret injection, backup storage, clock synchronization, log retention, monitoring, applying releases |
| **Target-system owner** | the system the governed actions reach: it authenticates the adapter's credential, enforces its own least-privilege permissions on it, and keeps its own record of what it performed. Frontera governs whether an effect may be **attempted**; it is not the target's IAM |
| **Witness operator** | the authority-state witness and its volume (the bundled reference witness: the deployment owner; an external one: whoever runs it) — kept outside the Host's restore domain, never reset |
| **Signer / custody operator** | under external custody, the custody service and its key; under software custody, whoever controls `.env` and the Host process |
| **Payment or provider operator** | only when a payment rail is composed (not in the qualified pilot): the rail's own accounts, credentials, node or processor, under that rail's runbooks (`docs/payments/`) |

Within the pilot organization one person is the **pilot owner**: accountable
for the pilot, the one who records the go-live decision
([`PILOT_READINESS.md`](PILOT_READINESS.md) §3) and acknowledges this matrix,
the security posture and the known limits for each release (§5.4 there; the
readiness gate's `PR-18` accepts no other role). It is an operational role,
not an operator-plane role: holding `organization-administrator` or any other
operator role does not make anyone the pilot owner.

## Platform and network

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| Host operating system | | ✔ | | Supported: Linux x86_64 or arm64. Patching, hardening, users, time synchronization |
| Docker runtime | | ✔ | | Docker Engine with Compose 2.20 or later |
| Container image contents | ✔ | | | Pinned Node base image, runtime dependencies from the lockfile, non-root user, no secret or state in the image |
| Building the image from an approved release | | ✔ | | `docker compose build` with `FRONTERA_BUILD_COMMIT` set (PILOT_DEPLOYMENT.md §8) |
| Network, firewall, exposure | | ✔ | | The kit publishes on `127.0.0.1:8787` by default; publishing elsewhere is the pilot's decision |
| DNS | | ✔ | | Frontera reads no `Host` header for any decision |
| TLS certificates and termination | | ✔ | | The Host speaks plain HTTP behind the pilot's proxy |
| Reverse proxy, rate limiting, request logging | | ✔ | | Forward `Authorization` and `Idempotency-Key` unchanged; do not retry POSTs (PILOT_DEPLOYMENT.md §15) |
| Restricting the operator plane (`/api/admin/...`) to operators' networks | | ✔ | | Path-based allow-listing at the proxy |
| Outbound access to the governed providers | | ✔ | | The Host calls only the `https://` origins in `governed-actions.json` |

## Secrets and keys

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| Secret storage and injection into `deploy/pilot/.env` | | ✔ | | Frontera has no secret store; it reads environment variables only |
| Generating the authority key, witness credential and operator credentials | | | ✔ | Frontera provides the one-time generator (`witness-init`); the pilot runs it once and keeps its output |
| Authority signing key custody | | | ✔ | Software custody in the qualified kit: the private key is in `.env` and in the Host process. The pilot protects both (OPERATIONS_RUNBOOK.md §15) |
| Retaining authority verification keys | | ✔ | | Every key that signed live state stays in `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS` |
| Operator credentials: distribution, safekeeping, revocation | | ✔ | | Frontera maps a credential to an `operatorId` and role; who holds it is the pilot's decision |
| Provider credentials | | ✔ | | Issued by the provider, never generated by Frontera |
| Witness credential and receipt key | | ✔ | | The receipt key lives on the `frontera-witness` volume; treat that volume as key material |
| Agent credentials issued through the operator plane | | | ✔ | Frontera issues, rotates and revokes them and stores only verifiers; the pilot hands the one-time value to the agent's owner |
| Secret exposure response | | ✔ | | INCIDENT_TRIAGE.md (secret exposure suspicion) |

## Runtime and health

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| Configuration validation | ✔ | | | `config-check` and the launcher's preflight refuse invalid, placeholder or insecure configuration |
| Configuration correctness (organization id, governed actions, operators, provider origins) | | ✔ | | Frontera validates form and the secure profile, not business intent |
| Host readiness semantics (`/live`, `/ready`, `/health`) | ✔ | | | OPERATIONS_RUNBOOK.md §9 |
| The readiness gate's checks and their fail-closed evaluation | ✔ | | | PILOT_READINESS.md §5 |
| Running the readiness gate, keeping its record, renewing it after a material change | | ✔ | | OPERATIONS_RUNBOOK.md §9.1 |
| Acknowledging shared responsibility, security posture and known limits for each release | | ✔ | | The pilot owner, in person (PILOT_READINESS.md §5.4); the gate checks form and binding, not who wrote the file |
| Clock synchronization (NTP) of the Host, witness and signer machines | | ✔ | | grants, approvals, credentials and evidence carry validity windows and timestamps |
| Acting on readiness (traffic decisions, restarts on `/live` failure) | | ✔ | | The image health check reports `/ready`; Compose restarts a stopped container (`restart: unless-stopped`) |
| Module health and criticality | ✔ | | | Required modules fail readiness; optional ones degrade |
| Application logs (structured `enterprise.host.*` lines, no secrets) | ✔ | | | |
| Log collection, retention and shipping | | ✔ | | `docker compose logs`; any log pipeline is the pilot's |
| Infrastructure monitoring and alerting | | ✔ | | Frontera provides the probes, not a monitoring stack |
| Release artifact integrity (what a release is, its identity) | ✔ | | | `/version`, the image revision label and the release manifest agree (qualified) |
| Verifying the deployed release is the approved one | | ✔ | | Startup runbook step 2 and 10 |

## Governance

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| Governed-action policy (routes, adapters, limits, profiles) | | ✔ | | Configured in `governed-actions.json` and through the operator plane |
| Which profiles require human approval (`approvalPolicy`) | | ✔ | | Frontera enforces it; the pilot decides it (ONBOARDING_RUNBOOK.md §2.1) |
| Organization bootstrap, operator role split, agent onboarding and bounded authority | | | ✔ | Frontera provides the operator plane and refuses unbounded or conflicting writes; the pilot's operators decide and perform them (ONBOARDING_RUNBOOK.md) |
| Agent credential one-time delivery to the agent's runtime | | ✔ | | ONBOARDING_RUNBOOK.md §6.1 |
| The target system's own permissions and its credential for the adapter | | ✔ | | Held by the target-system owner; disabled at offboarding |
| Enforcing the policy (deny, withhold, require approval, grant) | ✔ | | | |
| Approvals | | | ✔ | Frontera records and enforces approvals; the pilot's approvers decide them |
| Emergency stop activation and release | | | ✔ | Frontera enforces stops; the pilot decides when to activate and release |
| Operator resolution of unconfirmed executions | | | ✔ | Frontera records the attestation; the pilot's administrator establishes the real outcome with the provider |
| Evidence and trace integrity (ASSURE-01 traces, digests, signed state) | ✔ | | | |
| Audit retention and access to evidence | | ✔ | | Evidence lives in the stores and in the pilot's backups |
| Retention periods for security logs, activity, evidence exports, backups and operator change records | | ✔ | | Set by the pilot's own legal, contractual and customer requirements; Frontera imposes none and deletes none of its records |
| Data retention and deletion policy | | ✔ | | Frontera deletes nothing on its own; no supported purge exists in the pilot |

## Durability and change

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| Backup tooling and its integrity checks | ✔ | | | `backup:v1` / `restore:v1`, run through the kit (OPERATIONS_RUNBOOK.md §5, §6) |
| Backup scheduling | | ✔ | | RPO is the pilot's backup interval |
| Backup storage: encrypted, access-controlled, off-host | | ✔ | | Backups are checksummed, not signed or encrypted |
| Witness volume backups (a separate set and schedule) | | ✔ | | OPERATIONS_RUNBOOK.md §5.4 |
| Restore execution | | ✔ | | With Frontera's restore tooling, which validates before touching state |
| Restore testing before go-live | | ✔ | | Required for READY (PILOT_READINESS.md) |
| Upgrades: deciding, scheduling and executing | | ✔ | | OPERATIONS_RUNBOOK.md §7 |
| Upgrade compatibility statement (schema versions, migrations) | ✔ | | | Each release's `/version` lists the store schema versions it opens |
| Rollback | | ✔ | | Within the boundary in OPERATIONS_RUNBOOK.md §8 |
| Vulnerability patching of the Frontera code and image base | ✔ | | | Delivered as new releases |
| Applying patched releases | | ✔ | | Through the upgrade runbook |
| Host OS, Docker and proxy patching | | ✔ | | |

## Incidents

| Responsibility | Frontera | Pilot organization | Shared | Notes |
| --- | --- | --- | --- | --- |
| First-line triage | | ✔ | | INCIDENT_TRIAGE.md |
| Evidence preservation before remediation | | ✔ | | INCIDENT_TRIAGE.md §3 |
| Escalation to the Frontera team | | | ✔ | The contact and channel are agreed at handoff |
| Analysis of Frontera defects and fixes | ✔ | | | Delivered as releases |
| Communication to the pilot's own stakeholders | | ✔ | | |

## What Frontera does not do

- Operate, monitor or access the pilot's infrastructure.
- Store, rotate or recover the pilot's secrets.
- Take, schedule or keep backups.
- Never retries, replays or resends a governed action, automatically or on request.
- Repair durable state by hand.
- Provide a support desk, ticketing or paging platform as part of the pilot.
