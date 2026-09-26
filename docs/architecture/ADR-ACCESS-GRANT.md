# ADR: Canonical Access Grant (R004.G)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.D (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  R004.E (`ADR-ACCESS-DECISION.md`, `EnterpriseAccessDecision`), R004.F
  (`ADR-POLICY-OBLIGATION.md`, `EnterpriseAccessObligation`)

## Context

R004.E established `EnterpriseAccessDecision` as the canonical Enterprise
record of *the evaluated result* of a request against a resource. R004.F
established `EnterpriseAccessObligation` as the canonical Enterprise record
of a mandatory or optional condition attached to such a decision. Neither is
an authorization a principal actually holds: a decision can be evaluated (and
re-evaluated) any number of times without ever being "held" by anyone, and an
obligation is a description of a condition, not a credential. Access
Governance needs a canonical, immutable record of the third, distinct fact:
that authorization *was issued* -- to whom, for which resource, until when,
referencing which decision and which obligations were resolved first --
without this record becoming a provider token, a JWT, a download URL, an API
credential, a runtime session, or an execution engine.

A full-repository search (mirroring the search R004.F ran for a canonical
obligation type) found:

- **No existing "grant"-shaped type.** `GrantRevocation`, `UsageEvent`,
  `ProviderAdapter`, `EvidenceCorrelation`, and `AccessGrant` itself exist
  only as prose references inside the R004.D/E/F packages' own README/ADR
  files, describing each as a **future, unimplemented** consumer or
  producer. No code defines any of them.
- **No existing "grant status"/"revoked"/"expired" lifecycle enum.** The
  closest analogues -- `EnterpriseResourceLifecycleState` (storage
  existence: `registered`/`active`/`archived`/`deleted`), `PolicyDecision`
  (evaluation outcome: `allow`/`deny`/`conditional`), and
  `EnterprisePolicyDecision` (one orchestration engine's response shape,
  execution-shaped) -- are each scoped to a different concern, the same way
  R004.F's search found no reusable obligation type and instead justified a
  new, minimal vocabulary from that sequence's own evidence.
- **A settled composition precedent for what this contract must reference,
  and how.** `EnterpriseResourceEnvelope`'s own README already commits: *"A
  future `AccessGrant` contract is where approval state, revocation state,
  grantee, and scope will live. It will reference an
  `EnterpriseResourceEnvelope`'s `resource: ResourceRef` for identity."*
  `EnterpriseAccessDecision`'s own README commits similarly: *"It will
  reference an `EnterpriseAccessDecision` (the decision that authorized
  issuing the grant) the same way it will reference an
  `EnterpriseResourceEnvelope`'s `resource` for identity."*
  `EnterpriseAccessObligation`'s own README names the same relationship:
  *"AccessGrant (future) -- interprets mandatory obligations before issuing
  a grant."* All three treat referencing by opaque identity, never
  embedding, as already decided for this sequence.

R004.D, R004.E, and R004.F's conclusions, treated as authoritative for this
sequence:

- Reuse a canonical concept when one exists; do not invent a duplicate
  vocabulary without justification (R004.F Phase 4). No canonical grant
  status vocabulary exists, so this sequence defines the minimum one
  justified by the evidence above.
- Enterprise composes Protocol/Enterprise contracts *by reference* when the
  new type describes something *about* the composed value, and by opaque
  correlation id when the composed value has a different cardinality and
  lifecycle (established by `EnterpriseAccessObligation.decisionRef`).
- A superficially similar, differently-shaped existing type is not
  automatically the canonical one, and is not reused without a documented
  reason it does not fit (established by `EnterpriseAccessDecision` choosing
  `PolicyDecision` over `EnterprisePolicyDecision`, and
  `EnterpriseAccessObligation` choosing to define its own type over
  `CanonicalObligation`/`EnterprisePolicyObligation`/`PolicyObligation`).

## Decision

Create `EnterpriseAccessGrant` in a new package, `@aoc-enterprise/access-grant`
(`packages/access-grant`):

- **References `EnterpriseAccessDecision` by an opaque correlation id**
  (`decisionRef: CanonicalId`, pointing at
  `EnterpriseAccessDecision.correlationId`), never by embedding it. Mirrors
  the reference style `EnterpriseAccessObligation.decisionRef` already
  establishes.
- **References `EnterpriseAccessObligation`s by opaque correlation ids**
  (`obligationRefs?: readonly CanonicalId[]`, pointing at
  `EnterpriseAccessObligation.id` values), never by embedding them.
- **Composes Soberanía Protocol's `ResourceRef` directly** (`resource: ResourceRef`),
  not the full `EnterpriseResourceEnvelope` -- per
  `EnterpriseResourceEnvelope`'s own README commitment (quoted above). A
  grant needs resource identity, never the envelope's storage-lifecycle
  bookkeeping (`location`, `integrity`, `lifecycleState`).
