# Target Architecture: Frontera as an Authority-Control Platform

- Status: proposed — **no implementation has been performed**
- Prerequisite reading: `CURRENT_STATE_AUTHORITY_CONTROL.md`
- Decided by: `ADR-AUTHORITY-CONTROL-LAYERING.md`,
  `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`,
  `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`,
  `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md`

## 1. Product thesis, stated so it can be tested against code

> Frontera does not replace a system's internal IAM, RBAC, permissions,
> authentication, signing or native security controls. Frontera governs **under
> what authority** an action may be exercised **across a system boundary**.

Three consequences follow, and each one is a test a design must pass:

1. **Frontera never authenticates a human on behalf of the target system.** It
   consumes an authentication result; it never issues one. (Already true.)
2. **Frontera never stores the target system's permissions.** It decides whether
   an authority may be *exercised* now, under this policy, with these facts.
   (Already true.)
3. **Frontera never trusts the boundary-crossing caller for the facts the
   decision turns on.** (Not yet true — this is the work.)

## 2. The target lifecycle

```
request
  → authority          (A)  under whose authority is this being attempted?
  → context resolution (C)  what is true right now, and who says so?
  → policy evaluation  (B)  what do the declared rules conclude?
  → obligations        (D)  what must happen first, and did it?
  → bounded grant      (E)  a narrow, expiring permission to proceed
  → action                  execution, through an adapter
  → revocation/expiry  (E)  the grant ends, by clock or by decision
  → evidence           (F)  every step above, provable afterwards
                       (G)  intelligence observes all of it, decides none of it
```

## 3. The seven layers

### A — Authority

**Question:** under whose authority is this action attempted, and does that
authority currently stand?

**Owns:** the resolution of actor recognition, capability, delegation lineage,
organizational authority and rights-scoped authority into one typed
`AuthorityResolution` that downstream layers cite by id.

**Composes (does not replace):** Recognition Runtime, Authority Graph, Kernel
Authority Store, Governed Authority. Each keeps its current shape and tests; A
is the resolution *record* they contribute to, not a fifth engine.

**May not:** evaluate business policy, read business context, issue a grant,
execute anything.

**Fail mode:** an authority that cannot be resolved is not authority. Closed.

### B — Policy

**Question:** given resolved authority and resolved context, what do the
declared rules conclude?

**Owns:** policy packs, versions, rules, conditions, effects, and the
deterministic evaluation of them. Extended with *derived values* (§5.2) so
aggregate and arithmetic clauses become expressible.

**May not:** resolve its own context (it receives it), decide authority, mutate
state, call a model, use `eval`/`new Function`/dynamic code.

**Fail mode:** a rule that cannot be evaluated must not silently not-match.
**This is not already true**, and an earlier draft claimed it was. Today a
predicate over a missing field or a mismatched type simply returns `matched:
false` (`PolicyConditionEvaluator.compareNumeric` and its `default` arm), and
when no rule matches, `PolicyPackEvaluationService` yields `not_applicable`,
which is in `NON_BLOCKING_DECISION_TYPES`. So an unevaluable *restrictive* rule
today lets processing continue.

What *is* already fail-closed is one level up: a throwing policy-pack
integration, a malformed integration result, and `invalid_input` all map to
`policy_denied`. That is a different guarantee, and conflating the two
overstated the current posture.

The target adds a third predicate result alongside matched/not-matched —
`unevaluable`, carrying why (missing fact, unresolved fact, type mismatch,
below-required-trust). A rule with any `unevaluable` predicate does not silently
fall through; it resolves per the handling the rule itself declares, and a rule
that declares none fails closed. This is what makes an unresolved fact a thing
policy reacts to rather than a thing that disappears, and it is what reconciles
this layer with the context ADR's position that policy — not the platform —
decides what an unresolved fact means.

### C — Context

**Question:** what is true right now about the vendor, the invoice, the spend,
the risk — and **who says so, when, and how sure are we?**

