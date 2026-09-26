# ADR: Canonical Provider Adapter Contract (R005.A)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Sequence: R005.A, Soberanía Architectural Consolidation Program
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/canonical-provider-adapter-bqa14i`
- Related: `ADR-ACCESS-LIFECYCLE.md` (R005.0, frozen input — treated as
  frozen architecture, not modified by this change), `ADR-ACCESS-GRANT.md`
  (R004.G, `EnterpriseAccessGrant`), `ADR-GRANT-REVOCATION.md` (R004.H,
  `EnterpriseGrantRevocation`), `ADR-USAGE-EVENT.md` (R004.I,
  `EnterpriseUsageEvent`), `ADR-POLICY-OBLIGATION.md` (R004.F,
  `EnterpriseAccessObligation`)

## Role of this document

This ADR records the design of `@aoc-enterprise/provider-adapter`
(`packages/provider-adapter`): the canonical, provider-neutral Provider
Adapter **contract** — capability declaration, translation-input read
views, and a closed provider-failure vocabulary. It is not a Pinata
adapter, an S3 adapter, an Azure adapter, a Google Drive adapter, or a
SharePoint adapter. It defines only the architectural contract every future
provider implementation must satisfy. `ADR-ACCESS-LIFECYCLE.md` (R005.0) is
treated as frozen architecture throughout: nothing in that document, or in
any of the seven contracts it freezes (`EnterpriseResourceEnvelope`,
`EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
`EnterpriseAccessGrant`, `EnterpriseGrantRevocation`, `EnterpriseUsageEvent`,
`EnterpriseEvidenceCorrelation`), is redesigned or modified by this change.

---

## Phase 1 — Repository Validation

