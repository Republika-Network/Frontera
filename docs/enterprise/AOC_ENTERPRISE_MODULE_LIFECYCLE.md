# Frontera Systems Module Lifecycle & Registry v1

## Purpose

Before this PR, `createEnterprise()` was a flat sequence of `const`
bindings (see `AOC_ENTERPRISE_CURRENT_COMPOSITION_MODEL.md`): every
dependency was constructed once, in file order, with no declared
dependency graph, no observable per-component state, and no distinction
between "the process is running" and "the process can safely accept a
governance evaluation." This PR formalizes exactly that -- and nothing
more -- into an **Enterprise Module Registry** and an **Enterprise
Lifecycle Controller**, so the Host can answer, at runtime:

1. Which modules are registered? -- `enterprise.modules()`
2. Which versions are active? -- each `EnterpriseModuleSnapshot.version`
3. What dependencies does each module require? -- `snapshot.dependencies`
4. In what order must modules initialize? -- `registry.resolveInitializationOrder()`
5. Is every required module ready? -- `enterprise.isReady()`
6. Is the Host alive but degraded? -- `enterprise.lifecycleState() === 'degraded'`
7. Can the Host safely accept requests? -- `enterprise.isReady()`, enforced by `evaluate()` itself
8. What happens when initialization fails halfway? -- rollback, see below
9. In what order must modules shut down? -- reverse of #4, over only what actually started
10. Can the system reconstruct why it was/wasn't ready? -- `enterprise.health()`, lifecycle events

This is **not** a plugin marketplace: there is no dynamic loading, no
filesystem/URL module discovery, no hot reload, and no way to register a
module after the registry is frozen (which happens before `evaluate()`
ever becomes callable). Every module in this PR is a thin, real wrapper
around a capability `src/enterprise` already had before PR-003 --
Kernel, Providers, Persistence, Events, Telemetry. No new governance logic
and no new Kernel behavior were introduced.

## Module model

```ts
interface EnterpriseModule {
  readonly descriptor: EnterpriseModuleDescriptor;
  initialize(context: EnterpriseModuleContext): Promise<void>;
  health(): Promise<EnterpriseModuleHealth>;
  shutdown(): Promise<void>;
}
```

`EnterpriseModuleDescriptor` carries a stable `id` (`aoc.kernel`,
`aoc.enterprise.persistence`, ...), a `version`, `criticality`
(`'required' | 'optional'`), an optional list of `dependencies`, and an
optional list of `capabilities` (descriptive strings, not an
authorization framework). There are no speculative lifecycle hooks
(`beforeRegister`, `onEveryDecision`, ...) -- only what the five built-in
modules genuinely need.

### Built-in modules registered by `createEnterprise()`

| id | criticality | dependencies | capabilities | wraps |
|---|---|---|---|---|
| `aoc.enterprise.telemetry` | optional | none | `telemetry.enterprise-metrics` | `telemetry/enterprise-telemetry.ts` |
| `aoc.enterprise.events` | optional | none | `events.enterprise-events` | `events/enterprise-events.ts` |
| `aoc.enterprise.persistence` | **required** | none | `persistence.governance-decisions` | `persistence/governance-store.ts` |
| `aoc.enterprise.providers` | **required** | none | `providers.recognition`/`.authority`/`.approval`/`.handshake`(/`.policy-pack`) | `providers/kernel-provider-composition.ts` |
| `aoc.kernel` | **required** | `aoc.enterprise.providers` | `kernel.evaluate` | `AocKernel` (unmodified) |

