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

**Fail mode:** a rule that cannot be evaluated denies. Already true and
preserved.

### C — Context

**Question:** what is true right now about the vendor, the invoice, the spend,
the risk — and **who says so, when, and how sure are we?**

**Owns:** context sources, resolvers, resolved facts, and the provenance and
trust classification of each fact. This is the new layer that makes the product
thesis true.

**May not:** decide anything. A context resolver returns facts and a resolution
status; it has no allow, no deny, no narrow. (This is exactly the contract
`GovernedConstraintProvider` already honours.)

**Fail mode:** an unresolved fact is reported as unresolved, never as absent and
never as a default. Policy decides what an unresolved fact means; the platform
ships no default rule. A required fact that is unresolved denies **because the
policy said so**, not because C decided.

### D — Obligations

**Question:** what must happen before, during or after the action, and did it?

**Owns:** the obligation lifecycle, in six states and eight transitions, with
discharge and transition provenance. The normative definition is
`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §1; this is its summary.

```
required   ──▶ pending       required   ──▶ waived       required   ──▶ expired
pending    ──▶ discharged    pending    ──▶ waived       pending    ──▶ expired
discharged ──▶ verified                                  discharged ──▶ expired

verified · waived · expired  ──▶  no outgoing transition (terminal)
```

| state | meaning | terminal | satisfies a blocking obligation |
| --- | --- | --- | --- |
| `required` | declared as a consequence or condition of an authorization | no | **no** |
| `pending` | active, awaiting valid discharge | no | **no** |
| `discharged` | a discharge was supplied and has not been successfully verified | no | **no** |
| `verified` | the discharge was validly verified | **yes** | yes |
| `waived` | an authorized waiver validly removed the requirement | **yes** | yes |
| `expired` | the declared deadline passed before a satisfying terminal state | **yes** | **no** |

There is no state for a failed verification: a verification attempt that does
not succeed leaves the obligation `discharged` and records why.

**Owns `required`.** B *declares* that an obligation is required; D materializes
the obligation instance in state `required` and manages it from there. `required`
is a layer D lifecycle state, not a layer B declaration sitting outside the
lifecycle.

**Expiry.** An obligation may declare an optional `expiresAt`, which comes from
trusted policy or operator configuration and never from caller-controlled request
data. Against an injected clock, at read time, an obligation at or past that
deadline in `required`, `pending` or `discharged` becomes `expired`. One that
declares no deadline never expires, and expiry never disturbs `verified` or
`waived`. Obligation expiry is not discharge staleness — evidence too old to be
believed fails *verification* and the obligation stays `discharged`.

**May not:** grant anything, or narrow policy's conclusion. An unsatisfied
blocking obligation prevents grant issuance; it does not rewrite the decision.

**Fail mode:** an obligation whose discharge cannot be verified is not
`verified` — it remains `discharged`, and therefore unsatisfied. Closed.

### E — Grants

**Question:** what narrow, expiring permission does this decision actually
produce, and when does it stop?

**Owns:** bounded grant issuance derived from a *verified* decision, grant
lifecycle, expiry and revocation, and provider enforcement through the existing
adapter contract.

**May not:** issue a grant broader than the decision that authorized it, or
outlive any validity ceiling that authorized it. This is attenuation-only, the
same rule Authority Graph already enforces for delegation.

**Validity.** A grant's `expiresAt` is finite, strictly after `issuedAt`, and
**proposed by the trusted issuer at issuance time** — never derived from
deployment configuration, never defaulted, and never read from caller-controlled
request data. It is then contained by every applicable upstream ceiling **that
exists**: the decision's validity bound if the decision carries one, and the
mandate or representative authority's `expiresAt` where one governs the action.
No decision record in this repository carries a validity window today, so on the
generic Kernel path there is frequently nothing to contain against — and none is
invented. A deployment may configure a maximum grant lifetime as an **optional**
safety cap on its own issuers; its absence is not a reason to withhold a grant.
The normative statement is `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4,
"Where a grant's validity comes from".

**Scope.** "The evaluated scope" a grant attenuates is the scope of the
evaluated request and the decision taken on it, never the envelope of whichever
policy rule matched: a 7500 payment allowed by a rule reading `amount <= 10000`
yields a source ceiling of **7500**. A reusable authority envelope with a
ceiling and a window is a **mandate**, not a grant — see the same ADR §4,
"Mandate and grant are different artifacts".

**Fail mode:** a grant that cannot be bound to a verified decision is not
issued, and neither is one whose lifetime cannot be established. Closed.

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
E (Grants)        ──reads──▶  A B D                 ──writes──▶ grants, revocations
D (Obligations)   ──reads──▶  B                     ──writes──▶ obligation lifecycle state,
                                                                  discharge and transition records
