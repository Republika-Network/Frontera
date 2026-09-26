# Track 2.4 — Explicit SDK Host Composition and Registry-Free Runtime Consumption

## Public SDK consumption model

External hosts compose Frontera Systems Runtime with `createAocEnterpriseRuntime()` from `@aoc-enterprise/runtime` or `@aoc-enterprise/runtime/runtime-host`. The factory accepts host-provided runtime ports and returns a stable runtime object with these methods:

- `evaluate(input)`
- `enforce(input)`
- `issueExecutionGrant(input)`
- `validateExecutionGrant(input)`
- `consumeExecutionGrant(input)`
- `issueDelegatedCapability(input)`
- `evaluateDelegatedAccess(input)`
- `revokeDelegatedCapability(input)`
- `createCapabilityClaim(input)`
- `verifyCapabilityClaim(claim, expected)`

The host owns identity resolution, capability lookup, delegation validation, policy evaluation, agent access evaluation, audit emission, and signing. The runtime closes over an explicit `RuntimeContext` and does not require a process-global registry.

## Host-provided RuntimeContext model

`RuntimeContext` is the portable composition unit. It contains:

- `metadata`: runtime identity, trust domain, environment, version, and host metadata.
- `identity`: resolves actor identity for authorization requests.
- `capabilityRegistry`: evaluates whether an actor holds a capability in an organization.
- `delegationStore`: validates delegated capabilities.
- `policyDecision`: evaluates enterprise policy.
- `agentAccess`: evaluates scoped agent/runtime access.
- `auditSink`: emits canonical authorization audit envelopes.
- `signer`: signs and verifies runtime-issued execution grants, delegated capabilities, and capability claims.

These interfaces are exported as SDK types so external hosts can compile against the runtime without importing a host application, route handler, database client, or application bootstrap.

## Registry-free execution model

The portable runtime factory does not call `getAocAdapter()` and does not mutate adapter registries. Registry access, where present in future compatibility layers, must remain in a composition root and must not be required by `createAocEnterpriseRuntime()` consumers.

A minimal external host looks like this:

```ts
import { createAocEnterpriseRuntime } from '@aoc-enterprise/runtime';
import { createHostPorts } from './host-ports.js';

const runtime = createAocEnterpriseRuntime(createHostPorts());
const decision = await runtime.enforce(input);
```

## API classification

| Classification | Public API | Notes |
| --- | --- | --- |
| Portable explicit-context APIs | `createAocEnterpriseRuntime`, `RuntimeContext`, `RuntimeMetadata`, `RuntimeSignerPort`, runtime port interfaces, `evaluateEnforcementPipeline`, `orchestrateAuthorization`, `verifyCapabilityToken`, `verifyDelegatedCapability` | Suitable for SDK consumers. They accept or close over explicit dependencies. |
| Registry-backed convenience APIs | None in the current package export surface | If added later, names and docs must state that they compose from a registry-backed root and are internal/compatibility conveniences. |
| PMFreak compatibility APIs | None in the current package export surface | PMFreak-specific adapters and bootstraps must stay outside this SDK package. |
| Internal-only APIs | Implementation modules under `src/runtime/**` that are not package export entries | Public consumers should use root, `./runtime`, `./runtime-host`, `./authorization`, `./audit`, `./crypto`, or `./adapters` exports only. |

## Portable vs registry-backed API distinction

Portable APIs must satisfy all of these constraints:

1. Accept or close over a `RuntimeContext`.
2. Avoid `getAocAdapter()` and process-global registry reads.
3. Avoid application-specific import aliases.
4. Avoid direct database, web framework, or route dependencies.
5. Return canonical runtime decision envelopes where authorization decisions are involved.

Registry-backed convenience APIs may compose a `RuntimeContext` from an application registry, but they are not SDK-portable and must be documented as compatibility helpers.

## Non-host-app starter example

The starter in `examples/enterprise-runtime-host/` shows a mock external host. It provides ports, creates the runtime, calls `enforce()`, and handles the returned decision. The mocks are intentionally small so hosts can replace them with real infrastructure without changing runtime consumption.

## Remaining SDK blockers

- Publish-ready protocol dependency wiring should replace the local compile-time protocol bridge used in this repository checkout.
- Execution grant persistence and one-time-consumption semantics need a durable host port before production use.
- Delegated-capability revocation currently exposes the API shape but requires host-backed revocation storage for production enforcement.
- Release documentation should add semver guarantees for each public runtime method and port.

## Next release-readiness steps

1. Add durable grant and delegation stores to the portable `RuntimeContext`.
2. Add package-level API extractor or declaration-leak checks for the new runtime-host export.
3. Add external consumer fixture coverage for `@aoc-enterprise/runtime/runtime-host`.
4. Replace mock starter ports with templates for common infrastructure integrations.

## Recommended next Track 2 prompt

Track 2.5 should focus on production-grade grant/delegation lifecycle ports: durable issuance, validation, consumption, revocation, audit guarantees, and replay protection while keeping the external-host model registry-free.
