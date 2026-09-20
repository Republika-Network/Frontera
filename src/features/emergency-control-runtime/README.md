# Emergency Control Runtime

> **Has an operator administratively stopped execution for what is being
> attempted, and can that be established at all right now?**

One question, one closed answer, no rules. This module is an **operational
safety interlock** for the bounded-grant / Governed Action path — not a policy
engine, not a decision producer, not a revocation mechanism.

## What is here

```
domain/
  emergency-control-reason-codes.ts   EMERGENCY_CONTROL_ACTIVE | EMERGENCY_CONTROL_UNAVAILABLE
  emergency-control-port.ts           the reader port, the query, the assessment, the scope algebra
  emergency-control-signal.ts         EmergencyControlWithheldError — the one typed adapter-level signal
services/
  in-memory-emergency-control-store.ts  process-local, NOT durable, for focused tests
```

The durable implementation is `src/enterprise/emergency-control`
(`better-sqlite3`), because the composition root is what knows about storage.

## Three rules that explain the whole module

1. **`unavailable` is not `clear`.** A reader that throws, returns a
   non-assessment, returns a promise, is closed, holds unverifiable state, or is
   asked a malformed query yields `unavailable` — and `unavailable` withholds.
   Treating it as `clear` turns an outage into permission.
2. **The read is synchronous.** It is called inside
   `BoundedGrantStorePort.issue`'s `commitGuard`, where an `await` would
   reintroduce exactly the interleaving the commit boundary exists to prevent.
   Nothing in this module contains `await` or `async`, and a structural test
   fails the build if that changes.
3. **Monotonic safety.** If any applicable active control matches, execution is
   blocked. A narrower control being clear never overrides a broader one being
   active: "clear" is the absence of a match, not a vote.

## What this module may never become

`emergency-control-boundaries.test.ts` fails the build if it grows a decision
shape, a policy evaluator, a context resolver, an obligation, a revocation, a
grant, an AI dependency, an HTTP surface, a credential store, a wallet, a
provider SDK, an ambient clock, a generated identifier, a timer or a dynamic
import — and if any of its reason codes overlaps another layer's vocabulary.

Execution components depend on `EmergencyControlReaderPort`, which declares no
mutation. `EmergencyControlStorePort` extends it with the operator's
`activate` / `release`, and stays on the host side of the trust boundary.

See `docs/enterprise/AOC_EMERGENCY_CONTROL.md` for the lifecycle checkpoints,
the durability model and the limits.
