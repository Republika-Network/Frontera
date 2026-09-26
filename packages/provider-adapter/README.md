# @aoc-enterprise/provider-adapter

The canonical, provider-neutral **Provider Adapter contract** (R005.A). This
package defines only the architectural contract every future Provider
Adapter implementation must satisfy to participate in the frozen Access
Governance lifecycle (`docs/architecture/ADR-ACCESS-LIFECYCLE.md`, R005.0).

**This is not a Pinata adapter. It is not an S3 adapter. It is not an Azure
adapter. It is not a Google Drive or SharePoint adapter.** No provider SDK,
HTTP client, credential, or execution logic exists anywhere in this package.

## Purpose

R005.0 froze seven immutable, provider-neutral Enterprise contracts
(`EnterpriseResourceEnvelope` → `EnterpriseAccessDecision` →
`EnterpriseAccessObligation` → `EnterpriseAccessGrant` → [Provider
Translation → Provider Execution] → `EnterpriseUsageEvent` →
`EnterpriseEvidenceCorrelation`, with `EnterpriseGrantRevocation` alongside
`EnterpriseAccessGrant`) and named exactly one gap in that frozen lifecycle:
"Provider Translation → Provider Execution" is real, necessary, and
completely unimplemented. A Provider Adapter is whatever, in the future,
fills that gap for one real provider (Pinata, S3, Azure Blob, Google Drive,
SharePoint, ...).

This package does not fill that gap. It defines the **contract** every
future filler must satisfy: the shape of what an adapter declares about
itself, the shape of what it may read from Enterprise's frozen contracts,
and the shape of what it may report back. A Provider Adapter exists **only**
to translate immutable Enterprise artifacts into provider-specific
execution — it must never become part of the Enterprise domain.

## Responsibilities

Per R005.0 ADR Phase 5 ("Provider Contract Requirements"), a Provider
Adapter is responsible for:

| Responsibility | What this package provides for it |
| --- | --- |
| **Grant translation** | `EnterpriseGrantTranslationInput` / `toEnterpriseGrantTranslationInput` — the exact, compile-time-enforced read view of `EnterpriseAccessGrant` (`resource`, `status`, `expiresAt`) a translation may consume. |
| **Grant expiration** | `EnterpriseProviderCapability.SupportsExpiration` — a capability an adapter declares to record that it performs the `expiresAt`-vs-wall-clock comparison itself; `ENTERPRISE_PROVIDER_FAILURE_REASONS.GRANT_EXPIRED` — the failure category for when that comparison fails a translation. |
| **Revocation interpretation** | `EnterpriseGrantRevocationInterpretationInput` / `toEnterpriseGrantRevocationInterpretationInput` — the exact read view of `EnterpriseGrantRevocation` (`grantRef`, `reason`) a revocation interpretation may consume. |
| **Usage reporting** | Not re-modeled here — a Provider Adapter is the emitter of `EnterpriseUsageEvent` (`@aoc-enterprise/usage-event`) directly; `EnterpriseProviderCapability.SupportsUsageReporting` records that an adapter can do so. |
| **Capability declaration** | `EnterpriseProviderCapability` / `EnterpriseProviderCapabilityDeclaration` — the closed vocabulary and immutable record this whole package exists to define (R005.0 ADR Phase 10, Observation 3). |
| **Provider metadata** | Not re-modeled here — provider-specific location metadata already has a home, `EnterpriseResourceEnvelope.location` (`@aoc-enterprise/resource-envelope`); this package never adds a second one. |
| **Provider identifier translation** | `EnterpriseProviderCapabilityDeclaration.providerSystem` — a free-text identifier mirroring `EnterpriseResourceEnvelope.location.system` verbatim. |
| **Provider failure reporting** | `EnterpriseProviderFailureReason` / `mapEnterpriseProviderFailureToUsageEventType` — the closed failure vocabulary and its pure mapping onto the frozen `EnterpriseUsageEventType` vocabulary. |

## Explicit non-responsibilities

A Provider Adapter — and everything in this package — never:

- evaluates policy
- grants authorization
- creates an `EnterpriseAccessDecision`
- modifies an `EnterpriseAccessGrant`, an `EnterpriseAccessObligation`, or
  `EnterpriseEvidenceCorrelation`
- performs auditing
- executes governance
- owns the Enterprise lifecycle

