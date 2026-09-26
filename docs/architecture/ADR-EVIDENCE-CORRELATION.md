# ADR: Canonical Evidence Correlation (R004.J)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.D (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  R004.E (`ADR-ACCESS-DECISION.md`, `EnterpriseAccessDecision`),
  R004.F (`ADR-POLICY-OBLIGATION.md`, `EnterpriseAccessObligation`),
  R004.G (`ADR-ACCESS-GRANT.md`, `EnterpriseAccessGrant`),
  R004.H (`ADR-GRANT-REVOCATION.md`, `EnterpriseGrantRevocation`),
  R004.I (`ADR-USAGE-EVENT.md`, `EnterpriseUsageEvent`)

## Context

R004.D-I established a composition line -- `EnterpriseResourceEnvelope`
(wraps Protocol's `ResourceRef`), `EnterpriseAccessDecision` (an evaluated
outcome), `EnterpriseAccessObligation` (a condition attached to a decision),
`EnterpriseAccessGrant` (an issued authorization), `EnterpriseGrantRevocation`
(the end of a grant's validity), and `EnterpriseUsageEvent` (an observed
exercise of a grant) -- each referencing the layer beneath it by an opaque
`CanonicalId`, never embedding or extending it. Every one of these contracts
answers a question about **one fact, at one point**, in a governed access
lifecycle. `EnterpriseUsageEvent`'s own README names the gap directly in its
"Blast radius" section: "A future evidence-correlation contract -- would tie
`correlationId` and `evidenceRefs` into a wider audit trail alongside
`EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
`EnterpriseAccessGrant`, and `EnterpriseGrantRevocation` records."

No contract in this repository answers a question that spans the whole
lifecycle: *"which of these immutable facts, taken together, explain this
access lifecycle for this resource?"* Nothing generates evidence, collects
logs, or executes providers -- that is explicitly out of scope for this
sequence (see "Non-negotiable rules"). What is missing is a purely
declarative structure that represents *that a set of already-immutable
records belong together*, without becoming the mechanism that produced any
of them.

R004.D-I's conclusions, treated as authoritative for this sequence:

- Reuse a canonical concept when one exists; do not invent a duplicate
  without justification (Phase 4). Every reference field on
  `EnterpriseEvidenceCorrelation` reuses the exact `readonly CanonicalId[]`
  shape `EnterpriseAccessGrant.obligationRefs`/`auditRefs` and
  `EnterpriseAccessDecision`/`EnterpriseGrantRevocation`/
  `EnterpriseUsageEvent`'s `evidenceRefs` already establish -- no new
  collection abstraction is introduced.
- Enterprise composes Protocol/Enterprise contracts *by reference* when the
  new type describes something *about* the composed values, never by
  embedding or extending them wholesale. This sequence composes with six
  existing contracts simultaneously, by reference only, and modifies none of
  them.
- A reference does not require dereferencing an unknown record shape: this
  contract composes `EnterpriseAccessDecision` by its `correlationId` (the
  only externally-referenceable handle it has -- `EnterpriseAccessDecision`
  carries no `id` field of its own) and every other contract by its `id`,
  matching each contract's own established external-reference convention
  (`EnterpriseAccessObligation.decisionRef`, `EnterpriseGrantRevocation.grantRef`,
  `EnterpriseUsageEvent.grantRef`).

## Decision

Create `EnterpriseEvidenceCorrelation` in a new package,
`@aoc-enterprise/evidence-correlation` (`packages/evidence-correlation`):

- **References every other R004 contract by an opaque identifier array**,
  never by embedding: `decisionRefs: readonly CanonicalId[]` (pointing at
  `EnterpriseAccessDecision.correlationId`), `obligationRefs?`, `grantRefs?`,
  `usageRefs?`, `revocationRefs?` (each pointing at the referenced record's
  own `id`). No field belonging to any referenced contract (`outcome`,
  `evaluatedAt`, `mandatory`, `status`, `issuedAt`, `expiresAt`, `reason`,
  `eventType`, `occurredAt`, `principalId`, ...) is duplicated on
  `EnterpriseEvidenceCorrelation`.
- **Composes Soberanía Protocol's `ResourceRef` directly** (`resource: ResourceRef`,
  identity only), the same identity-only composition style
  `EnterpriseAccessGrant.resource` / `EnterpriseUsageEvent.resource` already
  establish -- never the full `EnterpriseResourceEnvelope`.
- **Requires `decisionRefs` to be a non-empty array**, and leaves every other
  reference collection optional: every governed access lifecycle in this
  line begins with an evaluated decision (R004.E), but does not always
  progress to an issued grant, a recorded usage, or a revocation.
- **Validates graph consistency as two purely structural implications**,
  never as an existence check: `usageRefs` cannot be populated without
  `grantRefs` also being populated (mirroring `EnterpriseUsageEvent.grantRef`
  -- a usage event always reports usage of a specific grant), and
  `revocationRefs` cannot be populated without `grantRefs` also being
  populated (mirroring `EnterpriseGrantRevocation.grantRef` -- a revocation
  always revokes a specific grant).
- **Carries a single `correlatedAt` timestamp** recording when the
  correlation graph itself was formed -- never validated against, or
  assumed to relate to, any referenced record's own timestamp (this
  contract does not know or assume the shape of any of them, the same
  boundary `EnterpriseUsageEvent.occurredAt` already establishes relative to
  a grant's validity window).
- **Carries an open, provider-neutral `metadata?` bag**, restricted to JSON
  primitives and to key names that do not resemble a credential, token, or
  URL -- reusing `EnterpriseUsageEvent.metadata`'s identical guard
  (`FORBIDDEN_METADATA_KEY_SUBSTRINGS`) verbatim, rather than inventing a
  second policy for the same risk.
- **Is purely relational and non-executable, and carries no evidence
  itself.** No persistence, no service, no API, no provider adapter, no
  logging, no storage, no audit execution, no analytics, no telemetry, no
  runtime execution. Distinctively for this contract (the "Most important
  rule"): no field can carry a JWT, a URL, a provider SDK client, a network
  client, a storage/bucket object, a runtime trace, a telemetry payload, an
  analytics payload, or an audit report -- see the package README's
  "Explicit non-responsibilities".
- **Validates required references, duplicate references, graph consistency,
  and timestamp consistency for a single graph; validates duplicate
  correlation identity across a collection, separately.**
  `validateEnterpriseEvidenceCorrelation` checks one graph;
  `validateEnterpriseEvidenceCorrelationSet` checks that no two graphs in a
  collection share an `id`. Neither checks provider availability, network,
  storage, or authorization -- and neither confirms that any referenced
  record actually exists.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted reference-array sets, sorted metadata keys, undefined
  fields omitted rather than written as `null`).
- **Provides identity equality derived from correlation identity, resource,
  and graph composition together** (Phase 8's required basis), and full
  structural equality extending it to every other declarative field
  (`schemaVersion`, `correlatedAt`, `metadata`, `description`,
  `resource.attributes`). Reference-array comparisons are set-based (order
  carries no meaning), the same pattern `enterpriseAccessGrantEquals`'s
  `obligationRefs`/`auditRefs` comparison already establishes.

## New contract responsibilities

- Represent correlation identity (`id`), the correlated resource reference
  (`resource`), and the correlated decision/obligation/grant/usage/
  revocation reference collections (`decisionRefs`, `obligationRefs?`,
  `grantRefs?`, `usageRefs?`, `revocationRefs?`).
- Represent a correlation timestamp (`correlatedAt`), optional
  provider-neutral correlation metadata (`metadata?`), and optional
  human-readable documentation metadata (`description?`).
- Validate its own internal consistency (required references, duplicate
  references, graph consistency, timestamp consistency, reference
  integrity) and, across a collection, duplicate correlation identity;
  (de)serialize deterministically.

## Explicit non-responsibilities

Enforced at compile time (`@ts-expect-error`) -- see
`__tests__/enterprise-evidence-correlation.test.ts`:

- a JWT, an OAuth token, a provider URL, a download link, or a signed URL
- Pinata-shaped, S3-shaped, Azure-shaped, or any other provider SDK client
- a network/HTTP client
- a storage/bucket/blob object
- a provider credential or an API key
- a runtime trace, a telemetry payload, or an analytics payload
- an audit report
- a runtime callback
- a session identifier
- a `success`/`httpStatus`/provider-response field
- any field belonging to a referenced contract (`outcome`, `evaluatedAt`,
  `mandatory`, `status`, `issuedAt`, `expiresAt`, `reason`, `eventType`,
  `occurredAt`, `principalId`, ...)
- provider-availability/network/storage/authorization/runtime-execution
  validation (excluded from `validateEnterpriseEvidenceCorrelation` by
  design, not by omission)

## Future integration path

```text
EnterpriseAccessDecision / EnterpriseAccessObligation / EnterpriseAccessGrant /
EnterpriseGrantRevocation / EnterpriseUsageEvent (existing, R004.E-I)
        │ referenced by decisionRefs/obligationRefs/grantRefs/
        │ usageRefs/revocationRefs (never embedded)
        ▼
