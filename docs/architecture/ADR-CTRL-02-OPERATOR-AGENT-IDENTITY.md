# ADR — CTRL-02: Organizations, Human Operators & Agent Inventory

- **Status:** ACCEPTED (CTRL-02), 2026-10-01
- **Roadmap item:** CTRL-02 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Builds on:** CTRL-01 (`AOC_AUTHORITY_ADMINISTRATION_API.md`), P2 customer principal binding (`AOC_CUSTOMER_PRINCIPAL_BINDING.md`), the durable Kernel Authority (`ADR-DURABLE-KERNEL-AUTHORITY.md`), CORE-03 Governance Profiles (`ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md`), CORE-04's one-organization-per-Host decision
- **Qualification:** `docs/security/CTRL-02-ORGANIZATIONS-OPERATORS-AGENT-INVENTORY.md`

## 1. Context

CTRL-01 made incident response operable over HTTP — inspect, revoke, emergency stop and release — behind a separate administrator credential class. It deliberately refused provisioning: a shared administrator bearer secret with no human identity and no role model is the wrong boundary for *creating* standing authority (Master Plan §9, CTRL-01 "Re-scoped").

Before CTRL-02, a pilot organization still needed source code to operate:

| Gap (discovered on `main @ 3c56a71`) | Where |
|---|---|
| Kernel-Authority provisioning (actors, trust domains, root issuers, passports, capability tokens, authority and delegation grants) was in-process only | `kernel-authority/provisioning-service.ts`; `composition-root.ts` exposes `kernelAuthorityProvisioning` to embedders |
| Customer admission was static: an agent could call `POST /api/governed-actions` only if its key and external subject were written into `customerPrincipals[]` in the governed-action file and the Host restarted | `host-configuration.ts` (`customerPrincipals` ≥ 1, refused otherwise); `customer-identity/admission-service.ts` reads a frozen key list |
| Administrators were named secrets with one implicit power set; no role model | `host-configuration.ts` `administrators[]`; `authority-administration/service.ts` |
| Governance Profiles had a format but no lifecycle: every configured profile was active, "who promoted it" was a string in the file (`provenance.approvedBy`) | `governance-profile/registry.ts` ("a lifecycle … is future work") |
| Five passport shapes, unreconciled | Master Plan §7, TD-5 |

The exit criterion is literal: *a pilot organization onboards an agent and assigns it bounded authority without source code, a REPL or direct DB access, as an identified human operator.*

## 2. Decisions

### D1 — One organization per Host, unchanged

CTRL-02 adds no multi-tenancy. "Organization" is the operational boundary the Host already serves — `kernelAuthority.organizationId` — and its control-plane representation (`GET /api/admin/organization`). The organization never comes from a request body, query, header or route. Every write is made with `{ system: true, organizationId: <served>, actorId: operator:<id> }`, built server-side after authorization; every read uses an organization-scoped, non-system context.

### D2 — A first-class operator principal, authentication separate from authorization

```
Bearer credential
  └─ constant-time match (the Host's one matcher)        → EnterpriseOperatorPrincipal
       { plane: 'operator', operatorId, organizationId, role, credentialClass, actorRef }
  └─ Host ready?                                          (503)
  └─ operatorMay(role, permission)                        (403 OPERATOR_PERMISSION_DENIED)
  └─ only now: the body is read, validated, and the operation runs
```

`operator-control/operator-authenticator.ts`. The principal carries no credential, no permission list, no authority and no caller-stated value; `actorRef` (`operator:<operatorId>`) is the identity every store records. Operators are configured in the governed-action file (`operators[] { operatorId, role, apiKeyEnv }`); secrets are environment references, ≥ 32 characters, unique across every credential class (`HOST_CREDENTIALS_AMBIGUOUS`), never logged or returned.

Pilot authentication remains a server-configured bearer secret per operator. SSO, OIDC, MFA, WebAuthn and IdP federation are PROD-04. No passwords, no browser sessions.

### D3 — A closed role model and one permission policy

