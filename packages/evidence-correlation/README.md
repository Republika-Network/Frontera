# @aoc-enterprise/evidence-correlation

The canonical Enterprise-owned contract for **the immutable correlation graph
that links every immutable business artifact produced across the lifecycle of
governed access**: `EnterpriseEvidenceCorrelation`. It references
`EnterpriseAccessDecision` (`@aoc-enterprise/access-decision`, R004.E),
`EnterpriseAccessObligation` (`@aoc-enterprise/access-obligation`, R004.F),
`EnterpriseAccessGrant` (`@aoc-enterprise/access-grant`, R004.G),
`EnterpriseGrantRevocation` (`@aoc-enterprise/grant-revocation`, R004.H), and
`EnterpriseUsageEvent` (`@aoc-enterprise/usage-event`, R004.I) -- each by an
opaque identifier -- and composes Soberanía Protocol's `ResourceRef` directly. It
never embeds, duplicates, or extends any of them.

This package is a pure data contract: no persistence, no service, no API, no
provider adapter, no logging, no storage, no audit execution, no analytics,
no telemetry, no runtime execution.

## Purpose

`EnterpriseResourceEnvelope`, `EnterpriseAccessDecision`,
`EnterpriseAccessObligation`, `EnterpriseAccessGrant`,
`EnterpriseGrantRevocation`, and `EnterpriseUsageEvent` each answer a
question about **one fact**, at **one point**, in a governed access
lifecycle. None of them, by itself, answers a question that spans the whole
lifecycle: *"which of these immutable facts, taken together, explain this
access lifecycle for this resource?"* `EnterpriseEvidenceCorrelation` is the
canonical Enterprise artifact that answers exactly that question:

> Which immutable facts together explain this access lifecycle?

It does **not** answer:

> What happened inside the provider?

`EnterpriseEvidenceCorrelation` does not generate evidence, does not collect
logs, and does not execute providers. It represents the canonical
correlation graph connecting immutable business artifacts that were produced
elsewhere, by other contracts, at other times. It is the terminal
graph-shaped layer of the R004 composition line -- the only contract in this
line whose entire purpose is to point at every other contract at once,
without adding a new fact of its own.

## What this contract is not

- It does not generate, produce, or collect evidence -- it only represents
  relationships between evidence that already exists as immutable records
  elsewhere.
- It does not collect logs.
- It does not execute providers or contact Pinata, S3, Azure Blob, Google
  Drive, SharePoint, or any other external system.
- It does not perform auditing -- it is a data structure a future audit
  surface would *read*, not an audit engine itself.
- It does not decide whether access was (or should be) allowed -- that is
  `EnterpriseAccessDecision`'s fact, never re-derived here.
- It does not evaluate or enforce policy or obligations.
- It does not issue, hold, or interpret a grant.
- It does not carry a provider URL, download link, signed URL, JWT, OAuth
  token, API key, or provider credential.
- It does not carry a provider's own success/failure status, a runtime
  trace, a telemetry payload, an analytics payload, or an audit report.
- It does not persist, store, execute, schedule, or run anything.

It records, immutably, that a set of previously-produced business artifacts
belong to the same governed access lifecycle for the same resource; it never
creates any of those artifacts, and it never interprets what happened inside
whatever produced them.

## Ownership

- **Every referenced record** (`EnterpriseAccessDecision`,
  `EnterpriseAccessObligation`, `EnterpriseAccessGrant`,
  `EnterpriseGrantRevocation`, `EnterpriseUsageEvent`) is referenced, not
  owned, via opaque `CanonicalId` arrays (`decisionRefs`, `obligationRefs?`,
  `grantRefs?`, `usageRefs?`, `revocationRefs?`). This package never
  duplicates any field belonging to any of them.
- **Everything on `EnterpriseEvidenceCorrelation`** -- `id`, `resource`,
  `decisionRefs`, `obligationRefs?`, `grantRefs?`, `usageRefs?`,
  `revocationRefs?`, `correlatedAt`, `metadata?`, `description?` -- is owned
  by Frontera Systems (`@aoc-enterprise/evidence-correlation`).

## Composition with the R004 line (Phase 2 / Phase 4)

