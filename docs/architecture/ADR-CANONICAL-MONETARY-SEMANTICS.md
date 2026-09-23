# ADR: Canonical monetary semantics and host-trusted financial classification (P9)

- Status: accepted
- Phase: P9 — the first increment after the MPP-00 architecture audit
- Status of implementation: implemented in `src/features/monetary-runtime`
  (canonical decimal, asset registry, amount ingress, financial action
  classifier), consumed by the governed-action boundary
  (`src/enterprise/governed-action/intent.ts`), the Kernel's grant projection
  (`src/kernel/orchestration/grant-adapter.ts`), the grant bound algebra
  (`src/features/grant-runtime/domain/grant-bound.ts`), the exercise assessment
  (`src/features/execution-runtime`), the P7 gate
  (`src/features/exercise-control-runtime`) and the policy-pack condition
  evaluator. Composed once by the Enterprise composition root from the
  `monetary` option.
- Related: `ADR-AUTHORITY-CONTROL-LAYERING.md`,
  `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` (grant ⊆ decision),
  `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7), `ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md` (P8),
  `docs/security/SECURITY_INVARIANTS.md` SEC-INV-089 … SEC-INV-093.

## Context

The MPP-00 audit settled one rule: **a machine payment is a governed action, not
a new authority model.** It travels the existing spine —

```
GovernedAction -> Kernel -> Grant -> P7 -> claim -> ExecutionAdapter -> P8
```

— and nothing about paying may introduce a second authorization path.

The audit also found that the spine carried money as a JavaScript `number`
from the first byte to the last, and that P7's exact `BigInt` arithmetic sat
*downstream* of that:

| where (pre-P9) | type | persisted? |
| --- | --- | --- |
| `GovernedActionIntent.amount.value` (wire, validated as a finite number) | `number` | inside the committed Governance Record's request payload |
| `ActionDescriptor.amount` (Kernel request) | `number` | same |
| `GrantCeilingBound.limit` (grant scope, derived from the request) | `number` | bounded-grant store `grant_json`, inside the grant digest |
| `GrantExerciseAmount.value` / `ValidatedExecutionAction.amount.value` | `number` | no |
| `ExerciseControlQuery.amount.value` (P7) | `number` | no |
| P7 reservation usage | canonical text, converted **once** from the number (`exerciseDecimalFromNumber`) | exercise-control ledger (TEXT) |
| policy-pack `amount` field | `number`, compared with `>=`/`<=` | no |

IEEE-754 therefore entered at the governed-action boundary, where
`JSON.parse` and `typeof value === 'number'` accepted `9007199254740993` as
`9007199254740992` and `0.1 + 0.2` as not `0.3`. Exact arithmetic downstream
cannot recover precision lost upstream, and grants and reservations were
becoming durable records whose monetary representation would otherwise need a
semantic migration once ceilings, provider execution and settlement arrive.

Separately, nothing identified an action as **financial**. Whether a quantity
applied was whatever the request carried.

## Decision

### 1. One canonical decimal, one implementation

A monetary quantity inside the trusted domain is **canonical decimal text**:

```
0
[1-9][0-9]*
(0|[1-9][0-9]*)\.[0-9]*[1-9]
```

No sign, exponent, leading `+`, leading zero, trailing fractional zero,
whitespace, separator or locale form. Every quantity has exactly one spelling,
so equal quantities compare equal as strings and serialize — and digest — once.
At most 128 digits.

`canonicalizeDecimalText` is the **only** conversion from untrusted text. It
accepts `(0|[1-9][0-9]*)(\.[0-9]+)?`, drops trailing fractional zeros
(`"10.50"` → `"10.5"`, `"1.00"` → `"1"`), and refuses everything else — a JSON
number included, because its precision was already decided by whoever parsed
it. Comparison and addition are `BigInt` coefficient/scale arithmetic in
`monetary-runtime/domain/canonical-decimal.ts`; P7's `exercise-decimal.ts` now
delegates to it, so there is one implementation, not two. Only the operations
the spine uses exist: compare and add. There is no general money library.

### 2. Explicit asset identity; trusted scale

```ts
interface MonetaryAmount { readonly value: string; readonly unit: string }
```

`unit` is an asset identifier that must resolve in the deployment's
**`MonetaryAssetRegistry`** — frozen host configuration mapping one identifier
to one `{ assetId, scale }` definition, with no aliases. Identifiers are
opaque, case-sensitive and admit a namespace and issuer
(`xrpl:USD/rIssuer`), so two assets that share a ticker never share an
identity; which assets exist is the deployment's choice, and this repository
enables none by default. `scale` is read from the definition only; a request
has no field for it and a `scale` key is refused. An unknown unit is refused.

`parseMonetaryAmount` is the single ingress: text → canonical → asset resolved
→ canonical scale ≤ asset scale. `"10.001"` USD (scale 2) is refused, never
`"10.00"`. `"10.000"` is `"10"` — trailing zeros state no precision.

### 3. No implicit rounding, no implicit FX

P9 validates, canonicalizes, compares and adds. It never rounds, truncates,
approximates or converts through a float. Amounts in different assets are
`incomparable`, and every consumer — grant attenuation, exercise containment,
P7 limits — already treats `incomparable` as the fail-closed answer. There is no
rate, conversion or exchange anywhere in the monetary runtime, and a structural
test keeps it that way.

### 4. Host-trusted financial classification

`FinancialActionClassifier` is built from host configuration
(`monetary.financialActions`) and answers one question — the class of an action
identifier — from one input: that string. There are two classes:

- `financial` — the intent **must** carry exactly one exact, strictly positive
  amount;
- `non-financial` — the intent **must not** carry an amount.

Validation produces a discriminated `ClassifiedGovernedActionIntent`, so the only
legal combinations are the only representable ones. A caller cannot downgrade a
financial action (omitting the amount is refused; `financial`/`actionClass` are
undeclared properties and reserved `assertedContext` keys) and cannot move money
under a non-financial one (an amount is refused). An unlisted action is
non-financial, so it can move no money at all. Zero is a valid monetary
quantity for the primitive; it is not a valid expenditure.

### 5. The spine carries text end to end

```
intent.amount { value: "7500.50", currency: "USD" }
  -> ClassifiedGovernedActionIntent { actionClass: 'financial', amount: { value: "7500.5", unit: "USD" } }
  -> KernelEvaluationRequest.action { amount: "7500.5", currency: "USD" }
  -> GrantScope.amount { kind: 'ceiling', limit: "7500.5", unit: "USD" }
  -> GrantExerciseRequest.amount / ValidatedExecutionAction.amount { value: "7500.5", unit: "USD" }
  -> ExerciseControlQuery { amount: { value: "7500.5", unit: "USD" }, actionClass: 'financial' }
  -> reservation usage "7500.5"
