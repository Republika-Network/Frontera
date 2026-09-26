# ADR: Provider-Neutral Resource Envelope (R004.D)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.C (ResourceRef canonicality conclusion), `ADR-EVIDENCE-BUNDLE.md`,
  `docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md`,
  `packages/scoped-access/src/enterprise-scoped-access-request.ts` (the
  existing Enterprise-wraps-Protocol composition pattern this contract
  follows)

## Context

Soberanía Protocol's `ResourceRef` (`@aoc/protocol`, `contracts` subpath) is the
sole canonical identity primitive for "a resource" across Soberanía:
`{ kind, id, tenantId?, attributes? }`. It is already referenced by
`CapabilityToken.resource`, `ScopedAccessRequest.resource`, and
`AuditEventEnvelope.subject`.

Access Governance needs a canonical way to describe a resource that is
*stored externally* — in S3, Pinata/IPFS, Azure Blob, Google Drive,
SharePoint, Arweave, or any future provider — well enough to reason about
governance later (which resource is this, does it still exist, what does its
content look like), without Frontera Systems ever holding a credential for
that provider or executing any provider-specific code. No such contract
exists today; `ResourceRef` alone does not carry location or integrity, and
the closest existing Enterprise concept, `SourceDocument`
(`src/features/evidence-source-runtime/domain/source-document.ts`), is a
different bounded context (see "Why `SourceDocument` was rejected" below).

R004.C's conclusion, treated as authoritative for this sequence:

- `ResourceRef` is already the canonical identity primitive.
- It must not be duplicated.
- `SourceDocument` must not be reused.
- The new model must wrap `ResourceRef` rather than replacing or extending
  it.

## Decision

Create `EnterpriseResourceEnvelope` in a new package,
`@aoc-enterprise/resource-envelope` (`packages/resource-envelope`):

- **Composes `ResourceRef` by reference**, not extension: `resource:
  ResourceRef` is a property, not a supertype. See the package README's "Why
  composition, not extension" section for the full comparison against
  `EnterpriseScopedAccessRequest` (which *does* extend `ScopedAccessRequest`,
  correctly, because `action` is additive to the same request shape — the
  resource envelope's added fields are not additive to `ResourceRef`, they
  describe something else about the resource).
- **Never duplicates identity.** `kind`, `id`, `tenantId`, `attributes` exist
  only on `envelope.resource`. Enforced at compile time via TypeScript
  excess-property checking in the negative test suite.
- **Adds exactly five semantic groups**, each justified from an existing
  repository pattern (full evidence table in the package README):
  `location` (mirrors `SourceDocument.sourceUri`/`sourceSystem`, generalized
  provider-neutral), `integrity` (mirrors the `sha256` digest convention used
  throughout `src/features/*/domain/*-proof.ts`), `descriptor`
  (provider-neutral content metadata, distinct from `ResourceRef.attributes`),
  `lifecycleState` (mirrors the enum-status pattern used elsewhere, scoped
  strictly to the resource's own storage existence), and `correlationId`
  (mirrors `AuditEventEnvelope.correlationId`).
- **Is purely descriptive and non-executable.** No persistence, no service,
  no API, no repository, no UI, no adapter logic, no provider SDK type, no
  credential, no runtime client.
- **Validates only internal consistency**: required fields and paired-field
  combinations (e.g. `location.systemReference` requires `location.system`;
  `integrity.algorithm` and `integrity.value` are required together). Never
  provider validation, credential validation, network/reachability checks,
  existence checks, authorization, or permission evaluation.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted attribute/tag sets, undefined fields omitted rather than
  written as `null`) and **identity equality that derives from `ResourceRef`
  alone**, never a second identity algorithm.

## Why `ResourceRef` remains canonical

Nothing in this change alters `@aoc/protocol` or `ResourceRef`. Enterprise
continues to consume Protocol exclusively through the published package
boundary (`docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md`); this package
imports `ResourceRef` (and `CanonicalId`, `UtcDateTime`) as types from
`@aoc/protocol` and does not redefine, shadow, or fork any of them.
`scripts/check-protocol-consumption.mjs` continues to enforce this for every
file in this package the same way it already does for
`packages/scoped-access`.

## Why composition was selected

See the package README's "Why composition, not extension" section for the
full rationale. In short: an `EnterpriseResourceEnvelope` is not "a
`ResourceRef` with more properties" the way an `EnterpriseScopedAccessRequest`
is "a `ScopedAccessRequest` with one more property" — it is a description
*about* a resource, and keeping that boundary as a nested property rather
than an inherited one keeps "no duplicate identity fields" mechanically
checkable rather than a matter of doc-comment discipline.

## Why `SourceDocument` was rejected

`SourceDocument` has its own `id: string` identity with no relationship to
`ResourceRef`, and its field set (`legalCompleteness`, `authority`,
`reviewedByActorId`, `jurisdiction`, `demoOnly`) encodes legal/business
judgment specific to the evidence/assurance domain. Reusing it here would
both violate "wrap `ResourceRef`, don't replace it" (it isn't built on
`ResourceRef` at all) and pull unrelated legal semantics into a contract
meant to be pure storage description. Full comparison table in the package
README.

## New contract responsibilities

- Describe where a governed external resource's bytes live
  (`location`), provider-neutrally.
- Describe the resource's content integrity at registration time
  (`integrity`), when known.
- Describe the resource's content for display/classification purposes
  (`descriptor`).
- Track whether the underlying stored object still exists
  (`lifecycleState`).
