# PROD-03 — Pilot Onboarding & Operational Qualification

- **Milestone:** PROD-03 (FRONTERA-MASTER-PLAN §9 PROD), the last requirement of **PILOT READY** (§11.3).
- **Baseline:** `main @ 6adfe45` (PAY-09, #185); `main @ 11db917` (TRADE-04a, #187, which touches none of PROD-03's files and changes no NO_BYPASS count) merged in by merge commit, never rebased.
- **Branch:** `feat/prod-03-pilot-onboarding-operational-qualification`.
- **Scope (Master Plan):** runbooks, provisioning path, observability minimum, security posture / shared responsibility, readiness gate. Nothing else: no SSO, billing, mobile, IaC, Kubernetes, INTEL, rails or credit.
- **Exit decision:** §16 — **PILOT READY achieved**, with the residuals of §15.

## 1. The exit criterion, made executable

> *A real organization uses Frontera without the founder operating source code or database state.* (§11.3)

Read as operational criteria, every one of which must hold on the shipped secure Host:

1. **Deploy** from a release with a recorded identity, validated before start, through documented commands.
2. **Bootstrap** the organization through the operator plane, safe to repeat, refused when conflicting or unauthorized.
3. **Onboard operators** by configuration and the supported secret generator — no store or source edit.
4. **Onboard an agent** with a credential revealed exactly once, delivered without ever touching a log.
5. **Assign bounded authority** (typed parameter bounds or P10 limits) that is enforced: in-bound executes once, over-bound reaches nothing.
6. **Execute** a governed action against a real separate target, exactly once.
7. **Approve** — a decision requiring a human waits with zero effect, is approved through the shipped console, resumes once; a rejection never executes — **with no embedder code** on the shipped launcher.
8. **Revoke** — the next request reaches nothing; authority can be restored by a supported path.
9. **Stop** — an emergency stop withholds everything; only an administrator releases it.
10. **Observe** — liveness, readiness, health, safety to execute, release, stops, activity, Attention and one request's trace, from supported signals; a machine-checkable readiness gate.
11. **Obtain evidence** — every request's ASSURE trace fetched and verified over the API, by an auditor holding no operator power.
12. **Back up** cold, with no secret in any byte.
13. **Restore** into a destroyed state directory from the backup alone, secrets re-supplied, the surviving witness — evidence identical, nothing replayed; a stale backup refused.
14. **Recover** from witness, signer, target and store failures, and from an unconfirmed effect, without resend, reset or store edit.
15. **Offboard** every agent and stop cleanly, with evidence and a final backup kept.
16. **Hand off** — a second operator team does the routine operations from the runbook alone.

"Docs exist" satisfies none of these: each is executed by the clean-room drill (§12) on real processes.

## 2. Dependencies

PROD-01, PROD-02, CTRL-01 … CTRL-04, CORE-06 — all VERIFIED (Master Plan §9); ASSURE-01 VERIFIED (§11.3 assurance). PAY and TRADE are outside the pilot path and are regression-tested, not depended on.

## 3. What existed, and what was missing

PROD-03 had partly landed as four sub-items on `main` without the milestone being claimed: **PROD-03-01** (five operator reads: executions, Attention, traces, metrics, operations health), **PROD-03-02** (operator resolution of unconfirmed executions, P12), **PROD-03-03** (the Compose pilot kit, the deployment preflight `config-check`, release identity `/version`, startup lifecycle events, D1–D15) and **PROD-03-04** (pilot operations documents, the human go-live checklist, runbooks executed as written by the acceptance qualification, O1–O15). Audited against criterion 1–16, they left these gaps, each closed here:

| Gap | Why it blocked §11.3 | Closed by |
| --- | --- | --- |
| **F1** No approval on the shipped launcher | `approval_required` came only from an in-process `policyPackProvider`; `npm run start:enterprise` and the kit compose none, so a pilot needing a human approval had to write code (criterion 7) | `approvalPolicy` in the governed-action file (§5.1) |
| No onboarding procedure or drill | the kit's qualifications prove deployment and operations, not bootstrap → profiles → agent → authority → approval → effect; no document told an operator how (criteria 2–8, 16) | `ONBOARDING_RUNBOOK.md`; the clean-room drill and its handoff phase |
| No machine-checkable readiness | the go-live gate was a human checklist; nothing distinguished "live", "ready" and "safe to execute" across witness, signer, stops and onboarding (criterion 10) | the readiness gate (§5.2) |
| Historical drills unprovable | a backup and a restore drill were checklist ticks (criterion 13) | verified evidence and the qualification record (§5.3) |
| **F2** A witness outage revocation answered `500 INFRASTRUCTURE_FAILURE` | an operator mid-incident could not tell whether the grant was revoked (criterion 14) | the administration API maps it (§5.4) |
| No real adapter effect in any kit qualification | the kit's Generic HTTP adapter refuses loopback targets (SSRF boundary), so O12 proves the decision path only (criterion 6) | the drill's reference target, a separate process counting effects (§12.1) |
| No pilot threat model, posture or party model | §11.3's "security posture / shared responsibility" | `SECURITY_POSTURE.md`, `SHARED_RESPONSIBILITY.md` parties |

## 4. Architecture of the delivery

No new architecture, store, route or effect path. Everything composes what exists:

```
governed-actions.json ── approvalPolicy ──► existing policy-pack runtime (require_approval only, frozen) ──► Kernel ──► CORE-05 approvals ──► CTRL-04 inbox / console
running Host ◄── GET ── pilot-readiness (scripts/pilot) ── preflight (scripts/deploy/host-preflight.mjs, unchanged)
                                         └── files: backup set · restore report · acknowledgement · qualification record
tests/pilot: clean-room drill ── supported CLIs + HTTP + console + runbook blocks ──► Host · witness · console · reference target (four processes)
```

## 5. What was built

### 5.1 `approvalPolicy` (F1)

`src/enterprise/host/approval-policy.ts`, wired by `host-configuration.ts` and `enterprise-host.ts`. Closed schema `{policyId, rules: [{ruleId, governanceProfile, reasonCode}]}`, 1 … 32 rules. Each compiles to one `require_approval` rule of the existing policy-pack runtime, matched on the effective profile id, scoped to the Host's trust domain, written by `configuration:governed-actions-file#approvalPolicy` (NB-008 attribution) and frozen. Refused: an undeclared profile, a profile that declares no `approval` (it could never be approved), two rules for one profile, a deployment without operators, and an embedder `policyPackProvider` alongside it (`HOST_POLICY_SOURCE_AMBIGUOUS`). It can only restrict: an unruled profile and a request the authority denies are untouched (SEC-INV-313).

### 5.2 The readiness gate

`scripts/pilot/lib-pilot-readiness.mjs`, CLI `scripts/pilot/pilot-readiness.mjs` (`npm run pilot:readiness`, `npm run pilot:diagnose`), and the kit tool `docker compose run --rm -T pilot-readiness`. Twenty checks PR-01 … PR-20 into three cumulative levels (`docs/pilot/PILOT_READINESS.md` §5): deployment (release identity, secure configuration and posture, storage, witness, signer, live/ready/healthy, no global or organization stop, diagnostics, no integrity or freshness failure), organization (bootstrapped, verified administrator, required profiles active, approval path, activity and evidence), pilot (an agent with an active credential and bounded standing authority, a verified backup, a qualified restore, the acknowledgement, an operable revocation path). Each result carries a bounded reason token and a remediation reference; `--json` is `frontera.pilot-readiness.v1`. Fail-closed: anything it cannot evaluate fails. Read-only: `GET` only (one method in its source), the unchanged preflight, the files it is given; credentials read by variable name and never printed (SEC-INV-314, SEC-INV-315).

### 5.3 The qualification record

`--write-record` writes, mode 600, `frontera.pilot-qualification-record.v1`: result, checks, evidence digests and the deployment fingerprint (organization, release, configuration checksum, posture digest, signer custody and key, witness id, active profile digests, governed-action file digest, last restore). `--record` lets it satisfy only PR-15, PR-16 and PR-18, only while the fingerprint is unchanged and before expiry (default 30, at most 90 days). It satisfies no live check, issues nothing, clears nothing and is declared unsigned operational evidence (SEC-INV-318). Material changes that invalidate it: release, configuration (an operator added or removed, a rotation, a file edit), signer custody or key, witness identity, a profile promotion or replacement, a restore.

### 5.4 Revocation during a witness outage (F2)

`src/enterprise/authority-administration/service.ts`: a CORE-07 freshness error is recognized by name and closed code (the administration layer stays structurally barred from the freshness module). `AUTHORITY_FRESHNESS_UNAVAILABLE` and `…_CONFLICT` — raised before any local write — answer `503 AUTHORITY_STATE_UNAVAILABLE`, `failure`, `recorded: false`; every other freshness code `500 AUTHORITY_STATE_INTEGRITY_FAILED` (SEC-INV-319). The approval workflow already answered conservatively (`503`, "whether recorded is unknown — read back") and is unchanged.

### 5.5 Configuration package and safety

`deploy/pilot/governed-actions.reference-pilot.json` — the canonical pilot template (§7). `scripts/pilot/scan-pilot-config.mjs` (`npm run pilot:scan-config`) refuses a configuration file carrying a pilot secret shape (private key, bearer or agent credential, Stripe key, macaroon, inline secret field, XRPL seed, an assigned secret variable), printing line and kind only. The committed templates pass it; the scanner is proven not vacuous (SEC-INV-316). `.gitignore` already excludes every `.env` except examples.

### 5.6 Documentation

`docs/pilot/ONBOARDING_RUNBOOK.md` (new), `docs/pilot/SECURITY_POSTURE.md` (new), and in the existing set: `PILOT_READINESS.md` §5, `OPERATIONS_RUNBOOK.md` §9.1–9.2, `INCIDENT_TRIAGE.md` §2, §4–5, `SHARED_RESPONSIBILITY.md` parties and rows, `PILOT_ACCEPTANCE.md` O16, `README.md`; `docs/deployment/PILOT_DEPLOYMENT.md` §4.3, §9; `docs/enterprise/AOC_ENTERPRISE_HOST.md` (`approvalPolicy`, `HOST_POLICY_SOURCE_AMBIGUOUS`); `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md` §5.1. One small set, cross-linked, no shallow document per topic.

## 6. Operator model

Closed roles (CTRL-02/04): organization administrator, provisioner, profile steward, approver, responder, observer. **Smallest safe staffing: four people** — an administrator who does not provision or approve day to day, a provisioner, an approver who is not the provisioner, an observer; steward and responder may be held alongside another role, never provisioner with approver. Rationale: an administrator holds every permission and could alone complete a quorum-1 approval (ADR-CTRL-04 R-8). `ONBOARDING_RUNBOOK.md` §1.

## 7. Reference pilot deployment and use case

| Part | Choice |
| --- | --- |
| Host | the PROD-03-03 Compose kit, secure `production` profile |
| Witness | the bundled reference witness on its own volume |
| Signer custody | software (qualified kit); external custody supported and drilled |
| Control plane | operator API; web console from the release checkout |
| State / backups / secrets | `frontera-state` volume; `backup:v1` cold through the kit; `.env` from the pilot's secret manager |
| Governed action target | the pilot's system over Generic HTTP `https://`; in the drill, a reference target process |
| Observability | `/live`, `/ready`, `/health`, `/version`, operations reads, structured logs, the readiness gate |
| People | `ops-admin`, `ops-provisioner`, `ops-steward`, `ops-approver`, `ops-responder`, `ops-observer`; agent credentials from the operator plane; an auditor by observer credential or an organization-scoped evidence key |

**Use case:** a governed deployment request (`deploy-release` × `staging-cluster` / `production-cluster`) with typed parameters `replicaCount` (≤ bound) and `deploymentStrategy` (= bound); profile `deploy-staging` decided by authority and bounds, profile `deploy-production` additionally requiring one approver with `approve-deploy`. Operationally harmless, and it exercises organization, operators, agent, profiles, authority, bounded parameters, policy (the approval requirement), approval, execution, P11, evidence, revocation and emergency stop. Payments and TRADE are not part of it.

## 8. Supported operator surfaces (CTRL-01 … CTRL-04 audit)

| Operation | Web console | Operator API | CLI / kit |
| --- | --- | --- | --- |
| Organization bootstrap | provisioning forms (administrator) | `POST /api/admin/authority/entities/{actor,trust-domain,root-issuer}` | — |
| Operator provisioning | — | — (operators are configuration) | `witness-init --secrets-only`; config check; `up -d` |
| Governance Profile promotion | Profiles (activate with digest) | `POST /api/admin/governance-profiles/{id}/versions/{v}/activate` | — |
| Agent onboarding | Agents → new (staged) | `POST /api/admin/authority/entities/actor` | — |
| Agent credential issuance / rotation / revocation | one-time reveal page; rotate; revoke | `POST /api/admin/agents/{id}/credentials[/{c}/rotate\|revoke]` | — |
| Authority assignment (bounds) | Authority → new grant / delegation | `POST /api/admin/authority/entities/{authority-grant,delegation-grant,…}` | — |
| Authority revocation | entity → revoke | `POST /api/admin/authority/entities/{kind}/{id}/revoke`; `…/grants/{id}/revoke` | — |
| Emergency stop / release | Emergency controls | `POST /api/admin/emergency-controls/{activate,release}` | — |
| Approval inbox / resolution | Approvals (one confirmation per verdict) | `GET /api/admin/approvals[/{id}]`, `POST …/{approve,reject,…}` | — |
| Activity and evidence review | Activity; Evidence | `GET /api/admin/activity/decisions`, `/api/admin/operations/*`, `/api/evidence/traces/{id}[/verify]` | — |
| Unconfirmed execution | — | `POST /api/admin/operations/executions/{id}/resolution` | — |
| Readiness, diagnosis | — | (reads) | `pilot-readiness`, `config-check` |
| Backup / restore | — | — | `backup:v1` / `restore:v1` through the kit |

No duplicate provisioning mechanism was added.

## 9. Founder-independence inventory

| Task | Supported surface | Source edit? | DB edit? | Founder-only knowledge? | PROD-03 remediation |
| --- | --- | --- | --- | --- | --- |
| Bootstrap organization | operator API / console | no | no | was undocumented | ONBOARDING §4, drill B, handoff |
| Create first administrator | `operators[]` + `witness-init` | no | no | no | ONBOARDING §3 |
| Configure Host | `.env` + governed-action file + `config-check` | no | no | no | reference template |
| Set secrets | `witness-init`, secret manager | no | no | no | SECURITY_POSTURE §8 |
| Configure witness | kit (`COMPOSE_PROFILES=reference-witness`) | no | no | no | — |
| Configure signer | `.env` (software) / external custody variables | no | no | external custody undocumented for pilots | SECURITY_POSTURE §4; signer drill |
| Require human approval | **was: embedder code** | **yes** | no | yes | **`approvalPolicy` (F1)** |
| Promote profile | operator API / console | no | no | authoring vs promotion unclear | ONBOARDING §5 |
| Onboard agent | operator API / console | no | no | was undocumented end to end | ONBOARDING §6 |
| Rotate / revoke agent credential | operator API / console | no | no | no | ONBOARDING §11.2 |
| Grant authority | operator API / console | no | no | bounds and approver standing undocumented | ONBOARDING §7, §8.1 |
| Change bounds | a new grant (bounds are immutable on a record) | no | no | yes | ONBOARDING §7, §11.3 |
| Restore authority after a revocation | **re-onboard a new identity** | no | no | **yes (shadowing)** | ONBOARDING §11.3; pinned in the drill |
| Approve / reject | console / operator API | no | no | no | ONBOARDING §8.2 |
| Emergency stop / release | operator API / console | no | no | no | OPERATIONS §12 |
| Inspect activity | operator API / console | no | no | no | — |
| Fetch evidence | operator / evidence API | no | no | auditor key undocumented | ONBOARDING §10 |
| Backup | kit (`backup:v1`) | no | no | no | — |
| Restore | kit (`restore:v1`) | no | no | no | readiness PR-16 |
| Restart | kit | no | no | no | — |
| Upgrade | kit | no | no | no | OPERATIONS §7 |
| Diagnose unhealthy Host | `/health`, logs | no | no | **no single answer** | readiness gate `--diagnose` |
| Revocation during witness outage | operator API | no | no | **yes (500)** | **F2** |
| Recover pending witness state | escalation (no force path exists) | no | no | documented | INCIDENT_TRIAGE §5 |
| Offboard pilot | operator API + kit | no | no | was undocumented | ONBOARDING §13, drill K |

After PROD-03 every routine row is "no / no / no"; the two rows marked as founder-only knowledge are now documented and executed.

## 10. Observability minimum and health states

| State an operator must distinguish | Signal |
| --- | --- |
| healthy / ready | `/ready` 200, `/health` `healthy`; gate deployment-ready |
| starting | `/live` with `lifecycleState`; `/ready` 503 until ready; startup events |
| degraded | `/health` `degraded` (optional module, witness after startup, signer) |
| not ready | `/ready` 503; gate `PR-06` |
| freshness witness unavailable | `authorityFreshness.witness.state`; gate `PR-04 WITNESS_UNAVAILABLE` |
| signer unavailable | `authoritySigner.state`; gate `PR-05 SIGNER_UNAVAILABLE` |
| store integrity / freshness failure | `authorityFreshness.stores[].status`, required module unhealthy; gate `PR-20`, `PR-03` |
| adapter / provider unavailable | the request's outcome; `governed_path.execution_outcome` |
| emergency stopped | `/api/admin/emergency-controls`; gate `PR-13` (does not change `/ready`) |

Liveness is lifecycle only; readiness requires health not `unhealthy`; **safe to accept governed executions** is the gate's deployment level, which also fails on a degraded witness or signer that `/ready` tolerates. Health and the gate are side-effect free (the gate is `GET`-only; the preflight's storage probe creates and removes a temporary file, as it always has). Logging: the existing structured events (`OPERATIONS_RUNBOOK.md` §9.2) already carry `requestId`, `executionId`, operator ids, dispositions, outcome certainty, approvals and emergency actions, with no credential, header or body; no logging stack was added.

