# Authority Administration API (CTRL-01) and the Operator Plane (CTRL-02)

> **Since CTRL-02** the `/api/admin/...` family is the identified **operator plane**: CTRL-02 operators (`operators[]`, one role each) authenticate here alongside CTRL-01 administrators, every operation checks one permission (§10), and the operator plane adds agent inventory, operator-issued agent credentials, Kernel-Authority provisioning and the Governance Profile lifecycle (§10). A CTRL-01 administrator keeps exactly the CTRL-01 operations below — never provisioning. Rows in §1 marked *CTRL-02* supersede this document's CTRL-01-era "not exposed" statements.

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
| Provision Kernel Authority (actors, trust domains, grants, delegations) | **CTRL-02: yes, to identified operators by role — never to a CTRL-01 administrator** | `POST /api/admin/authority/entities/{kind}` → `KernelAuthorityProvisioningService` (§10). Over a CTRL-01 administrator credential it stays refused (403): a shared administrator secret is still the wrong boundary for creating standing authority. |
| Delegation / attenuation | **no** | No new delegation semantics. Delegations are Kernel Authority entities; they can be inspected and revoked here, not created. |
| Un-revoke, delete or clear a revocation, reactivate | **no — and never** | Revocation is monotonic in every store. Restoring authority is new provisioning under a new id. No route, service method or port offers it. |
| Listing / search | **CTRL-02: yes, to operators** (`GET /api/admin/authority/entities?kind=&status=`, `GET /api/admin/agents`) | CTRL-01 administrators remain inspect-by-known-id only (§6). |
| Organizations, human operators, agents | **CTRL-02: yes** (§10) | — |
| Policy CRUD, payments, KMS | **no** | CORE-03, PAY, CORE-02 (approvals: CTRL-04, §12; web UI: CTRL-03, §11.2) |

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

`bounds` lists every axis the grant states, derived from the grant runtime's
own axis list (so an axis the exercise gate enforces can never be missing
here). Since CORE-03 a semantic grant also shows `actionClass`,
`resourceClass` and `governanceProfile` (an identity bound on
`<profileId>@<version>#sha256:…`), the top-level `semanticsFormat`
(`frontera.grant-semantics.v1`) and, when the grant bounds typed parameters,
`bounds.parameters`:
`[{ dimension, kind: "exact", type, value } | { dimension, kind: "maximum", type: "integer", limit }]`
in canonical dimension order. A grant issued before CORE-03 shows none of these.

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
| 401 | `AUTHENTICATION_FAILED` | No `Bearer` credential, or one no operator, administrator or ordinary credential matches (an operator-issued agent credential is unknown here) |
| 403 | `AUTHORIZATION_FAILED` | A valid ordinary credential — not an operator or administrator |
| 403 | `OPERATOR_PERMISSION_DENIED` | CTRL-02: an operator or administrator whose role does not hold the operation's permission. The body was not read; nothing changed |
| 404 | `AUTHORITY_ADMIN_TARGET_NOT_FOUND` | The grant, execution or entity is not held for this organization |
| 404 | `AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED` | The Host did not compose the capability the route administers |
| 404 | `NOT_FOUND` | No such administration route or method (including every un-revoke shape), or the API is not configured |
| 409 | `AUTHORITY_ADMIN_OPERATION_REFUSED` | The owning service refused for a domain reason other than the above (code in the message) |
| 415 | `INVALID_REQUEST` | A mutation body that is not `application/json` |
| 500 | `AUTHORITY_STATE_INTEGRITY_FAILED` | The authoritative state could not be verified; `failure` names the store condition (e.g. `BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT`, `BOUNDED_GRANT_STORE_STATE_CORRUPT`, `BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED`, `KERNEL_AUTHORITY_INTEGRITY_FAILED`, `EMERGENCY_CONTROL_STORE_STATE_CORRUPT`, and — CORE-07 — `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`, `…_FORK_DETECTED`, `…_BINDING_MISMATCH`, `…_PENDING_RECOVERY`, `…_UNBOUND_STORE`, `…_WITNESS_UNAUTHENTIC`). **Nothing was reported or changed.** Never a 404, never a status |
| 500 | `INFRASTRUCTURE_FAILURE` | Unexpected Host fault |
| 503 | `AUTHORITY_STATE_UNAVAILABLE` | The owning store is unavailable |
| 503 | `AUTHORITY_SIGNER_UNAVAILABLE` | CORE-02: the authority signer could not sign; `failure` is the closed reason, `recorded: false`. **Nothing was recorded**: the grant remains exercisable (use an emergency stop) |
| 503 | `AUTHORITY_FRESHNESS_UNAVAILABLE` | CORE-07: the authority-state witness could not prepare the revocation (unreachable, or another writer advanced first); `failure` is the closed code, `recorded: false`. **Nothing was recorded**: the grant remains exercisable (use an emergency stop — it depends on neither the signer nor the witness) |
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
| Snapshot rollback of a whole store | **closed for the grant, discharge and approval stores with an external freshness witness** (CORE-07; always on the secure Host); residual for the witness restored with them, and for the other stores | CORE-07 / PROD-02 |

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

