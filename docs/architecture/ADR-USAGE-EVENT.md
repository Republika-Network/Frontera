# ADR: Canonical Usage Event (R004.I)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.D (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  R004.E (`ADR-ACCESS-DECISION.md`, `EnterpriseAccessDecision`),
  R004.F (`ADR-POLICY-OBLIGATION.md`, `EnterpriseAccessObligation`),
  R004.G (`ADR-ACCESS-GRANT.md`, `EnterpriseAccessGrant`),
  R004.H (`ADR-GRANT-REVOCATION.md`, `EnterpriseGrantRevocation`)

## Context

R004.D-H established a composition line -- `EnterpriseResourceEnvelope`
(wraps Protocol's `ResourceRef`), `EnterpriseAccessDecision` (composes a
scoped access request with a resource envelope into an evaluated outcome),
`EnterpriseAccessObligation` (attaches a mandatory or optional condition to
a decision), `EnterpriseAccessGrant` (the immutable record of an issued
authorization), and `EnterpriseGrantRevocation` (the immutable record that a
previously-issued grant is no longer valid) -- each referencing the layer
beneath it by an opaque `CanonicalId`, never embedding or extending it.
`EnterpriseAccessGrant`'s own README states this sequence's outstanding
question directly: a grant records that authorization was issued; it
"never carries out, enforces, or translates that authorization into
anything a provider understands" and never records that the authorization
was *used*. `EnterpriseGrantRevocation`'s README lists a future
`UsageEvent` contract in its own "Blast radius" section: "would stop
attributing observed usage to a grant once a matching
`EnterpriseGrantRevocation` exists for it."

No contract in this repository records that an issued grant was actually
exercised. `EnterpriseAccessGrant` is immutable and issued once; it cannot
grow a usage log without breaking its own issued-once shape. Something
needs to record, immutably and repeatably -- once per observed usage --
*that* a grant was exercised: who, what, when, using which grant, against
which resource. It must do this without becoming the mechanism that carries
the access out (a provider's API call, a rendered page, a streamed byte
range) and without re-deciding anything `EnterpriseAccessDecision` or
`EnterpriseAccessGrant` already settled.

R004.D-H's conclusions, treated as authoritative for this sequence:

- Reuse a canonical concept when one exists; do not invent a duplicate
  without justification (Phase 4). No usage/activity-event contract exists
  anywhere in this repository (searched `src/`, `packages/`, `docs/`); see
  the package README's "Vocabulary search" section for the closest
  candidates considered and rejected (`EnterpriseEventType`,
  `AssuranceEnterpriseEventType` -- both operational event catalogs for a
  different concept, at a different layer).
- Enterprise composes Protocol/Enterprise contracts *by reference* when the
  new type describes something *about* the composed value, never by
  embedding or extending it wholesale. Unlike R004.H (which referenced a
  grant contract that did not exist yet), `EnterpriseAccessGrant` now exists
  (R004.G) -- this sequence references it directly, by the same opaque
  `grantRef: CanonicalId` style `EnterpriseGrantRevocation.grantRef` already
  established.

## Decision

Create `EnterpriseUsageEvent` in a new package, `@aoc-enterprise/usage-event`
(`packages/usage-event`):

- **References `EnterpriseAccessGrant` by an opaque grant identifier**
  (`grantRef: CanonicalId`, pointing at that grant's own `id`), never by
  embedding it. No grant field (`resource`, `status`, `issuedAt`,
  `expiresAt`, `decisionRef`, `obligationRefs`, `auditRefs`, ...) is
  duplicated on `EnterpriseUsageEvent`.
- **Carries `resource: ResourceRef` and `principalId: CanonicalId`
  directly**, rather than requiring `EnterpriseAccessGrant` to be
  dereferenced -- the same rationale `EnterpriseAccessGrant.resource` /
  `EnterpriseAccessGrant.principalId` already document for referencing
  `EnterpriseAccessDecision` by `decisionRef`.
- **Defines a new, closed `EnterpriseUsageEventType` vocabulary** of exactly
  the ten categories this sequence's own evidence identifies (Phase 4's
  "Expected examples", reproduced verbatim): `AccessAttempted`,
  `AccessStarted`, `AccessCompleted`, `AccessDenied`, `AccessExpired`,
  `AccessFailed`, `GrantConsumed`, `ContentViewed`, `ContentDownloaded`,
  `ContentStreamed`. No provider-specific event is introduced
  (non-negotiable rule). Every category remains a *description of what was
  observed*, never a judgment this record performed itself: `AccessDenied`
  records that an observed attempt did not proceed, it does not re-run
  `EnterpriseAccessDecision`'s evaluation or carry a reason code;
  `AccessFailed` records that an attempted access did not complete, it is
  not a provider status code or SDK error object.
- **Uses PascalCase vocabulary values**, deliberately departing from the
  kebab-case convention this repository's *category*-shaped vocabularies use
  (`EnterpriseAccessObligationType`, `EnterpriseGrantRevocationReason`), to
  match the PascalCase convention this repository's existing
  *event-name*-shaped vocabulary already uses (`EnterpriseEventType` in
  `src/enterprise/events/enterprise-events.ts`) and to reproduce this
  sequence's own Phase 4 examples verbatim. See the package README's
  "Event-type naming" section.
