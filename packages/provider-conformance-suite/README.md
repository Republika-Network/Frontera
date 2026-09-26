# @aoc-enterprise/provider-conformance-suite

The canonical, provider-neutral **Provider Conformance Suite** (R005.D). This
package defines the official compliance tests every future Provider Adapter
implementation (Pinata, S3, Azure Blob, Google Drive, SharePoint, Dropbox, or
any other) must pass to participate in the frozen Access Governance lifecycle
(`docs/architecture/ADR-ACCESS-LIFECYCLE.md`, R005.0).

**This is not a provider. It is not an adapter. It is not a test for
Pinata.** No provider SDK, HTTP client, credential, or execution logic exists
anywhere in this package's production code (`src/`). It defines the
provider-neutral verification rules every adapter is certified against.

## Purpose

`ADR-ACCESS-LIFECYCLE.md` (R005.0) froze seven immutable Enterprise
contracts. `ADR-PROVIDER-ADAPTER-CONTRACT.md` (R005.A) froze the read
boundary and failure vocabulary a Provider Adapter may use.
`ADR-PROVIDER-TRANSLATION-MODEL.md` (R005.B) froze the immutable
intermediate record — `EnterpriseProviderTranslation` — a translation
produces. `ADR-PINATA-PROVIDER-ADAPTER.md` (R005.C) proved that architecture
could be implemented for a real provider without changing it. R005.B's own
Phase 13 named exactly what remained missing:

> *"A future Provider Conformance Suite (validating that any adapter
> implementation produces well-formed `EnterpriseProviderTranslation`
> records before attempting Provider Execution)."*

This package is that suite. Every future Provider Adapter — not just
Pinata — is validated against it, using the identical harness shape and the
identical set of checks, never a bespoke per-provider test plan.

## Certification philosophy

**Future providers do not define compliance. They prove compliance against
this suite.** An adapter becomes "conformant" by building an
`EnterpriseProviderConformanceHarness` around its own already-implemented
capability declaration and `execute` function, and calling
`runEnterpriseProviderConformanceSuite(harness)`. The suite itself is never
modified to accommodate a new provider — a new provider is accepted or
rejected exactly as the suite already stands. `docs/architecture/ADR-PINATA-PROVIDER-ADAPTER.md`
already established the precedent this suite generalizes: *"If implementing
[a provider] had required changing any Enterprise concept, this sequence
would have stopped and reported architectural drift instead of proceeding."*
The same discipline applies here, forever: **the suite must remain
provider-neutral forever.**

## What this package defines

### 1. The certification harness

`EnterpriseProviderConformanceHarness` is what an adapter under test
supplies:

| Field | Purpose |
| --- | --- |
| `providerSystem` | Free-text provider identifier under test (mirrors `EnterpriseResourceEnvelope.location.system`) — never a closed enum. |
| `capabilityDeclaration` | The adapter's own, already-built `EnterpriseProviderCapabilityDeclaration` (`@aoc-enterprise/provider-adapter`, reused, never redefined). |
| `execute` | The adapter's own translation-consuming execution entrypoint, `(candidate: unknown) => Promise<EnterpriseProviderConformanceExecutionResult>` — mirrors `executePinataProviderTranslation`'s own `accepts unknown` convention. |
| `providerMetadataFor?` | Supplies provider-specific `providerMetadata` a canonical fixture translation needs to succeed (e.g. Pinata's own `requestedDurationSeconds`) — the suite is provider-neutral and cannot guess this itself. |
| `translateExpiredGrant?` | **Required whenever `SupportsExpiration` is declared** — proves the adapter refuses to translate/honor an expired grant. A declared capability without this hook fails certification rather than being silently skipped. |
| `boundaryEvaluation?` | **Required for certification** — the result of a real filesystem SDK-import scan, wired in by the adapter's own boundary script (see "Boundary validation" below). Omitting it fails the check; certification requires proof, not an assumption. |

**Adapter shapes this version certifies.** This suite certifies the
*translation-consuming* Provider Adapter shape R005.C's own reference
implementation (`@aoc-enterprise/pinata-adapter`) established — an adapter
whose entrypoint consumes an already-produced `EnterpriseProviderTranslation`
(R005.B), never an `EnterpriseAccessGrant` directly. A future adapter shape
that instead directly consumes `EnterpriseGrantTranslationInput`/
`EnterpriseGrantRevocationInterpretationInput` (R005.A) — translating a raw
grant rather than an already-produced translation — is a distinct shape this
version does not yet certify. This is a documented scope boundary, not a
silently-assumed one: extending the harness to cover that shape is a future,
additive sequence, never a redesign of what already exists here.

### 2. The canonical execution-result envelope

R005.A and R005.B both deliberately leave Provider Execution's *output*
unmodeled ("provider-specific by construction"). A conformance suite that
must certify "execution normalization" needs a minimal, provider-neutral
shape to normalize *against*. `EnterpriseProviderConformanceExecutionResult`
(`EnterpriseProviderConformanceExecutionSuccess |
EnterpriseProviderConformanceExecutionFailure`) is that shape — this suite's
own, additive, `schemaVersion`-carried contribution, never a widening of
R005.A/R005.B's own frozen scope:

```text
EnterpriseProviderConformanceExecutionSuccess          EnterpriseProviderConformanceExecutionFailure
{ outcome: 'executed',                                 { outcome: 'failed',
  translationId, grantRef, correlationId,                translationId, grantRef, correlationId,
  executionIntent, providerSystem,                        executionIntent, providerSystem,
  detail,        <- JSON-safe, provider-neutral            failureReason, <- closed EnterpriseProviderFailureReason
  executedAt }                                              message, failedAt }
```

`@aoc-enterprise/pinata-adapter`'s own `PinataProviderExecutionResult`
independently converged on this exact shape before this suite existed — the
envelope formalizes a pattern reference implementation already established,
rather than inventing one from scratch.

### 3. Boundary evaluation

`evaluateEnterpriseProviderConformanceBoundary` is a pure comparison
function any adapter's own filesystem-scanning boundary script (e.g.
`packages/pinata-adapter/scripts/check-pinata-boundary.mjs`) can reuse: given
three already-collected file lists (allowed importers, actual importers
within the adapter, foreign importers elsewhere in the repo), it returns
`{ valid: true }` or a structured list of issues. This suite performs no
filesystem access itself — a provider-neutral certification library has no
business walking a repository's directory tree — so wiring a real scan in is
each adapter's own responsibility, exactly as `check-pinata-boundary.mjs`
already does independently of this package.

