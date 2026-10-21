# G-01A — Trusted identity and attribution on the advisory evaluate route

Status: implemented on a Draft PR (base `1ea0368`). Not merged.
Invariants: SEC-INV-337 … SEC-INV-346 (`docs/security/SECURITY_INVARIANTS.md` §4.35).

## 1. The problem

`POST /api/governance/evaluate` authenticated the caller and then trusted the body:

| Defect | Before G-01A |
|---|---|
| Actor impersonation | `actor.id` was whatever the body said, for every credential — including a customer-principal key bound to one actor. The Governance Record's `actorId` (and its actor-indexed history) was a caller assertion. |
| Organization omission | An organization-scoped key was checked only when the body *named* an organization. Omitting it evaluated in the `global` idempotency scope with no organization on the record. |
| System writes | Every advisory append ran under `{ system: true }`, whatever the credential. |
| Unscoped keys | A bare `AOC_ENTERPRISE_API_KEYS` entry could evaluate for any organization and read every tenant's records as the system principal — including in `staging` / `production`. |
| No requester | Nothing in the record said who asked. |
| Replay across requesters | A stored decision answered whoever reused its `Idempotency-Key` or `requestId` with an equivalent payload. |

The governed-action path (`POST /api/governed-actions`) already derived actor and organization from `BoundCustomerIdentity` and was not affected.

## 2. The model

**Customer principals** (keys carrying `customerIdentity`). The advisory route now calls the existing `CustomerIdentityAdmissionService.admit()` — credential → principal → organization → Kernel Authority binding → actor. The body must name exactly that organization, that actor, and the Host's trust domain (the governed-action configuration's `trustDomainId`). Admission absent → the key cannot evaluate (403), never downgraded to a legacy key. Admission unavailable → 503 `PROVIDER_UNAVAILABLE`. Admission's answer must agree with the credential that was matched: the same principal id, external subject and organization as the key's configured `customerIdentity` and scope, from an admission serving that organization, naming a bound actor — otherwise the existing 403, and no record is created (SEC-INV-345). Admission returns no trust domain; the one trust domain is the Host's, and the request is held to it.

**Service principals** (`servicePrincipals` in the governed-action file; `EnterpriseConfiguration.authentication.servicePrincipals` for embedders). A named principal with its own secret (≥ 32 characters, unique across every credential), scoped to the one organization this instance serves, with `onBehalfOf: { actors: [...] }` — explicit, non-empty, exact ids. `onBehalfOf` accepts no other field, so no wildcard or "any bound actor" form can be written; `*` is refused. A service secret is **not** an `EnterpriseApiKey`: it authenticates the advisory evaluate route only — no read, no customer route, no operator or administration plane — and never holds a system context. The principal id may not collide with a customer principal, an operator, an administrator or the operator-issued `agent:` namespace.

One validator, two entry points: the Host's file parser reads only the file's shape (closed keys, environment-referenced secret), then runs `assertServicePrincipalConfiguration` on the configuration it built; `createEnterprise` runs the same function on whatever configuration it is handed. An embedder that bypasses the parser therefore meets identical rules — served organization, canonical id outside `agent:`, no collision with customer principals, operators or administrators, a secret of ≥ 32 characters without surrounding whitespace that no API key, operator, administrator or other service principal shares, and an explicit, distinct, wildcard-free allow-list (`ServicePrincipalConfigurationError`; the Host maps it to `HOST_SERVICE_PRINCIPAL_INVALID`). The Host's global one-secret-one-caller check still runs first, so a secret shared with a configured credential surfaces there as `HOST_CREDENTIALS_AMBIGUOUS`.

**Legacy keys.** `AOC_ENTERPRISE_LEGACY_KEY_MODE`:

- `restricted` — default in `staging` / `production`. The Host refuses to start with an unscoped key (`HOST_LEGACY_KEY_UNSCOPED`), so no legacy key holds implicit cross-organization system access; an unscoped key presented anyway is refused on evaluate (403).
- `compat` — default elsewhere; an explicit opt-in in a secure profile. Unscoped keys keep their v1 meaning.

The mode in force is `effectiveLegacyKeyMode`: an explicit mode wins, otherwise `staging` / `production` are `restricted` — for a configuration the Host loaded and for one an embedder built by hand alike. `assertLegacyKeyConfiguration` (the Host maps it to `HOST_LEGACY_KEY_UNSCOPED`; composition throws `LegacyKeyConfigurationError`) refuses an unscoped key while restricted, before anything is served, so bypassing the Host loader does not reopen system reads. An empty organization id on a key is malformed, never unscoped: evaluate refuses it, and restricted mode refuses it at startup.

