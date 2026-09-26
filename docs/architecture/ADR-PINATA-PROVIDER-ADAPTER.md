# ADR: Pinata Provider Adapter (R005.C)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Sequence: R005.C, Soberanía Architectural Consolidation Program
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/pinata-provider-adapter-oxtgdr`
- Related: `ADR-ACCESS-LIFECYCLE.md` (R005.0, frozen input), `ADR-PROVIDER-ADAPTER-CONTRACT.md`
  (R005.A, frozen input), `ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B, frozen
  input)

## Role of this document

This ADR records the design of `@aoc-enterprise/pinata-adapter`
(`packages/pinata-adapter`): the **first concrete Provider Adapter**
implementation, targeting Pinata. `ADR-ACCESS-LIFECYCLE.md` (R005.0),
`ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A), and
`ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B) are treated as frozen
architecture throughout: nothing in any of those documents, or in any
contract they freeze or define, is redesigned, renamed, or modified by this
change.

Pinata is not a special case. This package exists to prove that the
Provider Adapter architecture those three sequences already froze can be
implemented for a real provider without changing it. If implementing Pinata
had required changing any Enterprise concept, this sequence would have
stopped and reported architectural drift instead of proceeding -- see Phase
2 below and the package README's "Architecture validation."

---

## Phase 1 — Repository Validation

