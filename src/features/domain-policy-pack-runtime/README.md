# Soberanía Domain Policy Pack Runtime

Recognition Runtime answers "can this action be recognized?" Authority Graph
answers "where did the authority behind this action come from?" Approval
Runtime answers "who can approve this, and did they?" External Agent
Handshake answers "does this external agent have local standing?" Action
Enforcement answers "should real execution be blocked?" None of them answer
the question that only shows up once Soberanía is deployed at a real enterprise:

**Which domain-specific, jurisdiction-specific, customer-specific or
industry-specific rules apply to this autonomous action, and what must Soberanía
require before the action can be recognized, approved, enforced or blocked?**

That is the Domain Policy Pack Runtime's job.

## Why Soberanía should not hardcode all laws into the core runtimes

Soberanía's core runtimes are **constitutional**: they answer the same questions
for every deployment, every customer, every jurisdiction. "Is this actor
recognized?" and "did a real approver with real authority sign off?" do not
change based on which industry a customer is in. Hardcoding "if customer is
a bank, require X; if jurisdiction is Y, require Z" into Recognition Runtime
or Action Enforcement would couple a generic, reusable protocol to a
combinatorial, ever-growing, and inevitably incomplete pile of
domain/jurisdiction/customer-specific rules -- and it would make every one of
those rules un-versioned, un-auditable, and impossible to test in isolation.

No enterprise software vendor can encode "all laws" upfront, and no customer
wants a black box that claims to. The correct shape is **compliance by
need**: code the domain policy when the business use case requires it, code
the jurisdiction policy when the deployment requires it, code customer
policy when the enterprise requires it -- as an explicit, versioned,
testable, auditable pack loaded on top of the constitutional core, not baked
into it.

## Core Soberanía governance vs. domain policy packs

| Core Soberanía runtime | Question it answers |
| --- | --- |
| Recognition Runtime | Is the actor recognized? |
| Authority Graph | Where did authority come from? |
| Approval Runtime | Is human approval required or valid? |
| External Agent Handshake | Does an external agent have local standing? |
| Action Enforcement | Should execution be blocked? |
| Soberanía Control Plane | Can an operator inspect the proof trail? |
| Frontera Systems Demo | Can the system be proven end-to-end? |
| **Domain Policy Pack Runtime** | **Which domain/jurisdiction/customer policy applies, and what does it require?** |

The Domain Policy Pack Runtime never re-implements or bypasses any of the
runtimes above. It produces additional **requirements** (evidence, approval,
authority, external standing, denial, obligations) that a caller layers on
top of what those runtimes already decided. A policy pack can only ever make
an action *more* restrictive than the core runtimes already required, never
less -- see [Never overriding core denials](#never-overriding-core-denials-non-negotiable).

## Concepts

- **PolicyPack** -- a named, versioned container for one domain/jurisdiction/
  customer's rules (e.g. "Payments Basic"). Has a `kind` (`domain`,
  `jurisdiction`, `industry`, `customer`, `contract`, `data_boundary`,
  `risk`, `demo`) and a `domain` it applies to.
- **PolicyPackVersion** -- the actual unit of evaluation. Immutable once
  active: `rules`, `scope`, `sources`, `effectiveFrom`/`effectiveUntil`,
  `demoOnly`, and `legalCompleteness` all live here, not on the pack. A pack
  can have many versions over time (`draft` → `active` → `deprecated` /
  `revoked` / `superseded`).
- **PolicyPackRule** -- one `condition` → `effect` mapping, plus the
  `obligations`, `evidenceRequirements` and `approvalRequirements` that
  effect carries. Rules are evaluated independently and in deterministic
  priority order; every active rule produces a result (matched or not) so
  nothing is silently skipped.
- **PolicyCondition** -- a predicate (`field` + `operator` + `value`) or a
  group (`all` / `any` / `not` of nested conditions). Evaluated by plain,
  total functions -- no `eval`, no regex beyond simple string ops, no LLM.
- **PolicyEffect** -- what a matched rule *means*: `allow`, `deny`,
  `require_evidence`, `require_approval`, `require_authority`,
  `require_external_standing`, `limit_scope`, `raise_risk`, `warn`, or
  `no_op`.
