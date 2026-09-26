# Frontera Systems Pilot Template

Recognition Runtime, Authority Graph, Approval Runtime, External Agent
Handshake, Action Enforcement, the Domain Policy Pack Runtime, Evidence /
Source / Citation Runtime, the Soberanía Control Plane, Frontera Systems Demo, and
the Verifiable Export Package answer "can this be recognized, authorized,
approved, policy-checked, evidenced, enforced, observed and exported?" None
of them answer the question an enterprise buyer or operator asks before
they will pilot Soberanía at all:

**How does a real enterprise customer pilot Soberanía with a bounded use case,
real runtime-backed scenarios, clear acceptance criteria, operator
walkthroughs, evidence trails, policy packs, Control Plane visibility, and
verifiable export packages?**

That is the Enterprise Pilot Template's job -- and it is the **final
Foundation v1 packaging sprint**. Soberanía now has the runtime, governance,
evidence, proof and export foundations; this feature packages those
capabilities into reusable, enterprise-ready, demo-ready,
implementation-ready pilot kits.

## Core thesis: a pilot template is not the runtime truth

**A pilot template orchestrates existing runtime truth. It never
manufactures its own.** Concretely:

- It never creates a recognition, authority, approval, policy, evidence,
  enforcement, or export decision itself.
- It never marks a scenario "passed" unless a real Enterprise Demo scenario
  run actually produced that outcome.
- It never marks an export package "verified" unless the real Verifiable
  Export Package runtime actually verified it.
- It never marks `customer_signoff`/`operator_review` acceptance criteria
  complete on its own -- only explicit, caller-supplied metadata
  (`metadata.manuallyCompleted === true`) can do that.
- It never claims legal, regulatory, or production compliance -- every
  template, script and generated artifact carries an explicit disclaimer.

## PilotTemplate vs. PilotKit

- **`PilotTemplate`** is static, declarative, pre-authored data: personas,
  scope, actors, agents, capabilities, authority/approval/policy/evidence
  models, sample actions, scenarios, a Control Plane walkthrough script,
  export package definitions, acceptance criteria, success metrics, risks,
  a demo script, non-goals and a legal disclaimer. It describes what a
  pilot *should* demonstrate.
- **`PilotKit`** is the runtime-bound result of actually building a
  template: real bound scenario ids, real bound policy pack ids, real bound
  evidence proof ids, real bound (and verified) export package ids, a real
  `PilotReadinessReport`, and generated text artifacts. `PilotKitBuilder` is
  the only thing that produces one, and it never marks a kit `ready`/
  `validated` when `PilotReadinessService` reports `not_ready`.

## PilotScenario vs. Enterprise Demo scenario

A `PilotScenario` is a pilot-authored expectation: "this pilot exercises
Enterprise Demo scenario X and expects its outcome to be Y." It carries an
optional `demoScenarioId` and a coarser `PilotScenarioExpectedOutcome`
(`passed`/`blocked`/`approval_required`/`evidence_required`/`executed`/
`warning_allowed`) than the demo scenario's own
`DemoScenarioOutcomeStatus`. `services/pilot-scenario-binding-service.ts`
is the only place that reconciles the two vocabularies
(`integrations/enterprise-demo-pilot-adapter.ts`'s `OUTCOME_COMPATIBILITY`
table) and, when a real `DemoScenarioRunner` is supplied, actually **runs**
the bound Enterprise Demo scenario end to end rather than trusting its
static `expectedOutcome` declaration.

## PilotExportPackageDefinition vs. Verifiable Export Package

A `PilotExportPackageDefinition` is a static, pre-authored label (name,
package type, expected sections, expected verification status, buyer
purpose) describing what export artifact a pilot scenario should produce.
It is **not** an `ExportPackage` -- `services/pilot-export-package-binding-service.ts`
checks it against a real, already-created-and-verified `ExportPackage`
(built and verified by the real `ExportPackageRuntime`).
`integrations/verifiable-export-pilot-adapter.ts`'s `checkExportPackageBinding`
compares package type, target type, hash presence, manifest presence,
section coverage and verification status; it never fabricates a package.
Because a `PilotExportPackageDefinition.targetId` is authored ahead of the
run that produces the real target entity id, only `targetType` is compared
exactly -- `targetId` on the definition stays a human-readable label.

## How pilots use Control Plane walkthroughs