**Owns:** context sources, resolvers, resolved facts, and the provenance, subject
binding and trust classification of each fact — for both rule evaluation **and
policy-pack applicability**. This is the new layer that makes the product thesis
true.

Applicability matters as much as evaluation and is easy to miss: pack selection
runs *before* any rule, and today it filters on requester-asserted
`jurisdiction`, `country`, `industry`, `customerId`, `domain` and `dataDomains`,
so a caller can make a restrictive pack inapplicable and never have its rules
consulted. Per-rule requirements cannot reach that. See
`ADR-CONTEXT-PROVENANCE-AND-TRUST.md` §4a.

**May not:** decide anything. A context resolver returns facts and a resolution
status; it has no allow, no deny, no narrow. (This is exactly the contract
`GovernedConstraintProvider` already honours.)

**Fail mode:** an unresolved fact is reported as unresolved, never as absent and
never as a default. Policy decides what an unresolved fact means; the platform
ships no default rule. A required fact that is unresolved denies **because the
policy said so**, not because C decided.

### D — Obligations

**Question:** what must happen before, during or after the action, and did it?

**Owns:** the obligation lifecycle — `required → pending → discharged →
verified`, plus `waived` and `expired` — with a discharge record and a proof.

**May not:** grant anything, or narrow policy's conclusion. An undischarged
blocking obligation prevents grant issuance; it does not rewrite the decision.

**Fail mode:** an obligation whose discharge cannot be verified is not
discharged. Closed.

### E — Grants

**Question:** what narrow, expiring permission does this decision actually
produce, and when does it stop?

**Owns:** bounded grant issuance derived from a *verified* decision, grant
lifecycle, expiry and revocation, and provider enforcement through the existing
adapter contract.

**May not:** issue a grant broader than the decision that authorized it, or
outlive the decision's bound. This is attenuation-only, the same rule Authority
Graph already enforces for delegation.

**Fail mode:** a grant that cannot be bound to a verified decision is not
issued. Closed.

### F — Evidence

**Question:** can a third party reconstruct, later, exactly why this was
allowed?

**Owns:** the governance record, the evidence graph, bundles, disclosure
policies, integrity digests and export packages — extended to cover context
facts, obligation discharge and revocation as first-class subjects.

**May not:** alter what it records, or be required for the decision. Evidence is
downstream; a failure to project evidence must never change an outcome that was
already reached. (It may of course *block execution* via an existing evidence
requirement — that is B and D acting, not F.)

### G — Intelligence

**Question:** what should a human or an operator *understand* about all of the
above?

**Owns:** explanation, interpretation, signal detection, anomaly surfacing,
policy drafting assistance, simulation narration, recommendation.

**May not — and this is the hard boundary:** appear anywhere in the
authorization path. No AI output is an input to A, B, C, D or E. AI never
produces a fact that policy reads, never produces a decision, never discharges
an obligation, never issues or revokes a grant. Its outputs are *advisories*
addressed to humans, are typed as such, are stored as such, and are
structurally incapable of reaching the Kernel. See
`ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md`.

## 4. Boundaries, stated as a dependency rule

```
G (Intelligence)  ──reads──▶  A B C D E F           ──writes──▶ advisories only
                              ▲
F (Evidence)      ──reads──▶  A B C D E             ──writes──▶ records only
E (Grants)        ──reads──▶  A B C D               ──writes──▶ grants, revocations
D (Obligations)   ──reads──▶  A B C                 ──writes──▶ discharge records
B (Policy)        ──reads──▶  A C                   ──writes──▶ nothing
C (Context)       ──reads──▶  external systems      ──writes──▶ nothing
A (Authority)     ──reads──▶  identity, lineage     ──writes──▶ nothing
```

Six invariants, each intended to become a test:

1. **No upward dependency.** C never imports B. B never imports E. F never
   imports G. D reads A, B and C directly; the provider acknowledgement it needs
   from E arrives through a `DischargeVerificationPort` D declares and the
   adapter implements, so the import edge points D ◀── E and the graph stays
   acyclic (see `ADR-AUTHORITY-CONTROL-LAYERING.md` §2).
