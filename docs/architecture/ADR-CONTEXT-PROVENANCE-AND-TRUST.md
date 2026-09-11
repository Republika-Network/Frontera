# ADR: Context provenance and trust — the requester may not supply the facts that decide

- Status: accepted (architecture only — **no implementation performed**)
- Related: `ADR-AUTHORITY-CONTROL-LAYERING.md`,
  `ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §6 (the port this generalizes),
  `ADR-POLICY-OBLIGATION.md`, `ADR-EVIDENCE-BUNDLE.md`,
  `ADR-ACCESS-DECISION.md`
- Scope: `packages/context-contracts` (new), `src/features/context-resolution-runtime`
  (new), `src/features/domain-policy-pack-runtime`, `src/kernel/`,
  `src/enterprise/context-governance` (new)
- **A trust-boundary decision.** Not a data-integration framework. Not an ETL
  layer. Not a caching tier. Not a rules engine. No Protocol change.

## Context: the measured defect

`src/kernel/orchestration/request-adapter.ts` already contains the correct
statement of the problem, written for two field names:

> `organizationId`/`organizationName` are reserved: they are derived from the
> typed `organization` field and from nowhere else. A caller-supplied value of
> either name is dropped rather than passed through. […] A provider that scopes
> decisions by organization — the durable Kernel Authority one does — would
> otherwise be reading a claim the requester wrote about itself, which is
> exactly the self-assertion the governance boundary exists to prevent.

That defence covers exactly two keys. Measured against the rest of the request
shape, the same exposure is open everywhere else.

`ActionDescriptor` carries `amount`, `currency`, `counterpartyId`, `customerId`,
`jurisdiction`, `country`, `industry`, `domain`, `dataDomains` and `evidenceIds`.
Each is copied verbatim from the HTTP body into `EnforcementPolicyEvaluationInput`
and from there into `PolicyEvaluationInput`, where `PolicyConditionEvaluator`
reads it as fact. Traced end to end:

```
POST /api/governance/evaluate  { action: { amount: 9999 } }
  → toKernelEvaluationRequest       (verbatim)
  → buildPolicyEvaluationInput      (verbatim)
  → PolicyPackEnforcementService.buildEvaluationInput   (verbatim)
  → createActionEnforcementPolicyPackIntegration        (verbatim)
  → PolicyConditionEvaluator: amount less_than_or_equal 10000 → matched
```

A rule reading `amount <= 10000` therefore decides on a number the caller chose.
For an in-process, already-trusted caller that is defensible. For the stated
product thesis — governing authority **across a system boundary** — the boundary
is precisely where the caller's claim stops being evidence.

One channel already does the right thing. `GovernedConstraintProvider` is
resolved by the Kernel, from a store, *before* the synchronous engine runs, and
its output is injected under the namespaced key `aoc.governedConstraints`. A
failure reports `resolved: false` rather than an empty set, so a policy can tell
"none stand" from "none were read". It carries facts and no verdict, and it
cannot deny. It is the right shape; it exists for exactly one kind of fact.

## Decision

### 1. Facts used in decisions carry their origin *and their subject*

`ContextFact` is a discriminated union on `resolution`, so a shape that has no
value cannot pretend to have one and a conflict cannot be flattened to a winner:

```
ContextFact =
  { key, subject, requirementId, resolution: 'resolved',
    value, sourceId, observedAt, freshness, trust }
| { key, subject, requirementId, resolution: 'stale',
    value, sourceId, observedAt, freshness, trust }
| { key, subject, requirementId, resolution: 'unresolved',
    attemptedSourceIds, attemptedAt, failureCode }
| { key, subject, requirementId, resolution: 'conflicted',
    candidates: [ { value, sourceId, observedAt, trust }, … ] }