`PilotControlPlaneWalkthrough` is a read-only touring script
(`domain/pilot-control-plane.ts`): sections, what to show, why it matters,
and expected rows/references, plus an operator script.
`services/pilot-control-plane-walkthrough-service.ts` validates it
structurally and, when given a real `AocControlPlaneReadModel`, cross-checks
each section against real Control Plane rows via
`integrations/control-plane-pilot-adapter.ts`. `evidence` and
`export_packages` focus areas are honestly reported as **not yet wired
into the Control Plane read model** (see those features' own READMEs) --
this feature never claims Control Plane visibility it does not have. It
never mutates the read model.

## How pilots use policy packs

`PilotPolicyModel` references real Domain Policy Pack Runtime pack/version
ids and propagates their `demoOnly`/`legalCompleteness` labels verbatim via
`integrations/policy-pack-pilot-adapter.ts` -- it never upgrades a demo
pack's legal completeness and never claims production compliance on its
own.

## How pilots use the Evidence / Source / Citation Runtime

`PilotEvidenceModel` references real source documents, evidence artifacts,
requirements, satisfactions and proofs by id.
`integrations/evidence-pilot-adapter.ts` summarizes them verbatim
(`summarizeEvidenceForPilot`) and never infers legal sufficiency from
evidence presence -- `sourceDocumentClaimsValidation()` only reports a
`verified_by_customer`/`verified_by_counsel` label the *caller* already
asserted out of band.

## How pilots use Action Enforcement

`integrations/action-enforcement-pilot-adapter.ts` maps a real
`EnforcementDecision`/`EnforcementProof` into the pilot's coarser
`PilotExpectedEnforcement` vocabulary and never reruns execution -- it only
reads an already-decided outcome.

## How pilots use Verifiable Export Packages

See "PilotExportPackageDefinition vs. Verifiable Export Package" above.
Fixtures build real packages via literal, type-conformant
`EnforcementDecision`/`EnforcementProof` objects reconstructed from a real,
already-executed `DemoScenarioRun`'s own ids/status (see
`fixtures/pilot-fixture-support.ts`'s `realizeEnforcementFactsFromDemoRun`)
-- this mirrors the same fixture pattern `verifiable-export-package`'s own
demo fixture already uses, and every package is genuinely created, sealed
and verified by the real `ExportPackageRuntime`.

## How readiness is calculated

`services/pilot-readiness-service.ts` produces the single
`PilotReadinessReport` for a build:

- **`not_ready`** if the template itself is structurally incomplete (see
  `validatePilotTemplate`), any declared scenario failed to bind or
  mismatched its expected outcome, any declared export package failed to
  bind or verify, the Control Plane walkthrough failed structural
  validation, or any acceptance criterion failed.
- **`ready_with_warnings`** if every automated/structural check passed but
  a `warning`-severity issue remains -- a pending `operator_review`/
  `customer_signoff` acceptance criterion, a risk missing mitigation, or an
  escalated risk (missing legal disclaimer, demo-only confusion, missing
  export package coverage, missing evidence coverage).
- **`ready`** only when there are no issues at all.

`PilotKitBuilder` maps this onto `PilotKitStatus`: `not_ready` &rarr;
`failed_readiness`, `ready_with_warnings` &rarr; `ready`, `ready` &rarr;
`validated`.

## How generated artifacts work

`services/pilot-script-service.ts` deterministically renders seven text
artifacts purely from a `PilotTemplate`'s own fields (never an LLM):
`pilot_readme`, `demo_script`, `technical_setup`, `acceptance_checklist`,
`buyer_summary`, `operator_walkthrough`, and `pilot_json` (a stable-key
JSON serialization of the template). Every narrative artifact carries the
template's own `legalDisclaimer` plus a fixed not-legal-advice notice.
`contentHash` is a SHA-256 digest of the rendered content, so any drift
between two generations of the same content is detectable.

## Built-in pilots

1. **Datasys Internal PM / Project Governance Pilot**
   (`pilots/datasys-project-governance.pilot.ts`)
   - *Purpose*: govern autonomous PM agent (PMFreak) execution -- recognized
     reads, evidence-gated invoice support, approval-gated payments.
   - *Buyer*: COO/Operations Director, PMO Director, Services Delivery
     Director. *Operator*: Project Manager, PMO Analyst, Delivery Manager.
   - *Scope*: sandbox, synthetic data, demo policy model, 21 days.
   - *Policy packs*: procurement-basic, financial-approval-basic,
     data-boundary-basic.
   - *Evidence*: invoice, purchase order, approval memo.
   - *Scenarios*: low-risk read (warning-allowed), invoice support blocked
     on evidence, payment blocked on finance approval, full governance
     walkthrough + export.
   - *Control Plane walkthrough*: Overview, Enforcement, Policy Packs,
     Evidence, Proofs/Audit, Export Packages.
   - *Export packages*: invoice evidence packet, payment approval decision
     packet.
   - *Acceptance criteria*: scenarios pass, export verified, operator
     walkthrough, customer signoff.
   - *Disclaimer*: demo-only policy packs; not legal advice; no production
     compliance claim.

2. **Bank Payments / Procurement / Data Boundary Pilot**
   (`pilots/bank-payments-procurement-data.pilot.ts`)
   - *Purpose*: govern financial, procurement and data-sensitive actions --
     payment/bank-account-change gates, invoice-evidence gate, client-data
     export gate.
   - *Buyer*: CIO, CISO, Compliance Officer, Operations Risk Director,
     Digital Transformation Director. *Operator*: Finance Operator,
     Compliance Reviewer, Security Analyst, Process Owner.
   - *Scope*: sandbox, synthetic data, demo policy model, 30 days.
   - *Policy packs*: payments-basic, procurement-basic, data-boundary-basic,
     financial-approval-basic.
   - *Evidence*: invoice, purchase order, data classification, customer
     policy source.
   - *Scenarios*: payment approval required, bank-account change denied,
     invoice support requires evidence, data export requires compliance,
     prohibited data export denied, full walkthrough + audit bundle export.
   - *Control Plane walkthrough*: Enforcement, Policy Packs, Evidence,
     Approvals, Proofs/Audit, Export Packages.
   - *Export packages*: payment approval decision packet, data-boundary and
     payments audit bundle.
   - *Acceptance criteria*: scenarios pass, export verified, compliance
     review, customer signoff.
   - *Disclaimer*: demo policy packs; does not prove banking regulatory
     compliance; not legal advice.

3. **Healthcare Operations / Sensitive Data / Approval Pilot**
   (`pilots/healthcare-operations-sensitive-data.pilot.ts`)
   - *Purpose*: govern sensitive operational actions in a healthcare-like
     setting *without* claiming healthcare regulatory compliance.
   - *Buyer*: Healthcare Operations Director, CIO, Data Protection Officer,
     Compliance Lead. *Operator*: Operations Coordinator, Compliance
     Reviewer, Data Steward, Security Analyst.
   - *Scope*: sandbox, synthetic operational data, demo policy model, 21
     days.
   - *Policy packs*: data-boundary-basic, jurisdictional-baseline-demo.
   - *Evidence*: data classification, risk assessment.
   - *Scenarios*: low-risk read (warning-allowed), sensitive data export
     requires compliance approval, prohibited export denied, handoff
     requires evidence, full walkthrough + export.
   - *Control Plane walkthrough*: Overview, Policy Packs, Evidence,
     Approvals, Enforcement, Proofs/Audit, Export Packages.
   - *Export packages*: sensitive data export approval packet, operational
     handoff evidence packet.
   - *Acceptance criteria*: scenarios pass, export verified, no compliance
     overclaim, customer signoff.
   - *Disclaimer*: does not claim HIPAA, GDPR, Costa Rica health-data law,
     EU AI Act, or any other healthcare regulatory compliance; not legal
     advice.

4. **Sports Event Settlement Pilot**
   (`pilots/sports-event-settlement.pilot.ts`)
   - *Purpose*: govern event settlement / smart-contract-like payment
     execution -- blocked until event record evidence exists, payment
     gated on approval, *without* claiming smart-contract legal
     enforceability.
   - *Buyer*: Sports League Operator, Event Platform Founder, Payments
     Partner, Smart Contract Product Lead, Risk/Compliance Reviewer.
     *Operator*: Event Operations Manager, Settlement Reviewer, Finance
     Operator, Partner Operations Analyst.
   - *Scope*: sandbox, synthetic event/settlement data, demo policy model,
     21 days.
   - *Policy packs*: sports-event-settlement-basic, payments-basic,
     financial-approval-basic.
   - *Evidence*: event record.
   - *Scenarios*: settlement blocked pending event record, settlement
     payment requires finance approval, full walkthrough + export.
   - *Control Plane walkthrough*: Overview, Policy Packs, Evidence,
     Enforcement, Approvals, Proofs/Audit, Export Packages.
   - *Export packages*: settlement event record evidence packet, settlement
     payment approval decision packet.
   - *Acceptance criteria*: scenarios pass, export verified, no
     smart-contract overclaim, customer signoff.
   - *Disclaimer*: does not claim smart-contract legal enforceability or
     payment regulatory compliance; not legal advice.

## Legal / compliance disclaimer

- Pilot templates are **not legal advice**.
- Demo policy packs are **not production compliance** -- every template's
  `scope.legalCompleteness` and `policyModel.legalCompleteness` default to
  `demo_policy_model`, and this feature never upgrades that label itself.
- Evidence presence does not prove legal sufficiency -- see
  `evidence-source-runtime`'s own disclaimer; this feature only reports
  evidence status verbatim.
- Legal or regulatory compliance claims require explicit `customer_validated`
  / `counsel_validated` labeling by a caller with actual, out-of-band
  confirmation of that fact -- never inferred by this feature.
- No LLM generates any compliance conclusion, narrative, or decision
  anywhere in this feature. No network calls. No nondeterministic time or
  IDs (`PilotRuntimeContext` injects both, mirroring every other Soberanía
  runtime).

## How to add a new pilot template

1. Add the new id to `PilotTemplateId` (`domain/pilot-template.ts`).
2. Author a `pilots/<name>.pilot.ts` exporting a complete `PilotTemplate`
   literal -- every scenario's `demoScenarioId` must reference a real,
   existing Enterprise Demo scenario whose actual outcome is compatible
   with the scenario's declared `expectedOutcome` (see
   `integrations/enterprise-demo-pilot-adapter.ts`'s `OUTCOME_COMPATIBILITY`
   table), and every export package definition must be achievable from real
   sections your fixture can build (see `fixtures/pilot-fixture-support.ts`).
