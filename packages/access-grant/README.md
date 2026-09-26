# @aoc-enterprise/access-grant

The canonical Enterprise-owned contract for **the immutable record of an
issued authorization**: `EnterpriseAccessGrant`. It references
`EnterpriseAccessDecision` (`@aoc-enterprise/access-decision`) and
`EnterpriseAccessObligation` (`@aoc-enterprise/access-obligation`) by opaque
correlation ids -- it never embeds, duplicates, or extends either -- and
composes Soberanía Protocol's `ResourceRef` directly, the same identity primitive
`EnterpriseResourceEnvelope` composes.

This package is a pure data contract: no persistence, no service, no API, no
provider SDK, no provider credential, no JWT, no OAuth token, no signed URL,
no runtime session, no execution engine, no enforcement, no approval
workflow, no adapter.

## Purpose

`EnterpriseAccessDecision` answers *"should access be granted?"*
(`outcome: 'allow' | 'deny' | 'conditional'`). `EnterpriseAccessObligation`
answers *"under what mandatory conditions?"*. Neither is an authorization a
principal actually holds: a decision is an evaluation record that can be
produced (and reproduced) any number of times without ever being issued to
anyone. Something needs to record, once, immutably, that authorization
actually *was* issued -- to whom, for which resource, until when, and under
which decision and obligations -- without that record becoming the mechanism
that carries the authorization out. `EnterpriseAccessGrant` is that record.
It answers a third, distinct question: *"what authorization was issued?"*

## What this contract is not

- It is not a provider token.
- It is not a JWT.
- It is not a download URL.
- It is not an API credential.
- It is not a runtime session.
- It does not evaluate policy, execute access, contact a provider, enforce
  an obligation, or run an approval workflow.

It is the canonical authorization artifact a future Provider Adapter will
translate into provider-specific execution -- never that execution itself.

## Ownership

- **The decision that authorized issuing this grant** is referenced, not
  owned, via `decisionRef: CanonicalId` -- an opaque pointer to an
  `EnterpriseAccessDecision.correlationId` (`@aoc-enterprise/access-decision`).
  This package never duplicates any `EnterpriseAccessDecision` field
  (`request`, `resource` envelope, `outcome`, `evaluatedAt`, ...).
- **The obligations resolved before issuance** are referenced, not owned,
  via `obligationRefs?: readonly CanonicalId[]` -- opaque pointers to
  `EnterpriseAccessObligation.id` values (`@aoc-enterprise/access-obligation`).
  This package never duplicates any `EnterpriseAccessObligation` field
  (`type`, `mandatory`, `severity`, `parameters`, ...).
- **Resource identity** (`kind`, `id`, `tenantId`, `attributes`) is owned by
  Soberanía Protocol's `ResourceRef` (`@aoc/protocol`), composed directly as
  `resource: ResourceRef` -- not the full `EnterpriseResourceEnvelope`. This
  package never duplicates those fields.
- **Everything else on `EnterpriseAccessGrant`** -- `id`, `status`,
  `principalId`, `issuedAt`, `expiresAt`, `correlationId`, `issuerRef?`,
  `auditRefs?` -- is owned by Frontera Systems (`@aoc-enterprise/access-grant`),
  because it is metadata about the issuance event itself.

## Why composition by reference, not embedding

Following the precedent `EnterpriseAccessObligation` set for `decisionRef`
(an opaque pointer to a record owned elsewhere, never an embedded shape):

```ts
interface EnterpriseAccessGrant {
  readonly decisionRef: CanonicalId; // points at EnterpriseAccessDecision.correlationId
  readonly obligationRefs?: readonly CanonicalId[]; // point at EnterpriseAccessObligation.id values
  // ... id, status, resource, principalId, issuedAt, expiresAt, correlationId, ...
}
```

A grant is not "a decision with a credential bolted on," and it is not "an
obligation list with a verdict." A decision, its obligations, and the grant
they authorize have different cardinalities (one decision can be evaluated
without ever producing a grant; zero or more obligations can attach to that
decision; at most one grant is issued from a given evaluation) and different
lifecycles (a decision is a record of a moment; a grant has its own
issuance/revocation history, described by `status` below). Embedding either
would duplicate identity and evaluation state this contract has no need to
own, exactly the way `EnterpriseAccessObligation.decisionRef` avoids
embedding the decision it accompanies.

## Why `resource: ResourceRef`, not a full `EnterpriseResourceEnvelope`

