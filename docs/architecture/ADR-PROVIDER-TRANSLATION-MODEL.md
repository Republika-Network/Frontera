# ADR: Canonical Provider Translation Model (R005.B)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Sequence: R005.B, Soberanía Architectural Consolidation Program
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/canonical-provider-translation-model-icite4`
- Related: `ADR-ACCESS-LIFECYCLE.md` (R005.0, frozen input — treated as
  frozen architecture, not modified by this change),
  `ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A, frozen input — treated as
  frozen architecture, not modified by this change), `ADR-ACCESS-GRANT.md`
  (R004.G, `EnterpriseAccessGrant`), `ADR-GRANT-REVOCATION.md` (R004.H,
  `EnterpriseGrantRevocation`), `ADR-USAGE-EVENT.md` (R004.I,
  `EnterpriseUsageEvent`)

## Role of this document

This ADR records the design of `@aoc-enterprise/provider-translation`
(`packages/provider-translation`): the canonical, immutable **Provider
Translation Model** — the record of how an issued `EnterpriseAccessGrant`
should be translated into provider-neutral execution intent. It is not
Provider Execution. It is not a Pinata adapter, an S3 adapter, an Azure
adapter, a Google Drive adapter, or a SharePoint adapter — none of those
exist in this package or this repository. `ADR-ACCESS-LIFECYCLE.md`
(R005.0) and `ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A) are treated as
frozen architecture throughout: nothing in either document, or in any of
the contracts they freeze or define, is redesigned or modified by this
change.

## Phase 1 — Repository Validation

| Check | Result |
|---|---|
| Repository | `architects-of-change-protocol/aoc-enterprise` |
| Branch | `claude/canonical-provider-translation-model-icite4` (pre-existing, checked out) |
| Working tree | Clean at time of writing (no untracked/modified files) before this change |
| HEAD SHA (base) | `07ee141d6f33e3e4fdfce66e6510dbdd44f65983` (merge of PR #87, `feat(access-governance): add canonical Provider Adapter contract (R005.A)`) |

The designated branch already existed and is the one this sequence commits
to — no new branch creation was required. `ADR-ACCESS-LIFECYCLE.md`
(R005.0), `ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A), and every contract
either document freezes or defines are present, merged, and treated as
canonical, frozen input for this sequence.

---

## Phase 2 — Architecture Review: Enterprise, Translation, and Provider artifacts

R005.0 ADR Phase 4 ("Provider Boundary") and R005.A ADR Phase 2 already draw
the Enterprise/Provider line precisely; this sequence adopts it verbatim and
inserts exactly one new layer between the two, never redrawing the line
itself:

```text
┌───────────────────────────────── ENTERPRISE (frozen, R004/R005.0) ───────────┐
│ EnterpriseAccessGrant · EnterpriseGrantRevocation · EnterpriseUsageEvent ·    │
│ EnterpriseAccessDecision · EnterpriseAccessObligation · EnterpriseResourceEnvelope │
│ EnterpriseEvidenceCorrelation                                                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                        │ grantRef, providerSystem, resource
                                        │ (read boundary fixed by R005.A's
                                        │  EnterpriseGrantTranslationInput /
                                        │  EnterpriseGrantRevocationInterpretationInput)
                                        ▼
┌──────────────────── TRANSLATION (this sequence, R005.B) ─────────────────────┐
│ EnterpriseProviderTranslation                                                │
│ Owns: the immutable RESULT of a translation decision -- provider identifier, │
│ selected capability, execution intent, referenced grant + resource.          │
│ Never: execution success, provider response, URLs, credentials, SDKs.        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                        │ (opaque to this package -- a
                                        │  presigned URL, a SAS token, a
                                        │  scoped SDK call, never modeled)
                                        ▼
┌───────────────────────────────── PROVIDER (unmodeled) ───────────────────────┐
│ Owns: Execution · Temporary URLs · Signed URLs · Credentials · Network ·     │
│       Storage · SDK                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Enterprise-owned artifacts** (unchanged by this sequence):
  `EnterpriseAccessGrant`, `EnterpriseGrantRevocation`, `EnterpriseUsageEvent`,
  and the rest of the R004 lifecycle. This sequence reads exactly one field
  from this layer directly by reference: a grant's own `id`, carried forward
  as `EnterpriseProviderTranslation.grantRef`.
- **Translation artifacts** (this sequence's own, new layer):
  `EnterpriseProviderTranslation` — the sole type this package defines,
  plus its supporting closed vocabulary
  (`EnterpriseProviderTranslationExecutionIntent`) and pure functions
  (validation, equality, serialization, the capability-consistency mapping).
- **Provider-owned artifacts** (unmodeled, out of scope, exactly as R005.0/R005.A
  already established): a presigned URL, a SAS token, an IPFS pin, a Graph
  API permission grant, any provider SDK type, any HTTP client, any
  credential.

**Where Enterprise ends and Translation begins:** at the moment a Provider
Adapter has decided, using the read boundary R005.A already fixed
(`EnterpriseGrantTranslationInput`, `EnterpriseGrantRevocationInterpretationInput`),
*what it intends to ask a provider to do* — but before it has asked. That
decision, recorded immutably, is a `EnterpriseProviderTranslation`.

**Where Translation ends and Provider Execution begins:** at the moment
something takes a `EnterpriseProviderTranslation` and attempts to realize
it against a real provider. This sequence defines no such attempt, no
output type for it, and no way to represent its result — that remains
`EnterpriseUsageEvent`'s job, emitted independently, after the fact,
correlated by `grantRef`, never by this translation's own `id`.

The transition this sequence adds to the diagram above is the **result**
of a translation decision — never a new Enterprise fact, and never any
Provider execution detail.

---

## Phase 3 — Translation Responsibilities

Exactly the eleven concepts named in this sequence's own task language,
each given a concrete, provider-neutral shape in `packages/provider-translation`:

| Responsibility | Contract shape |
|---|---|
| Translation identity | `EnterpriseProviderTranslation.id` |
| Provider identifier | `EnterpriseProviderTranslation.providerSystem` (free text, mirrors `EnterpriseResourceEnvelope.location.system`) |
| Provider capability selection | `EnterpriseProviderTranslation.capability` (a single `EnterpriseProviderCapability`, reused from `@aoc-enterprise/provider-adapter`, never redefined) |
| Referenced Enterprise Grant | `EnterpriseProviderTranslation.grantRef` (opaque pointer to `EnterpriseAccessGrant.id`) |
| Referenced Enterprise Resource | `EnterpriseProviderTranslation.resource` (Protocol `ResourceRef`, identity only) |
| Provider-neutral execution intent | `EnterpriseProviderTranslation.executionIntent` (`EnterpriseProviderTranslationExecutionIntent`, closed vocabulary) |
| Provider metadata | `EnterpriseProviderTranslation.providerMetadata?` (JSON primitives only, credential-shaped keys forbidden) |
| Translation timestamp | `EnterpriseProviderTranslation.translatedAt` |
| Correlation identifier | `EnterpriseProviderTranslation.correlationId` |
| Version metadata | `EnterpriseProviderTranslation.schemaVersion` |
| Documentation metadata | `EnterpriseProviderTranslation.description?` |

Nothing else is defined. No responsibility beyond this table's eleven rows
is in scope for this sequence, and none of the following is represented
anywhere in this package: execution success, provider response, provider
URLs, provider SDK, network state, runtime, credentials, tokens,
authorization, policy, or grant ownership (`principalId` stays on
`EnterpriseAccessGrant` alone — never duplicated here, per R005.A's own
precedent for `EnterpriseGrantTranslationInput`).

---

## Phase 4 — Execution Intent

Searched before introducing any new vocabulary (per this sequence's own
Phase 4 instruction): `src/features/action-enforcement/domain/execution-intent.ts`
already defines an `ExecutionIntent` type in this repository. It is a
distinct, kernel-level runtime-enforcement concept — `action`, `riskLevel`
(`ExecutionRiskLevel`), `sideEffectType` (`SideEffectType`), `resourceScope`
— describing a kernel action's own execution shape, entirely unrelated to
Access Governance grant translation. Reusing it would conflate two
unrelated domains rather than avoid a duplicate, so it was not reused. No
other execution-intent-shaped vocabulary for "what a grant translation is
asking a provider to do" exists anywhere else in this repository.

The closed, five-value `EnterpriseProviderTranslationExecutionIntent`
vocabulary is therefore new, built directly from this sequence's own named
examples verbatim — no provider-specific intent is, or will ever be, added:

| Value | Meaning | Required `EnterpriseProviderCapability` |
|---|---|---|
| `ProvideTemporaryAccess` | Grant time-bounded access to a resource. | `SupportsTemporaryAccess` |
| `ProvideReadOnlyAccess` | Grant time-bounded, read-only access to a resource. | `SupportsTemporaryAccess` |
| `ProvideMetadata` | Surface descriptive metadata about a resource, never its bytes. | `SupportsProviderMetadata` |
| `RegisterUsage` | Ask a provider to record, on its own side, that a grant is being exercised. | `SupportsUsageReporting` |
| `InvalidateGrant` | Ask a provider to stop honoring a grant. | `SupportsGrantRevocation` |

`enterpriseProviderTranslationRequiredCapability` is the pure, total
function fixing this mapping, reused by `validateEnterpriseProviderTranslation`'s
"capability consistency" check (Phase 6 below).

---

## Phase 5 — Translation Semantics

`EnterpriseProviderTranslation` answers, and only answers:

- Which Enterprise Grant? — `grantRef`.
- Which Provider? — `providerSystem`.
- Which capability? — `capability`.
- Which execution intent? — `executionIntent`.

It never answers:

- Did execution succeed? — no such field exists, anywhere, by construction
  (see Phase 10's compile-time proof).
- Did Pinata / Azure / S3 return a URL, accept, or reject the request? — no
  provider-specific field or provider-response field exists.

`EnterpriseAccessGrant` (frozen, R004.G) answers *"what authorization
exists?"*. `EnterpriseProviderTranslation` (this sequence) answers a
distinct, later question: *"how should a provider attempt to realize that
authorization?"* Provider **Execution** — what a provider actually does,
whether it succeeds, what it returns — remains entirely outside this model,
exactly as R005.0/R005.A already established.

---

## Phase 6 — Validation

`validateEnterpriseProviderTranslation` validates exactly:

| Validated | How |
|---|---|
| Required fields | `id`, `providerSystem`, `capability`, `executionIntent`, `grantRef`, `resource`, `translatedAt`, `correlationId` — each checked for presence and well-formed shape. |
| Translation consistency | `schemaVersion` must match the package's own frozen version; `translatedAt` must be a well-formed ISO 8601 UTC timestamp; `providerMetadata` values must be JSON primitives and keys must not resemble a credential/token/URL. |
| Duplicate translation identifiers | `validateEnterpriseProviderTranslationSet` — a separate, collection-level function (mirroring every other R004/R005.A "set" validator) rejecting two translations that share the same `id`. Deliberately permits two translations to share a `grantRef` — a grant may be translated more than once over its lifetime. |
| Capability consistency | `candidate.capability` must equal `enterpriseProviderTranslationRequiredCapability(candidate.executionIntent)` — a translation whose declared capability disagrees with what its own execution intent requires is rejected with `CAPABILITY_EXECUTION_INTENT_MISMATCH`. |
| Reference integrity | `grantRef` and `resource.kind`/`resource.id` must be well-formed, non-empty identifiers — never checked for *existence* (this function never confirms `grantRef` points at a real grant, mirroring every R004/R005.A validator's identical boundary). |

Explicitly **not** validated, matching every frozen contract's own
boundary: provider availability, network reachability, real Provider
Execution, provider state, or credentials — this package contacts nothing
and executes nothing.

---

## Phase 7 — Serialization

`serializeEnterpriseProviderTranslation` / `deserializeEnterpriseProviderTranslation`
provide deterministic, provider-neutral, round-trip-safe, forward-compatible
(de)serialization, matching the identical pattern already established by
`serializeEnterpriseAccessGrant`/`serializeEnterpriseUsageEvent`/
`serializeEnterpriseProviderCapabilityDeclaration`:

- **Stable** — object keys are written in a fixed order; `resource.attributes`
  and `providerMetadata` keys are sorted before serialization, so two
  structurally-identical translations always serialize identically.
- **Provider-neutral** — the serialized shape (`SerializedEnterpriseProviderTranslation`)
  contains the same eleven fields as the in-memory type, nothing more.
- **Round-trip safe** — `deserializeEnterpriseProviderTranslation(JSON.parse(JSON.stringify(serializeEnterpriseProviderTranslation(t))))`
  is structurally equal (`enterpriseProviderTranslationEquals`) to `t` for
  both fully-populated and minimal translations (see `__tests__`).
- **Forward compatible** — `deserializeEnterpriseProviderTranslation` never
  performs a structural cast (`as EnterpriseProviderTranslation`) over
  unchecked input; every field is validated
  (`validateEnterpriseProviderTranslation`) and mapped explicitly, throwing
  `EnterpriseProviderTranslationValidationError` (carrying every issue, not
  just the first) on invalid input.

---

## Phase 8 — Equality

Per this sequence's own instruction, equality derives from exactly four
fields, never from execution:

```ts
enterpriseProviderTranslationIdentityEquals(a, b) =
  a.id === b.id &&
  a.grantRef === b.grantRef &&
  a.providerSystem === b.providerSystem &&
  a.executionIntent === b.executionIntent