- **Carries `principalId` directly**, not re-derived through `decisionRef`,
  because the decision is composed by reference, not embedding: there is no
  `grant.decision.request.principalId` path to read without dereferencing an
  external record this contract does not have access to. Unlike
  `EnterpriseAccessDecision`'s `request.resource`/`resource.resource`
  pairing (both present in the same object, enabling a
  `RESOURCE_IDENTITY_MISMATCH` check), no analogous check is possible or
  implemented here -- see "Explicit non-responsibilities."
- **Defines a new, minimal, two-state `EnterpriseAccessGrantStatus`
  vocabulary**: `'active' | 'revoked'`. No canonical lifecycle enum exists to
  reuse (see "Context"); `'expired'` is deliberately excluded (see "Why
  `status` excludes `'expired'`" below); no third state (`'suspended'`,
  `'pending'`) is included, per Phase 4's "avoid unnecessary states."
- **Represents expiration exclusively via `issuedAt`/`expiresAt`
  timestamps**, both required. Validates only that both are well-formed and
  that `expiresAt` is strictly after `issuedAt` -- a comparison between two
  values on the same candidate, never against the current time. No timer, no
  scheduled job, no expiration-execution logic.
- **Does not include renewal metadata.** Phase 5 permits it "if justified by
  repository evidence"; the search above found none, so none was added, the
  same restraint `EnterpriseAccessObligation`'s README documents for why its
  own fields are limited to what evidence supports.
- **Is purely descriptive and non-executable.** No persistence, no service,
  no API, no policy engine, no execution, no provider SDK, no provider
  credential, no JWT, no OAuth token, no signed URL, no runtime session, no
  approval workflow runtime, no adapter.
- **Validates only internal consistency**: required fields, timestamp
  format, expiration order, and duplicate/invalid reference shapes
  (`obligationRefs`, `auditRefs`). Never provider validation, network
  validation, existence checks against `decisionRef`/`obligationRefs`, user
  permission checks, policy-correctness evaluation, or wall-clock
  comparison.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted reference sets, undefined fields omitted rather than written
  as `null`).
- **Provides identity equality derived from exactly four things**: grant
  identity (`id`), the issued decision (`decisionRef`), the principal
  (`principalId`), and the resource (via `resourceRefIdentityEquals`) --
  Phase 8's required basis -- and full structural equality extending it to
  every remaining declarative field.

## Why `status` excludes `'expired'`

Expiration is fully represented by `issuedAt`/`expiresAt`. A status-derived
`'expired'` value would be a second, independently-settable source of truth
for the same fact, with no mechanical way for `validateEnterpriseAccessGrant`
-- a pure function with no "current time" input -- to keep the two
consistent (unlike `EnterpriseResourceEnvelope`'s
`location.systemReference`-requires-`location.system` check, which compares
two fields already present on the same candidate, no clock required).
Determining whether an `'active'` grant has lapsed past `expiresAt` is a
comparison against the current time, which this immutable, non-executing
contract does not perform -- consistent with the non-negotiable rule against
implementing expiration execution.

## Why `status` includes `'revoked'` despite `GrantRevocation` being future work

Phase 13 of this sequence explicitly names `GrantRevocation` as a future
consumer of this contract. `EnterpriseAccessGrant` does not implement or
assume `GrantRevocation`'s shape, and does not implement the revocation
transition itself -- but its `status` vocabulary must be able to represent
the state a `GrantRevocation` event causes, the same way
`EnterpriseResourceEnvelope.lifecycleState` already establishes the pattern
of "each value is an immutable snapshot; the field can differ between
snapshots of the same id over time; producing the next snapshot is a future
persistence layer's job." Naming this in `status` now, without implementing
the transition, avoids a breaking `schemaVersion` change once
`GrantRevocation` is built.

## New contract responsibilities

- Represent grant identity (`id`), grant status (`status`), the governed
  resource (`resource: ResourceRef`), the authorizing decision
  (`decisionRef`), the resolved obligations (`obligationRefs?`), the
  principal the grant was issued to (`principalId`), issuance and expiration
  timestamps (`issuedAt`, `expiresAt`), an issuance-event correlation
  identifier (`correlationId`), an optional issuer reference (`issuerRef?`),
  and optional audit trail references (`auditRefs?`).
- Validate its own internal consistency (required fields, timestamp format,
  expiration order, duplicate/invalid reference shapes) and (de)serialize
  deterministically.

## Explicit non-responsibilities

Enforced at compile time (`@ts-expect-error`) -- see
`__tests__/enterprise-access-grant.test.ts`:

- a JWT, an OAuth access/refresh token
- a download URL, a signed URL, an Azure SAS token
- an API key, a provider credential
- a Pinata SDK, S3 client, Azure Blob client, or any other provider SDK
  instance
- a runtime session id, a cookie
- an execution/run callback
- approval workflow runtime state
- a policy engine or rule set
- a duplicated decision outcome
- a scheduled expiration timer or job
- provider/network/existence validation and wall-clock comparison
  (excluded from `validateEnterpriseAccessGrant` by design, not by omission)

