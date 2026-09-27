# Authority Administration API (CTRL-01)

- **Milestone:** CTRL-01 — Authority Administration API (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9).
- **Code:** `src/enterprise/authority-administration/` (service + wire contract),
  routed by `src/enterprise/adapters/node-http-adapter.ts`, composed by
  `src/enterprise/composition/composition-root.ts`, configured by
  `src/enterprise/host/host-configuration.ts`.
- **Tests:** `src/enterprise/__tests__/authority-administration-api.test.ts`
  (real Host), `src/enterprise/__tests__/authority-administration-service.test.ts`.

The supported operator surface for **inspecting and revoking existing
authority** and for **emergency control** on the Frontera Enterprise Host
(`npm run start:enterprise` → `bootEnterpriseHost()`), without database access,
a Node REPL, repository changes or developer intervention.

> **Authority administration is itself an authority-bearing action.**
> Reaching the HTTP server is not authority. Holding an ordinary API
> credential is not authority. Only a configured administrator credential
> administers authority, and the identity every change is recorded under comes
> from the server's configuration, never from the request.

## 1. What it covers — and what it deliberately does not

| Capability | Exposed | Owner it calls |
|---|---|---|
| Inspect a bounded grant (bounds, provenance, status, revocation) | **yes** | `BoundedGrantReaderPort.read` + the grant runtime's `assessGrantExercise` |
| Find the bounded grant a governed-action execution ran under | **yes** | P11 `ExecutionOutcomeReader.read` (verified, tenant-scoped) |
| Revoke a bounded grant | **yes** | `AuthorityControlledExecutionService.revokeGrant` → CORE-01 signed store |
| Inspect a Kernel Authority entity (actor, passport, capability token, authority grant, delegation, trust domain, root issuer) | **yes** | `KernelAuthorityStore.getRecord` |
| Revoke a Kernel Authority entity (actor, passport, capability token, authority grant, delegation) | **yes** | `KernelAuthorityProvisioningService.revoke` |
| List, activate, release emergency controls | **yes** | `EmergencyControlStorePort.active / activate / release` (P4) |
| Issue a bounded grant | **no — intentionally not exposed** | Grants are minted only from a committed, verified Kernel decision inside the governed-action orchestrator. An administrative issuance route would mint authority no decision produced. |
| Provision Kernel Authority (actors, trust domains, grants, delegations) | **no — deferred** | Stays the trusted in-process surface. Creating standing organizational authority over a single shared bearer credential, with no human operator identity, is the wrong trust model; human operator identity and agent inventory are CTRL-02. |
| Delegation / attenuation | **no** | No new delegation semantics. Delegations are Kernel Authority entities; they can be inspected and revoked here, not created. |
| Un-revoke, delete or clear a revocation, reactivate | **no — and never** | Revocation is monotonic in every store. Restoring authority is new provisioning under a new id. No route, service method or port offers it. |
| Listing / search | **no** | Inspect-by-known-id only (see §6 for how an operator obtains ids). No bulk read. |
| Approvals, organizations, humans, agents, web UI, policy CRUD, payments, KMS | **no** | CORE-05/CTRL-04, CTRL-02, CTRL-03, CORE-03, PAY, CORE-02 |

## 2. Security model

### 2.1 Authentication vs. administrative authorization

PROD-01's authentication knows three kinds of credential, and none of them
carries administrative capability:

| Credential | Source | What it authenticates |
|---|---|---|
| Legacy key (bare) | `AOC_ENTERPRISE_API_KEYS=key` | legacy v1 routes, as `system` |
| Legacy key (org-scoped) | `AOC_ENTERPRISE_API_KEYS=key:org` | legacy v1 routes, one organization |
| Customer principal | governed-action file `customerPrincipals[]` | `POST /api/governed-actions`, as one bound actor |
| **Administrator (CTRL-01)** | governed-action file `administrators[]` | **`/api/admin/...` only**, as one named operator |

Administrator credentials are a **separate class**. They are not merged into
`authentication.apiKeys`, so:

- an administrator secret authenticates **no** other route (a governed action
  or a legacy read with it is `401`);
- every ordinary credential — including a bare `system` legacy key — is
  **`403 AUTHORIZATION_FAILED`** on every administration route;
- an unknown, missing or malformed credential is **`401 AUTHENTICATION_FAILED`**.

Matching reuses the Host's canonical constant-time matcher
(`orchestration/credential-matching.ts`); both lookups always run.

### 2.2 Trusted operator identity

Each administrator is `{ operatorId, apiKeyEnv }`. On every mutation the store
that owns it records the actor as **`operator:<operatorId>`**:

| Mutation | Durable record of the actor |
|---|---|
| Bounded-grant revocation | `issuerRef` inside the **signed** revocation artifact (CORE-01) |
| Kernel Authority revocation | `provisionedBy` on the hash-chained revocation event |
| Emergency control activate / release | `issuer_ref` on the hash-chained emergency-control event |

Request bodies are **closed schemas**. A body naming `admin`, `role`,
`operator`, `operatorId`, `actor`, `issuerRef`, `revokedBy`, `administrator`,
`organizationId`, `tenantId`, `permissions`, `revokedAt`, `signature` — or any
field not listed for the route — is refused with `400` before anything is read
or written. Headers such as `X-Admin`, `X-Operator`, `X-Forwarded-User` and
query parameters such as `?admin=true` are never read.

### 2.3 Organization scope

One Host serves exactly one authority organization
(`AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID`). Every administration read
and write is scoped to it by the service; no path segment, query parameter,
header or body field can name another. A Kernel Authority record of another
organization held in the same store is `404` through this API and is never
revoked by it. The runtime is single-tenant per Host; CTRL-01 does not
introduce multi-tenancy.

### 2.4 Order of checks

```
Authorization header
  └─ administrator?          missing/unknown/malformed → 401 · ordinary credential → 403
      └─ Host ready?         → 503 ENTERPRISE_NOT_READY
          └─ path + body     → 400 (415 for a non-JSON body)
              └─ authoritative service, under operator:<operatorId>
```

The body is not read, parsed or validated until the caller is an
administrator, so an unauthenticated caller learns nothing about route shapes,
target existence or validation rules.

## 3. Configuration

Administrators are declared in the governed-action file
(`AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE`), with their secrets held in
environment variables — the same rule as customer principals:

```json
{
  "version": 1,
  "trustDomainId": "trust-domain-acme",
  "grantLifetimeSeconds": 300,
  "customerPrincipals": [ … ],
  "administrators": [
    { "operatorId": "ops-oncall-1", "apiKeyEnv": "FRONTERA_ADMIN_KEY_ONCALL_1" }
  ],
  "routes": [ … ]
}
```

```bash
# in your secret manager — a long random value, never this placeholder
FRONTERA_ADMIN_KEY_ONCALL_1=<at least 32 random characters, e.g. `openssl rand -base64 48`>
```

Rules (each refuses to boot, with a message naming fields and variables, never values):

| Rule | Code |
|---|---|
| `administrators` absent | API **not mounted**; posture `authorityAdministration: not-configured` |
| `administrators: []` | `HOST_GOVERNED_ACTIONS_FILE_INVALID` (omit it instead) |
| Unknown field in an entry (e.g. an inline `apiKey`, a `role`) | `HOST_GOVERNED_ACTIONS_FILE_INVALID` |
| `operatorId` not 1–128 of `[A-Za-z0-9._-]` starting alphanumeric, or duplicated | `HOST_GOVERNED_ACTIONS_FILE_INVALID` |
| Named variable unset or empty | `HOST_SECRET_REFERENCE_UNRESOLVED` |
| Secret shorter than 32 characters or with surrounding whitespace | `HOST_ADMINISTRATOR_INVALID` |
| Secret equal to any other configured credential (legacy, customer, administrator) | `HOST_CREDENTIALS_AMBIGUOUS` |