`EnterpriseResourceEnvelope`'s own README already commits to this shape for
a future `AccessGrant`: *"It will reference an `EnterpriseResourceEnvelope`'s
`resource: ResourceRef` for identity"* -- not the envelope itself. A grant
needs to know **which** resource access was issued for; it has no need to
know **where** that resource's bytes live (`location`), whether they are
still there (`lifecycleState`), or their content digest (`integrity`) --
those are `EnterpriseResourceEnvelope`'s job alone, and a storage-lifecycle
change (a resource moving from `active` to `archived`) has no bearing on
whether a previously issued grant is still the operative authorization
record. Composing the bare identity primitive keeps `EnterpriseAccessGrant`
decoupled from the resource's storage lifecycle the same way
`EnterpriseResourceEnvelope` itself is decoupled from the decision/grant
lifecycle above it.

## Why `principalId` is carried directly, not re-derived through `decisionRef`

`EnterpriseAccessDecision.request.principalId` already records who asked.
`EnterpriseAccessGrant.principalId` is not a redundant copy of that field in
the sense that matters for "no duplicated identity": this contract composes
the decision **by reference**, not by embedding, so there is no
`grant.decision.request.principalId` path to read the principal from without
dereferencing an external record this contract does not have access to. A
grant must be reasoned about -- checked, displayed, audited -- on its own,
the same way `EnterpriseAccessObligation` does not require dereferencing its
`decisionRef` to know its own `type` or `mandatory` value. Unlike
`EnterpriseAccessDecision`'s `request.resource` / `resource.resource`
pairing (both present *in the same object*, so a cross-field consistency
check is possible and required), `EnterpriseAccessGrant` has no embedded
decision to check `principalId` against -- so no `PRINCIPAL_MISMATCH`-style
check exists here; that would require this contract to perform an existence
check against an external record, which it does not do by design (see
"Explicit non-responsibilities").

## Grant status semantics

`status: EnterpriseAccessGrantStatus` is deliberately a **two-state**
vocabulary: `'active' | 'revoked'`. No canonical lifecycle or status enum
already existed in the repository for this concept (`EnterpriseResourceLifecycleState`,
`PolicyDecision`, and `EnterprisePolicyDecision` were each evaluated and are
scoped to a different concern -- see `docs/architecture/ADR-ACCESS-GRANT.md`
for the full comparison), so this package defines the minimum lifecycle
model repository evidence and this sequence's own requirements justify:

- **`'active'`** -- as far as this record's own issuance history is
  concerned, this is the operative grant.
- **`'revoked'`** -- a later, separate event withdrew it. This sequence's
  own blast-radius requirements name a future `GrantRevocation` contract
  that will reference this grant's `id` the same way this contract
  references a decision's `correlationId` -- `EnterpriseAccessGrant` does
  not implement or assume `GrantRevocation`'s shape, but its `status`
  vocabulary must be able to represent what a `GrantRevocation` event
  causes.

This mirrors the precedent `EnterpriseResourceEnvelope.lifecycleState`
already establishes: each `EnterpriseAccessGrant` *value* is an immutable
snapshot (every field `readonly`, no mutation API), but the `status` field
can differ between snapshots of the same `id` taken at different times --
producing the next snapshot is a future persistence/enforcement layer's job,
not this contract's.

### Why `'expired'` is not a status value

Expiration is represented exclusively by `issuedAt` / `expiresAt` (see
"Expiration semantics" below). Adding a status-derived `'expired'` value
would create a second, independently-settable source of truth for the same
fact, with no mechanical way for `validateEnterpriseAccessGrant` -- a pure
function with no "current time" input -- to keep the two consistent (unlike,
say, `location.systemReference` requiring `location.system` in
`EnterpriseResourceEnvelope`, which is a check between two fields *within
the same object* and needs no clock). Determining whether an `'active'`
grant has lapsed past `expiresAt` is a comparison against the current time;
this immutable, non-executing contract does not perform that comparison --
see "Explicit non-responsibilities."

### Why no third status (`'suspended'`, `'pending'`, ...)

Nothing in this repository's evidence justifies a third state, and Phase 4
of this sequence requires avoiding unnecessary states. `'pending'` would
imply an approval-workflow-in-progress concept this contract explicitly
excludes (a grant, by construction, only exists once issuance has already
happened); `'suspended'` is not distinguishable from `'revoked'` by any
evidence in this repository and would be an invented state.

## Expiration semantics