```

`unresolved` carries no `value` and no single `sourceId` — the earlier draft's
flat shape required one of both, which would have forced an implementation to
invent a default for a lookup that did not answer, contradicting invariant 5.
`conflicted` retains **every** candidate rather than picking one, because
discarding the losing source is the same defect one layer over: a policy that
cannot see both answers cannot reason about the disagreement.

**`subject` is load-bearing and is not optional.** A fact is about something:

```
subject   { type: 'vendor' | 'invoice' | 'resource' | 'actor' | …,
            id, derivedFrom }
```

`derivedFrom` names where that identity came from — the evaluated request's
`target`, a resolved authority, or another fact — and a resolver may only be
asked about a subject the evaluated action actually engages.

Without this, provenance proves only *where a value came from*, never *that it
describes the right entity*. An authoritative ERP read of `vendor.status =
approved` is worthless if the governed action concerns a different, suspended
vendor, and nothing in a key/value/source triple can detect the substitution. A
fact whose `subject` is not bound to the evaluated request or resource does not
resolve.

A value without an origin is not a fact; a fact without a subject is not
evidence. There is no shape in this layer that carries a value alone.

### 2. Trust is a level; derivation is provenance. They are separate fields.

An earlier draft made `derived` a fourth member of the trust enum, which forced
it to be two incompatible things at once — a class in its own right, and a
placeholder for whatever class it inherited. A fact derived from an
authoritative read and an asserted line item then had to be recorded as
`asserted`, losing the fact that it was derived at all, and
`ContextRequirement`'s "minimum trust class" had no defined position for
`derived` in the ordering. Both problems disappear once the two ideas are
separated.

**`trust.level` — a totally ordered enum:**

```
attested (3) > authoritative (2) > asserted (1) > none (0)
```

| level | meaning |
| --- | --- |
| `attested` | signed by an issuer this deployment trusts; signature verified here |
| `authoritative` | read by Frontera directly from a configured system of record |
| `asserted` | supplied by the requester |
| `none` | no trustworthy origin established |

The ordering is explicit and total, so `ContextRequirement.minimumTrust` is a
simple `>=` comparison with no implementation-dependent behaviour.

**`trust.derivation` — provenance, orthogonal to level:**

```
{ kind: 'direct' }
{ kind: 'derived', operandFactIds: [...], operator: 'sum' | … }
```

**The composition rule:** a derived fact's `trust.level` is the **minimum** of
its operands' levels; its `trust.derivation` records that it was derived and
from which operand facts. So a spend aggregate computed from one authoritative
ledger read and one asserted line item has `level: 'asserted'` — it cannot
launder trust — **and** still carries `derivation.kind: 'derived'` with both
operand ids, so an auditor sees exactly which operand dragged the level down.

**A policy rule may not turn on a fact whose `trust.level` is `asserted` or
`none` unless the policy pack explicitly declares that key as assertable.** That
declaration is a visible, reviewable, versioned part of the pack, and it appears
in evidence.

### 3. Context sources are configured by the operator, never named by the requester

`ContextSource` is a declared, configured, named origin — kinds `request`,
`internal_store`, `erp`, `crm`, `external_api`, `ledger`, `identity_provider`,
`approval_system`, `risk_engine`, `signed_attestation`. A request may not
introduce a source, select which source answers a key, or influence a source's
trust level. Source configuration is trusted-operator provisioning, in the same
posture as `KernelAuthorityProvisioningService`.

### 4. Policy declares what it needs; the platform resolves exactly that

A rule carries a `ContextRequirement` set: which keys, about which subject, at
what minimum trust level, within what freshness. The Kernel resolves exactly the
declared keys before evaluation begins, and nothing else. No speculative
resolution, no "fetch everything about the vendor".

This keeps the blast radius of an external dependency proportional to the rules
that actually depend on it, and it makes the dependency visible in the pack
rather than discovered in an outage.

### 4a. Applicability is resolved too — per-rule requirements alone are a hole

Per-rule requirements protect rule *evaluation*. They do not protect pack
*selection*, and pack selection happens first.

`PolicyPackApplicabilityService.findScopeMismatch` filters candidate packs on
`trustDomainId`, `jurisdiction`, `country`, `industry`, `customerId`, `domain`,
`action`, `capability`, `resourceScope`, `actorType` and `dataDomains` — and six
of those are requester-asserted `ActionDescriptor` fields. A pack whose scope is
`jurisdictions: ['CR']` is filtered out for a request that claims
`jurisdiction: 'XX'`. Its rules never run, so no `ContextRequirement` of its is
ever consulted; with no other pack matching, `PolicyPackEvaluationService`
returns `NO_APPLICABLE_POLICY_PACK` → `not_applicable`, which is in
`NON_BLOCKING_DECISION_TYPES`.

**A boundary caller can therefore escape a restrictive pack entirely by naming a
jurisdiction it is not in.** This is a live property of the current code, not a
hypothetical of the proposed design, and it is the sharpest single instance of
the defect this ADR exists to fix.

The fix has three parts:

1. **A pack declares scope-level context requirements**, in the same form a rule
   does: the keys its own scope selection turns on, and the minimum trust level
   each must meet. `jurisdictions: ['CR']` becomes a scope that requires
   `jurisdiction` at `authoritative` or better.
2. **Those keys are resolved before applicability runs**, and applicability
   matches against the resolved fact, never the `ActionDescriptor` field.
3. **A scope key that is declared but does not resolve at the required level
   makes the pack applicable, not inapplicable.** This is deliberately the
   opposite of the intuitive direction: an unverifiable claim must not be able
   to *remove* governance. The pack then evaluates its rules, which apply their
   own requirements — so an unresolvable jurisdiction lands in the rules'
   declared handling rather than in a silent exit.

A pack that declares no scope-level requirements behaves exactly as it does
today, which is what keeps this additive.

**`not_applicable` remains non-blocking, and that is correct** — a pack that
genuinely does not govern an action should not block it. What changes is that a
requester can no longer manufacture inapplicability.

### 5. Unresolved is a value, not an absence, and never a default

A resolver that cannot answer reports `unresolved`. It does not report absence,
and it never substitutes a default. `stale` and `conflicted` are likewise
distinct, first-class resolutions — two sources disagreeing is a fact about the
world, not a tie to be broken silently.

**Frontera ships no rule about what an unresolved fact means.** A policy pack
decides: deny, require approval, fall back to a lower-trust source, or proceed.
This mirrors the position `ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §7 already
took — "Soberanía ships no rule connecting collateral to transfer" — and for the
same reason: the platform must not invent the deployment's business judgement,
and must not hide the fact the judgement needs.

