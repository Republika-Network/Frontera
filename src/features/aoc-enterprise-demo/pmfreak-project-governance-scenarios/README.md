# Soberanía PMFreak Project Governance Scenario Pack v1

Pack ID:

```
aoc.demo.pmfreak.project_governance_scenarios.v1
```

Purpose:

Demonstrates how Frontera Systems governs PMFreak agents inside realistic project-governance scenarios.

This pack uses the PMFreak Agent Passport Demo Pack (`aoc.demo.pmfreak.agent_passport.v1`) to evaluate whether project agents can perform attempted actions. It models scenarios such as:

- billing readiness
- milestone acceptance
- schedule change
- risk escalation
- client communication
- change control

This pack does not integrate with PMFreak production.
This pack does not access real PMFreak data.
This pack does not modify projects.
This pack does not send communications.
This pack does not create invoices.
This pack does not certify customer acceptance.
This pack does not certify invoice readiness.
This pack does not provide legal advice.
This pack does not certify compliance.

## Core rule: this pack orchestrates, it never re-decides

```
The previous PR answered: Can PMFreak agents have Frontera Systems passports?
This PR answers: What happens when PMFreak agents try to act inside real
project-governance scenarios?
```

Every scenario decision in this pack comes from `resolvePMFreakAgentPassportAction`, exported by the PMFreak Agent Passport Demo Pack:

```
Project Governance Scenario Pack
  |  calls
resolvePMFreakAgentPassportAction(...)
  |  uses
PMFreak Agent Passport Demo Pack
  |  uses
Policy Pack Foundation / no-overclaim / Control Plane / export patterns
```

This pack never re-implements passport status handling, authority-scope checks, capability-token checks, evidence gating, or approval gating. `pmfreak-scenario-runner.ts` builds a `ResolvePMFreakAgentPassportActionInput` from a scenario and its overrides, calls the resolver, and projects the resulting `PMFreakAgentPassportResolution` into a scenario-shaped, claim-safe run result. A scenario's `requiredEvidenceIds`/`requiredApprovalIds` are read directly from the passport pack's own action catalog (via `findPMFreakAction`), so they can never drift from what the resolver actually enforces.

## The primary demo scenario: Billing Readiness

The Billing Readiness Agent attempts to mark a milestone as ready for billing (`pmfreak.action.billing.mark_ready`).

Frontera Systems checks:

- passport status
- role authority
- capability token
- workspace/project/customer scope
- deliverable evidence
- customer acceptance evidence
- billing milestone evidence
- PM approval
- billing review
- billing-sensitive context
- jurisdiction pack references
- policy pack references
- audit/export trace

In this demo, `allow` means that Frontera Systems allows the governed demo action to proceed based on the configured passport, evidence, and approvals. It does not mean:

- invoice validity is certified
- customer acceptance is certified
- billing entitlement is guaranteed
- legal compliance is certified
- production mutation has occurred

## Scenario order

1. Billing Readiness -- Mark Milestone Ready (`pmfreak.scenario.billing_readiness.mark_milestone_ready`)
2. Milestone Acceptance -- Validate Acceptance Signals (`pmfreak.scenario.milestone_acceptance.validate_acceptance`)
3. Schedule Change -- Propose Replan / Apply Replan (`pmfreak.scenario.schedule_change.propose_replan`, `pmfreak.scenario.schedule_change.apply_replan`)
4. Risk Escalation -- Prepare Escalation (`pmfreak.scenario.risk_escalation.prepare_escalation`)
5. Client Communication -- Draft Status Update / Send Status Update (`pmfreak.scenario.client_communication.draft_status_update`, `pmfreak.scenario.client_communication.send_status_update`)
6. Change Control -- Classify Change Request / Approve Change Request (`pmfreak.scenario.change_control.classify_change_request`, `pmfreak.scenario.change_control.approve_change_request`)

| Scenario | Primary agent | Primary action | Real (catalog) evidence/approval gate | Typical outcome |
| --- | --- | --- | --- | --- |
| Billing Readiness | `pmfreak.agent.billing_readiness` | `pmfreak.action.billing.mark_ready` | deliverable + acceptance evidence; PM + billing approval | `require_evidence` -> `require_billing_review` -> `allow` |
| Milestone Acceptance | `pmfreak.agent.evidence` | `pmfreak.action.evidence.prepare_bundle` | deliverable evidence | `require_evidence` -> `allow` |
| Schedule Change (propose) | `pmfreak.agent.planning` | `pmfreak.action.schedule.propose_change` | schedule baseline + dependency evidence | `require_evidence` -> `allow` |
| Schedule Change (apply) | `pmfreak.agent.planning` | `pmfreak.action.schedule.apply_change` | restricted by the demo Planning Agent passport | `deny`, always |
| Risk Escalation | `pmfreak.agent.risk` | `pmfreak.action.risk.create_draft` | none | `allow` once in authority scope |
| Client Communication (draft) | `pmfreak.agent.client_communication` | `pmfreak.action.communication.draft_client_update` | none from the catalog; customer-facing context still requires PM approval | `require_pm_approval` -> `allow` |
| Client Communication (send) | `pmfreak.agent.client_communication` | `pmfreak.action.communication.send_client_update` | drafted-communication evidence + PM approval | `require_pm_approval` -> `allow` |
| Change Control (classify) | `pmfreak.agent.change_control` | `pmfreak.action.change_control.classify_request` | change-request-record evidence | `require_evidence` -> `allow`; contract/billing-sensitive impact escalates to review |
| Change Control (approve) | `pmfreak.agent.change_control` | `pmfreak.action.change_control.approve_request` | restricted by the demo Change Control Agent passport | `deny`, always |

## Documented deviations from a broader narrative reading

