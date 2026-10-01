# CTRL-02 — Organizations, Human Operators & Agent Inventory: Qualification

- **Roadmap item:** CTRL-02 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Branch:** `feat/ctrl-02-organizations-operators-agents`, from `main @ 3c56a71`
- **Decision record:** `docs/architecture/ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md`
- **Exit criterion:** *A pilot organization onboards an agent and assigns it bounded authority without source code, a REPL or direct DB access, as an identified human operator.*

## 1. Discovery inventory (before CTRL-02, `main @ 3c56a71`)

| Area | Finding |
|---|---|
| Human identities | CTRL-01 `administrators[] {operatorId, apiKeyEnv}` (configuration, shared bearer secret, one implicit power set); customer principals (configuration `customerPrincipals[]` → API key with `customerIdentity`); legacy API keys (`AOC_ENTERPRISE_API_KEYS`, optional org scope); approval actors = Kernel-Authority actors (CORE-05, in-process command port); Kernel-Authority write actor = `context.actorId` (`operator:<id>` from CTRL-01); passport-web human accounts (separate product, own DB) |
| Credentials | All Enterprise credentials are configuration (environment references), constant-time matched by `orchestration/credential-matching.ts`; secrets unique across classes (`HOST_CREDENTIALS_AMBIGUOUS`); administrators never merged into `authentication.apiKeys` |
| Organization scoping | One organization per Host (`kernelAuthority.organizationId`, CORE-04); customer keys must be scoped to it |
| Kernel-Authority provisioning | `KernelAuthorityProvisioningService`: actor, trust domain, passport, capability token, root issuer, authority grant, delegation grant, revoke, list/read, `findActorByExternalSubject`; organization-scoped idempotency pinned to the payload digest; P10 shape on append and asset/scale at provisioning; re-hydration after commit. **In-process only** (revocation over HTTP since CTRL-01) |
| Customer admission | `customerPrincipals[]` is parsed at boot and frozen; an agent unknown to the file cannot authenticate → the exit criterion was impossible without editing configuration and restarting |
| Governance Profiles | Trusted-host format (CORE-03); one active version per id; no lifecycle; `provenance.approvedBy` is a configured string |
| Passport shapes | Five, unreconciled (§6) |
| API freeze | 36 endpoints (`release/api-surface.v1.json`) |
| Boundaries to preserve | body read only after authorization; closed schemas; organization server-side; `system: true` never from a request; no un-revoke; no issuance over HTTP; append-only Kernel Authority |

## 2. What was built

See the ADR (D1–D15). In one line each: a first-class operator principal and a closed role model behind one authenticator and one permission policy; CTRL-01 administrators held to exactly CTRL-01; Kernel-Authority provisioning over the operator plane through the existing service, with reference checks and a dry-run replay; an agent inventory computed from the Kernel Authority; operator-issued agent credentials that close the static-admission gap; an operator-promoted Governance Profile lifecycle; an explicit passport reconciliation.

## 3. The exit criterion, executed

`src/enterprise/__tests__/ctrl02-pilot-onboarding-host.test.ts` › “operator authenticates → sees the organization → bootstraps → onboards the agent → issues its credential → assigns bounded authority → the agent acts in bounds, is held out of bounds, and is stopped by revocation (across a restart)”.

One shipped Host (`bootEnterpriseHost()`, secure profile: SQLite, required authentication, Ed25519 authority signing, external freshness witness), a **clean** durable store, a governed-action file whose `customerPrincipals` is **`[]`**, and HTTP only:

| Step | Over HTTP | Proven |
|---|---|---|
| 0 | `GET /api/admin/authority/entities`, `GET /api/admin/agents` | the store is empty; no agent exists anywhere |
| 1–2 | `GET /api/admin/organization` as `ops-provisioner` | the served organization, the trust domain, the operator's id, role, credential class and permissions |
| — | `POST …/entities/trust-domain` as the provisioner | 403 `OPERATOR_PERMISSION_DENIED`: bootstrap is the organization administrator's |
| — | issuer actor, trust domain, root issuer as `ops-admin` | organization bootstrap, over HTTP |
| 3, 5 | owner (human) and agent actors as the provisioner, the agent with its external subject | `provisionedBy: operator:ops-provisioner`; inventory: `actor: active, credential: none, standingAuthority: none` |
| 4 | `POST /api/admin/agents/{agent}/credentials` | `fra1.agc-….…` revealed once; principal `agent:<actorId>` |
| — | the agent governs with no authority | admitted, **denied** by the Kernel (422), adapter 0 |
| 6–7 | authority grant (one action, one resource, P10 `max_amount` 500 + `spending_limit`), passport, capability token, delegation | each provisioned and attributed |
| 8 | `GET /api/admin/agents` | the canonical actor, its subject, principal, passport, token and delegation; `standingAuthority: assigned` |
| 9–10 | the agent's credential → `POST /api/governed-actions` transfer 120 USD | `executed`, adapter calls 1 |
| 11 | transfer 900 USD; transfer 50 USD to another resource | `withheld` (`FINANCIAL_AUTHORITY_CEILING_EXCEEDED`); `denied`; adapter calls still 1 |
| — | restart (fresh process image over the same files) | the same credential executes again |
| 12 | `POST …/entities/actor/{agent}/revoke` as `ops-responder` (CTRL-01 route) | the same credential → 403; adapter never reached; inventory `actor: revoked`, credential still `active` (distinct facts) |
| — | one more restart | still 403, adapter 0 |
| — | responses and logs | the credential appeared in exactly one response; no configured or issued secret in any response or log line; every operator log line names an identified operator |

A structural check in the same suite proves the proof itself never provisions in-process, opens a database, edits configuration after boot or reaches into the composed Enterprise.

## 4. Role matrix, organization binding, provisioning, credentials, lifecycle

| Matrix | Where | Result |
|---|---|---|
| Role × operation (6 caller classes × 25 operations, CTRL-01 and CTRL-02, against a hand-written expectation table) | `ctrl02-operator-control-service.test.ts` | allowed exactly when intended; otherwise 403 `OPERATOR_PERMISSION_DENIED`, body unread, nothing written to the Kernel Authority or the control-plane store, nothing logged |
| Unknown / malformed / non-Bearer / truncated / agent credential → 401; ordinary customer key → 403 | same | on every operation; nothing read, written or logged |
| CTRL-01 administrator → CTRL-02 | same + `ctrl02-operator-plane-host.test.ts` | provisioning, credentials, profiles, inventory: 403; inspect, revoke, stop, release: allowed |
| Organization binding | `ctrl02-operator-control-service.test.ts` | 20 smuggled fields refused; organization in a query refused on every read; a foreign actor, grant, credential and lifecycle history unaddressable; every write context = served organization + authenticated operator |
| Provisioning, per kind (actor, trust-domain, root-issuer, passport, capability-token, authority-grant, delegation-grant) | `ctrl02-operator-control-service.test.ts`, `ctrl02-operator-plane-host.test.ts` | valid create; replay; changed terms → 409 conflict; idempotency replay / conflict / 8-way concurrency / restart; malformed id, unknown field, forged provenance, wrong organization, `system`, non-object → 400; revoked id reuse → 409; store unavailable → 503; integrity → 500; references to missing or revoked authority → 409 before any write; monetary asset, scale and shape → 400 before commit (service and HTTP); parameter-bound fields refused; `bounded-grant` not a kind |
| Credentials | `ctrl02-operator-plane-host.test.ts`, `ctrl02-operator-control-service.test.ts` | 4096 secrets distinct, 32 bytes each; revealed once; never on list/read/replay/log; at rest only `sha256(secret)` (file bytes searched); the verifier presented as a credential → 401; wrong secret / foreign id / malformed → 401; rotation kills the old credential atomically; a rotated-out credential cannot be rotated again; 6-way concurrent issuance → one credential; revocation terminal; triggers refuse un-revoke, delete and principal edits; a foreign organization's credential authenticates nothing; a principal naming another actor than the Kernel-Authority binding admits no one; never issued for a non-agent, unknown, revoked or statically configured subject |
| Cross-plane | `ctrl02-operator-plane-host.test.ts` | customer and legacy keys → 403 on `/api/admin`; agent credential → 401 on `/api/admin` and every legacy route; operator, administrator credentials → 401 on `/api/governed-actions`; legacy key → 403 there (unchanged) |
| Governance Profile lifecycle | `ctrl02-profile-lifecycle-host.test.ts` | drafts resolve nothing (refused, adapter 0); observer, provisioner, responder, CTRL-01 administrator, legacy key → 403, anonymous → 401; forged `approvedBy`/`authoredBy`/`activatedBy`/`operatorId`/`organizationId`/`role`/`provenance`/`definition` → 400; wrong digest → 409; unknown version/profile → 404; activation names `operator:ops-steward`; the grant binds `{id, version, digest}`; supersession retires v1 atomically; the historical grant stays bound to v1; a retired version is never re-activated; retiring the active version → refused, adapter unchanged; restart durable; an edited catalog version stops resolving and cannot be promoted under its number; static mode unchanged (409 `PROFILE_LIFECYCLE_STATIC`); executable-looking, ambiguous or malformed catalogs refuse the Host |