The one thing the platform *does* guarantee: a rule that requires trust level
`authoritative` for a key that resolved `asserted` does not match, and cannot be
made to match by any configuration short of the pack declaring otherwise.

### 6. The reserved-namespace rule generalizes

Resolved facts reach policy under a namespace the requester cannot write to.
Requester-supplied context is stripped of any key in that namespace before it
travels, the same `delete` `request-adapter.ts` already performs for
`organizationId` — generalized from two names to a namespace, and pinned by a
test that submits a forged fact and asserts it never reaches evaluation.

### 7. Migration posture: report before enforce

`context.assertedFactPolicy` has three values:

- `permit` (default) — today's behaviour exactly; asserted facts decide
- `report` — asserted facts still decide, and every rule that turned on one is
  named in the decision trace and in evidence
- `require-declaration` — a rule turning on an undeclared asserted fact does not
  match

A deployment moves `permit → report → require-declaration` on its own schedule.
`report` exists because no operator should discover their exposure by taking an
outage; it turns the migration into a list.

### 8. Context is an evidence subject, with values redacted by default

Which facts were resolved, from which sources, at what time, at what trust
class, and with what resolution status — all of it enters the existing evidence
machinery. The **default disclosure for a fact's `value` is hidden**: an auditor
needs to know the decision turned on an authoritative ERP read of
`vendor.status` at 14:02, not necessarily what the status was. Deployments raise
disclosure per field through the existing `DisclosurePolicy`.