Two scenarios narratively evoke evidence signals that the underlying passport-pack action does not actually gate on:

- **Milestone Acceptance.** `pmfreak.action.evidence.prepare_bundle` (the Evidence Agent's action) requires only `pmfreak.evidence.deliverable_evidence` in the passport pack's action catalog. Customer-acceptance evidence is a real gate, but only for the Billing Readiness Agent's `pmfreak.action.billing.mark_ready` -- the Evidence Agent's role profile explicitly states it "cannot certify customer acceptance." Re-gating `prepare_bundle` on acceptance evidence here would mean this pack inventing a second, duplicate evidence-gating rule outside the passport pack, which the core rule of this PR forbids. The demo risk/milestone fixtures still document the fuller evidence picture narratively (see `pmfreak-demo-project-fixtures.ts`).
- **Risk Escalation.** `pmfreak.action.risk.create_draft` (what the Risk Agent is actually allowed to attempt) requires no evidence in the catalog. `pmfreak.action.risk.close` does require a risk record and PM approval, but it is explicitly restricted for every demo Risk Agent passport -- attempting it always denies before evidence is ever evaluated. The demo risk fixture (`risk.demo.unconfirmed-customer-acceptance`) still documents a risk record as a required evidence signal for that risk's own workflow, independent of this action attempt.

Two scenarios exercise resolver-only context flags that are not exposed as run-time overrides (context is scenario-defined, not caller-injected, so a scenario's sensitivity flags can never be spoofed at run time):

- **Client Communication (send), customer commitment.** A contract-sensitive, customer-commitment send is tested against a one-off scenario variant built in the test file, confirming `require_contract_review` or `require_customer_validation` outranks a plain PM-approval gate.
- **Change Control (classify), contract-sensitive impact.** A contract-sensitive impact is tested the same way, confirming the resolver's documented decision priority -- `require_contract_review` outranks `require_evidence` -- even when the change-request-record evidence is also missing.

## Demo identifiers

```
workspace.demo.pmfreak
project.demo.network-refresh
customer.demo.acme
milestone.demo.network-refresh.phase-1-delivery
risk.demo.unconfirmed-customer-acceptance
change.demo.scope-adjustment-request
```

No real Datasys project codes, customer names, contract numbers, invoice numbers, or acceptance records appear anywhere in this pack. The demo project context carries a Costa Rica jurisdiction pack reference (`aoc.jurisdiction.costa_rica.base.v1`) as an opaque routing reference only -- it never claims Costa Rica legal compliance.

## Architecture

```
Policy Pack Foundation
  |
Soberanía PMFreak Agent Passport Demo Pack v1
  |
Soberanía PMFreak Project Governance Scenario Pack v1  (this module)
```

This pack's manifest is a real `PolicyPackManifest`, built with the Policy Pack Foundation's `createPolicyPackManifest`, and declares the PMFreak Agent Passport Demo Pack's id as a `requiredPackIds` dependency. Its claim-safety wrapper (`pmfreak-scenario-claim-safety.ts`) extends the PMFreak Agent Passport Demo Pack's own wrapper (`assertNoPMFreakAgentPassportOverclaim`) with a small, additive list of scenario-specific unsafe phrases -- never the generic Policy Pack Foundation harness directly, and never a replacement of the layers below it.

| File | Provides |
| --- | --- |
| `pmfreak-project-governance-scenario-constants.ts` | Pack id/name/version, deterministic demo workspace/project/customer/milestone/risk/change-request ids, scenario ids |
| `pmfreak-project-governance-scenario-types.ts` | Every domain type: project context, milestone, risk, change request, scenario, run input/result, trace step, registry, Control Plane summary, export metadata |
| `pmfreak-demo-project-context.ts` | `buildDemoPMFreakProjectContext` / `demoPMFreakProjectContext` |
| `pmfreak-demo-project-fixtures.ts` | `demoPMFreakMilestones`, `demoPMFreakRisks`, `demoPMFreakChangeRequests` |
| `scenarios/*.ts` | The 9 deterministic scenario definitions, one file per category |
| `pmfreak-project-governance-scenario-manifest.ts` | `createPMFreakProjectGovernanceScenarioPackManifest`, built via `createPolicyPackManifest` |
| `pmfreak-scenario-registry.ts` | `createPMFreakProjectGovernanceScenarioRegistry` -- in-memory, no mutation, no network |
| `pmfreak-scenario-runner.ts` | `runPMFreakProjectGovernanceScenario` -- calls `resolvePMFreakAgentPassportAction` and projects the result |
| `pmfreak-scenario-control-plane-summary.ts` | `createPMFreakProjectGovernanceScenarioControlPlaneSummary` and the pack's safe display labels |
| `pmfreak-scenario-export-metadata.ts` | `createPMFreakProjectGovernanceScenarioExportMetadata` |
| `pmfreak-scenario-claim-safety.ts` | Scenario-specific unsafe-claim phrases, additive to (never replacing) the PMFreak-wide list |

## What this pack is not

It is not a real PMFreak API integration, a real PMFreak authentication provider, a real PMFreak project sync, a real PMFreak database, or a production UI. It does not ingest real customer data, mutate a real task, schedule, or billing record, send a real email or Slack/Teams message, create a real invoice, approve a real contract, provide legal advice, or certify compliance. It performs no OAuth, no webhooks, no network calls, no LLM calls, no OCR, no PDF parsing, and no dynamic web lookup.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`. Every fixture id and timestamp is a fixed literal. See `tests/pmfreak-scenario-determinism.test.ts`.

## Core demo message

```
PMFreak demonstrates what autonomous project agents can do.
Frontera Systems demonstrates why they can be trusted to do it.
```