## Future integration path

```text
access-decision              access-obligation             @aoc/protocol
EnterpriseAccessDecision      EnterpriseAccessObligation     ResourceRef
        │ by correlationId            │ by id                       │ by reference
        ▼                              ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ access-grant                                                              │
│ EnterpriseAccessGrant                                                     │
│   id | status | resource | decisionRef | principalId | issuedAt |         │
│   expiresAt | correlationId | issuerRef? | obligationRefs? | auditRefs?   │
└──────┬─────────────┬─────────────┬─────────────┬────────────────────────┘
       │ future        │ future      │ future        │ future
       ▼               ▼             ▼               ▼
 GrantRevocation   UsageEvent   EvidenceCorrelation   Provider Adapter
 (moves status      (records     (correlates          (Pinata / S3 /
  to 'revoked')       actual       auditRefs to          Azure Blob /
                       access)      evidence)             Google Drive /
                                                            SharePoint)
```

**No adapter, revocation, usage-event, evidence-correlation, or audit
contract is implemented as part of this change.**

## Tests

`packages/access-grant/__tests__/enterprise-access-grant.test.ts`:

- Positive: construction (full and minimal), composition (no embedded
  `EnterpriseAccessDecision`/`EnterpriseAccessObligation` fields; `resource`
  composes a bare `ResourceRef`, never an `EnterpriseResourceEnvelope`
  field), identity and structural equality, validation (accepting valid
  shapes, every canonical status), serialization determinism, and
  round-trip (de)serialization.
- Negative: rejecting missing/invalid required fields, an out-of-vocabulary
  `status`, malformed timestamps, `expiresAt` at or before `issuedAt`,
  empty/duplicate/non-string reference arrays; plus compile-time
  `@ts-expect-error` proofs that the contract cannot carry a JWT, an OAuth
  token, a download/signed URL, an Azure SAS token, an API key, a
  credential, a Pinata/S3/Azure SDK client, a session id, a cookie, an
  execution callback, approval workflow state, a policy engine, a
  duplicated decision outcome, or a scheduled expiration timer; plus that
  fields are immutable (`readonly`, no reassignment).

## Compatibility

- No change to `@aoc/protocol`, `ResourceRef`, `EnterpriseResourceEnvelope`,
  `EnterpriseAccessDecision`, or `EnterpriseAccessObligation`.
- New workspace package (`packages/access-grant`), added to the root
  `tsconfig.json` project references so `npm run build`/`typecheck` cover
  it, the same way `packages/access-decision` and
  `packages/access-obligation` are.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), matching the
  precedent set by `packages/resource-envelope`, `packages/access-decision`,
  and `packages/access-obligation`.

## Blast radius

Existing and future code that *could* eventually adopt
`EnterpriseAccessGrant` once a revocation model, usage tracking, evidence
correlation, and provider adapters exist -- listed for future sequences,
**not migrated by this change**:

- A future `GrantRevocation` contract -- will reference this grant's `id`
  and cause future snapshots of it to hold `status: 'revoked'`.
- A future `UsageEvent` contract -- will correlate observed access back to
  this grant's `id` and `correlationId`.
- A future `EvidenceCorrelation` contract -- the natural consumer of
  `auditRefs?`; today no such contract exists.
- Any future Provider Adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would translate an `'active'`,
  unexpired `EnterpriseAccessGrant` into provider-specific execution (a
  presigned URL, a scoped SDK call, a SAS token), using `resource`,
  `status`, and `expiresAt` as its only inputs from this contract.
- `packages/access-decision` -- `EnterpriseAccessDecision.correlationId` is
  the value a future issuance process would use to populate
  `EnterpriseAccessGrant.decisionRef`; today the two are not wired together.
- `packages/access-obligation` -- `EnterpriseAccessObligation.id` values are
  the natural population source for `EnterpriseAccessGrant.obligationRefs`;
  today the two are not wired together.

## Validation

Commands run against this change:

- `npm install` (workspace symlinks; `@aoc-enterprise/access-grant` depends
  on `@aoc-enterprise/resource-envelope` for `resourceRefIdentityEquals`)
- `npm run build --workspace @aoc-enterprise/access-grant`
- `npm run typecheck` (root `tsc -b`, includes `packages/access-grant` via
  the new `tsconfig.json` reference)
- `npm run build` (root)
- `npm test --workspace @aoc-enterprise/access-grant`
- `npm test` (root, includes every workspace package via
  `npm test --workspaces --if-present`)
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run validate:publishability`

See the PR description for exact command output.

## Non-goals (out of scope for R004.G)

- No provider, adapter, JWT, OAuth, API key, or signed URL is implemented.
- No runtime session or execution engine is implemented.
- No persistence, API, service, repository, or UI is added.
- No `GrantRevocation`, `UsageEvent`, `EvidenceCorrelation`, or Provider
  Adapter contract is implemented.
- No existing consumer is migrated to this contract.