```

The Kernel derives a grant ceiling only from a well-formed canonical amount; a
grant ceiling or exercise amount that is not canonical text is malformed and
refuses. The policy-pack condition evaluator compares a canonical `amount`
exactly against its threshold (a number literal is read as the decimal its
author wrote: `10000` → `"10000"`). The Generic HTTP adapter emits
`amount.value` as that text.

### 6. P7 consumes the classification

The exercise-control gate requires the host classifier (no default), classifies
the **grant's** action — never the attempt's — exposes the class to the trusted
policy as `ExerciseControlQuery.actionClass`, and withholds before any
reservation a financial exercise without an amount or a non-financial exercise
with one (`EXERCISE_CONTROL_ACTION_CLASS_MISMATCH`), and any amount that is not
canonical text (`EXERCISE_CONTROL_AMOUNT_REQUIRED`). No number conversion
remains on the gate path. The composition root hands the gate and the
governed-action boundary the **same** classifier instance.

### 7. Persistence: no migration; historical records preserved, not re-spelled

- **Bounded-grant store.** A ceiling is now written as a JSON string inside the
  canonical grant bytes. A row written before P9 with a numeric ceiling is read
  back **unchanged** (its digests still verify — the store neither rewrites nor
  re-spells it), is not a well-formed scope under this contract, and covers no
  amount: exercise refuses with `GRANT_EXERCISE_AMOUNT_EXCEEDED`. Grants are
  short-lived, finite-expiry authority artifacts; converting one would change its
  identity and digest, i.e. mint authority nobody issued, so they are allowed to
  fail closed and expire. Grants without an amount axis are byte-identical and
  unaffected. The schema version is unchanged: bumping it would make the store
  refuse to open existing databases entirely, which is a larger availability
  loss for no additional safety.
- **Governance Store.** Committed records are immutable, digest-chained evidence
  and are not migrated. A governed-action **replay** of an idempotency key whose
  record holds a numeric amount rebuilds the request with text, so its payload
  digest differs from the one the idempotency claim recorded; the Store answers
  `conflict` and the orchestrator returns `rejected` /
  `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT` — fail closed, no Kernel run, no second
  effect. The historical record is untouched.
- **Exercise-control ledger.** Usage was already canonical TEXT; the reservation
  request digest was already over canonical text, so pre-P9 reservations keep
  their fingerprints. The usage digit bound (400) stays so pre-P9 rows, converted
  from any double, remain readable.
- **P8 event stream.** Event payloads carry no amount.

Rollback: a pre-P9 binary reading a P9 grant sees a string ceiling, which its
`Number.isFinite` check refuses — the grant covers no amount (fail closed). No
record needs to be rewritten in either direction.

### 8. Compatibility

- **`POST /api/governed-actions` (capability-gated) — deliberate breaking change
  to one request field's type.** `amount.value` must be decimal text. There is no
  safe compatibility shim: by the time the Host sees a JSON number its
  precision is gone, and accepting it would be the silent rounding P9 exists to
  forbid. The SDK's `GovernedActionAmount.value` is now `string`. An
  amount-bearing intent also requires the Host to configure `monetary`.
- **`POST /api/governance/evaluate` (frozen v1) — unchanged at runtime.** A numeric
  `action.amount` is still evaluated by policy packs as before (the evaluator's
  number–number path is kept); this route issues no grant, and the Kernel derives
  no ceiling from a non-canonical amount. A canonical-text amount is compared
  exactly.
- The TypeScript types `ActionDescriptor.amount`, `GrantCeilingBound.limit`,
  `GrantBoundEvaluation.limit`, `GrantExerciseAmount.value` and the policy-pack
  `amount` fields are now `string`.

## Invariants

1. **Monetary invariant.** Frontera monetary amounts are canonical exact
   decimals, never IEEE-754 monetary values inside the trusted domain.
2. **Asset invariant.** Every monetary amount is associated with an explicit
   canonical asset identity. Asset scale is trusted host metadata.
3. **Classification invariant.** Financial action classification is
   host-trusted and cannot be supplied or downgraded by callers.
4. **FX invariant.** Frontera performs no implicit cross-asset conversion.
5. **Authority invariant.** Financial actions use the same
   `GovernedAction → Kernel → Grant → P7 → claim → adapter → P8` authority
   spine. P9 adds no authority source, no payment-specific kernel and no
   parallel execution path; it narrows only.

## Not in P9

Authority-sourced ceilings and durable spending limits (P10); provider
certainty and `providerRef` durability (P11); reconciliation (P12); MPP
challenges and business-level idempotency (P13); Stripe and credential custody
(P14); receipts, settlement and obligations (P15); payment observability (P16);
XRPL (P18); containment (P19); KMS/HSM (P20); behavioural intelligence (P21).

## Follow-ups recorded by P9

- **P10.** Policy-pack thresholds remain host-authored number literals, read
  exactly; authority-sourced ceilings should be canonical text from the start.
  `authority-graph`'s declared-but-unevaluated `max_amount` constraint carries a
  `number` and is not on the spine.
- **P13/P14.** A rail adapter must encode `amount.value` for its provider (for
  example minor units for Stripe) from the canonical text and the asset's
  trusted scale — never through a float. The Generic HTTP adapter now emits the
  text verbatim.
- **Frozen evaluate route.** Whether `POST /api/governance/evaluate` should reject
  a numeric `action.amount` is a v2 question.
- **Trusted context facts** (`aoc.context`, layer C) carry arbitrary JSON values,
  numbers included; a resolver reporting a monetary fact should report text.
- **`collateralization-mandate`** keeps its own `{ minorUnits: safe integer,
  currency }` ceiling: exact, off the spine, and not reconciled with the asset
  registry.