**If a call returns `503 AUTHORITY_FRESHNESS_UNAVAILABLE`:** the revocation
was **not** recorded — the authority-state witness (CORE-07) did not prepare it.
Declare an emergency stop now, restore the witness, and retry the revocation.

**If a call returns `500 AUTHORITY_STATE_INTEGRITY_FAILED`:** treat it as a
security incident. The authority store's contents could not be verified — or,
with a `failure` of `AUTHORITY_FRESHNESS_*`, the store is not the newest state
its witness holds (a rollback, a fork, a substituted store, a pending
transition) — so the Host reports nothing from it and `/ready` will be failing. Do not attempt to
"fix" the database: restore the store files from a trusted copy
(`AUTHORITATIVE_GRANT_STORE.md`, `AUTHORITY_ARTIFACT_AUTHENTICITY.md`).

**Restoring authority after a revocation** is not an administration operation:
revocation is permanent. Provision new authority under a new id — since CTRL-02
over `POST /api/admin/authority/entities/{kind}` by an operator whose role
permits it (§10). A revoked actor is never re-onboarded under its id or its
external subject; onboard a new agent identity.

## 10. The operator plane (CTRL-02)

Decision record: `docs/architecture/ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md`.
Qualification: `docs/security/CTRL-02-ORGANIZATIONS-OPERATORS-AGENT-INVENTORY.md`.

### 10.1 Operators and roles

Configured in the governed-action file — `"operators": [{ "operatorId": "ops-alice", "role": "provisioner", "apiKeyEnv": "FRONTERA_OPERATOR_KEY_ALICE" }]` — each with a secret of at least 32 characters, unique across every credential. The organization is the Host's own; the operator identity every store records is `operator:<operatorId>`. No request can state an operator, role, permission, organization or `system` flag.

| Role | May |
|---|---|
| `observer` | read: the organization and itself, the agent inventory, Kernel-Authority entities, Governance Profile versions, and the CTRL-01 reads |
| `responder` | read; revoke Kernel-Authority entities and bounded grants; revoke an agent credential; declare an emergency stop. Never create, widen or release |
| `provisioner` | read; provision actors (human, agent), passports, capability tokens, authority and delegation grants; issue, rotate and revoke agent credentials; revoke |
| `profile-steward` | read; activate and retire Governance Profile versions |
| `organization-administrator` | everything, including organization bootstrap (trust domains, root issuers, organization/system actors) and emergency release |
| *CTRL-01 administrator* | exactly the CTRL-01 operations (§4): inspect, revoke, emergency stop and release |

### 10.2 Endpoints