**Optional, and explicit.** The API exists only on a Host that declares at
least one administrator. There is no default administrator, no default secret,
and no fallback to any other credential. `/health` reports
`posture.authorityAdministration` as `enabled` or `not-configured`, and the
launcher prints it. `AocEnterprise.configuration.administration` carries only
`administratorCount`.

## 4. Endpoints

All responses are JSON. Errors use the Host's envelope
`{ "error": { "code", "message", "details"?, … } }`. Every route requires
`Authorization: Bearer <administrator secret>`. Mutations are `POST` with
`Content-Type: application/json` and a body of at most 16 KiB; reads are `GET`
and change nothing. Any other method or path under `/api/admin/` is
`404 NOT_FOUND`.

### 4.1 `GET /api/admin/authority/grants/{grantId}` — inspect a bounded grant

`grantId`: the canonical bounded-grant id, `aoc.grant:` + 32 lowercase hex.

`200`:

```json
{
  "grantId": "aoc.grant:…",
  "subject": "actor-agent",
  "provenance": { "requestId": "aoc.gar:…", "decisionId": "…", "action": "invoice.approve", "resourceScope": "resource-ledger-1" },
  "bounds": { "action": { "kind": "identity", "value": "invoice.approve" }, "resources": { "kind": "set", "values": ["resource-ledger-1"] } },
  "issuedAt": "…", "expiresAt": "…",
  "status": { "eligibility": "exercisable", "reasonCodes": [], "assessedAt": "…" },
  "revocation": null
}
```

`status` is the grant runtime's own `assessGrantExercise` at `assessedAt`, on
the Host's clock — the same assessment the exercise path runs. `eligibility`
is `exercisable` or `unusable`; `reasonCodes` are `GRANT_REVOKED` and/or
`GRANT_EXPIRED`. The HTTP layer computes no status. `revocation` is
`{ revokedAt, reason, revokedBy }` as the signed record holds it, or `null`.
No digest, signature, key id or storage field is returned.

### 4.2 `GET /api/admin/authority/executions/{executionId}` — which grant an execution ran under

