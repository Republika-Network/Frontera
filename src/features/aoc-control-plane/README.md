# Soberanía Control Plane UI

Soberanía is no longer just a protocol or a runtime -- Recognition Runtime, Authority
Graph, Approval Runtime, External Agent Handshake and Action Enforcement
together form an enforceable governance system. The Control Plane makes that
system *operable*: it is the surface a human operator uses to inspect,
understand and (where safe) act on what those five runtimes have decided.

It answers one question, repeatedly, across every governed action: **who did
what, under what authority, with what evidence, and did Soberanía actually allow
it?**

## Why a control plane, and why after enforcement

Once Action Enforcement exists, every action in the system either executed
because Soberanía allowed it, or never ran because Soberanía blocked it. That is a large
amount of decision state -- recognition decisions, authority chains, approval
quorums, external handshakes, enforcement outcomes, and the proofs chaining
them together -- with no way for a person to see it. The Control Plane is the
next required layer for exactly that reason: enforcement without visibility
is not governance an operator can trust or audit.

## Runtime logic vs. read-model/UI logic

This is the one rule every file in this module follows:

**The UI never reimplements governance logic.** It does not decide whether an
actor is recognized, whether authority is valid, whether an approval clears
quorum, whether a handshake should be trusted, or whether an action is
allowed to execute -- those five runtimes already decided all of that, and
their decision is final. This module only:

1. **Reads** runtime state through each runtime's own public getters, stores
   and event ledgers (`services/control-plane-read-model-service.ts`).
2. **Projects** that state into typed, UI-friendly view models
   (`domain/control-plane-view-model.ts`).
3. **Filters, sorts and searches** those view models
   (`services/control-plane-query-service.ts`).
4. **Dispatches** commands verbatim to the real runtime service that owns
   them (`services/control-plane-command-service.ts`) -- it never mutates a
   read-model array as if that were a state change.

If a row says an action was `allowed`, that is because
`EnforcementDecision.allowedToExecute` was `true` on the real
`EnforcementDecision` the Action Enforcement runtime returned. If a row says
an action was `executed`, that is because `ExecutionResult.executed` was
`true`. Nothing here is inferred or dramatized.

## The eight sections

### 1. Overview (`AocOverviewDashboard`)
Status cards (recognized actors, active grants/delegations, pending
approvals, active visas/ingress grants, enforcement requests, blocked
executions, executed actions, open violations, proofs generated), a health
banner (`healthy` / `attention_required` / `degraded` / `critical`), the most
recent decisions across all five sources, open items needing attention, and
a merged activity timeline.

### 2. Recognition (`RecognitionPanel`)
Recognized actors, passports, capability tokens, recognition decisions and
the raw audit trail -- everything Recognition Runtime decided about *"is
this actor and this action recognized?"*.

### 3. Authority (`AuthorityPanel`)
Authority grants, delegation grants, role assignments, authority decisions,
authority proofs, and a deterministic nested chain view (`AuthorityChainViewer`)
built from the grants/delegations themselves -- no graph library, just
issuer → subject → delegate, in order.

### 4. Approvals (`ApprovalPanel`)
Approval requests, decisions, evidence reviewed, quorum status
(`ApprovalQuorumIndicator`), and safe approve/reject/request-changes/escalate
actions.

### 5. External Agents (`ExternalAgentsPanel`)
External agents and their standing, handshake requests, agent visas, ingress
grants and the local trust boundary configuration that gated them.

### 6. Enforcement (`EnforcementPanel`)
Enforcement requests, decisions (with reasonCode/reason and links back to
the recognition/authority/approval/handshake proof that justified them),
execution results, side effects, violations, and idempotency status.

### 7. Policy Packs (`PolicyPacksPanel`)
Domain policy packs, versions, rules, evaluations, decisions, proofs and
events read from Domain Policy Pack Runtime, plus the links between an
Action Enforcement decision/proof and the policy pack decision/proof it
consulted. See "Policy Pack Control Plane" below.

### 8. Proofs / Audit (`ProofsPanel`)
Proof references from all five governance runtimes plus Domain Policy Pack
Runtime, proof chains linking an enforcement proof back through recognition,
authority, approval, handshake and policy, hash/previousHash display, and
the full audit trail.

