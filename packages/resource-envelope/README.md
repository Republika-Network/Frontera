# @aoc-enterprise/resource-envelope

The canonical Enterprise-owned contract for **a governed external resource**:
`EnterpriseResourceEnvelope`. It composes Soberanía Protocol's `ResourceRef` — it
never duplicates, extends, or reimplements it — and adds only the
provider-neutral location, integrity, descriptive, lifecycle and
audit-correlation semantics that Access Governance needs and Protocol does
not own.

This package is a pure data contract: no persistence, no service, no API, no
provider SDK, no runtime execution.

## Purpose

Access Governance eventually needs to reason about resources that live
outside Soberanía (a contract PDF in S3, a dataset pinned to IPFS via Pinata, a
document in SharePoint) without Soberanía ever holding credentials for those
systems or executing provider-specific code. `EnterpriseResourceEnvelope` is
the description of such a resource that a governance decision can be made
*about* — never the mechanism that reaches it.

## Ownership

- **Identity** (`kind`, `id`, `tenantId`, `attributes`) is owned by Soberanía
  Protocol's `ResourceRef` (`@aoc/protocol`). This package never duplicates
  those fields; every function here that needs identity reads
  `envelope.resource`.
- **Everything else on `EnterpriseResourceEnvelope`** — `location`,
  `integrity`, `descriptor`, `lifecycleState`, `registeredAt`,
  `correlationId` — is owned by Frontera Systems
  (`@aoc-enterprise/resource-envelope`), because it is governance metadata
  about a resource, not part of what makes the resource *that* resource.
  Protocol has no concept of "where a resource's bytes live" or "has this
  envelope been registered yet" — those are Enterprise concerns.

## Why composition, not extension

