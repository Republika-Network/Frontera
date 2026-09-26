# Governed constraint applicability

How Frontera Systems decides **which persistent authority constraints affect which
governed actions, and how** — without inventing a single business or legal rule.

- Scope: `@aoc-enterprise/governed-authority`,
  `src/enterprise/authority-governance/`, `src/kernel/`
- Related: `AOC_GOVERNED_AUTHORITY.md`,
  `AOC_GOVERNED_AUTHORITY_RESERVATION.md`,
  `AOC_GOVERNED_AUTHORITY_ENCUMBRANCE.md`,
  `AOC_GOVERNED_ENCUMBRANCE_RELEASE.md`
- Decision record: `docs/architecture/ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md`

---

## 1. Why an encumbrance existing does not mean an action is denied

`GovernedAuthorityEncumbrance` records that a portion of a holder's underlying
authority stands persistently constrained after a governed action executed. Its
own contract has always been explicit about what it is *not*:

> **Not an inter-action conflict policy.** The record says a portion of the
> holder's authority is constrained; it does not by itself decide which future
> actions conflict.

That left a real question unanswered. With Alice holding 5 000 bp of an economic
interest and a 4 000 bp collateral constraint standing over it:

- may she `COLLATERALIZE` another 1 000? another 4 000?
- may she `TRANSFER` 500? 2 000? all 5 000?
- may she `TOKENIZE`? `LICENSE`? on which right?
- does the constraint have to be released first?
- does it narrow scope, block the action, or do nothing at all?

Before this layer existed each of those had an answer, but the answer was
*emergent* rather than declared: every commitment went through one
action-agnostic capacity computation, so a constraint reduced whatever asked
next, and the two actions that never consult the authority store were unaffected
by construction. Nothing could be asked which of several very different things
had happened.

**Soberanía must never infer either of these:**

```
an encumbrance exists          =>   all future actions are denied
this action is different       =>   the encumbrance does not matter
```

## 2. The five statements this layer keeps apart

```
1  a constraint exists
2  the constraint applies to THIS action
3  the constraint reduces finite capacity this action consumes
4  the constraint makes this action's transition structurally impossible
5  the deployment's business policy disallows the combination
```

1 does not imply 2. 2 does not imply 3 or 4. And 5 is not Soberanía's to assert at
all — it belongs to the deployment, is expressed through ordinary policy, and
this layer's job is to hand policy the typed facts rather than to choose the
rule.

## 3. Constraint class

`GovernedAuthorityConstraintClass` names **what finite thing a constraint
commits**, as a closed typed vocabulary. One member today:

```
collateral-commitment-capacity
    a finite quantity of the holder's authority is committed to an external
    collateral arrangement that already exists
```

### It is derived, not persisted

The class is derived from the constraint's `sourceAction` by a total function.
Nothing is stored, no column is added, no digest changes, and every Phase 5.5 and
5.6 row projects byte-identically to how it always did — **so there is nothing to
migrate.** A stored class would be a second source of truth that a restore or an
import could leave disagreeing with the record's own `sourceAction`.

The derivation is total over the only value the write path can produce:
`recordEncumbrance` already refuses any `sourceAction` not classified as
encumbering, so `'collateralize'` is the only value reachable through it.

### It is not `sourceAction` under another name

The mapping is one-to-one today and the two would still come apart the first time
one action produced more than one kind of constraint — an exclusive versus a
non-exclusive `LICENSE` is the obvious near case, and those do not interact with
future actions the same way. Keying applicability on the *class* means that
variant adds a class and a registry row, rather than an `if` inside every capacity
computation.

### Anything it cannot classify fails closed

An active, correctly-bound constraint whose class cannot be determined — from a
migration, a restore, or a writer of a version this deployment does not
understand — is reported as **invalid**, never as non-applicable, and stops the
question with `GOVERNED_AUTHORITY_CONSTRAINT_STATE_INVALID`. A constraint nobody
can classify is a constraint nobody can prove is being respected.

## 4. Action applicability profiles

Each canonical Governed Action declares a
`GovernedActionConstraintProfile` — four independent facts, deliberately not one
boolean:

| field | question |
| --- | --- |
| `producesConstraintClass` | what does executing this leave behind? |
| `consumesConstraintClasses` | which classes reduce the capacity available to it? |
| `constrainsHolderTransition` | does it change what the holder still possesses? |
| `terminalizesTargetConstraint` | is its governed effect ending one named constraint? |

An action that reaches the authority accounting layer with **no declared
profile** is refused with
`GOVERNED_AUTHORITY_CONSTRAINT_APPLICABILITY_UNDECLARED`, never assumed
unrelated. That is the enrolment rule, and it is one-way: a resource this
deployment holds no governed authority for never reaches the layer at all and
behaves exactly as it did before any of this existed, while an action that *does*
draw on governed-right capacity must have stated how it relates to constraints.

## 5. The canonical five-action matrix

Measured against the real runtimes, for the one constraint class that exists:

| action | reservation | produces | consumed by class | structural effect | policy visibility | release relationship |
| --- | --- | --- | --- | --- | --- | --- |
| `TRANSFER` | required | — | none | **yes** — remaining authority must still cover the holder's constraints | full | — |
| `COLLATERALIZE` | required | `collateral-commitment-capacity` | `collateral-commitment-capacity` | none | full | — |
| `TOKENIZE` | none | — | none | none | full | — |
| `LICENSE` | none | — | none | none | full | — |
| `RELEASE_ENCUMBRANCE` | none | — | none | none | full | terminalizes its named target |

### Two independent routes to the same number

With Alice at 5 000 bp and a 4 000 bp collateral constraint standing, both
`COLLATERALIZE` and `TRANSFER` are bounded at 1 000. That coincidence is why one
action-agnostic computation looked correct — and why the routes are kept apart:

```
COLLATERALIZE   capacity     a further commitment of the same class plus the
                             standing one must not exceed what is held
                             new + 4 000 <= 5 000

TRANSFER        structural   whatever the holder keeps must still cover the
                             constraints attached to her, which do not follow
                             the authority to a recipient
                             5 000 - moved >= 4 000
```

Merge them into one `conflicts` flag and the first action that has one property
without the other gets the wrong answer silently.

**`TRANSFER` is not bounded because "collateralized authority may not be sold".**
There is no such rule in Soberanía. A holder with a 4 000 bp constraint transfers 1 000
freely, right through this table.

### What `TOKENIZE` and `LICENSE` do *not* get

Nothing. They consume no class and perform no authority transition, so no
constraint applies to them, and Soberanía denies neither. Whether tokenizing or
licensing collateralized authority is acceptable is a deployment's question — see
§8.

An `economic-interest` constraint does not reach a `usage-right` action either.
There is deliberately **no cross-right hierarchy**: Soberanía holds no evidence that
those quantities are commensurable, and inventing the relation would be inventing
the policy.

## 6. Binding

A constraint applies only where all four dimensions match:

- **tenant** — never crossed; a constraint in one tenant reduces nothing in another
- **holder** — Alice's constraint never affects Bob, and every requester reaching
  Alice's authority draws on the same pool: a direct holder, a representative, a
  second representative, and a delegated agent all see the same constraints, and
  none of them gets a pool of its own
- **resource** — per canonical `ResourceRef`; no cross-resource assumption
- **governed right** — same right, or nothing

Constraints that are released, or not yet effective, constrain nothing.

Scope arithmetic goes through the canonical `GovernedRightsScope` algebra
throughout. There is no arithmetic on `basisPoints` or `units` anywhere in this
layer, an absent `rightsScope` is never read as 100 %, and quantities that cannot
be compared are refused rather than coerced.

## 7. What policy can never buy

Three things are decided in the Governed Authority Store's own consistency
boundary, after and independently of any policy result, and no deployment
configuration can widen them:

1. **Capacity conservation.** Applicable same-class commitments may never exceed
   what the holder holds.
2. **Structural coverage.** A transition may never leave a holder with less
   authority than the constraints standing over her.
3. **Constraint state integrity.** A corrupt or unclassifiable constraint stops
   the question.

Plus the binding rules in §6 — tenant, holder, resource and right boundaries are
not negotiable.

Policy may turn a viable action into a denial or an approval requirement. It can
never turn a structurally impossible one, or one that would overcommit finite
capacity, into an allowed one. And policy never mutates constraint state: it
cannot create, resize, move or release a constraint. Those are governed
lifecycles.

## 8. What policy *may* decide

Cross-action business compatibility, which Soberanía declines to choose. A deployment
configuring the optional `governedConstraintProvider` receives a bounded,
read-only, typed summary in its policy pack's deployment metadata bag under
`aoc.governedConstraints`:

```jsonc
{
  "resolved": true,
  "status": "unconstrained",
  "constraints": [
    {
      "constraintId": "governed-authority-encumbrance-…",
      "constraintClass": "collateral-commitment-capacity",
      "sourceAction": "collateralize",
      "governedRight": "economic-interest",
      "applicability": []          // stands over this authority; does not apply to this action
    }
  ]
}
```

- **References and typed facts only.** No scope quantities, no mandate or
  execution references, no holder, and no party — an encumbrance names no
  beneficiary and this view cannot invent one.
- **Scoped to the request.** Only constraints over the tenant, holder, resource
  and rights this request engages. A constraint belonging to another holder is
  not disclosed.
- **`applicability: []` is the interesting case.** A constraint that stands over
  exactly this authority but does not apply to this action is reported with an
  empty list rather than withheld — otherwise a deployment's most obvious rule
  ("require approval to tokenize collateralized authority") would be
  inexpressible. Soberanía declines to invent that rule; it must not also hide the fact
  the rule needs.
- **`resolved: false` is not "there are none".** It means no provider was
  configured or the state could not be read, and a policy must test it before
  drawing any conclusion from an empty list.

