# Soberanía PMFreak Governance Request Intake v1

Intake ID:

```
aoc.integration.pmfreak.governance_request_intake.v1
```

Repo:

```
Frontera Systems
```

Purpose:

```
This module lets Frontera Systems receive and evaluate PMFreak governance requests.
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
PMFreak agent attempts an action.
PMFreak builds a Soberanía governance request.
Frontera Systems receives the request.
Frontera Systems evaluates the request.
Frontera Systems returns a governed decision.
PMFreak receives the decision.
```

This PR implements the Soberanía-side intake/evaluator boundary only -- the receiving end of that flow. The PMFreak-side request builder is defined by `PMFreak AOC Governance Request Client v1`, a separate contract in the PMFreak repo. This repo never imports from the PMFreak repo; it owns its own Soberanía-side compatibility DTOs (`AocPMFreakGovernanceRequest`, `AocPMFreakGovernanceResponse`) that mirror that contract's vocabulary.

Incorrect (not what this module does):

```
Soberanía crawls PMFreak data.
Soberanía mutates PMFreak state.
Soberanía sends emails/invoices/client communications from this intake.
Soberanía certifies invoice validity, customer acceptance, compliance, or legal status.
```

## Relationship to the existing PMFreak demo layers

Frontera Systems already has a PMFreak governed-agent demo stack:

```
Soberanía PMFreak Agent Passport Demo Pack v1                    (src/features/aoc-enterprise-demo/pmfreak-agent-passport)
Soberanía PMFreak Project Governance Scenario Pack v1             (src/features/aoc-enterprise-demo/pmfreak-project-governance-scenarios)
Soberanía PMFreak Demo Control Plane View v1                      (src/features/aoc-enterprise-demo/pmfreak-demo-control-plane-view)
Soberanía PMFreak Demo Narrative Export Pack v1                   (src/features/aoc-enterprise-demo/pmfreak-demo-narrative-export)
```

Those layers established that PMFreak agents can be modeled as Soberanía-governed actors, that Soberanía can evaluate passports/capability/authority scope/evidence/approvals, and that Soberanía can produce and explain deterministic scenario decisions. Every one of those layers is an *Soberanía-initiated* simulation: Soberanía builds the scenario and evaluates it itself.

This intake is different: it is the boundary where **PMFreak initiates** the request. In `deterministic_local` mode (the default), it evaluates a PMFreak-declared request (evidence/approvals already marked provided or missing by PMFreak) directly against the PMFreak Governance Request Client v1 decision rules -- it does not duplicate the passport catalog's evidence/approval-requirement lookups. In the optional `passport_runtime` mode, it delegates to the existing, exported `resolvePMFreakAgentPassportAction` resolver from the Agent Passport Demo Pack (`src/features/aoc-enterprise-demo/pmfreak-agent-passport`) against that pack's own deterministic fixture registry, rather than re-implementing passport/authority/evidence/approval gating a second time. It never uses the newer `@aoc-enterprise/pmfreak-agent-passport-foundation` workspace package for this, because that package's resolver is asynchronous and requires real cryptographic passport/capability-token/runtime-guard material this bare intake boundary has no safe way to synthesize -- wiring it here would mean forcing a brittle import rather than a clean one.

## Possible decisions

```
allow
deny
hold
require_evidence
require_pm_approval
require_customer_validation
require_billing_review
require_contract_review
require_security_review
require_executive_approval
```

`deterministic_local` decision rules, in priority order (first match wins):

```
1. invalid request                          -> deny
2. actionAttempt.status === 'cancelled'      -> deny
3. billing action + missing evidence         -> require_evidence
4. billing action + missing billing_review   -> require_billing_review
5. missing evidence                          -> require_evidence
6. missing pm_approval                       -> require_pm_approval
7. missing customer_validation                -> require_customer_validation
8. missing contract_review                    -> require_contract_review
9. missing security_review                    -> require_security_review
10. missing executive_approval                -> require_executive_approval
11. otherwise                                 -> allow
```

