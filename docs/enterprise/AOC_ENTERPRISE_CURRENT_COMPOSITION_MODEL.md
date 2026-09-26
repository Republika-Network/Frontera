# Frontera Systems -- Current Composition Model (pre-PR-003 baseline)

This document reconstructs, as-built, the composition path produced by PR-001
(`src/kernel/`) and PR-002 (`src/enterprise/`), before any PR-003 module
lifecycle/registry code is introduced. It is the required "prove you
understand the current system" artifact for PR-003 and is the baseline every
lifecycle claim in `AOC_ENTERPRISE_MODULE_LIFECYCLE.md` is checked against.

## 1. `createEnterprise()` call path

Entry point: `src/enterprise/composition/composition-root.ts:createEnterprise(options)`.

```
createEnterprise(options)
  1. configuration = options.configuration ?? loadEnterpriseConfiguration()
  2. kernelProviders = options.kernelProviders ?? createDefaultKernelProviders()
  3. persistence = options.persistence ?? buildStore(configuration)   // async
  4. eventPublisher = options.eventPublisher ?? createInProcessEventPublisher()
  5. telemetry = options.telemetry ?? createEnterpriseTelemetry()
  6. logger = options.logger ?? createEnterpriseLogger(configuration.logLevel)
  7. eventIdGenerator = createEnterpriseIdGenerator()                  // internal, always fresh
  8. kernel = options.kernel ?? createAocKernel({ recognitionProvider, clock, idGenerator, policyPackProvider? })
  9. bootId = eventIdGenerator.nextId('boot')
  10. await persistence.recordEnterpriseVersion({ bootId, enterpriseVersion, kernelVersion, recordedAt })
  11. return { configuration, kernel, kernelProviders, persistence, eventPublisher, telemetry, logger, bootId, evaluate, health, close }
```

`createDefaultEnterprise(configuration?)` is a convenience wrapper with no
other behavioral difference.

`createEnterpriseServer(options)` (`src/enterprise/host/enterprise-server.ts`)
wraps step 11's result in a `node:http` server; it has no visibility into how
`AocEnterprise` was composed.

## 2. Every dependency currently created

| Dependency | Constructed by | Default | Overridable via `CreateEnterpriseOptions` |
|---|---|---|---|
| `configuration` | `loadEnterpriseConfiguration()` | reads `process.env` | `options.configuration` |
| `kernelProviders` | `createDefaultKernelProviders()` | real, empty (fail-closed) Recognition/Authority/Approval/Handshake world, wall-clock | `options.kernelProviders` |
| `persistence` | `buildStore(configuration)` | in-memory or SQLite, by `configuration.persistence.provider` | `options.persistence` |
| `eventPublisher` | `createInProcessEventPublisher()` | in-process pub/sub, no broker | `options.eventPublisher` |
| `telemetry` | `createEnterpriseTelemetry()` | in-memory counters | `options.telemetry` |
| `logger` | `createEnterpriseLogger(configuration.logLevel)` | console JSON-line sink | `options.logger` |
| `eventIdGenerator` | `createEnterpriseIdGenerator()` | `randomUUID()`-backed | not overridable (Enterprise-internal bookkeeping only) |
| `kernel` | `createAocKernel({...})` | built from `kernelProviders` | `options.kernel` (used verbatim; `kernelProviders` is then only used for `clock`/`idGenerator` in the orchestrator) |
| `policyPackProvider` | none by default | undefined | `options.policyPackProvider` |

## 3. Mandatory vs defaulted dependencies

Every one of the 8 dependencies above has a default -- `createEnterprise({})`
with zero options is a fully valid call and is exactly what
`createDefaultEnterprise()` and `scripts/run-enterprise-host.mjs` do. Nothing
is unconditionally mandatory from the caller's side. The only failure mode is
if a constructed/injected dependency throws during construction or during the
step-10 `recordEnterpriseVersion` call (see section 8).

## 4. Components holding resources

- `persistence` (`GovernanceStore`): holds an open SQLite handle
  (`better-sqlite3`) when `provider: 'sqlite'`; the in-memory variant holds
  only JS heap state.
- `eventPublisher`: holds a `Set` of subscriber callbacks (in-process, no
  external connection).
- `kernel` / `kernelProviders`: hold in-memory Recognition/Authority/Approval/
  Handshake runtime state (actors, trust domains, grants, tokens) -- no
  external resource.
- `logger`: holds no resource (`console.log` sink).
- `telemetry`: holds only in-memory counters.
- HTTP server (`EnterpriseServer.server`, `node:http.Server`): holds the bound
  socket/listener when `.listen()` has been called.

