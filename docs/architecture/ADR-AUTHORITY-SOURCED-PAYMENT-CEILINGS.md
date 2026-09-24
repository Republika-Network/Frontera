# ADR — Authority-Sourced Payment Ceilings and Durable Spending Limits (P10)

- **Status:** Accepted
- **Increment:** P10
- **Depends on:** `ADR-DURABLE-KERNEL-AUTHORITY.md`, `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`,
  `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7), `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9)
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-094 … SEC-INV-101

## 1. Context

Through P9, the Kernel grant adapter projected the grant's source amount ceiling from the request
itself:

```text
request says amount = 7500  →  Kernel evaluates 7500  →  grant source ceiling = 7500
```

So the ceiling an actor was authorized to spend was an echo of what it asked to spend. That is
not enough for machine payments. The Authority Graph already declared a `max_amount` constraint
(converted to canonical decimal text by P9), but nothing provisioned it, persisted it or read it.
P7's aggregate limits existed, but only as process-local host policy.

## 2. Decision

> **The amount an actor asks to spend is never the source of the amount the actor is authorized
> to spend.**

Four monetary concepts are kept apart:

| concept | example | source | role |
| --- | --- | --- | --- |
| requested amount | 25 USD | `GovernedActionIntent` | the **proposed effect**, compared against authority, never authority itself |
| policy threshold | allow when amount ≤ 10,000 | a Kernel policy rule | used to **decide**, never a ceiling |
| per-execution ceiling | ≤ 100 USD per payment | durable authority (`max_amount`) | **authority** |
| aggregate spending limit | ≤ 500 USD / rolling 24 h | durable authority (`spending_limit`) | **authority**; consumption lives in P7's ledger |

A machine payment remains an ordinary governed action. There is no payment kernel, payment grant,
payment policy engine or payment execution path:

```text
GovernedAction → Kernel → BoundedGrant → P7 → claim → ExecutionAdapter → P8
```

### 2.1 Durable authority, not a new store

Monetary authority lives in the existing **Kernel Authority Store**, on the records that already
carry authority:

```ts
ProvisionAuthorityGrantInput.constraints?:  readonly KernelAuthorityMonetaryConstraint[]
ProvisionDelegationGrantInput.constraints?: readonly KernelAuthorityMonetaryConstraint[]

type KernelAuthorityMonetaryConstraint =
  | { type: 'max_amount';     currency: string; value: string }                        // P9 canonical text
  | { type: 'spending_limit'; limitId: string; currency: string; maximum: string;
      window: { kind: 'lifetime' } | { kind: 'rolling'; seconds: number } }
```

`max_amount` is the Authority Graph's existing constraint, now activated. `spending_limit` is the
single constraint P10 adds, because no existing primitive could state an aggregate monetary budget.
Only these two kinds may be provisioned: the graph declares others that nothing enforces, and
persisting unenforced authority would make it read narrower than it behaves.

No payment-authority database was created. The three responsibilities stay separate:

```text
Kernel Authority Store       = what spending is authorized       (definitions)
P7 Exercise Control Ledger   = what authorized capacity is used  (consumption)
P8 Authority Event Stream    = evidence of what happened         (never read back as authority)
```

An authority record never carries `spent`, `remaining` or a usage count.

### 2.2 Validation

- **On every append**, by both store implementations (`append-rules.ts` →
  `monetary-constraints.ts`), whoever the caller. The shared P9 decimal runtime is used, with no
  second parser. The rules: canonical decimal text; strictly positive; a canonical asset
  identifier; exact keys (a record may not state its own `scale`, `spent` or `remaining`); a
  canonical `limitId`; a valid window (1 … 31,536,000 whole seconds); no duplicate
  `(limitId, currency)`; at most 16 constraints; only on authority and delegation grants.
- **At provisioning**, against the deployment's trusted `MonetaryAssetRegistry` when the
  provisioning service is composed with one (the Enterprise composition root always does). The
  asset must be recognized, and the value must fit its trusted scale. It is refused, never rounded.
- **On every hydration.** A malformed record fails the whole world closed
  (`KERNEL_AUTHORITY_INTEGRITY_FAILED`). It is never skipped or repaired.