And, mirroring every one of the seven frozen R004 contracts, this package
contains, and by design cannot contain (enforced at compile time via
`@ts-expect-error` — see `__tests__/enterprise-provider-adapter.test.ts`):

- a provider SDK client (Pinata, S3, Azure Blob, Google Drive, SharePoint,
  or any other)
- an HTTP client
- a provider credential or API key
- a signed or temporary URL
- persistence of any kind
- retry logic
- telemetry or logging
- a runtime execution/callback engine
- a policy evaluation or decision field

If a future change to this package starts to accumulate any of the above,
that is architectural drift, not an incremental improvement — see "Most
important rule" below.

## What this package defines

### 1. Capability model

`EnterpriseProviderCapability` is a closed, eight-value vocabulary
(`SupportsTemporaryAccess`, `SupportsGrantRevocation`,
`SupportsUsageReporting`, `SupportsProviderMetadata`,
`SupportsCapabilityDiscovery`, `SupportsExpiration`, `SupportsCorrelation`,
`SupportsEvidenceContribution`) describing **behavior only** — no provider
name, SDK type, or credential ever appears in it, and none ever will (a new
category is a `schemaVersion` change to this package, never an escape
hatch).

`EnterpriseProviderCapabilityDeclaration` is the immutable record an adapter
uses to declare, once, which of those categories it supports, which
`EnterpriseAccessObligationType` values (`@aoc-enterprise/access-obligation`)
it can actually enforce, and which provider system (`providerSystem`, a
free-text identifier mirroring `EnterpriseResourceEnvelope.location.system`)
it describes. This directly fills the gap R005.0 ADR Phase 10 (Observation
3) named: "A future Provider Adapter sequence must design where 'which
obligation types can this adapter actually enforce' is declared."

It carries the same ceremony every frozen contract in this line does:
`validateEnterpriseProviderCapabilityDeclaration` (internal consistency),
`validateEnterpriseProviderCapabilityDeclarationSet` (duplicate `id`
detection across a collection),
`enterpriseProviderCapabilityDeclarationIdentityEquals` /
`enterpriseProviderCapabilityDeclarationEquals` (identity vs. full
structural equality), and `serializeEnterpriseProviderCapabilityDeclaration`
/ `deserializeEnterpriseProviderCapabilityDeclaration` (deterministic,
round-trip-safe (de)serialization).

Two pure lookup helpers —
`enterpriseProviderCapabilityDeclarationHasCapability` and
`enterpriseProviderCapabilityDeclarationSupportsObligation` — let a caller
ask "does this adapter support X?" without contacting anything: both are
total, synchronous functions over already-declared data.

### 2. Translation model

R005.0 ADR Phase 4 draws the Provider boundary precisely: *"`EnterpriseAccessGrant`
(`resource`, `status`, `expiresAt`) is the ONLY input a Provider Adapter
reads from Enterprise's owned contracts."* `EnterpriseGrantTranslationInput`
is a `Pick<EnterpriseAccessGrant, 'resource' | 'status' | 'expiresAt'>` —
not a redefinition, so it can never drift from `EnterpriseAccessGrant`'s own
field types — and `toEnterpriseGrantTranslationInput` is the pure, total
projection function that narrows a full grant down to exactly those fields.
This turns R005.0's prose boundary into a compile-time-enforced one: code
that reads `principalId`, `decisionRef`, or any other grant field from an
`EnterpriseGrantTranslationInput` simply does not type-check.

The same pattern applies to revocation interpretation:
`EnterpriseGrantRevocationInterpretationInput` is `Pick<EnterpriseGrantRevocation,
'grantRef' | 'reason'>`, and `toEnterpriseGrantRevocationInterpretationInput`
projects down to it, matching R005.0 ADR Phase 5: *"The adapter reads
`EnterpriseGrantRevocation.reason` ... and decides what, if anything, to do
on the provider's own side."*

```text
 EnterpriseAccessGrant                Provider Translation        Provider Execution
 (frozen, R004.G)                     (this package's read         (not modeled --
                                        boundary only)               provider-specific)
   resource ─────────────┐
   status ────────────────┼──► EnterpriseGrantTranslationInput ──► (opaque to this
   expiresAt ─────────────┘         { resource, status,              package: a
   id            (never read)         expiresAt }                    presigned URL, a
   decisionRef   (never read)                                        SAS token, a
   principalId   (never read)                                        scoped SDK call --
   issuedAt      (never read)                                        each provider's
   correlationId (never read)                                        own choice)
   issuerRef?    (never read)
   obligationRefs? (never read)
   auditRefs?    (never read)
```