## 5. Structural pins

`ctrl02-structure.test.ts` (comment-stripped, measured scopes): no request-derived operator, role, permission, organization, system flag or provenance; `system: true` built in one place; operator refs only from the authenticated principal; no driver, SQL, signer or key import in HTTP-facing modules; no `appendEvent` or store write half outside the provisioning service; no bounded-grant issuance; role checks only in the policy table; the adapter reaches the operator plane only through `enterprise.operatorControl` with exactly six mutation shapes; no rail/protocol/domain vocabulary; no model, network, process or dynamic code; no passport-web / agent-governance / PMFreak load; the AgentPassport store unconsulted by the authority path; no passport or HMAC signer; admission resolves operator-issued credentials through the Kernel-Authority binding; no SDK method for the operator plane.

## 6. Passport reconciliation and TD-5

The **Kernel-Authority passport** is the only passport on the governed-action authority path: it is required for a Kernel ALLOW (`ValidPassportPolicy`), owned by the Kernel Authority store, provisioned over the operator plane and shown in the agent inventory. The Enterprise AgentPassport (`/api/passports`) is an identity/evidence record no authority path reads; `packages/agent-governance`, `apps/agent-passport-web` and the PMFreak foundation are separate libraries/products the Enterprise runtime never imports. The canonical governed-action identifier is the Kernel-Authority actor id. Provisioning one shape never creates another; CTRL-02 links none of them (ADR D12).

**TD-5 remains open.** The passport-web / agent-governance issuer signs with HMAC (`createTestSigner`), which is **not publicly verifiable**: any verifier holding the shared secret can also mint. CTRL-02 does not claim otherwise, adds no passport signer or key, and keeps the authority signing key free of any passport operation (ADR D13). A publicly verifiable passport needs its own asymmetric key role.

## 7. Threat model

THREAT_MODEL_V1 §7.25 adds twenty-nine CTRL-02 rows: **25 BLOCKED** (each mirrored as `TM-7.25-1` … `TM-7.25-25` in the CORE-06 BLOCKED-claim matrix with named executable evidence, machine-checked by `core06-qualification-structure.test.ts`), **2 PARTIAL** (stolen operator credential — bounded by role; stolen agent credential — bounded by revocation and rotation), **1 NOT ADDRESSED** (control-plane store tampered by a filesystem writer) and **1 NOT APPLICABLE** (passport key-role confusion: no passport key role exists; TD-5 owns it). Accepted risk 11 records the operator-plane residuals.

## 8. No-bypass effect-path ledger

