# ADR: Durable Grants + Truthful Effective Revocation (Sovereign Execution Binding, Slice 1)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Sequence: Slice 1 of N, Sovereign Execution Binding
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/durable-grants-revocation-tctqpg`
- Related: `ADR-ACCESS-LIFECYCLE.md` (R005.0, frozen input), `ADR-PROVIDER-ADAPTER-CONTRACT.md`
  (R005.A, frozen input), `ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B, frozen
  input), `ADR-PINATA-PROVIDER-ADAPTER.md` (R005.C, extended — see "GAP-012"
  below), `ADR-ACCESS-GRANT.md` (R004.G, frozen input), `ADR-GRANT-REVOCATION.md`
  (R004.H, frozen input)

## Role of this document

This ADR records Slice 1 of Sovereign Execution Binding: converting

> "Enterprise records that a grant was revoked"

into

> "Enterprise durably records revocation, prevents future authorization,
> invokes the strongest truthful provider-side enforcement available,
> measures when revocation actually becomes effective, and produces
> correlated evidence."

It does **not** claim, and this slice explicitly forbids claiming, "Soberanía
instantly kills every Pinata URL." That claim is false for the current
Pinata provider and is never made by this slice's code, tests, or
documentation.

---

## Four distinct concepts this slice keeps rigorously separate

Prior framing conflated "Enterprise revoked a grant" with "access to that
resource stopped." This slice's central architectural contribution is
separating that single claim into four, each independently true or false,
independently recorded:

1. **Governance Revocation** — the durable, tenant-scoped business fact
   that Frontera Systems no longer considers a grant valid. Represented by
   `AccessGrantRecord.status: 'revoked'` plus an
   `AccessGrantRevocationRecord`
   (`src/enterprise/access-governance/contracts.ts`), composed directly
   from the frozen `EnterpriseAccessGrant` (R004.G) /
   `EnterpriseGrantRevocation` (R004.H) canonical contracts. This is
   **always** immediate and durable, by construction: `AccessGrantStore.beginRevocation`
   persists it before any provider is ever contacted.

2. **Provider Revocation** — whatever action Enterprise attempted to take
   on the provider's own side (`AccessGrantProviderEnforcementResult.providerAction`/
   `.providerActionResult`). May be `'executed'`, `'failed'`, or `'skipped'`
   — skipped is not a defect; it is the truthful outcome when acting would
   either be unsupported or (for Pinata, most reasons) would over-revoke a
   shared resource. See "Never delete/unpin an entire resource merely to
   simulate per-grant revocation" below.

3. **Effective Revocation** — when access to the resource *actually* stops,
   as truthfully determined or measured
   (`AccessGrantProviderEnforcementResult.effectiveRevocationAt`/
   `.effectiveRevocationMode`/`.enforcementLagSeconds`/`.measured`). This is
   the concept prior framing erased by assuming it always equals
   Governance Revocation's own timestamp. It frequently does not.

4. **TTL-bounded Revocation** — the specific, honest case where Effective
   Revocation is bounded below by an already-issued credential's own
   recorded expiry, not by anything Enterprise did
   (`effectiveRevocationMode: 'ttl_bounded'`,
   `outstandingCredentialExpiresAt`). This is Pinata's true default for
   every revocation reason except `'resource-removed'` — see below.