In both modes a scoped key must now state its own organization, and its store context is the tenant scope, not `system`. The actor it names is recorded as **asserted**.

**Authentication disabled** (development, loopback only) is unchanged: no identity exists, no attribution is written.

**One immutable snapshot (SEC-INV-344).** `createEnterprise` first replaces every identity-bearing setting of the configuration it is handed — the environment, the feature flags (`requireAuthentication`), `authentication` (API keys and their customer identities, service principals and their allow-lists, auditors, `legacyKeyMode`) and `administration` (operators, administrators) — with a deep, frozen copy, then validates that copy and serves every route from it. An embedder that mutates its own objects afterwards changes nothing that authenticates or authorizes a caller; changing a credential means recomposing. The caller's objects are never frozen, and settings that carry no identity (stores, paths, limits, signers) are still the caller's, by reference.

## 3. Attribution

Each evaluation by a credential is sealed with a `GovernanceEvaluationAttribution` (`aoc.governance-attribution.v1`):

| Basis | Fields |
|---|---|
| `customer-principal`, `service-principal` | `organizationId`, `requestingPrincipalId`, `evaluatedActorId` |
| `legacy-asserted` | `legacyScope` (`organization` / `unscoped`), `organizationId?`, `evaluatedActorId` |

Storage: one extra event record in the aggregate (`eventType: GovernanceEvaluationAttributed`, contract `aoc.governance-event-record.v1`), after the operational events, covered by its own `eventDigest`, the aggregate's `eventsDigest` and `aggregateDigest`. No column, table, schema version or migration. The Store refuses (`GOVERNANCE_STORE_VALIDATION_ERROR`) a malformed attribution, or one naming another actor or organization than its request.

What is unchanged: an aggregate appended without `attribution` is byte-for-byte what it was — every historical record, every governed-action record, every unauthenticated one — so historical digests and chain verification are untouched. The public `EnterpriseEventType` union is untouched.

Disclosure (founder decision 4):

- **Never published.** The event is built inside the Store's projection; it never passes through the event publisher.
- **Not on the legacy event surface.** It carries no `requestId`, so `listEnterpriseEvents` (both providers) never lists it.
- **Not in evidence.** Evidence bundles project an aggregate's events as `{ eventType, occurredAt }` only (`evidence/projector.ts`); no disclosure level — PUBLIC through FULL — carries the principal id.
- **Raw Governance Record reads (P1, founder decision: option B).** The Store keeps the canonical aggregate complete and unchanged; disclosure is decided at read time (`orchestration/governance-record-disclosure.ts`), for `GET /api/governance/evaluations/{id}`, `/decisions/{id}` and `/requests/{id}` alike:
  - **canonical** to system scope and to an **auditor** (`auditors: [{auditorId, apiKeyEnv}]` in the governed-action file; `authentication.auditors` for embedders) for records of its one organization — an auditor reading another organization's record gets 404;
  - a **marked projection** to every ordinary organization-scoped key: each attribution event that names a requesting principal has its `eventPayload` replaced by `{"withheld":"attribution"}`, and the response carries `projection: { version: "aoc.governance-record-projection.v1", canonical: false, withheld: [...], verification }`. Organization scope alone is never auditor authority.
  - **Allow, never deny (SEC-INV-346).** A payload is shown to an ordinary reader only when it is exactly `{ attribution }` holding a well-formed `aoc.governance-attribution.v1` legacy-asserted value — the Store's own closed shape — that names the record's actor and organization: it names no principal. Every other payload — a principal, an unknown version, a missing or unsupported field at either level, an unsalted value, one contradicting its record — is withheld whole. Records with nothing to withhold are returned canonical and unmarked.
  - **Digests.** Every attribution carries 128 random bits (`salt`), so the attribution event's `eventDigest`, the `eventsDigest` and the `aggregateDigest` a projection still shows cannot be used to confirm a guessed principal id. A projection's digests describe the canonical record and cannot be recomputed from it; `GET …/verify` checks the complete stored record server-side.
  - **Auditor authority.** An auditor secret is not an API key: it authenticates only the Governance Record read service — over HTTP the record routes by evaluation, decision or request id and `…/verify` (query is an in-process method with no HTTP route) — not evaluate, governed actions, evidence, passports, assurance, approvals, the operator or administration plane — and is never system scope. One shared validator (`assertAuditorConfiguration`), run by the Host loader (`HOST_AUDITOR_INVALID`) and at composition (`AuditorConfigurationError`): the served organization only; a canonical id outside `agent:` naming no customer or service principal, operator, administrator or other auditor; a ≥ 32-character trim-stable secret no other credential shares.

  Every other read surface was checked and discloses nothing to an ordinary reader: `query` returns summaries without events, `verify` returns digests and booleans, evidence v1/v2 project event types only, the operator plane's decision view projects named fields, and `listEnterpriseEvents` never lists the attribution event.