| Method | Path | Permission | Body |
|---|---|---|---|
| GET | `/api/admin/organization` | `organization.read` | — |
| GET | `/api/admin/agents` | `inventory.read` | — |
| GET | `/api/admin/agents/{actorId}` | `inventory.read` | — |
| POST | `/api/admin/agents/{actorId}/credentials` | `agent-credential.manage` | `{ idempotencyKey }` |
| POST | `/api/admin/agents/{actorId}/credentials/{credentialId}/rotate` | `agent-credential.manage` | `{ idempotencyKey }` |
| POST | `/api/admin/agents/{actorId}/credentials/{credentialId}/revoke` | `agent-credential.revoke` | `{ reason }` |
| GET | `/api/admin/authority/entities?kind=&status=` | `inventory.read` | — |
| POST | `/api/admin/authority/entities/{kind}` | `authority.provision` (`authority.bootstrap` for `trust-domain`, `root-issuer`, organization/system actors) | the kind's closed schema + optional `idempotencyKey` |
| GET | `/api/admin/governance-profiles` | `inventory.read` | — |
| POST | `/api/admin/governance-profiles/{profileId}/versions/{version}/activate` | `profile.promote` | `{ digest, reason? }` |
| POST | `/api/admin/governance-profiles/{profileId}/versions/{version}/retire` | `profile.retire` | `{ digest, reason? }` |

Provisioning bodies mirror the Kernel Authority's own inputs (`actor`: `actorId, type, displayName, issuerId?, trustDomainId?, jurisdiction?, externalSubject?`; `passport`; `capability-token`; `authority-grant` with optional P10 `constraints` and optional typed `parameterBounds`; `delegation-grant` likewise; `trust-domain`; `root-issuer`).

**Typed parameter authority (`parameterBounds`).** A standing bound on a CORE-03 governed parameter, in the canonical bound shape: `{ "dimension": "replicaCount", "kind": "maximum", "type": "integer", "limit": 3 }` or `{ "dimension": "deploymentStrategy", "kind": "exact", "type": "token", "value": "rolling" }` (also exact integer and boolean). One bound per dimension. The dimension must be declared in the governed-action file's `governance.parameterDimensions` with the same type (`maximum` only on a `maximum` dimension), and an active Governance Profile must govern it for every action × resource pair in the grant's scope — otherwise the bound is refused (409 `PARAMETER_BOUND_*`) rather than stored as if it constrained something. A delegation must restate every upstream bound, equal or narrower; it may add new ones. At decision every bound on the agent's lineage applies, and a request outside them is `withheld` (`authority-binding`, `PARAMETER_AUTHORITY_EXCEEDED` / `PARAMETER_AUTHORITY_VALUE_REQUIRED`) before any grant or adapter call — no policy pack or source change needed. Overlapping grants for one action are not merged: the Authority Graph picks one lineage deterministically (first matching grant by id). Every named actor, trust domain and source grant must exist and be active; the would-be world is replayed through the engines before the write. A query string other than the listed filters is refused (an organization can never be named). There is no route that mints a bounded grant.

An issued credential (`fra1.agc-….…`) appears **once**, in `bearerCredential` of the issuing or rotating response; a replay answers `bearerCredential: null`. Hand it to the agent's runtime as its `Authorization: Bearer` credential for `POST /api/governed-actions`.

### 10.3 Additional errors

| HTTP | `code` | Meaning |
|---|---|---|
| 403 | `OPERATOR_PERMISSION_DENIED` | The role lacks the permission |
| 409 | `OPERATOR_IDEMPOTENCY_CONFLICT` | The idempotency key was used for a different request; nothing written |
| 503 | `AUTHORITY_STATE_REFRESH_FAILED` | The write **was durably recorded** (`recorded: true`), and refreshing the in-memory authority (or profile lifecycle) projection failed; decisions are denied until a refresh succeeds. Retry the **same** request (same target, terms and idempotency key) — it replays the committed record and refreshes. Never submit a different request instead |
| 409 | `OPERATOR_OPERATION_REFUSED` | The authoritative store or lifecycle refused (`failure`: e.g. `KERNEL_AUTHORITY_ENTITY_CONFLICT`, `KERNEL_AUTHORITY_ENTITY_REVOKED`, `KERNEL_AUTHORITY_REFERENCE_INVALID`, `KERNEL_AUTHORITY_REFERENCE_REVOKED`, `KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT`, `PROFILE_DIGEST_MISMATCH`, `PROFILE_LIFECYCLE_STATIC`, `CONTROL_PLANE_CONFLICT`, `PARAMETER_BOUND_DIMENSION_UNDECLARED`, `PARAMETER_BOUND_DECLARATION_MISMATCH`, `PARAMETER_BOUND_UNVERIFIABLE`, `PARAMETER_BOUND_REMOVED`, `PARAMETER_BOUND_WIDENED`); `recorded: false` |