No prior document in this repository named this distinction; `EnterpriseGrantRevocation`'s
own README already said as much ("it records that a grant is no longer
valid; it never makes that true anywhere else") but nothing built the layer
that turns that record into a truthful claim about the outside world. This
slice is that layer.

---

## The critical invariant

For a TTL-bounded provider:

```
effectiveRevocationAt >= latest outstanding capability expiry
```

unless the provider independently proves earlier invalidation (never true
for Pinata today — see below). This is enforced **by construction**, not by
assertion: `src/enterprise/access-governance/pinata-revocation-enforcement.ts`'s
`ttl_bounded` branch sets `effectiveRevocationAt` directly *from*
`grant.latestOutstandingCredentialExpiresAt`, never derives it from
`revokedAt`. `effectiveRevocationAt` is never computed as merely "the time
the governance record was created."

---

## Pinata's exact semantics — an adapter capability, never an Enterprise-wide limitation

This is the load-bearing correction of this slice. Pinata's inability to
selectively invalidate an already-issued signed access link is a fact
about **this one provider adapter**, verified directly against the real
`pinata` SDK surface (`packages/pinata-adapter/src/pinata-provider-client.ts`):
Pinata's private-gateway signed access links (`gateways.private.createAccessLink`)
carry their own `expires` bound and have no companion "revoke this link"
API. It is not evidence that Frontera Systems' architecture cannot support
real-time revocation — a future provider adapter (e.g. one fronting
short-lived, individually-revocable capability tokens) can genuinely
declare `effectiveRevocationMode: 'immediate_selective'`, and this
module's vocabulary already has a slot for that (`EffectiveRevocationMode`
in `contracts.ts`). Pinata remains the first reference provider, never the
architectural model — exactly the framing `ADR-PINATA-PROVIDER-ADAPTER.md`
already established for issuance; this slice extends it to revocation.

