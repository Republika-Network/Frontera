# Soberanía PMFreak Demo Narrative Export Pack v1

Export Pack ID:

```
aoc.demo.pmfreak.narrative_export.v1
```

Purpose:

Provides a deterministic narrative export layer for the PMFreak Frontera Systems demo.

This pack consumes Control Plane view models from the PMFreak Demo Control Plane View and turns them into human-readable narrative exports.

This pack does not create new governance decisions.
This pack does not duplicate the PMFreak Agent Passport resolver.
This pack does not duplicate the PMFreak Project Governance Scenario runner.
This pack does not integrate with PMFreak production.
This pack does not access real PMFreak data.
This pack does not modify projects.
This pack does not send communications.
This pack does not create invoices.
This pack does not generate page-layout or word-processor export files.
This pack does not certify customer acceptance.
This pack does not certify invoice readiness.
This pack does not provide legal advice.
This pack does not certify compliance.

## Core rule: this pack explains, it never re-decides

```
The previous PR answered: How do we show governed PMFreak decisions in a
Control Plane view?
This PR answers: How do we explain governed PMFreak decisions in a
shareable, auditable narrative?
```

```
PMFreak Demo Narrative Export Pack
  |  consumes
PMFreak Demo Control Plane View
  |  consumes
PMFreak Project Governance Scenario Pack
  |  consumes
PMFreak Agent Passport Demo Pack
```

Every field in every narrative export, section, comparison, and dashboard summary in this module is a direct or lightly-relabeled projection of a `PMFreakDemoControlPlaneViewModel` (or a `PMFreakDemoControlPlaneComparison` / `PMFreakDemoControlPlaneDashboard` built from one or more of them). This module never re-implements passport status handling, authority-scope checks, capability-token checks, evidence gating, approval gating, or decision-badge mapping -- `createPMFreakDemoNarrativeExport` never calls `resolvePMFreakAgentPassportAction`, `runPMFreakProjectGovernanceScenario`, or `createPMFreakDemoControlPlaneViewModel` itself.

## Narrative sections

| Section | Provides |
| --- | --- |
| Executive Summary | What happened, in one safe, decision-aware paragraph |
| Agent / Action | Agent id, passport id, passport status, attempted action, workspace/project/customer ids, context flags |
| Governance Checks | Passport, capability, authority-scope, evidence, and approval checks, plus the decision presented |
| Evidence | Required/provided/missing evidence, and whether evidence is satisfied |
| Approvals | Required/provided/missing approvals, and whether approvals are satisfied |
| Trace | The Control Plane trace timeline, preserved in its original order |
| Policy / Jurisdiction References | Applied policy pack ids and jurisdiction pack references |
| Safe Interpretation | What the decision means, and what it does not mean |
| Next Steps | Decision-aware, demo-only recommendations |
| Export Metadata | A narrative summary of this export's own bundle metadata |

## The primary demo: Billing Readiness

The Billing Readiness Agent attempts to mark a milestone as ready for billing.

The Narrative Export explains:

- what the agent attempted
- which passport was used
- what Frontera Systems checked
- which decision was returned
- which evidence was missing or satisfied
- which approvals were missing or satisfied
- which trace steps explain the result
- which policy/jurisdiction references were included
- what the decision safely means
- what it does not mean

In this demo, `allow` means that the configured Soberanía demo governance model allowed the governed demo action to proceed based on the available passport, evidence, approvals and scenario context.

It does not mean:

- invoice validity is certified
- customer acceptance is certified
- billing entitlement is guaranteed
- legal compliance is certified
- production mutation has occurred

## Comparison export

`createPMFreakDemoNarrativeComparisonExport` wraps a Control Plane comparison's own "before" and "after" narrative exports and reuses its already-computed `explanation`, `changedDecision`, `resolvedEvidenceIds`, and `resolvedApprovalIds` -- it never re-diffs evidence or approval ids and never re-derives a decision.

The comparison export can show how a decision changes when required demo evidence and approvals are added.

It does not claim that the invoice became legally valid.
It does not claim that customer acceptance was certified.
It does not claim that the project became compliant.

## Dashboard export

`createPMFreakDemoNarrativeDashboardExport` summarizes a Control Plane dashboard's own `viewModels` and `summaryMetrics` into a scenario-by-scenario decision summary.

It does not recompute decisions.
It does not execute scenarios.
It does not contact PMFreak production.

## Renderers

Markdown renderer (`renderPMFreakDemoNarrativeMarkdown`):
Creates a deterministic markdown string from a narrative export.

Plain-text renderer (`renderPMFreakDemoNarrativePlainText`):
Creates a deterministic plain-text string from a narrative export.

Neither renderer creates files, sends messages or performs a production export. Both produce a string only.

## Export bundle metadata

`createPMFreakDemoNarrativeExportBundleMetadata` records which sections, policy packs, and jurisdiction packs an export includes, plus fixed `demoOnly: true` / `productionExecution: false` flags. It never includes a `legalValidity`, `complianceCertified`, `invoiceValidityCertified`, or `customerAcceptanceCertified` field.

