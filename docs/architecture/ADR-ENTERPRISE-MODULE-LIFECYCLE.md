# ADR: Frontera Systems Module Lifecycle & Registry

## Status

Accepted (PR-003).

## Context

- `createEnterprise()` (PR-002) exists and is the Enterprise Host's one
  composition root, but composition is a fixed, flat sequence of `const`
  bindings with no declared dependency graph and no observable
  per-component state (`AOC_ENTERPRISE_CURRENT_COMPOSITION_MODEL.md`).
- Future Enterprise capabilities (durable Governance Store, Passport
  events, Evidence Bundles -- PR-004 and beyond) will need a real place to
  plug in operational lifecycle behavior, without every future PR
  reinventing "how do I initialize/health-check/shut down this thing."
- `/health` conflated "the store is reachable" with "the Host can safely
  accept a request" -- there was no way to distinguish "still starting
  up" from "unhealthy," and nothing gated `POST /api/governance/evaluate`
  on either.
- Initialization order was implicit (source line order); there was no way
  to answer "what must come up before what" except by reading the
  composition root's source.

## Decision

- Add a static, in-memory **Enterprise Module Registry**
  (`registry/enterprise-module-registry.ts`) generic to Enterprise
  *operational* modules -- it has no knowledge of Kernel decision
  contracts and no HTTP awareness.
- **Freeze registration before startup**: `createEnterprise()` registers
  the five built-in modules (Telemetry, Events, Persistence, Providers,
  Kernel) plus any caller-supplied modules, then freezes the registry.
  There is no runtime module installation.
- Use **deterministic dependency resolution** (Kahn's topological sort,
  ties broken by registration order) rather than a hand-maintained
  ordering list -- `resolveInitializationOrder()` is derived from
  declared dependencies, not asserted.
- **Initialize in topological order**, **shut down in reverse** of the
  order that actually succeeded (not the full declared order) --
  `lifecycle/enterprise-lifecycle-controller.ts`.
- **Aggregate health** centrally (`health/health-check.ts:aggregateStatus`)
  -- no individual module's status can override the Host's reported
  `status`.
- **Avoid dynamic plugins** entirely: no filesystem/URL module discovery,
  no hot reload, no remote modules, no general-purpose DI framework (no
  NestJS/Inversify/etc. was introduced -- module wiring stays plain
  factory functions, consistent with the rest of this repository).
- **Auto-start** (`createEnterprise()` awaits `lifecycle.start()` before
  resolving) rather than requiring an explicit `start()` call, to
  preserve every existing PR-002 consumer's behavior unchanged (see
  "Backward compatibility" below).

### Backward compatibility: why auto-start (Option A)

The mission described three options:

- **Option A -- auto-start**: `createEnterprise()` completes startup
  before resolving.
- **Option B -- explicit lifecycle + compatibility factory**: introduce
  `startEnterprise()` as the "real" entry point while `createEnterprise()`
  keeps its old behavior temporarily.
- **Option C -- lazy initialization**: the first `evaluate()`/`health()`
  call triggers startup.

Every existing test in `src/enterprise/__tests__/` (composition-root,
concurrency, kernel-integration, enterprise-api-endpoint, ...) calls
`createEnterprise()` and then immediately `evaluate()`/`health()`, with no
intervening `start()` call and no tolerance for a `503 ENTERPRISE_NOT_READY`
in between. Option B would require either duplicating `createEnterprise()`'s
behavior (violating "do not duplicate the composition root") or breaking
those call sites. Option C introduces a first-request race (which caller's
`evaluate()` triggers startup, and what do concurrent callers see while it
runs?) for no benefit, since every dependency this Host's modules wrap
constructs near-instantly (in-memory runtimes, an already-open SQLite
handle) -- there is no slow I/O startup step to defer. Option A costs
nothing observable (the built-in modules' `initialize()` calls are all
synchronous-fast) and requires zero changes to any existing test. `start()`
is still exposed on `AocEnterprise` for callers who want to observe/await
the lifecycle explicitly (or who register slower custom modules via
`options.modules`), and remains a safe idempotent no-op when called after
auto-start already succeeded.

## Consequences

### Positive

- Operational clarity: `enterprise.modules()` answers "what's running and
  in what state" without reading source.
- Safer startup: a required module's failure now rolls back cleanly
  instead of leaving a partially-constructed, silently-broken
  `AocEnterprise` (which is what would happen today if, say,
  `recordEnterpriseVersion` succeeded but a later, still-hypothetical step
  failed).
- Readiness guarantees: `POST /api/governance/evaluate` can no longer be
  called against a Host that hasn't finished starting, is shutting down,
  or has stopped -- it gets a clear `503 ENTERPRISE_NOT_READY` instead of
  an ambiguous failure.
- Improved observability: lifecycle events + additive telemetry counters
  give a durable-enough (in-process) trail of *why* the Host is or isn't
  ready, without a new persistence schema.
- Modular evolution: PR-004+ have a real, tested place to add a
  Governance Store module, a Passport module, etc., instead of growing
  `createEnterprise()`'s `const` list further.

### Negative

- Additional abstraction: five thin module wrappers now sit between
  `createEnterprise()` and the resources it always constructed directly.
- Module adapter maintenance: any future change to, say, `GovernanceStore`
  now touches its module wrapper too (in practice, one extra file).
- New lifecycle failure modes (registration errors, cycle errors,
  initialization/shutdown errors) that did not exist before -- though they
  only fire for genuinely invalid configurations (a real missing
  dependency, a real cycle), not for the built-in five, which are
  correct by construction.
- Startup is now (marginally) stricter: a required built-in module that
  used to fail *silently late* (e.g. persistence unreachable only
  surfacing on the first `evaluate()` call) now fails *at construction
  time*, which is more correct but is a behavior change for a
  hypothetical caller who relied on lazily-discovered persistence
  failures.

## Rejected alternatives

- **Keep direct composition forever** -- works today, but leaves no place
  for PR-004+ to hang lifecycle behavior off of, and gives no answer to
  "is every required module ready" beyond reading `/health`'s single
  boolean.
- **Dynamic plugin loading** (filesystem/URL discovery, hot reload) --
  explicitly out of scope (mission's non-goals); this Host has a fixed,
  known set of operational capabilities, not a marketplace.
- **A general-purpose DI framework** (NestJS/Inversify/etc.) -- would
  obscure the already-simple, already-correct composition root behind a
  framework this repository has never used, purely for aesthetics.
- **One global service container** -- every `createEnterprise()` call
  already produces a fully independent instance (no shared singletons);
  a global container would be a regression, not an improvement.
- **Make every object a module** (e.g. `EnterpriseConfiguration`,
  `EnterpriseLogger`) -- rejected per mission section 17: these have no
  initialize/health/shutdown behavior of their own; wrapping them would be
  symmetry for its own sake, not a real lifecycle need.