## 11. Shared responsibility, security posture, threat model

`docs/pilot/SHARED_RESPONSIBILITY.md` names seven parties (Frontera software, pilot operators, deployment owner, target-system owner, witness operator, signer operator, payment/provider operator) and adds the gate, approval policy, onboarding, clock and retention rows. `docs/pilot/SECURITY_POSTURE.md` states what is and is not protected, the deployment assumptions, key custody, witness, backups, network/TLS (loopback by default; TLS at the proxy; outbound `https://` only), credentials, and the pilot threat model: **PILOT-1 … PILOT-25** — 14 BLOCKED, 8 MITIGATED, 1 ACCEPTED, 2 DEPLOYMENT — plus the two defects F1, F2 (BLOCKED, fixed). THREAT_MODEL_V1 §7.37 carries them; every BLOCKED row names executable evidence in the CORE-06 matrix (TM-7.37-1 … 16).

## 12. The drills

### 12.1 Process boundaries and what the harness may do

`tests/pilot/prod03-clean-room-drill.test.mjs` runs four real processes: the **Host** (`tests/pilot/fixtures/drill-host.mjs` — the launcher's preflight, `bootEnterpriseHost()`, listen and graceful SIGTERM, from a **staged release** with a recorded identity, plus one embedder adapter: the documented `executionAdapters` seam every CTRL qualification uses), the **reference witness** (`scripts/run-reference-authority-state-witness.mjs`), the **web console** (`scripts/run-control-plane-web.mjs`) and the **reference target** (`tests/pilot/fixtures/reference-target.mjs`), which counts every effect it performs, so "exactly one effect" is what another process saw. Why an embedder adapter: the Generic HTTP adapter refuses loopback and private destinations by design; its mapping and transport are qualified by their own suites, and the reference template routes to it. The harness creates directories, writes configuration before boot (and once more as the supported operator-onboarding change, followed by a restart), generates secrets with the supported generator, sends HTTP, drives the console as a script-free browser, runs the documented CLIs (preflight, readiness, backup, restore) and runbook blocks. It never opens a database, imports a store or service, edits source or configuration mid-run — proven structurally (`prod03-pilot-structure.test.mjs`, SEC-INV-315).

### 12.2 Phases and results

| Phase | Proven |
| --- | --- |
| A deploy | secrets from the generator (a second run refused); the reference template with one route substitution; preflight `PASS` with `build=release`; witness, target, Host started; `/live`, `/ready` 200; `/version` the staged commit; gate **deployment-ready**, organization `PR-07 ORGANIZATION_NOT_BOOTSTRAPPED`; no secret in any output |
| B organization | wrong credential 401, provisioner 403, smuggled organization 400; bootstrap `provisioned` by `operator:ops-admin`; exact replay `replayed`; conflicting bootstrap 409 `recorded: false`; profiles promoted by the steward (a provisioner refused); approver standing provisioned; gate **organization-ready** |
| C agent | owner and agent; credential revealed once (replay `bearerCredential: null`); bounded standing authority (`replicaCount ≤ 3`, `strategy = rolling`); onboarding `assigned`; the console signs in and shows the agent and its bounds |
| D execution | in bounds → **exactly one effect** at the target, its execution id and parameters; over the bound `PARAMETER_AUTHORITY_EXCEEDED` and the wrong strategy → **zero effects**; activity lists it; ASSURE traces (success, over-bound) **verified** by an evidence key that can neither act nor administer |
| early backup | cold backup by the CLI on a stopped Host, kept for the stale-restore proof |
| E approval | a production deploy withheld by `approval`, zero effect; approved **through the web console** on the canonical subject digest; the same request resumes and executes **once**; a second rejected over the API never executes; trace verified |
| F emergency | a responder stops everything: withheld by `emergency-control`, zero effect, `/ready` unchanged, gate `PR-13 EMERGENCY_STOP_ACTIVE` (not-ready); a responder cannot release (403); the administrator releases; execution returns |
| G revocation | delegation revoked by a responder → denied, zero effect, gate `PR-11 NO_STANDING_AUTHORITY` with the deployment still ready; a replacement delegation to the same agent is **shadowed** (`AUTHORITY_CAPABILITY_REVOKED`, zero effect — pinned residual); re-onboarded as a new identity → executes; the revoked identity stays denied; rotation: the replaced credential 401, the rotated one executes |
| restart | SIGTERM exit 0 with `shutdown_complete`; organization, operators, profiles, agent, revocation, credentials and evidence identical (same trace digest); **no duplicate effect** |
| H backup | cold, complete, cold-attested; **no generated, issued or provider secret in any byte** of any file; no witness file |
| I restore | state directory destroyed; `restore:v1` from the backup alone; secrets re-supplied; the surviving witness; every trace digest identical and verified; **zero effects replayed**; revocation and rotation intact; gate **pilot-ready** with backup, restore report and acknowledgement; record written (0600) and then accepted alone (`source: qualification-record`) |
| stale restore | the early backup restored into a fresh directory against the surviving witness: the Host **refuses** (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`), never listens, value-free; zero effects; the live deployment unaffected |
| handoff | two operators added by configuration (`--secrets-only`, config check, restart); the record **invalidated** by the change; the second team runs **all 27 onboarding-runbook blocks as written**: bootstrap blocks safe to repeat (`replayed`), profile promotion, agent onboarding with one-time delivery (the issuing response deleted, header file 0600), bounded authority, its own approver standing, approval and rejection, evidence, rotation, revocation, offboarding — exactly the expected effects; organization-ready; their own cold backup |
| J incidents | **witness down**: an anchored revocation `503 AUTHORITY_STATE_UNAVAILABLE`, `recorded: false` (F2); `/health` degraded, `/live` and `/ready` 200, gate `PR-04 WITNESS_UNAVAILABLE` (deployment not ready); a governed request under existing authority **still executes** (CORE-07 serves existing authority against the floor established at startup and refuses only anchored mutations) — so during an outage the witness-independent emergency stop is the way to halt execution, as OPERATIONS_RUNBOOK §9 says; the witness restarted on its own state → recovered, no reset. **Target down**: not executed, nothing performed. **Unconfirmed**: the target performs and never answers → not executed; Attention lists it; established **at the target** by execution id; resolved `confirmed-completed` (`resolution-recorded-no-action-performed`); the agent's same request answers `executed`, `replayed: true` — **no second effect**; trace verified |
| store failures | a corrupt store (scratch restore, bytes overwritten): preflight `STORAGE_UNAVAILABLE`, Host refuses; a missing anchored store: Host refuses; an unwritable directory: preflight `STORAGE_NOT_WRITABLE` (skipped as root); the live deployment healthy throughout |
| K offboarding | delegation, credentials and every agent identity revoked; the agent 401, zero effect; gate organization-ready, `PR-10 NO_PILOT_AGENT`; every trace exported (0700/0600) and verified; final cold backup; every process stops with exit 0; **no secret in any HTTP response (other than its one reveal) or any process output** |
| signer drill | external custody, no private key in the Host's environment, `PR-05` custody=external; one externally signed action; the signer stopped → nothing new signed or performed, `/live` 200, `/health` signer unavailable, gate `PR-05 SIGNER_UNAVAILABLE`; the signer back on its own key → execution resumes, `PR-05` passes |

**Where the drills run.** The two multi-process drills run on their own: `npm run qualify:pilot` and the CI job `pilot-operations` (the six PROD-03 suites, one file at a time). Inside the parallel root suite of `npm test` they skip themselves unless `FRONTERA_PILOT_DRILL=1`: measured on the final tree, with them in the parallel run 3 of 7 full runs had one timing failure in a pre-existing timeout-sensitive suite (PAY-08 `LIFE-3`; CORE-07's enrollment ceremony, a 2 000 ms witness timeout), and without them 2 of 2 were clean. The readiness gate, structure, `approvalPolicy` and witness-outage suites stay in the root suite.

Observed (drill evidence, not an SLA): the clean-room drill takes about 45 s on one machine (four processes, about 30 Host starts and stops, four backups, three restores); the signer drill about 8 s; `npm run qualify:pilot` (all six PROD-03 suites, 119 tests) about 90 s.

## 13. Structural proofs

- **Founder-free / no direct DB** — `prod03-pilot-structure.test.mjs`: the drill sources contain no SQLite, store, service, provisioning or Host-composition reference, no source edit, no git change; only the Host runner imports Host code, from the staged release, through the launcher's entry points; configuration writes are exactly the two supported ones.
- **Tooling boundary** — `scripts/pilot/*` import only `node:` built-ins, the readiness library and the existing preflight; no driver, store, signer, witness, adapter, mutation route or non-`GET` method.
- **No founder-only path** — no pilot document asks an operator to ask someone, edit a database or source, or run an internal helper.
- **NO_BYPASS** — unchanged: eleven of seventy-two effect paths bounded-grant controlled. PROD-03 adds no effect path: the gate reads, `approvalPolicy` composes policy, the drill's adapter lives in `tests/` and is reached only through the Host's trusted registry. `no-bypass-effect-paths.test.ts` passes unchanged.
- **API freeze** — unchanged, 65 endpoints; no route added.

## 14. Security invariants and mutations

SEC-INV-313 … SEC-INV-319 (`SECURITY_INVARIANTS.md` §4.32). Mutation campaign on the delivered code (`docs/security/evidence/prod03-mutation-evidence.json`): **25 of 25 killed**, bytes restored and re-hashed after each:

| Id | Mutation | File | Killed by |
| --- | --- | --- | --- |
| M-PILOT-1 | readiness ignores witness failure | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-2 | readiness ignores signer failure | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-3 | readiness CLI prints the credential it reads | `scripts/pilot/pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-4 | the drill harness writes a store directly | `tests/pilot/fixtures/drill-lib.mjs` | `prod03-pilot-structure.test.mjs`, `pilot-operations-docs.structure.test.mjs` — killed |
| M-PILOT-5 | readiness ignores an active emergency stop | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-6 | a revoked delegation still counts as standing authority | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-7 | a regressed (stale-restored) store is called ready | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-8 | a backup holding a credential is accepted | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-9 | the diagnostic sends a mutating method | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-10 | the qualification reaches the Host through an internal bypass | `tests/pilot/fixtures/drill-host.mjs` | `prod03-pilot-structure.test.mjs`, `pilot-operations-docs.structure.test.mjs` — killed |
| M-PILOT-11 | readiness survives an insecure posture | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-12 | offboarding leaves the gate counting revoked agents | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-clean-room-drill.test.mjs` — killed |
| M-PILOT-13 | a qualification record satisfies a live check | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-14 | a release change does not invalidate the record | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-15 | approvalPolicy compiles a non-restrictive effect | `src/enterprise/host/approval-policy.ts` | `prod03-approval-policy-host.test.js` — killed |
| M-PILOT-16 | two policy sources are composed silently | `src/enterprise/host/enterprise-host.ts` | `prod03-approval-policy-host.test.js` — killed |
| M-PILOT-17 | a revocation the witness refused surfaces as a generic failure | `src/enterprise/authority-administration/service.ts` | `prod03-witness-outage-revocation.test.js` — killed |
| M-PILOT-18 | a freshness integrity failure is reported as an outage | `src/enterprise/authority-administration/service.ts` | `prod03-witness-outage-revocation.test.js` — killed |
| M-PILOT-19 | readiness levels are not cumulative | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-20 | a missing preflight passes | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-21 | the config scan misses private keys | `scripts/pilot/scan-pilot-config.mjs` | `prod03-pilot-structure.test.mjs`, `pilot-operations-docs.structure.test.mjs` — killed |
| M-PILOT-22 | a runbook block teaches sending a request again | `docs/pilot/ONBOARDING_RUNBOOK.md` | `prod03-pilot-structure.test.mjs`, `pilot-operations-docs.structure.test.mjs` — killed |
| M-PILOT-23 | approvalPolicy accepts a profile that declares no approval | `src/enterprise/host/approval-policy.ts` | `prod03-approval-policy-host.test.js` — killed |
| M-PILOT-24 | a degraded Host passes without an accepted module | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |
| M-PILOT-25 | a restore drill of another backup is accepted | `scripts/pilot/lib-pilot-readiness.mjs` | `prod03-readiness-gate.test.mjs`, `prod03-pilot-structure.test.mjs` — killed |

## 15. Residuals

Carried, not fixed (none blocks a serious pilot):

1. **Bearer-secret operators** — no SSO, MFA or rate limiting (PROD-04).
2. **Software key custody in the qualified kit** — AA-001; accepted in writing through the acknowledgement; external custody supported and drilled.
3. **Non-anchored state rolls back with a restore** (PROD-02) — emergency stops, credential revocations, profile lifecycle, Kernel Authority changes, exercise consumption; re-applied by runbook.
4. **A revoked delegation shadows a replacement** whose id sorts after it (deterministic lineage selection, CTRL-02). Fail-closed; the supported recovery is re-onboarding as a new identity. Changing lineage selection is a CORE change outside PROD-03.
5. **The qualification record is unsigned** (ASSURE-02 not landed).
6. **The web console is not in the pilot image** — it runs from the release checkout.
7. **Policy beyond `approvalPolicy`** is in-process embedding.
8. **The drill's adapter is an embedder adapter**, because the Generic HTTP adapter refuses local targets by design; Generic HTTP is qualified by its own suites and the pilot proves its own target end to end (A5).
9. **The kit's Docker qualifications** (D1–D15, O1–O16) run in CI; the process drill is the full-life-cycle proof.
10. Inherited and unchanged: control-plane store not witnessed (PROD-02); evidence integrity not authenticity (ASSURE-01/02); approval SOD is actor-level (CTRL-04 R-8); one Host per organization; no HA.

## 16. PILOT READY determination

| Can a real organization … without founder source or database intervention? | Answer | Evidence |
| --- | --- | --- |
| deploy | **yes** | kit + preflight (PROD-03-03, D1–D15); drill A |
| bootstrap | **yes** | ONBOARDING §4; drill B; handoff |
| onboard operators | **yes** | configuration + generator; handoff |
| onboard an agent | **yes** | ONBOARDING §6; drill C; handoff |
| assign authority | **yes** | ONBOARDING §7; drill C/D; handoff |
| execute | **yes** | drill D (one effect at a separate target) |
| approve | **yes** | `approvalPolicy` (F1); drill E through the console; handoff |
| revoke | **yes** | drill G, K; handoff |
| stop | **yes** | drill F |
| observe | **yes** | readiness gate; drill A, B, F, G, I, J, K |
| obtain evidence | **yes** | drill D–K traces verified; auditor key |
| backup | **yes** | drill H, handoff, K |
| restore | **yes** | drill I; stale refused |
| recover | **yes** | drill J, store failures, signer drill |

Every §11.3 requirement holds: GOVERNANCE CORE STABLE items 1, 2, 4, 5, 7, 8 (CORE-06, achieved), item 3 delivered (CORE-02) though not required; PROD-01 and PROD-02; CTRL-01 … CTRL-04; ASSURE-01; and PROD-03 — runbooks, provisioning path, observability minimum, security posture / shared responsibility and readiness gate — qualified above. **PILOT READY: ACHIEVED.**

## 17. Validation

Working copy, native-Linux LF tree (the baseline exported with `core.autocrlf=false`, overlaid with the branch normalized to LF; 0 CRLF files), Node 22.23.1:

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run build`, `npm run lint` | green |
| root tests (`node --test` over `dist` and `tests/`) | **11 269 tests: 11 256 pass, 0 fail, 9 skipped, 4 todo** (the first full run had 1 failure, PAY-08 `LIFE-3`, under the full suite's parallel load; it passes 3 / 3 alone and the whole suite passed on the next run — recorded, not hidden) |
| workspace tests (35 packages) | **1 103 / 1 103** |
| `npm run qualify:pilot` | **PASS** — 119 tests across the six PROD-03 suites; every drill phase |
| PROD-03 focused | clean-room drill 16 / 16, signer drill 2 / 2, readiness gate 57 / 57, pilot structure 16 / 16, approval policy 19 / 19, witness-outage revocation 9 / 9 |
| CTRL-01 … 04, CORE-06 matrix and invariants, NO_BYPASS, structural boundaries | green (185 in the focused CTRL-01/structure/NO_BYPASS run; CORE-06 matrix with TM-7.37-1 … 16; security invariants) |
| PROD-02, PAY-01 … 09, TRADE-00 … 03, ASSURE-01, CORE-07, CORE-08 | green inside the root suite |
| `npm run legal:check` | report mode, pre-existing findings only; no dependency added |
| `validate:invalid-imports`, `validate:publishability`, `check:protocol-consumption`, `check:protocol-contract-adoption`, `check:protocol-compatibility-lock`, `check:protocol-canonicalization` | green |
| protocol tarball (`validate-enterprise-against-protocol-tarball.mjs vendor/aoc-protocol-0.2.0-rc.1.tgz`) | green (`protocol:tarball:verify-lock` needs a `build-result.json` from building `@aoc/protocol` from its own source, outside this repository; the lock is verified by `check:protocol-compatibility-lock`) |
| `check:runtime-state`, `check:runtime-persistence`, `check:runtime-federation`, `check:runtime-vault`, `check:aoc-boundaries`, `check:release-integrity` | green |
| `check:clean-room-consumer` | green |
| `check:release-coherence` (manifest + API freeze), `check-release-docs`, `check-sdk-surface` | green — the release manifest matches the build (its stale endpoint count was regenerated by PROD-03-03); API freeze **65** endpoints, none added |
| `check:portability-smoke` | green |
| mutations | **25 / 25 killed** |

The Docker qualifications (`qualify:pilot-deployment` D1–D15, `qualify-pilot-acceptance.mjs` O1–O16) and the clean-export run of the final commit are reported, with the exact commit, in the milestone report and the pull request.