- **Represents the observed instant with a single `occurredAt` timestamp**,
  never validated against a grant's own `issuedAt`/`expiresAt` window --
  this contract does not know or assume the shape of
  `EnterpriseAccessGrant`, the same boundary
  `EnterpriseGrantRevocation.revokedAt` already establishes relative to a
  grant's validity window.
- **References the recording principal via `principalId`**, and ties the
  record into a wider audit trail via `correlationId` (mirroring
  `EnterpriseAccessGrant.correlationId` / `EnterpriseGrantRevocation.correlationId`
  in name and purpose) and optional `evidenceRefs` (mirroring the same field
  across this contract line).
- **Carries an open, provider-neutral `metadata?` bag**, restricted to JSON
  primitives and to key names that do not resemble a credential, token, or
  URL -- reusing `EnterpriseAccessObligation.parameters`'s identical guard
  (`FORBIDDEN_PARAMETER_KEY_SUBSTRINGS`) verbatim as
  `FORBIDDEN_METADATA_KEY_SUBSTRINGS`, rather than inventing a second policy
  for the same risk.
- **Is purely descriptive and non-executable, and carries no authorization
  or provider-outcome judgment.** No persistence, no service, no API, no
  provider adapter, no download/signed URL, no JWT/OAuth state, no provider
  credential, no runtime session, no execution engine, no enforcement, no
  policy evaluation. Distinctively for this contract (Phase 5's explicit
  prohibitions): no `allowed` field (whether access was permitted is
  `EnterpriseAccessDecision`'s/`EnterpriseAccessGrant`'s fact), no
  `enforced` field (obligation enforcement is a future layer's job), and no
  `success`/`httpStatus`/provider-response field (a provider's own
  success/failure determination is never recorded here -- only a
  provider-neutral `eventType` category).
- **Validates per-event shape and, separately, duplicate event identity
  across a collection.** `validateEnterpriseUsageEvent` checks required
  fields, reference-field shape ("reference integrity"), timestamp
  well-formedness ("timestamp consistency"), event-type-vocabulary
  membership, and `metadata` shape/key-safety for one event;
  `validateEnterpriseUsageEventSet` checks that no two events in a
  collection share an `id`. Deliberately does **not** forbid two events from
  sharing a `grantRef` -- unlike `EnterpriseGrantRevocation` (a grant is
  revoked at most once), a grant is expected to be exercised, and observed,
  many times; that repeatability is the entire reason this contract exists
  as a per-event record.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted evidence-ref sets, sorted metadata keys, undefined fields
  omitted rather than written as `null`).
