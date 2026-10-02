# Destination Runtime (ANDREW-P0-01)

> **A destination is a namespace and an exact identifier; whether it is
> approved is somebody else's fact.**

A pure primitive for naming the thing a governed action acts upon or sends value
to. Design record: `docs/demo/andrew/ANDREW-P0-01-DESTINATION-SEMANTICS.md`.

| file | what it owns |
| --- | --- |
| `domain/execution-destination.ts` | `ExecutionDestination` (`{ namespace, identifier }`), the single ingress `parseExecutionDestination`, the registry-free re-check, the canonical key `<namespace>:<identifier>`, and `sameExecutionDestination`. |

What it will never do: hold approval, revocation or expiry state, carry a display
label, validate a rail's address grammar, normalize an identifier, read a clock,
or perform I/O. `tests/destination-boundaries.test.ts` fails the build if any of
that changes.