### 10.4 Runbook — onboard a pilot agent (no source, REPL or database)

```bash
ADMINOP="authorization: Bearer $FRONTERA_OPERATOR_KEY_ADMIN"     # organization-administrator
PROV="authorization: Bearer $FRONTERA_OPERATOR_KEY_ALICE"         # provisioner
J='content-type: application/json'
# once per organization: the issuer, its trust domain, its root-issuer standing
curl -s -X POST "$FRONTERA/api/admin/authority/entities/actor" -H "$ADMINOP" -H "$J" -d '{"actorId":"actor-org","type":"organization","displayName":"Acme"}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/trust-domain" -H "$ADMINOP" -H "$J" -d '{"trustDomainId":"td-acme","name":"Acme","issuerActorId":"actor-org","acceptedIssuerIds":["actor-org"],"acceptedActorTypes":["human","agent","organization"]}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/root-issuer" -H "$ADMINOP" -H "$J" -d '{"trustDomainId":"td-acme","actorId":"actor-org"}'
# per agent: owner and agent actors, the agent's credential, bounded standing authority
curl -s -X POST "$FRONTERA/api/admin/authority/entities/actor" -H "$PROV" -H "$J" -d '{"actorId":"actor-treasurer","type":"human","displayName":"Treasurer","issuerId":"actor-org","trustDomainId":"td-acme"}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/actor" -H "$PROV" -H "$J" -d '{"actorId":"actor-payables","type":"agent","displayName":"Payables","issuerId":"actor-org","trustDomainId":"td-acme","externalSubject":{"system":"erp","subjectId":"payables-1"}}'
curl -s -X POST "$FRONTERA/api/admin/agents/actor-payables/credentials" -H "$PROV" -H "$J" -d '{"idempotencyKey":"payables-cred-0001"}'   # store bearerCredential now: shown once
curl -s -X POST "$FRONTERA/api/admin/authority/entities/authority-grant" -H "$PROV" -H "$J" -d '{"authorityGrantId":"grant-payables","issuerActorId":"actor-org","subjectActorId":"actor-treasurer","trustDomainId":"td-acme","capability":"payables.manage","actions":["transfer-funds"],"resourceScopes":["operating-account"],"canDelegate":true,"allowedDelegateActorTypes":["agent"],"maxDelegationDepth":1,"constraints":[{"type":"max_amount","currency":"USD","value":"500"},{"type":"spending_limit","limitId":"payables-lifetime","currency":"USD","maximum":"10000","window":{"kind":"lifetime"}}]}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/passport" -H "$PROV" -H "$J" -d '{"passportId":"passport-payables","type":"agent_passport","subjectActorId":"actor-payables","issuerActorId":"actor-org","trustDomainId":"td-acme"}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/capability-token" -H "$PROV" -H "$J" -d '{"capabilityTokenId":"cap-payables","subjectActorId":"actor-payables","principalActorId":"actor-treasurer","issuerActorId":"actor-treasurer","trustDomainId":"td-acme","capability":"payables.execute","actions":["transfer-funds"],"resourceScopes":["operating-account"],"riskLevel":"medium"}'
curl -s -X POST "$FRONTERA/api/admin/authority/entities/delegation-grant" -H "$PROV" -H "$J" -d '{"delegationGrantId":"delegation-payables","delegatorActorId":"actor-treasurer","delegateActorId":"actor-payables","delegateActorType":"agent","trustDomainId":"td-acme","sourceAuthorityGrantId":"grant-payables","capability":"payables.execute","actions":["transfer-funds"],"resourceScopes":["operating-account"],"canRedelegate":false}'
curl -s "$FRONTERA/api/admin/agents/actor-payables" -H "$PROV"     # onboarding: actor active, credential active, standing authority assigned
```

