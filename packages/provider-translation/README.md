# @aoc-enterprise/provider-translation

The canonical, immutable **Provider Translation Model** (R005.B). This
package defines the record of *how* an issued `EnterpriseAccessGrant`
should be translated into provider-neutral execution intent — the last
artifact Enterprise-adjacent code can reason about before an unmodeled,
provider-specific implementation (Pinata, S3, Azure Blob, Google Drive,
SharePoint, ...) takes over.

**This is not provider execution. It is not a provider SDK. It is not a
network request. It is not a signed URL. It is not a provider credential.**
It is the canonical intermediate artifact between Enterprise and Provider
execution.

## Purpose

`ADR-ACCESS-LIFECYCLE.md` (R005.0) names "Provider Translation" as the step
between an issued grant and unmodeled "Provider Execution": *"the grant is
translated into provider-specific execution input (a presigned URL request,
a scoped SDK call, a SAS request)."* `ADR-PROVIDER-ADAPTER-CONTRACT.md`
(R005.A) then fixed the compile-time-enforced *read boundary* a Provider
Adapter may use to perform that translation
(`EnterpriseGrantTranslationInput`, `EnterpriseGrantRevocationInterpretationInput`,
`@aoc-enterprise/provider-adapter`) but deliberately defined no output:
*"No Provider Translation output type, and no Provider Execution type, is
defined anywhere in this package."*

`@aoc-enterprise/provider-translation` is that output type — but only its
provider-neutral, pre-execution half. `EnterpriseProviderTranslation` is the
immutable record of *what a Provider Adapter decided a grant should
become*: which provider, which capability, which provider-neutral execution
intent, for which grant and resource.

It answers:

> "What should the Provider Adapter ask the provider to do?"

It never answers:

> "Did the provider actually do it?"

That second question belongs entirely to `EnterpriseUsageEvent`
(`@aoc-enterprise/usage-event`), emitted only after real Provider Execution
— a step this package does not implement, does not model the output of, and
does not observe.

## Responsibilities

Per R005.B Phase 3, `EnterpriseProviderTranslation` represents exactly:

| Field | Represents |
| --- | --- |
| `id` | Translation identity, minted once per translation attempt. |
| `providerSystem` | Provider identifier — free text, mirroring `EnterpriseResourceEnvelope.location.system` / `EnterpriseProviderCapabilityDeclaration.providerSystem` verbatim. |
| `capability` | Provider capability selection — a single `EnterpriseProviderCapability` (`@aoc-enterprise/provider-adapter`) this translation exercises. |
| `executionIntent` | Provider-neutral execution intent, from the closed `EnterpriseProviderTranslationExecutionIntent` vocabulary. |
| `grantRef` | The referenced `EnterpriseAccessGrant` (`@aoc-enterprise/access-grant`), by opaque `id`. |
| `resource` | The referenced Enterprise resource, composing Protocol's `ResourceRef` directly (identity only). |
| `providerMetadata?` | Provider-neutral documentation metadata about the translation itself (JSON primitives only, credential-shaped keys forbidden). |
| `translatedAt` | Translation timestamp. |
| `correlationId` | Correlation identifier, tying this translation into the rest of an audit trail. |
| `schemaVersion` | Version metadata. |
| `description?` | Documentation metadata. |

## Explicit non-responsibilities

A `EnterpriseProviderTranslation` — and everything in this package — never
represents:

- execution success or failure
- a provider's response
- a provider URL, signed URL, or temporary URL
- a provider SDK client or type
- network state, a socket, or an HTTP client
- a runtime session, execution engine, or workflow engine
- a credential, API key, JWT, OAuth token, or bearer token
- authorization, policy, or a policy decision
- grant ownership (`principalId` stays on `EnterpriseAccessGrant` alone)
- persistence of any kind
- retries, telemetry, or logging

And, mirroring every one of the R004/R005.A contracts, this package
contains, and by design cannot contain (enforced at compile time via
`@ts-expect-error` — see `__tests__/enterprise-provider-translation.test.ts`):

- a JWT, OAuth token, or bearer token
- a provider SDK client (Pinata, S3, Azure Blob, Google Drive, SharePoint,
  or any other)
- an HTTP client or network socket
- a URL, signed URL, or temporary URL
- a provider credential or API key
- an execution-success/provider-response field (`success`, `httpStatus`, ...)
- a storage object or blob
- retry logic
- an execution/persistence callback
- telemetry or logging
- a policy-evaluation/authorization/outcome field
- a `principalId`/grant-ownership field

If a future change to this package starts to accumulate any of the above,
that is architectural drift, not an incremental improvement — see "Most
important rule" below.

## Translation philosophy