2. **Only the Kernel decides.** A, B, C, D contribute; the Kernel concludes.
   Unchanged from today.
3. **Facts-only layers cannot decide.** C and G have no allow/deny in their
   return types. Structurally, not by convention.
4. **Narrowing only.** No optional port may widen an outcome. Already enforced
   for the governed-authority step; extended to every new port.
5. **Attenuation only.** A grant ⊆ its decision. A delegation ⊆ its source.
6. **Fail closed.** Every unresolvable state has exactly one documented
   direction, and it is denial or `indeterminate`.

## 5. Design of the two genuinely new mechanisms

### 5.1 Context: sources, facts, provenance, trust

Four concepts, deliberately small:

**`ContextSource`** — a declared, configured, named origin. Kinds:
`request` | `internal_store` | `erp` | `crm` | `external_api` | `ledger` |
`identity_provider` | `approval_system` | `risk_engine` | `signed_attestation`.
A source is *configured by the deployment operator*, never named by the
requester.

**`ContextFact`** — a discriminated union on `resolution`, so a shape with no
value cannot pretend to have one:

```
{ key, subject, requirementId, resolution: 'resolved' | 'stale',
  value, sourceId, observedAt, freshness, trust }
{ key, subject, requirementId, resolution: 'unresolved',
  attemptedSourceIds, attemptedAt, failureCode }
{ key, subject, requirementId, resolution: 'conflicted',
  candidates: [ { value, sourceId, observedAt, trust }, … ] }
```

**`subject`** — `{ type, id, derivedFrom }`, bound to the evaluated request or
resource. Provenance proves where a value came from; only the subject proves it
describes the entity the action concerns. A fact about vendor B cannot decide an
action about vendor A.

**`trust`** — two orthogonal fields, because level and derivation are different
questions:

```
trust.level       attested (3) > authoritative (2) > asserted (1) > none (0)
trust.derivation  { kind: 'direct' }
                | { kind: 'derived', operandFactIds, operator }
```

| level | meaning | may a policy decide on it? |
| --- | --- | --- |
| `attested` | signed by an issuer the deployment trusts, verified here | yes |
| `authoritative` | read directly by Frontera from a configured system of record | yes |
| `asserted` | supplied by the requester | **only when the policy pack explicitly declares that this key may be asserted** |
| `none` | no trustworthy origin established | no |

A derived fact's `level` is the **minimum** of its operands' levels — it cannot
launder trust — while `derivation` retains every operand id, so the provenance
survives the downgrade. The ordering is total, so `minimumTrust` is a plain `>=`
with no undefined cases. See `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` §2 for why
`derived` is not a fourth level.

The default for any key not declared is `asserted`, and the default for
`asserted` is that no rule may turn on it. That inverts today's posture, which
is why it must arrive behind a per-deployment switch (§7).

**`ContextRequirement`** — declared in two places, because two things select
what governs an action. A **rule** declares which keys it needs, about which
subject, at what minimum trust level. A **pack scope** declares the same for the
keys its own applicability turns on, so pack selection stops matching against
requester-asserted `ActionDescriptor` fields. The Kernel resolves exactly the
declared keys, scope keys first, and never speculatively.

Why this shape: it is `GovernedConstraintProvider` generalized. Same position in
the pipeline (resolved before the synchronous engine), same facts-only contract,
same explicit `resolved: false` rather than an empty set, same namespaced
delivery into policy input. The one addition is that a fact now carries who said
it.

**The self-assertion rule, stated once:** a requesting actor may state what it
wants to do. It may never state a fact that decides whether it may. The
`organizationId` reservation in `request-adapter.ts` becomes the general case
rather than a two-key special case.

### 5.2 Policy: value expressions as predicate operands

