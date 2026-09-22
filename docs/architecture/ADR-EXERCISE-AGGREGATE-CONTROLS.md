# ADR: Aggregate / velocity exercise controls, a durable reservation ledger, and exercise-time authority-binding revalidation

- Status: accepted
- Phase: P7
- Status of implementation: implemented in `src/features/exercise-control-runtime`
  (domain, gate, process-local ledger) and `src/enterprise/exercise-control-ledger`
  (durable SQLite ledger), composed through
  `authorityControlledExecution.exerciseControls`. Opt-in: a deployment that does
  not compose it sees no change.
- Related: `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` (the bounded grant
  this narrows; its "no usage counter" gap is what this ADR closes),
  `ADR-AUTHORITY-CONTROL-LAYERING.md`, `ADR-ENTERPRISE-GOVERNANCE-STORE.md`
  (evidence, which this ADR keeps separate from authority),
  `docs/enterprise/AOC_EXERCISE_CONTROLS.md` (the operator-facing design),
  `docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md`,
  `docs/enterprise/AOC_EMERGENCY_CONTROL.md`

## Context: per-action containment is not aggregate containment

Since the bounded-grant phase, the exercise gate proves that **each** attempted
action is inside a `BoundedGrant`: the exact holder, action, resource,
counterparty, organization, amount ceiling, correlation, expiry, revocation and
integrity. A grant bounding `amount ≤ 7,500 USD` therefore admits every single
7,500 USD attempt — and, until its expiry, admits them *repeatedly*:

```
7,500   7,500   7,500   7,500   …   until expiresAt
```

`BoundedGrant` records this honestly: it carries no usage counter, because no
accepted ADR had defined a consumption model. P6 made the governed path capable
of a real external effect, so repeated use of one grant is now a real,
unbounded exposure. This ADR defines the consumption model.

## Decision

### 1. The grant stays immutable; consumption lives in a separate authoritative ledger

```
IMMUTABLE BOUNDED GRANT   +   SEPARATE AUTHORITATIVE EXERCISE-CONTROL LEDGER
```

A grant is **not** mutated when it is used. It gains no `usesRemaining`,
`amountRemaining`, `spent`, `consumed`, `usageCount` or `velocityCount`, now or
later. A grant that changed on every use would be a mutable authority artifact
carrying a second, independently settable source of truth for "how much is
left" — exactly the shape `bounded-grant.ts` refuses for lifecycle status.
Consumption is owned by the exercise-control ledger, keyed by reservation.

### 2. Reservation before effect, and a reservation consumes immediately

With exercise controls composed, **no adapter call happens without a
successful reservation**. The reservation is written — durably, in one atomic
admission across every applicable limit — before the adapter is invoked, and it
consumes capacity from the moment it commits. There is no "pending, not yet
counted" state: a process can crash one instruction after the provider received
the request and before anything recorded the outcome, and returning that
capacity would let it be spent twice.

| reservation state | how it is represented | consumes? |
| --- | --- | --- |
| `reserved` | base record, no terminal event | **yes** |
| `settled` | base record + `settled` terminal event | **yes** |
| `released` | base record + `released` terminal event | no |

States are **derived** from an immutable base record and at most one immutable
terminal event, never stored as a mutable status column. Release is an appended
event, never a deletion: "this execution reserved capacity and later released
it" stays answerable.

### 3. Finalization follows the observed outcome, conservatively

| outcome | finalization | why |
| --- | --- | --- |
| `executed` | settle | the effect happened |
| `execution-unconfirmed` | **settle** | the provider may have acted — never release an unconfirmed reservation |
| `execution-failed` (incl. adapter throw, malformed result) | release | the port contract: the effect did not complete |
| withheld after the reservation (binding re-check, emergency re-check, adapter-scoped stop in the registry) | release | no provider was reached |

A settlement or release that **cannot be recorded** leaves the reservation
`reserved`, which still consumes. That is a safe loss of availability, never a
widening, and it never rewrites the provider outcome.

### 4. No automatic reservation expiry; no reconciliation; no exactly-once

A crash that leaves a reservation `reserved` leaves it consuming — indefinitely
for a lifetime limit; until its reservation instant leaves the window for a
rolling one. There is **no** reservation TTL, sweeper, auto-release timer,
startup cleanup or stale-pending recovery. There is **no** reconciliation engine
in P7, and **no** exactly-once claim. Reconciliation is future work.

### 5. Aggregate state is authority state, not evidence

The Governed Action execution ledger (`execution-ledger.ts`) is Governance Store
**evidence** — authorization artifact, execution attempt, execution outcome —
whose one behavioural use is negative replay prevention. It is not the
exercise-control ledger, is never read to reconstruct consumption, and gains
only one thing here: a third withholding layer, `withheld:exercise-control:<CODE>…`,
recorded as evidence of *why* an effect was withheld. The exercise-control
ledger is a separate store in a separate file. Evidence never becomes
authority, and authority is never reconstructed from evidence.