EnterpriseEvidenceCorrelation
  id | resource | decisionRefs | obligationRefs? | grantRefs? |
  usageRefs? | revocationRefs? | correlatedAt | metadata? | description?
        │
        ├── future: ProviderAdapters remain the indirect contributor of
        │           evidence -- they emit the EnterpriseUsageEvent records
        │           usageRefs eventually points at; they never write to or
        │           are referenced by name from this contract.
        ├── future: Audit reads correlation graphs as the index into a
        │           resource's full evidentiary trail.
        ├── future: Compliance walks correlation graphs to answer
        │           lifecycle-spanning questions.
        └── future: SIEM treats correlation graphs as correlated event
                    bundles to alert on.
```

**No provider adapter, audit engine, compliance module, or SIEM connector is
implemented as part of this change.**

## Tests

`packages/evidence-correlation/__tests__/enterprise-evidence-correlation.test.ts`:

- Positive: construction (full and minimal, including a graph with only
  `resource`/`decisionRefs` and a graph with multiple `decisionRefs`),
  composition (references every other R004 contract by opaque id only,
  never embeds any of their fields; carries `resource` directly), identity
  and structural equality (including reference-array construction-order
  insensitivity), validation (accepting valid shapes, accepting
  `usageRefs`/`revocationRefs` alongside `grantRefs`), duplicate detection
  (per-array duplicate references, and duplicate `id` across a collection),
  serialization determinism, and round-trip (de)serialization.
- Negative: rejecting missing/invalid required fields, an empty or
  non-array `decisionRefs`, duplicate references within any reference
  array, `usageRefs`/`revocationRefs` populated without `grantRefs`
  ("graph consistency"), a malformed `correlatedAt` timestamp, a
  non-primitive `metadata` value, a `metadata` key resembling a
  credential/token/URL, and a non-string `description`; a proof that no
  provider/network/storage/existence check is performed on any reference;
  plus compile-time `@ts-expect-error` proofs (matching the convention
  established across `packages/resource-envelope`, `packages/access-decision`,
  `packages/access-obligation`, `packages/access-grant`,
  `packages/grant-revocation`, and `packages/usage-event`) that the
  contract cannot carry a JWT, a URL, any provider SDK, a network client, a
  storage object, a provider credential, an API key, a runtime trace, a
  telemetry payload, an analytics payload, or an audit report; plus that
  fields are immutable (`readonly`, no reassignment).

## Compatibility

- No change to `@aoc/protocol`, `EnterpriseResourceEnvelope`,
  `EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
  `EnterpriseAccessGrant`, `EnterpriseGrantRevocation`, or
  `EnterpriseUsageEvent`.