`EnterpriseAccessGrant` answers *"what authorization exists?"* — an
immutable record produced once, at issuance, that a principal holds (or
once held) authorization for a resource. `EnterpriseProviderTranslation`
answers a different, later question: *"how should a provider attempt to
realize that authorization?"* — a provider-neutral instruction, never the
authorization itself, and never a claim about whether a provider carried it
out. Provider **Execution** — what the provider actually does, whether it
succeeds, what it returns — stays entirely outside this model, exactly as
R005.0/R005.A already established: this package does not implement Pinata,
S3, Azure Blob, Google Drive, or SharePoint, and defines no output shape
for any of them (a presigned URL, a SAS token, a scoped SDK call — every
one of those remains provider-specific and unmodeled here).

```text
 EnterpriseAccessGrant              EnterpriseProviderTranslation           Provider Execution
 (frozen, R004.G --                 (this package -- provider-neutral,       (not modeled --
  "what authorization exists?")      pre-execution execution plan)            provider-specific)
   resource ──────────┐
   status ─────────────┤
   expiresAt ──────────┘
   id ─────────────────────► grantRef
                                │
                                ▼
                     EnterpriseProviderTranslation
                       { id, providerSystem, capability,
                         executionIntent, grantRef, resource,
                         providerMetadata?, translatedAt,
                         correlationId, description? }
                                │
                                │ (opaque to this package: a presigned
                                │  URL, a SAS token, a scoped SDK call --
                                ▼  each provider's own, unmodeled choice)
                     (Provider Execution, out of scope)
                                │
                                ▼
                     EnterpriseUsageEvent
                     (frozen, R004.I -- emitted only after real
                      Provider Execution, referencing this
                      translation's grantRef, never its own id)
```

## Execution boundary

This package sits entirely on the Enterprise side of the R005.0 Provider
Boundary, one step further than `@aoc-enterprise/provider-adapter`:

| Layer | Owns | This package's relationship |
| --- | --- | --- |
| `EnterpriseAccessGrant` / `EnterpriseGrantRevocation` (frozen, R004.G/H) | The immutable fact that authorization was issued or withdrawn | Referenced by opaque `grantRef` only — never embedded, never modified. |
| `@aoc-enterprise/provider-adapter` (R005.A) | The read boundary (`EnterpriseGrantTranslationInput`, `EnterpriseGrantRevocationInterpretationInput`) and the closed `EnterpriseProviderCapability` vocabulary | `EnterpriseProviderTranslation.capability` selects one value from that same, reused vocabulary — never redefines it. |
| `@aoc-enterprise/provider-translation` (this package, R005.B) | The immutable, provider-neutral *result* of a translation decision | Everything this README documents. |
| Provider Execution (unmodeled, provider-specific) | A presigned URL, a SAS token, an IPFS pin, a Graph API permission grant, ... | Never read, written, or referenced anywhere in this package. |
| `EnterpriseUsageEvent` (frozen, R004.I) | The immutable fact that a grant was actually exercised, observed after real execution | Emitted independently, referencing `grantRef` — never this translation's own `id`. This package never imports or references `EnterpriseUsageEvent`. |

A `EnterpriseProviderTranslation` is produced once a Provider Adapter has
decided what it intends to ask a provider to do, and it is never updated
afterward to reflect what actually happened — that is always a fresh
`EnterpriseUsageEvent`, correlated by `grantRef`, never a mutation of this
record or a new field on it.

## Execution intent vocabulary

