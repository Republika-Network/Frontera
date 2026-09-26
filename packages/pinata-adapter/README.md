# @aoc-enterprise/pinata-adapter

The first concrete **Provider Adapter** (R005.C): translates an already-produced
`EnterpriseProviderTranslation` (`@aoc-enterprise/provider-translation`, R005.B)
into a real Pinata SDK operation, and normalizes whatever Pinata returns --
success or failure -- into a canonical, provider-neutral execution outcome.

**This package is not a redesign of the Provider Adapter architecture.** It is
the first proof that `docs/architecture/ADR-ACCESS-LIFECYCLE.md` (R005.0),
`docs/architecture/ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A), and
`docs/architecture/ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B) can be
implemented for a real provider without changing any of them. No Enterprise
contract is modified, renamed, or redesigned by this package.

## Architecture validation

`Grant -> Translation -> Provider Adapter -> Pinata` is implementable without
architecture change:

- **Grant** (`EnterpriseAccessGrant`, R004.G) and **Translation**
  (`EnterpriseProviderTranslation`, R005.B) are frozen, unmodified inputs.
  This package never reads an `EnterpriseAccessGrant` or
  `EnterpriseGrantRevocation` directly -- it consumes only an already-produced
  `EnterpriseProviderTranslation`, per R005.C's own "Primary Objective."
- **Provider Adapter** reuses, never redefines, `EnterpriseProviderCapability`
  (`@aoc-enterprise/provider-adapter`, R005.A) and
  `EnterpriseProviderTranslationExecutionIntent`
  (`@aoc-enterprise/provider-translation`, R005.B).
- **Pinata** is realized entirely inside `src/pinata-provider-client.ts` --
  the only file in this repository that imports the `pinata` SDK (proven by
  `scripts/check-pinata-boundary.mjs`, run as part of this package's own
  `npm test`).

No architectural drift was required. No new lifecycle state, obligation
value, revocation reason, capability category, or execution intent was added
anywhere.

## Responsibilities (R005.C Phase 3)

| Responsibility | Implementation |
| --- | --- |
| Translation consumption | `executePinataProviderTranslation(candidate, client, deps?)` accepts an `EnterpriseProviderTranslation` (as `unknown`, validated internally) |
| Capability validation | `enterpriseProviderTranslationRequiredCapability(executionIntent)` is checked against `PINATA_SUPPORTED_CAPABILITIES` before any Pinata call is attempted |
| Execution intent mapping | The closed, five-value `EnterpriseProviderTranslationExecutionIntent` vocabulary is mapped onto Pinata operations (see "Execution flow" below) |
| Pinata SDK invocation | `PinataProviderClient` (`src/pinata-provider-client.ts`), backed by the official `pinata` npm SDK |
| Provider metadata extraction | `ProvideMetadata` surfaces Pinata's own file metadata (name, cid, size, mime type, keyvalues, created-at) -- never bytes |
| Execution result normalization | `PinataProviderExecutionResult` (`PinataProviderExecutionSuccess \| PinataProviderExecutionFailure`) -- never a raw Pinata SDK response |

Explicitly **not** implemented, per R005.C's own non-negotiable rules: policy
evaluation, authorization, `EnterpriseAccessDecision` creation, governance,
auditing, `EnterpriseUsageEvent` generation, `EnterpriseEvidenceCorrelation`,
orchestration, workflow engines, retries, queues, REST APIs, persistence,
databases, or caching. This package is a translator. Nothing more.

## Boundary validation (R005.C Phase 8)

- No Enterprise contract (`packages/*` other than this one, or the
  repository-root `src/` tree) imports `pinata` -- proven by
  `scripts/check-pinata-boundary.mjs`.
