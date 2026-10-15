# Pilot Security Posture and Threat Model (PROD-03)

What a Frontera pilot is protected against, by whom, and what it assumes. The
division of work is [`SHARED_RESPONSIBILITY.md`](SHARED_RESPONSIBILITY.md); the
procedures are [`ONBOARDING_RUNBOOK.md`](ONBOARDING_RUNBOOK.md) and
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md). The repository-wide model and
the invariants it rests on are `docs/security/THREAT_MODEL_V1.md` (§7.37 is this
document's pilot section, with executable evidence) and
`docs/security/SECURITY_INVARIANTS.md`.

## 1. What Frontera protects

Within the governed-action path of the secure Host, and only there:

- **Deterministic governance.** Every governed request is decided by the
  Kernel against durable Kernel Authority and the deployment's policy; no
  model, heuristic or caller field decides.
- **Authority checks and bounds.** An action reaches an adapter only under a
  signed, short-lived bounded grant derived from a committed decision, and
  only within the authority's action, resource, P10 monetary limits and typed
  parameter bounds — re-checked at exercise.
- **Revocation.** A revoked grant, delegation, actor or credential stops
  admitting; revocation of a bounded grant is signed and anchored at the
  external witness, so a restored older state is refused at startup.
- **Approval.** A decision a profile sends to review is executed only after
  an approver with live standing approved it, once, within its validity.
- **Exercise controls and outcomes.** One execution per committed decision;
  an unconfirmed outcome is never retried by Frontera and is closed only by a
  recorded resolution (P11, P12).
- **Evidence.** Every decision, grant, approval, execution, outcome and
  resolution is recorded and can be traced and verified per request
  (ASSURE-01): integrity and correlation, authenticity where signed.
- **Store integrity and freshness.** Stores verify their own integrity and
  schema; the signed authority stores are anchored at the witness; a store
  that does not verify makes the Host not ready.
- **Configuration and readiness truth.** The Host refuses an insecure or
  inconsistent configuration; `/ready` is never 200 while a required module
  is unhealthy; the readiness gate fails closed.

## 2. What Frontera does not protect

- The network: firewalls, TLS, rate limits and exposure are the deployment's.
- The machine: the OS, the container runtime, filesystem permissions, disks.
- Identity beyond bearer secrets: no SSO, MFA or phishing resistance for
  operators (PROD-04). A stolen operator credential is that operator until it
  is removed from the configuration.
- The target system: Frontera decides whether an effect may be **attempted**;
  the target must still authenticate the adapter and enforce its own
  permissions. Frontera is not the target's IAM.
- Anything an embedder composes outside the governed-action path, and any
  process code outside Frontera's boundary (no sandbox, no egress control).
- Secrets at rest outside Frontera's stores: `.env`, the secret manager,
  backups' storage.

## 3. Required deployment assumptions

| Assumption | Why | Owner |
| --- | --- | --- |
| The kit's secure profile is unchanged (`production`, SQLite, authentication on, witness external) | every guarantee above assumes it; the configuration check and the Host refuse otherwise | deployment owner |
| `.env` is mode 600, never in Git, sourced from a secret manager | it holds the authority key (software custody) and every credential | deployment owner |
| The state and witness volumes are separate restore domains, backed up separately | a co-restore makes an old authority state look current | deployment owner, witness operator |
| The Host port is reachable only through the TLS reverse proxy, `/api/admin/...` only from operators' networks | operator credentials are bearer secrets | deployment owner |
| Clocks are synchronized (NTP) | grants, approvals, credentials and evidence carry validity windows and timestamps | deployment owner |
| The target authenticates the adapter's credential and enforces least privilege on it | Frontera governs attempts, not the target's permissions | target-system owner |
| Operators follow the role split (ONBOARDING_RUNBOOK.md §1) | an administrator holds every permission | pilot owner |

## 4. Key custody

The qualified kit uses **software custody**: the authority signing key is in
`.env` and in the Host process. Anyone who can read either can sign authority
that verifies (AA-001). This is accepted for a pilot when the pilot's threat
model accepts it in writing (Master Plan §11.3) — it is part of the
acknowledgement the readiness gate requires (`PR-18`, PILOT_READINESS.md §5.4).

**External custody** (`AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external`) keeps
the private key out of the Frontera process entirely: a separate custody
service signs over a pinned, verified protocol; the Host verifies every
signature locally. The readiness gate can require it
(`--require-external-custody`) and reports custody in `PR-05`. Under external
custody a signer outage stops new authority (issuance, revocation, discharge,
approval) with nothing written, keeps existing authority readable, and shows
as `PR-05 SIGNER_UNAVAILABLE`; it is qualified by
`tests/pilot/prod03-signer-outage-drill.test.mjs`. The reference custody
service is not an HSM.

Rotation of the authority key, the witness credential or the witness receipt
key has no supported pilot procedure (OPERATIONS_RUNBOOK.md §14): escalate.

## 5. The witness

The CORE-07 witness holds, outside the Host's restore domain, the newest
signed head of each anchored authority store. The Host refuses to start on an
older, forked or unknown state, and refuses (with nothing written) an anchored
mutation while the witness is unreachable. **A witness restored together with
the Host's stores defeats it by design**: they are separate volumes, separate
backup sets and separate restore decisions, and the witness is never reset or
re-enrolled to make a backup start. The bundled witness is a reference
implementation, not a ledger, an HSM or a timestamping authority.

## 6. Backups

A backup (`backup:v1`, cold) holds every Host store and no secret: secret
values, the authority key, signer and witness credentials and witness state
are excluded and never read, and the readiness gate searches a backup for the
credentials it holds (`PR-15`). Backups are checksummed, not signed or
encrypted: the deployment encrypts and access-controls them. Restoring is a
state rollback: state that is not witness-anchored (emergency stops, agent
credential revocations, profile lifecycle, Kernel Authority changes, exercise
consumption) returns to the backup's moment and must be re-applied
(OPERATIONS_RUNBOOK.md §6). A restore is a material change: the readiness
record must be renewed.

## 7. Network and TLS

| Interface | Default | Exposure |
| --- | --- | --- |
| Host HTTP (`/live`, `/ready`, `/health`, `/version`, `/api/...`) | `127.0.0.1:8787` (published by the kit) | behind the pilot's TLS reverse proxy; operator paths restricted at the proxy |
| Reference witness | loopback inside the kit's network namespace | never published; an external witness must be `https://` |
| External signer | loopback (reference) or `https://` | never on a public interface |
| Web console | `127.0.0.1:8788` | behind TLS; `FRONTERA_CONSOLE_PUBLIC_ORIGIN` must be `https://` off loopback |
| Generic HTTP adapter → target | outbound `https://` only | loopback, private and link-local destinations refused by the adapter |

Frontera terminates no TLS itself; it refuses plaintext only where it speaks
outbound (witness, signer, targets) off loopback.

## 8. Credentials

| Credential | Held by | Revealed | Rotation | If exposed |
| --- | --- | --- | --- | --- |
| Operator | one person per `operatorId` | at generation, into `.env` | new value, restart (OPERATIONS_RUNBOOK.md §14) | SEV-1 for an administrator; remove or rotate |
| Agent | the agent's runtime | once, in the issuing response | operator-plane rotation, no restart | revoke at once (ONBOARDING_RUNBOOK.md §11.2) |
| Evidence key (auditor) | the auditor | at generation | new value, restart | read-only exposure of evidence |
| Provider (target) | `.env`, the adapter | never by Frontera | at the target, then `.env` | rotate at the target |
| Authority key, witness token, receipt key | `.env`, witness volume | at generation | no pilot procedure | SEV-1, escalate |

None appears in any log, response other than its one reveal, backup,
evidence or readiness output; the drills search all of them.

## 9. Pilot threat model

Dispositions: **BLOCKED** — prevented by Frontera and proven by the evidence
named; **MITIGATED** — reduced by Frontera, a residual stated; **ACCEPTED** —
a stated pilot-level residual; **DEPLOYMENT** — the deployment's
responsibility, with the supporting Frontera control named.

| # | Threat | Disposition | How |
| --- | --- | --- | --- |
| PILOT-1 | A pilot depends on its founder for setup | **BLOCKED** | every routine operation has a supported surface; the clean-room drill and its handoff phase run the whole life cycle from the runbook with no source, database or founder step |
| PILOT-2 | Direct database editing becomes a routine operation | **BLOCKED** | no runbook step opens a store; the drill harness is structurally barred from it; stores refuse tampering |
| PILOT-3 | Secrets copied into the configuration repository | **MITIGATED** | the governed-action file names variables only, inline secrets are refused, the templates are scanned; `.env` placement is the deployment's |
| PILOT-4 | A stale backup restored while the witness is ahead | **BLOCKED** | the Host refuses to start (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`), nothing served |
| PILOT-5 | The witness restored together with the Host's stores | **DEPLOYMENT** | separate volumes and backup sets; never restored by any Frontera tool; a co-restore is undetectable by design (§5) |
| PILOT-6 | The one-time agent credential is lost | **MITIGATED** | it is never shown again; rotation replaces it, the old one stops at once |
| PILOT-7 | An operator credential is stolen | **ACCEPTED** | bearer secrets, no MFA (PROD-04); bounded by the role split, quorum, audit attribution and removal from the configuration |
| PILOT-8 | Unauthorized organization bootstrap | **BLOCKED** | bootstrap needs an organization administrator; a conflicting second bootstrap is refused, a replay writes nothing |
| PILOT-9 | An operator acts on another organization | **BLOCKED** | one organization per Host, never taken from a request; a request naming one is refused |
| PILOT-10 | A misconfigured Governance Profile | **MITIGATED** | profiles are validated at boot; promotion is digest-bound and attributed; `approvalPolicy` must name a profile every declared version of which declares how it is approved (PILOT-29), and needs an operator who can approve (PILOT-27) |
| PILOT-11 | Authority over-provisioned to an agent | **MITIGATED** | the readiness gate fails an agent with an unbounded active lineage (`PR-11`); the provisioner's judgement remains |
| PILOT-12 | Emergency release abused | **MITIGATED** | release is an organization-administrator permission, attributed and recorded; a responder can stop, never release |
| PILOT-13 | An unconfirmed action manually sent again | **BLOCKED** | no route sends anything again; the same request answers from the record; the operator records a resolution that performs nothing |
| PILOT-14 | Signer unavailable | **BLOCKED** | under external custody nothing new is signed or performed, and the gate reports `PR-05 SIGNER_UNAVAILABLE` |
| PILOT-15 | Witness unavailable | **BLOCKED** | anchored mutations refused with nothing written (`503`, `recorded: false`); the gate reports `PR-04 WITNESS_UNAVAILABLE`; recovers with no reset |
| PILOT-16 | Disk full or a store unavailable | **BLOCKED** | preflight refuses an unwritable or corrupt store; the Host refuses to start; never ready |
| PILOT-17 | A log leaks a credential | **BLOCKED** | no credential in any Host, gate, preflight or tool output; searched by the drills |
| PILOT-18 | A backup leaks a credential | **BLOCKED** | no secret is read into a backup; every byte searched; the gate refuses a backup holding a credential it knows |
| PILOT-19 | A restore loses authority history | **MITIGATED** | the anchored stores cannot be rolled back silently; non-anchored state returns to the backup's moment and is re-applied by runbook (§6) |
| PILOT-20 | Evidence unavailable after an incident | **MITIGATED** | traces are rebuilt from the durable stores after restart and restore; the evidence bundle and export are runbook steps; retention is the pilot's |
| PILOT-21 | The target's credential for the adapter is over-privileged | **DEPLOYMENT** | the target enforces its own permissions (§2); offboarding disables it at the target |
| PILOT-22 | An operator cannot tell live from ready from safe | **BLOCKED** | `/live`, `/ready`, `/health` and the gate's three levels are distinct; a live but not ready Host fails `PR-06` |
| PILOT-23 | An unsupported upgrade | **MITIGATED** | the configuration check refuses an unknown schema; no downgrade is offered; the upgrade runbook stops on any refusal |
| PILOT-24 | No rollback or restore practice | **BLOCKED** | `pilot-ready` requires a verified backup and a restore of that backup (`PR-15`, `PR-16`) |
| PILOT-25 | Offboarding leaves live authority | **BLOCKED** | the offboarding runbook revokes every identity; the gate shows no pilot agent left (`PR-10`) |
| PILOT-26 | Readiness false positive through split agent state (a credential on one agent, authority on another) | **BLOCKED** | `PR-11` counts authority only on an agent whose identity and credential are both active — the agents `PR-10` counts; no union across agents (independent review P1-1) |
| PILOT-27 | Human approval configured with no operator able to approve | **BLOCKED** | `approvalPolicy` boots only when a configured operator role can reach `approval.approve` (the canonical role policy); refused by `config-check` and the launcher (P1-2) |
| PILOT-28 | An incomplete backup accepted as complete | **BLOCKED** | `PR-15` judges coverage with PROD-02's own validators against this deployment's store requirements, never the manifest's `complete` flag; every declared store file checksummed twice (P1-3) |
| PILOT-29 | Approval policy and profile version disagree (a review nothing can approve) | **BLOCKED** | every declared version of a profile `approvalPolicy` rules must declare `approval`; under the operator-promoted lifecycle any promotable version stays approvable (P1-4) |
| PILOT-30 | Policy decision identifiers reused across a restart | **BLOCKED** | the compiled approval policy runs on the live clock with `${prefix}-${randomUUID()}` identifiers; two boots never share one (P2-1) |
| PILOT-31 | Unbounded memory retention in the compiled approval policy under sustained traffic | **BLOCKED** | each evaluation runs on its own freshly compiled, frozen runtime and is dropped with everything it recorded; nothing is retained between evaluations (P2-2) |
| PILOT-32 | Readiness acknowledged by someone other than the pilot owner | **MITIGATED** | `PR-18` requires an entry with role `pilot-owner`; the gate checks form and binding and cannot authenticate the person (an unsigned file, like the record) (P2-3) |

Residuals this pilot carries, beyond the table:

- **Bearer-secret operators** (PROD-04): no SSO, MFA or rate limiting.
- **Software key custody** in the qualified kit (§4).
- **Non-anchored state rolls back with a restore** (PROD-02): emergency
  stops, credential revocations, profile lifecycle, Kernel Authority changes.
- **A revoked delegation shadows a replacement** whose id sorts after it
  (deterministic lineage selection, CTRL-02): the agent stays denied — fail
  closed; re-onboard a new identity (ONBOARDING_RUNBOOK.md §11.3).
- **The qualification record is unsigned** operational evidence (no
  ASSURE-02): it is trusted as far as the filesystem holding it.
- **The web console is not in the pilot image**; it runs from a checkout.
- **Policy beyond `approvalPolicy`** (conditions on facts, amounts, risk) is
  in-process embedding, outside the qualified pilot.
- **Payments are outside the pilot**: a pilot that composes a payment rail
  adds that rail's own runbooks, trust assumptions and qualification
  (`docs/payments/`).