| Check | Result |
|---|---|
| Repository | `architects-of-change-protocol/aoc-enterprise` |
| Branch | `claude/pinata-provider-adapter-oxtgdr` (pre-existing, checked out) |
| Working tree | Clean at time of writing (no untracked/modified files) before this change |
| HEAD SHA (base) | `eb7a5b95d519e9d568c7007c2c2186dde3fe6119` (merge of PR #88, `feat(access-governance): add canonical Provider Translation Model (R005.B)`) |

The designated branch already existed and is the one this sequence commits
to. `ADR-ACCESS-LIFECYCLE.md` (R005.0), `ADR-PROVIDER-ADAPTER-CONTRACT.md`
(R005.A), `ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B), and every contract
any of those three freeze or define are present, merged, and treated as
canonical, frozen input for this sequence.

---

## Phase 2 — Architecture Validation

`Grant -> Translation -> Provider Adapter -> Pinata` was checked, before any
code was written, against every constraint the three frozen ADRs already
impose:

| Constraint (from R005.0/R005.A/R005.B) | How Pinata satisfies it without architecture change |
|---|---|
| A Provider Adapter's *only* input from Enterprise's owned contracts is `EnterpriseAccessGrant` (`resource`/`status`/`expiresAt`) or `EnterpriseGrantRevocation` (`grantRef`/`reason`) (R005.0 Phase 4). | This package goes one step further and reads neither directly -- its own "Primary Objective" restricts it to consuming only the already-produced `EnterpriseProviderTranslation` (R005.B's own output type), which is itself derived from that same restricted read view. No widening of the read boundary was needed. |
| Capability declaration must come from the closed, reused `EnterpriseProviderCapability` vocabulary (R005.A Phase 5), never a provider-specific value. | `PINATA_SUPPORTED_CAPABILITIES` selects a subset of the existing eight values; zero new values were added. |
| Execution intent must come from the closed, reused `EnterpriseProviderTranslationExecutionIntent` vocabulary (R005.B Phase 4), never a provider-specific value (the ADR's own example: no `'PinPinataObject'`). | This package switches on the existing five values; zero new execution intents were added. |
| A Provider Adapter never invents a new `EnterpriseUsageEventType`, obligation type, or revocation reason (R005.0/R005.A). | This package emits no `EnterpriseUsageEvent` at all (out of scope by its own non-negotiable rules) and selects `supportedObligationTypes` only from the existing eight-value `EnterpriseAccessObligationType` vocabulary. |
| Provider Translation's *output* is deliberately unmodeled by R005.A/R005.B; Provider Execution is provider-specific by construction. | `PinataProviderExecutionResult` is this package's own, new, provider-specific type -- exactly the "Provider Execution" layer R005.0/R005.A/R005.B leave for a real adapter to define. Defining it is not architecture change; it is filling the gap those ADRs named and left open on purpose. |
| Only a Provider Adapter's own module may import a provider SDK; no Enterprise contract may. | `pinata` is imported by exactly one file, `packages/pinata-adapter/src/pinata-provider-client.ts` -- proven, not merely asserted, by `scripts/check-pinata-boundary.mjs` (Phase 8 below). |

No constraint required weakening, and no Enterprise contract required a new
field, state, or vocabulary entry. **Architecture change was not necessary.**
This sequence proceeded to implementation rather than stopping to report
drift.

---

## Phase 3 — Adapter Responsibilities

Implemented, and only, the six responsibilities R005.C's own task language
names:

| Responsibility | Where |
|---|---|
| Translation consumption | `executePinataProviderTranslation` accepts a candidate `EnterpriseProviderTranslation` (as `unknown`, guarded by `validateEnterpriseProviderTranslation` from `@aoc-enterprise/provider-translation`) |
| Capability validation | `enterpriseProviderTranslationRequiredCapability(executionIntent)` is checked against `PINATA_SUPPORTED_CAPABILITIES` before any Pinata call is attempted; unsatisfiable capabilities return `capability-unsupported`, never a faked success |
| Execution intent mapping | A `switch` over the closed, five-value `EnterpriseProviderTranslationExecutionIntent` vocabulary, each arm mapped to one Pinata operation (see Phase 5) |
| Pinata SDK invocation | `PinataProviderClient` (`src/pinata-provider-client.ts`), a real implementation over the official `pinata` npm SDK |
| Provider metadata extraction | The `ProvideMetadata` arm surfaces Pinata's own file metadata (name, cid, size, mime type, keyvalues, created-at) -- never the resource's bytes |
| Execution result normalization | Every outcome -- success or failure -- is returned as a `PinataProviderExecutionResult`; no raw Pinata SDK response, HTTP status, or exception ever escapes `executePinataProviderTranslation` |

No Enterprise logic (policy evaluation, authorization, decision creation,
grant/obligation/evidence mutation, auditing, `EnterpriseUsageEvent`
generation, orchestration, workflow engines, retries, queues, REST APIs,
persistence, databases, caching) is implemented anywhere in this package,
per R005.C's own non-negotiable rules.

---

## Phase 4 — Capability Support

Only capabilities Pinata can genuinely satisfy are declared. See the package
README's "Supported capabilities" / "Unsupported capabilities" for the full
table and reasoning; summarized here:

**Supported:** `SupportsTemporaryAccess`, `SupportsProviderMetadata`,
`SupportsGrantRevocation`, `SupportsCapabilityDiscovery`,
`SupportsCorrelation`, `SupportsEvidenceContribution`.

**Unsupported, and never faked:**

- `SupportsUsageReporting` -- Pinata has no API asking the provider itself to
  record, on its own side, that a grant is being exercised. A translation
  whose `executionIntent` is `'RegisterUsage'` (which requires this
  capability, per `enterpriseProviderTranslationRequiredCapability`) always
  returns a `PinataProviderExecutionFailure` with `failureReason:
  'capability-unsupported'` -- proven by this package's own test suite,
  including a test asserting the Pinata client is never even contacted for
  this case.
- `SupportsExpiration` -- this adapter consumes only
  `EnterpriseProviderTranslation`, which carries no `expiresAt` field by
  R005.B's own design; performing that wall-clock comparison would require
  reading `EnterpriseAccessGrant` directly, which is out of scope for this
  sequence's "Adapter MUST consume: EnterpriseProviderTranslation ... Nothing
  else."

`supportedObligationTypes` is populated with exactly the two
`EnterpriseAccessObligationType` values Pinata's own primitives can enforce:
`read-only` (a signed access link only ever serves bytes over HTTP GET) and
`time-limit` (a signed access link's own `expires` parameter). The remaining
six (`watermark-content`, `no-download`, `require-mfa`, `require-approval`,
`record-usage`, `require-acceptance`) are not included -- each is a
capability no Pinata primitive can genuinely back, documented individually in
the package README.

---

## Phase 5 — Execution Intent Mapping

| `EnterpriseProviderTranslationExecutionIntent` | Pinata operation |
|---|---|
| `ProvideTemporaryAccess` | `gateways.private.createAccessLink({ cid, expires })` -- a Pinata signed access link |
| `ProvideReadOnlyAccess` | Same as `ProvideTemporaryAccess` -- a signed access link only ever grants read access; there is no separate Pinata read-only primitive to distinguish it by |
| `ProvideMetadata` | `files.public.get(resourceId)` -- Pinata's metadata API |
| `InvalidateGrant` | `files.public.delete([resourceId])` -- the nearest valid provider operation, since Pinata has no distinct "revoke a grant" primitive (matching `ADR-ACCESS-LIFECYCLE.md`'s own worked example: `resource-removed -> unpin/delete a provider object`) |
| `RegisterUsage` | No mapping exists -- returns `CapabilityUnsupported` (Phase 4) |

`translation.resource.id` is read as the Pinata identifier the operation
needs -- a CID for the signed access link, Pinata's own file id for
metadata/delete. This mirrors the frozen `@aoc-enterprise/provider-translation`
package's own test fixture (`resource: { kind: 'ipfs-object', id: 'Qm123' }`),
which already uses a CID directly as `resource.id`. See the package README's
"Pinata-specific decisions" for the full rationale, including why
`providerMetadata.requestedDurationSeconds` is required (never defaulted) for
the two temporary-access intents.

---

## Phase 6 — Execution Result

Every Pinata response is normalized before it leaves this package.
`PinataProviderExecutionSuccess.detail` is a closed, three-variant
discriminated union (`temporary-access`, `metadata`, `grant-invalidated`),
each carrying only plain, already-normalized fields -- never a raw Pinata SDK
response object, a `FileListItem`, a `DeleteResponse`, or any other
Pinata-specific type. `ProvideMetadata`'s `metadata` field is restricted to
JSON primitives (mirroring `EnterpriseProviderTranslationMetadataValue`),
flattening Pinata's `keyvalues` map into individually-prefixed keys rather
than nesting a Pinata-shaped object.

---

## Phase 7 — Failure Mapping

Every Pinata SDK failure is classified, inside `pinata-provider-client.ts`
only, onto the closed, reused `EnterpriseProviderFailureReason` vocabulary
(`@aoc-enterprise/provider-adapter`) -- never a new failure category:

| Pinata SDK failure | `EnterpriseProviderFailureReason` |
|---|---|
| `NetworkError` | `provider-unavailable` |
| `AuthenticationError` | `execution-rejected` |
| `ValidationError` | `execution-rejected` |
| `PinataError` (`statusCode` 408 or 429) | `provider-timeout` |
| `PinataError` (`statusCode >= 500`) | `provider-unavailable` |
| `PinataError` (other status codes) | `execution-rejected` |
| Any other thrown value | `unexpected-provider-failure` |

`PinataProviderExecutionFailure.message` is always a plain string; no HTTP
status code, SDK exception object, provider stack trace, or other
provider-specific object is ever attached to a returned result, verified by
this package's own negative tests (`never returns a raw client object, HTTP
status, or stack trace on the failure result`). A malformed or invalid
translation (fails `validateEnterpriseProviderTranslation`, or targets a
`providerSystem` other than `'pinata'`) is a programming-contract violation
and is thrown as `PinataAdapterInputError`, never returned as a
`PinataProviderExecutionFailure`.

---

## Phase 8 — Boundary Validation

- **No Enterprise contract imports Pinata.** Verified by
  `scripts/check-pinata-boundary.mjs` (run as part of this package's own
  `npm test`, and independently as `npm run check:pinata-boundary`), which
  scans every `packages/*/src` other than `pinata-adapter` and the
  repository-root `src/` tree for a `pinata` import and fails on any match.
- **Only the Adapter imports Pinata.** The same script asserts the `pinata`
  import set within `packages/pinata-adapter/src` is exactly one file:
  `pinata-provider-client.ts`.
- **Dependency direction.** `pinata-provider-adapter.ts` (orchestration)
  depends on `pinata-provider-client.ts` (the Pinata SDK wrapper); nothing
  depends the other way. `pinata-provider-adapter.ts` never imports `pinata`
  itself, only the narrow `PinataProviderClient` interface and
  `PinataProviderClientError` (this package's own types).

---

## Phase 9 — Documentation

Full design rationale, the complete supported/unsupported capability and
obligation tables, the execution-flow diagram, Pinata-specific decisions,
and known limitations are recorded in `packages/pinata-adapter/README.md`,
matching the documentation convention every R004/R005 package already
establishes (a package README for developer-facing detail, an ADR for the
architectural record).

---

## Phase 10 — Tests

`packages/pinata-adapter/__tests__/`:

- `pinata-provider-adapter.test.ts` -- positive (successful `ProvideTemporaryAccess`/
  `ProvideReadOnlyAccess`/`ProvideMetadata`/`InvalidateGrant` execution,
  capability declaration shape) and negative (`RegisterUsage` returns
  `capability-unsupported` and never contacts the client; malformed
  translation; translation targeting a non-Pinata `providerSystem`; missing
  `requestedDurationSeconds`; classified provider-unavailable failure;
  unclassified generic-error failure normalized to
  `unexpected-provider-failure`; no raw error/HTTP-status/stack-trace ever
  returned) coverage, entirely against a fake `PinataProviderClient` -- no
  test contacts a real Pinata endpoint or requires a real credential.
- `pinata-provider-client.test.ts` -- `PinataProviderClientError` shape and
  `createPinataProviderClient`'s constructed surface.
- `pinata-boundary.test.ts` responsibilities are covered by
  `scripts/check-pinata-boundary.mjs`, run as the final step of this
  package's own `npm test` (a compile-time-adjacent, repository-wide proof
  rather than a `tsc`-compiled assertion, since this repository's
  `types/node-shims.d.ts` ambient declarations deliberately do not cover
  `node:fs`/`node:path` for compiled package sources).

20 tests across 8 suites pass; see Phase 11 for the exact command and
output.

---

## Phase 11 — Validation

| Command | Result |
|---|---|
| `npm install` | Linked the new workspace package (`@aoc-enterprise/pinata-adapter`), its `file:`-referenced dependencies (`@aoc-enterprise/access-obligation`, `@aoc-enterprise/provider-adapter`, `@aoc-enterprise/provider-translation`), and its one real dependency, `pinata@^2.1.0`. Passed. |
| `npm run build` (root, `tsc -b --pretty false` across every project reference, including the new package added to `tsconfig.json`'s `references`) | Passed with no output (clean). |
| `npm run build --workspace @aoc-enterprise/pinata-adapter` | Compiled the package. Passed. |
| `npm test --workspace @aoc-enterprise/pinata-adapter` | Compiled `__tests__` under `tsconfig.test.json`, ran `node --test` against the compiled output (**20/20 tests passed, 0 failed**, across 8 suites), then ran `scripts/check-pinata-boundary.mjs` (passed: `pinata` imported only by `pinata-provider-client.ts`). |
| `npm run typecheck` (root, `tsc -b --pretty false`) | Passed with no output (clean). |
| `npm run lint` (root: `check-node16-imports.mjs` + `lint-architecture.mjs` + `lint-public-surface.mjs`) | `Node16 import and boundary checks passed` / `Architecture lint passed` / `Public surface lint passed`. |
| `node scripts/check-aoc-boundaries.mjs` | `Soberanía boundary check passed`. |
| `node scripts/check-duplicate-semantic-contracts.mjs` | Reports the same three pre-existing violations already documented as pre-existing by `ADR-PROVIDER-TRANSLATION-MODEL.md` Phase 14 (`EnterpriseResourceEnvelope`/`SerializedEnterpriseResourceEnvelope` in `access-decision` vs. `resource-envelope`; `AgentPassport` in `agent-governance` vs. `enterprise-host-sdk`) -- none introduced by `packages/pinata-adapter`. |
| `node scripts/validate-publishability.mjs` | `Publishability validation completed successfully` (1413 shipped JS artifacts scanned, none import `@aoc/protocol` at runtime). |
| `npm test --workspaces --if-present` (every workspace, including the new package) | Exit code 0 across all workspaces; no failures. |
| `npm test` (root, full suite: root build + root tests + all workspace tests) | 268/268 root tests passed; all workspace `test` scripts, including `@aoc-enterprise/pinata-adapter`, passed. |

---

## Acceptance Criteria

- [x] Adapter consumes `EnterpriseProviderTranslation`
- [x] Adapter does NOT consume Enterprise domain directly (never reads
      `EnterpriseAccessGrant`/`EnterpriseGrantRevocation`, never imports
      `EnterpriseAccessDecision`/`EnterpriseAccessObligation`/`EnterpriseEvidenceCorrelation`)
- [x] Adapter executes the Pinata SDK (`pinata-provider-client.ts`)
- [x] Adapter normalizes responses (`PinataProviderExecutionResult`)
- [x] Adapter normalizes failures (`EnterpriseProviderFailureReason`, reused)
- [x] No provider leakage (Phase 8)
- [x] No Enterprise modifications (Phase 2; zero files outside
      `packages/pinata-adapter`, `docs/architecture/`, and `tsconfig.json`'s
      `references` array touched)
- [x] Tests pass (Phase 10/11)
- [x] Documentation updated (Phase 9)
- [x] One Pull Request

---

## Most important rule, restated

This implementation is not a Pinata integration. It is the first validation
of the Provider Adapter architecture. Implementing Pinata required no change
to any Enterprise concept -- the architecture adapted to nothing; Pinata
adapted to the architecture. If a future provider genuinely cannot be
implemented without changing `EnterpriseAccessGrant`,
`EnterpriseProviderCapability`, `EnterpriseProviderTranslationExecutionIntent`,
or any other frozen contract, that is architectural drift to be reported as
a new sequence proposing a change to the relevant frozen ADR -- never an
implementation detail smuggled into a Provider Adapter package.

---

## Final Verdict

**R005.C COMPLETE — FIRST REFERENCE PROVIDER ADAPTER IMPLEMENTED**
