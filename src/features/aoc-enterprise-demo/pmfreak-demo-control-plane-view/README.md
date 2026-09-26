# Soberanía PMFreak Demo Control Plane View v1

View ID:

```
aoc.demo.pmfreak.control_plane_view.v1
```

Purpose:

Provides a deterministic Control Plane view-model layer for the PMFreak Frontera Systems demo.

This view consumes scenario run results from the PMFreak Project Governance Scenario Pack and turns them into presentation-ready cards, panels, badges, timelines and dashboard metrics.

This view does not create new governance decisions.
This view does not duplicate the PMFreak Agent Passport resolver.
This view does not integrate with PMFreak production.
This view does not access real PMFreak data.
This view does not modify projects.
This view does not send communications.
This view does not create invoices.
This view does not certify customer acceptance.
This view does not certify invoice readiness.
This view does not provide legal advice.
This view does not certify compliance.

## Core rule: this view presents, it never re-decides

```
The previous PR answered: What happens when PMFreak agents try to act inside
project-governance scenarios?
This PR answers: How do we show those governed decisions clearly in a Soberanía
Enterprise Control Plane demo?
```

```
PMFreak Demo Control Plane View
  |  consumes
PMFreak Project Governance Scenario Pack
  |  consumes
PMFreak Agent Passport Demo Pack
  |  consumes
Policy Pack Foundation / no-overclaim / Control Plane / export patterns
```

Every field in every view model, card, panel, badge, and timeline step in this module is a direct or lightly-relabeled projection of a `PMFreakProjectGovernanceScenarioRunResult` (and the `PMFreakAgentPassportResolution` it carries). This module never re-implements passport status handling, authority-scope checks, capability-token checks, evidence gating, or approval gating -- `createPMFreakDemoControlPlaneViewModel` never calls `resolvePMFreakAgentPassportAction`, and `createPMFreakDemoControlPlaneDashboard` never calls `runPMFreakProjectGovernanceScenario`. Only the optional `createDefaultPMFreakDemoControlPlaneDashboard` helper calls the existing scenario runner, to assemble the default demo dashboard from the existing deterministic scenarios -- it never invents a new decision path.

## View sections

| Section | Provides |
| --- | --- |
| Overview | `headline`, `summary`, `scenarioId`/`scenarioTitle`/`scenarioCategory` |
| Decision Badge | `decisionBadge` -- severity, label, and a safe description of the already-computed decision |
| Agent Passport Card | `agentPassportCard` -- passport status, capability, and authority-scope presentation |
| Attempted Action Card | `attemptedActionCard` -- the attempted action's identity, category, and declared context flags |
| Authority Scope Panel | `authorityScopePanel` -- whether the attempt fell within the demo passport's authority scope |
| Evidence Panel | `evidencePanel` -- required/provided/missing evidence |
| Approval Panel | `approvalPanel` -- required/provided/missing approvals |
| Trace Timeline | `traceTimeline` -- the scenario trace, in its original order, with canonical step labels |
| Policy/Jurisdiction References | `policyReferencePanel` -- applied policy pack ids and jurisdiction pack references |
| Export Status | `exportPanel` -- whether an audit-ready demo export can be built from this result |

## The primary demo: Billing Readiness

The Billing Readiness Agent attempts to mark a milestone as ready for billing.

The Control Plane view shows:

- the attempted action
- the agent passport
- the Soberanía decision
- missing evidence
- missing approvals
- trace steps
- policy pack references
- jurisdiction context references
- export readiness

In this demo, `allow` means that Frontera Systems allows the governed demo action to proceed based on the configured passport, evidence and approvals.

It does not mean:

- invoice validity is certified
- customer acceptance is certified
- billing entitlement is guaranteed
- legal compliance is certified
- production mutation has occurred

## Dashboard metrics

`createPMFreakDemoControlPlaneDashboard` maps already-run scenario results into view models plus `summaryMetrics`:

- total scenarios
- allowed scenarios
- denied scenarios
- held scenarios
- evidence-required scenarios (`require_evidence`)
- approval/review-required scenarios (every other `require_*` decision)

`createDefaultPMFreakDemoControlPlaneDashboard` runs every scenario registered in the Project Governance Scenario Pack with the existing demo passport and scenario registries, and builds the dashboard from those results -- it never integrates with PMFreak production.

## Comparison view