**Credential semantics.** A credential is matched only against the credential classes of the plane it reaches: an agent credential on `/api/admin`, or an operator credential on `/api/governed-actions`, is unknown there (401); no wrong-plane credential is ever accepted. Credential revocation is terminal within one monotonic control-plane store history; restoring an older copy of `control-plane.sqlite` (unsigned, not witnessed, not in `backup:v1`) resurrects revoked and pre-rotation credentials and earlier profile lifecycle state — revoke the agent's actor (Kernel Authority) after any such restore. **Profile promotion is permitting:** activating a less-demanding catalog version relaxes that profile's own requirements; only profile-stewards and organization administrators may do it.

A financial action needs both a per-execution ceiling (`max_amount`) and an aggregate limit (`spending_limit`) on its authority lineage; without the latter it is withheld (P10). Offboarding: `POST /api/admin/authority/entities/actor/actor-payables/revoke` (terminal; every credential bound to the agent stops admitting it), or revoke one credential (`…/credentials/{id}/revoke`) to replace it.

## 11. Decision activity and evidence (CTRL-03), and the web control plane

Decision record: `docs/architecture/ADR-CTRL-03-WEB-CONTROL-PLANE.md`.
Qualification: `docs/security/CTRL-03-WEB-CONTROL-PLANE-MVP.md`.

### 11.1 Endpoints

| Method | Path | Permission | Query |
|---|---|---|---|
| GET | `/api/admin/activity/decisions` | `inventory.read` | `actorId`, `decisionId`, `requestId`, `status` (`allowed`, `denied`, `approval_required`, `indeterminate`), `limit` (1–100, default 25), `cursor` (opaque, from `nextCursor`); any other key → 400 |
| GET | `/api/admin/evidence/decisions/{evaluationId}` | `inventory.read` | none accepted |

Both are **read-only**, scoped to the one organization the Host serves (an
organization in the query is refused), and serialize restated DTOs:

- **Activity:** `{ decisions: [{ evaluationId, decisionId, requestId, correlationId, actorId, actionType, status, reasonCodes, evaluatedAt, persistedAt }], nextCursor, coverage: "governance-store-decisions" }`, newest committed first. `status` is the **Kernel decision**: a request withheld after an `allowed` decision (for example by standing parameter authority, `PARAMETER_AUTHORITY_EXCEEDED`) is listed as `allowed` and records no grant.
- **Evidence:** `{ decision, integrity, references, verification, coverage: "governance-store-decision-record" }` — the request summary and Kernel decision, the aggregate digest and chain position, every reference appended to the record (`authorization_artifact` = the bounded grant id, `execution_record` = the execution attempt / outcome), and `GovernanceStore.verify`'s result (`valid`, per-check booleans, failures, reference-integrity counts). Verification is digest integrity: it detects modification, it is not a signature.
- Unknown evaluation → 404 `AUTHORITY_ADMIN_TARGET_NOT_FOUND`. A CTRL-01 administrator → 403 `OPERATOR_PERMISSION_DENIED`; an API key → 403; an agent credential, anonymous → 401.

### 11.2 The web control plane

`npm run start:control-plane` starts the Frontera web control plane — a
server-rendered, script-free console that operates a Host through this
operator plane only (it holds no store or key):

```bash
FRONTERA_CONSOLE_HOST_URL=http://127.0.0.1:8787 \
FRONTERA_CONSOLE_HTTP_PORT=8788 \
npm run start:control-plane            # then browse http://127.0.0.1:8788
```