### 4. The runner

`runEnterpriseProviderConformanceSuite(harness)` runs every check below and
returns an `EnterpriseProviderConformanceReport`: a `schemaVersion`, the
`providerSystem` under test, a `generatedAt` timestamp, the full list of
`EnterpriseProviderConformanceCheck` records (`category`, `id`,
`description`, `status: 'passed' | 'failed' | 'skipped'`, optional `detail`),
and `passed` (`true` iff no check has status `'failed'` — a `'skipped'`
check never blocks certification; it records a legitimately not-applicable
case, always with a `description` explaining why). Never throws for a
non-conformant adapter — every failure mode becomes a `'failed'` check in
the report.

## Conformance categories

| Category | What it verifies |
| --- | --- |
| **Translation acceptance** | A canonical, valid translation is accepted (never thrown on) whether or not its capability is declared; a structurally malformed candidate is rejected, never silently accepted. |
| **Capability validation** | The adapter's own capability declaration validates against the closed vocabulary; an execution intent whose required capability is undeclared is rejected with `capability-unsupported`, never faked as a success. |
| **Failure normalization** | Every failure result carries exactly the canonical failure fields (no HTTP status, stack trace, or SDK exception leaks), a `failureReason` from the closed `EnterpriseProviderFailureReason` vocabulary, and a plain string `message`. |
| **Execution normalization** | Every result echoes the originating translation's own `translationId`/`grantRef`/`correlationId`/`executionIntent`/`providerSystem`; a success result carries exactly the canonical success fields. |
| **Metadata normalization** | A success result's `detail` is a JSON-safe, provider-neutral bag of data (never a raw provider SDK object). |
| **Boundary validation** | The provider SDK is imported only by the adapter's own declared file(s) — never by an Enterprise contract or another adapter. Required for certification; omitting proof fails, never skips. |
| **Dependency validation** | An execution intent's declared `capability` matches what `enterpriseProviderTranslationRequiredCapability` actually requires; an adapter declaring `SupportsExpiration` genuinely refuses an expired grant, with a canonical failure shape. |
| **Serialization consistency** | Every translation and the capability declaration itself survive `serialize -> JSON round-trip -> deserialize` unchanged. |
| **Provider neutrality** | The capability declaration's `providerSystem` matches the harness under test; every declared capability is a member of the closed, provider-neutral vocabulary; a translation targeting a foreign `providerSystem` is rejected, never executed. |

## Boundary validation — wiring in a real filesystem scan

This suite performs no filesystem access itself, but boundary proof is
required for certification — omitting it fails the check, it does not skip.
To exercise the `boundary-validation` category, an adapter's own boundary
script (mirroring `packages/pinata-adapter/scripts/check-pinata-boundary.mjs`)
collects three file lists via a real scan and calls
`evaluateEnterpriseProviderConformanceBoundary`, then passes the result as
`harness.boundaryEvaluation`. A harness that has not yet wired this in fails
the check, with a `description` explaining that no evaluation was
supplied.

## How adapters become compliant

1. Build (or reuse) the adapter's own capability declaration and
   translation-consuming `execute` function — no new code specific to this
   suite is required if the adapter already follows the R005.A/R005.B/R005.C
   pattern.
2. Construct an `EnterpriseProviderConformanceHarness` around them, supplying
   `providerMetadataFor` for any execution intent that needs provider-specific
   metadata to succeed.
3. Call `runEnterpriseProviderConformanceSuite(harness)` from the adapter's
   own test suite (as a devDependency), against a fake client — exactly as
   `packages/pinata-adapter`'s own tests already do, never against a real
   provider endpoint.