| Check | Result |
|---|---|
| Repository | `architects-of-change-protocol/aoc-enterprise` |
| Branch | `claude/canonical-provider-adapter-bqa14i` (pre-existing, checked out) |
| Working tree | Clean at time of writing (no untracked/modified files) before this change |
| HEAD SHA (base) | `3145231258866d0cd28a4550a84ef786829c4bb3` (merge of PR #86, `docs(architecture): freeze Access Governance Lifecycle ADR (R005.0)`) |

The designated branch already existed and is the one this sequence commits
to — no new branch creation was required. `ADR-ACCESS-LIFECYCLE.md`
(R005.0) and all seven of the contracts it freezes are present, merged, and
treated as canonical, frozen input for this sequence.

---

## Phase 2 — Architecture Review: where Enterprise ends, where Provider execution begins

R005.0 ADR Phase 4 ("Provider Boundary") already draws this line precisely;
this sequence adopts it verbatim rather than re-deriving it:

```text
┌───────────────────────────────── ENTERPRISE ─────────────────────────────────┐
│                                                                                 │
│   EnterpriseResourceEnvelope   EnterpriseAccessDecision   EnterpriseAccessObligation │
│   EnterpriseAccessGrant        EnterpriseGrantRevocation  EnterpriseUsageEvent       │
│   EnterpriseEvidenceCorrelation                                                │
│                                                                                 │
│   Owns: Decision · Grant · Evidence · Policy (Obligation) · Usage · Revocation │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                        │  EnterpriseAccessGrant (resource,
                                        │  status, expiresAt) is the ONLY
                                        │  input a Provider Adapter reads.
                                        │  EnterpriseUsageEvent is the ONLY
                                        │  output a Provider Adapter writes
                                        │  back.
                                        ▼
┌───────────────────────────────── PROVIDER ────────────────────────────────────┐
│                                                                                 │
│   Owns: Execution · Temporary URLs · Signed URLs · Credentials · Network ·     │
│         Storage · SDK                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Where Enterprise ends:** at `EnterpriseAccessGrant` (the immutable record
that authorization *was issued*) and `EnterpriseGrantRevocation` (the
immutable record that a grant *stopped being valid, and why*). Enterprise
never crosses this line — no seven-contract field is provider-specific, and
none contacts a provider.

**Where Provider execution begins:** at "Provider Translation" — the moment
something reads `EnterpriseAccessGrant.resource`/`status`/`expiresAt` (or
`EnterpriseGrantRevocation.grantRef`/`reason`) and produces provider-specific
execution input (a presigned URL request, a scoped SDK call, a SAS
request). Provider Translation and Provider Execution are, by R005.0's own
design, never implemented by any of the seven frozen contracts and are not
implemented by this package either — `@aoc-enterprise/provider-adapter`
defines the contract for the crossing itself, never the crossing's
provider-specific contents.

The only new artifact this sequence adds to the diagram above is the
**contract** governing what may be read at the boundary and how a failure
crossing it is reported — never a new Enterprise fact, and never any
Provider execution detail.

---

## Phase 3 — Adapter Responsibilities

Exactly the responsibilities R005.0 ADR Phase 5 already named, each now
given a concrete, provider-neutral shape in `packages/provider-adapter`:

| Responsibility | Contract shape |
|---|---|
| Grant translation | `EnterpriseGrantTranslationInput` (`Pick<EnterpriseAccessGrant, 'resource' \| 'status' \| 'expiresAt'>`), `toEnterpriseGrantTranslationInput` |
| Grant interpretation | Same as above — "interpretation" and "translation" read the identical, single input view; R005.0 draws no distinction between them |
| Revocation interpretation | `EnterpriseGrantRevocationInterpretationInput` (`Pick<EnterpriseGrantRevocation, 'grantRef' \| 'reason'>`), `toEnterpriseGrantRevocationInterpretationInput` |
| Usage reporting | Not re-modeled — an adapter emits `EnterpriseUsageEvent` (`@aoc-enterprise/usage-event`) directly; `mapEnterpriseProviderFailureToUsageEventType` fixes the `eventType` mapping for the failure case |
| Capability declaration | `EnterpriseProviderCapability` (closed 8-value vocabulary), `EnterpriseProviderCapabilityDeclaration` (the immutable declaration record) |
| Provider metadata exposure | Not re-modeled — already has a home, `EnterpriseResourceEnvelope.location` (R004.D); this package adds no second one |
| Provider identifier translation | `EnterpriseProviderCapabilityDeclaration.providerSystem` (free text, mirrors `EnterpriseResourceEnvelope.location.system`) |
| Provider failure reporting | `EnterpriseProviderFailureReason` (closed 6-value vocabulary), `mapEnterpriseProviderFailureToUsageEventType` |

Nothing else is defined. No responsibility beyond this table's eight rows
is in scope for this sequence.

---

## Phase 4 — Explicit Non-Responsibilities

A Provider Adapter — and this contract — never:

- evaluates policy
- grants authorization
- creates an `EnterpriseAccessDecision`
- modifies an `EnterpriseAccessGrant`
- modifies an `EnterpriseAccessObligation`
- modifies `EnterpriseEvidenceCorrelation`
- performs auditing
- executes governance
- owns the Enterprise lifecycle

This is enforced two ways: architecturally (this package never imports,
references, or mentions `EnterpriseAccessDecision`, `EnterpriseAccessObligation`,
or `EnterpriseEvidenceCorrelation` at all — no field, function, or type in
`packages/provider-adapter/src` touches any of the three), and at compile
time for the fields it does compose (`@ts-expect-error` proofs in
`__tests__/enterprise-provider-adapter.test.ts` that
`EnterpriseProviderCapabilityDeclaration` cannot carry a provider SDK
client, an HTTP client, a credential, a signed/temporary URL, a retry
policy, a persistence method, an execution callback, a policy-evaluation
field, or a telemetry/logger field).

---

## Phase 5 — Capability Model

`EnterpriseProviderCapability` — a closed, eight-value, provider-neutral
vocabulary of **behavior**, never a provider name:

| Value | Meaning |
|---|---|
| `SupportsTemporaryAccess` | The adapter can translate a grant into time-bounded provider access. |
| `SupportsGrantRevocation` | The adapter can interpret an `EnterpriseGrantRevocation` and act on provider-side state. |
| `SupportsUsageReporting` | The adapter can emit `EnterpriseUsageEvent` records. |
| `SupportsProviderMetadata` | The adapter can populate `EnterpriseResourceEnvelope.location`-shaped metadata at registration time. |
| `SupportsCapabilityDiscovery` | The adapter can produce its own capability declaration at runtime, not only at build time. |
| `SupportsExpiration` | The adapter compares `EnterpriseAccessGrant.expiresAt` against wall-clock time itself (no frozen contract performs this comparison — R005.0 ADR Phase 5/7). |
| `SupportsCorrelation` | The adapter can associate its provider-side operations with `EnterpriseUsageEvent.correlationId`. |
| `SupportsEvidenceContribution` | The adapter can populate `EnterpriseUsageEvent.evidenceRefs`. |

No provider name appears in this vocabulary, and none ever will — a new
capability category is a `schemaVersion` change to this package, never an
open string.

`EnterpriseProviderCapabilityDeclaration` is the immutable record an
adapter uses to declare, once, which capabilities it supports, which
`EnterpriseAccessObligationType` values (`@aoc-enterprise/access-obligation`)
it can actually enforce (`supportedObligationTypes?`), and which
`providerSystem` it describes. This directly answers R005.0 ADR Phase 10,
Observation 3: *"A future Provider Adapter sequence must design where
'which obligation types can this adapter actually enforce' is declared."*

It carries the same ceremony as every frozen R004 contract:
`validateEnterpriseProviderCapabilityDeclaration` /
`validateEnterpriseProviderCapabilityDeclarationSet` (validation, including
duplicate-`id` detection across a collection),
`enterpriseProviderCapabilityDeclarationIdentityEquals` /
`enterpriseProviderCapabilityDeclarationEquals` (identity vs. full
structural equality), and `serializeEnterpriseProviderCapabilityDeclaration`
/ `deserializeEnterpriseProviderCapabilityDeclaration` (deterministic,
round-trip-safe (de)serialization) — see the package README for the full
API.

---

## Phase 6 — Translation Model

```text
 Enterprise Grant                    Provider Translation             Provider Execution
 (EnterpriseAccessGrant, frozen)      (this contract's read             (not modeled here --
                                        boundary only)                    provider-specific)
    │
    │ resource, status, expiresAt
    │ (Pick, via toEnterpriseGrantTranslationInput)
    ▼
 EnterpriseGrantTranslationInput ───────────────────────────────► (opaque: a presigned
    { resource, status, expiresAt }                                 URL, a SAS token, a
                                                                      scoped SDK call --
                                                                      each provider's own,
                                                                      unmodeled choice)