- **PolicyObligation** -- a side requirement that doesn't change the
  decision type but must still be tracked (e.g. `notify_operator`,
  `manual_verification`, `attach_source_reference`).
- **PolicyEvidenceRequirement** / **PolicyApprovalRequirement** -- structured
  requirements a matched rule adds to the decision; these are what Approval
  Runtime and evidence-collection callers consume.

## Registering packs

```ts
const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext(nowIso));
runtime.registerPolicyPack({ id, name, description, kind, domain });
runtime.registerPolicyPackVersion({ id, policyPackId, version, scope, rules, sources, effectiveFrom, demoOnly, legalCompleteness });
```

`registerPolicyPackVersion` runs `PolicyPackValidator` immediately: duplicate
rule IDs, rule `sourceIds` that don't resolve to a real `PolicyPackSource`,
empty condition groups, and deny/approval/evidence effects missing a
`reasonCode`/`reason` all fail registration before the version is ever
evaluable.

## Activating, deprecating, revoking

```ts
runtime.activatePolicyPackVersion(versionId); // draft|deprecated -> active (only if it has active rules)
runtime.deprecatePolicyPackVersion(versionId); // active -> deprecated
runtime.revokePolicyPackVersion(versionId);   // draft|active|deprecated -> revoked
```

Activating a version that declares `supersedesVersionId` automatically
transitions the superseded version to `superseded` and records both
transitions on the ledger. Status transitions follow a fixed state machine
(`PolicyPackRegistry`'s `VALID_TRANSITIONS`); an invalid transition (e.g.
re-activating a revoked version) throws
`PolicyPackInvalidStatusTransitionError` rather than silently succeeding.

## How applicability is resolved

`PolicyPackApplicabilityService` walks every registered version (not just
active ones, so operators can see *why* something doesn't apply) and
classifies each as `applicable`, `revoked`, `inactive`, `expired`, or
`scope_mismatch`. A version only reaches `applicable` if:

1. its status is `active`,
2. the evaluation's `requestedAt` falls within `effectiveFrom`/`effectiveUntil`, and
3. every non-empty field on its `PolicyPackScope` (trust domain, jurisdiction,
   country, industry, customer, domain, action, capability, resource scope,
   actor type, data domains) matches the input -- an empty/absent scope field
   means "no constraint on this dimension", not "matches nothing".

Only versions that resolve to `applicable` are handed to `PolicyRuleEvaluator`.

## How conditions are evaluated

`PolicyConditionEvaluator` reads one of ~20 known `PolicyEvaluationInput`
fields (or a dotted `metadataPath` under `input.metadata`) and applies one of
14 operators (`equals`, `not_equals`, `includes`, `not_includes`,
`starts_with`, `ends_with`, `in`, `not_in`, `greater_than(_or_equal)`,
`less_than(_or_equal)`, `exists`, `not_exists`). Group conditions compose
with `all` (AND), `any` (OR), and `not` (true only when every nested
condition is false). Every operator is a pure, total function -- a missing
field evaluates to `false` (or `true` for `not_exists`), never throws, and
never depends on anything but the input and the condition tree.

## How rule effects are aggregated

`PolicyRuleEvaluator` evaluates **every active rule** in every applicable
version, in ascending `priority` order (rule id as tie-break), and never
short-circuits: a matched `deny` rule does not stop a later `require_evidence`
rule from also being recorded. This matters because obligations, evidence
requirements and approval requirements are collected from **all** matched
rules regardless of which effect ultimately wins the decision -- so a
`deny`-winning decision can still carry the approval/evidence requirements
another matched rule attached, giving an operator the full picture of what
was checked.

## Effect precedence

`PolicyPackEvaluationService` picks exactly one *winning* matched effect,
using this fixed precedence (most to least restrictive):

1. `deny`
2. `require_external_standing`
3. `require_authority`
4. `require_approval`
5. `require_evidence`
6. `limit_scope`
7. `raise_risk`
8. `warn`
9. `allow`

`no_op` never wins (it can still contribute obligations). If no rule matched
at all, or no version was applicable, the decision type is `not_applicable`
-- meaning "no domain policy constrains this action", which is explicitly
**not** an allow claim, just an absence of an additional constraint. A
malformed `PolicyEvaluationInput` (missing trust domain, actor, action,
resource scope, risk level, or timestamp) short-circuits to `invalid_input`,
which is always `allowed: false` -- a runtime that cannot evaluate an input
must fail closed, never be silently skipped.

## Evidence requirements

`PolicyEvidenceService` deduplicates evidence requirements by `type:id`
across every matched rule and marks a requirement "missing" unless the
input's `evidenceIds` includes it (or `hasRequiredEvidence` is explicitly
`true`). `toStructuralApprovalEvidence()` maps each requirement onto a shape
structurally identical to Approval Runtime's `ApprovalEvidenceRequirement`
(e.g. `invoice` → `source_document`, `authority_proof` → `authority_proof`)
without importing Approval Runtime's types directly.

