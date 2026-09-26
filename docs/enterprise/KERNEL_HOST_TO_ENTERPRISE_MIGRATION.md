# Migration: `kernel-host` -> `enterprise`

This guide covers the rename introduced by the "Rename Kernel Host to
Enterprise Host" iteration on top of PR-002 (Frontera Systems Runtime Host
v1). No behavior changed -- see
`docs/enterprise/AOC_ENTERPRISE_HOST.md` for what stayed the same and
`docs/architecture/ADR-ENTERPRISE-HOST-NAMING.md` for why the rename
happened.

## Module path

| Old | New |
| --- | --- |
| `src/kernel-host/` | `src/enterprise/` |
| `@aoc-enterprise/runtime/kernel-host` | `@aoc-enterprise/runtime/enterprise` |

```ts
// Before
import { buildRuntimeHost } from '@aoc-enterprise/runtime/kernel-host';

// After
import { createEnterprise } from '@aoc-enterprise/runtime/enterprise';
```

## Symbol renames

| Old | New | Notes |
| --- | --- | --- |
| `buildRuntimeHost(overrides)` | `createEnterprise(options)` | `overrides.store` is now `options.persistence`. `options.kernel` is new -- pass an already-built `AocKernel` directly instead of `kernelProviders`. |
| -- (none) | `createDefaultEnterprise(configuration?)` | New convenience factory; `createEnterprise({configuration})` with everything else defaulted. |
| `RuntimeHost` | `AocEnterprise` | `.store` -> `.persistence`. `.handleGovernanceEvaluate({rawBody, authorizationHeader})` -> `.evaluate(rawBody, {authorizationHeader})`. |
| `RuntimeHostOverrides` | `CreateEnterpriseOptions` | |
| `createRuntimeHostServer(overrides)` | `createEnterpriseServer(options)` | |
| `RuntimeHostServer` | `EnterpriseServer` | `.host` -> `.enterprise`. |
| `createRuntimeHostRequestListener(host)` | `createEnterpriseRequestListener(enterprise)` | |
| `RuntimeConfiguration` | `EnterpriseConfiguration` | `.runtimeVersion` -> `.enterpriseVersion`. |
| `loadRuntimeConfiguration(env)` | `loadEnterpriseConfiguration(env)` | Env vars renamed `AOC_RUNTIME_*` -> `AOC_ENTERPRISE_*` (see below). |
| `RuntimeEnvironment` | `EnterpriseEnvironment` | |
| `RuntimePersistenceProviderKind` | `EnterprisePersistenceProviderKind` | |
| `RuntimeFeatureFlags` | `EnterpriseFeatureFlags` | |
| `RuntimeApiKey` | `EnterpriseApiKey` | |
| `RuntimeTelemetry` / `createRuntimeTelemetry()` | `EnterpriseTelemetry` / `createEnterpriseTelemetry()` | `recordRuntimeFailure()` -> `recordEnterpriseFailure()`. |
| `RuntimeTelemetrySnapshot` | `EnterpriseMetricsSnapshot` | `runtimeFailureCount` -> `enterpriseFailureCount`. |
| `RuntimeLogger` / `createRuntimeLogger()` | `EnterpriseLogger` / `createEnterpriseLogger()` | |
| `RuntimeLogFields` | `EnterpriseLogContext` | `.runtimeVersion` -> `.enterpriseVersion`. |
| `RuntimeLogLevel` / `RuntimeLoggerSink` | `EnterpriseLogLevel` / `EnterpriseLoggerSink` | |
| `RuntimeEvent` / `RuntimeEventType` / `RuntimeEventBase` | `EnterpriseEvent` / `EnterpriseEventType` / `EnterpriseEventBase` | Event *names* (`GovernanceEvaluationRequested` etc.) are unchanged. |
| `RuntimeEventPublisher` | `EnterpriseEventPublisher` | |
| `RuntimeEventRecord` | `EnterpriseEventRecord` | Persisted in the (unrenamed) `RuntimeEvents` SQL table. |
| `RuntimeVersionRecord` | `EnterpriseVersionRecord` | `.runtimeVersion` -> `.enterpriseVersion`. Persisted in the (unrenamed) `RuntimeVersions` SQL table. |
| `GovernanceStore.appendRuntimeEvent()` | `.appendEnterpriseEvent()` | |
| `GovernanceStore.listRuntimeEvents()` | `.listEnterpriseEvents()` | |
| `GovernanceStore.recordRuntimeVersion()` | `.recordEnterpriseVersion()` | |
| `GovernanceStore.getLatestRuntimeVersion()` | `.getLatestEnterpriseVersion()` | |
| `computeRuntimeHealth()` | `computeEnterpriseHealth()` | |
| `RuntimeHealthReport` | `EnterpriseHealthReport` | `.runtimeVersion` -> `.enterpriseVersion`; `.database` -> `.persistence` (now includes a `status` field); `.providers` is now `{loaded: string[]}` instead of three booleans. |
| `RuntimeHealthStatus` | `EnterpriseHealthState` | The `'healthy' \| 'degraded' \| 'unhealthy'` enum. |
| `RuntimeHealthDependencies` | `EnterpriseHealthDependencies` | |
| `RuntimeHttpError` / `RuntimeHttpErrors` | `EnterpriseHttpError` / `EnterpriseHttpErrors` | |
| `RuntimeHttpErrorCode` | `EnterpriseHttpErrorCode` | |
| `EvaluateGovernanceRequestOutcome` | `EnterpriseEvaluationResponse` | |

