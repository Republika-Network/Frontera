# Soberanía Enterprise Host v1

> This document supersedes `docs/runtime/ENTERPRISE_RUNTIME_HOST.md`
> (PR-002's original name). The module moved from `src/kernel-host/` to
> `src/enterprise/`; see `docs/enterprise/KERNEL_HOST_TO_ENTERPRISE_MIGRATION.md`
> for the exact rename and `docs/architecture/ADR-ENTERPRISE-HOST-NAMING.md`
> for why.

## Executive Summary

The Kernel (`src/kernel`, `AocKernel.evaluate()`) evaluates governance
requests. The **Soberanía Enterprise Host** (`src/enterprise/`) is the production
HTTP service that hosts it: `POST /api/governance/evaluate`, `GET /health`,
a single composition root (`createEnterprise()`), durable persistence of
every governance request/evaluation/trace, an in-process event catalog,
telemetry, structured logging, and a documented HTTP error model.

**What was renamed in this iteration**, and why: PR-002 originally built
this module as `src/kernel-host/`. The repository already has an unrelated
`src/runtime/` module (`createAocEnterpriseRuntime`: grants, delegation,
vault, federation -- it never calls `AocKernel.evaluate()`), and calling
the new module "Kernel Host" undersold its actual, long-term architectural
job: it will eventually orchestrate more than the Kernel alone (persistence,
audit, telemetry, APIs, SDK adapters, provider composition, and eventually
integration with Passport/Evidence/Jurisdiction/Constitutional subsystems).
`src/enterprise/` and the public term **Soberanía Enterprise Host** name that role
directly, without colliding with `src/runtime/`'s unrelated meaning.

**What stayed unchanged:**
- `src/kernel/**` -- zero lines touched, zero behavior changes, all Kernel
  tests still pass.
- `src/runtime/**` -- zero lines touched. Not moved, not renamed, not
  merged, not routed through the Kernel, not deprecated. It remains a
  distinct, valid runtime-services layer.
- Every endpoint, decision semantics, persistence transaction boundary,
  event trigger, and Kernel-parity guarantee PR-002 established.

**How compatibility was preserved:** `@aoc-enterprise/runtime/kernel-host`
still resolves, via a one-line re-export shim (`src/kernel-host/index.ts`)
pointing at `src/enterprise/`. No duplicate implementation exists anywhere.
See the migration guide for the exact old-name -> new-name mapping and
removal criteria for that shim.

## Why `src/runtime/` stays separate

`src/runtime/` (`AocEnterpriseRuntime`) is a mature, independently-tested
system: execution grants, delegated capabilities, capability claims, vault
boundaries, and federation envelopes. It has its own composition
(`createAocEnterpriseRuntime`), its own ports (`RuntimePortSet`), its own
test suite, and its own contract-stability documentation
(`docs/sdk/versioning-and-stability.md`). It does not call
`AocKernel.evaluate()` anywhere, and rewriting it to route through the
Kernel would be a governance-logic change this iteration explicitly does
not make. The two systems solve different problems and are allowed to
coexist under the same package without one absorbing the other.

## Architecture

```
              Soberanía Protocol
                      |
                      v
               Soberanía Kernel                 (src/kernel -- decision engine, unchanged)
                      |
                      v
          Soberanía Enterprise Host             (src/enterprise -- this module)
                      |
        +-------------+--------------+---------------+-------------+
        |             |              |               |             |
        v             v              v               v             v
  Runtime Services  Persistence   Events        Telemetry       Health
  (src/runtime,     (Governance   (in-process   (counters,      (GET /health)
   consumed only     Store)        pub/sub)      structured
   through explicit                              logging)
   public contracts,
   not by default in
   this PR)
                      |
                      v
          Solutions and External Clients
```

Per-request call path (unchanged from PR-002, renamed in terminology only):

```
HTTP Request
  -> Authentication            (Enterprise-owned, optional, off by default)
  -> Enterprise Validation      (HTTP/JSON shape only)
  -> Kernel Request Adapter     (1:1 field mapping onto KernelEvaluationRequest)
  -> kernel.evaluate()          (src/kernel -- the only decision-maker)
  -> Kernel Result
  -> Persistence                (one transaction: request + evaluation + trace)
  -> Audit                      (a distinct "governance.audit.decision" log line)
  -> Event Publication           (in-process publish + durable RuntimeEvents row)
  -> HTTP Response
```

The Enterprise layer hosts; it does not decide. It may validate
transport-level requests, authenticate callers, compose providers, call the
Kernel, persist decisions, emit events, expose health, collect telemetry,
and map errors to HTTP. It may not evaluate authority, decide policy
outcomes, invent reason codes, reinterpret Kernel results, bypass the
Kernel, or duplicate governance semantics.

Some Runtime services may in the future be consumed before or during
Kernel evaluation (e.g. an execution grant validated as a precondition) --
this PR does not wire that consumption; it only reserves the composition
root's shape (`CreateEnterpriseOptions`) so a later PR can add it as an
explicit, injected dependency rather than an implicit import.

### Module map (`src/enterprise/`)

| Module | Responsibility |
| --- | --- |
| `configuration/` | `EnterpriseConfiguration` -- every env-derived Runtime knob. The Kernel reads none of it. |
| `telemetry/` | `EnterpriseTelemetry` (operational counters) and `EnterpriseLogger` (structured request logging). |
| `events/` | The Enterprise event catalog (`EnterpriseEvent`) + a simple in-process publisher/subscriber. |
| `providers/` | Constructs the Kernel's real `RecognitionProvider` (Recognition Runtime + Authority Graph + Approval Runtime + External Agent Handshake) and its clock/id generator. |
| `persistence/` | `GovernanceStore` port + in-memory and SQLite implementations. |
| `health/` | `computeEnterpriseHealth()` -- version, persistence connectivity, provider/config status, no secrets. |
| `composition/` | The one composition root, `createEnterprise()` / `createDefaultEnterprise()`. |
| `api/` | Wire contracts for `POST /api/governance/evaluate`, request validation, Kernel request/response adaptation, `EnterpriseHttpError`; `governed-action-contract.ts` for `POST /api/governed-actions` (result → HTTP status, admission failure → envelope). |
| `orchestration/` | `evaluateGovernanceRequest()` -- the full request lifecycle, framework-agnostic; `governGovernedActionRequest()` -- customer admission, then `governedActionOrchestrator.govern()`. |
| `adapters/` | `node-http-adapter.ts` -- the only module that touches `node:http`. |
| `host/` | `createEnterpriseServer()` -- binds the adapter to a real `http.Server`. |
| `__tests__/` | Endpoint, persistence, composition-root, health, error-mapping, concurrency, Kernel-parity, structural-boundary, and compatibility tests. |
| `index.ts` | Public barrel. |
| `version.ts` | `AOC_ENTERPRISE_HOST_VERSION`. |

No speculative folders were added (no `middleware/`, `plugins/`, `graphql/`,
`testing/` with nothing in it) -- every directory backs a concrete file
exercised by the test suite. `testing/` from the mission's suggested layout
was not created: there was nothing concrete to put in it beyond
`__tests__/support.ts`, which already exists.

## Public API

### Enterprise exports (`@aoc-enterprise/runtime/enterprise`)

```ts
// Composition
export { createEnterprise, createDefaultEnterprise } from '...';
export type { AocEnterprise, CreateEnterpriseOptions, EnterpriseEvaluationRequest, EnterpriseRequestContext } from '...';

// Hosting
export { createEnterpriseServer } from '...';
export type { EnterpriseServer } from '...';
export { createEnterpriseRequestListener } from '...';

// Configuration
export { loadEnterpriseConfiguration, computeConfigurationChecksum, toPublicEnterpriseConfiguration } from '...';
export type { EnterpriseConfiguration, EnterpriseEnvironment, EnterprisePersistenceProviderKind, EnterpriseFeatureFlags, EnterpriseApiKey, PublicEnterpriseConfiguration } from '...';
// AocEnterprise.configuration is a PublicEnterpriseConfiguration (R004.B) --
// see "Credential handling" under Configuration below. The full
// EnterpriseConfiguration (with real apiKeys) never crosses this barrel;
// getInternalEnterpriseConfiguration() is a trusted-in-process-only accessor
// and is deliberately not exported here.

// Telemetry & logging
export { createEnterpriseTelemetry, createEnterpriseLogger } from '...';
export type { EnterpriseTelemetry, EnterpriseMetricsSnapshot, EnterpriseLogger, EnterpriseLogContext, EnterpriseLogLevel, EnterpriseLoggerSink } from '...';

// Events
export { createInProcessEventPublisher } from '...';
export type { EnterpriseEvent, EnterpriseEventType, EnterpriseEventPublisher, GovernanceEvaluationRequestedEvent, GovernanceEvaluationCompletedEvent } from '...';

// Providers (Kernel composition)
export { createDefaultKernelProviders } from '...';
export type { KernelProviderSet, KernelWorldHandles } from '...';

// Persistence
export { createInMemoryGovernanceStore, createSqliteGovernanceStore } from '...';
export type { GovernanceStore, GovernanceRequestRecord, GovernanceEvaluationRecord, GovernanceTraceRecord, EnterpriseEventRecord, EnterpriseVersionRecord, PersistEvaluationInput, PersistEvaluationResult, PersistEvaluationOutcome } from '...';

// Health
export { computeEnterpriseHealth } from '...';
export type { EnterpriseHealthReport, EnterpriseHealthState, EnterpriseHealthDependencies } from '...';

// API / errors
export { validateGovernanceEvaluateRequestBody, toKernelEvaluationRequest, toKernelEvaluationOptions, toGovernanceEvaluateResponseBody, mapDecisionStatusToHttpStatus } from '...';
export type { GovernanceEvaluateRequestBody, GovernanceEvaluateResponseBody } from '...';
export { EnterpriseHttpError, EnterpriseHttpErrors } from '...';
export type { EnterpriseHttpErrorCode } from '...';

export { AOC_ENTERPRISE_HOST_VERSION } from '...';
```

### Kernel exports (`@aoc-enterprise/runtime/kernel`) -- unchanged by this iteration

`AocKernel`, `createAocKernel`, `AocKernelOptions`, `AOC_KERNEL_VERSION`,
`KernelEvaluationRequest`, `KernelEvaluationResult`, `KernelTrace`,
`AOC_KERNEL_REASON_CODES`, `KernelError` and subclasses, and the rest of the
Kernel's contract surface documented in `docs/kernel/`. None of these were
redefined by the Enterprise layer -- it only adapts around them.

### Compatibility aliases / deprecated names

| Deprecated | Replacement |
| --- | --- |
| `@aoc-enterprise/runtime/kernel-host` (package export) | `@aoc-enterprise/runtime/enterprise` |
| `buildRuntimeHost()` | `createEnterprise()` |
| `RuntimeHost` | `AocEnterprise` |
| `RuntimeHostOverrides` | `CreateEnterpriseOptions` |
| `createRuntimeHostServer()` | `createEnterpriseServer()` |
| `RuntimeHostServer` | `EnterpriseServer` |
| `RuntimeConfiguration` / `loadRuntimeConfiguration()` | `EnterpriseConfiguration` / `loadEnterpriseConfiguration()` |
| `RuntimeTelemetry` / `createRuntimeTelemetry()` | `EnterpriseTelemetry` / `createEnterpriseTelemetry()` |
| `RuntimeLogger` / `createRuntimeLogger()` / `RuntimeLogFields` | `EnterpriseLogger` / `createEnterpriseLogger()` / `EnterpriseLogContext` |
| `RuntimeEvent` / `RuntimeEventPublisher` | `EnterpriseEvent` / `EnterpriseEventPublisher` |
| `RuntimeEventRecord` / `RuntimeVersionRecord` | `EnterpriseEventRecord` / `EnterpriseVersionRecord` |
| `computeRuntimeHealth()` / `RuntimeHealthReport` / `RuntimeHealthStatus` | `computeEnterpriseHealth()` / `EnterpriseHealthReport` / `EnterpriseHealthState` |
| `RuntimeHttpError` / `RuntimeHttpErrors` | `EnterpriseHttpError` / `EnterpriseHttpErrors` |
| `host.handleGovernanceEvaluate({rawBody, authorizationHeader})` | `enterprise.evaluate(rawBody, {authorizationHeader})` |
| `host.store` | `enterprise.persistence` |

The full before/after guide, including import examples, lives in
`docs/enterprise/KERNEL_HOST_TO_ENTERPRISE_MIGRATION.md`.

`GovernanceStore`, `GovernanceRequestRecord`, `GovernanceEvaluationRecord`,
`GovernanceTraceRecord`, `GovernanceEvaluateRequestBody`,
`GovernanceEvaluateResponseBody`, and `KernelProviderSet` /
`createDefaultKernelProviders` were **not** renamed -- they describe
governance/Kernel concepts, not the prior `kernel-host` module name, and
were never ambiguous with `src/runtime/`.

## Composition Root

`createEnterprise(options?: CreateEnterpriseOptions): Promise<AocEnterprise>`
is the Enterprise Host's single composition root (mission: "Create one
Enterprise composition root"). It constructs, in order:

1. `EnterpriseConfiguration` (env-derived, or injected).
2. A `KernelProviderSet` (the Kernel's real `recognitionProvider`/`clock`/`idGenerator`)
   -- or accepts an already-built `AocKernel` directly via `options.kernel`,
   in which case `kernelProviders` is only used for its clock/id generator
   in orchestration, not to construct a second Kernel instance.
3. `GovernanceStore` (in-memory or SQLite, per configuration, or injected).
4. `EnterpriseEventPublisher`, `EnterpriseTelemetry`, `EnterpriseLogger` (all injectable).
5. `AocKernel` (via `createAocKernel`, unless `options.kernel` was supplied).
6. Records one `EnterpriseVersion` row for this boot.

The Kernel receives only the four ports it defines in
`kernel/contracts/ports.ts`; it never sees `EnterpriseConfiguration`, the
`GovernanceStore`, the event publisher, or any other Enterprise concern.

`createDefaultEnterprise(configuration?)` is a convenience wrapper --
`createEnterprise({configuration})` with every other dependency defaulted.
Real use: `scripts/run-enterprise-host.mjs` and local development, where
nothing needs to be injected.

**Lifecycle:** `AocEnterprise` deliberately has no `start()`/`stop()` -- it
does not own an HTTP listener's lifecycle. `EnterpriseServer`
(`createEnterpriseServer()`) does: `listen()` binds a `node:http` server and
`close()` tears down both the server and the underlying `AocEnterprise`
(`persistence.close()`). The HTTP server consumes only the stable
`AocEnterprise.evaluate()`/`.health()` interface -- it has no visibility
into how the Kernel, persistence, or providers were composed.

```ts
const enterprise = await createEnterprise({ kernel, persistence, eventPublisher, telemetry, logger, configuration });
// or, for a full HTTP service:
const server = await createEnterpriseServer({ kernelProviders });
await server.listen();
```

## Compatibility Evidence

- **Kernel parity**: `__tests__/kernel-integration.test.ts` asserts
  `enterprise.evaluate()` produces a byte-identical `decisionId`/`status`/
  `reasonCodes`/`trace`/`summary` to calling `AocKernel.evaluate()` directly,
  for the same seeded world and deterministic clock/id sequence.
- **Endpoint parity**: `__tests__/enterprise-api-endpoint.test.ts` --
  `POST /api/governance/evaluate` and `GET /health` behave exactly as in
  PR-002 (200/422/503 status mapping, 400/401/403/409 error mapping,
  response body shape), only the module and type names changed.
- **Persistence parity**: `__tests__/persistence.test.ts` -- stored/
  idempotent-replay/conflict outcomes, trace round-tripping, and the SQLite
  transaction rollback test all still pass against the renamed
  `appendEnterpriseEvent`/`recordEnterpriseVersion` methods (SQL table
  names `RuntimeEvents`/`RuntimeVersions` are unchanged; only TypeScript
  names moved).
- **Event parity**: event *names* (`GovernanceEvaluationRequested`/
  `Completed`/`Denied`/`ApprovalRequired`/`Failed`) are unchanged -- only the
  surrounding `RuntimeEvent*` TypeScript types became `EnterpriseEvent*`.
- **Compatibility**: `__tests__/compatibility.test.ts` asserts the
  `kernel-host` shim re-exports the identical function/class references as
  `src/enterprise` (no duplicate implementation), and that
  `createEnterprise` called through the old path produces the same
  evaluation behavior.
- **Test totals**: see "Test Results" below.

## Persistence

Unchanged from PR-002 -- five tables (`GovernanceRequests`,
`GovernanceEvaluations`, `GovernanceTraces`, `RuntimeEvents`,
`RuntimeVersions`), one transaction per evaluation, in-memory default,
SQLite (`better-sqlite3`) for durability. Table/column names were **not**
renamed (no schema migration in this iteration); only the TypeScript
`EnterpriseEventRecord`/`EnterpriseVersionRecord` types and the
`GovernanceStore` methods that operate on them
(`appendEnterpriseEvent`/`listEnterpriseEvents`/`recordEnterpriseVersion`/
`getLatestEnterpriseVersion`) were renamed.

This remains **Enterprise decision persistence**, not the full Persistence
Runtime. It does not (yet) provide event sourcing, replay, Evidence
Bundles, Passport history, Assurance-grade audit preservation, retention
governance, immutable storage, or distributed consistency. See "Known
Limitations" below and PR-003.

## Health

`GET /health` now reports:

```jsonc
{
  "status": "healthy",
  "enterpriseVersion": "1.0.0",
  "kernelVersion": "1.0.0",
  "buildVersion": "1.0.0",
  "persistence": { "provider": "memory", "connected": true, "status": "connected" },
  "providers": { "loaded": ["recognitionProvider", "eventPublisher"] },
  "configurationChecksum": "80e0efdb",
  "checkedAt": "2026-07-10T00:00:00.000Z"
}
```

`enterpriseVersion` and `kernelVersion` are always distinct, real values --
`src/runtime/`'s own versioning is not reported here (this endpoint has no
visibility into `src/runtime/` at all in this iteration). No secrets,
connection strings, or API keys are ever included.

## Configuration

Environment variables were renamed from `AOC_RUNTIME_*` to
`AOC_ENTERPRISE_*` (this is new, unreleased surface from PR-002 -- not yet
a stable external contract). Full list in
`configuration/enterprise-configuration.ts`; highlights:
`AOC_ENTERPRISE_ENV`, `AOC_ENTERPRISE_VERSION`, `AOC_ENTERPRISE_LOG_LEVEL`,
`AOC_ENTERPRISE_PERSISTENCE_PROVIDER`, `AOC_ENTERPRISE_SQLITE_PATH`,
`AOC_ENTERPRISE_EVENTS_ENABLED`, `AOC_ENTERPRISE_API_KEYS`,
`AOC_ENTERPRISE_REQUIRE_AUTH`, `AOC_ENTERPRISE_TRACE_LEVEL`,
`AOC_ENTERPRISE_HTTP_PORT`, `AOC_ENTERPRISE_HTTP_HOST`.

### Credential handling (R004.B)

`AOC_ENTERPRISE_API_KEYS` (`"key1,key2:org-acme"`) is the only secret this
layer accepts today -- the static bearer tokens `evaluateGovernanceRequest`
and `resolveGovernanceAccessContext` compare an incoming `Authorization`
header against. There is no fallback/default credential: an unset
`AOC_ENTERPRISE_API_KEYS` resolves to an empty key list, so with
`AOC_ENTERPRISE_REQUIRE_AUTH=true` every request is rejected until real keys
are configured (fail closed).

The raw keys never leave `loadEnterpriseConfiguration()`'s resolved
`EnterpriseConfiguration` except through two routes, both server-side and
trusted:

- the closures inside `createEnterprise()` (`evaluate()`, `health()`, module
  construction), and
- `getInternalEnterpriseConfiguration(enterprise)`
  (`composition/composition-root.ts`, not re-exported from `index.ts`),
  which `adapters/node-http-adapter.ts` uses to authenticate HTTP callers.

`AocEnterprise.configuration` -- the public field any embedder holding an
`AocEnterprise` instance can read -- is the redacted
`PublicEnterpriseConfiguration` view (`toPublicEnterpriseConfiguration()`):
every non-secret setting is preserved; `authentication.apiKeys` is replaced
by `authentication.apiKeyCount` (a count) and
`authentication.apiKeyOrganizationScopes` (which configured keys are
organization-scoped, never the key values). It is never reachable via direct
property access, `JSON.stringify`, or an object spread of `configuration` or
of the `AocEnterprise` instance itself -- see
`src/enterprise/__tests__/credential-exposure.test.ts`.

## Future Enterprise Modules

Not built in this iteration, deliberately out of scope:

- Full plugin lifecycle / registration (**PR-003**).
- The full Persistence Runtime (normalized schema, replay, Evidence
  Bundles, Passport history, Assurance-grade audit) -- **PR-003**.
- Passport, Evidence, Jurisdiction, and Constitutional Runtimes.
- A public SDK wrapping this HTTP endpoint.
- Distributed event publication (a message broker).
- Explicit, injected consumption of `src/runtime/` services from within
  `evaluateGovernanceRequest()` -- reserved in `CreateEnterpriseOptions`'s
  shape, not implemented.

## Deployment

```bash
npm run build
npm run start:enterprise        # scripts/run-enterprise-host.mjs -> bootEnterpriseHost()
# `npm run start:kernel-host` still works (points at the same script), transitionally.
```

The secure production path is the next section. `createEnterprise()` and
`createEnterpriseServer()` remain the **embedding** surface; they apply none
of the secure-profile rules below.

## Secure production host (PROD-01)

### One canonical path

```
npm run start:enterprise
  └─ scripts/run-enterprise-host.mjs        thin launcher: print posture, handle SIGINT/SIGTERM
      └─ bootEnterpriseHost()               src/enterprise/host/enterprise-host.ts
          ├─ loadEnterpriseHostConfiguration   strict env + governed-action file   (refuse)
          ├─ createEnterpriseServer            -> createEnterprise (composition root)
          │     authority signing keys checked before any store opens;
          │     every store it opens is closed again if composition fails     (refuse)
          ├─ posture + health gate             composed == required; signed revocation
          │                                    state verifies; required modules healthy (refuse, closed)
          └─ listen()                          only now is a socket bound
```

Tests call `bootEnterpriseHost()` directly
(`src/enterprise/__tests__/enterprise-host.test.ts`), and
`tests/enterprise-host-launcher.test.mjs` pins that the launcher delegates to
it and composes nothing itself.

### Profiles

`AOC_ENTERPRISE_ENV` selects the profile. There is no other mode flag.

| Profile | Persistence | Authentication | Governed actions | Bind |
|---|---|---|---|---|
| `development`, `test` | `memory` (default) or `sqlite` | optional | optional (file) | loopback unless auth is on |
| `production`, `staging` | `sqlite`, stated explicitly | **required**, with credentials | **required** (file) | any, auth is on |

Every variable is read strictly by the bootstrap
(`validateEnterpriseEnvironment`): `AOC_ENTERPRISE_ENV=prod`,
`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqllite` or `AOC_ENTERPRISE_REQUIRE_AUTH=yes`
refuse to boot. The lenient `loadEnterpriseConfiguration` is unchanged for
embedders.

### Minimum secure configuration

```bash
AOC_ENTERPRISE_ENV=production
AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite
AOC_ENTERPRISE_REQUIRE_AUTH=true
AOC_ENTERPRISE_HTTP_HOST=0.0.0.0                  # or 127.0.0.1 behind a TLS proxy
AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED=true
AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID=org-acme
AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID=authority-key-2026-01
AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM=<secret, PKCS#8>
AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS='[{"keyId":"authority-key-2026-01","algorithm":"ed25519-v1","publicKeyPem":"..."}]'
AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE=/etc/frontera/governed-actions.json
# every AOC_ENTERPRISE_*_SQLITE_PATH on a persistent volume (see .env.example)
# plus each secret variable the governed-action file names
npm run start:enterprise
```

### The governed-action file

JSON, `version: 1`, closed schema (an unknown field refuses to boot). A
reviewed example: `examples/enterprise-host/governed-actions.example.json`.

| Field | Meaning |
|---|---|
| `trustDomainId` | The trust domain governed actions are evaluated in |
| `grantLifetimeSeconds` | Bounded-grant lifetime from the committed decision, 1 … 3600 |
| `customerPrincipals[]` | `principalId`, `externalSubject {system, subjectId}`, `apiKeyEnv`. Each becomes a customer credential scoped to `AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID`, bound to the Kernel Authority actor carrying that external subject |
| `monetary` | Optional. `assets [{assetId, scale}]`, `financialActions []` (P9) |
| `genericHttpAdapters[]` | `EnterpriseGenericHttpExecutionAdapterOptions` (`AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`), except `credential` is `{kind:'bearer', tokenEnv}` or `{kind:'header', name, valueEnv}` |
| `routes[]` | `{action, adapterId}`. An action with no route reaches no adapter |

**The file holds no secrets.** A secret is named by the variable that holds
it; an inline `token`, `value` or `key` is refused. A named variable that is
unset or empty refuses to boot (`HOST_SECRET_REFERENCE_UNRESOLVED`, naming the
variable, never a value). A secret used by two credentials refuses
(`HOST_CREDENTIALS_AMBIGUOUS`).

### What the secure Host composes

| Capability | Status on the secure Host |
|---|---|
| Customer principal binding (API key → principal → subject → actor) | **required** |
| Durable Kernel Authority world + trusted in-process provisioning surface | **required** |
| Grant-aware Kernel, Governance Store commit/re-read | **required** |
| Authenticated durable bounded-grant store (signed, revocation-state verified, CORE-01) | **required**; its health is part of readiness |
| P7 exercise controls, durable ledger; P10 authority-sourced ceilings | **required**; no host-imposed aggregate limits (the authority's own apply) |
| P11 durable execution outcomes | **required** |
| Durable emergency control (P4) | composed; operator surface in-process only (CTRL-01) |
| P8 authority event stream | optional by design (evidence never blocks) |
| Generic HTTP adapter(s) behind the trusted registry, routed by the file | composed as configured |
| P12 reconciliation | not wired: no resolution authority implementation ships |
| Policy packs | not wired: no durable policy store (CORE-03 / NB-008) |
| Obligations, trusted context | not wired: CORE-04 |
| Durable approvals | not wired: `approval_required` stays withheld (CORE-05) |
| Evidence bundle store | in-memory on every Host (ASSURE) |

The authority binding every grant states is
`HOST_ORGANIZATIONAL_AUTHORITY_BINDING` (`organizational-authority`): the Host
composes no mandate or representative-authority window. Exercise-time lineage
is revalidated for financial actions (P10); for non-financial actions the
bound is the grant lifetime, at most one hour, until CORE-04.

### Refusal codes

`EnterpriseHostConfigurationError.code`, printed by the launcher as
`refused to start [CODE] message` with exit status 1. Messages name variables
and fields, never values; no stack trace is printed.

| Code | When |
|---|---|
| `HOST_ENVIRONMENT_INVALID` | A variable does not parse strictly (includes malformed `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`) |
| `HOST_UNAUTHENTICATED_NETWORK_BIND` | Authentication off and a non-loopback bind |
| `HOST_CREDENTIALS_MISSING` | Authentication required, no credential |
| `HOST_CREDENTIALS_AMBIGUOUS` | One secret configured for two credentials |
| `HOST_PERSISTENCE_NOT_DURABLE` | Secure profile without explicit `sqlite` |
| `HOST_AUTHENTICATION_REQUIRED` | Secure profile without `AOC_ENTERPRISE_REQUIRE_AUTH=true` |
| `HOST_GOVERNED_ACTIONS_REQUIRED` | Secure profile without the governed-action file |
| `HOST_KERNEL_AUTHORITY_REQUIRED` | Governed actions without the durable Kernel Authority source, or secure profile with it optional |
| `HOST_AUTHORITY_SIGNING_KEY_REQUIRED` | Secure profile without signing key and trusted set |
| `HOST_GOVERNED_ACTIONS_FILE_UNREADABLE` / `_INVALID` | The file cannot be read, or breaks the schema |
| `HOST_SECRET_REFERENCE_UNRESOLVED` | A named secret variable is unset or empty |
| `HOST_EXECUTION_ROUTE_INVALID` | No route, or a route to an unconfigured adapter |
| `HOST_COMPOSITION_INCOMPLETE` | The composed Enterprise does not have the posture the profile requires |
| `HOST_NOT_HEALTHY` | Composed, but a required module is unhealthy — e.g. the signed revocation state of the grant store does not verify |

Composition's own refusals pass through unchanged: a signing key absent from
the trusted set or not matching it (`AuthorityAuthenticityConfigurationError`),
invalid Generic HTTP configuration (`GenericHttpConfigurationError`), invalid
customer credentials (`CustomerIdentityConfigurationError`), an unopenable
store.

### Health, readiness and posture

- `GET /live` — the process is running (lifecycle only).
- `GET /ready` — `200` only when the lifecycle is ready **and** `/health` is
  not `unhealthy`. On a secure Host the governed spine is `required`, so a
  grant store whose revocation state stops verifying makes the Host not
  ready.
- `GET /health` — `healthy`: every module healthy; `degraded`: ready, an
  optional module impaired; `unhealthy` (HTTP 503): not ready, the Governance
  Store unreachable, or a required module unhealthy. It carries `posture`:
  `environment`, `persistence` (`durable`/`ephemeral`), `authentication`,
  `governedActions`, `authorityStore`
  (`authenticated-durable`/`unauthenticated`/`not-composed`),
  `kernelAuthority`, `emergencyControl`, `exerciseControls`, and a count of
  execution adapters. No secret, key, path or adapter identity.

### Shutdown

`SIGINT`/`SIGTERM` → the listener stops accepting and idle connections close
→ the lifecycle shuts modules down in reverse order → every store the
composition root opened is closed (each exactly once; host-supplied stores
are the host's). A second signal is ignored; the process exits 0, or 1 if
shutdown failed.

### What an operator still does by hand

- **Provisioning authority** (actors, trust domain, grants, delegations) and
  **revoking** it has no HTTP route yet: it is the trusted in-process
  `AocEnterprise.kernelAuthorityProvisioning` surface (CTRL-01).
- **Revoking a bounded grant** and **activating an emergency stop** are
  in-process too (`authorityControlledExecution.revokeGrant`,
  `emergencyControlAdministration`).
- **Backup/restore** covers four stores; the governed-action stores are
  PROD-02.
- The authority signing key is process-resident (AA-001, CORE-02).

Embedding without `node:http` (e.g. a Next.js route handler):

```ts
import { createEnterprise } from '@aoc-enterprise/runtime/enterprise';

const enterprise = await createEnterprise();
export async function POST(req: Request) {
  const outcome = await enterprise.evaluate(await req.json(), { authorizationHeader: req.headers.get('authorization') ?? undefined });
  return Response.json(outcome.body, { status: outcome.httpStatus });
}
```

## Test Results

Command:

```bash
npm run build && node --test dist/src/enterprise/__tests__/*.js
```

Result: **64 tests / 16 suites, 64 passed, 0 failed.** (Up from PR-002's 52
tests / 14 suites -- 8 new tests: 2 added to the composition-root suite
(`options.kernel` pass-through, "fails clearly when persistence cannot be
constructed"), plus 6 across the two new suites,
`structural-boundaries.test.ts` and `compatibility.test.ts`.) Every test
still executes the real `AocKernel`.

Also run and confirmed green:

```bash
npx tsc -b --pretty false           # typecheck -- clean
npm run build                       # clean
npm run lint                        # Node16 imports, architecture, public-surface -- all pass
```

> Note (2026-07-12 doc audit): the root `npm test` script has since been scoped to `dist/src/**/*.test.js`, `tests/**/*.test.mjs`, and per-workspace suites (`npm test --workspaces --if-present`); the unscoped-discovery issue described in this historical paragraph no longer applies.

`npm test` (the repo-root script, `npm run build && node --test` with no
scoping) was run and re-confirmed: it discovers **every** package's `.ts`
test sources directly (no TypeScript loader) in addition to the compiled
`.js` this PR's own suite produces, and that pre-existing, unrelated
discovery issue is unchanged -- confirmed against a clean `origin/main`
checkout before this iteration began (354 pre-existing failures, e.g.
`apps/agent-passport-web/__tests__/*.test.ts`,
`packages/pmfreak-agent-passport-foundation/__tests__/*.test.ts`,
`src/features/action-enforcement/tests/*.test.ts`). This iteration's own
8 new `src/enterprise/__tests__/*.test.ts` source files are additionally
(and correctly) flagged by that same pre-existing root-harness limitation,
exactly like every other package's `.ts` test file already was -- this is
not a regression this PR introduces.

## Customer governed actions (1.3.0)

`POST /api/governed-actions` is the one customer-facing route onto the
Governed Action path. It is **capability-gated**: the adapter mounts it only
when the composed `AocEnterprise` has both `customerIdentityAdmission` and
`governedActionOrchestrator` (and therefore `governAction`); otherwise it is the
ordinary `404 NOT_FOUND`. The adapter stays translational:

```
read body -> enterprise.governAction(rawBody, { authorizationHeader }) -> write { httpStatus, body }
```

`governAction` admits the caller through the customer plane (never the legacy
`AOC_ENTERPRISE_REQUIRE_AUTH` path, and never optional), then hands the bound
identity and the untouched body to `govern()`. Nothing below the orchestrator
— the Kernel, the Governance Store, grant issuance, exercise, the adapter
registry or emergency control — is reachable from the adapter. See
`docs/enterprise/API_STABILITY_V1.md` §2.6 for the wire contract and
`docs/security/SECURITY_INVARIANTS.md` SEC-INV-055 … SEC-INV-061.

## Known Limitations

The Soberanía Enterprise Host still lacks:

- Full plugin lifecycle (registration, dependency graph, module readiness) -- **PR-003**.
- The full Persistence Runtime (event sourcing, replay, retention governance, immutable storage, distributed consistency).
- Passport integration.
- Evidence Bundles.
- Assurance-grade Audit Records.
- Jurisdiction Runtime.
- Constitutional Runtime.
- A public SDK.

## Recommended Next PR

**PR-003 -- Soberanía Enterprise Composition Root v1.** Formalize plugin
registration, lifecycle, provider resolution, configuration validation, the
dependency graph, module readiness, controlled access to Runtime services,
and Enterprise startup/shutdown semantics -- without adding governance
decision logic. `createEnterprise()`/`CreateEnterpriseOptions` as they
exist today are the foundation that PR extends, not replaces.
