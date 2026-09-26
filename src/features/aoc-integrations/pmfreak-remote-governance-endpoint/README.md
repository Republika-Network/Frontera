# Soberanía PMFreak Remote Governance Endpoint v1

Endpoint ID:

```
aoc.integration.pmfreak.remote_governance_endpoint.v1
```

Repo:

```
Frontera Systems
```

Purpose:

```
Expose Soberanía PMFreak Governance Request Intake through a safe remote endpoint/handler boundary.
```

Runtime direction:

```
PMFreak consumes Soberanía Governance.
```

This module does not mutate PMFreak data.
This module does not execute PMFreak actions.
This module does not write back decisions.
This module does not send communications.
This module does not create invoices.
This module does not certify invoice validity.
This module does not certify customer acceptance.
This module does not certify compliance.
This module does not provide legal advice.

## Correct flow

```
PMFreak builds a governance request.
PMFreak sends the request to the Soberanía endpoint.
Soberanía validates the request.
Soberanía evaluates the request through the existing intake.
Soberanía returns a governed decision.
PMFreak receives the decision.
```

This PR builds on the already-merged `Soberanía PMFreak Governance Request Intake v1` (`aoc.integration.pmfreak.governance_request_intake.v1`, `src/features/aoc-integrations/pmfreak-governance-request-intake`). That module already receives, validates, normalizes, and deterministically evaluates PMFreak governance requests; this module never duplicates that logic -- it only adds a request/response envelope, safety guards, and a pure handler in front of it, then delegates to `createAocPMFreakGovernanceRequestIntakeClient().receiveAndEvaluate(...)` for the actual evaluation.

Incorrect (not what this module does):

```
Soberanía crawls PMFreak data.
Soberanía mutates PMFreak state.
Soberanía sends emails/invoices/client communications from this endpoint.
Soberanía certifies invoice validity, customer acceptance, compliance, or legal status.
Soberanía re-implements governance evaluation instead of delegating to the existing intake.
```

## Default path

```
/api/aoc/pmfreak/governance/evaluate
```