## Hard invariants

1. A `resolved` or `stale` `ContextFact` without a `sourceId` and an
   `observedAt` is invalid. `unresolved` carries neither and must not
   fabricate either.
2. Every `ContextFact` carries a `subject` bound to the evaluated request or
   resource. An unbound subject does not resolve.
3. A derived fact's `trust.level` is the minimum of its operands' levels, and
   its `trust.derivation` retains every operand id.
4. `trust.level` is totally ordered (`attested > authoritative > asserted >
   none`), so `minimumTrust` is a `>=` comparison with no undefined cases.
5. A requester cannot write, select, or influence a source, a subject binding,
   or a trust level.
6. A resolver cannot allow, deny or narrow. Its return type has no such shape.
7. `unresolved` never becomes a default value, at any layer, and `conflicted`
   never silently collapses to one candidate.
8. Resolution failure of an *optional* fact never denies by itself; policy
   decides. Resolution failure of a *required* fact denies **because the rule
   said required**, not because the resolver decided.
9. A declared scope-level context requirement that does not resolve at its
   required level makes a pack **applicable**, never inapplicable.

## Consequences

**Gained.** The product thesis becomes true rather than aspirational: the
boundary-crossing caller can state what it wants, never what makes it allowed.
An auditor can distinguish a fact from a claim. The `organizationId` defence
stops being a two-key special case.

**Not gained, deliberately.** No data integration framework, no connector
catalogue, no ETL, no sync, no schema mapping engine. Frontera reads the specific
facts a rule declares, at decision time, and keeps nothing it was not asked for.

**Costs.** Decision latency becomes partly a function of external systems (R1 in
the target architecture; mitigated by declared-keys-only resolution, per-source
timeouts, circuit breaking and explicit freshness). A new store for source
configuration. A migration posture that every deployment must eventually walk.

## Alternatives rejected

| alternative | why not |
| --- | --- |
| Trust the caller; secure the channel instead | mTLS proves *who* is calling, never that the amount they typed is the invoice's amount. Authentication is not provenance |
| Sign the whole request at the edge | proves the request was not tampered *in transit*; the originating system still authored the claim about itself |
| Resolve everything about every entity in the request | unbounded blast radius, unbounded latency, and it leaks business data into decisions that never needed it |
| One boolean `trusted: true/false` per fact | cannot distinguish a verified attestation from a direct read from a computed aggregate, and gives the wrong answer the first time one is derived from the other |
| Let context resolvers return a recommended decision | an ERP outage would become an authorization outcome decided by the ERP; violates the facts-only layer law |
| A flat `ContextFact` with `resolution` as a sibling field | forces `unresolved` to carry a value and a source it does not have, and forces `conflicted` to discard every candidate but one — both contradict this ADR's own invariants |
| `derived` as a fourth trust class | it is two things at once (a class, and a stand-in for an inherited class), leaves `minimumTrust` undefined for it, and loses the derivation once the level is rewritten to the operand minimum |
| A fact identified by key and source alone, with no subject | proves where a value came from, never that it describes the entity the action concerns; vendor A's action decided on vendor B's status is undetectable |
| Per-rule context requirements only, leaving applicability on asserted fields | a caller escapes a restrictive pack by claiming a jurisdiction it is not in; the pack's rules never run, so its requirements never apply |
| Make an unresolvable scope key render a pack **inapplicable** | an unverifiable claim would then remove governance, which is the escape inverted rather than closed |
| Default `asserted` facts to non-matching immediately | breaks every existing deployment on upgrade; `report` posture exists precisely to avoid this |
| Put resolved facts in the same bag as requester context | the forgery surface is the entire point; namespace separation plus a strip is what makes the guarantee mechanical |
