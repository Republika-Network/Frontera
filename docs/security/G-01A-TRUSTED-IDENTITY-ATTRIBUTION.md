# G-01A — Trusted identity and attribution on the advisory evaluate route

Status: implemented on a Draft PR (base `1ea0368`). Not merged.
Invariants: SEC-INV-337 … SEC-INV-342 (`docs/security/SECURITY_INVARIANTS.md` §4.35).

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

**Customer principals** (keys carrying `customerIdentity`). The advisory route now calls the existing `CustomerIdentityAdmissionService.admit()` — credential → principal → organization → Kernel Authority binding → actor. The body must name exactly that organization, that actor, and the Host's trust domain (the governed-action configuration's `trustDomainId`). Admission absent → the key cannot evaluate (403), never downgraded to a legacy key. Admission unavailable → 503 `PROVIDER_UNAVAILABLE`.

**Service principals** (`servicePrincipals` in the governed-action file; `EnterpriseConfiguration.authentication.servicePrincipals` for embedders). A named principal with its own secret (≥ 32 characters, unique across every credential), scoped to the one organization this instance serves, with `onBehalfOf: { actors: [...] }` — explicit, non-empty, exact ids. `onBehalfOf` accepts no other field, so no wildcard or "any bound actor" form can be written; `*` is refused. A service secret is **not** an `EnterpriseApiKey`: it authenticates the advisory evaluate route only — no read, no customer route, no operator or administration plane — and never holds a system context. The principal id may not collide with a customer principal, an operator, an administrator or the operator-issued `agent:` namespace. Composition re-checks all of this for embedders (`ServicePrincipalConfigurationError`).

**Legacy keys.** `AOC_ENTERPRISE_LEGACY_KEY_MODE`:

- `restricted` — default in `staging` / `production`. The Host refuses to start with an unscoped key (`HOST_LEGACY_KEY_UNSCOPED`), so no legacy key holds implicit cross-organization system access; an unscoped key presented anyway is refused on evaluate (403).
- `compat` — default elsewhere; an explicit opt-in in a secure profile. Unscoped keys keep their v1 meaning.

In both modes a scoped key must now state its own organization, and its store context is the tenant scope, not `system`. The actor it names is recorded as **asserted**.

**Authentication disabled** (development, loopback only) is unchanged: no identity exists, no attribution is written.

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
- **Raw Governance Record reads.** `GET /api/governance/evaluations/{id}` (and by request/decision id) returns the complete aggregate to a credential scoped to that organization, as it always has — including the full trace and request payload, which the evidence policies reserve for AUDITOR and above. The attribution payload is visible there to the same audience. See §6.

## 4. Replay

`Idempotency-Key` scopes stay `org:{id}` / `global` (no format change). A stored decision answers a caller only if `mayReplayTo` holds: the same basis, requesting principal (or legacy scope), organization and actor. Otherwise the caller gets the existing `409 GOVERNANCE_IDEMPOTENCY_CONFLICT` (key) or `409 CONCURRENCY_CONFLICT` (request id) and nothing is written. The check runs on the pre-Kernel probe **and** on the append transaction's replay.

Historical records (no attribution): never answer a customer or service principal — not adopted, not promoted. They still answer a legacy key or an unauthenticated caller exactly as before, and are returned untouched (no attribution is added). An unreadable attribution (two events, unknown version, or contradicting its request) answers no one.

## 5. Scope

Changed: `orchestration/advisory-identity.ts` (new), `orchestration/evaluate-governance-request.ts`, `orchestration/credential-matching.ts` (`matchApiKey` generic, same comparison), `governance-store/attribution.ts` (new), `governance-store/contracts.ts`, `governance-store/projection.ts`, `configuration/enterprise-configuration.ts`, `host/host-configuration.ts`, `composition/composition-root.ts`.

Unchanged (gate E): the Kernel and its contracts (including `actor.principalId` delegation, which the Kernel verifies against provisioned capability tokens and delegation grants), CORE-07, grants and their signatures, P7 / P11 / P12, the governed-action path, the customer-identity layer, the read routes, the Store schema, the public response shapes, every error code.

## 6. Residual risks

- **In-organization raw reads.** Any credential scoped to an organization — including a customer principal — reads that organization's complete Governance Records through the governance read routes, now including attribution payloads (principal ids). This is the existing read contract (it already exposes AUDITOR-level trace data to those credentials); narrowing it to principal- or actor-level scoping changes read contracts and is proposed as a separate milestone.
- **Legacy keys within one organization are indistinguishable.** Two scoped legacy keys of one organization share `legacy-asserted / organization` attribution and may replay each other's decisions, as in v1. Configured legacy keys carry no identity to tell them apart.
- **Unscoped keys under `compat`** keep cross-organization system access on the read routes — by explicit opt-in only.
- **Request-id existence oracle.** `request_id` is unique store-wide, so a reused id still answers 409 across requesters and tenants (G-01B1).
- **Passports.** Passport lifecycle actors and `linkGovernanceRecord` remain caller-asserted / unchecked against the record's actor (out of scope).

## 7. Evidence

Suites (root suite, GitHub Actions): `src/enterprise/__tests__/g01a-advisory-attribution.test.ts` (in-memory and SQLite; HTTP end to end on a composed Host) and `src/enterprise/__tests__/g01a-mutation.test.ts` (12 mutants over the compiled modules, each detected by its guard). Run IDs are reported on the PR.