- New workspace package (`packages/evidence-correlation`), added to the root
  `tsconfig.json` project references (with a `references` entry to
  `../resource-envelope`, mirroring `packages/access-grant` and
  `packages/usage-event`) so `npm run build`/`typecheck` cover it.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), matching the
  precedent set by every other contract in this line.

## Blast radius

Existing and future code that *could* eventually consume
`EnterpriseEvidenceCorrelation` once audit/compliance/SIEM surfaces and
provider adapters exist -- listed for future sequences, **not migrated by
this change**:

- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would remain the indirect contributor of
  evidence via the `EnterpriseUsageEvent` records it emits.
- A future Audit surface -- would render correlation graphs as the index
  into a resource's full evidentiary trail.
- A future Compliance surface -- would use correlation graphs to answer
  lifecycle-spanning compliance questions.
- A future Reporting/Analytics surface -- would summarize or aggregate
  correlation graphs without this contract performing any aggregation.
- A future SIEM integration -- would treat correlation graphs as correlated
  event bundles to alert on.
- The Control Plane -- would eventually expose correlation graphs read-only
  to operators.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/evidence-correlation`
  via the new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/evidence-correlation`
- `npm test` (full workspace suite)
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run check:protocol-contract-adoption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.J)

- No provider adapter (Pinata, S3, Azure Blob, Google Drive, SharePoint, or
  any other) is implemented.
- No audit engine, logging system, SIEM, analytics engine, telemetry
  pipeline, storage implementation, or runtime executor is implemented.
- No timer, scheduler, persistence, API, service, or runtime execution is
  added.
- No change to `EnterpriseResourceEnvelope`, `EnterpriseAccessDecision`,
  `EnterpriseAccessObligation`, `EnterpriseAccessGrant`,
  `EnterpriseGrantRevocation`, or `EnterpriseUsageEvent`.
- No existing consumer is migrated to this contract (none exists yet).