Derived from the permissions CTRL-02 needs (passport-web's `owner/admin/member/viewer/auditor` was a reference only — it has no "narrow-only" role and treats a legacy token as owner-equivalent):

| Permission | observer | responder | provisioner | profile-steward | organization-administrator | *legacy-administrator* (CTRL-01) |
|---|---|---|---|---|---|---|
| `organization.read` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `authority.inspect` (CTRL-01 reads) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `inventory.read` (CTRL-02 reads) | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `authority.bootstrap` (trust domains, root issuers, organization/system actors) | — | — | — | — | ✓ | — |
| `authority.provision` (human/agent actors, passports, capability tokens, authority/delegation grants) | — | — | ✓ | — | ✓ | — |
| `authority.revoke` | — | ✓ | ✓ | — | ✓ | ✓ |
| `agent-credential.manage` (issue, rotate) | — | — | ✓ | — | ✓ | — |
| `agent-credential.revoke` | — | ✓ | ✓ | — | ✓ | — |
| `profile.promote` | — | — | — | ✓ | ✓ | — |
| `profile.retire` | — | — | — | ✓ | ✓ | — |
| `emergency.stop` | — | ✓ | — | — | ✓ | ✓ |
| `emergency.release` (restores execution) | — | — | — | — | ✓ | ✓ |

`operator-control/roles.ts` holds the only mapping; handlers call `authenticator.authorize(header, permission)` and nothing else (structurally tested). `responder` only narrows; it cannot release a stop because release restores execution.

### D4 — CTRL-01 administrators keep exactly CTRL-01 powers

`administrators[]` remains supported unchanged and is mapped to the `legacy-administrator` compatibility class: inspect, revoke, emergency stop and release. It is not a configurable role and gains **no** CTRL-02 permission — not provisioning, not credentials, not profile promotion, not the new inventory reads. Migration is deliberate: declare the person under `operators[]` with a role (an operator id may not be both; refused at boot). CTRL-01's routes, wire contract, error codes and recorded identity (`operator:<operatorId>`) are unchanged; they now authenticate through the shared authenticator and check one permission each.

### D5 — The agent inventory is a projection of the Kernel Authority

The canonical governed-action agent is the Kernel-Authority **actor** (type `agent`). There is no second agent store. `GET /api/admin/agents[/{actorId}]` is computed per request from the Kernel Authority (actor status, passports, capability tokens, authority and delegation grants that name it, provenance) plus credential metadata from the control-plane store. Nothing in the inventory decides existence, revocation or authority; `onboarding` restates facts (`actor`, `credential`, `standingAuthority`).

### D6 — Operator-issued agent credentials close the static-admission gap

The literal exit criterion is impossible with `customerPrincipals[]` alone. CTRL-02 adds operator-issued customer-plane credentials:

```
fra1.agc-<32 hex credential id>.<43-char base64url secret (32 CSPRNG bytes)>
```

- **Issue / rotate** (`agent-credential.manage`): only for an active Kernel-Authority actor of type `agent` that has an `externalSubject`, whose subject is not a statically configured customer principal's. The principal (`agent:<actorId>`) binds exactly that external subject and actor, once, immutably.
- **Stored:** SHA-256(secret) only. A fast hash is a sufficient verifier because the secret is 256 bits of uniform randomness; a database reader holds verifiers that do not authenticate.
- **Revealed once**, in the issuing (or rotating) response. An idempotent replay returns the metadata with `bearerCredential: null` — the secret was never stored; a lost secret is replaced by rotation.
- **Admission:** a bearer token that matches no configured key is offered to the credential verifier (one indexed read by credential id, scoped to the served organization, `timingSafeEqual` over fixed-length digests). The authenticated principal then resolves its external subject through the **Kernel Authority** binding exactly as a configured principal does, and admission refuses unless that binding names the actor the credential was issued for. A revoked actor admits no one, whatever the credential's state.
- **Rotation** revokes the old credential and inserts the new one in one SQLite transaction. **Revocation** (`agent-credential.revoke`) is terminal **within one monotonic control-plane store history**: SQLite triggers refuse un-revoke, deletion and any other update. It is not terminal across a rollback of the whole store — the store is unsigned and unwitnessed, and restoring an older copy resurrects revoked and pre-rotation credentials (and earlier profile lifecycle state). That is an accepted pilot trust-boundary residual (R-3, PROD-02); actor revocation in the Kernel Authority still stops the agent.
- **Wrong-plane status (decision):** a credential is matched only against the credential classes of the plane it is presented to. An operator-issued agent credential on `/api/admin` and an operator or administrator credential on `/api/governed-actions` are **unknown to that plane → 401**, which reveals nothing about other planes; an ordinary or legacy key the operator plane deliberately recognizes (to refuse it) gets 403, as in CTRL-01. The guarantee is that **no wrong-plane credential is ever accepted**, not that every wrong-plane credential gets one status.
- **Separation:** operator-issued credentials are consulted only by customer admission — they reach no operator route (401), no legacy route (401). Operator and administrator credentials are not customer credentials (401 on `/api/governed-actions`).
- **Not JWT, not a capability:** the credential says who is calling; the Kernel decides what the actor may do.

With operators configured, the governed-action file may name **no** static customer principal; `customerPrincipals[]` stays fully supported as bootstrap/backward compatibility.

**Actor revocation and credential revocation are distinct facts.** Revoking the actor (CTRL-01 route) denies admission for every credential bound to it and is terminal for the actor; revoking a credential denies only that credential, and the agent can be issued a new one.

### D7 — Kernel-Authority provisioning over the operator plane

`POST /api/admin/authority/entities/{kind}` exposes the **existing** `KernelAuthorityProvisioningService` for all seven kinds. Each kind has a closed request schema that mirrors its `Provision*Input` and builds it field by field; there is no second authority model, no `Ctrl02Grant`, and no schema for a bounded grant.

Sequence per request: authenticate → authorize (`authority.bootstrap` for `trust-domain`, `root-issuer` and organization/system actors; `authority.provision` otherwise) → closed body → P10 constraint shape (the Kernel Authority's own validator) → references → **dry-run replay** → `provisionX(context, input, { idempotency })` → re-hydration (the service's own `onCommitted`).

- **References:** every actor, trust domain and source grant a request names must exist in the served organization and be active. The engines tolerate some dangling references (an authority grant for a missing actor replays and never authorizes); an operator typing one has made a mistake, and authority is never assigned to, from or under revoked authority.
- **Dry-run replay:** the would-be world (committed records + the candidate) is replayed through `hydrateKernelAuthorityWorld` — the real Recognition Runtime and Authority Graph — before the append. A record the engines refuse would otherwise commit, be impossible to remove (append-only), and make every later boot refuse to hydrate. Writes are serialized in-process so the dry run and the append see the same world (one Host, one process, one organization).
- **Preserved unchanged:** terminal revocation, no in-place rewrite (changed terms under an id → 409), idempotency (`KernelAuthorityIdempotency`, organization-scoped, pinned to the payload digest), unique external subjects, P10 checks (shape on append; asset/scale against the Host's trusted registry at provisioning; again at resolution), store-enforced `system: true` + operator identity, re-hydration after commit.

### D8 — Trust domains and root issuers are exposed, as organization bootstrap

Onboarding from a clean store needs an issuer actor, a trust domain and a root-issuer standing; leaving them in-process would hide a REPL requirement in the pilot flow. They are exposed, but only to `authority.bootstrap` (organization administrator). Neither is revocable (unchanged Kernel-Authority rule). The configured `trustDomainId` remains the domain governed actions are decided in; it is reported, never used to scope a write.

### D9 — No bounded-grant minting

A `BoundedGrant` is produced only by the governed-action lifecycle (governed request → Kernel decision → committed decision → grant → exercise). The operator plane holds no grant store, issuance core or Kernel; `bounded-grant` is not a provisionable kind (400); structurally tested.

### D10 — Bounded standing authority, including typed governed parameters (one model)

Standing authority is bounded by the Authority Graph's own scope (one `capability`, explicit `actions`, explicit `resourceScopes`, delegation depth and actor types, expiry), by P10 monetary constraints (`max_amount`, `spending_limit` — unchanged, kept apart), and — **since the CTRL-02 pre-push hardening** — by **typed governed-parameter bounds**, the work CORE-03 ADR §8 assigned to CTRL-02 ("Authority-sourced non-money limits … Owner: CTRL-02 (provisioning schema) with CORE-04"). The first CTRL-02 candidate misread that section as deferring the work and refused the field; the adversarial pre-push review caught it, and it is now implemented, not reassigned.

- **Representation:** `parameterBounds?: readonly ({ dimension } & GovernedParameterBound)[]` on `ProvisionAuthorityGrantInput` and `ProvisionDelegationGrantInput` — exactly the canonical CORE-03 bound a BoundedGrant's `scope.parameters` carries (`exact` integer/token/boolean, `maximum` integer). No second parameter model, no new algebra: validation is `isWellFormedGovernedParameterBound` / `isSemanticIdentifier`, containment is `governedParameterBoundAdmits`, attenuation is `compareGovernedParameterBound`. Durable records store it in canonical (dimension) order; it is validated on every append and every hydration. Absent bounds keep the historical meaning (no parameter restriction beyond the record's other scope); old records are never reinterpreted.
- **Evaluation (as P10):** at issuance the decision's own Authority Graph lineage is resolved (`resolveAuthorityChain`, proof-matched id for id) and **every** hop's bounds apply. A request whose typed parameters are not inside all of them — above a maximum, other than an exact value, of another type, or not stated — is withheld (`withheldBy: authority-binding`, `PARAMETER_AUTHORITY_*`) **before** any BoundedGrant, reservation or adapter call. The adapter never enforces authority, and policy is not the only enforcement point.
- **Relationship:** standing bound ⊇ permitted request value = decision / signed BoundedGrant `scope.parameters` ⊇ exercise value. The signed grant may be narrower than standing authority (its maximum is the requested value); it is never wider, because no grant is issued outside it. The grant's provenance digest commits to the parameter lineage and its bounds (`frontera.grant-authority-provenance.v2`, only when bounds exist — every other grant's digest is byte-identical), so exercise re-derives it from the live world and a revoked, replaced or re-lineaged parameter authority is unverifiable before any reservation.
- **Delegation attenuation:** at decision every hop applies, so a delegate can never exceed its source; at provisioning the operator plane refuses a delegation (or child grant) that drops an upstream bound, widens a maximum, or changes an exact value. A parent with no bound may delegate a new, narrower one.
- **Multiple records:** the lineage is the Authority Graph's deterministic choice (the first matching grant by id, else the first matching delegation — the rule P10 and the decision proof already use). No minimum is taken across independent records and no satisfying alternative is searched for; overlapping grants with different bounds are an operator responsibility (residual R-8).
- **Effective, not inert:** the operator plane refuses a bound whose dimension is undeclared, whose type does not match the declaration, whose kind the declaration does not permit (`maximum` only on a `maximum` dimension), or which no active Governance Profile governs for **every** action × resource pair in the record's scope (conservative: under the operator-promoted lifecycle the profile must be active). Once any parameter authority exists in the organization, an unresolvable lineage fails closed.