`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §5.1 adds EP-063 (Kernel-Authority provisioning over HTTP), EP-064 (agent credential issuance and rotation), EP-065 (agent credential revocation) and EP-066 (Governance Profile lifecycle transitions), all **DEPLOYMENT-GATED**, none bounded-grant controlled, none a way to reach a provider: **8 of 66** effect paths are bounded-grant controlled (was 8 of 62). EP-021's reachability names EP-063. Finding **NB-012** records the hazard CTRL-02 found and closed on the operator plane: an in-process provisioning call can commit a record the engines cannot replay, making every later boot refuse; it stays open for in-process embedders.

| EP | Route / call site | Effect | Principal | Authorization boundary | Organization binding | Durable destination |
|---|---|---|---|---|---|---|
| EP-063 | `POST /api/admin/authority/entities/{kind}` → `KernelAuthorityProvisioningService.provisionX` | standing authority (permitting) | identified operator | `authority.provision` / `authority.bootstrap`, before the body; closed schema; references; dry-run replay; store's operator rule | served organization only (`{system: true, organizationId, actorId}` built server-side) | Kernel Authority event chain |
| EP-064 | `POST /api/admin/agents/{actorId}/credentials[/{id}/rotate]` → `ControlPlaneStore.issueAgentCredential` | credential issuance | identified operator | `agent-credential.manage`; active agent actor with a non-static external subject | served organization only | control-plane store (verifier only) |
| EP-065 | `POST …/credentials/{id}/revoke` → `ControlPlaneStore.revokeAgentCredential` | credential revocation (restrictive) | identified operator | `agent-credential.revoke` | served organization only | control-plane store |
| EP-066 | `POST /api/admin/governance-profiles/{id}/versions/{v}/{activate,retire}` → `ControlPlaneStore.transitionProfile` | profile selection (activate: potentially permitting; retire: restrictive) | identified operator | `profile.promote` / `profile.retire`; digest compare-and-set | served organization only | control-plane store (append-only lifecycle) |

## 9. Deliberate mutation campaign

Run on a native-Linux export of `4f0ba8a` by a scripted runner: each mutation edits real source (each `find` string verified to occur exactly once), must compile (`tsc -b`; a compile failure is not counted — M25's first form did not compile and was corrected), runs the ten CTRL-02 / CTRL-01 / admission / signer / CORE-06 suites, and is restored byte-for-byte (SHA-256 per file, then the whole `src` tree compared with a fresh export of the commit: identical). **37 mutations, 37 killed, 0 survivors.**

| ID | File | Change | Property attacked | Killed by (first failing tests) | Failing |
|---|---|---|---|---|---|
| M1 | `operator-authenticator.ts` | an ordinary key matched as organization-administrator | ordinary customer credential accepted as operator | no header, a malformed header, an unknown secret → 401; an ordinary credential → 403; nothing is read or revok; the body is not read until the caller is an administrator | 5 |
| M2 | `roles.ts` | legacy class gains 'authority.provision' | legacy CTRL-01 administrator gains provisioning | legacy-administrator → provision:actor: 403, body unread, nothing written, nothing logged; legacy-administrator → provision:passport: 403, body unread, nothing written, nothing logged | 7 |
| M3 | `roles.ts` | observer gains 'authority.provision' | read-only role gains provisioning | observer → provision:actor: 403, body unread, nothing written, nothing logged; observer → provision:passport: 403, body unread, nothing written, nothing logged | 7 |
| M4 | `operator-authenticator.ts` | permission check made vacuous | role authorization removed | observer → revokeGrant: 403, body unread, nothing written, nothing logged; profile-steward → revokeGrant: 403, body unread, nothing written, nothing logged | 73 |
| M5 | `contracts.ts` +1 | body 'operatorId' accepted and used as the write's actorId | operatorId accepted from body and recorded as provenance | a provisioning body carrying 'operatorId' is refused before anything is written; no operator-plane module reads an operator id, role, permission, organization, system flag or provenance from  | 3 |
| M6 | `contracts.ts` | 'organizationId'/'tenantId' allowed in provisioning bodies | organizationId accepted from body | a provisioning body carrying 'organizationId' is refused before anything is written; a provisioning body carrying 'tenantId' is refused before anything is written | 9 |
| M7 | `contracts.ts` | 'system' allowed in provisioning bodies | system:true accepted from body | a provisioning body carrying 'system' is refused before anything is written; actor: malformed id, unknown field, forged provenance and a non-object body are refused before any write | 8 |
| M8 | `service.ts` | body read before authorize() | body read before authorization | observer → provision:actor: 403, body unread, nothing written, nothing logged; responder → provision:actor: 403, body unread, nothing written, nothing logged | 40 |
| M9 | `contracts.ts` | unknown-field filter made vacuous | closed-schema unknown-field rejection removed | a provisioning body carrying 'organizationId' is refused before anything is written; a provisioning body carrying 'tenantId' is refused before anything is written | 30 |
| M10 | `service.ts` | provisionThrough replaced by store.appendEvent | route writes directly to KernelAuthorityStore | every write reaches the provisioning service under the served organization and the authenticated operator — ne; monetary authority: an unknown asset, an over-scale value, a malformed or widening constraint shape are refuse | 14 |
| M11 | `composition-root.ts` | composition drops monetaryAssets from the provisioning service | monetary asset/scale validation bypassed at provisioning (composition drops the trusted registry) | monetary authority over HTTP is checked against the Host’s trusted asset registry before it commits: an unknow | 1 |
| M11b | `service.ts` | P10 shape pre-validation removed | monetary shape pre-validation removed (malformed constraint reaches the replay) | monetary authority: an unknown asset, an over-scale value, a malformed or widening constraint shape are refuse; monetary authority over HTTP is checked against the Host’s trusted asset registry before it commits: an unknow | 2 |
| M12 | `contracts.ts` | 'parameters' allowed on authority-grant bodies | parameter bound widened: a parameters field accepted on standing authority | typed governed parameters are not a second authority model: a parameter bound on standing authority is refused | 1 |
| M13 | `service.ts` | Kernel-Authority idempotency option dropped | idempotency conflict treated as a fresh write (Kernel-Authority idempotency dropped) | actor: idempotency — same key + same body replays; same key + different authority conflicts; concurrent same k; trust-domain: idempotency — same key + same body replays; same key + different authority conflicts; concurrent | 8 |
| M13b | `control-plane-store.ts` | credential idempotency digest mismatch ignored | credential idempotency conflict treated as replay | revealed once; never on a list, a read, a replay or a log line; stored as a verifier that does not authenticat | 1 |
| M14 | `append-rules.ts` | external-subject conflict rule made vacuous (append-rules) | duplicate external subject allowed (Kernel Authority binding) | a revoked actor is never re-authorized: authority naming it is refused, and a revoked agent is never re-onboar | 1 |
| M14b | `service.ts` | static-subject refusal made vacuous | operator-issued principal for a statically configured subject | a credential is never issued for a non-agent, an unknown actor, a revoked actor or a statically configured sub | 1 |
| M15 | `service.ts` | revoked-reference refusal made vacuous | revoked actor re-authorized (references to revoked authority accepted) | a revoked actor is never re-authorized: authority naming it is refused, and a revoked agent is never re-onboar | 1 |
| M15b | `service.ts` | revoked-actor credential refusal made vacuous | credential issued for a revoked actor | a revoked actor is never re-authorized: authority naming it is refused, and a revoked agent is never re-onboar; a credential is never issued for a non-agent, an unknown actor, a revoked actor or a statically configured sub | 2 |
| M16 | `control-plane-store.ts` +1 | verifier carried on records and spread into the credential view | agent credential verifier returned by GET/list | revealed once; never on a list, a read, a replay or a log line; stored as a verifier that does not authenticat | 1 |
| M17 | `control-plane-store.ts` | rotation UPDATE matches nothing (old stays active) | old rotated credential remains usable | rotation invalidates the old credential in the same transaction; revocation is terminal; neither touches the a | 1 |
| M18 | `operator-authenticator.ts` | 'fra1.' tokens admitted as observer operators | agent credential reaches /api/admin | an operator-issued agent credential → 401 on every operation; nothing read, written or logged; customer, legacy, administrator, operator and agent credentials: each refused everywhere but where it belongs | 2 |
| M19 | `roles.ts` | provisioner gains 'profile.promote' | unauthorized operator activates a Governance Profile | provisioner → activateProfile: 403, body unread, nothing written, nothing logged; drafts govern nothing; only a profile steward or organization administrator promotes; the promotion names the  | 2 |
| M20 | `registry.ts` | no active version → latest catalog version resolves | draft profile becomes resolvable | drafts govern nothing; only a profile steward or organization administrator promotes; the promotion names the  | 1 |
| M21 | `control-plane-store.ts` | retirement never clears the active version | retired profile remains active | drafts govern nothing; only a profile steward or organization administrator promotes; the promotion names the  | 1 |
| M22 | `contracts.ts` +1 | body 'approvedBy' accepted and recorded as operatorRef | approvedBy / promotion provenance taken from the request | drafts govern nothing; only a profile steward or organization administrator promotes; the promotion names the ; no operator-plane module reads an operator id, role, permission, organization, system flag or provenance from  | 3 |
| M23 | `control-plane-store.ts` | lifecycle query drops the organization filter | cross-organization lifecycle mutation applies here | another organization's actor, authority and profile lifecycle are invisible, unaddressable and cannot be attac | 1 |
| M23b | `control-plane-store.ts` +1 | credential verification ignores organization | cross-organization agent credential authenticates | an operator-issued credential of another organization authenticates nothing here | 1 |
| M24 | `node-http-adapter.ts` | POST /api/admin/authority/grants/issue route added | admin route creates a BoundedGrant directly | no route literal or pattern names a forbidden verb; the HTTP adapter reaches the operator plane only through `enterprise.operatorControl`, and its mutations are e | 2 |
| M25 | `agent-credentials.ts` | authority signer used to sign a passport in operator-control | authority signer reused for passport | no passport signer, HMAC signer or passport key role exists in the Enterprise runtime; the authority signer st | 1 |
| M26 | `subject-binding-reader.ts` | dynamic import of passport-web from the binding reader | passport-web / agent-governance becomes an authority source for admission | passport-web, agent-governance and the PMFreak foundation are never imported or loaded by the Enterprise runti; has no I/O, network, process or dynamic-code capability of its own | 3 |
| M27 | `service.ts` | reference checks and dry-run replay removed | onboarding leaves an unreplayable / dangling-reference record committed after a failed check | another organization's actor, authority and profile lifecycle are invisible, unaddressable and cannot be attac; references the engines cannot replay are refused before they are written — the world stays bootable | 3 |
| M28 | `service.ts` | latestEventDigest added to the provisioning response | provisioning response leaks a store digest | actor: valid create → provisioned, attributed, and readable; trust-domain: valid create → provisioned, attributed, and readable | 7 |
| M29 | `service.ts` | Authorization header written into the audit target | operator secret logged | revealed once; never on a list, a read, a replay or a log line; stored as a verifier that does not authenticat; operator authenticates → sees the organization → bootstraps → onboards the agent → issues its credential → ass | 2 |
| M30 | `host-configuration.ts` | customerPrincipals ≥ 1 required again | static customerPrincipals still required after claimed onboarding | an unknown role, a short secret, an inline secret, a duplicate identity and a reused secret are each refused a; without operators a file still needs a static customer principal; a profile lifecycle needs a catalog and some | 11 |
| M30b | `composition-root.ts` | agentCredentials not composed into admission | operator-issued credentials not composed into admission (agent needs static configuration) | customer, legacy, administrator, operator and agent credentials: each refused everywhere but where it belongs; malformed JSON, an oversized body, a wrong content type, unknown query parameters and other verbs are refused; | 10 |
| M31 | `admission-service.ts` | admission ignores credential/binding actor mismatch | admission trusts the credential record over the Kernel Authority binding (actor mismatch admitted) | admission believes the Kernel Authority, not the credential record: a principal naming another actor than the  | 1 |

## 10. API surface

`release/api-surface.v1.json`: **36 → 47** (11 added, all under `/api/admin/`, mounted only when operators are configured). `check-api-freeze` confirms exactly nine new patterns (two with a two-verb alternation) and no other drift. No SDK method was added (`check-sdk-surface`: 5 frozen exports, unchanged). The committed `release/RELEASE_MANIFEST.json` still states 28 endpoints — stale since CTRL-01 (at `3c56a71` it said 28 while the freeze said 36); it is a release-tag artifact regenerated at release time and was not touched.

## 12. Residual risks (not claimed)

SSO, MFA, WebAuthn and IdP federation (PROD-04); rate limiting (PROD-04); operator and agent credentials are bearer secrets (agent credentials not client-bound); the control-plane store is not signed, witnessed or backed up (PROD-02; ADR R-3); operator actions are attributed per store and in logs, not on a canonical event stream (ASSURE-01); profile content changes still need configuration and a restart; in-process provisioning by embedders is not replay-checked (NB-012); no approval inbox or web control plane (CTRL-04, CTRL-03); no egress controls; no payments or rail neutrality; target-system IAM is the target's; exactly-once execution is not claimed; TD-5 open. **PILOT READY is not claimed:** CTRL-03, CTRL-04, PROD-02, ASSURE-01 and PROD-03 remain.