## How read models are built

`ControlPlaneReadModelService.buildControlPlaneReadModel(bundle, options)`
takes a `ControlPlaneRuntimeBundle` -- handles to the five live runtimes plus
whatever entity ids a fixture (or a real integration) knows about -- and
produces one `AocControlPlaneReadModel`. Each sub-view-model is built by
calling that runtime's own read methods:

- Authority Graph, Approval Runtime and Action Enforcement all expose
  `store.getXByTrustDomain(...)`-style queries, so their grants/requests are
  enumerated directly.
- Authority decisions and proofs are additionally recovered via
  `AuthorityProofService.getAllProofs()`, since every authority decision --
  valid or not -- produces a proof, including ones Recognition Runtime
  triggers internally through its own Authority Graph integration.
- External Agent Handshake has no blanket "list all agents/visas" query, so
  agents are discovered from handshake requests and visas/ingress grants are
  discovered from the handshake event trail (`visaId`/`ingressGrantId` on
  each event), then re-fetched fresh by id for current state.
- Recognition Runtime exposes no "list all actors/passports/tokens" query at
  all -- the Control Plane fixture records which ids it created and the read
  model re-fetches each one fresh via `getActor`/`getPassport`/
  `getCapabilityToken`, so revocations made after fixture setup are reflected.
- Recognition Runtime's own audit trail persists a decision's `reasonCode`
  but not its original free-text `reason`; `RecognitionDecisionRow.reason` is
  therefore optional and left unset rather than guessing (an earlier version
  of this service incorrectly attached the *enforcement* decision's reason to
  the recognition row -- e.g. showing "idempotency key already used" as if
  Recognition Runtime had said it. That bug is why this row's `reason` field
  is optional now instead of backfilled).

## How metrics and health are computed

`ControlPlaneMetricsService.computeMetrics`/`computeHealth` take the
already-built view models (not raw runtime handles) and only count and
compare fields that are already there: `status === 'active'`,
`allowedToExecute === false`, `severity === 'critical'`, and so on. Health
escalates in this order: `emergencyDenyActive` or an open critical violation
→ `critical`; blocked executions, expired visas or revoked approvals →
`degraded`; pending approvals (especially high/critical risk) →
`attention_required`; otherwise `healthy`.

## How the timeline is built