- **Provides identity equality derived from `id`, `occurredAt`, `grantRef`,
  and `eventType` together** (Phase 8's required basis: "event identity,
  timestamp, grant reference, event type"), and full structural equality
  extending it to every other declarative field (`resource` via
  `resourceRefIdentityEquals` plus `resource.attributes`, `principalId`,
  `correlationId`, `metadata`, `evidenceRefs`, `description`) -- the same
  compound-identity pattern `enterpriseGrantRevocationIdentityEquals`
  already establishes. Deliberately excludes `resource`/`principalId` from
  the identity basis itself, per Phase 8's literal, four-field
  specification -- they still participate in full structural equality.

## New contract responsibilities

- Represent usage event identity (`id`), the referenced grant (`grantRef`),
  the resource the usage was observed against (`resource`), the principal
  who exercised the grant (`principalId`), the observed instant
  (`occurredAt`), and the observed usage category (`eventType`).
- Represent a correlation identifier tying the record into a wider audit
  trail (`correlationId`).
- Represent optional provider-neutral metadata (`metadata?`), optional
  evidence references (`evidenceRefs?`), and optional human-readable
  documentation metadata (`description?`).
- Validate its own internal consistency (required fields, reference
  integrity, timestamp consistency, event-type-vocabulary membership,
  metadata shape/key-safety) and, across a collection, duplicate event
  identity; (de)serialize deterministically.

## Explicit non-responsibilities

Enforced at compile time (`@ts-expect-error`) -- see
`__tests__/enterprise-usage-event.test.ts`:

- provider execution, runtime state, provider URLs, download links, signed
  URLs
- JWTs, OAuth tokens/state, API keys, provider credentials
- Pinata-shaped, S3-shaped, Azure-shaped, or any other provider SDK client
- network/HTTP clients
- runtime callbacks
- session state, cache state
- an `allowed` field -- whether access was permitted is
  `EnterpriseAccessDecision`'s/`EnterpriseAccessGrant`'s fact
- an `enforced` field -- obligation enforcement belongs to a future
  enforcement layer
- a `success`/`httpStatus`/provider-response field -- "was it successful
  from the provider's perspective?" is out of scope by design (Phase 5)
- a `policyEvaluationRef` field -- policy evaluation is
  `EnterpriseAccessDecision`'s responsibility
- grant fields (`status`, `decisionRef`, `issuedAt`, `expiresAt`,
  `issuerRef`, `obligationRefs`, `auditRefs`, ...) -- these belong to
  `EnterpriseAccessGrant`, never duplicated or embedded here
- provider/resource-existence/network/policy-correctness/authorization-decision
  validation (excluded from `validateEnterpriseUsageEvent` by design, not by
  omission)

## Future integration path

```text
EnterpriseAccessGrant (existing, R004.G)
        │ referenced by grantRef (never embedded)
        ▼
EnterpriseUsageEvent
  id | eventType | grantRef | resource | principalId | occurredAt |
  correlationId | metadata? | evidenceRefs? | description?
        │
        ├── future: evidence-correlation contract ties correlationId/evidenceRefs
        │           into a wider audit trail
        ├── future: audit/compliance surface renders usage events
        ├── future: analytics surface aggregates by eventType/resource/principalId
        ├── future: monitoring/SIEM integration alerts on AccessDenied/AccessFailed
        │           volume
        └── future: provider adapter (Pinata / S3 / Azure Blob / Google Drive /
                    SharePoint) is the actual emitter -- observes a real access
                    attempt against its own provider and emits the matching
                    eventType (e.g. a presigned-URL GetObject → ContentDownloaded;
                    a rejected SAS-token check → AccessDenied). No
                    provider-specific logic is introduced by this change.
```

**No adapter, enforcement layer, analytics engine, or audit contract is
implemented as part of this change.**

## Tests

`packages/usage-event/__tests__/enterprise-usage-event.test.ts`:

- Positive: construction (full and minimal), composition (references
  `EnterpriseAccessGrant` by `grantRef` only, never embeds any grant-shaped
  field; carries `resource`/`principalId` directly; a single `grantRef` may
  be shared by many usage events), identity and structural equality,
  validation (accepting valid shapes, every canonical `eventType`),
  duplicate detection (duplicate `id` only, not duplicate `grantRef`) across
  a collection, serialization determinism, and round-trip
  (de)serialization.
- Negative: rejecting missing/invalid required fields, a malformed
  timestamp, an out-of-vocabulary `eventType`, a non-primitive `metadata`
  value, and a `metadata` key resembling a credential/token/URL; plus
  compile-time `@ts-expect-error` proofs (matching the convention
  established across `packages/resource-envelope`, `packages/access-decision`,
  `packages/access-obligation`, `packages/access-grant`, and
  `packages/grant-revocation`) that the contract cannot carry provider URLs,
  JWTs, OAuth state, Pinata/S3/Azure SDK clients, network clients, runtime
  callbacks, provider credentials, API keys, download/signed URLs, session
  identifiers, cache keys, or -- specific to this contract -- an `allowed`,
  `enforced`, `success`/`httpStatus`, or `policyEvaluationRef` field; plus
  that fields are immutable (`readonly`, no reassignment).

## Compatibility

- No change to `@aoc/protocol`, `EnterpriseResourceEnvelope`,
  `EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
  `EnterpriseAccessGrant`, or `EnterpriseGrantRevocation`.
- New workspace package (`packages/usage-event`), added to the root
  `tsconfig.json` project references (with a `references` entry to
  `../resource-envelope`, mirroring `packages/access-grant`) so `npm run
  build`/`typecheck` cover it.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), matching the
  precedent set by `packages/resource-envelope`, `packages/access-decision`,
  `packages/access-obligation`, `packages/access-grant`, and
  `packages/grant-revocation`.

## Blast radius

Existing and future code that *could* eventually consume
`EnterpriseUsageEvent` once provider adapters and audit/analytics surfaces
exist -- listed for future sequences, **not migrated by this change**:

- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would be the actual emitter of usage
  events.
- A future evidence-correlation contract -- would tie `correlationId` and
  `evidenceRefs` into a wider audit trail alongside `EnterpriseAccessDecision`,
  `EnterpriseAccessObligation`, `EnterpriseAccessGrant`, and
  `EnterpriseGrantRevocation` records.
- A future audit/compliance surface -- would render usage events as part of
  an immutable audit trail.
- A future analytics surface -- would aggregate usage events by
  `eventType`/`resource`/`principalId`.
- A future monitoring/SIEM integration -- would alert on `AccessDenied`/
  `AccessFailed` volume or correlate usage patterns across principals.
- A future consumer reading `EnterpriseGrantRevocation` -- would stop
  attributing new usage events to a `grantRef` once a matching revocation
  record exists for it.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/usage-event` via the
  new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/usage-event`
- `npm test` (full workspace suite)
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run check:protocol-contract-adoption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.I)

- No provider adapter (Pinata, S3, Azure Blob, Google Drive, SharePoint, or
  any other) is implemented.
- No enforcement layer, analytics engine, monitoring/SIEM integration, or
  evidence-correlation contract is implemented.
- No timer, scheduler, persistence, API, service, or runtime execution is
  added.
- No change to `EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
  `EnterpriseAccessGrant`, `EnterpriseGrantRevocation`, or
  `EnterpriseResourceEnvelope`.
- No existing consumer is migrated to this contract (none exists yet).