Distinguished rigorously (Slice 1's own required vocabulary):

| # | Concept | Pinata's truth |
|---|---|---|
| 1 | Governance revocation | Always immediate and durable (`beginRevocation`). |
| 2 | Prevention of future credential issuance | Always immediate — Enterprise-side gating (`requestProviderCredential` calls `assertActive`), independent of any provider primitive. |
| 3 | Provider-side invalidation action | `files.public.delete` — genuinely unpins/deletes the file record. The **only** action this adapter can honestly invoke; it has no other. |
| 4 | Actual invalidation of already-issued credentials | **Never** for a signed access link already issued — Pinata has no such API. `supportsSelectiveInvalidationOfIssuedCredential: false` (`packages/pinata-adapter/src/pinata-revocation-capability.ts`), verified against the real SDK, never inferred from a method name. |
| 5 | TTL-bounded effective revocation | The honest default for every revocation reason except `resource-removed` — the outstanding credential remains valid until its own recorded `expires`. |
| 6 | Resource-wide invalidation | What `files.public.delete` actually does when invoked — affects **every** grant against the resource, not only the one being revoked. |
| 7 | Unsupported selective invalidation | The truthful state for reasons 4/5/6 combined: Pinata is asked to selectively invalidate one credential and cannot. |

**Never delete/unpin an entire resource merely to simulate per-grant
revocation.** `pinataRevocationSemanticsForReason` (`pinata-revocation-capability.ts`)
is the single source of truth for when `files.public.delete` is even
attempted: **only** when the revocation `reason` is `'resource-removed'`
— the one case where the resource itself, not merely one principal's
access to it, is what's actually being revoked, matching
`ADR-ACCESS-LIFECYCLE.md`'s own worked example. For every other reason
(`administrator-revoked`, `policy-changed`, `principal-disabled`,
`manual-revocation`, `security-incident`, `expired`), this slice never
calls `files.public.delete` — doing so would revoke every other grant
against a resource shared across principals, which is not what was asked
for. `determineAndExecutePinataEnforcement`'s own test coverage
(`src/enterprise/__tests__/access-grant-revocation.test.ts`, "Test D")
proves the delete path is never invoked for those reasons.

**No false `blocked`/`invalidated` result is ever emitted.** `AccessGrantProviderEnforcementResult.providerActionResult`
is `'executed'` **only** when a real provider call actually succeeded;
`'skipped'` (with a truthful, non-generic `providerActionDetail` sentence)
covers every case where Enterprise deliberately did not attempt a provider
action, and `'failed'` covers a genuinely attempted, genuinely failed one.
There is no fourth value that could be mistaken for success.

---

## GAP-012: CID vs. Pinata file id conflation — fixed

A prior revision of `packages/pinata-adapter/src/pinata-provider-adapter.ts`
read `translation.resource.id` for **both** the Pinata CID
(`gateways.private.createAccessLink({ cid: resource.id })`) and Pinata's
own, separate internal file id (`files.public.get`/`files.public.delete`,
keyed by `resourceId`). These are different identities — Pinata's own SDK
types already keep them separate (`PinataResourceMetadata.cid` vs. `.id`)
— and conflating them means a translation correctly built for one
operation silently breaks the other against the real API.

**Fix** (`packages/pinata-adapter/src/pinata-provider-adapter.ts`,
`requirePinataFileId`): `resource.id` is now used **exclusively** as the
Pinata CID (`ProvideTemporaryAccess`/`ProvideReadOnlyAccess`).
`ProvideMetadata`/`InvalidateGrant` instead read Pinata's file id from
`translation.providerMetadata.pinataFileId` — `EnterpriseProviderTranslation.providerMetadata`
(`@aoc-enterprise/provider-translation`, R005.B) is *already* the
provider-neutral, validated extension point this contract was designed to
carry translation-specific detail through; using it here required no
change to any frozen contract's shape. A translation missing
`pinataFileId` for those two intents throws `PinataAdapterInputError` — a
programming-contract violation, exactly like a missing
`requestedDurationSeconds` already was.

**Explicit typing** (`src/enterprise/access-governance/contracts.ts`):
`AccessGrantRecord` carries `providerCid` and `providerFileId` as two
separate, optional, distinctly-named fields — never one field reused for
both. `src/enterprise/access-governance/service.ts`'s
`requestProviderCredential` reads `grant.providerCid`;
`pinata-revocation-enforcement.ts`'s resource-wide branch reads
`grant.providerFileId`. Test H
(`src/enterprise/__tests__/access-grant-revocation.test.ts`) proves both
paths route to the correct, distinct identifier and never to each other.

---

## Architecture reused, not redesigned

- **Persistence**: `src/enterprise/access-governance/{in-memory,sqlite}-access-grant-store.ts`
  reuse the exact `better-sqlite3`, pragma, schema-versioning, and
  transaction-discipline conventions `src/enterprise/governance-store/` and
  `src/enterprise/passport/` already establish. Two tables
  (`access_grants` current-state projection, `access_grant_revocations`
  at-most-one-per-grant), not event-sourced — this module's lifecycle
  (`active -> revoked`) is simpler than Passport's six-state machine, so it
  does not adopt Passport's append-only event ledger.
- **Tenant isolation**: `requireAccessGrantAccessToOrganization`/
  `requireAccessGrantTenantScope` (`access-grant-store.ts`) mirror
  `requireAccessToOrganization`/`requirePassportTenantScope`
  (`../passport/passport-store.ts`) verbatim in shape and intent.
- **Authentication**: `orchestration.ts`'s `revokeGrantRequest` reuses
  `resolveGovernanceAccessContext` (`../orchestration/governance-read-service.ts`)
  — the exact function the Governance Store's own read surface already
  uses — rather than reimplementing bearer-token/API-key matching.
- **Canonical contracts**: `service.ts` composes, never redefines,
  `EnterpriseAccessGrant`/`EnterpriseGrantRevocation` — every
  issue/revoke input is validated through `validateEnterpriseAccessGrant`/
  `validateEnterpriseGrantRevocation` (`@aoc-enterprise/access-grant`,
  `@aoc-enterprise/grant-revocation`) before being durably persisted.
- **Soberanía Protocol** is not modified. **A2 Mediated Credential architecture**
  is preserved: this slice adds no encryption, KMS, `ProtectedAsset`,
  player, `ExecutionGrant` asset binding, fingerprinting, or watermarking —
  all explicitly out of scope, reserved for later slices.

## What is genuinely new, and why it is additive, not a redesign of frozen contracts

- `AccessGrantRecord`/`AccessGrantRevocationRecord`/`AccessGrantProviderEnforcementResult`
  (`src/enterprise/access-governance/contracts.ts`) are this module's own
  durable *row* shapes — they compose, never replace,
  `EnterpriseAccessGrant`/`EnterpriseGrantRevocation`.
- `packages/pinata-adapter/src/pinata-revocation-capability.ts` is a new,
  additive file — it does not modify `EnterpriseProviderCapabilityDeclaration`
  (`@aoc-enterprise/provider-adapter`, R005.A, frozen). The frozen
  declaration's single `SupportsGrantRevocation` capability cannot
  truthfully express "selective vs. TTL-bounded vs. resource-wide"; rather
  than widen that frozen shape (architectural drift
  `ADR-PINATA-PROVIDER-ADAPTER.md` already treats as something to report,
  not smuggle in), this slice adds a new, Pinata-owned, additive record a
  caller consults *alongside* the existing declaration, never in place of
  it.

---

## Security

- `revokeGrantRequest` (`orchestration.ts`) is the **only** entry point in
  this module that accepts a raw `authorizationHeader`; `AccessGrantService.revokeGrant`
  always requires an already-resolved `AccessGovernanceContext` and never
  touches a credential. No unauthenticated caller can reach a mutation.
- Tenant/trust-domain isolation is enforced at the store layer
  (`requireAccessGrantAccessToOrganization`), not only at the service
  layer — a cross-tenant caller never even learns whether a grant exists.
- Idempotent revoke: a second `revokeGrant` call against an already-revoked
  grant returns the original revocation, never re-attempts a provider
  action, never errors.
- Strict UTC timestamp validation (`isStrictUtcTimestamp`,
  `access-grant-store.ts`) — stricter than `../governance-store/`'s (none)
  or `../passport/`'s (none): only a `Z`-suffixed or all-zero-offset
  instant is accepted for `issuedAt`/`expiresAt`/`revokedAt`.
- No provider credential is ever exposed on any returned result —
  `PinataProviderClientConfig.jwt` never appears in a log, an
  `AccessGrantRecord`, or an `AccessGrantProviderEnforcementResult`.

---

## Tests

See `src/enterprise/__tests__/access-grant-store-contract.test.ts` and
`access-grant-revocation.test.ts` for Tests A–H, and
`access-grant-pinata-live.test.ts` for the live-provider gate (skipped,
with an explicit reason, when `PINATA_JWT`/`PINATA_TEST_CID` are not
configured in this environment — never faked).

---

## Deferred to a later slice

- Full `composition-root.ts`/HTTP-adapter/module-registry wiring (a new
  `AccessGrantStore` behind `AocEnterprise.accessGrants`, new
  `/api/access-grants/*` routes) — this slice delivers the durable store
  and the one authoritative `revokeGrant` orchestration path; wiring it
  into the running Enterprise Host's public HTTP surface is follow-up
  work, tracked separately from Slice 1's own scope.
  `src/enterprise/access-governance/` is fully usable in-process today
  (as its own test suite proves) without that wiring.
  `packages/access-grant`/`grant-revocation`/`provider-adapter`/
  `provider-translation`/`pinata-adapter` are correspondingly not yet
  declared as `dependencies` of the published `@aoc-enterprise/runtime`
  package (`scripts/validate-publishability.mjs`) — each carries its own
  further `file:`-dependency chain that bundling would need to resolve
  too, deferred alongside the HTTP wiring itself.
- Encryption, KMS, `ProtectedAsset`, player, `ExecutionGrant` asset
  binding, fingerprinting, watermarking — explicitly out of scope per the
  Slice 1 task description.
- A future provider adapter that can genuinely declare
  `effectiveRevocationMode: 'immediate_selective'` — this slice's
  vocabulary already supports it; no adapter claims it yet.