4. Assert `report.passed === true` and inspect `report.checks` for any
   `'failed'` entry's `detail`.

No adapter package is modified by this sequence to prove this — see
"Reference execution" below for how Pinata was certified without touching
`packages/pinata-adapter` at all.

## Reference execution (R005.D Phase 10)

`__tests__/reference-pinata-conformance.test.ts` is the **one** file in this
package permitted to import a concrete Provider Adapter package
(`@aoc-enterprise/pinata-adapter`, a `devDependency`), enforced by
`scripts/check-provider-conformance-boundary.mjs`. It builds a harness
around `@aoc-enterprise/pinata-adapter`'s already-published, unmodified
public exports (`createPinataProviderCapabilityDeclaration`,
`executePinataProviderTranslation`) plus a fake `PinataProviderClient` —
the same fake-client pattern `packages/pinata-adapter`'s own tests already
use, so no test in this package contacts a real Pinata endpoint or requires
a real credential.

**Result: PASS.** Every applicable check passes. Exactly one check is
`'skipped'`, a documented, legitimate non-applicability:

- `expired-grant-rejected` — Pinata does not declare `SupportsExpiration`
  (see `packages/pinata-adapter/README.md`, "Unsupported capabilities"): it
  consumes only `EnterpriseProviderTranslation`, which carries no
  `expiresAt` by R005.B's own design.

Every other check, including boundary validation, is proven rather than
skipped: `scripts/compute-pinata-reference-boundary-evidence.mjs` — run as
the first step of this package's own `npm test` — performs a real
filesystem scan of the current working tree (mirroring
`packages/pinata-adapter/scripts/check-pinata-boundary.mjs`'s own walk/regex
logic) and writes its result to `dist-test/pinata-boundary-evidence.json`;
the reference harness reads that file at runtime as its `boundaryEvaluation`.
This is a live proof, not a hard-coded fact: if a future change ever adds a
second file that imports `pinata` anywhere in this repository, this scan's
output changes and the reference test's boundary-validation check starts
failing on its own, without needing to be told to re-check anything.

Zero files under `packages/pinata-adapter` are read-write touched by this
sequence — the reference execution consumes only that package's already-frozen
public API.

## Future compatibility — how future providers adopt the suite

No code in this suite changes to add a new provider. A future adapter
(Amazon S3, Azure Blob, Google Drive, SharePoint, Dropbox, an alternate IPFS
implementation, or any other) adopts it exactly as the Pinata reference
execution does:

| Provider | `providerSystem` (illustrative) | What the adapter itself implements | What this suite requires of it |
| --- | --- | --- | --- |
| Pinata (IPFS) | `'pinata'` | Pin/unpin, IPFS gateway URL generation (already implemented, R005.C) | Same harness shape, same checks — proven above. |
| Amazon S3 | `'s3'` | Presigned `GetObject`/`PutObject` URL generation | ″ |
| Azure Blob | `'azure-blob'` | SAS token generation | ″ |
| Google Drive | `'google-drive'` | Drive API share-link/permission grant | ″ |
| SharePoint | `'sharepoint'` | Graph API sharing-link/permission grant | ″ |
| Dropbox | `'dropbox'` | Shared-link generation | ″ |
| Alternate IPFS implementation | free text, e.g. `'web3-storage'` | Its own pin/unpin, gateway URL generation | ″ |

Each adapts to the suite; the suite never adapts to a provider. If a future
provider genuinely cannot be certified without changing this package, that
is architectural drift to be reported as a new sequence proposing a change
to this ADR — never an implementation detail smuggled into the suite to make
one provider pass.

## Explicit non-responsibilities

This package — and the Provider Conformance Suite it defines — never:

- implements a provider, an adapter, or a provider SDK
- implements HTTP, networking, storage, or credentials
- implements persistence, governance, or authorization
- implements auditing or `EnterpriseUsageEvent` generation
- implements orchestration
- performs filesystem access (boundary scanning is delegated to each
  adapter's own script; see "Boundary validation" above)
- depends on a concrete Provider Adapter package outside its own Phase 10
  reference-execution test file (enforced by
  `scripts/check-provider-conformance-boundary.mjs`)

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/provider-conformance-suite
npm test --workspace @aoc-enterprise/provider-conformance-suite
```

`npm test` compiles `__tests__` under `tsconfig.test.json`, runs `node --test`
against the compiled output (including the Phase 10 reference execution
against Pinata), and then runs
`scripts/check-provider-conformance-boundary.mjs` (also runnable standalone
as `npm run check:provider-conformance-boundary --workspace @aoc-enterprise/provider-conformance-suite`).

## Most important rule

The Conformance Suite is the official certification mechanism for Provider
Adapters. Future providers do not define compliance — they prove compliance
against this suite. It must never become a provider, an adapter, an SDK
wrapper, an execution engine, a governance engine, or an authorization
engine. If a future change to this package starts to accumulate any of
those responsibilities — or starts depending on a concrete provider package
outside its one designated reference-execution test — that is architectural
drift to be reported and reverted, not an incremental improvement to build
on. **The suite must remain provider-neutral forever.**