## Approval requirements → Approval Runtime

`PolicyApprovalRequirementService.toStructuralApprovalRequirement()` maps a
`PolicyApprovalRequirement` onto a shape structurally identical to Approval
Runtime's `ApprovalRequirement`:

| Policy pack type | Structural approval type | Default `requiredAuthorityCapability` |
| --- | --- | --- |
| `finance_review` | `authority_based_approval` | `approve_financial_action` |
| `legal_review` | `authority_based_approval` | `approve_critical_action` |
| `compliance_review` | `authority_based_approval` | `approve_critical_action` |
| `operator_review` | `authority_based_approval` | `approve_project_action` |
| `single_approval` / `dual_approval` / `quorum_approval` / `role_based_approval` | same name | (none; use `requiredApproverRoleIds`/`requiredApproverActorIds` instead) |

`minimumApprovals` and `requiresSegregationOfDuties` always pass through
unchanged -- this module only **proposes** requirements; Approval Runtime
still decides who may approve, still enforces segregation of duties, and
still produces its own `ApprovalDecision`/`ApprovalProof`.

## How Action Enforcement can consume policy pack results

`createActionEnforcementPolicyPackIntegration(runtime)` returns
`evaluatePolicyForEnforcement(input)`, mapping a `PolicyPackDecision` onto a
`PolicyEnforcementEvaluationResult` (`policy_allowed` / `policy_denied` /
`policy_requires_evidence` / `policy_requires_approval` /
`policy_requires_authority` / `policy_requires_external_standing` /
`policy_limited` / `policy_warning` / `policy_not_applicable`). This remains a
**structural adapter**: it never imports `action-enforcement`'s
`EnforcementRequest`/`EnforcementPolicy` types, and it never itself blocks or
allows execution -- it only evaluates and reports. Deciding what a result
*means* for a real enforcement decision, and invoking a real executor
callback, stays entirely inside `action-enforcement`.

### Action Enforcement wiring

`action-enforcement` now has an optional, deterministic preflight
integration that consults this adapter. To wire the two together:

1. **Build a `PolicyPackRuntime`** with the packs you need registered and
   activated (see "Registering packs" above, or reuse
   `buildDemoPolicyPackRuntime()` from `fixtures/domain-policy-pack-demo.fixture.ts`
   for the six sample packs).
2. **Create the integration adapter**:
   `const integration = createActionEnforcementPolicyPackIntegration(runtime);`
3. **Bridge it onto `action-enforcement`'s local structural interface** --
   `action-enforcement/domain/policy-pack-enforcement.ts` defines its own
   `EnforcementPolicyPackIntegration`/`EnforcementPolicyPackEvaluationInput`/
   `EnforcementPolicyPackEvaluationResult` types (mirroring this module's
   shapes field-for-field, the same pattern `action-enforcement` already uses
   for Recognition Runtime) rather than importing this module's types
   directly, so a small bridge function adapts one to the other. See
   `bridgePolicyPackIntegration()` in
   `action-enforcement/fixtures/policy-pack-enforcement.fixture.ts` for a
   complete example, including how it enriches the result with
   `policyPackVersionIds`/`matchedRuleIds` by reading the underlying
   `PolicyPackDecision` back off `runtime.getPolicyPackDecision(...)`.