```

Every mapping this sequence documents:

| Enterprise field | Provider Translation input? | Why |
|---|---|---|
| `EnterpriseAccessGrant.resource` | Yes | Which resource access was issued for — the translation's primary subject. |
| `EnterpriseAccessGrant.status` | Yes | Whether the grant is `'active'` — a translation must refuse an already-`'revoked'` grant. |
| `EnterpriseAccessGrant.expiresAt` | Yes | The wall-clock bound a `SupportsExpiration` adapter compares itself against. |
| `EnterpriseAccessGrant.id` | No | Enterprise-owned identity metadata; no translation need. |
| `EnterpriseAccessGrant.decisionRef` | No | Points at policy evaluation, irrelevant to provider execution. |
| `EnterpriseAccessGrant.principalId` | No | *Who* was granted access is out of scope for a provider-neutral translation contract to standardize; a provider-specific identity mapping, if any, is entirely the adapter's own concern. |
| `EnterpriseAccessGrant.issuedAt` | No | Audit metadata; only `expiresAt` bounds translation validity. |
| `EnterpriseAccessGrant.correlationId` | No | Audit-trail metadata, not translation input. |
| `EnterpriseAccessGrant.issuerRef?` / `obligationRefs?` / `auditRefs?` | No | Audit/issuance metadata; no translation need. |
| `EnterpriseGrantRevocation.grantRef` | Yes | Which grant a revocation interpretation applies to. |
| `EnterpriseGrantRevocation.reason` | Yes | What a revocation interpretation decides to do on the provider's own side. |
| `EnterpriseGrantRevocation.id` / `revokedAt` / `issuerRef` / `correlationId` / `evidenceRefs?` / `description?` | No | Audit/identity metadata; no interpretation need. |

**No Provider Translation *output* type, and no Provider Execution type, is
defined anywhere in this package.** Both are provider-specific by
construction (a presigned URL is not the same shape as a SAS token, an IPFS
CID, or a Graph API permission grant) and are explicitly excluded by the
non-negotiable rules governing this sequence (no URLs, no signed URLs, no
SDK clients, no HTTP, no execution).

---

## Phase 7 — Failure Contract

`EnterpriseProviderFailureReason` — a closed, six-value, provider-neutral
vocabulary:

| Value | Meaning |
|---|---|
| `provider-unavailable` | The provider could not be reached at all. |
| `capability-unsupported` | The requested behavior is outside this adapter's own declared `EnterpriseProviderCapability` set. |
| `execution-rejected` | The provider was reached but declined to carry out the translated request. |
| `grant-expired` | The adapter compared `EnterpriseAccessGrant.expiresAt` against wall-clock time and refused to translate or honor a lapsed grant. |
| `provider-timeout` | The provider did not respond within whatever bound the adapter itself enforces. |
| `unexpected-provider-failure` | Any other provider-side failure not fitting the other five categories. |

`mapEnterpriseProviderFailureToUsageEventType` — the pure, total,
deterministic mapping onto the frozen, closed `EnterpriseUsageEventType`
vocabulary (`@aoc-enterprise/usage-event`), per R005.0 ADR Phase 5
("Failure reporting: ... reported as an `EnterpriseUsageEvent` with
`eventType: 'AccessFailed'` ... or `'AccessDenied'` ... never as a
`success`/`httpStatus`/provider-response field"):

| `EnterpriseProviderFailureReason` | Reported `EnterpriseUsageEventType` |
|---|---|
| `grant-expired` | `AccessExpired` |
| `capability-unsupported` | `AccessDenied` |
| `execution-rejected` | `AccessDenied` |
| `provider-unavailable` | `AccessFailed` |
| `provider-timeout` | `AccessFailed` |
| `unexpected-provider-failure` | `AccessFailed` |

No retry logic is defined (no attempt count, backoff, or scheduling type
exists in this package). No networking is defined (no HTTP client, socket,
or timeout-duration type exists in this package). An adapter decides, in
its own provider-specific code, when to classify an observation as
`provider-timeout` vs. `provider-unavailable`, and whether or how to retry
before doing so; this contract only fixes the vocabulary and the reporting
mapping once that decision has already been made.

---

## Phase 8 — Lifecycle Integration

How a Provider Adapter interacts with each of the four contracts named by
this sequence, without ever modifying ownership:

| Frozen contract | Interaction | Ownership preserved |
|---|---|---|
| `EnterpriseAccessGrant` | Read-only, via `EnterpriseGrantTranslationInput` (`resource`/`status`/`expiresAt` only) | Enterprise remains sole owner of issuance; `status` moving to `'revoked'` is a future Enterprise-produced snapshot, never adapter-written. |
| `EnterpriseGrantRevocation` | Read-only, via `EnterpriseGrantRevocationInterpretationInput` (`grantRef`/`reason` only) | Enterprise remains sole owner of the recorded fact that a grant is no longer valid; an adapter never creates a revocation record. |
| `EnterpriseUsageEvent` | Write-only (emit) — the adapter is the actual observer of real provider access | Enterprise remains sole owner of the frozen `EnterpriseUsageEventType` vocabulary; `mapEnterpriseProviderFailureToUsageEventType` only selects among already-canonical values, never invents one. |
| `EnterpriseEvidenceCorrelation` | No direct interaction | An adapter contributes evidence only indirectly, by being the eventual producer of `EnterpriseUsageEvent` records some future correlation graph's `usageRefs` may reference. This package never imports or references `EnterpriseEvidenceCorrelation`. |

---

## Phase 9 — Future Compatibility (conceptual only)

The contract is identical regardless of which provider eventually
implements it — no provider name, SDK type, or execution detail appears
anywhere in `packages/provider-adapter/src`.

```text
 EnterpriseProviderCapabilityDeclaration.providerSystem (free string, illustrative)
   'pinata' | 's3' | 'azure-blob' | 'google-drive' | 'sharepoint'
        │              │              │                │              │
        ▼              ▼              ▼                ▼              ▼
   ┌─────────┐    ┌─────────┐    ┌──────────┐     ┌──────────┐  ┌────────────┐
   │ Pinata  │    │   S3    │    │  Azure   │     │  Google  │  │ SharePoint │
   │ (IPFS)  │    │         │    │  Blob    │     │  Drive   │  │            │
   └─────────┘    └─────────┘    └──────────┘     └──────────┘  └────────────┘
   Pin/unpin,      Presigned      SAS token         Drive API     Graph API
   IPFS gateway    GetObject/     generation         share-link/   sharing-
   URL generation  PutObject                         permission    link/
                   URL generation                    grant         permission
                                                                    grant

   Every one of the five reads the identical EnterpriseGrantTranslationInput /
   EnterpriseGrantRevocationInterpretationInput shape, declares capabilities from
   the identical EnterpriseProviderCapability vocabulary, and reports failures
   through the identical EnterpriseProviderFailureReason → EnterpriseUsageEventType
   mapping. Only Provider Translation/Execution (unmodeled, provider-specific)
   differs per provider.