`@aoc-enterprise/scoped-access`'s `EnterpriseScopedAccessRequest` extends
Protocol's `ScopedAccessRequest` (`interface EnterpriseScopedAccessRequest
extends ScopedAccessRequest`), because `action` is a genuinely additive field
on the *same* request — the request doesn't change shape, it just gains one
more property alongside `principalId`/`resource`/`requestedScope`.

`EnterpriseResourceEnvelope` does not extend `ResourceRef` the same way.
Instead:

```ts
interface EnterpriseResourceEnvelope {
  readonly resource: ResourceRef;
  // ... location, integrity, descriptor, lifecycleState, ...
}
```

Reasons:

1. **The envelope is not "a resource with extra properties" — it is a
   description *about* a resource.** `ResourceRef` answers "which resource is
   this?"; the envelope answers "where does it live, is it still there, what
   does it look like?" Those are different questions with different owners,
   and a `resource: ResourceRef` property keeps that boundary visible at
   every call site, not just in a doc comment.
2. **It composes cleanly with any future shape Protocol gives `ResourceRef`.**
   If Protocol ever adds a field to `ResourceRef`, this contract inherits it
   automatically through the `resource` property — exactly the same benefit
   `EnterpriseScopedAccessRequest` gets from `extends`, without also merging
   Enterprise's governance fields into Protocol's identity namespace.
3. **It makes "no duplicate identity fields" mechanically checkable.**
   Because `kind`/`id`/`tenantId`/`attributes` only exist nested under
   `resource`, TypeScript's excess-property checking on object literals
   catches an accidental top-level `kind`/`id` at compile time (see the
   negative tests) — extension would make that harder to keep sight of degree
   by degree as this contract grows.

## Why `SourceDocument` was rejected

`src/features/evidence-source-runtime/domain/source-document.ts` already
defines a Enterprise concept ("where evidence comes from") that superficially
resembles "a governed external resource," but it is a different bounded
context entirely:

| | `SourceDocument` | `EnterpriseResourceEnvelope` |
| --- | --- | --- |
| Identity | Its own `id: string` — no relationship to `ResourceRef` at all | Composes Protocol's `ResourceRef` |
| Purpose | Evidentiary provenance for a legal/business record (a contract, a policy, an approval memo) | A provider-neutral description of *any* externally stored resource, regardless of business meaning |
| Carries | `legalCompleteness`, `authority`, `reviewedByActorId`, `jurisdiction`, `demoOnly` — legal/business judgment fields | Only location, integrity, descriptor, lifecycle — no legal or business judgment of any kind |
| Owner | The evidence/assurance domain (`evidence-source-runtime`) | Access Governance (this package) |

Reusing `SourceDocument` here would conflate two identity models (its own
`id` vs. Protocol's `ResourceRef`) and pull unrelated legal/business
semantics (`legalCompleteness`, `authority`, `jurisdiction`) into a contract
that is supposed to be purely descriptive of storage location and integrity.
R004.C's conclusion — "`SourceDocument` must not be reused" — is why this
package defines its own contract instead of extending or wrapping it.

## Semantic groups and their evidence

Each additional field group was justified from an existing repository
pattern, not invented from scratch:

| Group | Field(s) | Evidence |
| --- | --- | --- |
| Resource location | `location: { uri, system?, systemReference? }` | Mirrors `SourceDocument.sourceUri` / `sourceSystem` / `sourceReference` — the existing repo pattern for "where something external lives," generalized to be provider-neutral (a free-text `system` label, never an enum, so no per-provider branching is ever required here). |
| Resource integrity | `integrity?: { algorithm: 'sha256', value, sizeBytes? }` | Mirrors `SourceDocument.contentHash` and the `sha256` digest convention used throughout `src/features/*/domain/*-proof.ts`. |
| Provider-neutral metadata | `descriptor?: { displayName?, contentType?, tags? }` | Descriptive-only fields distinct from `ResourceRef.attributes` (which Protocol may use for policy/authorization matching) — purely about what the content *is*, never how to reach or authorize against it. |
| Resource lifecycle | `lifecycleState: 'registered' \| 'active' \| 'archived' \| 'deleted'` | Mirrors the enum-status pattern used by `SourceDocumentStatus`, `assurance_assessments`, and the Governance/Passport stores' version ledgers — but scoped strictly to "does the underlying object exist," never to approval or revocation (see below). |
| Audit correlation | `correlationId?: CanonicalId` | Directly mirrors `AuditEventEnvelope.correlationId` in `@aoc/protocol`, using the same `CanonicalId` type. |
| Version | `schemaVersion: '1.0.0'` | Mirrors the `schemaVersion: '1.0.0'` literal already used on Protocol's own `CapabilityToken`/`ConsentGrant`. |

No new value objects were introduced where an existing one would fit —
`packages/canonical-runtime-contracts` and `packages/audit-sdk` were checked
first and contain no reusable resource-location, integrity, or lifecycle
type; `SourceDocument`'s fields inspired the shape of `location`/`integrity`
but were not imported or reused directly, for the reasons above.

## Explicit non-responsibilities

`EnterpriseResourceEnvelope` never carries, and by design cannot carry
(enforced at compile time — see `__tests__/enterprise-resource-envelope.test.ts`):

- provider credentials, API keys, bearer tokens, access keys
- temporary/signed grants or download URLs with embedded credentials
- authorization headers
- runtime clients or provider SDK instances/types
- business policy
- approval state
- revocation state

`lifecycleState` looks adjacent to "revocation state" but is not: it records
whether the *underlying stored object* still exists (`registered` → `active`
→ `archived`/`deleted`), never whether *access to it* has been approved,
granted, or revoked. That is a future `AccessGrant` concern.

## Relationship diagram

```text
┌───────────────────────────┐
│   @aoc/protocol            │
│                            │
│   ResourceRef              │  <- canonical identity: kind, id, tenantId, attributes
│   (kind, id, tenantId,     │
│    attributes)             │
└─────────────┬──────────────┘
              │ composed by reference (resource: ResourceRef)
              ▼
┌───────────────────────────────────────────────────────────┐
│   @aoc-enterprise/resource-envelope                        │
│                                                              │
│   EnterpriseResourceEnvelope                                │
│     resource: ResourceRef        (identity — never duplicated) │
│     location                     (where the bytes live)     │
│     integrity?                   (content digest)           │
│     descriptor?                  (display name, content type, tags) │
│     lifecycleState               (registered/active/archived/deleted) │
│     registeredAt                                             │
│     correlationId?               (audit correlation)        │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               │ future, not implemented here │ future, not implemented here
               ▼                              ▼
   ┌─────────────────────────┐   ┌──────────────────────────────┐
   │ Provider adapters        │   │ AccessGrant (future)          │
   │ (Pinata, S3, Azure Blob, │   │ - approval state               │
   │  Google Drive,           │   │ - revocation state             │
   │  SharePoint, IPFS,       │   │ - grantee/scope                │
   │  Arweave, ...)           │   │ references an envelope's       │
   │ populate/refresh         │   │ `resource` for identity        │
   │ location/integrity via   │   └──────────────────────────────┘
   │ their own SDKs — never   │
   │ referenced by this       │   ┌──────────────────────────────┐
   │ contract                 │   │ UsageEvent (future)           │
   └─────────────────────────┘   │ - references an envelope's     │
                                  │   `resource` and `correlationId` │
                                  │   for audit trail linkage       │
                                  └──────────────────────────────┘
```

## Relationship to future adapters

A provider adapter (Pinata, S3, Azure Blob, Google Drive, SharePoint, IPFS,
Arweave, ...) is what would eventually *populate* or *refresh* a
`location`/`integrity` pair by calling that provider's own SDK — but no such
adapter exists in this package, and none is implied by its shape.
`location.system` is a free-text string specifically so a new provider never
requires a change here: a Pinata adapter would produce
`{ uri: 'ipfs://...', system: 'pinata', systemReference: '<CID>' }`, an S3
adapter `{ uri: 's3://bucket/key', system: 's3', systemReference: 'bucket/key' }`,
an Azure Blob adapter `{ uri: 'https://account.blob.core.windows.net/container/blob', system: 'azure-blob' }`
— all without adding a branch, a field, or a type to this contract.

## Relationship to future `AccessGrant`

A future `AccessGrant` contract is where approval state, revocation state,
grantee, and scope will live. It will reference an
`EnterpriseResourceEnvelope`'s `resource: ResourceRef` for identity (the same
way `CapabilityToken.resource` and `ScopedAccessRequest.resource` already
do in `@aoc/protocol`) — this package does not implement or assume that
contract's shape.

## Relationship to future `UsageEvent`

A future `UsageEvent` contract would record that a resource was accessed,
correlating back to this envelope's `resource` and `correlationId` the same
way `AuditEventEnvelope.subject`/`correlationId` already correlate audit
events to resources and requests today. Not implemented here.

## API

- `EnterpriseResourceEnvelope`, `EnterpriseResourceLocation`,
  `EnterpriseResourceIntegrity`, `EnterpriseResourceDescriptor`,
  `EnterpriseResourceLifecycleState` — the contract and its value objects.
- `resourceRefIdentityEquals(a, b)` / `enterpriseResourceEnvelopeIdentityEquals(a, b)`
  — identity equality, always derived from `ResourceRef`.
- `enterpriseResourceEnvelopeEquals(a, b)` — full structural equality.
- `validateEnterpriseResourceEnvelope(candidate)` — internal-consistency
  validation only (see "Explicit non-responsibilities").
- `serializeEnterpriseResourceEnvelope(envelope)` /
  `deserializeEnterpriseResourceEnvelope(candidate)` — deterministic,
  round-trip-safe (de)serialization; see the "Serialization" doc comment in
  `src/enterprise-resource-envelope.ts` for the full assumptions list.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/resource-envelope
npm test --workspace @aoc-enterprise/resource-envelope
```
