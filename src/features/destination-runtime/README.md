# Destination Runtime (ANDREW-P0-01, ANDREW-P0-02, ANDREW-P0-03)

> **A destination is a namespace and an exact identifier; whether it is
> approved is somebody else's fact.**

A pure primitive for naming the thing a governed action acts upon or sends value
to, a registry recording which destinations Frontera knows, and per-organization
governance approval of known destinations. Design records:
`docs/demo/andrew/ANDREW-P0-01-DESTINATION-SEMANTICS.md`,
`docs/demo/andrew/ANDREW-P0-02-DESTINATION-REGISTRY.md` and
`docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md`.

| file | what it owns |
| --- | --- |
| `domain/execution-destination.ts` | `ExecutionDestination` (`{ namespace, identifier }`), the single ingress `parseExecutionDestination`, the registry-free re-check, the canonical key `<namespace>:<identifier>`, and `sameExecutionDestination`. |
| `registry/destination-registry.ts` | Registry membership (P0-02): the `DestinationRegistration` record (`destination`, `destinationKey`, `registeredBy`, `registeredAt`), `DestinationRegistryReaderPort` (`lookup` → `unknown` \| `known`), `DestinationRegistryPort` (`register` → `registered` \| `existing`), and the shared input checks. |
| `registry/in-memory-destination-registry.ts` | Process-local, **not durable**, for focused tests. |
| `approval/destination-approval.ts` | Governance approval (P0-03): approval and revocation records, `DestinationApprovalState` (`never-approved` \| `approved` \| `expired` \| `revoked`), `DestinationApprovalReaderPort` (`read`, `history` — always per organization), `DestinationApprovalStorePort` (`approve`, `revoke` under a trusted `DestinationGovernanceAuthority`), the input checks and the pure state derivation. |

The durable registry is `src/enterprise/destination-registry` (`better-sqlite3`),
because the composition root is what knows about storage. Both implementations
are proven against one contract in `src/enterprise/__tests__/destination-registry.test.ts`.

`registry/` and `approval/` are their own entry points; the root `index.ts`
stays the import-free P0-01 identity primitive and exports neither. The durable
approval store and its operator-plane administrative service are
`src/enterprise/destination-approval`.

**Registered is not approved.** A known destination is exactly as unapproved as
an unknown one. The registry holds no approval, trust, revocation, expiry or
status state, offers no update or delete, and `registeredBy` is provenance of
the recording, never of an approval.

**Approval is per organization and explicit.** An approval exists only as an
`approved` event recorded under an authenticated authority, for one
organization and one already-registered destination; it ends by an explicit
`revoked` event or by its `expiresAt` passing, and history is never rewritten.

What the identity primitive will never do: hold governance state, carry a display
label, validate a rail's address grammar, normalize an identifier, read a clock,
or perform I/O. `tests/destination-boundaries.test.ts`,
`tests/destination-registry-boundaries.test.ts` and
`tests/destination-approval-boundaries.test.ts` fail the build if any of that
changes.