Every contract beneath this one in the R004 line already established the
composition-by-reference style this contract reuses rather than reinventing:

| Contract | How it is referenced here | Why not the record's `id` |
| --- | --- | --- |
| `EnterpriseResourceEnvelope` | `resource: ResourceRef` (identity only) | Mirrors `EnterpriseAccessGrant.resource` / `EnterpriseUsageEvent.resource`: a correlation needs to know *which* resource, never its storage location/lifecycle state. |
| `EnterpriseAccessDecision` | `decisionRefs: readonly CanonicalId[]`, each pointing at a decision's own `correlationId` | `EnterpriseAccessDecision` has no `id` field of its own -- its identity is compound (resource + principal + `evaluatedAt`) and its externally-referenced handle is `correlationId`, the same handle `EnterpriseAccessObligation.decisionRef` already points at. |
| `EnterpriseAccessObligation` | `obligationRefs?: readonly CanonicalId[]`, each pointing at an obligation's own `id` | Mirrors `EnterpriseAccessGrant.obligationRefs`. |
| `EnterpriseAccessGrant` | `grantRefs?: readonly CanonicalId[]`, each pointing at a grant's own `id` | Mirrors `EnterpriseGrantRevocation.grantRef` / `EnterpriseUsageEvent.grantRef`. |
| `EnterpriseGrantRevocation` | `revocationRefs?: readonly CanonicalId[]`, each pointing at a revocation's own `id` | New reference kind this contract introduces -- no existing contract points *at* a revocation record, so no existing field name to reuse. |
| `EnterpriseUsageEvent` | `usageRefs?: readonly CanonicalId[]`, each pointing at a usage event's own `id` | New reference kind this contract introduces, for the same reason as `revocationRefs`. |

No new collection abstraction is invented (Phase 4): every reference field is
a plain `readonly CanonicalId[]`, the exact shape `EnterpriseAccessGrant`
(`obligationRefs`, `auditRefs`) and `EnterpriseAccessDecision`/
`EnterpriseGrantRevocation`/`EnterpriseUsageEvent` (`evidenceRefs`) already
use. `EnterpriseEvidenceCorrelation` **owns only the relationships** --
plain arrays of opaque identifiers -- never the evidence itself.

`decisionRefs` is the one required reference collection (non-empty). Every
other reference collection (`obligationRefs?`, `grantRefs?`, `usageRefs?`,
`revocationRefs?`) is optional, because a governed access lifecycle always
begins with an evaluated decision (R004.E), but does not always progress to
an issued grant (`outcome: 'deny'` never issues one), a recorded usage (a
grant may not yet have been exercised), or a revocation (a grant may still
be active).

## Evidence philosophy (Phase 5)

`EnterpriseEvidenceCorrelation` answers:

- **Which immutable artifacts belong together?** -- every record whose
  opaque id appears in `resource`/`decisionRefs`/`obligationRefs`/
  `grantRefs`/`usageRefs`/`revocationRefs` on the same
  `EnterpriseEvidenceCorrelation` value.
- **Which Decision produced this Grant?** -- `decisionRefs` correlated
  alongside `grantRefs` on the same graph.
- **Which Grant generated this Usage?** -- `grantRefs` correlated alongside
  `usageRefs` on the same graph (and structurally required to be present
  whenever `usageRefs` is -- see "Graph consistency" below).
- **Which Grant was revoked?** -- `grantRefs` correlated alongside
  `revocationRefs` on the same graph (same structural requirement).
- **Which Resource initiated the lifecycle?** -- `resource`, always present.

It never answers:

- **Was the provider successful?** -- no `success`/`httpStatus` field exists
  anywhere in this contract line, and this contract does not add one.
- **Was the download completed?** -- that is (at most) an observed
  `EnterpriseUsageEvent.eventType`, itself never a provider status; this
  contract does not re-derive or re-interpret it, only references the usage
  record's opaque `id`.
- **Did Pinata respond? Was S3 available?** -- this contract has no concept
  of a provider; it is provider-neutral by construction (no field can carry
  a provider name, SDK type, or response).

## Explicit non-responsibilities

