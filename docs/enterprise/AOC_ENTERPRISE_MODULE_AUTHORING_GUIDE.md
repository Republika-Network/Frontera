# Frontera Systems Module Authoring Guide

This guide is for adding a new operational module to the Frontera Systems
Host's module registry -- not for adding governance/decision logic (that
belongs in the Kernel, `src/kernel/`) and not for a dynamic/loadable
plugin (this system doesn't have those; see
`AOC_ENTERPRISE_MODULE_LIFECYCLE.md`'s "Limitations").

## The contract

```ts
import type { EnterpriseModule, EnterpriseModuleContext, EnterpriseModuleHealth } from '@aoc-enterprise/runtime/enterprise';

export function createExampleModule(clock: { now: () => string }): EnterpriseModule {
  return {
    descriptor: {
      id: 'example.module',
      version: '1.0.0',
      criticality: 'optional',
      dependencies: [{ moduleId: 'aoc.enterprise.events' }],
      capabilities: ['example.capability'],
    },
    async initialize(context: EnterpriseModuleContext): Promise<void> {
      context.logger.info('example_module_initializing', {});
      // Acquire whatever this module needs. Throw to fail initialization --
      // see "required vs optional" below for what happens next.
    },
    async health(): Promise<EnterpriseModuleHealth> {
      return { status: 'healthy', checkedAt: clock.now() };
    },
    async shutdown(): Promise<void> {
      // Release resources acquired in initialize(). Must be safe to call
      // even if initialize() never fully succeeded is NOT guaranteed --
      // shutdown() is only ever called for a module that reached 'ready'
      // or 'degraded'.
    },
  };
}
```

Use an injected clock (`context` does not hand you one directly, but your
module's own constructor can take one, as above) rather than
`new Date()` wherever a timestamp needs to be deterministic in tests.

## Descriptor requirements

- `id` -- stable, machine-readable, dot-namespaced (e.g. `myteam.cache`).
  Never a display name; use `displayName` for that.
- `version` -- a plain string. If another module might declare a
  dependency on yours with a `versionRange`, keep it semver-shaped
  (`'1.2.3'`); the registry only supports exact-match or `^major`
  compatibility checks, never a full semver range grammar.
- `criticality` -- `'required'` if the Enterprise Host must not be `ready`
  without this module; `'optional'` if a failure here should only
  `degrade` the Host, never block it. Base this on an actual guarantee
  the Host makes to its callers, not on how important the module feels.
- `dependencies` (optional) -- `{ moduleId, versionRange?, optional? }`.
  Omit `optional` (defaults to required-dependency) if your module cannot
  function without the dependency present; a missing required dependency
  fails registry validation for the *whole* registry, so declare it only
  when truly necessary.
- `capabilities` (optional) -- descriptive strings for diagnostics only.
  This is not an authorization or resolution mechanism.

## `initialize(context)`

`context` gives you exactly: `enterpriseVersion`, `configuration`
(read-only `EnterpriseConfiguration`), `logger`, `telemetry`, and a
read-only `registry` view (`get`/`list` -- no `register`/`setState`). You
cannot reach the HTTP server, raw persistence internals, secrets, or
another module's private state through this context. If you need a
capability that isn't here, that's a signal you need a new, narrowly
scoped context field -- not a workaround.

Throwing from `initialize()`:

- If `criticality: 'required'`: the whole startup fails, every module that
  *did* initialize successfully is rolled back in reverse order, and
  `createEnterprise()` rejects with `EnterpriseModuleInitializationError`.
- If `criticality: 'optional'`: your module is marked `degraded`; startup
  continues; the Host still becomes `ready` (or stays `degraded` if
  already so from another module).

## `health()`

Called on every `enterprise.health()` / `GET /health`. Return
`{ status: 'healthy' | 'degraded' | 'unhealthy', checkedAt, message?, details? }`.
Never include secrets/tokens/raw configuration/PII in `message`/`details`
-- this flows straight into an HTTP response body. If `health()` throws,
the Enterprise Lifecycle Controller catches it and reports your module as
`unhealthy` with the thrown error's message -- you do not need your own
try/catch purely to avoid crashing the health endpoint, though catching
expected failure modes yourself produces a better message.

Remember: **your module's `health()` status does not, by itself, set the
Host's overall `/health` `status`.** Aggregation belongs to Enterprise
(`aggregateStatus()` in `health/health-check.ts`) -- a required module
reporting `degraded` still makes the *Host* `unhealthy`, and an optional
module reporting `unhealthy` still only makes the Host `degraded` (never
`unhealthy`), by design.

## `shutdown()`

Only called for a module that reached `ready` or `degraded`, in reverse
initialization order, during Host shutdown (or during rollback after a
different required module's startup failure). Release whatever
`initialize()` acquired. If it throws, shutdown of the *other* modules
still proceeds -- your failure is collected, not fatal to the rest of
teardown -- but it is surfaced in `EnterpriseModuleShutdownError`, so
don't swallow real problems just to avoid that.

## Required vs. optional -- how to decide

Ask: "if this module never comes up, can the Enterprise Host still
honestly tell a caller their governance evaluation was correctly
evaluated, persisted, and reported?" If no, it's `required`. The built-in
Kernel/Providers/Persistence modules are `required` for exactly this
reason; Telemetry/Events are `optional` because this Host already treats
them as independently disable-able features, not guarantees.

## What modules must not do

- Must not evaluate authority, invent reason codes, or reinterpret a
  Kernel decision -- that is the Kernel's exclusive domain.
- Must not import HTTP route handlers or `node:http` types -- a module is
  transport-agnostic; only `adapters/node-http-adapter.ts` knows about
  HTTP.
- Must not mutate the registry (the context you receive is read-only) or
  reach into another module's private closures.
- Must not perform dynamic code loading, fetch remote code, or read
  arbitrary files to decide what to become -- if your module needs
  configuration, take it from `context.configuration`.
- Must not assume it can retry its own failed `initialize()` -- v1 has no
  automatic retry; a failed/stopped module instance is terminal for the
  life of that `AocEnterprise`.

## Testing your module

At minimum:

- Unit-test `initialize()`/`health()`/`shutdown()` directly against your
  module factory, independent of the registry.
- Register it into a real `createEnterpriseModuleRegistry()` alongside a
  couple of trivial test modules to confirm your declared `dependencies`
  produce the initialization order you expect
  (`registry.resolveInitializationOrder()`).
- If registering it via `createEnterprise({ modules: [yourModule] })`,
  confirm the Host still reaches `ready`/`degraded` as you intend, and
  that `enterprise.modules()` reports your module's snapshot correctly.
- Never fabricate a fake Kernel/GovernanceStore/EventPublisher purely to
  test your module in isolation if the real (in-memory) ones from
  `src/enterprise` are already cheap enough to use directly -- this
  repository's own test suite (`__tests__/support.ts`) prefers real
  components wherever practical.

## Example: the module wired above, end to end

```ts
import { createEnterprise } from '@aoc-enterprise/runtime/enterprise';
import { createExampleModule } from './example-module.js';

const enterprise = await createEnterprise({
  modules: [createExampleModule({ now: () => new Date().toISOString() })],
});

console.log(enterprise.modules().find((m) => m.id === 'example.module'));
// { id: 'example.module', version: '1.0.0', state: 'ready', required: false, dependencies: [...], capabilities: [...] }
```