**Why persistence/providers/kernel are required, and telemetry/events are
optional** (mission section 18, "base classification on the current
Host's actual guarantees"): PR-002's Host unconditionally persists every
evaluation and unconditionally routes every evaluation through the
Kernel's provider set -- those are guarantees this Host already made, so
their modules block readiness if they fail. Telemetry and event
publishing are both individually feature-flaggable
(`AOC_ENTERPRISE_TELEMETRY_ENABLED`/`AOC_ENTERPRISE_EVENTS_ENABLED`) and
were already optional in practice; their modules degrade, never block.

**Why there is no Configuration module**: `EnterpriseConfiguration` is
loaded synchronously, once, before the registry exists, and has no
initialize/health/shutdown behavior of its own (mission section 17:
"do not convert immutable configuration into a fake lifecycle module
merely for symmetry").

**The true dependency graph is nearly flat.** In the actual composition
root, `telemetry`/`events`/`persistence`/`providers` are each constructed
independently -- none needs another to exist first. The only real
construction-order dependency is that `AocKernel` is built from the
already-composed `KernelProviderSet`, which is why `aoc.kernel` is the
only module with a declared dependency (`aoc.enterprise.providers`). This
PR does not invent additional dependency edges the real system does not
have.

## Registration rules

- Duplicate module ids are rejected (`EnterpriseModuleRegistrationError`,
  code `MODULE_DUPLICATE`).
- `createEnterprise()` registers the five built-in modules, then any
  caller-supplied `options.modules`, then **freezes** the registry --
  registration after that point throws the same error. There is no
  runtime module installation in v1 (mission section 33).
- `registry.validate()` checks every declared dependency: a missing
  *required* dependency is an error; a missing *optional* dependency is
  not. A present dependency whose `versionRange` doesn't match is also an
  error. Version compatibility supports exactly two shapes -- an exact
  version string, or a `^major.minor.patch` caret range meaning "same
  major version" -- never a full semver parser.

## Dependency graph & initialization order

`registry.resolveInitializationOrder()` performs a deterministic
topological sort (Kahn's algorithm) over every *registered* module.
**Tie-break rule** (mission section 9, "choose one and document it"):
when multiple modules have no remaining unresolved dependency, the one
registered first initializes first. For the built-in set this produces:

```
aoc.enterprise.telemetry
aoc.enterprise.events
aoc.enterprise.persistence
aoc.enterprise.providers
aoc.kernel                 (after providers, by declared dependency)
```

A cycle throws `EnterpriseModuleCycleError` (code `MODULE_DEPENDENCY_CYCLE`)
carrying the concrete path, e.g.:

```
Dependency cycle detected:

aoc.enterprise.persistence
→ aoc.enterprise.events
→ aoc.enterprise.telemetry
→ aoc.enterprise.persistence
```

never a bare "cycle detected."

## Module states and transitions

```
registered -> validating -> initializing -> ready
                                 |             \-> stopping -> stopped
                                 \-> degraded -> stopping -> stopped
                                 \-> failed -> stopping -> stopped
```

Every transition not in this table is rejected by
`EnterpriseModuleStateError` (code `MODULE_INVALID_STATE`) --
`ready -> initializing` and `stopped -> ready` are both invalid; a module
instance's `failed`/`stopped` state is terminal (**no automatic retry in
v1**; retrying means constructing a new `AocEnterprise`).

## Host lifecycle states and transitions

```
created -> validating -> starting -> ready -> stopping -> stopped
                              |         \-> stopping -> stopped
                              \-> degraded -> stopping -> stopped
                              \-> failed -> stopping -> stopped
```

- **Liveness** (`isLive()`): true from `created` through everything except
  `stopped`. A live process may be `degraded` or not yet `ready`.
- **Readiness** (`isReady()`): true only in `ready` or `degraded`. False
  in `created`/`validating`/`starting`/`failed`/`stopping`/`stopped`.
  `degraded` still counts as ready because, in this Host, `degraded` is
  reached *only* by an optional module failing -- a required-module
  failure always drives the Host to `failed`, never `degraded` (mission
  section 13: "Optional module degradation must not necessarily make
  readiness false").

## Startup

`createEnterprise()` **auto-starts** (mission section 20, Option A) --
existing PR-002 consumers call `createEnterprise()` then `evaluate()`
immediately with no `start()` in between, and that keeps working
unchanged (see `docs/architecture/ADR-ENTERPRISE-MODULE-LIFECYCLE.md` for
why Option A was chosen over B/C). `start()` is still exposed and is a
safe idempotent no-op once already `ready`/`degraded`; concurrent
`start()` calls (including the implicit one inside `createEnterprise()`)
share a single in-flight promise, so module `initialize()` never runs
twice.

Sequence: `validate()` dependencies -> `resolveInitializationOrder()` ->
for each module in order: `validating` -> `initializing` -> `ready`, or on
failure, `degraded` (optional) or `failed` (required, and initialization
stops there -- later modules in the order are never started).

## Startup failure & rollback

If a **required** module fails to initialize, the controller:

1. Marks that module `failed`.
2. Shuts down every module that *did* successfully initialize, in reverse
   order, continuing through individual shutdown failures rather than
   aborting the rollback.
3. Sets the Host to `failed`.
4. Throws `EnterpriseModuleInitializationError`, carrying the failed
   module id, the original cause, the list of modules that *had*
   initialized, and any rollback failures -- nothing is swallowed.

A module that never successfully initialized never has `shutdown()`
called on it (it holds no resources to release). Once `failed`, calling
`shutdown()`/`close()` is a safe no-op: rollback already ran; the Host
simply transitions straight to `stopped`.

## Shutdown

Normal shutdown runs the modules that *actually initialized*, in reverse
of the order they came up in -- not the full registered set. It is:

- **Idempotent**: a second `shutdown()`/`close()` call does nothing.
- **Non-aborting**: one module's `shutdown()` throwing does not stop the
  rest from being attempted.
- **Aggregating**: every failure is collected into
  `EnterpriseModuleShutdownError` (code `MODULE_SHUTDOWN_FAILED`) and
  thrown once all modules have been attempted -- never silently dropped.
- **Readiness-first**: the Host state moves to `stopping` (readiness
  false) *before* any module's `shutdown()` runs, so no new evaluation
  can be accepted while modules are being torn down.

Concurrent `shutdown()`/`close()`/`stop()` calls share one in-flight
promise, the same way `start()` does.

## Health aggregation

`enterprise.health()` still returns the PR-002 `EnterpriseHealthReport`
shape unchanged (`status`/`persistence`/`providers`/`configurationChecksum`/...)
and additively includes `lifecycleState`, `live`, `ready`, and `modules`
(a `moduleId -> { version, state, health, required }` map). Aggregation
(`health/health-check.ts:aggregateStatus`) is owned entirely by
Enterprise, never by a module:

- **`unhealthy`**: the store is unreachable, the Host is not `ready`, or
  any *required* module's own `health()` reports anything but `healthy`.
- **`degraded`**: the Host is `ready` and every required module is
  healthy, but at least one *optional* module is not.
- **`healthy`**: ready, and every module (required and optional) reports
  healthy.

`computeEnterpriseHealth()`'s pre-PR-003 signature/behavior is preserved
exactly when called without the new optional `lifecycle` field (see the
still-passing `__tests__/health.test.ts`), so no existing direct caller's
assertions changed shape.

## Evaluation readiness guard

`AocEnterprise.evaluate()` checks `isReady()` before doing anything else.
If not ready, it rejects with the same `EnterpriseHttpError` class every
other Enterprise-owned failure uses -- code `ENTERPRISE_NOT_READY`, HTTP
`503`, carrying the current `lifecycleState`. The HTTP adapter's existing
generic error handler renders this exactly like any other
`EnterpriseHttpError` -- no special-casing was needed in
`node-http-adapter.ts` beyond the two new routes below. This is a
readiness failure, never a Kernel denial: it happens *before* the Kernel
request adapter runs.

## HTTP surface

- `GET /health` -- unchanged route, richer body (see "Health aggregation").
- `GET /live` -- `{ live: boolean, lifecycleState }`, `200` if live else `503`.
- `GET /ready` -- `{ ready: boolean, lifecycleState }`, `200` if ready else `503`.
- `POST /api/governance/evaluate` -- unchanged route; now additionally
  503s with `ENTERPRISE_NOT_READY` before startup completes, during
  shutdown, and after stop.

## Event catalog (additive to `EnterpriseEvent`)

`EnterpriseStartupRequested`, `EnterpriseModuleInitializationStarted`,
`EnterpriseModuleReady`, `EnterpriseModuleDegraded`,
`EnterpriseModuleFailed`, `EnterpriseReady`, `EnterpriseStartupFailed`,
`EnterpriseShutdownRequested`, `EnterpriseModuleShutdownStarted`,
`EnterpriseModuleStopped`, `EnterpriseStopped`. Every event carries
`eventId`, `occurredAt`, `enterpriseVersion`, a `lifecycleCorrelationId`
scoping one Enterprise instance's startup-through-shutdown sequence, and
(where applicable) `moduleId`/`moduleVersion`/`previousState`/`newState`/
`durationMs`/`failureCode`. These flow through the same in-process
`EnterpriseEventPublisher` the existing `GovernanceEvaluation*` events
use (no second event bus) but are **not** persisted to the
`GovernanceStore` (see "Limitations").

## Telemetry (additive to `EnterpriseMetricsSnapshot`)

`startupCount`/`startupFailureCount`, `shutdownCount`/`shutdownFailureCount`,
`moduleFailureCount`. Per-module initialization duration is carried on the
`EnterpriseModuleReady` lifecycle event's `durationMs` field rather than a
separate counter -- this repo has no metrics backend to export named
histograms to, and the event stream already carries the same number.

## Extension guidance

See `AOC_ENTERPRISE_MODULE_AUTHORING_GUIDE.md`. In short: implement
`EnterpriseModule`, pass it via `createEnterprise({ modules: [...] })`; it
is registered after the built-ins and participates in the same
dependency graph, ordering, health aggregation, and shutdown.

## Limitations (explicitly out of scope for this PR)

- No dynamic plugin loading, filesystem/URL module discovery, hot reload,
  or module marketplace.
- No remote/distributed lifecycle coordination, multi-node leader
  election, or distributed health consensus.
- No restart recovery: lifecycle state is in-memory only; a process
  restart begins the lifecycle from `created` again. The Module Registry
  itself is never durably persisted.
- No in-flight-evaluation draining during shutdown: `close()` marks
  readiness false and tears down modules; it does not wait for
  evaluations already in progress to finish before releasing persistence.
  For this Host's own evaluation path (in-memory or a single SQLite
  handle, synchronous per request), this is judged acceptable for v1; a
  future PR can add draining if a slower persistence backend needs it.
- No full Governance/Persistence Runtime, Passport Runtime, Evidence
  Bundle generation, Assurance certification, Jurisdiction Runtime, or
  Constitutional Runtime -- unchanged from PR-002's own stated scope.
- Lifecycle events are not durably persisted to the `GovernanceStore`
  (only published in-process) -- see the rationale in this doc's "Event
  catalog" section; a durable, replayable event log is PR-004's concern.
- No public SDK.
