# Frontera Trust Boundaries and Privileged Assets

- Status: canonical. This is the authoritative map of where trust changes hands in Frontera, and of what is worth stealing on either side of each change.
- Established by: Security & Containment Architecture track, Prompt 2.
- Prerequisites: `docs/security/SECURITY_INVARIANTS.md` (what is guaranteed, and where each guarantee stops), `SECURITY_CONTAINMENT_BASELINE_AUDIT.md` (Prompt 0 evidence base).
- Relationship to `docs/security/THREAT_MODEL_V1.md`: that document threat-models the **Enterprise Host** (`src/enterprise`) and explicitly excludes `apps/` and `packages/` (§9). This document covers the **whole repository**, including the surfaces that exclusion left unmapped. Where the two overlap, the threat model remains authoritative on attack analysis; this document is authoritative on *boundary and asset inventory*.

---

## 1. Purpose

`SECURITY_INVARIANTS.md` answers "what does Frontera guarantee, and where does that guarantee stop?" It stops short of two questions a security reviewer asks next:

1. **Where does trust actually change hands?** Every point where data or control crosses from a less-trusted zone to a more-trusted one, what is checked at that point, and what is simply trusted.
2. **What is privileged, and who can reach it?** Every asset whose compromise produces authority, identity, money or silence — where it lives, what protects it, and the blast radius if it falls.

This document answers both, as registers rather than prose, so that a later prompt can point at a row rather than re-derive it.

It is a **map, not a mechanism.** Prompt 2 builds no control. Where a boundary is weak, the row says so and names the prompt that owns it.

---

## 2. Trust Zone Model

A trust zone is a set of code and data that shares a single trust level: anything inside a zone can reach anything else inside it without crossing a checked boundary.

| ID | Zone | Inside the TCB? | Notes |
|---|---|---|---|
| **TZ-0** | **Operator** — environment variables, process user, data directory, composition code | **Yes — root of trust** | `THREAT_MODEL_V1.md` §2.6. Everything below depends on this zone being honest. |
| **TZ-1** | **Enterprise Host process** — `src/kernel`, `src/features`, `src/enterprise`, loaded `packages/` | **Yes** | Single process, single writer. Holds every Enterprise secret in memory. |
| **TZ-2** | **Agent Passport Web process** — `apps/agent-passport-web` (Next.js) | **Yes, and separate** | A *distinct* TCB with its own SQLite, its own secrets, and no shared authorization model with TZ-1. Previously unmapped (SC-006). |
| **TZ-3** | **Authenticated system caller** — unscoped Enterprise API key | Partially | Cross-tenant by design. Compromise is full-API, not store-integrity. |
| **TZ-4** | **Authenticated tenant** — org-scoped Enterprise API key | No | Confined by store-layer tenant scoping. |
| **TZ-5** | **Registry principal** (web app) — buyer account + role, **or** registry admin token | No | Two disjoint mechanisms with different privilege shapes; see TB-015. |
| **TZ-6** | **Unauthenticated network** | No | Reaches TB-001 and TB-011 only. |
| **TZ-7** | **External providers** — Stripe, Pinata | No | Trusted only for signed inbound webhooks (TB-013); outbound calls trust the provider with data. |
| **TZ-8** | **Governed agent** — the actor whose declared actions are evaluated | **No — but not isolated either** | Frontera governs its *declarations*. If agent code runs inside TZ-1 or TZ-2, it inherits that zone entirely (SEC-TRUST-005). **This is the defining gap of the current architecture.** |

### The zone observation that matters most

TZ-8 has no enforced separation from TZ-1/TZ-2. Every other zone boundary in this document is a real boundary with a real check. TZ-8's is a *convention*: agents are assumed to be elsewhere, calling in over HTTP. Nothing enforces that assumption, and SEC-TRUST-004 (voluntary chokepoint) plus SEC-TRUST-005 (no process isolation) are its two halves.

---

## 3. Trust Boundary Register

What crosses, what is checked, what is trusted anyway.

