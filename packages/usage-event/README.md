# @aoc-enterprise/usage-event

The canonical Enterprise-owned contract for **the immutable record that a
previously-issued Access Grant was exercised**: `EnterpriseUsageEvent`. It
references `EnterpriseAccessGrant` (`@aoc-enterprise/access-grant`, R004.G)
by an opaque grant identifier (`grantRef: CanonicalId`) -- it never embeds,
duplicates, or extends it.

This package is a pure data contract: no persistence, no service, no API, no
provider adapter, no download URL, no signed URL, no JWT/OAuth state, no
provider credential, no runtime session, no execution engine, no
enforcement, no authorization decision, no policy evaluation.

## Purpose

`EnterpriseAccessGrant` answers *"what authorization was issued?"* -- an
immutable record produced once, at issuance. It records that authorization
exists (or once did); it is not a log of activity, and it does not grow or
change shape every time a principal exercises it. Something needs to record,
immutably and repeatably, *that* a grant was exercised -- who, what, when,
using which grant, against which resource -- without becoming the mechanism
that carries the access out (a provider's own API call, a rendered page, a
streamed byte range). `EnterpriseUsageEvent` is that record. It answers
*"what actually happened, using an authorization that already exists?"*

`EnterpriseUsageEvent` is the terminal, observation-only layer of the R004
composition line:

```text
EnterpriseResourceEnvelope  "what resource, in what storage state?"
        │
        ▼
EnterpriseAccessDecision    "should access occur?"
        │
        ├──▶ EnterpriseAccessObligation   "under what mandatory conditions?"
        │
        ▼
EnterpriseAccessGrant        "what authorization was issued?"
        │
        ├──▶ EnterpriseGrantRevocation    "when/why did that authorization end?"
        │
        ▼
EnterpriseUsageEvent (this package)  "what happened, using that authorization?"
```

Every layer above `EnterpriseUsageEvent` answers a question about
*authorization*. `EnterpriseUsageEvent` alone answers a question about
*observed fact*: it never re-decides, re-evaluates, or re-authorizes
anything a decision, obligation, or grant already settled.

## What this contract is not

- It does not decide whether access is (or was) allowed -- that is
  `EnterpriseAccessDecision`'s fact, never re-derived or re-evaluated here.
- It does not evaluate or enforce policy or obligations.
- It does not issue, hold, or interpret a grant.
- It does not contact providers (Pinata, S3, Azure Blob, Google Drive,
  SharePoint, or any other).
- It does not carry a provider URL, download link, signed URL, JWT, OAuth
  token, API key, or provider credential.
- It does not carry a provider's own success/failure status (an HTTP status
  code, an SDK error object, a `success: boolean` field) -- see "Explicit
  non-responsibilities" below.
- It does not execute, schedule, or run anything.

It records the immutable fact that a grant was exercised, in what observed
category, when, and by/against whom; it never carries that usage out, never
judges whether it should have been permitted, and never reports how a
provider's own operation resolved.

## Ownership

- **The grant this record reports usage of** is referenced, not owned, via
  `grantRef: CanonicalId` -- an opaque pointer to `EnterpriseAccessGrant`'s
  own `id`. This package never duplicates any grant field (`resource`,
  `status`, `issuedAt`, `expiresAt`, `decisionRef`, `obligationRefs`, ...).
- **Everything on `EnterpriseUsageEvent`** -- `id`, `eventType`, `resource`,
  `principalId`, `occurredAt`, `correlationId`, `metadata?`,
  `evidenceRefs?`, `description?` -- is owned by Frontera Systems
  (`@aoc-enterprise/usage-event`).

## Why composition by reference, not embedding

`EnterpriseAccessGrant` (`@aoc-enterprise/access-grant`, R004.G) already
exists in this repository -- unlike the situation R004.H
(`@aoc-enterprise/grant-revocation`) faced, where no grant contract existed
yet. This package still composes with it **by an opaque reference**
(`grantRef: CanonicalId`), never by importing or embedding its shape,
because a usage event is not "a grant with extra properties," and because
the reference style is already this Enterprise contract line's established
precedent for exactly this relationship
(`EnterpriseGrantRevocation.grantRef`; `EnterpriseAccessObligation.decisionRef`;
`EnterpriseAccessGrant.decisionRef`):

