# Exercise Control Runtime (P7)

> **The grant covered this attempt. Does repeated use of it still fit the
> trusted aggregate limits, and does the authority it was issued under still
> stand exactly?**

Aggregate / velocity limits on repeated use of a bounded grant, the reservation
model they are enforced through, and exercise-time authority-binding
revalidation. It **narrows only**: it can stop an effect a grant covered and
never permit one it did not.

## What is here

```
domain/
  exercise-control-reason-codes.ts   EXERCISE_CONTROL_* — its own closed vocabulary
  exercise-decimal.ts                canonical decimal text + exact BigInt arithmetic
  exercise-control-limits.ts         the closed limit contract, the policy query, snapshotting, the policy digest
  exercise-reservation.ts            reservation identity, request digest, terminal vocabulary, the shared admission rule
  exercise-control-ledger-port.ts    ExerciseControlLedgerPort — what every ledger must guarantee
  exercise-authority-binding.ts      exact-equality revalidation against the grant's opaque provenance digest
services/
  exercise-control-gate.ts           admit (binding #1 → policy → atomic reserve), revalidate (binding #2, after the grant re-read), finalize
  in-memory-exercise-control-ledger.ts  process-local, NOT durable, for focused tests
```

The durable ledger is `src/enterprise/exercise-control-ledger` (`better-sqlite3`,
`BEGIN IMMEDIATE` admission), because the composition root is what knows about
storage. Both ledgers pass the same contract suite
(`tests/exercise-control-ledger-contract.ts`).

## Rules that explain the whole module

1. **The grant stays immutable.** Consumption lives here, keyed by reservation,
   never on `BoundedGrant`.
2. **Reservation before effect.** A reservation consumes from the moment it
   commits; `reserved` and `settled` consume, `released` does not. The
   reservation instant is the ledger's: sampled from its injected clock inside
   its admission critical section, never supplied by a caller.
3. **Unconfirmed consumes.** Only a definite no-effect result or a withholding
   after the reservation releases.
4. **No expiry.** Nothing here ages, sweeps or releases a reservation on its own.
5. **Exact.** Amounts are canonical decimal text summed with `BigInt`; units are
   compared exactly and never converted.
6. **Authority, not evidence.** This state is never reconstructed from — and
   never written as — Governance Store evidence.
7. **Trusted inputs only.** The policy and the binding resolver are host code
   and receive only what the authoritative grant holds or the grant-exercise
   assessment already proved. Nothing a caller sends reaches them.

`tests/exercise-control-boundaries.test.ts` fails the build if the module grows
a Kernel, a Governance Store, a network client, an ambient clock, a timer, a
float accumulator, a decision shape or a caller-facing surface, or if its
vocabulary overlaps another layer's.

See `docs/enterprise/AOC_EXERCISE_CONTROLS.md` and
`docs/architecture/ADR-EXERCISE-AGGREGATE-CONTROLS.md`.