- Within this package, only `src/pinata-provider-client.ts` imports `pinata`.
  `src/pinata-provider-adapter.ts` (the orchestration layer) talks only to
  the narrow `PinataProviderClient` interface and to `PinataProviderClientError`
  (this package's own type, not a Pinata SDK type).
- Dependency direction is one-way: `pinata-provider-adapter.ts` depends on
  `pinata-provider-client.ts`; nothing depends the other way.

## Supported capabilities

| `EnterpriseProviderCapability` | Supported? | Why |
| --- | --- | --- |
| `SupportsTemporaryAccess` | Yes | Realized as a Pinata private-gateway signed access link (`gateways.private.createAccessLink`), keyed by CID and a requested duration. |
| `SupportsProviderMetadata` | Yes | Realized as a Pinata file metadata lookup (`files.public.get`) -- name, cid, size, mime type, keyvalues, created-at. Never the file's bytes. |
| `SupportsGrantRevocation` | Yes | Realized as the nearest valid Pinata operation: deleting/unpinning the file record (`files.public.delete`). Pinata has no distinct "revoke a grant" primitive -- unpinning is what stops the object being served, matching `ADR-ACCESS-LIFECYCLE.md`'s own example (`resource-removed -> unpin/delete a provider object`). |
| `SupportsCapabilityDiscovery` | Yes | `createPinataProviderCapabilityDeclaration` can be called at runtime, not only referenced as a build-time constant. |
| `SupportsCorrelation` | Yes | Every `PinataProviderExecutionResult` echoes back the translation's own `correlationId`. |
| `SupportsEvidenceContribution` | Yes | The normalized result (translation id, grant reference, correlation id, execution detail) is shaped to be attachable as evidence by a future caller; this package does not itself write `evidenceRefs` anywhere (out of scope -- see "Unsupported capabilities"). |

## Unsupported capabilities

| `EnterpriseProviderCapability` | Why Pinata (or this package) cannot genuinely satisfy it |
| --- | --- |
| `SupportsUsageReporting` | Pinata has no API asking the provider itself to record, on its own side, that a grant is being exercised (its analytics APIs are aggregate gateway traffic reports, not per-grant usage registration). A `RegisterUsage`-intent translation always returns `capability-unsupported`, per R005.C Phase 4 ("do not fake capability support"). This is independent of, and does not require, `EnterpriseUsageEvent` generation, which this package does not implement at all (non-negotiable rule). |
| `SupportsExpiration` | This adapter consumes only `EnterpriseProviderTranslation`, which (by R005.B's own design) carries no `expiresAt` -- performing a wall-clock comparison would require reading `EnterpriseAccessGrant` directly, out of scope for R005.C's "Adapter MUST consume: EnterpriseProviderTranslation ... Nothing else." |

## Obligation types Pinata can enforce

| `EnterpriseAccessObligationType` | Supported? | Why |
| --- | --- | --- |
| `read-only` | Yes | A Pinata gateway signed access link only ever serves bytes over HTTP GET; there is no write capability to grant through it. |
| `time-limit` | Yes | A Pinata signed access link carries its own `expires` (Unix timestamp) parameter -- a genuinely provider-enforced time bound. |
| `no-download` | No | Any HTTP GET response can be saved by the client; Pinata has no mechanism to prevent that at the storage layer. |
| `watermark-content` | No | Pinata is a pinning/storage service; it performs no content transformation. |
| `require-mfa` | No | Not a Pinata concept -- this is an Enterprise-side policy decision made before a translation is ever produced. |
| `require-approval` | No | Same as above -- a workflow concept Pinata is unaware of. |
| `record-usage` | No | Same reasoning as `SupportsUsageReporting` above. |
| `require-acceptance` | No | Pinata's gateway has no acceptance-of-terms mechanism. |

## Execution flow

```text
 EnterpriseProviderTranslation                Pinata operation                Execution result
 (already produced, R005.B)                   (this package only)             (this package's own type)

 executionIntent: 'ProvideTemporaryAccess' ─┐
 executionIntent: 'ProvideReadOnlyAccess'  ─┼─► gateways.private.createAccessLink  ─► { kind: 'temporary-access',
   providerMetadata.requestedDurationSeconds │    ({ cid: resource.id, expires })       accessUrl, expiresAt }
                                              ┘

 executionIntent: 'ProvideMetadata' ───────────► files.public.get(fileId)          ─► { kind: 'metadata', metadata }
   providerMetadata.pinataFileId

 executionIntent: 'InvalidateGrant' ───────────► files.public.delete([fileId])     ─► { kind: 'grant-invalidated',
   providerMetadata.pinataFileId                  (nearest valid provider              providerResourceStatus }
                                                     operation -- unpin/delete)

 executionIntent: 'RegisterUsage' ─────────────► (no Pinata mapping exists) ───────► failureReason:
                                                                                        'capability-unsupported'
```

`translation.resource.id` is the Pinata CID (`ProvideTemporaryAccess`/
`ProvideReadOnlyAccess`); `translation.providerMetadata.pinataFileId` is
Pinata's own, distinct file id (`ProvideMetadata`/`InvalidateGrant`) -- see
"Pinata-specific decisions" below. **GAP-012 (fixed):** an earlier revision
of this package read `resource.id` for both, silently treating a content
CID and a provider-internal file id as the same identifier. They are not:
Pinata's own SDK types keep them separate (`PinataResourceMetadata.cid` vs.
`.id`), and reusing a CID as a file id (or vice versa) fails against the
real API. See `docs/architecture/ADR-DURABLE-GRANTS-REVOCATION.md` (Slice 1
of Sovereign Execution Binding) for the full fix record.

## Failure mapping

Every Pinata SDK failure is classified, inside `pinata-provider-client.ts`
only, onto the closed `EnterpriseProviderFailureReason` vocabulary
(`@aoc-enterprise/provider-adapter`, reused, never redefined):

| Pinata SDK failure | `EnterpriseProviderFailureReason` |
| --- | --- |
| `NetworkError` | `provider-unavailable` |
| `AuthenticationError` | `execution-rejected` |
| `ValidationError` | `execution-rejected` |
| `PinataError` with `statusCode` 408 or 429 | `provider-timeout` |
| `PinataError` with `statusCode >= 500` | `provider-unavailable` |
| `PinataError` (other status codes) | `execution-rejected` |
| Any other thrown value | `unexpected-provider-failure` |

`PinataProviderExecutionFailure.message` is always a plain, provider-neutral
string (the classified error's own message) -- never an HTTP status code, a
Pinata SDK exception object, a stack trace, or any other provider-specific
object. `grant-expired` is a legitimate value of the reused vocabulary that
this adapter never emits, since it consumes no `expiresAt` (see "Unsupported
capabilities").

A malformed or invalid `EnterpriseProviderTranslation` (fails
`validateEnterpriseProviderTranslation`, or validly targets a `providerSystem`
other than `'pinata'`) is a programming-contract violation, not a Pinata
failure: `executePinataProviderTranslation` throws `PinataAdapterInputError`
rather than returning a `PinataProviderExecutionFailure`.

## Pinata-specific decisions

- **Resource identity (GAP-012 fixed).** `EnterpriseProviderTranslation.resource`
  composes Protocol's `ResourceRef` (identity only); `resource.id` is
  *always* the Pinata CID here, mirroring the frozen
  `@aoc-enterprise/provider-translation` package's own test fixture
  (`resource: { kind: 'ipfs-object', id: 'Qm123' }`). `files.public.get`/
  `files.public.delete` need Pinata's own, separate file id instead -- a
  storage handle, not a content identity -- which this adapter reads from
  `translation.providerMetadata.pinataFileId` (a plain string), never from
  `resource.id`. A translation missing it for `ProvideMetadata`/
  `InvalidateGrant` throws `PinataAdapterInputError`, exactly like a missing
  `requestedDurationSeconds` does for temporary access. The caller building
  the translation (a durable orchestration layer, e.g.
  `src/enterprise/access-governance/`) is responsible for resolving both
  identifiers from the resource's own `EnterpriseResourceEnvelope.location`
  (`@aoc-enterprise/resource-envelope`) before it ever reaches this adapter
  -- this package still never reads a grant or envelope directly.
- **Requested access duration.** `ProvideTemporaryAccess`/`ProvideReadOnlyAccess`
  require `providerMetadata.requestedDurationSeconds` (a positive number of
  seconds) on the translation; this package does not invent a default
  duration. Missing it throws `PinataAdapterInputError`.
- **Public vs. private Pinata network.** Metadata and invalidation operate
  against Pinata's public-network files API. Temporary access is realized
  through Pinata's private-gateway signed access link API, since that is the
  primitive with an `expires` parameter.
- **`InvalidateGrant` maps to delete, not a Pinata-native "revoke."** Pinata
  has no concept of revoking a grant; unpinning/deleting the file record is
  the nearest valid provider operation, matching
  `ADR-ACCESS-LIFECYCLE.md`'s own worked example.

## Known limitations

- `RegisterUsage` always fails with `capability-unsupported` -- Pinata has no
  provider-side usage-registration primitive this adapter can honestly claim.
- No expiration enforcement -- this adapter never reads `EnterpriseAccessGrant.expiresAt`
  (out of scope; see "Unsupported capabilities").
- No obligation enforcement beyond `read-only`/`time-limit` -- Pinata cannot
  genuinely satisfy any of the other six `EnterpriseAccessObligationType`
  values (see "Obligation types Pinata can enforce").
- This package never emits `EnterpriseUsageEvent` -- a future caller composes
  `PinataProviderExecutionResult` with `mapEnterpriseProviderFailureToUsageEventType`
  (`@aoc-enterprise/provider-adapter`) to do so; that composition is out of
  scope for this sequence.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/pinata-adapter
npm test --workspace @aoc-enterprise/pinata-adapter
```

`npm test` compiles `__tests__` under `tsconfig.test.json`, runs `node --test`
against the compiled output, and then runs `scripts/check-pinata-boundary.mjs`
(also runnable standalone as `npm run check:pinata-boundary --workspace @aoc-enterprise/pinata-adapter`).

## Most important rule

This package is a translator. Nothing more. It never evaluates policy, never
grants authorization, never creates or modifies any Enterprise-owned
contract, never performs auditing, and never becomes an orchestration or
workflow layer. If a future change to this package starts to accumulate any
of those responsibilities, that is architectural drift to be reported and
reverted -- not an incremental improvement to build on.