4. **Pass the bridged integration into the runtime**:
   `createActionEnforcementRuntime(ctx, recognitionIntegration, { policyPackIntegration })`.

Once wired, `action-enforcement`'s preflight pipeline calls
`evaluatePolicyForEnforcement` once per request (after recognition, approval,
evidence, external standing and adapter permission have already
independently passed) and maps the result onto its own `EnforcementDecision`:
`policy_denied`/`policy_requires_authority` block as `execution_blocked`,
`policy_requires_evidence` blocks as `evidence_required`,
`policy_requires_approval` blocks as `approval_required`,
`policy_requires_external_standing` blocks as `external_handshake_required`,
and `policy_allowed`/`policy_warning`/`policy_not_applicable` never block by
themselves. A policy pack `allow` can therefore never override an earlier
Recognition Runtime, Authority Graph, Approval Runtime, External Agent
Handshake, adapter, emergency-deny, dry-run or idempotency denial -- those
are all resolved before the policy pack is ever consulted. See
`action-enforcement/README.md`'s "Domain Policy Pack Runtime integration"
section for the full preflight ordering and mapping table.

**Why adapter-only composition preserves module boundaries**: this module
never imports `action-enforcement` internals, and `action-enforcement` never
imports this module's domain types outside of fixtures/tests -- both sides
depend only on the small structural shapes each defines for itself. That
keeps the two features free to evolve independently and keeps
`action-enforcement` policy-pack-*aware*, not policy-pack-*dependent*: a
runtime built without `policyPackIntegration` behaves exactly as it did
before this integration existed.

**Testing a pack before wiring it into enforcement**: call
`runtime.evaluatePolicy(...)` (or `PolicyPackSimulationService` for a draft
version) directly against representative inputs and assert on the
`PolicyPackDecision` -- this module's own `tests/packs/` and
`tests/scenarios/` suites are the place to validate a pack's rules in
isolation, before any `action-enforcement` wiring test ever runs it end to
end.

## How Recognition Runtime can consume policy pack results

`createRecognitionPolicyPackIntegration(runtime)` returns
`evaluatePolicyForRecognition(input)`, mapping `denied`/`invalid_input`/
`limited`/`requires_authority`/`requires_external_standing` to
`'policy_violation'`, `requires_evidence` to `'require_more_evidence'`, and
`requires_approval` to `'require_human_approval'` -- Recognition Runtime's
own `RecognitionDecisionType` vocabulary. `allowed`, `warning` and
`not_applicable` all map to **no override** (`recognitionOverrideType:
undefined`), meaning "defer entirely to Recognition Runtime's own passport,
capability, revocation and expiry checks." A policy pack can never itself
grant recognition -- the override vocabulary only ever narrows, never widens,
what Recognition Runtime would otherwise decide.

## How Control Plane can display policy pack decisions

`buildPolicyPackControlPlaneViewModel(runtime)` maps every registered pack,
version, rule, evaluation, decision, proof and event into flat `*Row` types
(`PolicyPackRow`, `PolicyPackVersionRow`, `PolicyRuleRow`,
`PolicyEvaluationRow`, `PolicyDecisionRow`, `PolicyProofRow`,
`PolicyEventRow`), mirroring `aoc-control-plane`'s existing
`to<X>Row()`/`build<X>ViewModel()` pattern. This is read-model-only: it never
evaluates policy and never mutates the runtime. Wiring it into the live
`AocControlPlaneReadModel` union requires touching
`aoc-control-plane/services/control-plane-read-model-service.ts` and
`aoc-control-plane/domain/control-plane-view-model.ts`, which this module
deliberately leaves undone -- the adapter and its tests are the deliverable;
Control Plane UI wiring is a follow-up.

## How Enterprise Demo scenarios can use policy packs

`buildPolicyPackDemoScenarioMetadata(evaluationResult)`,
`buildPolicyPackProofChainReference(evaluationResult)` and
`buildPolicyPackDemoExportSnippet(evaluationResult)` all derive their output
strictly from a real `PolicyPackEvaluationResult` the runtime produced --
none of them accept a canned outcome or synthesize a decision.