`ControlPlaneTimelineService.buildTimeline` merges `AuditEvent`,
`AuthorityEvent`, `ApprovalEvent`, `HandshakeEvent` and `EnforcementEvent`
into one `AocTimelineItem[]`, normalizing each event's type into a title,
description and status (`info`/`success`/`warning`/`danger`) via a fixed
lookup table per event type -- no interpretation beyond that -- and sorts
newest-first (falling back to id for a stable tie-break).
`buildControlPlaneReadModel` then merges in
`ControlPlanePolicyPackTimelineService.buildPolicyPackTimeline`'s output
(policy events plus policy-blocked enforcement decisions -- see "Policy Pack
Control Plane" below) and re-sorts, so the final timeline is one
chronologically consistent feed across all six sources.

## How proof chains are built and displayed

`ControlPlaneProofService.buildProofsViewModel` collects proof references
per source, then builds one `ProofChainRow` per enforcement proof by walking
the ids it already carries (`recognitionDecisionId`, `authorityProofId`,
`approvalProofId`, `handshakeProofId`). A chain is marked `complete` **only**
when every one of those referenced ids was actually found among the
collected proofs -- if Action Enforcement recorded a reference to a proof
this service could not resolve, the chain is `incomplete`, visibly.
`control-plane-policy-pack-proof-service.ts` builds an additional
`enforcement proof → policy proof` chain per enforcement proof carrying a
`policyProofId`, using the same "complete only if actually found" rule.

## Policy Pack Control Plane

Domain Policy Pack Runtime and its Action Enforcement wiring (see
`../domain-policy-pack-runtime/README.md` and
`../action-enforcement/README.md`) let an operator answer "was this action
allowed?" but not "was it allowed *under which policy pack, and by which
rule*?". The Policy Packs section closes that gap.

### 1. What this section shows

Policy packs and their versions (with status, scope, demo-only/legal-
completeness metadata), the rules inside each version, every recorded policy
evaluation and decision, policy proofs, the policy pack event trail, and the
links between an Action Enforcement decision/proof and the policy pack
decision/proof it consulted during preflight.

### 2. Why this is needed after enforcement wiring

Policy Pack Enforcement Wiring lets Action Enforcement's preflight
optionally consult Domain Policy Pack Runtime and carry the result forward
as `policyDecisionId`/`policyProofId`/... on its own `EnforcementDecision`/
`EnforcementProof`. Those ids are opaque without a place to look them up --
this section is that place. It never re-evaluates policy; it only reads what
Domain Policy Pack Runtime and Action Enforcement already decided.

### 3. Policy evaluation vs. enforcement decision

A **policy evaluation** (`PolicyPackEvaluationRow`/`PolicyPackDecision`) is
Domain Policy Pack Runtime's own answer to "does any active policy pack
version apply to this action, and if so, what does it require?" -- computed
independently of Action Enforcement. An **enforcement decision**
(`EnforcementDecisionRow`) is Action Enforcement's own answer to "is this
action allowed to execute right now?", which folds together recognition,
authority, approval, evidence, external standing *and* (optionally) the
policy pack evaluation above. A policy pack can only ever narrow an
enforcement decision that every earlier Soberanía layer already allowed -- it
never overrides a core denial, and a `policy_warning`/`policy_allowed`
result never shows as blocked unless something else in the chain blocked it.

### 4. Policy proof vs. enforcement proof

A **policy proof** (`PolicyProofRow`) hash-chains a single policy
evaluation's input, rule results and decision. An **enforcement proof**
(`EnforcementProofRow`) hash-chains the whole enforcement outcome
(recognition/authority/approval/handshake/policy references, execution
result, side effects). When an enforcement proof carries a `policyProofId`,
the Proofs / Audit panel's proof chain viewer shows both: `enforcement proof
→ policy proof`, marked `complete` only when the referenced policy proof was
actually found (see `control-plane-policy-pack-proof-service.ts`).

### 5. How `policyDecisionId`/`policyProofId` connect the two

`EnforcementDecision.policyDecisionId`/`policyProofId` (and the mirrored
fields on `EnforcementProof`) are the only link the Control Plane trusts.
`ControlPlanePolicyPackReadModelService.buildPolicyEnforcementLinks` builds
one `PolicyEnforcementLinkRow` per enforcement decision that carries either
id, resolving `policyDecisionType` by looking that id up in Domain Policy
Pack Runtime's own decisions. `blockedByPolicy` is `true` only when the
enforcement decision's own `reasonCode` exactly equals its
`policyReasonCode` -- i.e. the policy pack outcome is what actually stopped
execution, not some other Soberanía layer that happened to run after a policy
warning.

### 6. Policy pack versions and matched rules

`PolicyPackVersionsTable` shows each version's status, demo-only/legal-
completeness metadata and scope (jurisdictions/countries/domains/actions).
`PolicyRulesTable` and `PolicyDecisionDetail`/`PolicyEvaluationsTable` show
`matchedRuleIds` verbatim from the underlying `PolicyPackDecision` -- this
Control Plane never re-runs `PolicyConditionEvaluator`/`PolicyRuleEvaluator`
to determine which rules matched.

### 7. How obligations are displayed

`PolicyObligationsList` renders each obligation's type, description and
required/optional status exactly as `PolicyPackDecision.obligations`
recorded them, with the source rule id when present.

### 8. How evidence requirements are displayed

`PolicyEvidenceRequirementsList` renders each evidence requirement's type,
description and required/optional status from `PolicyPackDecision.
evidenceRequirements`, unchanged.

### 9. How approval requirements are displayed

`PolicyApprovalRequirementsList` renders each approval requirement's type,
description, minimum approvals, segregation-of-duties flag and required
authority capability from `PolicyPackDecision.approvalRequirements`.

### 10. How policy events appear in the timeline

`ControlPlanePolicyPackTimelineService.buildPolicyPackTimeline` normalizes
every `PolicyPackEvent` (`policy_pack_registered`,
`policy_pack_version_activated/deprecated/revoked`, `policy_evaluation_
started`, `policy_pack_applicability_resolved`, `policy_rule_matched/not_
matched`, `policy_decision_created`, `policy_proof_created`, `policy_
simulation_started/completed`) into an `AocTimelineItem` with `source:
'policy'`, plus a synthetic-but-not-fabricated `policy_pack_blocked_
execution` item for every enforcement decision whose `blockedByPolicy` is
true -- timestamped from that decision's own `decidedAt`, never invented.
The main `AocControlPlaneReadModel.timeline` merges these in with every
other source, sorted newest-first.

### 11. How policy proofs appear in proof chains

See point 4 above; `ProofsViewModel.policyProofs` and the policy entries in
`ProofsViewModel.proofChains` are additive to the existing five-source proof
model, built by `control-plane-policy-pack-proof-service.ts`.

### 12. What `demoOnly` means

`demoOnly: true` means the policy pack version is illustrative/sample data,
not a customer-configured or production policy. `PolicyDemoOnlyBadge` always
renders this with a `warning` tone and the literal label "demo only" -- it
is never hidden or downplayed.

### 13. What `legalCompleteness` means

One of `not_legal_advice`, `partial_policy_model`, `customer_provided_
policy`, `verified_by_customer`, `verified_by_counsel` -- metadata the
policy pack version's author declared, not a conclusion this Control Plane
draws. `PolicyLegalCompletenessBadge` always renders `not_legal_advice` with
a `danger` tone and the literal label "Not legal advice"; only
`verified_by_customer`/`verified_by_counsel` render as `success`.

### 14. Legal / compliance disclaimer

- Every demo policy pack shipped in this repository is `demoOnly: true` and
  `not_legal_advice`. **None of it is legal advice**, and none of it should
  be treated as a certified compliance control.
- A policy pack is not "complete" compliance coverage for any domain or
  jurisdiction unless its own metadata explicitly says
  `verified_by_customer` or `verified_by_counsel` -- absence of a denial is
  not evidence of compliance.
- This Control Plane displays policy **evidence** (what was evaluated, what
  matched, what was required, what was proven) -- it draws no legal
  **conclusions**, and it must never be extended to do so (no LLM-generated
  explanations, no compliance scoring, no "this is GDPR-compliant"-style
  claims).

### 15. Extending with future customer/jurisdiction packs

Nothing in this section is specific to the six demo packs. Any additional
`PolicyPack`/`PolicyPackVersion` registered on the `PolicyPackRuntime` this
Control Plane is wired to shows up automatically through the same
`buildPolicyPackControlPlaneViewModel` adapter -- a customer or
jurisdictional pack with `legalCompleteness: 'verified_by_counsel'` and
`demoOnly: false` renders with the `success` tone and no "demo only" badge,
with zero code changes required here.

### 16. Driven by the Policy Pack Enterprise Demo Extension

`aoc-enterprise-demo`'s eight `policy_packs`-category scenarios (see that
module's README) drive this section end to end: each scenario's
`DemoPolicyPackControlPlaneService` calls this module's own
`buildPolicyPackViewModel()` (fed with the scenario's real
`PolicyPackRuntime` and real enforcement request/decision/proof rows,
converted with this module's exported `toEnforcementRequestRow`/
`toEnforcementDecisionRow`/`toEnforcementProofRow`) -- never
re-implementing this section's own read-model mapping. Every pack, rule,
decision and proof an operator inspects after running a policy-pack demo
scenario is exactly what this section would show for that same
`PolicyPackRuntime` in a live deployment.

## How commands work

`ControlPlaneCommandService` wraps the real runtime services and nothing
else:

| Command | Runtime call |
| --- | --- |
| `approve_approval_request` | `ApprovalRuntime.approve(...)` |
| `reject_approval_request` | `ApprovalRuntime.reject(...)` |
| `request_approval_changes` | `ApprovalRuntime.requestChanges(...)` |
| `escalate_approval` | `ApprovalRuntime.escalate(...)` |
| `revoke_approval_proof` | `ApprovalRuntime.revokeApproval({ approvalProofId, ... })` |
| `revoke_authority_grant` | `AuthorityGraphRuntime.revokeAuthorityGrant(...)` |
| `revoke_delegation_grant` | `AuthorityGraphRuntime.revokeDelegationGrant(...)` |
| `revoke_agent_visa` | `ExternalAgentHandshakeRuntime.revokeAgentVisa(...)` |
| `revoke_ingress_grant` | `ExternalAgentHandshakeRuntime.revokeIngressGrant(...)` |
| `dry_run_enforcement` | `AocGuard.enforce(input, () => undefined)` with `mode: 'dry_run'` |
| `retry_failed_enforcement` | **not wired** -- see below |

Every command returns a `ControlPlaneCommandResult` built from the real
return value of that call (decision reasonCode/reason, resulting proof id,
revocation timestamp pulled from the `RevocationLink`/proof/visa itself --
never a fabricated timestamp).

### What is disabled, and why

`retry_failed_enforcement` is always reported as unavailable
(`reasonCode: 'COMMAND_NOT_WIRED'`). Action Enforcement has no first-class
retry method: a retry is really "resubmit the original `execute()` callback
with the same idempotency key", and the Control Plane does not own that
callback. Every component that renders a command button (`ApprovalActionBar`,
`AuthorityGrantsTable`, `DelegationGrantsTable`, `AgentVisasTable`,
`IngressGrantsTable`) renders it **disabled with a tooltip**
(`"Command wiring not enabled in this read-only demo."`) whenever no handler
was supplied, rather than silently hiding it or faking success.

## How the demo/fixture state works

`fixtures/control-plane-demo.fixture.ts` builds one deterministic "Datasys
Agent Republic" world by:

1. Calling Action Enforcement's own `buildPolicyPackEnforcementFixture()`,
   which wires all five governance runtimes together *and* registers all six
   Domain Policy Pack Runtime demo packs on the same `ActionEnforcementRuntime`
   used for every scenario below (this module does not rebuild that
   composition, and does not run a second, unconfigured runtime alongside it
   -- there is exactly one enforcement store, so every decision/proof in the
   read model is internally consistent).
2. Directly exercising Authority Graph's `verifyAuthority` for two
   representative actions (one delegated and valid, one not delegated), the
   same way `authority-graph`'s own demo scenarios do.
3. Driving thirteen real scenarios through `AocGuard.enforce(...)`: an
   allowed and executed action, a pending-then-approved approval (plus a
   suppressed duplicate via the same idempotency key), an evidence-required
   denial, an unrecognized-actor denial, a completed external handshake and
   successful read, an adapter-denied action, a dry run, plus four
   policy-pack-specific scenarios -- a `policy_warning` that still executes,
   a `policy_denied` block (payments-basic's bank-account rule), a
   `policy_requires_evidence` block (procurement-basic) and a
   `policy_requires_approval` block (payments-basic's finance-review rule).
4. Revoking one capability token nobody else in the fixture depends on, so
   the Recognition panel has a genuine `revoked` row to show.

Every runtime call in that fixture is the *real* public API of its module --
nothing here reimplements a policy. **Limitation:** since the fixture is the
only currently-wired data source, `buildControlPlaneReadModel` only ever
reflects this one demo trust domain; a production integration would build
its own `ControlPlaneRuntimeBundle` from live runtime instances instead of
this fixture.

## Mounting the Control Plane

This backend package (`@aoc-enterprise/runtime`) has no existing frontend
app or bundler, so this module ships as **feature-local React components**
(`.tsx`, compiled via the same `tsc -b` project as the rest of `src/`, with
`jsx: "react-jsx"` added to `tsconfig.base.json` and `react`/`react-dom`
added as optional peer dependencies) rather than a full mounted application.
A consuming app wires it up like this:

```tsx
import { buildControlPlaneReadModel } from '@aoc-enterprise/runtime/dist/src/features/aoc-control-plane/services/control-plane-read-model-service.js';
import { AocControlPlanePage } from '@aoc-enterprise/runtime/dist/src/features/aoc-control-plane/components/AocControlPlanePage.js';

const readModel = buildControlPlaneReadModel(runtimeBundle);

<AocControlPlanePage
  readModel={readModel}
  commands={{
    onApproveApproval: (id) => commandService.approveApprovalRequest({ approvalRequestId: id, approverActorId }),
    // ...omit a handler to leave that command safely disabled
  }}
/>;
```

Recommended routes, matching the "prefer existing conventions" rule: mount
under `/aoc/control-plane`, or `/admin/aoc` / `/console/aoc` if the host app
has an admin or console area. This repository has no existing frontend app
route table to integrate into, so no route was registered here.

## Accessibility

- Every table uses `<th scope="col">`/`<th scope="row">` and an
  `aria-label` describing its contents.
- Every action button has visible text (never icon-only) and a `title`
  explaining its state, especially when disabled.
- Status/decision/risk badges (`AocDecisionBadge`, `AocRiskBadge`,
  `ExternalStandingBadge`, and the policy pack badges --
  `PolicyDecisionBadge`, `PolicyEffectBadge`, `PolicyLegalCompletenessBadge`,
  `PolicyDemoOnlyBadge`, `PolicyRuleMatchBadge`) always pair color with a
  text label and symbol -- color is never the only signal, and
  `not_legal_advice` is always `danger`-toned, never green.
- Navigation tabs use `role="tablist"`/`role="tab"`/`aria-selected`.
- Error and empty states use `role="alert"`/`role="status"` respectively.

## Determinism

- `buildControlPlaneReadModel` takes an optional `now: () => string` for
  `generatedAt`; without it, `generatedAt` defaults to the demo world's own
  `trustDomain.updatedAt` rather than a wall-clock read.
- The demo fixture uses each runtime's injectable `ManualClock` /
  sequential id generator (the same pattern every other Soberanía module uses),
  so two independent builds of the fixture produce byte-identical output --
  verified directly in `tests/control-plane-read-model-service.test.ts`
  ("produces deterministic output for the same input").
- No service in this module reads the wall clock, generates random ids, or
  makes a model call. Every table, badge and detail view is a pure function
  of the read model it was given.

## Known limitations

- Recognition Runtime's audit trail does not persist a decision's free-text
  `reason`, only its `reasonCode`; `RecognitionDecisionRow.reason` and
  `AuthorityDecisionRow.reason` are optional for exactly this reason.
- Full DOM interaction tests (simulated clicks, typing) were intentionally
  not added -- this package has no `jsdom`/`@testing-library` dependency and
  adding one was judged not "clearly necessary" for an MVP. Component tests
  use `react-dom/server`'s `renderToStaticMarkup` instead, asserting on
  server-rendered markup across different prop-driven states (a controlled
  `initialSection`, hand-built row fixtures, etc.) rather than simulating
  clicks; this is documented here rather than silently skipped.
- `retry_failed_enforcement` is permanently disabled (see above) since
  Action Enforcement has no runtime API to back it without inventing new
  governance behavior.

## Evidence / Source / Citation Runtime

`src/features/evidence-source-runtime/integrations/control-plane-evidence-adapter.ts`
builds a read-model-only `EvidenceControlPlaneViewModel` (source documents,
evidence artifacts, requirements, satisfactions, reviews, citations, links,
proofs, events) that can feed future evidence/source/citation panels here.
No UI section for it exists yet in this sprint -- the adapter and its tests
are the MVP surface; wiring it into `AocControlPlanePage`/`AocNavigationTabs`
is left for a future sprint.

## Verifiable Export Package

Control Plane snapshots (either a `DemoControlPlaneSnapshot` or a live
`AocControlPlaneReadModel`) can be included in a verifiable export package
via
`src/features/verifiable-export-package/integrations/control-plane-export-adapter.ts`.
That adapter is read-model-only: it never mutates Control Plane state and
never creates policy/evidence/enforcement truth of its own.

## Frontera Systems Pilot Template

Control Plane walkthroughs can now be included in Enterprise Pilot
Templates via
`src/features/aoc-enterprise-pilot-template/integrations/control-plane-pilot-adapter.ts`,
which cross-checks a pilot's declared walkthrough sections against a real
`AocControlPlaneReadModel` -- read-only, never mutating this module's state,
and honestly reporting that `evidence`/`export_packages` focus areas are not
yet backed by a dedicated read-model section here.