| ID | Boundary | Crossing direction | Checked at the crossing | Trusted without check | Strength |
|---|---|---|---|---|---|
| **TB-001** | Network → Enterprise HTTP adapter (`node-http-adapter.ts`) | TZ-6/3/4 → TZ-1 | Bearer API key, SHA-256 digest comparison of fixed length with all keys always compared (`orchestration/credential-matching.ts:15-16`); 1 MiB body cap; JSON shape validation; percent-encoding validation; idempotency key | **Authentication is off by default** (`AOC_ENTERPRISE_REQUIRE_AUTH`, default `false`) | Strong **when enabled** — DEPLOYMENT-DEPENDENT (SC-001) |
| **TB-002** | HTTP adapter → services | TZ-1 internal | Domain re-validation in services; access context `{system, organizationId}` derived from the key, never from the body | — | Strong |
| **TB-003** | Services → stores (tenant scoping) | TZ-1 internal | Enforced **in the stores**, not only the adapter: `canSeeRecord`, `requireAccessToOrganization`, `requireAssuranceTenantScope` (`sqlite-assurance-store.ts:483,491,587`); non-system context without an org gets a defensive `1 = 0` | — | Strong — a bypassed adapter still cannot cross tenants |
| **TB-004** | Host process → filesystem (3 SQLite files) | TZ-1 → TZ-0 | Schema version verified fail-closed; digests and chains make silent modification detectable on `verify` | **Filesystem writer is outside the software boundary**; ordinary `get` does not re-verify | Detective, not preventive (SEC-TRUST-002) |
| **TB-005** | Enterprise ↔ Kernel | TZ-1 internal, same process | Kernel version stamped per record; results recorded immutably with provenance | Kernel results treated as authoritative | By construction |
| **TB-006** | Kernel → optional capability ports (authority, context, obligation, grant) | TZ-1 internal | Narrowing-only composition; facts-only return types; absent port ⇒ byte-identical behaviour (SEC-INV-002, SEC-INV-006) | — | Strong, TYPE-LEVEL + TEST-ENFORCED |
| **TB-007** | Layer E → `ExecutionAdapter` (bounded-grant exercise) | TZ-1 → TZ-7 | **The strongest crossing in the repository.** Authoritative store re-read, 12 fail-closed checks, 17-field whitelist, no free-form payload channel (SEC-INV-011…015) | The adapter *implementation* is trusted code (SEC-TRUST-006) | Strong — PATH-LOCAL |
| **TB-008** | Sovereign Access → provider adapter | TZ-1 → TZ-7 | Authoritative `EnterpriseAccessGrant` store read + `assertActive` (`access-governance/lifecycle.ts:20`) | **Does not pass through the Kernel or a bounded grant** (SEC-INV-019, SC-002) | Real but *different* model — Prompt 3 decides |
| **TB-009** | Adapter → external provider (Pinata SDK) | TZ-1 → TZ-7 | Provider's own credential (`PINATA_JWT`) | No egress allowlist, no network boundary | Unconstrained egress (SEC-INV-U03) |
| **TB-010** | Operator → composition root / Kernel Authority provisioning | TZ-0 → TZ-1 | `KernelAuthorityProvisioningService` requires `context.system === true` **and** an operator context (`provisioning-service.ts:51-60`); append-only, terminal revocation | **`PolicyPackRegistry.savePack`/`saveVersion`/`activatePolicyPackVersion` carry no caller identity at all** (`policy-pack-registry.ts:81,121,129`) — protected only by not being exposed | Mixed — one island done right, one unguarded |
| **TB-011** | Network → Next.js web app routes (31 routes) | TZ-6/5 → TZ-2 | Per-route: buyer session cookie, registry admin token, or registry role check | No uniform gate; each route decides for itself | Per-route, not centralized |
| **TB-012** | Web app → its own SQLite (`AOC_AGENT_PASSPORT_DB_PATH`, default `.data/agent-passport.sqlite`) | TZ-2 → TZ-0 | Prepared statements | No digest chain, no integrity verification, no append-only discipline | Weaker than TZ-1's stores |
| **TB-013** | Stripe → webhook endpoint | TZ-7 → TZ-2 | `stripe.webhooks.constructEvent` signature verification against `STRIPE_WEBHOOK_SECRET`; fails closed when the secret is unset; replay-protected by `UNIQUE(stripe_event_id)` | — | **Strong — correctly built** |
| **TB-014** | Web app → Stripe API | TZ-2 → TZ-7 | `STRIPE_SECRET_KEY` | No egress allowlist | Unconstrained egress |
| **TB-015** | Registry admin token → registry admin surface | TZ-5 → TZ-2 privileged | `timingSafeEqual` over SHA-256 of a 256-bit random token (`registry-access-token.ts:16-20`); admin access events recorded | **Permanent** (no expiry field), **transported in URL query strings**, and **bypasses the RBAC role model entirely** | Weak transport, strong comparison — SC-018, SC-019 |
| **TB-016** | Governed agent → declared action | TZ-8 → TZ-1 | Recognition, authority, policy, context, obligations — all over the **declaration** | **What the actor actually does is not bound to what it declared** on the `enforce()` path (SEC-INV-010) | Decision-time only |