### D11 — Governance Profile lifecycle: a trusted catalog, a durable human promotion

`profileLifecycle: "operator-promoted"` (governed-action file, opt-in) turns `governance.profiles` into a **catalog** of immutable versions:

- Every catalog version is validated and composed at boot exactly as CORE-03/04/05 compose a profile — trusted-context declarations, obligations and approval requirements are keyed by the version's `{id, version, digest}` reference — so activating a version can never select a profile whose material facts or obligations were not composed. **Profile content is never authored over HTTP**: no executable or template content can enter through the API, and there is no policy CRUD.
- **Catalog-backed draft.** A configured catalog version with no lifecycle history is a draft; draft is inferred from the absence of history, not stored. Profile content is trusted configuration: creating or editing a version is a configuration change and a restart. CTRL-02 owns **human promotion and retirement**, not dynamic profile authoring (authoring over HTTP is deliberately absent: trusted-context, obligation and approval composition is frozen per version at boot). Activation and retirement are durable; historical versions are immutable by digest; an edited configured version no longer matches its lifecycle digest. A draft resolves nothing; it may be retired directly (withdrawn), which is terminal. `POST /api/admin/governance-profiles/{id}/versions/{v}/activate` (`profile.promote`) with `{ digest }` — the content the operator reviewed, a compare-and-set — makes it **active**; activating while another version of the same profile is active retires that version in the same transaction (`superseded by version v`), so there is never a gap or two active versions. `…/retire` (`profile.retire`) makes a version **retired** — terminal; a retired version is never activated again.
- The registry resolves a classified pair to the active version **only while its catalog digest equals the activated digest**: editing the file under an activated version number deactivates it, and the edited content cannot be promoted under that number (history pins one digest per version).
- Each transition records organization, profile id, version, digest, transition, the authenticated operator (`operator:<id>`), time and reason.
- **Promotion is a permitting governance operation.** Activating a less-demanding catalog version relaxes that profile's own requirements (parameters, material facts, obligations, approval) for future decisions. An operator holding `profile.promote` (profile-steward, organization-administrator — never a CTRL-01 administrator, observer, responder or provisioner) is trusted to do so. Activation creates no actor, grant or other authority; Kernel standing authority and independent policy-pack requirements stay binding; historical decisions and grants keep the digest they recorded. The definition's own `provenance.authoredBy/approvedBy` remain the catalog content's authorship claim (trusted configuration, digested); the **promotion identity is the lifecycle record**, never a body value (OQ-2's human half).
- A decision already committed stays bound to the profile id/version/digest it recorded; its grant is unchanged by later transitions.
- Without `profileLifecycle`, CORE-03 behaviour is unchanged: every configured profile is active and the lifecycle routes answer `409 PROFILE_LIFECYCLE_STATIC`.