3. Register it in `pilots/index.ts`'s `ALL_BUILT_IN_PILOT_TEMPLATES`.
4. Add a `fixtures/<name>-pilot.fixture.ts` composing a real Enterprise Demo
   suite, a real `ExportPackageRuntime`, and (if evidence-gated) the real
   Evidence Runtime demo fixture, then call `runtime.buildPilotKit(...)`.
5. Add the corresponding `tests/pilots/<name>.pilot.test.ts` and
   `tests/scenarios/<name>-pilot-end-to-end.test.ts`.

## How to bind real customer scenarios

Supply a real `DemoScenarioRegistry`/`DemoScenarioRunner` (or your own
scenario runtime with the same shape) to `PilotRuntime`/
`PilotScenarioBindingService` and call `bindOne`/`bindAll` -- it will run
the real scenario and report `bound`/`missing_binding`/`outcome_mismatch`,
never a fabricated result.

## How to bind real customer policy packs

Register the customer's policy pack with a real `PolicyPackRuntime` and
pass its id/version id through `PilotTemplate.policyModel` and
`PilotKitBuildInput.boundPolicyPackIds`/`boundPolicyPackVersionIds` --
`integrations/policy-pack-pilot-adapter.ts` propagates its
`demoOnly`/`legalCompleteness` labels verbatim.