---

## 4. Privileged Asset Register

An asset is privileged if its compromise yields **authority** (act as someone), **identity** (be believed), **money**, or **silence** (suppress the record).

### 4.1 Secrets

| ID | Asset | Zone | At rest | In memory | Rotation | Blast radius |
|---|---|---|---|---|---|---|
| **PA-001** | `AOC_ENTERPRISE_API_KEYS` | TZ-0 → TZ-1 | Operator env file | Yes, whole process | Restart only | Full Enterprise API; unscoped key ⇒ cross-tenant |
| **PA-002** | `AOC_ISSUER_PRIVATE_KEY_PEM` (an **HMAC secret**, despite the name) | TZ-0 → TZ-2 | env | Yes | Restart only | Forge any Agent Passport (SC-004) |
| **PA-003** | `PASSPORT_SIGNING_SECRET` | TZ-0 → TZ-2 | env | Yes | Restart only | Forge passport payload signatures — a *second*, independent scheme (SC-017) |
| **PA-004** | `STRIPE_SECRET_KEY` | TZ-0 → TZ-2 | env | Yes | Restart only | Full merchant account access — money |
| **PA-005** | `STRIPE_WEBHOOK_SECRET` | TZ-0 → TZ-2 | env | Yes | Restart only | Forge billing events ⇒ forge entitlements |
| **PA-006** | `PINATA_JWT` | TZ-0 → TZ-1 | env | Yes | Restart only | Direct provider access, bypassing every gate |

Every one is process-resident, env-loaded, and rotated only by restart (SEC-INV-U02). None is behind a KMS, a broker, or a scoped accessor in TZ-2.

### 4.2 Authoritative state

| ID | Asset | Zone | Integrity | Durable | Blast radius if rewritten |
|---|---|---|---|---|---|
| **PA-007** | Governance records + hash chain | TZ-1 | SHA-256 per-section + aggregate + `chain_position` linkage | Yes | Destroys the product's core claim: independently verifiable governance |
| **PA-008** | Bounded grants + revocations | TZ-1 | Digest verified at every exercise | **No — in-memory only** | Loss fails closed; a rewrite inside the process grants arbitrary execution authority |
| **PA-009** | Governed authority positions, reservations, encumbrances | TZ-1 | Digest **verified on read, fail-closed** (`sqlite-authority-store.ts:646,671`) | Yes | Fabricate authority an action draws on |
| **PA-010** | Kernel Authority events | TZ-1 | Event-sourced, chained digests | Yes, opt-in | Fabricate actor enrolment |
| **PA-011** | Agent passports + event chains | TZ-1 | Per-event chained digests, contiguous sequence | Yes | Forge agent lifecycle standing |
| **PA-012** | Assurance assessments + frameworks | TZ-1 | Seven section digests; registry frozen before traffic | Yes | Fabricate compliance posture |
| **PA-013** | Evidence bundles | TZ-1 | Bundle/record/verification digests | Yes | Mislead third parties who rely on the digests |
| **PA-014** | Recognition capability tokens, authority graph, approvals | TZ-1 | **None** | **No — in-process `Map`** (`capability-token-service.ts:47`) | Revocation is not durable; a restart can resurrect revoked authority (SEC-TRUST-003) |
| **PA-015** | `emergencyDeny` flag | TZ-1 | — | **No — instance field** | Stop-everything is process-local and invisible to the exercise path (SEC-INV-U05) |
| **PA-016** | Policy packs (`PolicyPackRegistry`) | TZ-1 | — | In-process | Rewrite the rules decisions are made under; **no caller identity on the write methods** |