`passport_runtime` mode maps the resolver's decision vocabulary onto the list above 1:1, except `require_legal_review` (which this intake's public vocabulary has no dedicated bucket for) is routed through `require_contract_review`, the closest existing review path -- every response still carries a fixed disclaimer that this is never legal advice or legal clearance.

## Architecture

```
PMFreak
  |  sends governance request
  v
Soberanía PMFreak Governance Request Intake   (this module)
  |  validates / redacts / normalizes request
  v
Soberanía PMFreak governance evaluation        (deterministic_local, or passport_runtime via the Agent Passport Demo Pack resolver)
  |  returns governed decision
  v
PMFreak receives response
```

| File | Provides |
| --- | --- |
| `aoc-pmfreak-governance-intake-constants.ts` | Intake id/name/version, system ids, capability/forbidden-operation/safe-label/disclaimer constants |
| `aoc-pmfreak-governance-intake-types.ts` | Every domain type: descriptor, config, request/response compatibility DTOs, validation result, evaluation input, client, error, health, claim safety |
| `aoc-pmfreak-governance-intake-descriptor.ts` | `createAocPMFreakGovernanceRequestIntakeDescriptor` |
| `aoc-pmfreak-governance-intake-config.ts` | `createAocPMFreakGovernanceRequestIntakeConfig` -- safe by default, forces mutation/execution/writeback flags to `false` |
| `aoc-pmfreak-governance-request-compat.ts` | Re-exports the PMFreak governance request compatibility type on its own import path |
| `aoc-pmfreak-governance-response-compat.ts` | Re-exports the Soberanía governance response compatibility type on its own import path |
| `aoc-pmfreak-governance-intake-validator.ts` | `validateAocPMFreakGovernanceRequest` -- pure, read-only, no network |
| `aoc-pmfreak-governance-request-redaction.ts` | `redactAocPMFreakGovernanceRequestValue`, `redactAocPMFreakGovernanceRequest` |
| `aoc-pmfreak-request-to-passport-adapter.ts` | `mapAocPMFreakGovernanceRequestToEvaluationInput`, `mapAocPMFreakGovernanceRequestToPassportResolverInput` |
| `aoc-pmfreak-governance-evaluator.ts` | `evaluateAocPMFreakGovernanceRequest` -- the deterministic decision engine |
| `aoc-pmfreak-governance-response-builder.ts` | `createAocPMFreakGovernanceResponse` |
| `aoc-pmfreak-governance-decision-mapping.ts` | `mapAocPMFreakDecisionToLabel`, `mapAocPMFreakDecisionToSeverity`, `createAocPMFreakDecisionSafeSummary` |
| `aoc-pmfreak-governance-intake-client.ts` | `createAocPMFreakGovernanceRequestIntakeClient` -- the intake facade |
| `aoc-pmfreak-governance-intake-errors.ts` | `createAocPMFreakGovernanceIntakeError` |
| `aoc-pmfreak-governance-intake-health.ts` | `createAocPMFreakGovernanceIntakeHealth` |
| `aoc-pmfreak-governance-intake-fixtures.ts` | Deterministic demo request/response fixtures |
| `aoc-pmfreak-governance-intake-claim-safety.ts` | Intake-specific unsafe-claim phrases, additive to (never replacing) the universal Policy Pack Foundation list |

## What this module is not

It is not a production HTTP API -- this PR implements a pure typed intake/evaluator module only; a later PR (`Soberanía PMFreak Remote Governance Endpoint v1`) may expose it over HTTP once the repo's route conventions (currently only in `apps/agent-passport-web`, a separate Next.js app) explicitly support it and tests remain safe. It performs no PMFreak project/task/milestone/schedule/risk mutation, no client communication or email/Slack/Teams sending, no invoice creation, no OAuth, no secret/credential generation, and no external network call.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`, no `crypto.randomUUID()`. Every fixture id is a fixed literal, and the response id is derived deterministically from the request id. See `tests/aoc-pmfreak-governance-intake-determinism.test.ts`.

## Next possible PR

```
Soberanía PMFreak Remote Governance Endpoint v1
```

Only after this pure intake/evaluator module is stable.