`EnterpriseEvidenceCorrelation` never carries, and by design cannot carry
(enforced at compile time via `@ts-expect-error` -- see
`__tests__/enterprise-evidence-correlation.test.ts`):

- a JWT, an OAuth token, a provider URL, a download link, or a signed URL
- a Pinata SDK, Azure SDK, S3 SDK, or any other provider SDK client
- a network/HTTP client
- a storage/bucket/blob object -- this contract does not implement storage
- a provider credential or an API key
- a runtime trace, a telemetry payload, or an analytics payload
- an audit report -- audit execution belongs to a future Audit surface that
  *reads* this contract, never to this contract itself
- a runtime callback -- a correlation graph never executes itself
- a session identifier
- a `success`/`httpStatus`/provider-response field
- any field belonging to a referenced record (`outcome`, `evaluatedAt`,
  `mandatory`, `status`, `issuedAt`, `expiresAt`, `reason`, `eventType`,
  `occurredAt`, `principalId`, ...) -- every one of those belongs to the
  contract that owns it, never duplicated or embedded here

## Relationship with every other contract

```text
┌──────────────────────────────────────────────────────────────────────┐
│ EnterpriseResourceEnvelope (R004.D)                                    │
│   "what resource, in what storage state?"                                │
└──────────────────────────────┬───────────────────────────────────────┘
                                 │ resource: ResourceRef (identity only)
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ EnterpriseAccessDecision (R004.E)                                       │
│   "should access occur?"                                                   │
└──────────────────────────────┬───────────────────────────────────────┘
                                 │ decisionRefs (→ decision.correlationId)
              ┌──────────────────┴───────────────────┐
              │ obligationRefs? (→ obligation.id)         │
              ▼                                              ▼
┌───────────────────────────┐                 ┌──────────────────────────┐
│ EnterpriseAccessObligation   │                 │ EnterpriseAccessGrant       │
│ (R004.F)                       │                 │ (R004.G)                       │
│ "under what conditions?"          │                 │ "what authorization was       │
│                                     │                 │  issued?"                        │
└───────────────────────────┘                 └──────────────┬────────────┘
                                                                  │ grantRefs (→ grant.id)
                                                ┌──────────────────┴───────────────────┐
                                                │ usageRefs? (→ usage.id)                    │
                                                ▼                                              ▼
                                    ┌───────────────────────┐               ┌───────────────────────────┐
                                    │ EnterpriseUsageEvent      │               │ EnterpriseGrantRevocation     │
                                    │ (R004.I)                     │               │ (R004.H)                        │
                                    │ "what happened, using       │               │ "when/why did that                │
                                    │  that authorization?"          │               │  authorization end?"               │
                                    └───────────────────────┘               └───────────────────────────┘
                                                │                                              │
                                                └──────────────────┬───────────────────────────┘
                                                                     │ revocationRefs (→ revocation.id)
                                                                     ▼
                                                    ┌────────────────────────────────────┐
                                                    │ @aoc-enterprise/evidence-correlation    │
                                                    │                                          │
                                                    │ EnterpriseEvidenceCorrelation                │
                                                    │   id | resource | decisionRefs |             │
                                                    │   obligationRefs? | grantRefs? |               │
                                                    │   usageRefs? | revocationRefs? |               │
                                                    │   correlatedAt | metadata? | description?       │
                                                    │                                          │
                                                    │ "which immutable facts together             │
                                                    │  explain this access lifecycle?"              │
                                                    └───────────────┬──────────────┬─────────┘
                                                                      │ future        │ future
                                                                      ▼                ▼
                                                             Audit / Compliance   Provider Adapters /
                                                             / SIEM                 Control Plane
```

**`EnterpriseEvidenceCorrelation` does not create evidence. It links
immutable facts that already exist elsewhere.** Every arrow into this
contract in the diagram above is a reference (`CanonicalId` or `ResourceRef`
identity), never an embedding -- this contract's own `id` and structural
fields are the only new information it introduces.

## Lifecycle diagram