### 4.3 Web application assets (previously unmapped — SC-006)

| ID | Asset | Zone | Protection | Blast radius |
|---|---|---|---|---|
| **PA-017** | Registry admin access token | TZ-2 | 256-bit random; SHA-256 at rest; `timingSafeEqual`; access events recorded | **Full registry admin, permanently** — enrol agents, manage team, generate/download exports, manage billing (SC-018) |
| **PA-018** | Registry recovery code | TZ-2 | 64-bit random, SHA-256 at rest, **single-use** (`recovery_code_used_at`), rotates the admin token on use | Registry takeover. Single-use + online-only makes 64 bits adequate here; it would not be if the hash leaked. |
| **PA-019** | Buyer account session tokens | TZ-2 | 256-bit random; SHA-256 at rest; `HttpOnly`, `SameSite=Lax`, `Secure` in production; 30-day expiry; revocable individually and in bulk | Account takeover, bounded by role |
| **PA-020** | Buyer password hashes | TZ-2 | **scrypt** (N=16384, r=8, p=1, 16-byte salt, 64-byte key) + `timingSafeEqual` | Offline cracking — **correctly built, no finding** |
| **PA-021** | Web app SQLite (`.data/agent-passport.sqlite` by default) | TZ-2 | Prepared statements only | Holds PA-017…PA-020 plus billing and team state; **no digest chain, no integrity check, no append-only discipline** — unlike every TZ-1 store |

---

## 5. Reachability Matrix

Which zone can reach which asset class *without crossing a checked boundary*.

| Zone | Enterprise secrets | Enterprise authoritative state | Web app secrets | Web app state | External providers |
|---|---|---|---|---|---|
| TZ-0 Operator | ✅ all | ✅ all (can re-seal) | ✅ all | ✅ all | ✅ via any credential |
| TZ-1 Enterprise process | ✅ all | ✅ all | ❌ | ❌ | ✅ direct (no egress control) |
| TZ-2 Web app process | ❌ | ❌ | ✅ all | ✅ all | ✅ direct |
| TZ-3 System API caller | ❌ | via API only, cross-tenant | ❌ | ❌ | ❌ |
| TZ-4 Tenant API caller | ❌ | via API only, org-scoped | ❌ | ❌ | ❌ |
| TZ-5 Registry admin token | ❌ | ❌ | ❌ | ✅ that registry, fully | ❌ |
| TZ-6 Unauthenticated | ❌ | ❌ (unless auth disabled — SC-001) | ❌ | ❌ | ❌ |
| TZ-8 Governed agent **in-process** | ✅ all of its host zone | ✅ all of its host zone | — | — | ✅ direct |

The last row is the finding, not a curiosity: a governed agent that executes inside either host process is indistinguishable from that process. Every protection in rows 3–7 assumes the agent is *outside*.

---

## 6. New Findings

Continuing the `SC-` sequence from the Prompt 0 baseline (which ended at SC-017).