`PolicyCondition` is a boolean tree. A third sibling node type producing a
*number* would not fit it: nothing would say how that number becomes true or
false, and no predicate could reference it. Arithmetic belongs one level down,
inside a predicate, as an operand.

So `PolicyPredicateCondition` gains a typed operand union on both sides of its
comparison:

```
ValueExpression =
  { kind: 'literal',     value }
| { kind: 'field',       field: PolicyPredicateField }    // unchanged, closed
| { kind: 'contextKey',  key, subject }                   // a resolved fact
| { kind: 'arithmetic',  operator, operands: ValueExpression[] }

PolicyPredicateCondition = { type: 'predicate', left: ValueExpression,
                             operator: PolicyPredicateOperator,
                             right: ValueExpression }
```

`monthlyVendorSpend + amount < 50000` is then one predicate:

```
left:  { kind: 'arithmetic', operator: 'sum', operands: [
           { kind: 'contextKey', key: 'vendor.monthlySpend', subject: vendorRef },
           { kind: 'contextKey', key: 'payment.amount',      subject: paymentRef } ] }
operator: 'less_than'
right: { kind: 'literal', value: 50000 }
```

The arithmetic operator set is closed (`sum`, `difference`, `product`,
`quotient`, `min`, `max`, `count`) and total over its operand types. No
expression language, no parser, no `eval`, no free-floating node whose result
nothing consumes.

`monthlyVendorSpend` is a *context fact resolved by an aggregate resolver*
(`authoritative`, read from the spend ledger), not something the policy engine
computes by querying a database — B never reads a store.

Division by zero, type mismatch, and an operand fact that is `unresolved`,
`conflicted` or below the rule's required trust level all make the expression
`unevaluable`, which is the third predicate result introduced under layer B
above — not a silent `false`.

**Backward compatibility:** today's `{ field, operator, value }` predicate is
exactly `{ left: {kind:'field'}, operator, right: {kind:'literal'} }`, so every
existing pack maps over mechanically and `PolicyPredicateField` stays closed for
the fields it already has.

`PolicyPredicateField` stops being the only way in: a predicate may name either
a known field (unchanged) or a `contextKey`. The closed union stays for the
fields it already has, so every existing pack keeps compiling and behaving
identically.

## 6. Proposed module structure

Additive only. Nothing listed here replaces an existing module.

```
packages/
  context-contracts/          NEW  ContextSource/Fact/TrustClass/Requirement,
                                   validation, equality, serialization.
                                   Pure data. Same discipline as access-decision.
  authority-resolution/       NEW  AuthorityResolution record + validation.
                                   Pure data.
  obligation-lifecycle/       NEW  ObligationState, DischargeRecord,
                                   DischargeProof. Pure data.
  advisory-contracts/         NEW  Advisory, AdvisoryKind, AdvisoryProvenance.
                                   Pure data, structurally non-decisional.
  access-grant/               EXT  optional decision-binding fields
  provider-adapter/           EXT  optional expiry/revocation capability flags

src/features/
  context-resolution-runtime/ NEW  resolvers, registry, freshness, trust
                                   classification, conflict detection, ledger.
                                   Deterministic given resolver outputs.
  domain-policy-pack-runtime/ EXT  derived-value nodes, contextKey predicates,
                                   per-rule ContextRequirement declarations
  obligation-runtime/         NEW  lifecycle, discharge verification, proofs
  intelligence-advisory/      NEW  advisory producers; no port into the Kernel

src/kernel/
  contracts/ports.ts          EXT  ContextProvider (facts only, optional)
                                   AuthorityResolutionProvider (optional)
  orchestration/
    context-adapter.ts        NEW  mirrors governed-constraint-adapter.ts
    request-adapter.ts        EXT  generalized reserved-key enforcement

src/enterprise/
  context-governance/         NEW  source registry, store, operator provisioning
  obligation-governance/      NEW  obligation store + service
  access-governance/          EXT  decision-bound grant issuance
  evidence/                   EXT  context/obligation/revocation subjects

apps/
  policy-engine/              FILL policy authoring + simulation surface
  audit-console/              FILL evidence + provenance inspection surface
```