| Variable | Meaning |
|---|---|
| `FRONTERA_CONSOLE_HOST_URL` | The Host's base URL. `https://` unless loopback. Required |
| `FRONTERA_CONSOLE_HTTP_HOST` / `FRONTERA_CONSOLE_HTTP_PORT` | Bind address / port. Default `127.0.0.1:8788` (the Host defaults to 8787) |
| `FRONTERA_CONSOLE_PUBLIC_ORIGIN` | The exact origin browsers use; required, and `https://`, when binding a non-loopback address (terminate TLS in front of the console) |
| `FRONTERA_CONSOLE_SESSION_IDLE_SECONDS` / `FRONTERA_CONSOLE_SESSION_MAX_SECONDS` | Session idle timeout (default 1800) / absolute lifetime (default 28800, at most 43200) |

Operators sign in with their CTRL-02 operator credential; it is verified
against `GET /api/admin/organization` and held only in the console's server
memory for the session (the browser receives an opaque `HttpOnly`,
`SameSite=Strict` cookie). CTRL-01 administrator credentials, API keys and
agent credentials cannot sign in. Every operation is forwarded to the Host,
which authorizes it; an agent credential's secret is shown once, on the page
that issued it.

## 12. Approval & escalation workflow (CTRL-04)

Decision record: `docs/architecture/ADR-CTRL-04-APPROVAL-ESCALATION-WORKFLOW.md`.
Qualification: `docs/security/CTRL-04-APPROVAL-ESCALATION-WORKFLOW.md`.

Mounted only when operators are configured **and** a Governance Profile
declares an `approval` requirement (CORE-05 approvals composed). The Host
computes nothing about an approval: every answer is CORE-05's derived view,
restated field by field, and every verdict is a CORE-05 command whose acting
approver is the authenticated operator.

### 12.1 Endpoints

| Method | Path | Permission | Body / query |
|---|---|---|---|
| GET | `/api/admin/approvals` | `approval.read` | `view` = `pending` (default), `escalated`, `approved`, `rejected`, `revoked`, `expired`, `superseded`, `all`; any other key → 400 |
| GET | `/api/admin/approvals/{approvalRequestId}` | `approval.read` | none accepted |
| POST | `/api/admin/approvals/{approvalRequestId}/approve` | `approval.approve` | `{ subjectDigest, evidence?: [{ type, hash, uri? }], reason? }` |
| POST | `/api/admin/approvals/{approvalRequestId}/reject` | `approval.restrict` | `{ subjectDigest, reason? }` |
| POST | `/api/admin/approvals/{approvalRequestId}/request-changes` | `approval.restrict` | `{ subjectDigest, reason? }` |
| POST | `/api/admin/approvals/{approvalRequestId}/escalate` | `approval.restrict` | `{ subjectDigest, reason }` — the reference is **required** (it is what the Escalated view routes on) |
| POST | `/api/admin/approvals/{approvalRequestId}/revoke` | `approval.restrict` | `{ subjectDigest, reason? }` |

Permissions: `approval.read` — observer, responder, approver, organization
administrator; `approval.restrict` — responder, approver, organization
administrator; `approval.approve` — approver, organization administrator.
Provisioners, profile stewards and CTRL-01 administrators hold none.

Bodies are closed `application/json` of at most 16 KiB: anything but
`subjectDigest`, `evidence` and `reason` (an actor, approver, channel,
organization, role, state, quorum, proof — even `approvalRequestId`) is refused
(400). `subjectDigest` is the digest of the subject the operator reviewed
(`sha256:` + 64 hex); strings ≤ 256 characters; ≤ 32 evidence references, each
hash `sha256:` + 64 lowercase hex.

### 12.2 Who may approve

The operator role only reaches a command. The verdict counts only if the
Kernel-Authority actor **`operator:<operatorId>`** — the operator's canonical
identity — is recognized and holds live authority for the profile's
`approverAction` (never the governed action) over exactly the request's
resource. An organization makes an operator an approver over this same
operator plane: provision a `human` actor with id `operator:<operatorId>`, then
an `authority-grant` whose `actions` is the approver action and whose
`resourceScopes` are the resources they may approve. Revoking that grant
withdraws the operator's unused approvals.

