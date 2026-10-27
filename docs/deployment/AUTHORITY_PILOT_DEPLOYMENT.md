# Frontera Authority — synthetic pilot deployment plan (AUTH-04D2A)

**Status:** a plan and a CI-qualified configuration kit (`deploy/authority-pilot/`).

- **Nothing created:** no cloud resource, DNS record, certificate, secret or invitation exists. Nothing was deployed.
- **Activation:** AUTH-04D2B, only after the founder's approval (§11).

**Scope:** a **synthetic-only** demonstration with:
- one synthetic organization;
- one explicitly provisioned test CTO;
- one long-running Host;
- one independently hosted CORE-07 witness;
- the existing evidence-free reference policy;
- an executor that cannot reach anything.

It is not a customer production system, and nothing here accepts the irreversible-loss risks for real-world operations (§12).

## 1. Verified baseline (2026-10-27)

- **Main:** `8f5472e` (AUTH-04D1R merged).
- **Open PRs:** none touch deployment (#221, #164, #141 and #96 are unrelated).
- **Reused, not duplicated:** the PROD-03 pilot kit, with its pinned-digest `Dockerfile`, `deploy/pilot/compose.yaml`, preflight, readiness gate, secret generator and CI qualifications (`pilot-deployment`, `pilot-acceptance`, `pilot-operations`), together with the AUTH-04D1 ingress contract and the AUTH-04C web client.
- **No existing pilot infrastructure:** none is deployed and no repository file describes any. The `infrastructure/` folders are empty placeholders.

## 2. Topology

```
                     Internet (HTTPS)
                            │
 ┌──────────────── HOST machine (one VM, one organization, one process) ─────────────────┐
 │ nginx (OS package)  :443 authority.frontera-systems.com   :80 → redirect / ACME only  │
 │   /authority/v1/*  ─────► 127.0.0.1:8788  Authority gateway  ┐                         │
 │   everything else  ─────► /srv/frontera-authority-web        │ Frontera Host container │
 │                                                              │ (PROD-03 image)         │
 │ 127.0.0.1:8787  main listener: operator plane, health ◄─ SSH tunnel only (founder)     │
 │ /var/lib/frontera  ← replicated block-storage volume: every store + human-identity     │
 └───────────────────────────────┬─────────────────────────────────────────────────────────┘
                                 │ HTTPS, pinned witness key, bearer credential
 ┌───────────────── WITNESS machine (separate VM, separate region) ──────┐
 │ nginx :443 <witness name>, allow-list = Host machine only             │
 │   /v2/*  ─────► 127.0.0.1:8444  reference witness container           │
 │ /var/lib/frontera-witness ← its own replicated block-storage volume   │
 └────────────────────────────────────────────────────────────────────────┘
 Off both machines: sealed backups (object storage), secret manager, DNS, monitoring.
```

- **Execution model:** long-running containers under Docker Compose. Never serverless (§17 of `PILOT_DEPLOYMENT.md`); the Host and the identity store keep process and SQLite state.
- **Configuration files:**
  - **Host, stage 1:** `deploy/pilot/compose.yaml` + `deploy/authority-pilot/compose.host.yaml`. The authority is **disabled**.
  - **Host, stage 2 (cutover):** `+ deploy/authority-pilot/compose.authority.yaml`. Removing it disables the authority again.
  - **Witness:** `deploy/authority-pilot/compose.witness.yaml`.
- **Synthetic-only by construction:** the policy (`governed-actions.synthetic-pilot.json`) is the reference pilot policy with its one executor pointed at `https://synthetic-executor.invalid`.
  - `.invalid` never resolves (RFC 6761), and the generic adapter refuses loopback, private and non-https targets anyway.
  - Every approved execution is recorded as **failed, nothing transmitted** (`PROVIDER_UNAVAILABLE`), which is the execution evidence the runbook inspects.
  - There is no provider credential to hold.

## 3. Infrastructure options (prices checked 2026-10-27 on the providers' own pages unless marked)

| | **A. DigitalOcean** | **B. AWS Lightsail** | **C. Hetzner Cloud** |
|---|---|---|---|
| Host | Basic Droplet 2 GiB / 1 vCPU / 50 GiB, **$12.00/mo** | Linux bundle 2 GB / 2 vCPU / 60 GB, **$12/mo** | Shared vCPU, ~€3.49–6.49/mo **(UNVERIFIED: repriced twice in 2026; sources disagree)** |
| Witness | Basic Droplet 1 GiB / 1 vCPU / 25 GiB, **$6.00/mo**, another region | Linux bundle 1 GB / 2 vCPU / 40 GB, **$7/mo**, another region | Smallest shared vCPU, another location **(UNVERIFIED)** |
| Durable volumes (10 GiB each) | Volumes **$0.10/GiB/mo** (tiers 100 GiB = $10) → ~$2/mo; Ceph, "replicated across multiple hosts" within one datacenter | Block storage **$0.10/GB/mo**, min 8 GB → ~$2/mo; "highly available" (replication not described) | Volumes ~€0.05/GB/mo **(UNVERIFIED)** |
| Snapshots / backups | Volume snapshots **$0.06/GiB/mo**; Droplet backups **20% weekly / 30% daily** | Snapshots **$0.05/GB/mo** | Backups 20% **(UNVERIFIED)** |
| Sealed-backup storage | Object storage **(price UNVERIFIED)** | S3 **(price UNVERIFIED)** | Object storage **(UNVERIFIED)** |
| TLS | Let's Encrypt via certbot on each VM (no cost) | same | same |
| Private connectivity | VPC within a region **(UNVERIFIED)**; the witness in another region is reached over the internet (TLS, allow-list, token, signed receipts) | same pattern | same pattern |
| Secret storage | No managed secret store relied on: founder-held password manager with MFA, and `.env` rendered at start **(founder choice)** | AWS Secrets Manager available **(price UNVERIFIED)** | none relied on |
| **Recurring estimate** | **Approximately US$20/month for the verified compute and volume components only. Partial estimate, not a complete operational quote.** (2 Droplets + 2 small volumes.) Excluded, unverified: object storage, VPC, snapshots and backups, monitoring, bandwidth beyond the allowance, taxes | **≈ $21/mo verified**, plus S3 and optional Secrets Manager (unverified) | ≈ €12–20/mo, **all unverified** |
| Operational complexity | Low | Low–medium (AWS account and IAM hygiene) | Low |
| Failure domains | Host and witness in **different regions**; each volume replicated inside its datacenter | Different regions; volume within one Availability Zone | Different locations |
| Recovery limits | Volume replication covers disk failure, **not** deletion, corruption, account compromise, or F2/F3 (§6) | same | same |

**Recommendation:** **A**. It is the lowest *verified* cost, with an explicit replication statement for its volumes and the simplest operations. Choose **B** if a managed secret store and AWS account controls matter more than a few dollars. **C** is cheapest on paper, but its 2026 pricing could not be verified. No option claims resilience it does not have: one Host and one witness, no failover.

## 4. Exact infrastructure inventory (to be created only at AUTH-04D2B)

| # | Item | Size / setting | Purpose |
|---|---|---|---|
| 1 | Host VM | 2 GiB RAM, Ubuntu 24.04 LTS, Docker Engine and Compose plugin **2.24 or later** (the Host overlay's `!reset`), nginx and certbot from the distribution | Host, gateway, ingress |
| 2 | Host volume | 10 GiB block storage, ext4, mounted for the `frontera-state` volume | every store, including `human-identity.sqlite` |
| 3 | Witness VM | 1 GiB RAM, Ubuntu 24.04 LTS, another region, same packages | reference witness and its TLS |
| 4 | Witness volume | 10 GiB block storage, mounted at `FRONTERA_WITNESS_DATA_DIR` | witness database and receipt key |
| 5 | Firewall (Host) | in: 443, 80 from anywhere; 22 from founder addresses only; out: 443, DNS, NTP, package mirrors | — |
| 6 | Firewall (Witness) | in: 443 from the Host VM only; 80 for ACME; 22 from founder addresses only | — |
| 7 | DNS | `authority.frontera-systems.com` A/AAAA → Host VM; `<witness name>` → Witness VM (a name under the founder's domain, not published anywhere) | — |
| 8 | Certificates | Let's Encrypt, HTTP-01, auto-renew (certbot timers) | — |
| 9 | Object storage bucket | private, versioned, write-only credentials on the Host | sealed backups |
| 10 | Secret store | password manager vault (or a managed store under B) | §7 |
| 11 | Monitoring | an external HTTPS uptime check on `/`, and a Host-local health check (§9) | — |

## 5. Networking and ingress (public surface)

**Reachable from the internet:**

| Machine | Path | Purpose |
|---|---|---|
| Host :443 | `/`, `/index.html`, the static assets | the web client (CSP, HSTS, no CORS) |
| Host :443 | `/authority/v1/session`, `session/login/options`, `session/login`, `session/logout` | passkey sign-in |
| Host :443 | `/authority/v1/enrolment/options`, `enrolment` | invitation-bound registration |
| Host :443 | `/authority/v1/approvals`, `approvals/:id`, `approvals/:id/decision-challenges` | the human's eligible inbox and decisions |
| Host :443 | `/authority/v1/decisions`, `decisions/:commitment` | decision submission and status |
| Host :80 | redirect, ACME | none other |
| Witness :443 | `/v2/*` | the Host machine only (allow-list and firewall) |

**Never reachable from the internet:**
- the Host's main listener `127.0.0.1:8787` (operator plane, CTRL-02/04, passkey invitations, `/health`, `/ready`, governed actions), reached by the founder through `ssh -L 8787:127.0.0.1:8787`;
- the gateway's own port;
- the witness port;
- databases, signing keys, the backup store and secrets.

**Enforced in configuration and qualified in CI** (`authority-pilot-config` job):
- one TLS name, and another Host or SNI is closed;
- the Host header is preserved, and Origin, Cookie, CSRF and Authorization pass through unchanged, so the gateway's own 421, 403 and 400 checks stand;
- no CORS, and preflight is refused;
- bodies up to 64 KiB (413 beyond);
- per-IP limits: sign-in 10/min (burst 5), enrolment 5/min (burst 3), API 120/min;
- the client's exact security headers, including HSTS;
- the log line holds only time, IP, method, path, status and size.

No browser-held operator bearer, no administrative self-registration, and no route to the operator plane exist.

## 6. Persistent storage and witness design

- **Host:** one volume for every store (PROD-02 registry layout). The identity store appears only after cutover. The volume is replicated by the provider inside one datacenter.
- **Witness:** its own VM, region and volume, with no shared snapshot schedule. Its state must never be lost or rolled back: a stale copy reads as a fork and is refused. Durability comes from the replicated volume only.
- **Initialization is split** so that neither machine sees the other's private key:
  - the witness runs `witness-init` (`--witness-only`), which keeps its receipt key and prints its id, token and public key;
  - the Host runs `authority-init` (`--authority-only`), which prints the signing key, the verification set and the operator credentials, and refuses a second run.
  - The Host project cannot generate or reach a witness key: `compose.host.yaml` removes the inherited PROD-03 `witness-init` and `authority-witness` services and the `frontera-witness` volume (`!reset null`), so `run witness-init` answers "no such service" under any profile. CI checks every resolved Host-side service, tools included, and proves that the overlay without this removal is refused.
- **Backups:** `npm run authority-pilot:backup` (sealed, cold, verified; AUTH-04D1) at every planned stop, uploaded to the private bucket, with the backup key held in the secret store and never in the bucket.
  - A backup is restorable only until the next witnessed transition (any sign-in, enrolment, revocation or decision).
  - It serves migration and maintenance, **not** disaster recovery.

## 7. Secret inventory (names only; no value exists yet)

| Secret | Where generated | Held by | Used by |
|---|---|---|---|
| `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` (+ `_ID`) | Host, `authority-init` | secret store, rendered into `deploy/pilot/.env` at start | Host |
| `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS` | Host, `authority-init` | configuration (public) | Host, restore |
| `FRONTERA_OPERATOR_KEY_ADMIN`, `_PROVISIONER`, `_STEWARD`, `_APPROVER`, `_RESPONDER`, `_OBSERVER` | Host, `authority-init --secret …` | secret store; the founder uses ADMIN and OBSERVER over the SSH tunnel only | operator plane |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN` | Witness, `witness-init` | secret store; both machines' `.env` | Host → witness |
| Witness receipt private key | Witness, `witness-init` | witness volume only | witness |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID`, `_WITNESS_PUBLIC_KEY` | Witness, `witness-init` | configuration (public) | Host pins them |
| Backup key | `authority-pilot:backup keygen` | secret store only | backup and restore |
| TLS private keys | certbot on each VM | each VM's `/etc/letsencrypt` | nginx |
| Cloud, DNS and registrar accounts; SSH keys | founder | founder, with MFA | — |
| Passkey | the CTO's iPhone (Secure Enclave or iCloud Keychain) | the CTO | WebAuthn |

No secret is committed, logged, printed by the Host or the ingress, or sent to a browser.

## 8. Failure and shutdown settings (AUTH-04D1R)

| Setting | Value | Why |
|---|---|---|
| Witness request timeout | **2000 ms** | cross-region round trips are well under it |
| Witness attempts | **1** | each call is bounded; no hidden retry window |
| Witness interactions | sign-in 3, enrolment 3, decision **≤ 9** (three witnessed transitions × finalize-outstanding, prepare, finalize) | — |
| Worst case of one decision | 9 × 2 s × 1 = **18 s** | — |
| `AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS` (HTTP drain and authority drain) | **20000** | above 18 s: a healthy write is never cut |
| Compose `stop_grace_period` (supervisor) | **75 s** | at least 2 × 20 s (two drains) + 35 s for modules and margin, so a stop is never a `SIGKILL` |

All of these are fixed in the overlay and checked in CI.

- **A lost witness answer (F2):** the write fails, and the next write or start is `PENDING_RECOVERY`. Human authority stays unavailable; the operator plane continues. No ceremony exists to resolve it.
- **Host restart:** sessions are lost (sign in again); in-flight decisions drain on a graceful stop; consumed-but-unsettled decisions are reconciled at start.
- **Backups:** sealed and cold at planned stops; a restore of an older one is refused by the witness by design.

## 9. Monitoring and logs

- **Public uptime check:** an external HTTPS check on `/` (the static client).
- **Host-local health check:** a cron script on the Host VM reads `http://127.0.0.1:8787/ready` and alerts the founder on failure or on `authorityFreshness` status `pending-recovery` or `unavailable`.
- **Daily review:** the founder reads `docker compose logs frontera` for `enterprise.human_authority.drain_incomplete` and `enterprise.host.refused`.
- **nginx logs:** the minimal format, on each VM.

## 10. CTO pilot runbook

**[F]** = founder-controlled infrastructure step; **[CI]** = already qualified automatically; **[V]** = a verification the founder performs on the live pilot.

1. **[F] Provision** the inventory in §4 (option A). Attach and mount the volumes. Install Docker, nginx and certbot from the distribution. Harden SSH (keys only, founder addresses). Apply the firewalls.
2. **[F] Domains and TLS:**
   - create the two DNS names;
   - install `deploy/authority-pilot/nginx/*` as each file's header states;
   - set the witness host name in `witness.conf`;
   - add the Host VM address to `witness-allowlist.conf`;
   - run `certbot certonly --webroot -w /var/www/frontera-acme -d <name>` on each VM;
   - run `nginx -t`, then reload.

   **[CI]** The configuration is qualified by `authority-pilot-config`.
3. **[F] Initialize:**
   - **witness:** build the image at the approved commit; `cp witness.env.example .env.witness`; set the data directory; `docker compose … run --rm -T witness-init` into the secret store; set the id and token; `up -d`;
   - **Host:** build the image at the same commit; `cp host.env.example deploy/pilot/.env`; set the witness values and the organization id; `docker compose … run --rm -T authority-init --secret FRONTERA_OPERATOR_KEY_ADMIN … --secret FRONTERA_OPERATOR_KEY_OBSERVER` into the secret store; render `.env`; `run --rm config-check`; `up -d` (stage 1).
4. **[V] Signed storage and freshness:**
   - `pilot-readiness --require deployment` passes;
   - over the tunnel, `/health` shows `authorityFreshness` with every slot `ready`;
   - the witness's log shows enrolled slots.
5. **[F] Synthetic policy:** it is already mounted (stage 1). Activate the `deploy-production` profile over the operator plane (steward). Give the CTO's operator id (`ops-approver`) Kernel-Authority standing for `approve-deploy` on `production-cluster` only.
6. **[F] Cutover** (after §11): add `compose.authority.yaml`; set `FRONTERA_AUTHORITY_INITIALIZE_IDENTITY=true` in `.env` for **one** start; set it back to `false` at once; restart. The posture shows `humanAuthority: composed`. Provision the test human: `POST /api/admin/passkey-humans {operatorId: "ops-approver", displayName}` (organization administrator, over the tunnel).
7. **[F] One-time invitation:**
   - `POST /api/admin/passkey-invitations`; the token is shown once and lives 15 minutes;
   - hand it to the CTO in person;
   - revoke it if it is exposed or late.
8. **[V] Register** on the iPhone: Safari, `https://authority.frontera-systems.com`, "Register with an invitation", Face ID. Confirm the credential with `GET /api/admin/passkey-humans/ops-approver`.
9. **[V] Sign in** explicitly; registration creates no session.
10. **[F] A synthetic action:** a synthetic agent, onboarded per `docs/pilot/ONBOARDING_RUNBOOK.md`, requests `deploy-release` on `production-cluster` (synthetic). The CTO opens it and checks the summary, the canonical subject and the digest badge.
11. **[V] Approve** with a fresh Face ID assertion. The result shows the Host's outcome, with execution "not observed".
12. **[V] CORE-05 verdict:** over the tunnel, check `GET /api/admin/approvals/:id` (observer): one verdict, citing the passkey decision evidence.
13. **[V] Execution evidence:** the agent's retry returns the governed result, which is **failed, nothing transmitted** (the `.invalid` executor). Check the evidence bundle and the execution outcome over the operator plane. No external effect exists to inspect, by construction.
14. **[V] Rejection and status recovery:** a second request is rejected. Turn on airplane mode mid-submission, then use "Check status"; it reads the authoritative state and never resubmits.
15. **[F] Shutdown and restore drills:**
    - `docker compose stop` (drain, 75 s grace);
    - `authority-pilot:backup backup`, then `verify`;
    - restore into a fresh directory and start; it is ready;
    - sign in once, then restore the same backup again; it is **refused** (`ROLLBACK_DETECTED`), and the witness is untouched;
    - return to the newest data.

**[CI]**, already qualified on every PR:
- the authority flows with software authenticators (AUTH-04B, 04B2, 04C);
- the drain (AUTH-04D1R);
- the backup and restore and CORE-07 refusals (AUTH-04D1);
- the Compose and ingress configuration (AUTH-04D2A).

## 11. Founder approval checklist for cutover (all must be ✓; none is pre-checked)

| Gate | Evidence |
|---|---|
| Environment isolation | Host and witness in different regions, separate volumes and accounts or projects; synthetic organization id; synthetic policy mounted (`compose host` check) |
| TLS and RP ID | valid certificates; `curl -I https://authority.frontera-systems.com` shows HSTS; the posture's RP ID equals `authority.frontera-systems.com` |
| Cookie security | after sign-in on the iPhone, the session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict` (Safari Web Inspector) |
| Privileged API exposure | from outside, `/api/admin/*`, `/health`, `/ready` and `:8787` return 404 or are unreachable; the witness is unreachable from anywhere but the Host |
| Witness availability | `/health` freshness `ready`; one deliberate witness stop refuses identity writes, and recovery is automatic |
| Identity persistence | a Host restart keeps the passkey; sign-in works after restart |
| Secret handling | no secret in git, image, logs or `docker inspect` output; `.env` mode 600; the backup key is not in the bucket |
| Ingress rate limiting | 429 on the 7th rapid sign-in POST (the `authority-pilot-config` check, repeated live) |
| Backup verification | `authority-pilot:backup verify` passes on the uploaded file |
| Rollback refusal | the §10 step 15 stale restore is refused |
| Host restart | a graceful stop logs `drained`, never `drain_incomplete` |
| Synthetic-only execution | step 13 shows "nothing transmitted"; the egress firewall allows only 443 to the witness, DNS, NTP and mirrors |
| Security scanning | the CI and CodeQL of the deployed commit are green; `apt` updates applied; the image is built at that commit |

## 12. Known risks and limitations (analysis only; not accepted for real-world operations)

- **F2, a lost witness response,** and **F3, a crash between the witness and the local commit:** the identity store becomes `PENDING_RECOVERY` with no resolving ceremony.
- **F5, permanent identity-volume loss,** and **F6, permanent witness-state loss:** human authority becomes permanently unavailable for that organization at that witness.
- **No re-founding ceremony is authorized.** Volume replication reduces disk-failure loss but does **not** resolve F2, F3, deletion, corruption or account compromise.
- **Single points of failure:** one Host and one witness, with no failover. Cold backups need a stop, and they are restorable only until the next witnessed transition.
- **Software custody:** the signing key is resident in the Host process. The bootstrap administrator is a static bearer (over the tunnel only). There is an invitation hand-off interception risk.
- **Approvals cannot carry evidence:** no evidence-requiring profile can be approved by passkey (AUTH-04D1E, Option C).
- **Real-device qualification** is still pending (AUTH-04D3 matrix in AUTH-04D1 §9).

The environment is synthetic-only and cannot produce an external effect; its loss is a demonstration loss.

## 13. AUTH-04D2B activation readiness

**Ready for founder review, not for activation.**
- **Done:** the configuration is CI-qualified, the timings satisfy AUTH-04D1R, and the plan and runbook are complete.
- **Activation requires:**
  - the founder's choice of option (A recommended);
  - authorization to create the §4 resources and DNS names;
  - every §11 gate;
  - explicit founder acceptance that the pilot environment is a demonstration in which F2, F3, F5 and F6 can make human authority permanently unavailable.
