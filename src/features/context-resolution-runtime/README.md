# Context Resolution Runtime

Layer **C** of `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.

> **What is true right now, and who says so?**

That is the only question this module answers. It produces facts with
provenance and a trust classification. It produces no verdict, and it cannot be
made to: nothing exported from here carries an allow, a deny, a narrowing, a
severity or a risk level, and `tests/context-layer-boundaries.test.ts` fails the
build if one ever appears.

## The defect this closes

`docs/architecture/CURRENT_STATE_AUTHORITY_CONTROL.md` §5 records GAP-1 as the
highest-severity finding in the repository, and traces it end to end:

```
POST /api/governance/evaluate  { action: { amount: 9999 } }
  → toKernelEvaluationRequest       (verbatim)
  → buildPolicyEvaluationInput      (verbatim)
  → PolicyPackEnforcementService    (verbatim)
  → PolicyConditionEvaluator: amount less_than_or_equal 10000 → matched
```

A rule reading `amount <= 10000` decides on a number the caller chose. For an
in-process, already-trusted caller that is defensible; for governing authority
*across a system boundary* it is not, because the boundary is exactly where the
caller's claim stops being evidence.

The repository had already identified this and already solved it correctly —
for two field names. `request-adapter.ts` deletes a caller-supplied
`organizationId`/`organizationName` and re-derives both from the typed
`organization` field, with a comment naming the general principle. This module
is that principle generalized, plus the machinery that makes a resolved fact
distinguishable from a claimed one.

## The model, in four pieces

| | |
| --- | --- |
| `ContextSource` | a declared, configured, named origin. Operator-provisioned. A request may not introduce one, select which one answers a key, or influence its trust class. |
| `ContextFact` | one value *with* its origin, observation time, freshness and trust class. There is no shape in this layer that carries a value alone. |
| `ContextRequirement` | which key, at what minimum trust class, within what freshness, and whether this deployment will proceed without it. |
| `ContextResolution` | everything resolved for one request: facts, plus the keys that came back `unresolved`, `stale` or `conflicted`. |

### Trust

```
attested        signed by an issuer this deployment trusts; signature verified here
authoritative   read by Frontera directly from a configured system of record
derived         computed by Frontera from other facts
asserted        supplied by the requester
```

`derived` is not a rank. A derived fact's *effective* class is the minimum of
its operands' — one asserted operand makes the whole aggregate asserted. Any
other rule launders trust, which is why the type system separates
`TerminalContextTrustClass` (the three comparable classes) from
`ContextTrustClass` (all four) and makes a requirement expressible only against
the former.

**The one unconditional guarantee:** a requirement for `authoritative` is never
satisfied by an `asserted` fact. No posture, source configuration or declaration
relaxes it.

### Where a trust class comes from

From the configured source, and from nowhere else. `ContextFactObservation` —
what a resolver returns — has **no** `trustClass` field and no way to acquire
one through the port. A resolver reports what it read and where; the registry
decides what that is worth. An observation citing an unregistered source is
discarded and the key resolves `unresolved`, because an unknown origin is not a
low-trust origin, it is no origin at all.

### Unresolved is a value, never an absence

A resolver that cannot answer reports `unresolved`. It never reports absence and
never substitutes a default. `stale` and `conflicted` are separately first-class:
two sources disagreeing is a fact about the world, not a tie to be broken
silently, so both readings survive and neither is chosen.

Frontera ships **no rule** about what any of that means. A deployment decides,
through its own policy pack or through a `required: true` declaration.

## Migration posture

`ContextDeclaration.assertedFactPolicy` moves `permit → report →
require-declaration` on each deployment's own schedule:

- **`permit`** (default) — today's behaviour exactly.
- **`report`** — asserted facts still decide, and every requirement that turned
  on one is named on the decision. The migration becomes a list before it
  becomes an outage.
- **`require-declaration`** — an asserted fact satisfies a requirement only for
  a key the deployment has reviewed and declared assertable.

## Derived values

A closed, total algebra of seven operators — `sum`, `difference`, `product`,
`quotient`, `min`, `max`, `count` — over facts and nothing else. No parser, no
expression string, no `eval`, no `new Function`, no user-supplied code. Division
by zero, a type mismatch, wrong arity and a non-finite result each resolve to
`unresolved`, never to a substituted value. A derivation is declared
configuration, not something a requester or a policy author writes as text.

## How the Kernel uses it

An optional port, in exactly the sense `policyPackProvider`,
`governedAuthorityProvider` and `governedConstraintProvider` are optional:

```
AocKernel.evaluate()
  ├─ resolveGovernedConstraintContext()   ← facts only
  ├─ resolveKernelContext()               ← facts only, this module
  ├─ AocGuard.preflight()                 ← resolved facts reach policy under `aoc.context`
  ├─ applyGovernedAuthorityStep()         ← narrows only
  └─ applyContextStep()                   ← narrows only
```

Omitted, or configured with an empty declaration, Kernel behaviour is
byte-identical to this layer not existing: no resolution runs, no metadata key
appears, no field is added to the result, and the Governance Record is
unchanged. `src/kernel/__tests__/characterization/context-capability-absent.test.ts`
pins that.

Present, it can only narrow. A requirement the *deployment* marked
`required: true` and that did not resolve turns a viable outcome into a denial;
nothing here can make anything allowed that was not already allowed. The test
that settles whether this layer decides anything is in
`src/kernel/__tests__/kernel-context-resolution.test.ts`: remove the
`required: true` and the identical facts change no outcome anywhere.

## The security boundary

Resolved facts reach policy under `aoc.context`, a namespace with exactly one
producer — `buildPolicyMetadata` in `request-adapter.ts`, which reads resolved
values and never the request. Every other field of the policy input is copied
from a typed `ActionDescriptor` field, so no request body contributes a key to
that object at all.

On the requester-facing side, every key in the caller's free-form context bag
that is `aoc.context` or sits under it is dropped before the bag travels
anywhere — whether or not a capability is configured, and generalizing the
two-name `organizationId` defence to a namespace. The attacks are written from
the attacker's side in `src/kernel/__tests__/kernel-context-self-assertion.test.ts`.

## What this phase deliberately does not do

- **No evidence extension.** `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §8 puts
  context as an evidence subject at phase 9. Provenance travels on the decision
  and is canonicalized with it; no bundle field, disclosure-policy entry or
  store schema changes. Fact *values* never reach the record at all —
  `ContextFactEvaluation` has no `value` field, which is ADR §8's
  "hidden by default" enforced at the type level rather than by a redaction rule
  someone has to remember.
- **No policy-language change.** `PolicyPredicateField` and
  `PolicyConditionEvaluator` are untouched, so every existing pack compiles and
  behaves identically. A pack reads resolved facts through `readContextFact`,
  the same way the governed-constraint context is read today. `contextKey`
  predicates and derived-value condition nodes are phase 6.
- **No HTTP surface change.** The frozen v1 contract is untouched and
  `check-api-freeze` stays green. The capability is *composed*, never submitted.
- **No workspace package.** The ADR proposes `packages/context-contracts`. The
  port's only consumers are the Kernel and the composition root, both inside
  `src/`, which is exactly where `RecognitionProvider` and `PolicyPackProvider`
  are typed from today. Extracting it later is a mechanical move; doing it now
  would add a bundled dependency to a frozen release artifact for no consumer
  that exists.
- **No obligations, grants, AI or connectors.** Those are later phases, and the
  import boundary above is what keeps this module from acquiring them by
  accident.