`EnterpriseProviderTranslationExecutionIntent` is a closed, five-value
vocabulary, searched for reuse before being introduced (see "Vocabulary
search" below):

| Value | Meaning | Required capability |
| --- | --- | --- |
| `ProvideTemporaryAccess` | Grant time-bounded access to a resource. | `SupportsTemporaryAccess` |
| `ProvideReadOnlyAccess` | Grant time-bounded, read-only access to a resource. | `SupportsTemporaryAccess` |
| `ProvideMetadata` | Surface descriptive metadata about a resource, never its bytes. | `SupportsProviderMetadata` |
| `RegisterUsage` | Ask a provider to record, on its own side, that a grant is being exercised. | `SupportsUsageReporting` |
| `InvalidateGrant` | Ask a provider to stop honoring a grant. | `SupportsGrantRevocation` |

`enterpriseProviderTranslationRequiredCapability` is the pure, total
function fixing this mapping — the basis for the "capability consistency"
check in `validateEnterpriseProviderTranslation` (see below).

### Vocabulary search

`src/features/action-enforcement/domain/execution-intent.ts` already
defines an `ExecutionIntent` type in this repository. It is a distinct,
kernel-level runtime-enforcement concept (`action`, `riskLevel`,
`sideEffectType`, `resourceScope` — a kernel action's own shape, unrelated
to Access Governance grant translation). Reusing it would conflate two
unrelated domains rather than avoid a duplicate, so it was not reused. No
other provider-neutral vocabulary of "what a grant translation is asking a
provider to do" exists anywhere else in this repository. The five values
above are therefore a new, minimum-required vocabulary, built directly from
R005.B's own named examples, not a reuse.

## What this package defines

`EnterpriseProviderTranslation` carries the same ceremony every frozen
contract in this line does:

- `validateEnterpriseProviderTranslation` — required fields, closed-vocabulary
  membership, capability/execution-intent consistency, reference integrity
  (well-formedness, never existence), and `providerMetadata` key/value
  consistency for a single candidate.
- `validateEnterpriseProviderTranslationSet` — duplicate `id` detection
  across a collection. Deliberately does not also forbid two translations
  from sharing the same `grantRef`: a grant is expected to be translated
  more than once over its lifetime (e.g. once at issuance, again after a
  capability-set change).
- `enterpriseProviderTranslationIdentityEquals` — identity derives from
  translation identity, grant reference, provider identifier, and execution
  intent only (R005.B Phase 8), never from `capability`, `providerMetadata`,
  timestamps, or execution.
- `enterpriseProviderTranslationEquals` — full structural equality,
  extending identity to every remaining declarative field.
- `serializeEnterpriseProviderTranslation` / `deserializeEnterpriseProviderTranslation`
  — deterministic, round-trip-safe (de)serialization; `deserialize` throws
  `EnterpriseProviderTranslationValidationError` (carrying every issue) on
  invalid input.

## Relationship diagram

```text
┌──────────────────────────┐   ┌───────────────────────────────┐
│ @aoc-enterprise/access-grant │   │ @aoc-enterprise/provider-adapter │
│                              │   │                                    │
│ EnterpriseAccessGrant           │   │ EnterpriseProviderCapability          │
│ (id referenced as grantRef)     │   │ (reused, not redefined, as              │
│                              │   │  EnterpriseProviderTranslation.capability) │
└───────────────┬──────────┘   └────────────────┬──────────────┘
                 │                                                 │
                 ▼                                                 ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/provider-translation                                        │
│                                                                              │
│ EnterpriseProviderTranslationExecutionIntent                                  │
│ EnterpriseProviderTranslation                                                 │
│ enterpriseProviderTranslationRequiredCapability                               │
│ enterpriseProviderTranslationIdentityEquals / Equals                          │
│ validateEnterpriseProviderTranslation(Set)                                    │
│ serializeEnterpriseProviderTranslation / deserializeEnterpriseProviderTranslation │
└───────────────────────────────────────┬───────────────────────────────────┘
                                          │ grantRef correlates back to
                                          ▼
                              ┌───────────────────────────┐
                              │ @aoc-enterprise/usage-event  │
                              │                              │
                              │ EnterpriseUsageEvent            │
                              │ (emitted independently, after  │
                              │  real Provider Execution --     │
                              │  this package never imports it) │
                              └───────────────────────────┘
```

## Future provider compatibility (conceptual only)

The model in this package is identical regardless of which provider
eventually realizes it — no provider name, SDK type, or execution detail
appears anywhere in this package's types.

| Provider | `providerSystem` (illustrative) | What a future adapter would implement at Provider Execution | What this package's model requires of it |
| --- | --- | --- | --- |
| Pinata (IPFS) | `'pinata'` | Pin/unpin, IPFS gateway URL generation | Same `EnterpriseProviderTranslation` shape, same closed execution-intent vocabulary |
| Amazon S3 | `'s3'` | Presigned `GetObject`/`PutObject` URL generation | ″ |
| Azure Blob | `'azure-blob'` | SAS token generation | ″ |
| Google Drive | `'google-drive'` | Drive API share-link/permission grant | ″ |
| SharePoint | `'sharepoint'` | Graph API sharing-link/permission grant | ″ |

None of the five is implemented here. No adapter is implemented by this
package. The model's job is exactly to make sure none of them ever needs a
differently-shaped translation record.

## Blast radius — future consumers (not migrated by this change)

No existing code imports this package (it is not wired into
`src/index.ts` or any public runtime export, matching the "no runtime
consumer yet" status every R004/R005.A contract already carries). Its
future consumers are expected to be:

- A future Pinata Provider Adapter
- A future Amazon S3 Provider Adapter
- A future Azure Blob Provider Adapter
- A future Google Drive Provider Adapter
- A future SharePoint Provider Adapter
- A future Provider Conformance Suite (validating that any adapter
  implementation produces well-formed `EnterpriseProviderTranslation`
  records before attempting Provider Execution)

None of these is created, modified, or migrated by this change.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/provider-translation
npm test --workspace @aoc-enterprise/provider-translation
```

## Most important rule

The Translation Model is an immutable execution *description*, never an
execution *engine*. It must never become a provider SDK, an execution
engine, an HTTP client, a networking layer, a storage implementation, a
workflow engine, an authorization engine, or a governance engine. If a
future change to this package starts to accumulate any of those
responsibilities, that is architectural drift to be reported and reverted,
not an incremental improvement to build on.