```

Two translations can share identity while disagreeing on every other field
(e.g. a corrected `description`, or a re-declared `capability` after a
capability-set change) — `enterpriseProviderTranslationEquals` extends
identity to every remaining declarative field (`capability`, `resource`
identity + attributes via `resourceRefIdentityEquals`, `providerMetadata`,
`translatedAt`, `correlationId`, `description`, `schemaVersion`), mirroring
`enterpriseAccessGrantEquals`/`enterpriseUsageEventEquals`'s own
identity-then-structural-equality pattern. Neither function has an
execution-shaped field to derive from — none exists on this type, at all
(Phase 10's compile-time proof).

---

## Phase 9 — Documentation

Full design rationale, API surface, relationship diagrams, and every table
above are also recorded in `packages/provider-translation/README.md`,
matching the documentation convention already established by every
R004/R005.A package (a package README for developer-facing detail, an ADR
for the architectural record).

**Purpose:** the immutable record of how an issued grant should be
translated into provider-neutral execution intent.

**Responsibilities / Non-responsibilities:** Phase 3 (this document) /
README "Explicit non-responsibilities".

**Relationship with `EnterpriseAccessGrant`:** referenced by opaque
`grantRef` only — never embedded, never modified. A grant's `principalId`,
`decisionRef`, `issuedAt`, `issuerRef`, `obligationRefs`, and `auditRefs`
are never read or carried by a translation (mirroring
`EnterpriseGrantTranslationInput`'s own exclusions).

**Relationship with `@aoc-enterprise/provider-adapter` (`ProviderAdapter`):**
this package reuses, never redefines, `EnterpriseProviderCapability` — the
capability vocabulary R005.A already froze. `EnterpriseProviderTranslation`
is the *result* a Provider Adapter would produce after reading
`EnterpriseGrantTranslationInput`/`EnterpriseGrantRevocationInterpretationInput`;
this package defines that result's shape, never the adapter that produces
it.

**Relationship with a Provider SDK:** none, and by design cannot be — see
Phase 10.

**Relationship with `EnterpriseUsageEvent`:** correlated by `grantRef`
only, emitted independently, after real Provider Execution this package
never models. This package never imports or references
`EnterpriseUsageEvent`.

**Relationship with `EnterpriseEvidenceCorrelation`:** none, directly — this
package is never imported or referenced by it, matching R005.A's own
identical boundary with that contract.

Stated plainly, once more: `EnterpriseAccessGrant` answers *"what
authorization exists?"* `EnterpriseProviderTranslation` answers *"how
should a provider attempt to realize that authorization?"* Execution
remains outside the model.

---

## Phase 10 — Negative Tests

`__tests__/enterprise-provider-translation.test.ts` proves, at compile time
(via `@ts-expect-error`, checked by `tsc -p tsconfig.test.json` before
`node --test` runs), that `EnterpriseProviderTranslation` cannot carry:

| Forbidden concept | Assertion |
|---|---|
| JWT | `_noJwt` |
| OAuth / bearer token | `_noOAuthToken` |
| Provider SDK (Pinata, S3) | `_noPinataSdk`, `_noS3Client` |
| HTTP client | `_noHttpClient` |
| URL / signed URL | `_noSignedUrl` |
| Credential / API key | `_noCredential`, `_noApiKey` |
| Network client | `_noNetworkClient` |
| Execution results (`success`) | `_noExecutionSuccess` |
| Provider responses (`httpStatus`) | `_noProviderResponse` |
| Storage objects | `_noStorageObject` |

Also proven: no retry policy, no execution/persistence callback, no
telemetry/logger field, no policy-evaluation/authorization/outcome field,
no grant-ownership (`principalId`) field, and no in-place mutation
(`readonly` fields cannot be reassigned).

---

## Phase 11 — Positive Tests

`__tests__/enterprise-provider-translation.test.ts` verifies:

- **Construction** — a fully-populated translation and a minimal,
  required-fields-only translation both construct and validate.
- **Validation** — every required-field-missing case, every closed-vocabulary
  violation (`capability`, `executionIntent`), the capability/execution-intent
  mismatch case, malformed `resource`/`translatedAt`, forbidden
  `providerMetadata` keys, and that provider/network/execution-outcome/
  existence checks are deliberately never performed.
- **Serialization / deserialization** — full and minimal round-trips,
  omission of `undefined` optional fields (never written as `null`), and
  `EnterpriseProviderTranslationValidationError` thrown with every issue on
  invalid input.
- **Immutability** — enforced at compile time (`readonly` fields; the
  reassignment `@ts-expect-error` case in Phase 10).
- **Reference integrity** — `grantRef` accepted as any well-formed,
  non-empty string, deliberately without existence-checking it.
- **Capability consistency** — every canonical execution intent validates
  only when paired with its own required capability, and is rejected
  otherwise.
- **Execution intent consistency** — `enterpriseProviderTranslationRequiredCapability`
  is exhaustively exercised over the full closed vocabulary.

All 41 tests pass — see Phase 14.

---

## Phase 12 — Future Compatibility

The model in this package is identical regardless of which provider
eventually realizes it — no provider name, SDK type, or execution detail
appears anywhere in this package's types:

| Provider | `providerSystem` (illustrative) | What a future adapter would implement at Provider Execution | What this package's model requires of it |
|---|---|---|---|
| Pinata (IPFS) | `'pinata'` | Pin/unpin, IPFS gateway URL generation | Same `EnterpriseProviderTranslation` shape, same closed execution-intent vocabulary |
| Amazon S3 | `'s3'` | Presigned `GetObject`/`PutObject` URL generation | ″ |
| Azure Blob | `'azure-blob'` | SAS token generation | ″ |
| Google Drive | `'google-drive'` | Drive API share-link/permission grant | ″ |
| SharePoint | `'sharepoint'` | Graph API sharing-link/permission grant | ″ |

No adapter is implemented by this document or this package. The model's
job is exactly to make sure none of the five ever needs a differently-shaped
translation record.

---

## Phase 13 — Blast Radius

No existing code imports this package — it is not wired into
`src/index.ts` or any public runtime export, matching the "no runtime
consumer yet" status every R004/R005.A contract already carries. Future
consumers only (none created, modified, or migrated by this change):

- A future Pinata Provider Adapter
- A future Amazon S3 Provider Adapter
- A future Azure Blob Provider Adapter
- A future Google Drive Provider Adapter
- A future SharePoint Provider Adapter
- A future Provider Conformance Suite (validating that any adapter
  implementation produces well-formed `EnterpriseProviderTranslation`
  records before attempting Provider Execution)

---

## Phase 14 — Validation

| Command | Result |
|---|---|
| `npm install` | Linked the new workspace package (`@aoc-enterprise/provider-translation`) and its `file:`-referenced dependencies (`@aoc-enterprise/provider-adapter`, `@aoc-enterprise/resource-envelope`). Passed. |
| `npx tsc -b --pretty false` (root project references) | Built every referenced package, including the new one, in dependency order. Passed with no output (clean). |
| `npm run build --workspace @aoc-enterprise/provider-translation` | Compiled the package (`tsc -p tsconfig.json`). Passed. |
| `npm test --workspace @aoc-enterprise/provider-translation` | Compiled `__tests__` under `tsconfig.test.json` (enforcing the `@ts-expect-error` negative-test proofs) and ran `node --test` against the compiled output: **41/41 tests passed, 0 failed.** |
| `npm run typecheck` (root, `tsc -b --pretty false` across every project reference) | Passed with no output (clean). |
| `npm run lint` (root: `check-node16-imports.mjs` + `lint-architecture.mjs` + `lint-public-surface.mjs`) | `Node16 import and boundary checks passed` / `Architecture lint passed` / `Public surface lint passed`. |
| `node scripts/check-duplicate-semantic-contracts.mjs` | Reports three pre-existing violations (`EnterpriseResourceEnvelope`/`SerializedEnterpriseResourceEnvelope` in `access-decision` vs. `resource-envelope`; `AgentPassport` in `agent-governance` vs. `enterprise-host-sdk`) — confirmed identical before and after this change (`git stash` diff), i.e. pre-existing on the base branch and untouched by this sequence. No name introduced by `packages/provider-translation` appears in the violation list. |
| `node scripts/check-aoc-boundaries.mjs` | `Soberanía boundary check passed`. |
| `node scripts/validate-publishability.mjs` | `Publishability validation completed successfully` (1413 shipped JS artifacts scanned, none import `@aoc/protocol` at runtime). |
| `npm test --workspaces --if-present` (every workspace, including the new package) | Exit code 0 across all workspaces; no failures. |
| `npm run build` (root, full monorepo build) | Passed with no output (clean). |

---

## Most important rule, restated

The Translation Model is an immutable execution *description*, never an
execution *engine*. It must never become a provider SDK, an execution
engine, an HTTP client, a networking layer, a storage implementation, a
workflow engine, an authorization engine, or a governance engine.
`@aoc-enterprise/provider-translation` defines the record; it implements
none of Pinata, S3, Azure Blob, Google Drive, or SharePoint, and is not
wired into `src/index.ts` or any public runtime export, matching the "no
runtime consumer yet" status every R004/R005.A contract already carries. If
a future change to this package starts to accumulate any of the
above-listed responsibilities, that is architectural drift to be reported
and reverted, not an incremental improvement to build on.

---

## Final Verdict

**R005.B COMPLETE — CANONICAL PROVIDER TRANSLATION MODEL IMPLEMENTED**