**No translation *output* type is defined.** A presigned URL, a SAS token, a
scoped SDK call, an IPFS gateway URL — every one of those is provider-
specific execution, explicitly out of scope (see "Non-negotiable rules").
Modeling an output shape, even an abstract one, would start to describe
what execution looks like; this package stops at the read boundary.

### 3. Failure model

`EnterpriseProviderFailureReason` is a closed, six-value vocabulary
(`provider-unavailable`, `capability-unsupported`, `execution-rejected`,
`grant-expired`, `provider-timeout`, `unexpected-provider-failure`)
describing *why* a provider-side operation did not succeed — never a
`success`/`httpStatus`/provider-response field, which every one of the seven
frozen R004 contracts already forbids.

`mapEnterpriseProviderFailureToUsageEventType` is the pure, total,
deterministic function that fixes how each failure category is reported:
onto exactly one of the three negative values already canonical in
`EnterpriseUsageEventType` (`@aoc-enterprise/usage-event`) —
`'AccessExpired'`, `'AccessDenied'`, or `'AccessFailed'` — per R005.0 ADR
Phase 5 ("Failure reporting"). No new field is added anywhere; this function
only fixes an existing, already-frozen mapping.

| `EnterpriseProviderFailureReason` | Reported `EnterpriseUsageEventType` |
| --- | --- |
| `grant-expired` | `AccessExpired` |
| `capability-unsupported` | `AccessDenied` |
| `execution-rejected` | `AccessDenied` |
| `provider-unavailable` | `AccessFailed` |
| `provider-timeout` | `AccessFailed` |
| `unexpected-provider-failure` | `AccessFailed` |

No retry logic and no networking are defined here (non-negotiable rule): an
adapter decides, in its own code, when to classify an observation as
`provider-timeout` vs. `provider-unavailable`, and whether or how to retry
before doing so. This package only fixes the vocabulary and the reporting
mapping once that decision has already been made.

## Lifecycle integration — without modifying ownership

Every interaction between a Provider Adapter and the frozen R004 lifecycle
is **read or emit**, never modify:

| Frozen contract | How a Provider Adapter interacts | What it can never do |
| --- | --- | --- |
| `EnterpriseAccessGrant` | Reads `resource`/`status`/`expiresAt` via `EnterpriseGrantTranslationInput` | Cannot read `id`, `decisionRef`, `principalId`, or any other field; cannot write back to it — `EnterpriseAccessGrant.status` moving to `'revoked'` is a future snapshot Enterprise itself produces, never something a Provider Adapter sets. |
| `EnterpriseGrantRevocation` | Reads `grantRef`/`reason` via `EnterpriseGrantRevocationInterpretationInput` | Cannot read or write any other field; never creates a revocation record itself — revocation is always Enterprise's own recorded fact. |
| `EnterpriseUsageEvent` | Is the adapter's own emitter — the only party positioned to observe a real access attempt | Never invents a new `eventType`; every emitted event uses the frozen, closed `EnterpriseUsageEventType` vocabulary as-is, via this package's failure-mapping helper where the event is failure-shaped. |
| `EnterpriseEvidenceCorrelation` | Never interacted with directly | A Provider Adapter contributes evidence *indirectly*, only by being the eventual producer of `EnterpriseUsageEvent` records that some future correlation graph's `usageRefs` may reference; this package never references `EnterpriseEvidenceCorrelation` by name. |
| `EnterpriseAccessDecision` / `EnterpriseAccessObligation` | Never interacted with directly | Neither is read, written, or referenced anywhere in this package — a Provider Adapter has no business with "should access be granted" or "under what conditions," only with "translate an already-issued grant." |

## Future provider compatibility (conceptual only)

The contract in this package is identical regardless of which provider
eventually implements it — this is the entire point of a provider-neutral
contract. No provider name, SDK type, or execution detail appears anywhere
in this package's types.