### SC-018 — Registry admin credential is permanent and travels in URLs
- **Severity:** HIGH · **Zone:** TZ-2 · **Asset:** PA-017 · **Boundary:** TB-015
- **Evidence:** `registry-admin-access.ts:50-52` reads the credential from `url.searchParams.get('access_token')`. It is then embedded in **navigable page URLs** returned to users as `registryUrl` / `adminUrl`: `api/account/claim-registry/route.ts:46,59`, `api/agent-passports/route.ts:76`, `api/checkout/session/[sessionId]/route.ts:69`, and consumed by the server-rendered page at `app/registry/admin/page.tsx:20,32`. The registry row carries `admin_access_token_created_at`, `..._rotated_at`, `..._last_used_at` — **and no expiry column**.
- **Risk:** a permanent bearer credential granting full registry administration is written into browser history, bookmarks, shareable links, and server/proxy/CDN access logs. It is valid until someone manually rotates it.
- **Mitigating factors, stated fairly:** the comparison itself is constant-time over a 256-bit token; admin access events are recorded; the admin page renders no external subresource, so `Referer` leakage to third parties is limited; a rotate endpoint and a single-use recovery path both exist.
- **Remediation direction:** move the credential to the existing `aoc_registry_admin_session` cookie path (already implemented alongside it in `verifyRegistryAdminAccess`), keep the URL token as a one-time bootstrap that is exchanged for a session and then invalidated, and give it an expiry.
- **Owner:** the SaaS threat-model prompt Prompt 0 §13 recommended inserting before Prompt 3.

### SC-019 — The admin-token path bypasses the registry role model
- **Severity:** MEDIUM · **Zone:** TZ-5 · **Boundary:** TB-015
- **Evidence:** `registry-role-policy.ts` defines five roles (`owner`, `admin`, `member`, `viewer`, `auditor`) over eleven permissions. `verifyRegistryAdminAccess` returns `{ ok, registryId, via }` — **no role** — so a caller holding the token is neither owner nor admin in the RBAC sense; it is simply ungated.
- **Risk:** two parallel authorization models over one resource, where the weaker one wins. This is the same shape as SC-002 in `src/` (two authority models, one invariant that does not span both), and it should be recorded the same way rather than assumed equivalent.
- **Owner:** same as SC-018.

### Assessed and explicitly *not* findings

Recorded so a later reviewer does not re-open them:

- **Buyer password storage** (PA-020) — scrypt with sound parameters and constant-time comparison. Correct.
- **Stripe webhook ingress** (TB-013) — signature-verified, fails closed on a missing secret, replay-protected by a unique constraint. Correct.
- **Buyer session tokens** (PA-019) — 256-bit, hashed at rest, `HttpOnly`/`SameSite`/`Secure`, expiring, revocable. Correct.
- **Recovery-code entropy** (PA-018) — 64 bits is low in isolation, but the code is single-use, online-only, and rotates the admin token on use. Adequate as built.

---

## 7. Naming Corrections

Two names in `src/` promise more than the code delivers. Both are honestly documented *inside* their files; the risk is that the export names are read without opening them (SC-013, SC-014 from the Prompt 0 baseline).

| Name | What a reader assumes | What it does | Where it is honest |
|---|---|---|---|
| `verifyCapabilityToken`, exported from `src/index.ts:56` and `src/runtime/crypto/index.ts:7` under **`crypto`** | Cryptographic signature verification | Validates token **shape, expiry and revocation-list membership**. Verifies no signature. The trust-domain parameter is explicitly **not enforced**. | `capability-verifier.ts:3-13` says so in full |
| `src/runtime/vault/` | Key custody | A **logical isolation and continuity boundary**. Performs no cryptography; attestations are deterministic fingerprints, not signatures. | `CURRENT_STATE_SOVEREIGN_RUNTIME_VAULT_BOUNDARY.md`: "Attestation is deterministic but not cryptographically signed yet" |

Neither is a vulnerability. Both are recorded here so that a security questionnaire answered from export names alone cannot accidentally overclaim. Renaming is a public-surface change and is deliberately **not** done in this prompt.

---

## 8. What This Document Does Not Do

- It does not threat-model `apps/agent-passport-web`. It inventories that application's boundaries and assets — which is what was missing — but attack analysis, abuse cases and per-route review remain open (SC-006).
- It builds no control. TB-009/TB-014 egress, TB-016 isolation, PA-015 kill switch and PA-001…PA-006 key custody each name an owner prompt and are untouched here.
- It does not renumber or restate `SECURITY_INVARIANTS.md`. Where a row cites `SEC-INV-nnn` or `SEC-TRUST-nnn`, that document remains authoritative.
- It does not resolve SC-002. TB-008 records the Sovereign Access path as a separate authority model; Prompt 3 decides whether to converge it.