### 12.3 Responses

- **Inbox:** `{ view, approvals: [{ approvalRequestId, requestId, decisionId, requestedAt, status, actorId, action, resourceScope, governanceProfile, quorum: { minimumApprovals, countedApprovers, satisfied }, requestExpiresAt, escalations: [{ actorId, recordedAt, reason }], changesRequested }] }`.
- **Detail:** the inbox fields plus `subjectDigest`, `canonicalSubject` (the exact bytes the digest is over), `subject` (evaluation, actor, principal, action, resource, counterparty, amount, typed parameters, Governance Profile and classes, context digest and validity, Kernel decision, recorded digests), `requirement` (`approverAction`, `minimumApprovals`, `requestTtlSeconds`, `approvalValiditySeconds`, `requiredEvidence`, `digest`), `superseded`, `approvedAt`, `notAfter`, `approvalDigest`, `closedBy`, `verdicts: [{ kind, actorId, recordedAt, recordedBy, counted, reasonCode, reason, evidence, rowDigest }]`. `status`, `quorum`, `counted`, `reasonCode`, `approvedAt`, `notAfter`, `approvalDigest` are **derived** by CORE-05 at read time.
- **Command:** `{ outcome: "recorded", verdict, approval }` — `approval` is CORE-05's re-read after the append. An approval is not an execution: the original requester retries its governed action (same idempotency key) to resume the same committed decision.

### 12.4 Errors

| Situation | Status | `error.code` | `error.failure` |
|---|---|---|---|
| no / unknown credential; agent credential | 401 | `AUTHENTICATION_FAILED` | — |
| API key | 403 | `AUTHORIZATION_FAILED` | — |
| role lacks the permission; CTRL-01 administrator | 403 | `OPERATOR_PERMISSION_DENIED` | — |
| malformed body or query | 400 | `INVALID_REQUEST` | — |
| unknown approval request (in this organization) | 404 | `AUTHORITY_ADMIN_TARGET_NOT_FOUND` | — |
| reviewed subject differs | 409 | `OPERATOR_OPERATION_REFUSED` | `APPROVAL_SUBJECT_MISMATCH` |
| no live approval standing | 409 | ″ | `APPROVAL_APPROVER_INELIGIBLE` (+ `reasonCode`) |
| requester approving its own request | 409 | ″ | `APPROVAL_SEGREGATION_OF_DUTIES` |
| same approver again | 409 | ″ | `APPROVAL_DUPLICATE` |
| required evidence not cited | 409 | ″ | `APPROVAL_EVIDENCE_INSUFFICIENT` |
| request closed | 409 | ″ | `APPROVAL_REJECTED`, `APPROVAL_REVOKED`, `APPROVAL_REQUEST_EXPIRED`, `APPROVAL_ALREADY_APPROVED`, `APPROVAL_EXPIRED` (+ `approvalStatus`) |
| profile or requirement changed | 409 | ″ | `APPROVAL_REQUEST_SUPERSEDED` |
| approval state unverifiable (on a command: whether it was recorded is unknown — re-read) | 500 | `AUTHORITY_STATE_INTEGRITY_FAILED` | store code |
| approval store unavailable | 503 | `AUTHORITY_STATE_UNAVAILABLE` | — (re-read before retrying) |

Every 409 carries `recorded: false`. There is no un-reject, un-revoke, restore,
delete or execute route. Escalation is recorded and listed in the `escalated`
view with its reference; it counts toward nothing and notifies no one (alerts:
CTRL-05).

### 12.5 In the web control plane

The console's **Approvals** section lists the inbox views, shows one request's
derived state, canonical subject, requirement snapshot and recorded verdicts,
and offers one confirmation page per verdict (evidence rows for each required
type; an explicit confirmation; the subject digest of the page it rendered).
After every verdict it re-reads the Host; after a refusal it shows the Host's
reason and the current subject.
