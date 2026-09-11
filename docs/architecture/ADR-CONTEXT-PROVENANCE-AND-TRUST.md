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

### 1. Facts used in decisions carry their origin

Introduce `ContextFact` as the unit policy reads:

```
key            'vendor.status'
value          'approved'
sourceId       'ctx.src.erp.sap-prod'
observedAt     ISO-8601
freshness      { maxAgeSeconds, staleAt }
trustClass     'attested' | 'authoritative' | 'derived' | 'asserted'
attestationRef opaque, present only when trustClass === 'attested'
resolution     'resolved' | 'unresolved' | 'stale' | 'conflicted'
```

A value without an origin is not a fact. There is no shape in this layer that
carries a value alone.

### 2. Four trust classes, and one rule about the fourth

| class | meaning |
| --- | --- |
| `attested` | signed by an issuer this deployment trusts; signature verified here |
| `authoritative` | read by Frontera directly from a configured system of record |
| `derived` | computed by Frontera from other facts; **inherits the lowest class it derives from** |
| `asserted` | supplied by the requester |

**A policy rule may not turn on an `asserted` fact unless the policy pack
explicitly declares that key as assertable.** That declaration is a visible,
reviewable, versioned part of the pack, and it appears in evidence.

The inheritance rule for `derived` is not decoration: a spend aggregate computed
from one authoritative ledger read and one asserted line item is asserted. Any
other rule launders trust.

### 3. Context sources are configured by the operator, never named by the requester

`ContextSource` is a declared, configured, named origin — kinds `request`,
`internal_store`, `erp`, `crm`, `external_api`, `ledger`, `identity_provider`,
`approval_system`, `risk_engine`, `signed_attestation`. A request may not
introduce a source, select which source answers a key, or influence a source's
trust class. Source configuration is trusted-operator provisioning, in the same
posture as `KernelAuthorityProvisioningService`.

### 4. Policy declares what it needs; the platform resolves exactly that

A rule carries a `ContextRequirement` set: which keys, at what minimum trust
class, within what freshness. The Kernel resolves exactly the declared keys
before evaluation begins, and nothing else. No speculative resolution, no
"fetch everything about the vendor".

This keeps the blast radius of an external dependency proportional to the rules
that actually depend on it, and it makes the dependency visible in the pack
rather than discovered in an outage.

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

The one thing the platform *does* guarantee: a rule that requires trust class
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

1. A `ContextFact` without a `sourceId` and an `observedAt` is invalid.
2. A `derived` fact's trust class is the minimum of its operands'.
3. A requester cannot write, select, or influence a source or a trust class.
4. A resolver cannot allow, deny or narrow. Its return type has no such shape.
5. `unresolved` never becomes a default value, at any layer.
6. Resolution failure of an *optional* fact never denies by itself; policy
   decides. Resolution failure of a *required* fact denies **because the rule
   said required**, not because the resolver decided.

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
| Default `asserted` facts to non-matching immediately | breaks every existing deployment on upgrade; `report` posture exists precisely to avoid this |
| Put resolved facts in the same bag as requester context | the forgery surface is the entire point; namespace separation plus a strip is what makes the guarantee mechanical |