This is a documented default (`AOC_PMFREAK_REMOTE_GOVERNANCE_DEFAULT_PATH`), independent of whether an actual HTTP route exists in this repo yet -- see [What this module is not](#what-this-module-is-not).

## Architecture

```
PMFreak
  |  sends HTTP request (method, path, headers, body)
  v
handleAocPMFreakRemoteGovernanceRequest        (this module's pure handler)
  |  1. build safe config
  |  2. reject an unsafe production config (environment: "production" + authMode: "none_demo")
  |  3. guard method / content-type / payload size / auth
  |  4. parse body into AocPMFreakGovernanceRequest (envelope shape check only)
  |  5. redact request
  v
Soberanía PMFreak Governance Request Intake    (already-merged, unchanged)
  |  validates / evaluates the request
  v
handleAocPMFreakRemoteGovernanceRequest
  |  claim-safety scan the response, then serialize
  v
PMFreak receives { status, headers, body }
```

| File | Provides |
| --- | --- |
| `aoc-pmfreak-remote-governance-endpoint-constants.ts` | Endpoint id/name/version, system ids, default path, capability/forbidden-operation/safe-label/disclaimer constants |
| `aoc-pmfreak-remote-governance-endpoint-types.ts` | Every domain type: descriptor, config, request/response envelope, guard result, parser result, error, health, claim safety |
| `aoc-pmfreak-remote-governance-endpoint-descriptor.ts` | `createAocPMFreakRemoteGovernanceEndpointDescriptor` |
| `aoc-pmfreak-remote-governance-endpoint-config.ts` | `createAocPMFreakRemoteGovernanceEndpointConfig` -- safe by default, forces mutation/execution/writeback/invoice/communication flags to `false`, flags an unsafe production+`none_demo` combination |
| `aoc-pmfreak-remote-governance-endpoint-handler.ts` | `handleAocPMFreakRemoteGovernanceRequest` -- the pure, framework-agnostic handler |
| `aoc-pmfreak-remote-governance-http-adapter.ts` | Documented HTTP-route adapter placeholder (see below) |
| `aoc-pmfreak-remote-governance-method-guard.ts` | `validateAocPMFreakRemoteGovernanceMethod` |
| `aoc-pmfreak-remote-governance-content-type-guard.ts` | `validateAocPMFreakRemoteGovernanceContentType` |
| `aoc-pmfreak-remote-governance-payload-guard.ts` | `validateAocPMFreakRemoteGovernancePayloadSize` |
| `aoc-pmfreak-remote-governance-auth-guard.ts` | `validateAocPMFreakRemoteGovernanceAuth` |
| `aoc-pmfreak-remote-governance-parser.ts` | `parseAocPMFreakRemoteGovernanceRequestBody` -- envelope shape check, not a re-implementation of the intake's own validator |
| `aoc-pmfreak-remote-governance-serializer.ts` | `serializeAocPMFreakRemoteGovernanceSuccess`, `serializeAocPMFreakRemoteGovernanceError` |
| `aoc-pmfreak-remote-governance-status-mapping.ts` | `mapAocPMFreakRemoteGovernanceErrorToStatus` |
| `aoc-pmfreak-remote-governance-errors.ts` | `createAocPMFreakRemoteGovernanceEndpointError` |
| `aoc-pmfreak-remote-governance-health.ts` | `createAocPMFreakRemoteGovernanceEndpointHealth` |
| `aoc-pmfreak-remote-governance-fixtures.ts` | Deterministic demo request/response fixtures, layered on the intake's own fixtures |
| `aoc-pmfreak-remote-governance-claim-safety.ts` | Endpoint-specific unsafe-claim phrases, additive to (never replacing) the universal Policy Pack Foundation list |

## Safety

```
This endpoint does not mutate PMFreak data.
This endpoint does not execute PMFreak actions.
This endpoint does not write back decisions.
This endpoint does not send communications.
This endpoint does not create invoices.
This endpoint does not certify invoice validity.
This endpoint does not certify customer acceptance.
This endpoint does not certify compliance.
This endpoint does not provide legal advice.
```

A successful evaluation always returns HTTP 200, even when the governance decision itself is `deny`, `hold`, or any `require_*` decision -- the endpoint succeeded; the governance decision lives in the response body, not the HTTP status.

## Auth modes

```
none_demo               No authentication. Allowed outside production only.
shared_secret_header     Requires a configured header name + secret value; compared
                          in constant time against the request's header value.
unsupported              Always rejected safely.
```

`none_demo` is not allowed in production. If `environment: "production"` and `authMode: "none_demo"`, the handler returns a safe `unsafe_production_config` error (HTTP 503) and never parses or evaluates the request.

No secrets are generated or stored by this module. `sharedSecretValue` must be supplied by the caller (e.g. from real deployment configuration); this module never invents, persists, or logs one, and no fixture ever carries a real-looking secret.

## Guards

Every guard is pure and returns `{ valid: boolean; error?: AocPMFreakRemoteGovernanceEndpointError }`; none of them mutate their inputs.

```
validateAocPMFreakRemoteGovernanceMethod        -- only POST by default (405 otherwise)
validateAocPMFreakRemoteGovernanceContentType   -- only application/json by default (415 otherwise)
validateAocPMFreakRemoteGovernancePayloadSize   -- 256 KB by default (413 otherwise), estimated via JSON.stringify length
validateAocPMFreakRemoteGovernanceAuth          -- see Auth modes above (401/403/503)
```

## What this module is not

It is not a production HTTP API on its own. This repo has exactly one stable HTTP route convention -- Next.js App Router `route.ts` handlers under `apps/agent-passport-web/src/app/api/**` -- and that convention belongs to a separate deployable app that only depends on `packages/*` workspace packages, never on this root package's `src/features/**` tree (see that app's `package.json` and this repo's root `package.json` `workspaces` field). Wiring an actual route there for this feature would add an undocumented cross-package dependency rather than follow an existing, clear convention, so this PR implements only the pure handler (`handleAocPMFreakRemoteGovernanceRequest`) plus a documented adapter placeholder (`aoc-pmfreak-remote-governance-http-adapter.ts`) explaining exactly what a future thin route should do. The handler itself is already framework-agnostic -- a plain `{ method, path, headers, body }` in, `{ status, headers, body }` out -- and ready to be called from a route once one exists.

It performs no PMFreak project/task/milestone mutation, no client communication or email/Slack/Teams sending, no invoice creation, no OAuth, no secret/credential generation, and no external network call.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`, no `crypto.randomUUID()`. Every fixture id is a fixed literal. See `tests/aoc-pmfreak-remote-governance-determinism.test.ts`.

## Next possible PR

```
PMFreak Soberanía Remote Governance Transport v1
```

The PMFreak-repo counterpart that actually calls this endpoint over the network, once a stable route exists for it to call.