`POST /api/governed-actions` returns `requestId` and `executionId` but — by
design — never a grant. This route resolves an execution the operator (or the
application's logs) knows to the grant it ran under, from the verified P11
execution record:

`200`: `{ executionId, requestId, decisionId, grantId, action, preparedAt }`.
`404 AUTHORITY_ADMIN_TARGET_NOT_FOUND` if no execution with that id is recorded
for this organization.

### 4.3 `POST /api/admin/authority/grants/{grantId}/revoke` — revoke a bounded grant

Body (closed): `{ "reason": <one of administrator-revoked | expired | manual-revocation | policy-changed | principal-disabled | resource-removed | security-incident> }`.

`200`: `{ "outcome": "revoked" | "already-revoked", "grantId", "revocation": { revokedAt, reason, revokedBy } }`.

- Runs `AuthorityControlledExecutionService.revokeGrant` → the CORE-01 signed
  store: a signed revocation artifact and an advanced signed revocation-state
  commitment, committed together or not at all, read back through the same
  verification every later read uses; then the P8 `grant.revoked` event.
- **Idempotent.** A repeat — any reason, any administrator — returns
  `already-revoked` with the **first** revocation, unchanged; nothing new is
  signed and the commitment does not advance. Concurrent requests commit
  exactly once.
- **Immediately authoritative.** The next read and the next exercise of that
  grant see it.
- **Scope of effect.** A bounded grant is per governed request and at most
  `grantLifetimeSeconds` long (≤ 1 h). Revoking it stops *that grant* from
  being exercised (e.g. a retry of an interrupted request). To stop an agent's
  **future** governed actions, revoke the standing authority it acts under
  (§4.5): the delegation, capability token, passport or actor.

### 4.4 `GET /api/admin/authority/entities/{entityKind}/{entityId}` — inspect Kernel Authority

`entityKind`: `actor | trust-domain | passport | capability-token | root-issuer | authority-grant | delegation-grant`.

`200`:

```json
{
  "entityKind": "delegation-grant", "entityId": "delegation-agent",
  "organizationId": "org-acme", "trustDomainId": "trust-domain-acme",
  "status": "active",
  "terms": { "actions": ["invoice.approve"], "resourceScopes": ["resource-ledger-1"], … },
  "provisionedBy": "…", "provisionedAt": "…",
  "revokedBy": null, "revokedAt": null, "revocationReason": null,
  "sequence": 1
}
```

`status` is the store's own reconstruction from the entity's hash-chained
event history (`active` | `revoked`). `terms` are the provisioned authority
terms; the provisioning contracts carry no secret.

### 4.5 `POST /api/admin/authority/entities/{entityKind}/{entityId}/revoke` — revoke Kernel Authority

Body (closed): `{ "reason": <1–512 characters, no control characters> }`.
Revocable kinds: `actor`, `passport`, `capability-token`, `authority-grant`,
`delegation-grant` (a trust domain or root issuer is refused with `400` by the
provisioning service's own rule).

`200`: `{ "outcome": "revoked" | "already-revoked", "entity": <§4.4 view> }`.

- Runs `KernelAuthorityProvisioningService.revoke` with the operator context
  `{ system: true, organizationId: <served>, actorId: "operator:<operatorId>" }`;
  the store appends a `KernelAuthorityEntityRevoked` event, and the Host's live
  authority world is re-hydrated from the store before the call returns.
- **Terminal and idempotent**: a repeat is `already-revoked` and appends
  nothing; a revoked id can never be provisioned again.
- **Effect**: the next governed action that depended on the entity is
  `denied` by the Kernel, with no adapter call, and stays denied across
  restarts.

### 4.6 Emergency control

| Route | Body | `200` |
|---|---|---|
| `GET /api/admin/emergency-controls` | — | `{ "active": [{ "scope", "value"? }] }` |
| `POST /api/admin/emergency-controls/activate` | `{ "scope", "value"? }` | `{ "outcome": "activated", "control", "active" }` |
| `POST /api/admin/emergency-controls/release` | `{ "scope", "value"? }` | `{ "outcome": "released", "control", "active" }` |

`scope`: `global` (no `value`), or `organization | actor | adapter | resource`
with a `value`. `workflow` is refused: no governed-action path carries a
trusted workflow identity, so such a stop would stop nothing while looking
like a stop. Both mutations are the existing P4 store operations — durable,
hash-chained, idempotent (re-activating keeps the original declaration;
releasing an inactive control is a no-op). Activation withholds governed
execution at every P4 checkpoint (`withheld`, `withheldBy: emergency-control`)
and survives restart. Release is the existing, legitimate recovery path; there
is no other reset.

## 5. Error model

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed path id, unknown entity kind, non-object or invalid JSON body, unsupported body field (listed in `details`), invalid reason or control, non-revocable entity kind |
| 401 | `AUTHENTICATION_FAILED` | No `Bearer` credential, or one no administrator or ordinary credential matches |
| 403 | `AUTHORIZATION_FAILED` | A valid ordinary credential — not an administrator |
| 404 | `AUTHORITY_ADMIN_TARGET_NOT_FOUND` | The grant, execution or entity is not held for this organization |
| 404 | `AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED` | The Host did not compose the capability the route administers |
| 404 | `NOT_FOUND` | No such administration route or method (including every un-revoke shape), or the API is not configured |
| 409 | `AUTHORITY_ADMIN_OPERATION_REFUSED` | The owning service refused for a domain reason other than the above (code in the message) |
| 415 | `INVALID_REQUEST` | A mutation body that is not `application/json` |
| 500 | `AUTHORITY_STATE_INTEGRITY_FAILED` | The authoritative state could not be verified; `failure` names the store condition (e.g. `BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT`, `BOUNDED_GRANT_STORE_STATE_CORRUPT`, `BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED`, `KERNEL_AUTHORITY_INTEGRITY_FAILED`, `EMERGENCY_CONTROL_STORE_STATE_CORRUPT`). **Nothing was reported or changed.** Never a 404, never a status |
| 500 | `INFRASTRUCTURE_FAILURE` | Unexpected Host fault |
| 503 | `AUTHORITY_STATE_UNAVAILABLE` | The owning store is unavailable |
| 503 | `ENTERPRISE_NOT_READY` | The Host lifecycle is not ready |

A refused administrative request is also a no-op: nothing is read past the
refusal point and nothing is written. Error text carries no secret, SQL, file
path or key material.

## 6. Audit and correlation

| Question | Where it is answered |
|---|---|
| Who (trusted actor) | `operator:<operatorId>` in the owning store's record (§2.2) — the signed revocation for bounded grants |
| What | The store's event type (`grant revocation`, `KernelAuthorityEntityRevoked`, `activated`/`released`) |
| Which target | The canonical id: `grantId`, `(entityKind, entityId)`, `(scope, value)` |
| When | The store's own timestamps (`revokedAt`, `occurredAt`, `recorded_at`) on the Host clock |
| Outcome | The HTTP response, and the structured log line `enterprise.admin.authority` with `operatorId`, `operation`, `target`, `status`, `organizationId` (no credential) |
| Correlation to governed actions | A bounded grant's `provenance.requestId` is the governed request; its P8 stream carries `grant.issued` … `grant.revoked`. §4.2 goes from `executionId` to grant. A later denial is a new governed request whose Kernel reason names the revoked entity |

**Residual (honest):** the canonical P8 `grant.revoked` event carries the
reason but not the actor (the actor is in the signed revocation); Kernel
Authority and emergency-control mutations are not on the P8 stream at all
(they are in their own hash-chained histories); there is no single
administration request id threaded through every store. Unifying the trace is
ASSURE-01.

## 7. Threat review

| Threat | Status | How |
|---|---|---|
| Ordinary credential escalates to administration | **mitigated** | Separate credential class; ordinary → 403; tests + non-vacuity M1, M2 |
| Unauthenticated reach | **mitigated** | 401 before any read or body parse |
| Forged admin flag / role / permissions | **mitigated** | Never read; closed bodies refuse them |
| Forged actor / issuer / timestamps | **mitigated** | Actor from configuration; body fields refused; non-vacuity M3, M4 |
| Cross-organization target substitution | **mitigated** | Served organization fixed server-side; other org's records 404 and untouched |
| ID enumeration | **partially mitigated** | Only administrators get past 401/403; ids are 128-bit hashes (grants) or operator-chosen (entities). No rate limiting (residual, PROD-04) |
| Replay / retry | **mitigated** | Revocation idempotent in every store; a repeat reports the first record |
| Concurrent revocation | **mitigated** | CORE-01 serialized sign-then-commit with stale-plan re-verification; Kernel Authority transactional append; tested 24-way and 12-way |
| Malformed ids / oversized bodies / malicious extra fields | **mitigated** | Canonical id checks, 16 KiB bound, closed schemas |
| Authority-store corruption or deletion | **mitigated (fail closed)** | 500 `AUTHORITY_STATE_INTEGRITY_FAILED`, never 404/active; for the signed grant store the Host also goes not-ready and nothing executes (PROD-01) |
| Stale state | **mitigated** | No cache: every read is an authoritative store read; Kernel world re-hydrated on commit |
| Secret leakage | **mitigated** | Counts only in `/health` and public configuration; messages name variables, never values; tested |
| Direct database bypass through the API | **mitigated** | Service has no driver, SQL, signer or issuance surface (structural tests) |
| Confused deputy (API performs something the operator cannot) | **mitigated** | The API can only call revoke/inspect/emergency operations; no issuance or provisioning is reachable from it |
| **Administrator credential theft** | **residual** | A stolen administrator secret *is* an administrator: it can revoke authority and stop or resume execution (it cannot mint authority). No MFA, SSO, per-human identity, approval quorum or external signing custody — CTRL-02, CTRL-04, CORE-02, PROD-04. Rotate by changing the variable and restarting |
| Rate limiting / brute force | **residual** | None on any Host route (PROD-04). Secrets ≥ 32 characters |
| Signer on the revocation critical path | **residual** | AA-004: a revocation fails loudly if the signer is unavailable (CORE-02) |
| Snapshot rollback of a whole store | **residual** | CORE-07 |

## 8. Operator runbook

Everything below uses only the HTTP API. Replace the placeholders; never paste
a secret into a ticket or a shell history you do not control.

```bash
export FRONTERA=https://frontera.internal.example        # your Host
export ADMIN="Authorization: Bearer $FRONTERA_ADMIN_KEY"  # from your secret manager
```

**0. Confirm the API is enabled and the Host is healthy.**

```bash
curl -s "$FRONTERA/health" | jq '{status, posture}'
# posture.authorityAdministration == "enabled", authorityStore == "authenticated-durable"
```

**1. Stop the bleeding (optional, incident only).** Stop one agent, or everything:

```bash
curl -s -X POST "$FRONTERA/api/admin/emergency-controls/activate" -H "$ADMIN" \
  -H 'content-type: application/json' -d '{"scope":"actor","value":"actor-agent"}'
# or {"scope":"global"}
curl -s "$FRONTERA/api/admin/emergency-controls" -H "$ADMIN"
```

**2. Inspect the authority the agent acts under.**

```bash
curl -s "$FRONTERA/api/admin/authority/entities/delegation-grant/delegation-agent" -H "$ADMIN" | jq
```

If you start from a governed-action response or application log, resolve the
grant it ran under and inspect it:

```bash
curl -s "$FRONTERA/api/admin/authority/executions/<executionId>" -H "$ADMIN" | jq .grantId
curl -s "$FRONTERA/api/admin/authority/grants/<grantId>" -H "$ADMIN" | jq '{status, revocation, provenance}'
```

**3. Revoke.** Standing authority (stops future actions):

```bash
curl -s -X POST "$FRONTERA/api/admin/authority/entities/delegation-grant/delegation-agent/revoke" \
  -H "$ADMIN" -H 'content-type: application/json' -d '{"reason":"agent offboarded after INC-1234"}'
```

A specific bounded grant (stops that grant):

```bash
curl -s -X POST "$FRONTERA/api/admin/authority/grants/<grantId>/revoke" \
  -H "$ADMIN" -H 'content-type: application/json' -d '{"reason":"security-incident"}'
```

A retry is safe: it answers `already-revoked` with the original record.

**4. Verify the revoked state.**

```bash
curl -s "$FRONTERA/api/admin/authority/entities/delegation-grant/delegation-agent" -H "$ADMIN" | jq '{status, revokedBy, revokedAt}'
# "status": "revoked", "revokedBy": "operator:<your operatorId>"
```

**5. Verify governed execution is blocked.** Ask the application (or use a test
principal) to attempt the action; `POST /api/governed-actions` answers
`"status": "denied"` for revoked standing authority (or `"withheld"` with
`"withheldBy": "emergency-control"` while a stop is active), and the provider
adapter is not called.

**6. Resume (only if you stopped execution in step 1).**

```bash
curl -s -X POST "$FRONTERA/api/admin/emergency-controls/release" -H "$ADMIN" \
  -H 'content-type: application/json' -d '{"scope":"actor","value":"actor-agent"}'
```

**If a call returns `500 AUTHORITY_STATE_INTEGRITY_FAILED`:** treat it as a
security incident. The authority store's contents could not be verified; the
Host reports nothing from it and `/ready` will be failing. Do not attempt to
"fix" the database: restore the store files from a trusted copy
(`AUTHORITATIVE_GRANT_STORE.md`, `AUTHORITY_ARTIFACT_AUTHENTICITY.md`).

**Restoring authority after a revocation** is not an administration operation:
revocation is permanent. Provision new authority under a new id (today through
the trusted in-process provisioning surface; CTRL-02 owns the API for it).