- **At resolution.** Registry membership and scale are re-checked on every call, because the
  registry is configuration and can change between restarts (`FINANCIAL_AUTHORITY_MALFORMED`).

Constraints sit in the event payload. They are therefore covered by the existing event digest and
chain: widening a ceiling in the file, or deleting one, fails integrity.

### 2.3 Resolving the same authority that justified the action

`createKernelFinancialAuthorityResolver` (`src/enterprise/kernel-authority/`) answers
synchronously from the hydrated Authority Graph:

1. It resolves the chain with the Authority Graph's own deterministic rule: the rule recognition
   used.
2. At **issuance** it requires the decision's own `authority.decisionId`. It loads that decision's
   `AuthorityProof` and proves the resolved chain has exactly the proof's `evaluatedGrantIds` and
   `evaluatedDelegationIds`, in order. It never runs an independent search for "any authority of
   this actor that mentions USD". A decision with no Authority Graph proof has no lineage to take
   monetary authority from, and is unresolved. Recognition consults the Authority Graph only for
   agents and for actors acting for a principal.
3. Every hop must be `active` and unexpired at the instant asked.
4. Every monetary constraint on **every** hop applies. The effective ceiling is the narrowest
   `max_amount` in the requested asset, so a delegate can narrow but never broaden, re-denominate
   or drop an upstream bound. All `spending_limit`s in that asset accumulate.
5. It fails closed on:
   - no ceiling
   - ceilings only in other assets (incomparable; nothing is converted)
   - no aggregate limit
   - any malformed monetary constraint on the lineage
   - an organization other than the world's
   - an unparseable instant

   Missing authority is never unlimited authority.

The composition root wires the resolver only together with P7 exercise controls and governed
actions. Without P7, every financial action is withheld at issuance.

### 2.4 Grant source and issuance

`sourceScopeFor()` no longer projects an amount bound at all. The issuance core
(`issuance-core.ts`) runs these steps for a host-classified financial action whose decision is
grant-eligible:

1. Resolve the financial authority (phase `issuance`, anchored to the decision's proof).
2. Compare **requested amount ≤ authority ceiling** exactly. If the request is above the ceiling,
   issue no grant (`FINANCIAL_AUTHORITY_CEILING_EXCEEDED`), so nothing is reserved and no adapter
   is called.
3. Attach the authority ceiling with `withGrantAmountCeiling`. This mirrors
   `withGrantValidityCeiling`: Kernel projection plus authority known to the composition.
4. Record `authorityBindingDigest = grantAuthorityProvenanceDigest(binding, financialAuthority)`.

By default the grant inherits the authority ceiling (100, never the requested 25). A trusted
issuer may narrow it through `requestedBounds`, and broadening is refused.

The Kernel decision is never rewritten. An `allowed` decision with a
`financial-authority-withheld` outcome is the truthful combination. Publicly it is
`status: 'withheld', withheldBy: 'authority-binding'` carrying a `FINANCIAL_AUTHORITY_*` code. The
wire union is unchanged, and the codes are strings in the existing `reasonCodes` array.

### 2.5 Commit-boundary revalidation

Inside the grant store's synchronous commit guard, financial authority is re-resolved (phase
`commit`) from the live projection. The guard refuses unless it is **exactly** the measured
authority (`FINANCIAL_AUTHORITY_CHANGED`, or the resolver's own code, e.g. `INACTIVE`). There is no
`await`: the provisioning service commits first and then re-hydrates, so the projection is always
the store's.

### 2.6 Durable spending limits through P7

For a financial exercise, the P7 policy handed to the gate is
`financialAuthorityExercisePolicy(hostPolicy, resolver)`. The host's limits are computed first and
then **extended** with every authority limit, so no host callback can omit, replace or loosen one.
Both sets enter the gate's single validated snapshot and therefore **one** atomic `reserve()`.

A host limit that collides with an authority bucket on `(limitId, scopeKey)` makes the snapshot
refuse the whole answer (`EXERCISE_CONTROL_POLICY_INVALID`).

Bucket identity is derived from trusted authority, never from a request, decision, grant, execution
or process:

```text
limitId  = "authority:" + spending_limit.limitId
scopeKey = JSON(["aoc.kernel-authority.spending-limit.v1", organizationId, entityKind, entityId, currency])
```

That identity is stable across grants, requests, execution ids, processes and restarts. It is
isolated per authority record, per asset and per organization.

P7's lifecycle is untouched:

| outcome | P7 action |
| --- | --- |
| `executed` / `execution-unconfirmed` | settle |
| `execution-failed` / withheld after reserve | release |

There is no TTL, no sweeper and no reset. Rolling windows age out by P7's own window arithmetic.

### 2.7 Exercise-time provenance

For a financial exercise, the P7 binding-digest resolver recomputes
`grantAuthorityProvenanceDigest(binding, currentFinancialAuthority)` and compares it for exact
equality. This happens before the policy and before any reservation (revalidation #1), and again
after the reservation (#2):

| authority state | result |
| --- | --- |
| revoked, expired or re-lineaged | `EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE` |
| any monetary or lineage difference | `EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED` |
| a replacement authority with identical terms | withholds too: lineage identity is in the digest |

**Backward compatibility:**

- A non-financial grant's digest is byte-identical to its pre-P10 binding digest. Nothing about it
  moves.
- A financial grant issued before P10 carries a binding-only digest. It can never match, and is
  withheld until it expires. No digest is fabricated for it and no record is rewritten.

### 2.8 Caller isolation

Nothing a caller sends reaches any of this:

- Undeclared intent keys are refused.
- The P10 vocabulary is reserved in `assertedContext`: `max_amount`, `paymentCeiling`, `ceiling`,
  `spendingLimit(s)`, `spending_limit`, `budgetId`, `remaining`, `financialAuthority`,
  `authorityLimit`, `authorityRef`, `constraints`. (P7 already reserved `maxAmount`, `budget`,
  `limitId`, `scopeKey` and `window`.)
- Nested context never reaches the resolver.
- There is no new route, no SDK method and no host option through which a financial resolver
  could be supplied (`financialAuthority` is omitted from
  `EnterpriseAuthorityControlledExecutionOptions`).

## 3. Invariants

- **Amount distinction:** requested amount ≠ policy threshold ≠ authority ceiling ≠ aggregate budget.
- **Authority invariant:** payment ceilings originate from durably provisioned authority, never from
  the payment request.
- **Spending invariant:** spending-limit definitions are authority state; spending consumption is P7
  ledger state.
- **Persistence invariant:** restart cannot reset either authority definitions or consumed budget.
- **Exactness invariant:** all monetary authority is canonical decimal text, compared with P9's
  BigInt arithmetic. No `number` appears anywhere between the store and the SQLite reservation.
- **FX invariant:** different assets are incomparable.
- **Machine-payment invariant:** machine payments remain governed actions.

## 4. Consequences and limits

- **Schema.** No table or column changes. `constraints` is an optional payload field inside the
  existing event JSON (`aoc.kernel-authority.schema.v1` unchanged). Pre-P10 records have no
  `constraints`, and therefore no monetary authority. Rolling back to P9 leaves the payload field in
  place. The P9 validators accept it (payloads are opaque objects to them), but P9 would ignore it
  and revert to request-derived ceilings. Do not roll back a deployment that relies on P10 limits.
- **Behavioural change for P9 deployments.** A financial action now requires provisioned
  `max_amount` and `spending_limit` on the actor's lineage, P7 exercise controls, and an
  Authority-Graph-verified actor. Otherwise it is withheld at issuance.
- **Proof lifetime.** The issuance anchor (`AuthorityProof`) lives in the hydrated world. A
  re-hydration between the Kernel decision and issuance, caused by a concurrent provisioning call,
  makes that one issuance unresolved. That fails closed, and a retry resolves it.
- **Cross-process propagation.** This is unchanged from `AOC_DURABLE_KERNEL_AUTHORITY.md`. A process
  observes another process's provisioning or revocation on reload or restart.
- **Authority Graph selection.** The chain rule selects the first matching grant or delegation
  regardless of status. So a revoked delegation still shadows a replacement delegation for the same
  delegate: it is withheld, never widened. Rotating authority for the same delegate is deferred.
- **Out of scope:** provider certainty (P11), reconciliation (P12), MPP (P13), Stripe (P14),
  receipts and settlement (P15). P7's word "settled" still means reservation capacity, not financial
  settlement.