### D12 — Passport reconciliation

| Passport | Defined / stored | Signed by | Authority-bearing? | Role after CTRL-02 |
|---|---|---|---|---|
| **Kernel-Authority passport** (entity kind `passport`) | `kernel-authority/contracts.ts` `ProvisionPassportInput`; `kernel_authority_records`/`_events`; replayed by `recognition.issuePassport` | Not signed (unkeyed SHA-256 event chain; the recognition proof is a deterministic digest, not a signature) | **Yes** — `ValidPassportPolicy` denies `PASSPORT_REQUIRED`/invalid; required for a Kernel ALLOW | **The CTRL-02 inventory artifact.** Provisioned over the operator plane; linked to its actor by `subjectActorId`; listed in the agent inventory |
| Enterprise AgentPassport (PR-006, `/api/passports`) | `enterprise/passport/*`; `agent_passports` SQLite | Not signed (hash chain + state digest) | No — no governed-action, Kernel or Kernel-Authority module reads it | Identity/evidence record (assurance evidence). Unchanged, not linked, not consulted |
| `packages/agent-governance` AgentPassport | package types; in-memory store port | HMAC-SHA256 `createTestSigner` (shared secret) | No | Library for passport-web |
| `apps/agent-passport-web` passport | its own SQLite (`agent_passports`, registries) | HMAC `createTestSigner` even in production | No — no connection to `src/enterprise` | Separate product; not imported by the Enterprise runtime |
| PMFreak passport foundation | `packages/pmfreak-agent-passport-foundation` (no store) | HMAC by default | No | Library/demo |

