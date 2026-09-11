# ADR: Authority-control layering — seven conceptual layers and their boundaries

- Status: accepted (architecture only — **no implementation performed**)
- Related: `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`,
  `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`,
  `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md`,
  `ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`, `ADR-ACCESS-DECISION.md`,
  `ADR-ACCESS-LIFECYCLE.md`, `ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md`
- Scope: `src/kernel/`, `src/features/`, `src/enterprise/`, `packages/*`
- **A naming and boundary decision.** Not a refactor. Not a new engine. Not a
  new decision producer. No Protocol change. No store schema change. No HTTP
  surface change.

## Context

Frontera's product thesis has been restated: it governs **under what authority**
an action may be exercised across a system boundary, and it explicitly does not
replace a target system's IAM, RBAC, authentication or signing.

The measurement in `CURRENT_STATE_AUTHORITY_CONTROL.md` found that most of that
platform already exists and works — one decision producer, a fixed-precedence
policy chain, four deterministic authority engines, provider-neutral lifecycle
contracts, canonical-JSON evidence with digests, 5666 passing tests. What does
not exist is a **vocabulary**: the code is organized by module lineage
(`features/`, `enterprise/`, `packages/`) rather than by the concern each part
serves, so questions like "may this component decide?" or "may this component
read a business system?" have no structural answer, only a convention and a
careful reviewer.

Two concrete costs were measured:

1. `GovernedConstraintProvider` had to explain, in a 20-line doc comment on an
   options field, that it "produces facts and no verdict" — because there was no
   layer name that would have said it.
2. `request-adapter.ts` defends exactly two keys (`organizationId`,
   `organizationName`) against requester self-assertion, with a comment naming
   the general principle. The principle had nowhere to live, so it was applied
   twice and nowhere else.

## Decision

Adopt seven named layers as the architecture's primary vocabulary.

| | Layer | Answers | Produces |
| --- | --- | --- | --- |
| A | Authority | under whose authority? | an authority resolution |
| B | Policy | what do the rules conclude? | a policy conclusion |
| C | Context | what is true, and who says so? | facts, with provenance |
| D | Obligations | what must happen first? | obligation state + discharge |
| E | Grants | what bounded permission results? | grants, revocations |
| F | Evidence | can this be proven later? | records, bundles, exports |
| G | Intelligence | what should a human understand? | advisories |

### 1. Layers are boundaries, not processes or directories

A layer is a *contract about what a component may do*, enforced by types and
by structural tests. It is emphatically not a deployment unit: the single-process
composition root stays. It is also not a directory rename — existing modules keep
their paths and are *classified* into layers, so no import changes and no test
moves.

Rejected: a physical `src/layers/a-authority/...` reorganization. It would move
roughly 117 000 lines, invalidate every import-boundary lint, break the frozen
public surface fingerprint, and buy nothing a classification plus a test does not.

### 2. The dependency rule is one-directional and testable

```
G reads A B C D E F      G writes advisories only
F reads A B C D E        F writes records only
E reads A B D            E writes grants and revocations
D reads B                D writes discharge records
B reads A C              B writes nothing
C reads external systems C writes nothing
A reads identity/lineage A writes nothing
```

C never imports B. B never imports E. F never imports G. These become structural
tests in the same family as the existing `structural-boundaries.test.ts`, run by
`npm test`, not review conventions.

### 3. Facts-only layers are structurally incapable of deciding

C and G return types carry no allow, no deny, no narrow, no severity that maps
onto a decision. This is a type-level property, not a documented promise. The
precedent is already in the tree and already correct:
`GovernedConstraintProvider` returns a constraint summary and a `resolved`
boolean, and the Kernel's constraint adapter cannot turn it into an outcome.

Rejected: letting C return a "recommended decision" for efficiency. The moment a
context source can recommend, an ERP outage becomes an authorization outcome
decided by an ERP.

### 4. The Kernel remains the only decision producer

Unchanged. A, B, C, D contribute; `AocKernel` concludes. The seven-layer naming
does not introduce a second place where a decision is formed, and
`assertKernelInvariants` plus the characterization suite continue to be what
proves it.

### 5. Narrowing-only, attenuation-only, fail-closed — restated as layer law

Three rules already enforced in specific places become general:

- **Narrowing only.** No optional port may widen an outcome. Enforced today for
  the governed-authority step; every new port inherits it.
- **Attenuation only.** A grant ⊆ the decision that authorized it, exactly as a
  `DelegationGrant` ⊆ its source in Authority Graph.
- **Fail closed.** Every unresolvable state has exactly one documented
  direction — denial or `indeterminate` — and that direction is stated at the
  point the state is defined.

### 6. Every new capability arrives as an optional port

Absent → behaviour identical to the layer not existing. This is not a new idea;
it is the pattern `policyPackProvider`, `governedAuthorityProvider` and
`governedConstraintProvider` each already follow, with the identical sentence in
each doc comment. Each new port carries a characterization test proving the
unconfigured path is unchanged.

## What each layer may not do

| Layer | May not |
| --- | --- |
| A | evaluate business policy, read business context, issue a grant, execute |
| B | resolve its own context, decide authority, mutate state, call a model, use `eval`/`new Function` |
| C | decide anything; return a verdict; default an unresolved fact to a value |
| D | grant anything; narrow policy's conclusion; route, schedule or notify |
| E | issue a grant broader or longer-lived than its decision |
| F | alter what it records; be required for a decision to be reached |
| G | appear anywhere in the authorization path, under any configuration |

## Consequences

**Gained.** A vocabulary that makes "may this component decide?" a structural
question. Six invariants that become tests instead of review habits. A named
home for the self-assertion principle that is currently applied to two keys. A
declared position for AI that exists before the first AI feature, rather than
after it.

**Not gained, deliberately.** No directory reorganization. No new engine. No
second decision producer. No microservice decomposition. No Protocol change.

**Costs.** Seven names to learn and to apply consistently. A classification that
must be maintained as modules are added — which is the point, not the cost.
A new family of structural tests that will initially encode today's behaviour
and later constrain it.

## Alternatives rejected

| alternative | why not |
| --- | --- |
| Leave the layering implicit | measured cost: the facts-only contract had to be re-explained per port, and the anti-self-assertion rule was applied twice and forgotten elsewhere |
| Physical directory reorganization | ~117k lines moved, every import lint invalidated, public-surface fingerprint broken, no behavioural gain |
| Five layers (fold C into B, D into E) | folding C into B is exactly the defect being fixed — policy that resolves its own context cannot be kept deterministic; folding D into E loses the "obligation blocked the grant" distinction in evidence |
| Nine layers (split Identity from Authority, Execution from Grants) | identity is consumed, never produced here, so it is not a layer Frontera owns; execution is already the adapter contract's job |
| Layers as deployment units | operational cost with no governance gain; the composition root already isolates them in-process |