## How to bind customer evidence

Register the customer's source documents/evidence artifacts with a real
`EvidenceRuntime` and pass the resulting ids through
`PilotTemplate.evidenceModel` and `PilotKitBuildInput.boundEvidenceProofIds`.

## How to generate pilot artifacts

`PilotRuntime.generateArtifacts(templateId)` or
`PilotScriptService.generateAll(template)` -- both are pure functions of
the template's own fields.

## How to run tests

```
npm run build && node --test src/features/aoc-enterprise-pilot-template
```

or run the full repository suite with `npm test`.

## Foundation v1 completion statement

`fixtures/foundation-v1-complete.fixture.ts` builds all four built-in pilot
kits against real Enterprise Demo, Verifiable Export Package and Evidence
Runtime dependencies and derives an `AocFoundationV1Status` purely from
their real `PilotReadinessReport`s -- `complete` only if every kit is fully
`ready`, `complete_with_warnings` if every kit is at least
`ready_with_warnings`, `not_complete` if any kit is `not_ready`. As of this
sprint, all four built-in pilots report `ready_with_warnings` (pending only
manual `operator_review`/`customer_signoff` acceptance criteria and the
always-honest "evidence proof ids are not statically pre-populated"
warning), so Foundation v1 is `complete_with_warnings`: the runtime,
governance, evidence, proof, export and pilot-packaging layers all exist
and interoperate -- what remains is human sign-off, not missing
functionality.