## 7. Migration strategy

The governing constraint: **existing Sovereign Access behaviour must not
change.** The repository has already done this three times — `policyPackProvider`,
`governedAuthorityProvider`, `governedConstraintProvider` are each optional
Kernel ports whose absence is documented as "behaviour identical to this layer
not existing". That pattern is the migration strategy.

1. **Every new capability is an optional port.** Omitted → byte-identical
   behaviour. Each new port carries a characterization test proving the
   unconfigured path is unchanged.
2. **No existing field changes meaning.** `ActionDescriptor.amount` continues to
   be exactly what it is today. Resolved facts arrive *alongside* it under a
   namespaced key, and a policy pack chooses which to read.
3. **The trust-level default flips per deployment, not globally.** A new
   configuration posture — `context.assertedFactPolicy: 'permit' | 'report' |
   'require-declaration'` — defaults to `permit` (today's behaviour). `report`
   is the load-bearing middle step, not an optional nicety: asserted facts still
   decide, and every rule that turned on one is named in the decision trace and
   in evidence, so an operator gets a list of what would break before anything
   breaks. R2's mitigation depends on it existing. The stricter posture is
   opt-in, then default in a later major, then the only option.
4. **No store schema is rewritten.** New stores are new. Existing schema
   identifiers are untouched, so every durability and portability drill passes
   unchanged.
5. **The frozen v1 HTTP surface is untouched.** New capability arrives on new
   paths, and `check-api-freeze` stays green.
6. **Each phase ends green.** `npm run validate:v1-release` — typecheck, build,
   three lints, full suite, protocol consumption/contract/compat/canonicalization,
   runtime state/persistence/federation/vault, boundaries, release integrity,
   clean-room consumer, publishability, API freeze, manifest, docs, SDK surface,
   portability smoke — before the next phase starts.

## 8. Implementation sequence

Each phase is independently shippable and independently reversible.

| # | Phase | Deliverable | Gate |
| --- | --- | --- | --- |
| 0 | Architecture | this document + four ADRs | suite green (done) |
| 1 | Layer boundary tests | structural tests asserting the §4 invariants over today's code | new tests pass against unchanged source |
| 2 | `@aoc-enterprise/context-contracts` | pure data + validation + serialization, no wiring | package contract suite |
| 3 | Context Resolution Runtime | registry, resolvers, freshness, conflict, trust classification | determinism + fail-closed suites |
| 4 | `ContextProvider` Kernel port | optional, facts-only, mirrors the constraint adapter | characterization: unconfigured ≡ today |
| 5 | Reserved-key generalization | requester-asserted keys cannot occupy resolved namespaces | measured self-assertion attack suite |
| 5a | **Applicability context requirements** | pack scope selection matches resolved facts, not asserted fields; an unresolvable declared scope key makes a pack applicable | attack suite: a forged `jurisdiction` no longer escapes a restrictive pack |
| 5b | **Provider credential capping** | a credential's lifetime is capped at its grant's, refused when none remains | reproduces the current over-long credential first, then shows it bounded |
| 6 | Value expressions + `unevaluable` predicates | the brief's two examples become expressible end-to-end, and an unevaluable restrictive rule no longer silently not-matches | both examples as executable scenario tests; fail-closed suite |
| 7 | Obligation lifecycle | states, discharge, verification, proofs | lifecycle + fail-closed suites |
| 8 | Decision-bound grants | `issueGrant` derives bounds from a verified decision | attenuation suite; legacy path preserved behind the optional binding |
| 9 | Evidence extension | context/obligation/revocation as bundle subjects | disclosure + integrity suites |
| 10 | Authority resolution record | one record the four engines contribute to | no behaviour change; new record only |
| 11 | Intelligence layer | advisory contracts + producers, structurally non-decisional | boundary test: no import path from advisory into kernel |
| 12 | Operator surfaces | `apps/policy-engine`, `apps/audit-console` | UI is read/author only; never a decision path |

Phases 1–6 deliver the product thesis. Phases 7–12 complete the lifecycle.

**Phases 5a and 5b are separable and should not wait.** Both describe defects in
code that ships today — an applicability escape via an asserted `jurisdiction`,
and a provider credential that can outlive its grant — rather than gaps in a
proposed design. Neither depends on the context layer landing first, and both
are worth fixing whether or not the rest of this architecture is adopted.

## 9. Architectural risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Context resolution adds network I/O to a synchronous decision path and turns availability of an ERP into availability of authorization | **high** | resolve only declared keys; per-source timeout and circuit breaker; `unresolved` is a first-class value policy reacts to; cache with explicit freshness bounds; never a default value |
| R2 | Flipping the asserted-fact default breaks every existing deployment | **high** | per-deployment posture flag defaulting to today's behaviour; a report mode that names which rules read asserted facts before anything is enforced |
| R3 | Derived values grow into an expression language and then into `eval` | **high** | closed algebra, total functions, no parser, no dynamic code — pinned by a lint rule and a test, same as the existing `no explicit any` rule |
| R4 | AI leaks into the decision path through a "helpful" integration | **high** | advisory types carry no decision shape; no import path from advisory modules into `src/kernel` or `src/features/action-enforcement`; enforced by a boundary test, not a review convention |
| R5 | Stale context produces a confidently wrong allow | **high** | every fact carries `observedAt` and `staleAt`; `stale` is distinct from `resolved`; policy declares its own tolerance |
| R6 | Two sources disagree (ERP says approved, CRM says suspended) | medium | `conflicted` is a first-class resolution state and never silently resolves to one side |
| R7 | Seven layers become seven deployment units and operational cost explodes | medium | layers are boundaries, not processes; the single-process composition root is preserved |
| R8 | Obligation lifecycle becomes a workflow engine | medium | closed state set, no branching, no scheduling, no assignment routing — discharge is recorded, never orchestrated |
| R9 | Context facts leak sensitive business data into evidence bundles | medium | facts enter the existing disclosure-policy machinery; default disclosure for a context fact is its key and provenance, never its value |
| R10 | Scope drift — the platform starts reimplementing IAM | medium | the §1 thesis tests; any feature that authenticates a user or stores a target system's permissions is rejected at review |
| R11 | The four authority engines diverge once a fifth record cites them | low | `AuthorityResolution` is a projection, not a source of truth; it is derived per evaluation, never persisted as an authority |
| R12 | Context is resolved for rules but not for pack applicability, leaving the escape open in the one place nobody looks | **high** | phase 5a; applicability requirements are declared on the pack scope and an unresolvable declared key makes a pack applicable, never inapplicable |
| R13 | A resolver answers about the wrong subject and provenance cannot tell | **high** | every fact carries a `subject` bound to the evaluated request or resource; an unbound subject does not resolve |
| R14 | A provider credential outlives the grant that authorized it | **high** | cap at `min(requested, grant.expiresAt − now)`, reject a provider expiry beyond the grant, refuse when no positive lifetime remains |
| R15 | A `continuing` or `post_action` obligation is treated as a pre-grant blocker and deadlocks the grant | medium | `timing` is a required closed field; only `precondition` obligations gate issuance |
| R16 | The two stores drift and a grant cites a decision state that no longer holds | medium | governance records are append-only and immutable, and the grant pins the decision's digests at issue |

## 10. What this architecture deliberately does not do

- No IAM, no authentication, no session management, no password or key custody
  for target systems.
- No replacement of any target system's RBAC.
- No workflow engine, no approval routing, no notification delivery.
- No expression language, no rules DSL, no user-supplied code execution.
- No AI in the decision path, in any form, under any configuration.
- No chain dependency. Ledgers remain optional attestation/export backends
  behind the provider adapter contract, exactly as `repo-boundaries.md` already
  requires.
- No Protocol change. Everything here is Enterprise-owned.