## Demo identifiers

```
aoc.demo.pmfreak.narrative_export.v1
aoc.demo.pmfreak.control_plane_view.v1
pmfreak.scenario.billing_readiness.check_readiness
```

No real Datasys project codes, customer names, contract numbers, invoice numbers, or acceptance records appear anywhere in this module. A Costa Rica jurisdiction pack reference (`aoc.jurisdiction.costa_rica.base.v1`), when present on a Control Plane view model, is surfaced as "Costa Rica jurisdiction context referenced" -- a routing reference only, never a compliance claim.

## Architecture

```
Policy Pack Foundation
  |
Soberanía PMFreak Agent Passport Demo Pack v1
  |
Soberanía PMFreak Project Governance Scenario Pack v1
  |
Soberanía PMFreak Demo Control Plane View v1
  |
Soberanía PMFreak Demo Narrative Export Pack v1  (this module)
```

Its claim-safety wrapper (`pmfreak-demo-narrative-claim-safety.ts`) extends the Control Plane View's own wrapper (`assertNoPMFreakDemoControlPlaneOverclaim`) with a small, additive list of narrative-specific unsafe phrases -- never the generic Policy Pack Foundation harness directly, and never a replacement of the layers below it.

| File | Provides |
| --- | --- |
| `pmfreak-demo-narrative-export-constants.ts` | Export pack id/name/version, source view/scenario ids, section ids, safe labels, purpose, disclaimers |
| `pmfreak-demo-narrative-export-types.ts` | Every narrative type: section, descriptor, export, bundle metadata, comparison export, dashboard export |
| `pmfreak-demo-narrative-export-descriptor.ts` | `createPMFreakDemoNarrativeExportDescriptor` |
| `pmfreak-demo-executive-summary.ts` | `createPMFreakDemoExecutiveSummarySection` |
| `pmfreak-demo-agent-action-narrative.ts` | `createPMFreakDemoAgentActionSection` |
| `pmfreak-demo-governance-checks-narrative.ts` | `createPMFreakDemoGovernanceChecksSection` |
| `pmfreak-demo-evidence-narrative.ts` | `createPMFreakDemoEvidenceNarrativeSection` |
| `pmfreak-demo-approval-narrative.ts` | `createPMFreakDemoApprovalNarrativeSection` |
| `pmfreak-demo-trace-narrative.ts` | `createPMFreakDemoTraceNarrativeSection` |
| `pmfreak-demo-policy-reference-narrative.ts` | `createPMFreakDemoPolicyReferenceNarrativeSection` |
| `pmfreak-demo-safe-interpretation.ts` | `createPMFreakDemoSafeInterpretationSection` |
| `pmfreak-demo-next-steps.ts` | `createPMFreakDemoNextStepsSection` |
| `pmfreak-demo-export-bundle-metadata.ts` | `createPMFreakDemoNarrativeExportBundleMetadata`, `createPMFreakDemoExportMetadataSection` |
| `pmfreak-demo-narrative-builder.ts` | `createPMFreakDemoNarrativeExport` -- composes every section above from a single Control Plane view model |
| `pmfreak-demo-markdown-renderer.ts` | `renderPMFreakDemoNarrativeMarkdown` |
| `pmfreak-demo-plain-text-renderer.ts` | `renderPMFreakDemoNarrativePlainText` |
| `pmfreak-demo-comparison-narrative.ts` | `createPMFreakDemoNarrativeComparisonExport` |
| `pmfreak-demo-dashboard-narrative.ts` | `createPMFreakDemoNarrativeDashboardExport` |
| `pmfreak-demo-narrative-fixtures.ts` | Deterministic narrative/comparison/dashboard export fixtures |
| `pmfreak-demo-narrative-claim-safety.ts` | Narrative-specific unsafe-claim phrases, additive to (never replacing) the Control Plane View list |

## What this module is not

It is not a production UI, a real PMFreak API connector, a real PMFreak authentication provider, a real PMFreak project sync, or a real PMFreak database reader or writer. It does not mutate a real task, schedule, risk, or billing record, send a real email or Slack/Teams message, create a real invoice, certify customer acceptance, certify invoice readiness, provide legal advice, or certify compliance. It performs no OAuth, no webhooks, no network calls, no LLM calls, no OCR, no PDF parsing, and no dynamic web lookup. It does not generate page-layout or word-processor export files -- its two renderers produce strings only.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`. Every export id is built deterministically from its source scenario id (`aoc.export.demo.pmfreak.narrative.<scenario-id-safe>.v1`), never a random UUID, and every fixture's decision is read from a real Control Plane View fixture rather than hand-authored. See `tests/pmfreak-demo-narrative-determinism.test.ts`.

## Core demo message

```
PMFreak demonstrates what autonomous project agents can do.
Frontera Systems demonstrates why they can be trusted to do it.
The Control Plane shows why a governed decision was made.
The Narrative Export explains that decision in shareable language.
```