```

No adapter is implemented by this document or this package. The contract's
job is exactly to make sure none of the five ever needs to be implemented
differently.

---

## Phase 10 — Documentation

Full design rationale, API surface, relationship diagrams, and every table
above are also recorded in `packages/provider-adapter/README.md`, matching
the documentation convention already established by all seven R004
packages (a package README for developer-facing detail, an ADR for the
architectural record). This ADR and that README intentionally overlap in
content — the README is the canonical reference once this contract is in
active use; this ADR is the point-in-time architectural decision record.

---

## Phase 11 — Validation

| Command | Purpose |
|---|---|
| `npm install` | Link the new workspace package (`@aoc-enterprise/provider-adapter`) and its `file:`-referenced dependencies (`@aoc-enterprise/access-grant`, `@aoc-enterprise/access-obligation`, `@aoc-enterprise/grant-revocation`, `@aoc-enterprise/usage-event`). |
| `npm run build --workspace @aoc-enterprise/provider-adapter` | Compiles the package (also exercises the project-reference build via `tsc -b` at the repo root). |
| `npm test --workspace @aoc-enterprise/provider-adapter` | Compiles `__tests__` under `tsconfig.test.json` (this is where the `@ts-expect-error` negative-test proofs are enforced) and runs `node --test` against the compiled output. |
| `npm run typecheck` (root) | `tsc -b --pretty false` across every project reference, including the new package added to `tsconfig.json`'s `references`. |
| `npm run lint` (root) | `check-node16-imports.mjs` + `lint-architecture.mjs` (no explicit `any`) + `lint-public-surface.mjs`. |
| `node scripts/check-duplicate-semantic-contracts.mjs` | Confirms no type/interface/const name in `packages/provider-adapter/src` collides with any other non-canonical package. |
| `node scripts/check-aoc-boundaries.mjs` | Confirms no Soberanía boundary violation was introduced. |
| `node scripts/validate-publishability.mjs` | Confirms the new package's `package.json` (`main`, `types`, `exports`, `files`) is publishable-shaped, matching every other `packages/*` entry. |

Every command's actual output for this change is recorded in the pull
request description under "Validation."

---

## Most important rule, restated

A Provider Adapter is a translator. Nothing more. It must never become a
governance engine, an authorization engine, an audit engine, a provider
SDK, a storage implementation, a runtime service, a workflow engine, or an
orchestration layer. `@aoc-enterprise/provider-adapter` defines the
contract; it implements none of Pinata, S3, Azure Blob, Google Drive, or
SharePoint, and is not wired into `src/index.ts` or any public runtime
export, matching the "no runtime consumer yet" status every one of the
seven R004 contracts already carries.

---

## Final Verdict

**R005.A COMPLETE — CANONICAL PROVIDER ADAPTER CONTRACT IMPLEMENTED**