## 4. Replay

`Idempotency-Key` scopes stay `org:{id}` / `global` (no format change). A stored decision answers a caller only if `mayReplayTo` holds: the same basis, requesting principal (or legacy scope), organization and actor. Otherwise the caller gets the existing `409 GOVERNANCE_IDEMPOTENCY_CONFLICT` (key) or `409 CONCURRENCY_CONFLICT` (request id) and nothing is written. The check runs on the pre-Kernel probe **and** on the append transaction's replay.

A replay signal that comes without the record it replays — possible only from an injected Store, on the probe or inside the append — is a `500 GOVERNANCE_RECORD_CORRUPTED` integrity error: never trusted as a replay, never treated as this caller's fresh commit, nothing written, no commit or completion event published.

Historical records (no attribution): never answer a customer or service principal — not adopted, not promoted. They still answer a legacy key or an unauthenticated caller exactly as before, and are returned untouched (no attribution is added). An unreadable attribution (two events, unknown version, or contradicting its request) answers no one.

## 5. Scope

Changed: `configuration/enterprise-configuration.ts` (`snapshotIdentityConfiguration`), `orchestration/advisory-identity.ts` (new), `orchestration/evaluate-governance-request.ts`, `orchestration/credential-matching.ts` (`matchApiKey` generic, same comparison), `governance-store/attribution.ts` (new), `governance-store/contracts.ts`, `governance-store/projection.ts`, `configuration/enterprise-configuration.ts`, `host/host-configuration.ts`, `composition/composition-root.ts`, `orchestration/governance-record-disclosure.ts` (new), `orchestration/governance-read-service.ts`.

Unchanged (gate E): the Kernel and its contracts (including `actor.principalId` delegation, which the Kernel verifies against provisioned capability tokens and delegation grants), CORE-07, grants and their signatures, P7 / P11 / P12, the governed-action path, the customer-identity layer, the Store schema, every error code catalogued. The three Governance Record read routes keep their URLs, methods, error codes and fields, and gain only the approved `projection` marker and the withheld attribution payload for ordinary readers (§3).

## 6. Residual risks

- **Credential changes need recomposition.** Identity configuration is snapshotted at composition; an embedder that rotated credentials by mutating its configuration in place must now recompose (the Host already restarts).
- **Admission carries no trust domain.** Trust-domain consistency is the request against the Host's trust domain; binding a trust domain into admission's result would change the customer-identity contract.
- **Auditor credential custody.** An auditor reads every complete record of its organization, including principal ids; its secret must be held as carefully as an operator's.
- **Records committed by an earlier G-01A build of this PR** carry no salt and are unreadable to this build (`readRecordedAttribution` → unreadable): they replay to no one and are withheld from ordinary readers. No such records exist outside this branch's tests.
- **Legacy keys within one organization are indistinguishable.** Two scoped legacy keys of one organization share `legacy-asserted / organization` attribution and may replay each other's decisions, as in v1. Configured legacy keys carry no identity to tell them apart.
- **Unscoped keys under `compat`** keep cross-organization system access on the read routes — by explicit opt-in only.
- **Request-id existence oracle.** `request_id` is unique store-wide, so a reused id still answers 409 across requesters and tenants (G-01B1).
- **Passports.** Passport lifecycle actors and `linkGovernanceRecord` remain caller-asserted / unchecked against the record's actor (out of scope).

## 7. Evidence

Suites (root suite, GitHub Actions): `src/enterprise/__tests__/g01a-advisory-attribution.test.ts` (in-memory and SQLite; HTTP end to end on a composed Host) and `src/enterprise/__tests__/g01a-mutation.test.ts` (46 mutants over the compiled modules, each detected by its guard; 14 of them for the final P3-1/P3-2/P3-3 hardening). Run IDs are reported on the PR.