```text
Resource        Decision          Obligation/Grant       Usage/Revocation      EvidenceCorrelation
registered      evaluated         attached/issued        observed/recorded    formed
   │                │                     │                       │                    │
   │ resource        │                     │                       │                    │
   │ registered      │                     │                       │                    │
   │ (R004.D)          │                     │                       │                    │
   │                │  request evaluated    │                       │                    │
   │                │  (R004.E)                │                       │                    │
   │                │─────────────────────▶│                       │                    │
   │                │                     │  obligation attached      │                    │
   │                │                     │  (R004.F, optional)          │                    │
   │                │                     │  grant issued                │                    │
   │                │                     │  (R004.G, optional)             │                    │
   │                │                     │─────────────────────▶│                    │
   │                │                     │                       │  usage observed       │
   │                │                     │                       │  (R004.I, optional)      │
   │                │                     │                       │  grant revoked           │
   │                │                     │                       │  (R004.H, optional)         │
   │                │                     │                       │───────────────────▶│
   │                │                     │                       │                    │  correlation graph
   │                │                     │                       │                    │  formed, referencing
   │                │                     │                       │                    │  every fact above by
   │                │                     │                       │                    │  its own opaque id
   ▼                ▼                     ▼                       ▼                    ▼
resource.id     decision.correlationId  obligation.id/grant.id  usage.id/revocation.id  EnterpriseEvidenceCorrelation
                                                                                          .resource/.decisionRefs/
                                                                                          .obligationRefs/.grantRefs/
                                                                                          .usageRefs/.revocationRefs
```