**Not renamed** (already domain-appropriate, never ambiguous with the old
`kernel-host` name or `src/runtime/`): `GovernanceStore`,
`GovernanceRequestRecord`, `GovernanceEvaluationRecord`,
`GovernanceTraceRecord`, `GovernanceEvaluateRequestBody`,
`GovernanceEvaluateResponseBody`, `PersistEvaluationInput/Result/Outcome`,
`KernelProviderSet`, `KernelWorldHandles`, `createDefaultKernelProviders`,
`EvaluateGovernanceRequestInput`/`Dependencies`, `evaluateGovernanceRequest`,
every `GovernanceEvaluation*Event` type name, and the entire Kernel surface
(`AocKernel`, `KernelEvaluationRequest`, etc.).

## Environment variables

| Old | New |
| --- | --- |
| `AOC_RUNTIME_ENV` | `AOC_ENTERPRISE_ENV` |
| `AOC_RUNTIME_HOST_VERSION` | `AOC_ENTERPRISE_VERSION` |
| `AOC_RUNTIME_LOG_LEVEL` | `AOC_ENTERPRISE_LOG_LEVEL` |
| `AOC_RUNTIME_PERSISTENCE_PROVIDER` | `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` |
| `AOC_RUNTIME_SQLITE_PATH` | `AOC_ENTERPRISE_SQLITE_PATH` |
| `AOC_RUNTIME_EVENTS_ENABLED` | `AOC_ENTERPRISE_EVENTS_ENABLED` |
| `AOC_RUNTIME_TELEMETRY_ENABLED` | `AOC_ENTERPRISE_TELEMETRY_ENABLED` |
| `AOC_RUNTIME_API_KEYS` | `AOC_ENTERPRISE_API_KEYS` |
| `AOC_RUNTIME_REQUIRE_AUTH` | `AOC_ENTERPRISE_REQUIRE_AUTH` |
| `AOC_RUNTIME_TRACE_LEVEL` | `AOC_ENTERPRISE_TRACE_LEVEL` |
| `AOC_RUNTIME_HTTP_PORT` | `AOC_ENTERPRISE_HTTP_PORT` |
| `AOC_RUNTIME_HTTP_HOST` | `AOC_ENTERPRISE_HTTP_HOST` |

These were introduced in PR-002 and had not shipped to any external
consumer yet, so they were renamed outright rather than dual-supported.

## npm scripts

| Old | New |
| --- | --- |
| `npm run start:kernel-host` | `npm run start:enterprise` (the old script name still works -- both point at `scripts/run-enterprise-host.mjs`) |

## Compatibility period

`@aoc-enterprise/runtime/kernel-host` still resolves: `src/kernel-host/index.ts`
is a one-line re-export, `export * from '../enterprise/index.js'`, verified
by `src/enterprise/__tests__/compatibility.test.ts` (identical exported
keys, identical function/class references -- no duplicate implementation).

```ts
// Still works during the compatibility period:
import { createEnterprise } from '@aoc-enterprise/runtime/kernel-host';
```

### Removal criteria

This repository does not yet have a formal deprecation/release-cadence
policy (`package.json` is `"private": true`, unpublished), so no calendar
date is set. Remove `src/kernel-host/`, its `package.json` export entry, and
the `start:kernel-host` npm script alias when **both** of the following are
true:
1. A repository-wide search confirms no remaining import of
   `@aoc-enterprise/runtime/kernel-host` (or `src/kernel-host`) outside this
   compatibility shim itself.
2. Whoever owns the release process for this package confirms no known
   external consumer depends on the old path.

Until then, keep the shim as the single source of truth re-export -- never
let it drift into a second implementation.