- Carry an audit correlation identifier (`correlationId`) and a schema
  version (`schemaVersion`) for this contract's own evolution.
- Validate its own internal consistency and (de)serialize deterministically.

## Explicit non-responsibilities

Enforced at compile time (see `__tests__/enterprise-resource-envelope.test.ts`):

- provider credentials, API keys, bearer tokens, access keys
- temporary/signed grants, download URLs with embedded credentials
- authorization headers, runtime clients, provider SDK instances or types
- business policy, approval state, revocation state (these belong to a
  future `AccessGrant`)
- provider/network/existence validation and permission evaluation (excluded
  from `validateEnterpriseResourceEnvelope` by design, not by omission)

## Future integration path

```text
┌───────────────────────────┐
│   @aoc/protocol            │
│   ResourceRef               │  canonical identity
└─────────────┬──────────────┘
              │ composed by reference
              ▼
┌───────────────────────────────────────────────────────────┐
│   @aoc-enterprise/resource-envelope                        │
│   EnterpriseResourceEnvelope                                 │
│     resource: ResourceRef | location | integrity? |         │
│     descriptor? | lifecycleState | registeredAt |           │
│     correlationId?                                           │
└──────────────┬──────────────────────────────┬───────────────┘
               │ future                        │ future
               ▼                                ▼
   Provider adapters                  AccessGrant (future)
   (Pinata, S3, Azure Blob,           - approval/revocation state
    Google Drive, SharePoint,         - grantee/scope
    IPFS, Arweave, ...)               references envelope.resource
   populate location/integrity
   via their own SDKs — never
   referenced by this contract
                                       UsageEvent (future)
                                       - references envelope.resource
                                         and correlationId
```

A Pinata adapter would eventually produce
`{ uri: 'ipfs://...', system: 'pinata', systemReference: '<CID>' }`; an S3
adapter `{ uri: 's3://bucket/key', system: 's3', systemReference:
'bucket/key' }`; an Azure Blob adapter
`{ uri: 'https://account.blob.core.windows.net/container/blob', system:
'azure-blob' }`; and so on for Google Drive, SharePoint, IPFS, and Arweave —
each fits `location`'s free-text `system` field without any change to this
contract, because `system` is deliberately a plain string rather than a
closed enum. **No adapter is implemented as part of this change.**

## Tests

`packages/resource-envelope/__tests__/enterprise-resource-envelope.test.ts`:

- Positive: construction (full and minimal), composition-over-`ResourceRef`
  (no duplicated identity fields, identity read only through
  `envelope.resource`), identity and structural equality, validation
  (accepting valid shapes, including order-insensitivity of attributes/tags),
  serialization determinism, and round-trip (de)serialization.
- Negative: compile-time `@ts-expect-error` proofs (matching the convention
  already established for Protocol's own contracts in
  `EnterpriseScopedAccessRequest`) that the contract cannot carry API keys,
  bearer tokens, credentials, access keys, authorization headers, signed
  URLs, temporary grants, runtime clients, provider SDK instances, business
  policy, approval state, revocation state, or a duplicated `kind`/`id`; plus
  that fields are immutable (`readonly`, no reassignment).

## Compatibility

- No change to `@aoc/protocol`, `ResourceRef`, or any existing Enterprise
  package's shipped API.
- New workspace package (`packages/resource-envelope`), added to the root
  `tsconfig.json` project references so `npm run build`/`typecheck` cover it,
  the same way `packages/scoped-access` and `packages/identity` are.
- Not wired into `src/index.ts` or any public runtime export — it has no
  runtime consumer yet by design (see "Blast Radius" below), so it does not
  need to be added to `scripts/validate-publishability.mjs`'s bundled
  workspace packages list (that list exists only for packages whose types
  appear in the shipped public API's `.d.ts` output, which this package's
  types do not, today).

## Blast radius

Existing code that *could* eventually adopt `EnterpriseResourceEnvelope` once
a provider adapter exists — listed for future sequences, **not migrated by
this change**:

- `src/features/evidence-source-runtime/domain/source-document.ts` /
  `evidence-artifact.ts` — currently model "where evidence comes from" with
  ad hoc `sourceUri`/`sourceSystem`/`sourceReference`/`contentHash` fields
  that this contract's `location`/`integrity` groups could eventually
  represent, without touching `SourceDocument`'s legal/business fields.
- `src/features/verifiable-export-package/*` — builds, hashes, and verifies
  export packages; a future export package section referencing an externally
  stored artifact could describe it with this envelope instead of an ad hoc
  shape.
- `packages/control-plane` / `packages/control-plane-sdk` — audit/control
  events that reference an external resource today do so via
  `ResourceRef`/`subject` directly; could eventually carry a full envelope
  when richer resource description is needed.
- `src/features/aoc-integrations/*` (`pmfreak-governance-request-intake`,
  `pmfreak-remote-governance-endpoint`) — integration surfaces that already
  move resource references across a boundary and could standardize on this
  envelope for anything backed by external storage.
- Any future provider adapter package (not yet created) — the natural
  producer of `location`/`integrity` values for a given `resource`.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/resource-envelope` via
  the new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/resource-envelope`
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.D)

- No provider adapter (Pinata, S3, Azure Blob, Google Drive, SharePoint,
  IPFS, Arweave) is implemented.
- No `AccessGrant` or `UsageEvent` contract is implemented.
- No persistence, API, service, repository, or UI is added.
- No existing consumer is migrated to this contract.