`createPMFreakDemoControlPlaneComparison` shows how a decision changes when required demo evidence and approvals are added between a "before" and an "after" scenario run.

It does not claim that the invoice became legally valid or that customer acceptance was certified -- its `explanation` field states only that the later demo run included the evidence/approval signals the earlier run was missing.

## Demo identifiers

```
aoc.demo.pmfreak.control_plane_view.v1
pmfreak.scenario.billing_readiness.mark_milestone_ready
```

No real Datasys project codes, customer names, contract numbers, invoice numbers, or acceptance records appear anywhere in this module. A Costa Rica jurisdiction pack reference (`aoc.jurisdiction.costa_rica.base.v1`), when present on a scenario run result, is surfaced as "Costa Rica jurisdiction context referenced" -- a routing reference only, never a compliance claim.

## Architecture

```
Policy Pack Foundation
  |
Soberanía PMFreak Agent Passport Demo Pack v1
  |
Soberanía PMFreak Project Governance Scenario Pack v1
  |
Soberanía PMFreak Demo Control Plane View v1  (this module)
```

Its claim-safety wrapper (`pmfreak-demo-control-plane-claim-safety.ts`) extends the Project Governance Scenario Pack's own wrapper (`assertNoPMFreakScenarioOverclaim`) with a small, additive list of view-specific unsafe phrases -- never the generic Policy Pack Foundation harness directly, and never a replacement of the layers below it.

| File | Provides |
| --- | --- |
| `pmfreak-demo-control-plane-view-constants.ts` | View id/name/version, primary demo scenario id, section ids, safe labels, canonical trace step labels |
| `pmfreak-demo-control-plane-view-types.ts` | Every view-model type: decision badge, cards, panels, timeline, dashboard, comparison |
| `pmfreak-demo-decision-badges.ts` | `createPMFreakDemoDecisionBadge` |
| `pmfreak-demo-agent-passport-card.ts` | `createPMFreakDemoAgentPassportCard` |
| `pmfreak-demo-action-card.ts` | `createPMFreakDemoAttemptedActionCard` |
| `pmfreak-demo-authority-panel.ts` | `createPMFreakDemoAuthorityScopePanel` |
| `pmfreak-demo-evidence-panel.ts` | `createPMFreakDemoEvidencePanel` |
| `pmfreak-demo-approval-panel.ts` | `createPMFreakDemoApprovalPanel` |
| `pmfreak-demo-trace-timeline.ts` | `createPMFreakDemoTraceTimeline` |
| `pmfreak-demo-policy-reference-panel.ts` | `createPMFreakDemoPolicyReferencePanel` |
| `pmfreak-demo-export-panel.ts` | `createPMFreakDemoExportPanel` |
| `pmfreak-demo-control-plane-view-model.ts` | `createPMFreakDemoControlPlaneViewModel` -- composes every card/panel/badge above from a single scenario run result |
| `pmfreak-demo-dashboard.ts` | `createPMFreakDemoControlPlaneDashboard`, `createDefaultPMFreakDemoControlPlaneDashboard` |
| `pmfreak-demo-comparison.ts` | `createPMFreakDemoControlPlaneComparison` |
| `pmfreak-demo-control-plane-fixtures.ts` | Deterministic demo view/dashboard/comparison fixtures |
| `pmfreak-demo-control-plane-claim-safety.ts` | View-specific unsafe-claim phrases, additive to (never replacing) the scenario-pack list |

## What this module is not

It is not a production UI, a real PMFreak API connector, a real PMFreak authentication provider, a real PMFreak project sync, or a real PMFreak database reader or writer. It does not mutate a real task, schedule, risk, or billing record, send a real email or Slack/Teams message, create a real invoice, certify customer acceptance, certify invoice readiness, provide legal advice, or certify compliance. It performs no OAuth, no webhooks, no network calls, no LLM calls, no OCR, no PDF parsing, and no dynamic web lookup.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`. Every fixture id and timestamp is a fixed literal, and every fixture's decision is read from a real `runPMFreakProjectGovernanceScenario` output rather than hand-authored. See `tests/pmfreak-demo-control-plane-determinism.test.ts`.

## Core demo message

```
PMFreak demonstrates what autonomous project agents can do.
Frontera Systems demonstrates why they can be trusted to do it.
The Control Plane shows why a governed decision was made.
```