`issuedAt: UtcDateTime` and `expiresAt: UtcDateTime` are both required.
`validateEnterpriseAccessGrant` checks that both are well-formed ISO 8601
timestamps and that `expiresAt` is strictly after `issuedAt`
(`INVALID_EXPIRATION_ORDER`) -- a pure comparison between two values already
present on the same candidate, not a comparison against the current time.
No timer, scheduled job, or expiration-execution logic is implemented here,
and none is implied by this contract's shape: determining that a grant has
actually lapsed, and acting on that fact (e.g. refusing further use, or a
provider adapter declining to translate an expired grant into access), is a
future enforcement layer's responsibility.

No renewal metadata is included. Phase 5 of this sequence permits renewal
metadata only "if justified by repository evidence" -- a full-repository
search (see `docs/architecture/ADR-ACCESS-GRANT.md`, "Context") found no
existing renewal concept to generalize from, the same reasoning
`EnterpriseAccessObligation`'s README already applies to `severity` (only
included because evidence supported it). A future renewal mechanism would
most naturally be a new `EnterpriseAccessGrant` referencing the prior one by
id, not a mutable field on this contract.

## Explicit non-responsibilities

`EnterpriseAccessGrant` never carries, and by design cannot carry (enforced
at compile time via `@ts-expect-error` -- see
`__tests__/enterprise-access-grant.test.ts`):

- a JWT, an OAuth access/refresh token
- a download URL, a signed URL, an Azure SAS token
- an API key, a provider credential
- a Pinata SDK, S3 client, Azure Blob client, or any other provider SDK
  instance
- a runtime session id, a cookie
- an execution/run callback -- this contract never executes anything
- approval workflow runtime state
- a policy engine or rule set
- a duplicated decision outcome (`outcome` lives only on
  `EnterpriseAccessDecision.outcome`)
- a scheduled expiration timer or job

It records the immutable fact that authorization was issued; it does not
carry out, enforce, or translate that authorization into anything a
provider, session, or workflow engine would recognize.

## Relationship diagram

```text
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌──────────────────────┐
│ @aoc-enterprise/access-decision │  │ @aoc-enterprise/access-obligation │  │ @aoc/protocol           │
│                                    │  │                                    │  │                          │
│ EnterpriseAccessDecision           │  │ EnterpriseAccessObligation          │  │ ResourceRef              │
│   correlationId | outcome | ...    │  │   id | type | mandatory | ...       │  │   kind, id, tenantId, ...  │
└──────────────────┬────────────────┘  └──────────────────┬────────────────┘  └──────────────┬────────────┘
                    │ referenced by correlationId          │ referenced by id                  │ composed by
                    │ (never embedded)                     │ (never embedded)                  │ reference
                    ▼                                       ▼                                    ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/access-grant                                                                                  │
│                                                                                                                 │
│ EnterpriseAccessGrant                                                                                          │
│   id | status | resource: ResourceRef | decisionRef | principalId | issuedAt | expiresAt | correlationId |    │
│   issuerRef? | obligationRefs? | auditRefs?                                                                    │
└──────────────┬───────────────────────┬───────────────────────┬───────────────────────┬────────────────────┘
               │ future, not            │ future, not            │ future, not             │ future, not
               │ implemented here       │ implemented here       │ implemented here        │ implemented here
               ▼                        ▼                        ▼                         ▼
   ┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐ ┌──────────────────────────┐
   │ GrantRevocation          │ │ UsageEvent               │ │ EvidenceCorrelation       │ │ Provider Adapter            │
   │ - references grant.id     │ │ - references grant.id      │ │ - references grant.id and │ │ (Pinata, S3, Azure Blob,     │
   │ - future snapshots of        │ │   and correlationId        │ │   auditRefs/correlationId  │ │  Google Drive, SharePoint)   │
   │   this grant's id would       │ │ - records that access        │ │ - correlates issuance with │ │ - translates an 'active'      │
   │   move status to 'revoked'      │ │   actually occurred under      │ │   evidence bundles         │ │   grant into provider-specific │
   └───────────────────────┘ └───────────────────────┘ └───────────────────────┘ │   execution (a presigned URL, │
                                                                                    │   a scoped SDK call, ...)     │
                                                                                    └──────────────────────────┘
```

## Relationship to `EnterpriseAccessDecision`

`EnterpriseAccessDecision` answers *"should access be granted?"*.
`EnterpriseAccessGrant` answers *"what authorization was issued?"*. The
decision can exist, and be evaluated, without ever producing a grant (a
`'deny'` outcome, or a `'conditional'` outcome whose mandatory obligations
were never satisfied, produces no grant at all -- this contract has no way
to represent "a grant that wasn't issued," because it only exists once
issuance already happened). `decisionRef` is how a grant records which
evaluation authorized it, without embedding that evaluation's own request,
resource envelope, or outcome.