```text
 EnterpriseProviderCapabilityDeclaration          EnterpriseGrantTranslationInput
 { providerSystem, capabilities,                  { resource, status, expiresAt }
   supportedObligationTypes? }                              │
              │                                              │ (identical shape,
              │ (identical shape,                            │  every provider)
              │  every provider)                             ▼
              ▼                                    ┌───────────────────────┐
   ┌─────────────────────┐                         │  Provider Translation    │
   │ providerSystem:        │                         │  (not implemented here,   │
   │  'pinata' | 's3' |       │◄────────────────────────│   provider-specific)        │
   │  'azure-blob' |          │                         └───────────┬───────────┘
   │  'google-drive' |         │                                     │
   │  'sharepoint'               │                                     ▼
   └─────────────────────┘                         ┌───────────────────────┐
                                                     │  Provider Execution       │
                                                     │  (not implemented here,   │
                                                     │   provider-specific:      │
                                                     │   pin/unpin, presigned    │
                                                     │   URL, SAS token, share   │
                                                     │   link, Graph API grant)  │
                                                     └───────────┬───────────┘
                                                                  │
                                                                  ▼
                                                     EnterpriseUsageEvent
                                                     (frozen, R004.I --
                                                      eventType from
                                                      mapEnterpriseProviderFailureToUsageEventType
                                                      on failure)
```

| Provider | `providerSystem` (illustrative) | What a future adapter would implement | What this package's contract requires of it |
| --- | --- | --- | --- |
| Pinata (IPFS) | `'pinata'` | Pin/unpin, IPFS gateway URL generation | Same `EnterpriseProviderCapabilityDeclaration` shape, same `EnterpriseGrantTranslationInput` read view, same failure vocabulary |
| Amazon S3 | `'s3'` | Presigned `GetObject`/`PutObject` URL generation | ″ |
| Azure Blob | `'azure-blob'` | SAS token generation | ″ |
| Google Drive | `'google-drive'` | Drive API share-link/permission grant | ″ |
| SharePoint | `'sharepoint'` | Graph API sharing-link/permission grant | ″ |

None of the five is implemented here. The contract's job is exactly to make
sure none of them ever needs to be implemented differently.

## Relationship diagram

```text
┌──────────────────────────┐   ┌───────────────────────────────┐
│ @aoc-enterprise/access-grant │   │ @aoc-enterprise/grant-revocation │
│                              │   │                                    │
│ EnterpriseAccessGrant           │   │ EnterpriseGrantRevocation             │
└───────────────┬──────────┘   └────────────────┬──────────────┘
                 │ Pick<'resource'|'status'|'expiresAt'>          │ Pick<'grantRef'|'reason'>
                 ▼                                                 ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/provider-adapter                                            │
│                                                                              │
│ EnterpriseProviderCapability / EnterpriseProviderCapabilityDeclaration        │
│ EnterpriseGrantTranslationInput / toEnterpriseGrantTranslationInput           │
│ EnterpriseGrantRevocationInterpretationInput /                                  │
│   toEnterpriseGrantRevocationInterpretationInput                              │
│ EnterpriseProviderFailureReason / mapEnterpriseProviderFailureToUsageEventType    │
└───────────────────────────────────────┬───────────────────────────────────┘
                                          │ mapEnterpriseProviderFailureToUsageEventType
                                          ▼
                              ┌───────────────────────────┐
                              │ @aoc-enterprise/usage-event  │
                              │                              │
                              │ EnterpriseUsageEvent            │
                              │ (emitted directly by a future  │
                              │  provider adapter -- this      │
                              │  package never wraps it)          │
                              └───────────────────────────┘
```

## Explicit non-responsibilities of this package

Beyond what "Explicit non-responsibilities" above already lists, this
package also does not:

- implement Pinata, S3, Azure Blob, Google Drive, or SharePoint
- implement any runtime service
- implement a provider translation *output* type (see "Translation model")
- wire itself into `src/index.ts` or any public runtime export — matching
  every one of the seven R004 contracts' "no runtime consumer yet" status

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/provider-adapter
npm test --workspace @aoc-enterprise/provider-adapter
```

## Most important rule

A Provider Adapter is a translator. Nothing more. It must never become a
governance engine, an authorization engine, an audit engine, a provider
SDK, a storage implementation, a runtime service, a workflow engine, or an
orchestration layer. If a future change to this package starts to
accumulate any of those responsibilities, that is architectural drift to be
reported and reverted, not an incremental improvement to build on.