### Example deployment policies — **not** Soberanía defaults

These are illustrations of the mechanism. Soberanía ships none of them, and a
deployment that configures nothing gets none of them:

```
deny TRANSFER when a collateral constraint applies
require approval for TOKENIZE when a collateral constraint stands
allow everything, and rely on the hard invariants alone
```

Each is a legitimate choice for some deployment and none of them is a statement
about law, liens, security interests, foreclosure or any external registry.

## 9. Evaluation and commit-time revalidation

```
                 GovernedAuthorityPosition
                          │
                          ▼
                  Active Constraints
                          │
                          ▼
              Constraint Applicability
                      Evaluator                (pure, deterministic)
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      Capacity        Structural         Policy
       effects         effects           context
          │               │                │
          │               │                ▼
          │               │              Kernel
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                    Viable request
                          │
                          ▼
               Atomic commit revalidation      ◀── decides
```

The evaluator is a **pure function**: no store, no clock, no policy, and the same
records in any order produce an equivalent verdict.

**Applicability is resolved inside the store's own critical section**, against
the records read there — never from a verdict a caller measured earlier. That is
what closes the TOCTOU window:

- `acquireReservation` re-derives applicability and capacity inside its
  transaction (SQLite) or its await-free critical section (in-memory), so a
  constraint that appeared after a caller read `resolveAvailability` still binds
  the commitment.
- `recordEncumbrance` does the same for the producing action, in the commit
  section that also terminalizes the reservation it takes over from.
- `applyTransition` runs the structural coverage check inside the same boundary.

`resolveAvailability` remains an **explanation, never a gate**. Its answer is a
snapshot of a moment that has already passed by the time a caller acts on it.

### Concurrency

- Two competing 4 000 bp commitments against 5 000 bp: exactly one succeeds.
- A release racing an acquisition: either the acquisition sees the constraint
  active and is refused, or the release committed first and the capacity
  genuinely returns. Uncommitted release state is never observed.
- A constraint being created while another action evaluates: the second action
  never sees false unconstrained capacity, because the reservation-to-encumbrance
  handoff is one commit section.

Where policy state and authority state live in separate stores, no global
transaction is claimed. Policy sees a snapshot; the hard invariants are re-decided
in the authority boundary afterwards, which is why a stale or permissive policy
result cannot cost anything.

## 10. Reason taxonomy

Deliberately compact. Two codes were added, and both are about a question Soberanía
could not **answer** — neither is a denial of authority and neither may be
reported as one:

| code | meaning |
| --- | --- |
| `GOVERNED_AUTHORITY_CONSTRAINT_APPLICABILITY_UNDECLARED` | an action drew on governed authority without a declared profile |
| `GOVERNED_AUTHORITY_CONSTRAINT_STATE_INVALID` | an active constraint could not be classified |

Existing codes keep their meanings and their call sites:

| code | meaning |
| --- | --- |
| `GOVERNED_AUTHORITY_AVAILABILITY_INSUFFICIENT` | enough is held, too much is committed or constrained |
| `GOVERNED_AUTHORITY_ENCUMBRANCE_UNCOVERED` | a transition would strand a constraint (structural) |
| `GOVERNED_AUTHORITY_SCOPE_INCOMPATIBLE` | quantities that cannot be compared |

A capacity refusal now carries typed evidence of *why*, in references and classes
only:

```jsonc
{
  "action": "collateralize",
  "constraintApplicability": "capacity_constrained",
  "applicableConstraints": [
    {
      "constraintId": "governed-authority-encumbrance-…",
      "constraintClass": "collateral-commitment-capacity",
      "sourceAction": "collateralize",
      "applicability": ["capacity"]
    }
  ]
}
```

The identical request as a `TRANSFER` reports `"structurally_constrained"` and
`"applicability": ["structural"]` — same arithmetic, recorded as the different
fact it is. Constraints considered and dismissed are not included, and no stored
row ever reaches a caller.

## 11. What this layer deliberately does not do

- **No legal interpretation.** The matrix is deployment governance semantics.
  Soberanía creates no lien, perfects nothing, files nothing and ranks nothing.
- **No priority model.** No seniority, no first/second lien, no ordering. Multiple
  constraints have no rank.
- **No automatic resolution.** A conflict is reported, never negotiated.
- **No automatic release.** An action blocked by a constraint never triggers a
  release; release remains its own governed lifecycle with its own authority.
- **No constraint migration on transfer.** A transition that would strand a
  constraint is refused, not resolved by moving the constraint to the recipient.
  That remains deferred.
- **No rule engine.** No DSL, no expressions, no policy compiler. A narrow typed
  registry, and the deployment's existing policy machinery for everything else.
- **No sixth Governed Action**, and no `DELEGATE`.
- **No Protocol change.** Constraint applicability is Enterprise-local mutable
  governance and policy. Portable cross-deployment constraint interpretation —
  proving to a remote deployment not merely that constraint C exists but how its
  action A must read it — is a genuinely different problem and is out of scope.