## Relationship to `EnterpriseAccessObligation`

A decision's mandatory obligations (`EnterpriseAccessObligation.mandatory ===
true`) are resolved by something else -- a future approval engine or
enforcement layer, not this contract -- before a grant can be issued.
`obligationRefs?` records which obligations were considered part of that
resolution, by reference, so an auditor can later answer "which conditions
did this grant depend on?" without this contract needing to know how any
obligation was satisfied.

## Relationship to future `GrantRevocation`

A future `GrantRevocation` contract will be the immutable record that a
previously issued grant's authority was withdrawn -- referencing this
grant's `id`, the same reference-not-embed pattern this contract already
uses for `decisionRef`/`obligationRefs`. It is not implemented here.
`EnterpriseAccessGrant.status`'s `'revoked'` value is the state a
`GrantRevocation` event causes a future snapshot of this grant to hold; this
contract does not implement the transition itself.

## Relationship to future `UsageEvent`

A future `UsageEvent` contract will record that access actually occurred
under an issued grant, correlating back to this grant's `id` and
`correlationId` -- the same correlation pattern
`EnterpriseResourceEnvelope.correlationId` and
`EnterpriseAccessDecision.correlationId` already establish for their own
lifecycle events. Not implemented here.

## Relationship to future `EvidenceCorrelation`

A future evidence-correlation contract is the natural consumer of
`auditRefs?` -- linking a grant's issuance to the specific audit trail
entries it should be provable against. Not implemented here; today no such
correlation contract exists.

## Relationship to future Provider Adapters

No provider adapter is implemented or assumed by this contract. Because
`resource` is Protocol's bare `ResourceRef` and every reference field
(`decisionRef`, `obligationRefs`, `auditRefs`, `issuerRef`) is an opaque
`CanonicalId`, a future adapter can translate an `EnterpriseAccessGrant`
into provider-specific execution without this contract changing:

- A **Pinata adapter** would translate `{ status: 'active', resource: {
  kind: 'ipfs-object', id: '...' }, expiresAt: '...' }` into a scoped,
  time-limited IPFS gateway URL -- using its own SDK, never referenced by
  this contract.
- An **S3 adapter** would translate the same grant into a presigned S3 URL
  whose expiry matches `expiresAt`.
- An **Azure Blob adapter** would translate it into a SAS token whose
  expiry matches `expiresAt` -- this contract has no `sasToken` field for
  the adapter to populate; it produces one independently, downstream.
- A **Google Drive** or **SharePoint** adapter would translate it into a
  scoped share link or Graph API permission grant.

None of this is implemented here. This contract only records that
authorization was issued, to whom, for what, and until when.

## Equality semantics

- `enterpriseAccessGrantIdentityEquals(a, b)` -- identity equality, derived
  from grant identity (`id`), the issued decision (`decisionRef`), the
  principal (`principalId`), and the resource (via
  `resourceRefIdentityEquals`) -- Phase 8's required basis. Never derived
  from `status`, timestamps, or any other field, and never from runtime
  execution.
- `enterpriseAccessGrantEquals(a, b)` -- full structural equality: identity
  plus `status`, `issuedAt`, `expiresAt`, `correlationId`, `issuerRef`,
  `obligationRefs`, `auditRefs`, and `resource.attributes`.

## Validation

`validateEnterpriseAccessGrant(candidate)` checks required fields,
timestamp format, expiration order (`expiresAt` strictly after `issuedAt`),
and duplicate/invalid reference shapes (`obligationRefs`, `auditRefs`).
It never checks that `decisionRef`/`obligationRefs`/`auditRefs` point at
anything real, never contacts a provider, and never compares `expiresAt`
against the current time -- see "Explicit non-responsibilities."

## API

- `EnterpriseAccessGrant`, `EnterpriseAccessGrantStatus` -- the contract and
  its status vocabulary.
- `enterpriseAccessGrantIdentityEquals(a, b)` / `enterpriseAccessGrantEquals(a, b)`
  -- identity and full structural equality.
- `validateEnterpriseAccessGrant(candidate)` -- internal-consistency
  validation only (see "Explicit non-responsibilities").
- `serializeEnterpriseAccessGrant(grant)` / `deserializeEnterpriseAccessGrant(candidate)`
  -- deterministic, round-trip-safe (de)serialization.
- `EnterpriseAccessGrantValidationError` -- thrown by
  `deserializeEnterpriseAccessGrant` on invalid input.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/access-grant
npm test --workspace @aoc-enterprise/access-grant
```