`EnterpriseEvidenceCorrelation` is formed **after** the facts it references
already exist -- it never precedes, predicts, or produces any of them. Its
own `correlatedAt` records only when the correlation graph itself was
formed, never when any referenced record occurred (this contract does not
know or assume any referenced record's own timestamp).

## Graph consistency (Phase 6)

Beyond required-field and reference-integrity checks, two purely structural
implications are validated -- never as an existence check against any other
record, only as an internal consistency rule mirroring the R004 line's own
reference relationships:

- **`USAGE_WITHOUT_GRANT`** -- `usageRefs` cannot be populated unless
  `grantRefs` is also populated, mirroring `EnterpriseUsageEvent.grantRef`
  (a usage event always reports usage of a specific grant).
- **`REVOCATION_WITHOUT_GRANT`** -- `revocationRefs` cannot be populated
  unless `grantRefs` is also populated, mirroring
  `EnterpriseGrantRevocation.grantRef` (a revocation always revokes a
  specific grant).

Neither check confirms that the referenced grant record actually exists,
actually corresponds to the referenced usage/revocation record, or is
actually still active -- those are existence and cross-record consistency
questions this contract, by design, cannot and does not answer (see "What
this contract is not").

## Equality semantics (Phase 8)

- `enterpriseEvidenceCorrelationIdentityEquals(a, b)` -- identity equality,
  derived from **correlation identity, resource, and graph composition**
  together (Phase 8's required basis): the same `id`, the same resource
  identity (via `resourceRefIdentityEquals`, already canonical for
  `ResourceRef` in `@aoc-enterprise/resource-envelope`), and the same set of
  `decisionRefs`/`obligationRefs`/`grantRefs`/`usageRefs`/`revocationRefs`
  (compared as sets, not sequences -- reference construction order carries
  no meaning). Two graphs can share identity while disagreeing on every
  other field (e.g. a corrected `description` recorded after the fact).
- `enterpriseEvidenceCorrelationEquals(a, b)` -- full structural equality:
  identity plus `schemaVersion`, `correlatedAt`, `metadata`, `description`,
  and `resource.attributes`. "Do not derive equality from runtime execution"
  (Phase 8) is satisfied structurally: this contract has no
  execution-shaped field to begin with.

## Validation (Phase 6)

- `validateEnterpriseEvidenceCorrelation(candidate)` -- internal-consistency
  validation of a single correlation graph: **required references**
  (`decisionRefs` must be a non-empty array), **duplicate references**
  (no reference array may repeat the same id), **graph consistency**
  (`USAGE_WITHOUT_GRANT`, `REVOCATION_WITHOUT_GRANT` -- see above),
  **timestamp consistency** (`correlatedAt` must be a valid ISO 8601 UTC
  instant), and **reference integrity** (every reference must be a
  well-formed non-empty identifier, never checked for existence). Never
  provider availability, network, storage, authorization, or runtime
  execution validation.
- `validateEnterpriseEvidenceCorrelationSet(correlations)` -- duplicate
  detection across a collection: no two correlation graphs may share the
  same `id`.

## Serialization (Phase 7)

- Every key is written in a fixed order (matching declaration order), so two
  correlation graphs that are `enterpriseEvidenceCorrelationEquals` always
  serialize to byte-identical JSON text.
- `resource.attributes` keys, `metadata` keys, and every reference array
  (`decisionRefs`, `obligationRefs`, `grantRefs`, `usageRefs`,
  `revocationRefs`) are treated as unordered sets and sorted before
  serialization.
- Optional fields that are `undefined` are omitted entirely (never written
  as `null`), so `deserializeEnterpriseEvidenceCorrelation(serializeEnterpriseEvidenceCorrelation(x))`
  round-trips to a graph `enterpriseEvidenceCorrelationEquals` to `x`.
- No field ever carries a provider secret or process-local runtime state --
  every field is a plain string, number, boolean, or plain object/array of
  those, which is what makes round-trip safety possible in the first place.
- Provider-neutral and forward-compatible: nothing in the serialized shape
  names a provider, and a future `schemaVersion` bump is the only path to
  adding a new reference kind or field.

## Future integration path (Phase 12)

No provider adapter, audit engine, compliance module, or SIEM connector is
implemented or assumed by this package. Because every reference field is an
opaque `CanonicalId` array and `metadata` is a provider-neutral primitive
bag, future consumers can be built without this contract changing:

- **Future ProviderAdapters** (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) contribute evidence *indirectly*: they are
  the actual emitters of `EnterpriseUsageEvent` records (see that package's
  README). This contract never talks to a provider adapter directly -- it
  only references the `EnterpriseUsageEvent.id` a provider adapter's own
  usage-observation eventually produces, via `usageRefs`. A provider adapter
  never writes to, or is referenced by name from, this contract.
- **A future Audit service** would read `EnterpriseEvidenceCorrelation`
  records as the index into a resource's full evidentiary trail: given a
  correlation graph, it would fetch and render every record its reference
  arrays point at (the decision(s), obligation(s), grant(s), usage
  event(s), revocation(s)) as one coherent audit trail entry. It would never
  need to reconstruct those relationships itself.
- **A future Compliance module** would use the same graph to answer
  compliance questions that span the lifecycle (e.g. "was every access to
  this resource backed by an evaluated decision?") by walking
  `decisionRefs`/`grantRefs`/`usageRefs` across every correlation graph for
  a resource, without needing to independently re-derive which records
  belong together.
- **A future SIEM connector** would treat each `EnterpriseEvidenceCorrelation`
  as a correlated event bundle to forward or alert on (e.g. "a grant was
  revoked and later usage was still observed against it" -- detectable by a
  SIEM connector correlating two separate graphs' `grantRefs`, never by this
  contract itself, which performs no analysis).

None of this is implemented here. This contract only records which
records belong together and why; every future consumer above decides, in
its own code, what to do with that information.

## Blast radius (Phase 13)

Existing and future code that *could* eventually consume
`EnterpriseEvidenceCorrelation` once audit/compliance/SIEM surfaces and
provider adapters exist -- listed for future sequences, **not migrated by
this change**:

- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would be the eventual producer of the
  `EnterpriseUsageEvent` records this contract's `usageRefs` point at.
- A future Audit surface -- would render correlation graphs as the index
  into a resource's full evidentiary trail.
- A future Compliance surface -- would use correlation graphs to answer
  lifecycle-spanning compliance questions.
- A future Reporting surface -- would summarize correlation graphs by
  resource, decision outcome, or grant status.
- A future Analytics surface -- would aggregate correlation graphs (e.g.
  time-to-grant, time-to-revocation) without this contract performing any
  aggregation itself.
- A future SIEM integration -- would treat correlation graphs as correlated
  event bundles to alert on.
- The Control Plane -- would eventually expose correlation graphs read-only
  to operators, without this contract depending on the Control Plane in any
  way.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/evidence-correlation
npm test --workspace @aoc-enterprise/evidence-correlation
```