### 6. The limit contract is closed, and entirely trusted host composition

Two metrics — `count` (one unit per reserved execution identity) and `amount`
(the attempt's amount, in exactly the limit's unit) — over two windows —
`lifetime` and `rolling` (1 s to 31,536,000 s). At most 32 limits per exercise;
a duplicate `(limitId, scopeKey)` is refused, never merged. The policy, the
bucket keys, the maxima and the windows are the host's; nothing a caller sends
can name any of them. The policy receives only trusted, already-contained
exercise material, and an invalid answer fails closed with no reservation.

### 7. Exact decimal arithmetic, exact units, no conversion

Amount maxima are canonical decimal strings (`0 | [1-9][0-9]* ( . [0-9]*[1-9] )?`,
at most 128 digits). An attempted amount is converted **once** from its
JavaScript number to canonical text (`String(n)`, exponent expanded), and every
sum and comparison thereafter is `BigInt` coefficient/scale arithmetic. There is
no JavaScript floating-point accumulation and no SQL `SUM()` over a floating
column anywhere on the path. `0.1 + 0.2` under a maximum of `0.3` is exactly
full. Units are compared exactly; there is no FX and no unit conversion.

### 8. Atomic, concurrency-safe admission

"Read active usage → test every applicable limit → insert the reservation"
happens inside one critical section: one `BEGIN IMMEDIATE` SQLite transaction,
which takes the write lock before the first read, so two processes on one file
racing for the last unit of a bucket cannot both win. All limits are admitted
together or none is.

### 9. Exercise-time authority-binding revalidation against immutable provenance

The authority binding resolved (and re-proved at the commit boundary) at
issuance is committed onto the grant as an **opaque** provenance digest,
`authorityBindingDigest` — SHA-256 over a canonical serialization the Enterprise
layer owns. The grant runtime treats it as bytes. At exercise time a separate,
synchronous `ExerciseAuthorityBindingResolver` answers which binding holds
**now**; its canonical digest must equal the grant's **exactly** (equality, not
containment). It is checked twice: before the reservation, and again after it,
because the reservation can wait on a write lock. A grant without provenance
cannot be revalidated and is withheld when exercise controls are composed.

The issuance commit-boundary comparison of the actual binding stays
load-bearing; the digest is additional durable provenance, not a replacement.

`authorityBindingDigest` is optional and additive: a pre-P7 grant without it
keeps its canonical bytes, deterministic identity and digest, and remains
readable and exercisable when exercise controls are not composed.

### 10. Path-local, additional narrowing only

Every guarantee in this ADR applies to the bounded-grant execution path when
exercise controls are composed. It never widens a Kernel decision, a grant or an
attempt, and it does **not** govern `AocKernel.enforce`, Sovereign Access,
Content Protection, Pinata or Stripe paths outside ACE, or arbitrary application
networking.

## Hard invariants

1. No provider execution without a successful reservation when P7 is enabled.
2. Reservation admission is atomic across every applicable limit.
3. A pending (`reserved`) reservation consumes.
4. An unconfirmed execution consumes.
5. Only a definite no-effect result, or a withholding after the reservation, releases.
6. An unreadable, unavailable or corrupt ledger fails closed.
7. The authority binding is revalidated against immutable grant provenance before provider execution.
8. One execution identity cannot invoke an adapter twice through the P7-enabled path.
9. A caller cannot choose a limit, bucket, policy, reservation or binding.
10. Amount aggregation uses exact decimal arithmetic and exact units.

## Consequences

- Repeated use of one grant — or of any bucket the host keys, per actor, per
  organization, per counterparty — can be bounded in count, amount and velocity.
- Availability can be lost conservatively (a crashed or unrecordable
  finalization keeps consuming); authority is never widened by it.
- Stage-A scale: admission is linear in a bucket's indexed rows, because exact
  amounts are summed in `BigInt` rather than by a floating aggregate.
- One SQLite file serializes the processes sharing it on one host; separate
  files on separate hosts do not share a quota.

## Alternatives rejected

- **A usage counter on the grant.** Mutates an authority artifact on every use
  and duplicates the source of truth; rejected in §1.
- **Reconstructing consumption from Governance Store evidence.** Makes evidence
  authoritative and couples admission to the evidence schema; rejected in §5.
- **Releasing pending reservations on a timer.** Returns capacity an effect may
  already have used; rejected in §4.
- **`SUM()` over a `REAL` column, or `Math.round(amount * 100)`.** Binary
  floating point in an authority check; rejected in §7.
- **Digest-only comparison at the issuance commit boundary.** Would weaken an
  existing, load-bearing field-by-field check; rejected in §9.
- **Synthesizing a `KernelEvaluationRequest` at exercise time to reuse the
  issuance resolver.** Invents the very input the binding is resolved from;
  rejected in favour of a separate exercise-time resolver.