`aoc-enterprise-demo`'s Policy Pack Enterprise Demo Extension (see that
module's README) now demonstrates all six demo packs end to end: eight
`policy_packs`-category scenarios drive real `AocGuard.enforce()` calls
through a policy-pack-configured runtime (built via
`action-enforcement/fixtures/policy-pack-enforcement.fixture.ts`'s
`buildPolicyPackEnforcementFixture()`, which itself wraps
`buildDemoPolicyPackRuntime()`), covering payments-basic,
procurement-basic, data-boundary-basic and sports-event-settlement-basic --
finance-review approval, hard-deny bank account changes, purchase-order and
event-record evidence requirements, sensitive/prohibited data export
handling, and a low-risk allowed read that still records a policy decision.

## How PolicyPackProof is generated

`PolicyPackProofService` hashes three independent slices of an evaluation --
`inputHash` (the `PolicyEvaluationInput`), `ruleResultsHash` (every
`PolicyRuleEvaluationResult`), `decisionHash` (the `PolicyPackDecision`) --
using the same `stableStringify` + SHA-256 pattern used across every other
Soberanía runtime (recursively sort object keys so hashing never depends on
insertion order). `proofHash` then chains all three hashes together with the
applicable pack version IDs, matched rule IDs, and the previous proof's hash
(`previousHash`), so identical inputs always produce an identical
`proofHash`, and changing any part of the input, rule results, decision, or
which pack versions applied changes it. `verifyProof()` re-derives the hash
from a proof's own recorded fields and compares.

## How PolicyPackLedger works

Every lifecycle transition and every step of an evaluation
(`policy_pack_registered`, `policy_pack_version_activated/deprecated/
revoked/superseded`, `policy_evaluation_started`,
`policy_pack_applicability_resolved`, `policy_rule_matched`/
`policy_rule_not_matched`, `policy_decision_created`, `policy_proof_created`,
`policy_simulation_started`/`completed`) is recorded as a `PolicyPackEvent`
with its own hash-chained `eventHash`/`previousHash`, independent of the
proof chain. `getTrailByEvaluation`/`getTrailByDecision`/`getTrailByProof`/
`getTrailByTrustDomain` reconstruct the full audit trail behind any decision.

## How simulation works

`PolicyPackSimulationService.simulate(input)` copies the selected
`policyPackVersionIds` (and their parent packs) into a throwaway in-memory
`PolicyPackStore`, runs every `evaluationInputs` entry through a fresh
`PolicyPackEvaluationService` bound to that sandbox, and returns a summary
(`allowed`/`denied`/`requiresEvidence`/`requiresApproval`/`warnings`/
`notApplicable` counts). The live runtime's decisions, proofs and event
ledger are never touched -- this is how a pack author tests a **draft**
version's behavior before ever activating it.

## Sample packs

All seven ship marked `demoOnly: true` and `legalCompleteness:
'not_legal_advice'` (or `'partial_policy_model'`), and none claims to encode
a real jurisdiction, regulation, or industry certification:

| Pack | Domain | Demonstrates |
| --- | --- | --- |
| `payments-basic` | payments | finance review, deny-by-default bank account changes, dual approval above a value threshold, invoice evidence, authority proof |
| `procurement-basic` | procurement | purchase order evidence, vendor counterparty requirement, operator review for high-risk procurement |
| `data-boundary-basic` | data_boundary | compliance review for sensitive exports, deny for prohibited data domains, allow for non-sensitive reads, data classification evidence |
| `sports-event-settlement-basic` | sports_event_settlement | event record evidence, authority proof, value-threshold approval, unsupported-jurisdiction manual verification, counterparty requirement |
| `financial-approval-basic` | financial_approval | finance review capability gate, deny-by-default bank details management, approval proof for financial side effects, dual approval at critical risk |
| `jurisdictional-baseline-demo` | general_enterprise | a **placeholder** showing the shape of a jurisdictional pack -- legal/contractual review, sign_contract authority+approval, source-reference obligation, and (because it encodes no real jurisdiction) every jurisdiction-tagged action requires manual verification |
| `global-legal-baseline` (`aoc.global_legal_baseline.v1`) | legal | see [Soberanía Global Legal Baseline Pack v1](#aoc-global-legal-baseline-pack-v1) below |

## Soberanía Global Legal Baseline Pack v1

`packs/global-legal-baseline.policy-pack.ts` (pack id `aoc.global_legal_baseline.v1`,
registered via `registerGlobalLegalBaselinePolicyPack(runtime)`) is a
**baseline legal-awareness layer**, not a legal compliance engine. It gives
Soberanía a reusable, deterministic baseline for jurisdiction awareness
(jurisdiction-unknown/conflict handling, missing jurisdiction-specific-pack
detection), authority-boundary flags (missing authority proof binding a
principal, authority scope mismatch, unidentified principal), legal-review
triggers (high-value contract, cross-border payment, minor involvement,
unclear consumer refund rights, employment classification risk, detected
regulated activity), regulated-action-pattern warnings (payment services,
healthcare data, employment decision, financial advice, consumer credit,
insurance, gambling/prize, minor data, biometric data, cross-border
transfer -- flagged, never interpreted), prohibited-action baseline patterns
(deny-by-default), contract-template re-review after modification, active-
dispute blocking, and customer/counsel validation gating -- evaluated
entirely through this runtime's ordinary `condition` -> `effect` rule shape,
exactly like every other pack above. It creates no separate legal engine,
interpreter, or jurisdictional law resolver.

Its `PolicyPackVersion.metadata` carries the required safe-framing fields
(`legalAdvice: false`, `complianceCertification: false`,
`jurisdictionSpecific: false`, `completenessClaimed: false`,
`policyModelStatus: 'partial_policy_model'`, `validationStatus:
'demo_baseline'`, `requiredDisclaimer: 'not_legal_advice'`,
`safeFramingLabels: [...]`) alongside this runtime's existing
`legalCompleteness`/`demoOnly` fields, plus empty extension-point arrays for
future jurisdiction-specific packs (`requiredJurisdictionPackIds`,
`jurisdictionPackStatus`, `jurisdictionSpecificPolicyRefs`,
`counselReviewedPolicyRefs`) that this pack never pre-populates with a real
compliance claim.

Two rules are the **critical merge gate**: a policy source whose
`validationStatus` is `demo_baseline` or `customer_provided` can never
satisfy an action that `requiresCounselReview` -- both always route to
`legal_review` instead of passing, and `PolicyPackValidator` separately
rejects any attempt to register this pack `demoOnly: true` with
`legalCompleteness: 'verified_by_counsel'`.

Because its scope is intentionally unconstrained (`{}` -- a *global*
baseline meant to apply across every domain/jurisdiction, not one vertical),
it is deliberately kept out of the shared `buildDemoPolicyPackRuntime()` seed
the other six sample packs' tests reuse: an unconstrained-scope pack added
to that shared seed would start matching those packs' existing demo inputs
and silently changing their asserted decisions. Use
`buildGlobalLegalBaselineDemoPolicyPackRuntime()` /
`buildQuietGlobalLegalBaselineInput()` from
`fixtures/global-legal-baseline-policy-demo.fixture.ts` instead. Wiring it
into the shared demo runtime, `action-enforcement`, `aoc-enterprise-demo`, or
the Enterprise Pilot Template is left as a follow-up once a real deployment
has decided which of its triggers it wants active enterprise-wide.

## Legal / compliance disclaimer

**These sample packs are demo-only illustrations, not legal advice.** They
do not constitute a complete legal, regulatory, or industry compliance pack
for any real jurisdiction or business. They do not claim PCI-DSS, AML, SOX,
GDPR, HIPAA, CCPA, or any other statutory or contractual compliance. The
`jurisdictional-baseline-demo` pack in particular encodes **no real
jurisdiction's law** -- it exists only to show how a real, customer- and
counsel-reviewed jurisdictional pack would be loaded and evaluated later. A
real deployment must author its own packs from sources it can stand behind
(`PolicyPackSource.authority`: `customer_provided`, `internal`,
`external_reference`, or `counsel_reviewed`) and set `legalCompleteness`
honestly (`not_legal_advice` → `partial_policy_model` →
`customer_provided_policy` → `verified_by_customer` →
`verified_by_counsel`). This runtime never fetches legal data from the
network, never uses an LLM to decide applicability or evaluate a rule, and
never claims completeness beyond what a pack's own `sources` and
`legalCompleteness` field explicitly assert.

## Never overriding core denials (non-negotiable)

A policy pack can only ever **add** a restriction on top of what Recognition
Runtime, Authority Graph, Approval Runtime, External Agent Handshake and
Action Enforcement already decided -- it can never remove one:

- `policy_allowed`/`policy_warning`/`policy_not_applicable` never override a
  revoked capability, an expired capability, invalid authority, a missing
  approval, invalid external standing, or an Action Enforcement deny. Every
  integration adapter in this module documents this composition rule at the
  call site (see the "does not override" scenario tests under
  `tests/scenarios/`), and a caller wiring this module in is expected to
  `AND` this module's `allowed` flag with every other runtime's decision,
  never substitute it.
- `policy_denied` always blocks, even if every other runtime would have
  allowed the action.

## Adding a new policy pack

1. Add a new file under `packs/<name>.policy-pack.ts` exporting a
   `RegisterPolicyPackParams` const, a `RegisterPolicyPackVersionParams`
   const (with real `PolicyPackRule`s, each with a real `sourceIds` entry
   resolving to a `PolicyPackSource` in the same version), and a
   `register<Name>PolicyPack(runtime)` function that registers and activates
   it.
2. Mark `demoOnly` and `legalCompleteness` honestly. If the pack is not
   backed by a customer- or counsel-reviewed source, it must stay `demoOnly:
   true` and `legalCompleteness: 'not_legal_advice'` or
   `'partial_policy_model'`.
3. Re-export it from `packs/index.ts`.
4. Add a fixture builder under `fixtures/` if the pack needs demo inputs, and
   register it with `buildDemoPolicyPackRuntime()` if it should be part of
   the shared demo seed.
5. Write `tests/packs/<name>.policy-pack.test.ts` covering every rule's
   condition, effect, and (where relevant) precedence interaction with other
   packs.

## Adding a jurisdiction-specific pack safely

Never encode a real jurisdiction's law without a real, attributable source.
A jurisdictional pack must:

- set `kind: 'jurisdiction'` and scope itself with `scope.jurisdictions`/
  `scope.countries`,
- attach a `PolicyPackSource` for every rule with `authority` set honestly
  (`customer_provided`/`external_reference`/`counsel_reviewed` -- never
  `demo_only` for a pack claiming real jurisdictional coverage),
- set `legalCompleteness` no higher than what was actually reviewed, and
- never claim completeness for a jurisdiction it doesn't have a rule for --
  an unsupported jurisdiction should route to `manual_verification` (see
  `jurisdictional-baseline-demo`'s pattern), not silently pass.

## Testing a new pack

Use `PolicyPackSimulationService` to run a batch of representative
`PolicyEvaluationInput`s against a **draft** version before activating it --
this never touches the live runtime's decisions/proofs/events. Once
satisfied, activate the version and add its scenarios to
`tests/packs/<name>.policy-pack.test.ts`. Every test in this module runs
against a fixed, injected clock and ID generator, so re-running a test twice
must always produce byte-identical decisions and proof hashes -- if it
doesn't, the pack (or the test) has a nondeterminism bug.

## Determinism

- **Injected clock**: every service takes a `PolicyPackRuntimeContext` with
  `clock.now()`; nothing calls `Date.now()` or `new Date()` directly.
- **Injected ID generator**: `ids.nextId(prefix)` is a simple sequential
  counter (`createSequentialPolicyPackIdGenerator`); nothing calls
  `Math.random()`, `crypto.randomUUID()`, or similar.
- **Deterministic hashing**: `stableStringify` + SHA-256, recursively sorted
  keys, shared verbatim with the same pattern used in `action-enforcement`,
  `approval-runtime`, `authority-graph` and `recognition-runtime`.
- **No LLM evaluation**: every condition, rule, and applicability check is a
  plain, total TypeScript function over typed fields -- no model call, no
  prompt, no non-deterministic inference, anywhere in this module.
- **No network calls**: policy packs are code, registered in-process; this
  module never fetches a pack, a source, or a rule from the network.

## Control Plane visibility

The Soberanía Control Plane's Policy Packs section
(`../aoc-control-plane/components/policy-packs/`) surfaces this runtime's
state to an operator. A few rules govern that integration:

1. Policy packs, versions, rules, evaluations, decisions, proofs and events
   can all be surfaced in the Soberanía Control Plane -- see
   `integrations/control-plane-policy-pack-adapter.ts`
   (`buildPolicyPackControlPlaneViewModel`), which the Control Plane's own
   `control-plane-policy-pack-read-model-service.ts` consumes and re-projects
   into its own row types.
2. The Control Plane consumes this runtime's read-only rows/adapter output
   -- never `PolicyConditionEvaluator`, `PolicyRuleEvaluator`, or any other
   evaluation service directly. It only ever reads `PolicyPackStore`/
   `PolicyPackLedger` state through the adapter above.
3. The UI does not re-evaluate policy. No React component in the Control
   Plane calls `evaluatePolicy`, `simulatePolicyPack`, or any other
   evaluation entry point on `PolicyPackRuntime` -- it only renders decisions
   and proofs this runtime already produced.
4. The UI shows pack/version/rule/decision/proof/event state exactly as
   recorded: `PolicyPacksTable`/`PolicyPackVersionsTable`/`PolicyRulesTable`
   list registry state, `PolicyEvaluationsTable`/`PolicyDecisionDetail`/
   `PolicyProofDetail` show a single evaluation's outcome and proof, and
   `PolicyEventsTable` shows the ledger's hash-chained event trail.
5. `legalCompleteness`/`demoOnly` badges (`PolicyLegalCompletenessBadge`,
   `PolicyDemoOnlyBadge`) are **display metadata, not legal conclusions**.
   They render exactly what `PolicyPackVersion.legalCompleteness`/
   `demoOnly` already say -- the Control Plane never upgrades, infers, or
   softens either value.

## Relationship to `packages/policy-runtime`

This module is unrelated to the separate `packages/policy-runtime` workspace
package (`EnterprisePolicyDecision`/`EnterprisePolicyEvaluationRequest` in
`packages/policy-runtime/src/contracts.ts`). That package is a placeholder,
has no consumers, and lives in a different TypeScript project (`packages/*`
vs. `src/features/*`). Do not confuse the two when searching for "policy" in
this repository.

## Evidence / Source / Citation Runtime

`PolicyEvidenceRequirement`s produced here (see [Evidence requirements](#evidence-requirements))
can be represented, tracked, and validated by the new
`src/features/evidence-source-runtime/` module via
`integrations/policy-pack-evidence-integration.ts`. That runtime owns
registering source documents, submitting evidence artifacts, and producing
deterministic evidence proofs and citation trails -- this runtime still owns
evaluating rules and deciding `requires_evidence`; it never delegates that
decision.

## Verifiable Export Package

`PolicyPackDecision`/`PolicyPackProof` records produced here can be exported
in a verifiable decision packet via
`src/features/verifiable-export-package/integrations/policy-pack-export-adapter.ts`.
That module never re-evaluates a policy rule -- it packages the decision and
proof this runtime already produced, preserving `demoOnly`/
`legalCompleteness` as plain metadata, never a compliance claim.

## Frontera Systems Pilot Template

Sample policy packs registered here (payments-basic, procurement-basic,
data-boundary-basic, financial-approval-basic, sports-event-settlement-basic,
jurisdictional-baseline-demo) can now be referenced inside Enterprise Pilot
Templates via `src/features/aoc-enterprise-pilot-template/integrations/policy-pack-pilot-adapter.ts`,
which propagates each pack version's `demoOnly`/`legalCompleteness` label
verbatim and never claims production compliance on this runtime's behalf.
