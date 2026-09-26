# ADR: Canonical Grant Revocation (R004.H)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.D (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  R004.E (`ADR-ACCESS-DECISION.md`, `EnterpriseAccessDecision`),
  R004.F (`ADR-POLICY-OBLIGATION.md`, `EnterpriseAccessObligation`),
  `src/features/authority-graph/domain/authority-grant.ts` (`AuthorityGrant`,
  evaluated and not reused), `src/features/authority-graph/domain/revocation-link.ts`
  (`RevocationLink`, evaluated and not reused)

## Context

R004.D-F established a composition line -- `EnterpriseResourceEnvelope`
(wraps Protocol's `ResourceRef`), `EnterpriseAccessDecision` (composes a
scoped access request with a resource envelope into an evaluated outcome),
and `EnterpriseAccessObligation` (attaches a mandatory or optional condition
to a decision) -- each referencing the layer beneath it, never embedding or
extending it. Every one of those three package READMEs mentions a future
"`AccessGrant`" as the next layer: something that would read decisions and
their obligations and, at some point, issue authorization. No such contract
exists in this repository yet.

Grants are not permanent. A grant expires, an administrator withdraws it, the
policy that permitted it changes, the principal it was issued to is
disabled, the resource it covered is removed, or it is revoked in response
to a security incident. Access Governance needs a canonical, immutable way
to record *that* a grant is no longer valid and *why* -- without becoming
the mechanism that makes it true anywhere else (a provider's own state, a
cached URL, a session, a token blacklist).

Two revocation- or grant-shaped types already exist in the repository:

- `AuthorityGrant` (`src/features/authority-graph/domain/authority-grant.ts`)
  -- models direct organizational authority/role delegation (e.g. "Datasys
  grants Victor Project Manager authority for project:HMP-14665"), with a
  `status: 'active' | 'expired' | 'suspended' | 'revoked'` field on the grant
  itself rather than a separate immutable revocation event, and no reason
  vocabulary at all. A single feature's private domain type
  (`src/features/authority-graph`), not a canonical `packages/*` Enterprise
  contract, and not about access to a governed resource.
- `RevocationLink` (`src/features/authority-graph/domain/revocation-link.ts`)
  -- tracks revocation lineage for `AuthorityGrant`/`DelegationGrant`/role
  assignments in that same feature, with a free-text `reason: string` and no
  closed vocabulary. Same feature-private scope as `AuthorityGrant`.

R004.D-F's conclusions, treated as authoritative for this sequence:

- Reuse a canonical concept when one exists; do not invent a duplicate
  without justification (Phase 4). Neither existing type fits: both are
  private to `src/features/authority-graph`, model organizational authority
  rather than resource-access grants, and neither has a closed,
  provider-neutral reason vocabulary.
- Enterprise composes Protocol/Enterprise contracts *by reference* when the
  new type describes something *about* the composed value, never by
  embedding or extending it wholesale -- and, per R004.F's own precedent
  (`EnterpriseAccessObligation.decisionRef`), the referenced contract does
  not need to exist yet. A reference only requires a stable identifier space
  (`CanonicalId`, already defined by `@aoc/protocol`) to point into.

## Decision

Create `EnterpriseGrantRevocation` in a new package,
`@aoc-enterprise/grant-revocation` (`packages/grant-revocation`):

- **References a future `EnterpriseAccessGrant` by an opaque grant
  identifier** (`grantRef: CanonicalId`), never by embedding it. No
  `EnterpriseAccessGrant` contract is defined by this change, or required to
  exist for this one to be complete -- mirrors the reference style
  `EnterpriseAccessObligation.decisionRef` already establishes for a
  composed contract, and `EnterpriseAccessDecision.policyEvaluationRef`
  establishes for a contract whose shape is *never* defined by
  `@aoc-enterprise/access-decision` at all.
- **Does not reuse `AuthorityGrant` or `RevocationLink`.** Both were
  evaluated and rejected for a distinct, documented reason (see the package
  README's "Evaluated and not reused" section for the full comparison
  table): both are private to one feature (`src/features/authority-graph`),
  model organizational authority rather than resource-access grants, and
  neither has a closed, provider-neutral revocation-reason vocabulary.
- **Defines a new, closed `EnterpriseGrantRevocationReason` vocabulary** of
  exactly the seven categories this sequence's own evidence identifies
  (Phase 4's "Expected examples"): `expired`, `administrator-revoked`,
  `policy-changed`, `principal-disabled`, `resource-removed`,
  `manual-revocation`, `security-incident`. No provider-specific revocation
  reason is introduced (non-negotiable rule). Every category remains
  declarative: this contract records that a category of cause applies, never
  how to act on it.
- **Represents the revocation instant with a single `revokedAt` timestamp**,
  never a workflow-shaped status; this contract never decides what happens
  anywhere else as a result of the revocation.
- **References the recording principal/system via `issuerRef`**, and ties
  the record into a wider audit trail via `correlationId` (mirroring
  `EnterpriseAccessDecision.correlationId` in name and purpose) and optional
  `evidenceRefs` (mirroring the same field on `EnterpriseAccessDecision` /
  `EnterpriseAccessObligation`).
- **Is purely descriptive and non-executable.** No persistence, no service,
  no API, no provider adapter, no URL invalidation, no cache invalidation,
  no session termination, no JWT invalidation, no OAuth revocation, no
  timer, no scheduler, no runtime enforcement.
- **Validates per-record shape and, separately, duplicate revocations across
  a collection.** `validateEnterpriseGrantRevocation` checks required
  fields, reference-field shape ("reference integrity"), timestamp
  well-formedness ("timestamp consistency"), and reason-vocabulary
  membership ("reason consistency") for one record;
  `validateEnterpriseGrantRevocationSet` checks that no two records in a
  collection share an `id`, and that no two records claim to revoke the same
  `grantRef` ("duplicate revocations") -- a grant is revoked at most once.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted evidence-ref sets, undefined fields omitted rather than
  written as `null`).
- **Provides identity equality derived from `id`, `grantRef`, and
  `revokedAt` together** (Phase 7's required basis: "revocation identity,
  grant reference, timestamp"), and full structural equality extending it to
  every other declarative field (`reason`, `issuerRef`, `correlationId`,
  `evidenceRefs`, `description`) -- the same compound-identity pattern
  `enterpriseAccessDecisionIdentityEquals` already establishes.

## New contract responsibilities

- Represent revocation identity (`id`), the revoked grant reference
  (`grantRef`), the revocation timestamp (`revokedAt`), and the revocation
  reason (`reason`).
- Represent the issuer of the revocation (`issuerRef`) and a correlation
  identifier tying the record into a wider audit trail (`correlationId`).
- Represent optional evidence references (`evidenceRefs?`) and optional
  human-readable documentation metadata (`description?`).
- Validate its own internal consistency (required fields, reference
  integrity, timestamp consistency, reason consistency) and, across a
  collection, duplicate revocations; (de)serialize deterministically.

## Explicit non-responsibilities

Enforced at compile time (`@ts-expect-error`) -- see
`__tests__/enterprise-grant-revocation.test.ts`:

- provider execution, runtime state, provider URLs, download links
- JWTs, OAuth tokens/state, API keys, provider credentials
- Pinata-shaped, S3-shaped, Azure-shaped, or any other provider SDK client
- network/HTTP clients
- runtime callbacks
- session state, cache state
- grant fields (resource, scope, expiry, status, ...) -- these belong to a
  future `EnterpriseAccessGrant`, never duplicated or embedded here
- provider/resource-existence/network/policy-correctness/runtime-enforcement
  validation (excluded from `validateEnterpriseGrantRevocation` by design,
  not by omission)

## Future integration path

```text
EnterpriseAccessGrant (future)
        │ referenced by grantRef (never embedded)
        ▼
EnterpriseGrantRevocation
  id | grantRef | revokedAt | reason | issuerRef | correlationId |
  evidenceRefs? | description?
        │
        ├── future: UsageEvent stops attributing usage to a revoked grant
        ├── future: evidence-correlation contract ties correlationId/evidenceRefs
        │           into a wider audit trail
        ├── future: audit/compliance surface renders revocation records
        └── future: provider adapter (Pinata / S3 / Azure Blob / Google Drive /
                    SharePoint) interprets `reason` when it next reaches the
                    resource -- e.g. `resource-removed` → unpin/delete provider
                    object; `security-incident` → revoke outstanding presigned
                    URLs; `principal-disabled` → remove a share/permission.
                    No provider-specific logic is introduced by this change.
```

**No adapter, grant, enforcement layer, or audit contract is implemented as
part of this change.**

## Tests

`packages/grant-revocation/__tests__/enterprise-grant-revocation.test.ts`:

- Positive: construction (full and minimal), composition (references a
  future `EnterpriseAccessGrant` by `grantRef` only, never embeds any
  grant-shaped field), identity and structural equality, validation
  (accepting valid shapes, every canonical reason), duplicate detection
  (both duplicate `id` and duplicate `grantRef`) across a collection,
  serialization determinism, and round-trip (de)serialization.
- Negative: rejecting missing/invalid required fields, a malformed
  timestamp, an out-of-vocabulary `reason`; plus compile-time
  `@ts-expect-error` proofs (matching the convention established in
  `packages/resource-envelope`, `packages/access-decision`, and
  `packages/access-obligation`) that the contract cannot carry provider
  URLs, JWTs, OAuth state, Pinata/S3/Azure SDK clients, network clients,
  runtime callbacks, provider credentials, API keys, download URLs, session
  identifiers, or cache keys; plus that fields are immutable (`readonly`, no
  reassignment).

## Compatibility

- No change to `@aoc/protocol`, `EnterpriseResourceEnvelope`,
  `EnterpriseAccessDecision`, `EnterpriseAccessObligation`, `AuthorityGrant`,
  or `RevocationLink`.
- No `EnterpriseAccessGrant` contract is introduced or assumed to exist by
  this change; `grantRef` is a forward-compatible opaque reference.
- New workspace package (`packages/grant-revocation`), added to the root
  `tsconfig.json` project references so `npm run build`/`typecheck` cover
  it, the same way `packages/access-obligation` and
  `packages/access-decision` are.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), matching the
  precedent set by `packages/resource-envelope`, `packages/access-decision`,
  and `packages/access-obligation`.

## Blast radius

Existing and future code that *could* eventually consume
`EnterpriseGrantRevocation` once a grant contract, usage tracking, and
provider adapters exist -- listed for future sequences, **not migrated by
this change**:

- A future `EnterpriseAccessGrant` contract -- the natural place a
  revocation is looked up by grant identity.
- A future `UsageEvent` contract -- would stop attributing observed usage to
  a grant once a matching `EnterpriseGrantRevocation` exists for it.
- A future evidence-correlation contract -- would tie `correlationId` and
  `evidenceRefs` into a wider audit trail alongside `EnterpriseAccessDecision`
  and `EnterpriseAccessObligation` records.
- A future audit/compliance surface -- would render revocation records as
  part of an immutable audit trail.
- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would interpret a revocation's `reason`
  when it next reaches the resource the revoked grant covered.
- A future monitoring surface -- would alert on `security-incident`
  revocations or track revocation volume by `reason`.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/grant-revocation` via
  the new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/grant-revocation`
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.H)

- No provider adapter (Pinata, S3, Azure Blob, Google Drive, SharePoint, or
  any other) is implemented.
- No URL invalidation, cache invalidation, session termination, JWT
  invalidation, or OAuth revocation is implemented.
- No timer, scheduler, persistence, API, service, or runtime enforcement is
  added.
- No `EnterpriseAccessGrant`, `UsageEvent`, or evidence-correlation contract
  is implemented.
- No existing consumer (`AuthorityGrant`, `RevocationLink`, or anything
  referencing them) is migrated to this contract.