B (Policy)        ──reads──▶  A C                   ──writes──▶ nothing
C (Context)       ──reads──▶  external systems      ──writes──▶ nothing
A (Authority)     ──reads──▶  identity, lineage     ──writes──▶ nothing
```

Six invariants, each intended to become a test:

1. **No upward dependency.** C never imports B. B never imports E. F never
   imports G.
2. **Only the Kernel decides.** A, B, C, D contribute; the Kernel concludes.
   Unchanged from today.
3. **Facts-only layers cannot decide.** C and G have no allow/deny in their
   return types. Structurally, not by convention.
4. **Narrowing only.** No optional port may widen an outcome. Already enforced
   for the governed-authority step; extended to every new port.
5. **Attenuation only.** A grant ⊆ its decision, in scope and in lifetime. A
   delegation ⊆ its source. A grant never outlives the authority justifying it,
   exactly as a reservation never outlives its mandate.
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

**`ContextFact`** — one resolved value with its origin:

```
{
  key            'vendor.status'
  value          'approved'
  sourceId       'ctx.src.erp.sap-prod'
  observedAt     ISO-8601
  freshness      { maxAgeSeconds, staleAt }
  trustClass     'attested' | 'authoritative' | 'derived' | 'asserted'
  attestationRef opaque id, when trustClass === 'attested'
  resolution     'resolved' | 'unresolved' | 'stale' | 'conflicted'
}
```

**`ContextTrustClass`** — the load-bearing concept:

| class | meaning | may a policy decide on it? |
| --- | --- | --- |
| `attested` | signed by an issuer the deployment trusts, verified here | yes |
| `authoritative` | read directly by Frontera from a configured system of record | yes |
| `derived` | computed by Frontera from other facts of equal or higher class | yes, inherits the lowest class it derives from |
| `asserted` | supplied by the requester | **only when the policy pack explicitly declares that this key may be asserted** |

The default for any key not declared is `asserted`, and the default for
`asserted` is that no rule may turn on it. That inverts today's posture, which
is why it must arrive behind a per-deployment switch (§7).

**`ContextRequirement`** — a policy pack declares, per rule, which keys it needs
and at what minimum trust class. The Kernel resolves exactly the declared keys
before evaluation and never speculatively.

Why this shape: it is `GovernedConstraintProvider` generalized. Same position in
the pipeline (resolved before the synchronous engine), same facts-only contract,
same explicit `resolved: false` rather than an empty set, same namespaced
delivery into policy input. The one addition is that a fact now carries who said
it.

**The self-assertion rule, stated once:** a requesting actor may state what it
wants to do. It may never state a fact that decides whether it may. The
`organizationId` reservation in `request-adapter.ts` becomes the general case
rather than a two-key special case.

### 5.2 Policy: derived values

To express `monthlyVendorSpend + amount < 50000`, `PolicyCondition` gains a
third node type alongside `group` and `predicate`:

```
{ type: 'derived', id, expression: <closed, total, typed>, operands: [...] }
```

with a closed operator set (`sum`, `difference`, `product`, `quotient`, `min`,
`max`, `count`) over operands that are themselves context facts or literals.
`monthlyVendorSpend` is then a *context fact resolved by an aggregate resolver*
(class `authoritative`, read from the spend ledger), not something the policy
engine computes by querying a database — B never reads a store.

No expression language, no parser, no `eval`. A closed algebra, total over its
operand types, with division by zero and type mismatch resolving to
`unresolved`, which policy then treats as it declared.

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
3. **The trust-class default flips per deployment, not globally.** A new
   configuration posture — `context.assertedFactPolicy: 'permit' | 'require-declaration'`
   — defaults to `permit` (today's behaviour) and is flipped by a deployment
   when it is ready. The stricter posture is opt-in, then default in a later
   major, then the only option.
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
| 6 | Policy derived values + `contextKey` | the brief's two examples become expressible end-to-end | both examples as executable scenario tests |
| 7 | Obligation lifecycle | states, discharge, verification, proofs | lifecycle + fail-closed suites |
| 8 | Decision-bound grants | `issueGrant` derives bounds from a verified decision; grant validity proposed by the trusted issuer and contained by the ceilings that exist | attenuation suite; legacy path preserved behind the optional binding |
| 9 | Evidence extension | context/obligation/revocation as bundle subjects | disclosure + integrity suites |
| 10 | Authority resolution record | one record the four engines contribute to | no behaviour change; new record only |
| 11 | Intelligence layer | advisory contracts + producers, structurally non-decisional | boundary test: no import path from advisory into kernel |
| 12 | Operator surfaces | `apps/policy-engine`, `apps/audit-console` | UI is read/author only; never a decision path |

Phases 1–6 deliver the product thesis. Phases 7–12 complete the lifecycle.

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