```ts
interface EnterpriseUsageEvent {
  readonly grantRef: CanonicalId; // points at EnterpriseAccessGrant.id
  // ... id, eventType, resource, principalId, occurredAt, correlationId,
  //     metadata?, evidenceRefs?, description?
}
```

A usage event is not "a grant with a usage counter" for two reasons that
mirror `EnterpriseGrantRevocation`'s own rationale for not folding into
`EnterpriseAccessGrant.status`:

- **Different cardinality.** A grant is issued once. A grant is *used* an
  unbounded number of times -- zero, one, or many. Modeling usage as a field
  on the grant would force the grant to grow, mutate, or fan out into a
  collection every time it is exercised, breaking `EnterpriseAccessGrant`'s
  own immutable, issued-once shape (see that package's README).
- **Different lifecycle and owner.** A grant is issued by whatever issues
  grants (an approval engine, a policy runtime). A usage event is recorded
  by whatever observes usage (a future Provider Adapter, an enforcement
  layer) -- a distinct actor, at a distinct, repeatable moment, that never
  needs write access to the grant record itself.

`resource: ResourceRef` and `principalId: CanonicalId` are carried directly
on `EnterpriseUsageEvent` rather than re-derived by dereferencing `grantRef`
-- the same rationale `EnterpriseAccessGrant.principalId` and
`EnterpriseAccessGrant.resource` already document: this contract composes
the grant by reference, not by embedding, so a usage event must be
reasoned about -- filtered, displayed, audited -- without requiring access
to the grant record it points to.

## Vocabulary search (Phase 4)

Before defining `EnterpriseUsageEventType`, this repository was searched for
an existing canonical usage/activity-event vocabulary to reuse:

- `EnterpriseEventType` (`src/enterprise/events/enterprise-events.ts`) --
  the Enterprise Host's own *operational/integration* event catalog
  (`'GovernanceEvaluationRequested'`, `'GovernanceRecordCommitted'`, ...).
  These describe the hosting of a *governance evaluation*, not usage of an
  *issued grant* -- a different concept at a different layer (the Kernel
  neither emits nor knows about them, per that file's own documentation).
  Not reused, but its PascalCase event-name convention is: see "Event-type
  naming" below.
- `AssuranceEnterpriseEventType` (same file) -- Assurance-runtime
  operational events (`'AssuranceAssessmentCreated'`, ...). Same reasoning:
  a distinct concept (assurance-assessment lifecycle), not grant usage.
- No `UsageEvent`, `AccessEvent`, or `ActivityEvent`-shaped canonical type
  exists anywhere else in the repository (searched across `src/`,
  `packages/`, `docs/`).

No existing vocabulary fits; `EnterpriseUsageEventType` is therefore a new,
minimum-required vocabulary, not a reuse -- exactly this sequence's own
Phase 4 "Expected examples" list, reproduced verbatim rather than invented:

| Value | Meaning |
| --- | --- |
| `AccessAttempted` | A principal attempted to exercise the grant. |
| `AccessStarted` | An attempted access began. |
| `AccessCompleted` | An access ran to completion. |
| `AccessDenied` | An attempted access did not proceed. |
| `AccessExpired` | An attempted access lapsed against the grant's own validity. |
| `AccessFailed` | An attempted access did not complete. |
| `GrantConsumed` | The grant was exercised in a way not shaped as content access (e.g. an API-scoped grant invoked programmatically). |
| `ContentViewed` | Governed content was viewed. |
| `ContentDownloaded` | Governed content was downloaded. |
| `ContentStreamed` | Governed content was streamed. |

Each is a *category describing what was observed*, never a judgment this
record made itself. `'AccessDenied'` records that an observed attempt did
not proceed -- it is not this contract re-running `EnterpriseAccessDecision`'s
evaluation, and it carries no reason code or policy citation (that belongs
to whatever decision or enforcement record produced the denial).
`'AccessFailed'` records that an attempted access did not complete -- it is
not a provider status code, HTTP response, or SDK error object (see
"Explicit non-responsibilities"). No provider-specific event (e.g.
`pinata-pin-succeeded`, `s3-get-object-200`) is introduced (non-negotiable
rule). A future category is a `schemaVersion` change, not an open string --
this is deliberately a closed union, mirroring every other closed
vocabulary in this Enterprise contract line.

### Event-type naming

`EnterpriseUsageEventType` values are PascalCase (`'AccessAttempted'`,
`'ContentViewed'`), not the kebab-case this repository's other
*category*-shaped vocabularies use (`EnterpriseAccessObligationType`:
`'require-approval'`; `EnterpriseGrantRevocationReason`:
`'administrator-revoked'`). This is deliberate, not an inconsistency: it
matches this repository's own precedent for *event-name*-shaped vocabularies
specifically -- `EnterpriseEventType` already uses PascalCase event names
(`'GovernanceEvaluationRequested'`) -- and it reproduces this sequence's own
Phase 4 examples verbatim rather than re-casing them into a style this
sequence's evidence never specified.

## Explicit non-responsibilities

`EnterpriseUsageEvent` never carries, and by design cannot carry (enforced
at compile time via `@ts-expect-error` -- see
`__tests__/enterprise-usage-event.test.ts`):

- provider URLs, download links, signed URLs
- JWTs, OAuth tokens/state
- API keys, provider credentials
- Pinata-shaped, S3-shaped, Azure-shaped, or any other provider SDK client
- network/HTTP clients
- runtime callbacks
- session identifiers, cache keys
- **an `allowed` field** -- whether access was permitted is
  `EnterpriseAccessDecision`'s/`EnterpriseAccessGrant`'s fact; this contract
  never re-decides it.
- **an `enforced` field** -- whether an obligation was carried out belongs
  to a future enforcement layer, never this immutable observation.
- **a `success`/`httpStatus`/provider-response field** -- "was it successful
  from the provider's perspective?" is explicitly out of scope (Phase 5);
  only a provider-neutral `eventType` category is recorded, never a
  provider's own status code or SDK result object.
- **a `policyEvaluationRef` field** -- policy evaluation is
  `EnterpriseAccessDecision`'s responsibility; this contract references only
  the grant (`grantRef`), never the decision that authorized it.
- grant fields (`status`, `decisionRef`, `issuedAt`, `expiresAt`,
  `issuerRef`, `obligationRefs`, `auditRefs`, ...) -- these belong to
  `EnterpriseAccessGrant`, never duplicated or embedded here.

## Relationship diagram

```text
┌────────────────────────────────────────────────────────────────────────┐
│ EnterpriseAccessDecision / EnterpriseAccessObligation (existing)          │
│   "should access occur, and under what conditions?"                        │
└──────────────────────────────┬─────────────────────────────────────────┘
                                 │ referenced by decisionRef/obligationRefs
                                 ▼
                      ┌────────────────────────┐
                      │ EnterpriseAccessGrant     │  (existing, R004.G)
                      │ "what authorization         │
                      │  was issued?"                 │
                      └────────────┬────────────────┘
                                    │ referenced by grantRef
                                    │ (never embedded)
                    ┌───────────────┴────────────────┐
                    ▼                                  ▼
       ┌─────────────────────────┐        ┌──────────────────────────────┐
       │ EnterpriseGrantRevocation │        │ @aoc-enterprise/usage-event    │
       │ "when/why did that          │        │                                  │
       │  authorization end?"          │        │ EnterpriseUsageEvent              │
       │ (existing, R004.H)              │        │   id | eventType | grantRef |      │
       └─────────────────────────┘        │   resource | principalId |          │
                                            │   occurredAt | correlationId |      │
                                            │   metadata? | evidenceRefs? |       │
                                            │   description?                       │
                                            │                                        │
                                            │ "what happened, using that              │
                                            │  authorization?"                          │
                                            └───────────┬──────────────┬────────────┘
                                                          │ future        │ future
                                                          ▼                ▼
                                                 EvidenceCorrelation   Audit / Compliance
                                                 (ties usage into      / Analytics /
                                                  the wider audit      Monitoring / SIEM
                                                  trail via
                                                  correlationId)
```

## Sequence diagram: grant issuance to observed usage

```text
Approval engine      EnterpriseAccessGrant     Principal        Provider Adapter        EnterpriseUsageEvent    Future consumers
(or policy runtime)      (existing)          (grant holder)     (future -- not          (this package)        (EvidenceCorrelation,
                                                                  implemented here)                              Audit, Analytics, ...)
      │                      │                     │                     │                       │                      │
      │  grant issued        │                     │                     │                       │                      │
      │─────────────────────▶│                     │                     │                       │                      │
      │                      │  grant is active,    │                     │                       │                      │
      │                      │  held by principal    │                     │                       │                      │
      │                      │                     │                     │                       │                      │
      │                      │                     │  request access      │                       │                      │
      │                      │                     │  (using the grant)     │                       │                      │
      │                      │                     │──────────────────────▶│                       │                      │
      │                      │                     │                     │  observes the usage      │                      │
      │                      │                     │                     │  (view/download/stream/  │                      │
      │                      │                     │                     │   attempt/deny/expire/    │                      │
      │                      │                     │                     │   fail/consume)             │                      │
      │                      │                     │                     │  emits a usage event         │                      │
      │                      │                     │                     │  (grantRef = grant.id)         │                      │
      │                      │                     │                     │──────────────────────────────▶│                      │
      │                      │                     │                     │                       │  EnterpriseUsageEvent    │
      │                      │                     │                     │                       │  is now the immutable     │
      │                      │                     │                     │                       │  business record that       │
      │                      │                     │                     │                       │  this usage occurred          │
      │                      │                     │                     │                       │                            │
      │                      │                     │                     │                       │  (repeats for every future │
      │                      │                     │                     │                       │   observed usage of this     │
      │                      │                     │                     │                       │   same grant)                   │
      │                      │                     │                     │                       │──────────────────────────────▶│
      │                      │                     │                     │                       │                      │  future consumers
      │                      │                     │                     │                       │                      │  read this record
      │                      │                     │                     │                       │                      │  and act in their
      │                      │                     │                     │                       │                      │  own domain
```

**No step after "emits a usage event" is implemented by this package.**
Everything below `EnterpriseUsageEvent` in both diagrams is a future
consumer's responsibility, not this contract's. The Provider Adapter that
emits usage events is likewise a future, unimplemented consumer of this
contract -- see "Future integration path" below.

## Future integration path

No provider adapter, enforcement layer, or analytics engine is implemented
or assumed by this package. Because `eventType` is a closed,
provider-neutral vocabulary, `grantRef`/`evidenceRefs` are opaque
`CanonicalId`s, and `metadata` is a provider-neutral primitive bag, a future
adapter can emit usage events without this contract changing:

- A **Pinata adapter** serving a gateway request for an IPFS-pinned object
  would emit `eventType: 'ContentDownloaded'` (or `'ContentStreamed'` for a
  range request) the moment it observes the request -- using its own SDK,
  never referenced by this contract.
- An **S3 adapter** handling a presigned-URL `GetObject` request would emit
  `eventType: 'ContentDownloaded'`; a failed request (network error, object
  missing) would emit `eventType: 'AccessFailed'` -- never the S3 SDK's own
  error object or HTTP status code (see "Explicit non-responsibilities").
- An **Azure Blob adapter** would emit `eventType: 'ContentStreamed'` for a
  streamed blob read, or `eventType: 'AccessDenied'` if its own SAS-token
  check (independent of this contract) rejected the request at the point of
  use.
- A **Google Drive adapter** would emit `eventType: 'ContentViewed'` for an
  in-browser preview, or `eventType: 'AccessExpired'` if the underlying
  grant's validity window had lapsed by the time of the request.
- A **SharePoint adapter** would emit `eventType: 'GrantConsumed'` for a
  programmatic, non-content-shaped API call made under the grant.

None of this is implemented here. This contract only records that a usage
occurred, in what category, when, and against which grant/resource/principal
-- a future adapter decides, in its own provider-specific code, when and how
to observe and emit that record.

## Equality semantics

- `enterpriseUsageEventIdentityEquals(a, b)` -- identity equality, derived
  from `id`, `occurredAt`, `grantRef`, and `eventType` together (Phase 8's
  required basis: "event identity, timestamp, grant reference, event
  type"), the same compound-identity pattern
  `enterpriseGrantRevocationIdentityEquals`/`enterpriseAccessDecisionIdentityEquals`
  already establish rather than a bare single field. Deliberately excludes
  `resource` and `principalId` -- not because they are unimportant, but
  because Phase 8 specifies exactly these four fields as this contract's
  identity basis; `resource`/`principalId` still participate in full
  structural equality below.
- `enterpriseUsageEventEquals(a, b)` -- full structural equality: identity
  plus `resource` (via `resourceRefIdentityEquals`, already canonical for
  `ResourceRef` in `@aoc-enterprise/resource-envelope`, plus
  `resource.attributes`), `principalId`, `correlationId`, `metadata`,
  `evidenceRefs`, `description`, and `schemaVersion`. "Do not derive
  equality from runtime execution" (Phase 8) is satisfied structurally: this
  contract has no execution-shaped field to begin with.

## Validation

- `validateEnterpriseUsageEvent(candidate)` -- internal-consistency
  validation of a single usage event: required fields, reference-field
  shape ("reference integrity" -- `grantRef`/`evidenceRefs` must be
  well-formed non-empty identifiers, never whether the referenced grant or
  evidence record actually exists), timestamp well-formedness ("timestamp
  consistency" -- `occurredAt` must be a valid ISO 8601 UTC instant, never
  compared against a grant's own `issuedAt`/`expiresAt` window, which this
  contract does not know or assume the shape of), event-type-vocabulary
  membership, and `metadata` shape/key-safety (JSON primitives only; no key
  resembling a credential, token, or URL, mirroring
  `EnterpriseAccessObligation.parameters`'s identical guard). Never
  provider, resource-existence, network, policy-correctness, or
  authorization-decision validation.
- `validateEnterpriseUsageEventSet(events)` -- duplicate detection across a
  collection ("duplicate detection"): no two events may share an `id`.
  Deliberately does **not** also forbid two events from sharing the same
  `grantRef` -- unlike `EnterpriseGrantRevocation` (a grant is revoked at
  most once), a single grant is expected to be exercised, and observed, many
  times; that repeatability is the entire reason this contract exists as a
  per-event record rather than a mutable field on the grant. Deliberately a
  separate function from `validateEnterpriseUsageEvent`: "duplicate" is a
  property of a collection, not of any single event.

## Blast radius

Existing and future code that *could* eventually consume
`EnterpriseUsageEvent` once provider adapters and audit/analytics surfaces
exist -- listed for future sequences, **not migrated by this change**:

- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would be the actual emitter of usage
  events, observing real access attempts against its own provider.
- A future evidence-correlation contract -- would tie `correlationId` and
  `evidenceRefs` into a wider audit trail alongside `EnterpriseAccessDecision`,
  `EnterpriseAccessObligation`, `EnterpriseAccessGrant`, and
  `EnterpriseGrantRevocation` records.
- A future audit/compliance surface -- would render usage events (who, what,
  when, under which grant) as part of an immutable audit trail.
- A future analytics surface -- would aggregate usage events by `eventType`,
  `resource`, or `principalId` (e.g. content-view counts, download volume)
  without this contract itself performing any aggregation.
- A future monitoring/SIEM integration -- would alert on `eventType:
  'AccessDenied'` or `'AccessFailed'` volume, or correlate usage patterns
  across principals.
- A future consumer reading `EnterpriseGrantRevocation` -- would stop
  attributing new usage events to a `grantRef` once a matching revocation
  record exists for it (a consumer-side behavior; `EnterpriseUsageEvent`
  itself carries no revocation-awareness field).

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/usage-event
npm test --workspace @aoc-enterprise/usage-event
```