## 5. Components requiring cleanup

- `persistence.close()` -- only real cleanup call in the current system.
  Releases the SQLite handle (a no-op for the in-memory store).
- `EnterpriseServer.close()` -- closes the `node:http.Server` listener, then
  calls `enterprise.close()`.
- Nothing else (`eventPublisher`, `telemetry`, `logger`, `kernelProviders`,
  `kernel`) exposes or needs a close/shutdown call today.

`AocEnterprise.close()` today is exactly:

```ts
async close() {
  await persistence.close();
}
```

## 6. Current initialization order

Strictly sequential, as written in `createEnterprise()` (see section 1):
`configuration -> kernelProviders -> persistence -> eventPublisher ->
telemetry -> logger -> eventIdGenerator -> kernel -> bootId ->
recordEnterpriseVersion`. There is no dependency graph, no module concept, no
declared "this needs that" relationship -- order is simply the order these
`const` statements appear in the function body. The only *real* ordering
constraint today is that `kernel` construction needs `kernelProviders` to
already exist (it reads `kernelProviders.recognitionProvider/clock/idGenerator`).
Every other line is independent and could be reordered without changing
behavior.

## 7. Current failure behavior

There is no rollback and no partial-failure model. If any `await`ed step
throws (`buildStore`, or `persistence.recordEnterpriseVersion`), the
`createEnterprise()` promise rejects and no `AocEnterprise` is ever returned --
whatever was constructed before the throw (e.g. an already-open SQLite
handle) is never closed. This is exercised today by
`__tests__/composition-root.test.ts` ("fails clearly when persistence cannot
be constructed") via `assert.rejects(() => createEnterprise({...}))`.

## 8. Current health behavior

`AocEnterprise.health()` calls `computeEnterpriseHealth()`
(`src/enterprise/health/health-check.ts`), which:

- calls `store.checkConnectivity()` -- the *only* liveness signal;
- reports `status: 'unhealthy'` iff that check returns `false`, else `'healthy'`
  (there is no third state reachable today; `'degraded'` is declared in the
  type but never produced);
- reports `enterpriseVersion`, `kernelVersion`, `buildVersion`,
  `configurationChecksum`, and a `providers.loaded` list built from three
  booleans (`hasPolicyPackProvider`, `eventPublishingEnabled`, and an
  always-present `'recognitionProvider'`).

There is no concept of "ready to accept requests" distinct from "healthy" --
`/health` is the only signal, and nothing gates `POST /api/governance/evaluate`
on it.

## 9. Current close/shutdown behavior

`AocEnterprise.close()` (section 5) is unconditional and idempotent only to
the extent `store.close()` itself is idempotent (the in-memory store's
`close()` is a no-op; SQLite's `close()` is called once per test today, never
twice). There is no state machine -- nothing prevents `evaluate()` from being
called after `close()`; it would simply keep running against a possibly-closed
store.

## 10. Current HTTP server lifecycle

`createEnterpriseServer(options)` composes `AocEnterprise` then binds a plain
`node:http.Server` via `createEnterpriseRequestListener` (`adapters/node-http-adapter.ts`).
`listen()` resolves once the OS confirms the socket is bound, reading back the
OS-assigned port (relevant for `port: 0` in tests). `close()` closes the
socket first, then calls `enterprise.close()`. There is no separate
liveness/readiness distinction at the HTTP layer -- only `GET /health` and
`POST /api/governance/evaluate` exist; every request that arrives while
`listen()`ing is processed regardless of any startup/shutdown phase, because
no such phase currently exists.

## 11. Current persistence lifecycle

`buildStore()` picks `createInMemoryGovernanceStore()` or
`createSqliteGovernanceStore(sqlitePath)` based on
`configuration.persistence.provider`. Both implement the same `GovernanceStore`
port (`persistence/governance-store.ts`): `persistEvaluation` (with
idempotent-replay/conflict semantics), request/evaluation/trace lookups,
`appendEnterpriseEvent`/`listEnterpriseEvents`, `recordEnterpriseVersion`/
`getLatestEnterpriseVersion`, `checkConnectivity`, `close`. Construction is a
single call; there is no separate "connect" step, no retry, no connection
pool.

## 12. Current event publisher lifecycle

`createInProcessEventPublisher()` returns an object holding a `Set` of
listener callbacks. `publish()` iterates and invokes every listener
synchronously (awaited, but each listener call itself is not awaited inside
the loop against errors -- a throwing listener would reject `publish()` and
therefore the whole evaluation). There is no `start`/`stop`; the object is
usable from construction and requires no cleanup.

## 13. Current telemetry lifecycle

`createEnterpriseTelemetry()` returns an object closing over plain mutable
counters (`evaluationCount`, `deniedCount`, etc.). No construction-time I/O,
no cleanup, no external backend.

## 14. Current Kernel lifecycle

`AocKernel` (`src/kernel/AocKernel.ts`) is constructed once, synchronously, in
`createEnterprise()`, from exactly the ports `kernel/contracts/ports.ts`
defines (`recognitionProvider`, optional `policyPackProvider`, `clock`,
`idGenerator`). It has no `initialize()`/`close()` of its own -- the Kernel
this PR wraps in a "Kernel Module" is exposed for *readiness reporting only*,
never given new lifecycle hooks of its own (this PR must not modify Kernel
behavior).

## 15. Current provider composition

`createDefaultKernelProviders()`
(`src/enterprise/providers/kernel-provider-composition.ts`) builds, in this
order: a shared wall-clock/id-generator pair, `AuthorityGraphRuntime`,
`ApprovalRuntime` (depends on the authority runtime), `ExternalAgentHandshakeRuntime`
+ its standing integration, `AocRecognitionRuntime` (depends on all three
prior runtimes), then bridges the recognition runtime into a `RecognitionProvider`
via `bridgeRecognitionRuntime()`. This is a real, non-trivial dependency chain
*within* what PR-003 treats as a single "Providers" module -- it is not
re-modeled here; it stays exactly as-is, wrapped by one thin adapter.

## 16. Existing side effects during creation

- `buildStore()` may open a SQLite file on disk (side effect: filesystem I/O,
  file handle).
- `persistence.recordEnterpriseVersion()` is an unconditional write on every
  `createEnterprise()` call (a boot-accounting row), independent of whether
  any request is ever evaluated.
- `randomUUID()` calls (event/boot ids) consume OS entropy; negligible but
  real.
- No network calls, no other filesystem writes, no environment mutation.

## 17. Existing global or mutable state

None at module scope. Every `createEnterprise()` call produces fully
independent instances -- no shared singletons, no process-level caches. The
only mutable state lives inside the returned closures (`telemetry` counters,
`eventPublisher`'s listener `Set`, the SQLite handle).

## 18. Current concurrency assumptions

- `evaluate()` calls are expected to run concurrently; `GovernanceStore.persistEvaluation`
  is the sole synchronization point for idempotent-replay/conflict resolution
  (exercised by `__tests__/concurrency.test.ts`).
- `createEnterprise()` itself is not designed for concurrent/duplicate
  invocation -- each call independently constructs a full, separate set of
  dependencies; there is no shared "startup in progress" guard because there
  is no shared startup at all.
- There is no `start()`/duplicate-start guard prior to this PR because there
  is no explicit start step -- `createEnterprise()` *is* the (synchronous,
  one-shot) startup.

## 19. Files expected to change (this PR)

- `src/enterprise/composition/composition-root.ts` -- evolves `createEnterprise()`
  to build a module registry and run it through a lifecycle controller instead
  of ad hoc sequential `const`s; adds `start`/`isLive`/`isReady`/`modules`/`stop`
  to `AocEnterprise`.
- `src/enterprise/adapters/node-http-adapter.ts` -- adds `GET /live`, `GET /ready`.
- `src/enterprise/health/health-check.ts` -- additive `lifecycle` merge (no
  existing field removed or renamed).
- `src/enterprise/api/enterprise-http-errors.ts` -- adds `ENTERPRISE_NOT_READY`.
- `src/enterprise/events/enterprise-events.ts` -- adds the lifecycle event
  catalog to the `EnterpriseEvent` union (existing Governance* events
  unchanged).
- `src/enterprise/telemetry/enterprise-telemetry.ts` -- adds lifecycle
  metrics (additive).
- `src/enterprise/configuration/enterprise-configuration.ts` -- adds
  `lifecycle` timeout configuration (additive, defaulted).
- `src/enterprise/index.ts` -- exports the new public surface.
- New: `src/enterprise/modules/*`, `src/enterprise/registry/*`,
  `src/enterprise/lifecycle/*`, and their `__tests__/`.

## 20. Files/paths this PR does not touch

`src/kernel/**`, `src/runtime/**`, `src/kernel-host/index.ts` (the
compatibility shim keeps re-exporting `src/enterprise` unchanged), and every
existing `src/enterprise` file not listed in section 19 above.