Decisions: the canonical identifier for governed-action authority is the Kernel-Authority **actor id**; the canonical passport is the **Kernel-Authority passport**, owned by the Kernel Authority store. Provisioning one shape never creates another, and CTRL-02 does not link them: a link would make a non-authority record look authoritative. passport-web stays a separate product.

### D13 — Passport cryptography / TD-5 stays open

No Enterprise passport is required to be publicly verifiable for the CTRL-02 exit criterion: governed-action authority rests on the Kernel-Authority world and on Ed25519-signed bounded grants. CTRL-02 therefore adds **no** passport signer and **no** passport key. The authority key still has no passport operation (CORE-02, structurally tested), and no HMAC passport signer is composed by the Enterprise Host. **TD-5 remains open:** the passport-web/agent-governance issuer is HMAC and is **not publicly verifiable**; a publicly verifiable passport needs its own asymmetric key role (it may reuse the CORE-02 custody pattern), never `AuthorityArtifactSigner`.

### D14 — One control-plane store

Agent credentials and the profile lifecycle share one SQLite file (`AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH`, default `.data/control-plane.sqlite`; `:memory:` under memory persistence), opened only when operators are configured. It is append-only by trigger (the one permitted update is a credential's `active → revoked`), holds no secret and no authority, and is **not** covered by `backup:v1` (PROD-02, like six other stores). Its integrity rests on the database file's protection: it is not signed or witnessed (residual R-3).

### D15 — Onboarding is composable, not a pseudo-transaction

"Onboard an agent" spans two stores (Kernel Authority, control plane). There is no distributed transaction and none is claimed. It is a sequence of independent, idempotent operations, each of which leaves the agent with **no more** authority than its completed stages:

| Completed stages | What the agent can do |
|---|---|
| actor provisioned | nothing (cannot authenticate) |
| + credential issued | authenticate; the Kernel denies everything (no passport/standing authority) |
| + passport, capability token, authority/delegation grants | act within exactly that standing authority |
| any stage revoked | actor revoked → admitted nowhere; credential revoked → that credential refused; grant/delegation revoked → denied |

A failure at any step writes nothing for that step (each is one store transaction); a retry under the same idempotency key replays.

### D16 — A committed write is never reported as unwritten

When a Kernel-Authority append has committed and refreshing the live projection fails, the provisioning service raises `KERNEL_AUTHORITY_REFRESH_FAILED` (`committed: true`); the operator plane (and CTRL-01's revocation route) answers **503 `AUTHORITY_STATE_REFRESH_FAILED`** with `recorded: true, retry: 'same-request'` and audits `committed-refresh-failed`. Nothing is rolled back (append-only). The durable world becomes the **deny-all** projection until a reload succeeds — the previous projection would still hold authority a just-committed revocation removed. The next call, the same request's idempotent replay included, refreshes again; a different body still conflicts. Operational recovery: retry the **same** request (same target, terms and idempotency key); never invent a second, different one. The profile lifecycle view does the same (no version active until its reload succeeds).

## 3. HTTP surface (36 → 47)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/admin/organization` | `organization.read` |
| GET | `/api/admin/agents` | `inventory.read` |
| GET | `/api/admin/agents/{actorId}` | `inventory.read` |
| POST | `/api/admin/agents/{actorId}/credentials` | `agent-credential.manage` |
| POST | `/api/admin/agents/{actorId}/credentials/{credentialId}/rotate` | `agent-credential.manage` |
| POST | `/api/admin/agents/{actorId}/credentials/{credentialId}/revoke` | `agent-credential.revoke` |
| GET | `/api/admin/authority/entities?kind=&status=` | `inventory.read` |
| POST | `/api/admin/authority/entities/{kind}` | `authority.provision` / `authority.bootstrap` |
| GET | `/api/admin/governance-profiles` | `inventory.read` |
| POST | `/api/admin/governance-profiles/{profileId}/versions/{version}/activate` | `profile.promote` |
| POST | `/api/admin/governance-profiles/{profileId}/versions/{version}/retire` | `profile.retire` |

Mounted only when operators are configured. Revocation of Kernel-Authority entities stays the CTRL-01 route. No customer-plane or SDK method was added: the operator plane is HTTP-only (an operator SDK is CTRL-03's to decide).

## 4. Consequences and residual risks

- **R-1 Operator credential theft = that operator, within its role.** Bearer secrets; no MFA/SSO/quorum/rate limiting (PROD-04, CTRL-04). Roles bound the blast radius.
- **R-2 Agent credential theft = that agent** until rotation or revocation. Not bound to a client (no mTLS/DPoP).
- **R-3 Control-plane store integrity is filesystem trust.** Not signed, not witnessed, not backed up (PROD-02). A writer of the file could insert a credential verifier or a lifecycle event; triggers stop accidental and in-process mutation only. A **rollback** of the whole store resurrects revoked and pre-rotation credentials and earlier lifecycle state. Accepted pilot residual: the data directory is already trusted (THREAT_MODEL accepted risk 3; the Kernel Authority store is unsigned too); no rollback protection is claimed.
- **R-4 Operator attribution is durable per store** (Kernel-Authority `provisionedBy`, credential `created_by/revoked_by`, lifecycle `operator_ref`) plus structured logs; there is no unified canonical event stream for operator actions (ASSURE-01).
- **R-5 Profile content changes need a configuration change and restart** (by design: content is composed at boot). Promotion and retirement do not.
- **R-6 TD-5 open** (D13).
- **R-8 Overlapping standing grants** with different parameter bounds for one action resolve to one deterministic lineage, never a merge or a search (D10).
- **R-7 Single process.** The provisioning serialization and the lifecycle cache assume one Host process per store set (as every SQLite store does).
