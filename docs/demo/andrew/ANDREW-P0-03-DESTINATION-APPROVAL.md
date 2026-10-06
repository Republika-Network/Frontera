# ANDREW-P0-03 — Destination Governance / Approval

| | |
| --- | --- |
| Task | ANDREW-P0-03 — Andrew Demo — Destination Governance / Approval Flow |
| Branch | `feat/andrew-p0-03-destination-approval` |
| Baseline | `d65770f19afd74ee1be530ce5b1aed83edb6a25c` (`feat/andrew-demo`, P0-00 + P0-01 + P0-02 merged) |
| Status | Implemented, uncommitted, not pushed |

> **P0-03 builds the trusted source of destination governance truth. It does
> not wire it into the Kernel, policy, grants or trusted context.** An
> unapproved destination still produces no HOLD / DENY / WITHHELD anywhere —
> that is P0-04 (trusted context) and P0-05 (the $75k policy).

## 1. Objective

Answer, from durable trusted state and never from a request's claim:

> **For organization O, is destination D currently approved for governed use?**

…and provide the administrative operations that make it so: approve, revoke,
read current state, read history. Approval is explicit, durable, attributable,
tenant-scoped, revocable, optionally expiring, and independent of both registry
membership and anything a request states.

## 2. Starting Baseline

| check | result |
| --- | --- |
| path | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-03` (the P0-03 isolated worktree) |
| branch | `feat/andrew-p0-03-destination-approval` |
| working tree | clean |
| `HEAD` | `d65770f` = `feat/andrew-demo` (`merge: Andrew P0-02 destination registry`) |
| P0-01 present | `src/features/destination-runtime/domain/`, `ANDREW-P0-01-DESTINATION-SEMANTICS.md` |
| P0-02 present | `src/features/destination-runtime/registry/`, `src/enterprise/destination-registry/`, `ANDREW-P0-02-DESTINATION-REGISTRY.md` |

As in P0-00..P0-02, the worktree's `.git` file points at a Windows path that
WSL `git` cannot resolve, so git was run read-only with Windows Git
(`git.exe`); the pointer was not modified. Toolchain: WSL2 Linux, Node
v22.23.1, `npm ci`. No other worktree (including the unmerged CTRL-04
worktree) was read from or depended on.

## 3. Domain Separation

| # | concept | question | owner | scope |
| --- | --- | --- | --- | --- |
| 1 | Destination identity | what exact destination is this? | P0-01 `destination-runtime/domain` | — |
| 2 | Registry membership | does Frontera have a record of it? | P0-02 `destination-runtime/registry` | deployment-wide |
| 3 | **Governance approval** | **has THIS organization authorized use of THIS destination?** | **P0-03 `destination-runtime/approval`, `enterprise/destination-approval`** | **per organization** |
| 4 | Action authorization | may this actor do this action, asset, amount, destination? | future (Kernel / policy) | per action |
| 5 | Rail validity / execution | can this rail technically reach it? | future rail adapters | per rail |

P0-03 consumes (1) unchanged, reads (2) through `DestinationRegistryReaderPort`
only, and implements (3). It touches neither (4) nor (5).

## 4. Tenant Scope

The security identity of an approval is **`(organizationId, destinationKey)`**.

- **Organization identifier.** No branded organization type exists in the
  repository; the canonical organization is the string the Host serves —
  `config.kernelAuthority.organizationId`, carried server-side as
  `EnterpriseOperatorPrincipal.organizationId`. P0-03 reuses exactly that
  value and invents no organization identity. Its admission grammar is
  `isCanonicalCustomerIdentifier`'s (non-empty, ≤ 256, trim-stable, no control
  character); because a feature runtime may not import `src/enterprise`, the
  predicate is restated in the feature port (`isDestinationApprovalOrganizationId`,
  the same precedent as `domain-policy-pack-runtime`'s `isTrustedPolicyPackWriter`)
  and a test proves the two agree on a corpus.
- **Writes take their organization from the trusted authority, never from the
  command.** `approve(authority, command)` scopes to `authority.organizationId`;
  a command that states `organizationId` is refused. An administrator can only
  approve or revoke for the organization the Host serves them.
- **Reads always name the organization.** `DestinationApprovalQuery` is
  `{ organizationId, destination }`; both are required. There is no listing by
  destination across organizations, no "who approved this wallet" query, and
  no API that returns another organization's record. The administrative read
  takes the organization from the principal.
- **Idempotency keys are per organization**: `(organization_id,
  idempotency_key)` is the primary key, so one organization's keys neither
  collide with nor replay another's.
- The store supports many organizations in one file (tested with two Hosts
  serving two organizations over one store); today's Host serves one.

Membership stays deployment-wide (P0-02). A tenant-facing response from
P0-03 never reports membership or another tenant's approval; the only
cross-tenant fact observable is the existing P0-02 one (an approve attempt on
an unregistered destination is refused as `DESTINATION_UNKNOWN`). Scoping
membership itself remains a P0-02 follow-up if required (§19).

## 5. Approval Model

API (`src/features/destination-runtime/approval/index.ts`):

```ts
interface DestinationGovernanceAuthority {        // built only by the administrative service (§6)
  readonly authenticated: true;
  readonly organizationId: string;                // the ONLY source of a write's organization
  readonly actorRef: string;                      // provenance: who decided   (operator:admin-1)
  readonly authorityBasis: string;                // why they could decide     (§6)
}

interface DestinationApprovalReaderPort {
  read(query: { organizationId; destination }): DestinationApprovalState;
  history(query: { organizationId; destination }): readonly DestinationApprovalHistoryEntry[];
}
interface DestinationApprovalStorePort extends DestinationApprovalReaderPort {
  approve(authority, { destination, expiresAt?: string | null, idempotencyKey }): ApproveDestinationResult;
  revoke(authority, { destination, idempotencyKey }): RevokeDestinationResult;
}

type DestinationApprovalState =
  | { state: 'never-approved'; organizationId; destinationKey }
  | { state: 'approved';  approval }
  | { state: 'expired';   approval }
  | { state: 'revoked';   approval; revocation };

isDestinationApprovalActive(state)  // the one permitted reading: state === 'approved'
```

Records — immutable, frozen, never edited:

```ts
interface DestinationApproval {
  organizationId; destination /* P0-01, frozen copy */; destinationKey /* derived */;
  sequence;          // position in history; what a revocation names
  approvedBy; authorityBasis; approvedAt /* store clock, in the write txn */; expiresAt /* or null */;
}
interface DestinationApprovalRevocation {
  organizationId; destinationKey; sequence; approvalSequence;
  revokedBy; revocationBasis; revokedAt;
}
```

Results:

```ts
ApproveDestinationResult = { outcome: 'approved' | 'already-approved'; approval; replayed: boolean }
RevokeDestinationResult  = { outcome: 'revoked' | 'already-revoked'; revocation; replayed }
                         | { outcome: 'not-active'; destinationKey; replayed }
```

Errors (`DestinationApprovalError`): `DESTINATION_APPROVAL_INPUT_INVALID`,
`_AUTHORITY_INVALID`, `_DESTINATION_UNKNOWN`, `_IDEMPOTENCY_CONFLICT`,
`_UNAVAILABLE`, `_CORRUPT`. None of them is an authorization outcome.

Deliberately absent: delete, edit, rename, re-key, change expiry in place,
manual timestamps, "approve and register", cross-organization listing.

## 6. Administrative Authority

The repository has a proven operator-plane authority path (CTRL-02), and
P0-03 reuses it rather than inventing one:

```
Authorization: Bearer …
  └─ OperatorAuthenticator.authorize(header, permission)   constant-time match; 401 / 403 / 503
      └─ EnterpriseOperatorPrincipal                        server configuration only
          └─ DestinationGovernanceAuthority                 organization, actorRef, authorityBasis
              └─ DestinationApprovalStorePort
```

`src/enterprise/destination-approval/administration.ts`
(`createDestinationApprovalAdministration({ authenticator, store })`):

| operation | permission | roles holding it |
| --- | --- | --- |
| `approveDestination(header, { destination, expiresAt?, idempotencyKey })` | `destination.approve` (widens) | organization-administrator |
| `revokeDestination(header, { destination, idempotencyKey })` | `destination.revoke` (narrows only) | organization-administrator, responder |
| `readDestinationApproval(header, { destination })`, `destinationApprovalHistory(…)` | `inventory.read` | every CTRL-02 role |
| any of the above | — | legacy-administrator: **none** (held to its CTRL-01 powers) |

Two permissions were added to the closed CTRL-02 model (`operator-control/roles.ts`),
following its invariants: *restriction never implies expansion* (the responder
may revoke an approval but never grant one) and *the mapping is trusted code*
(permissions decided only through `operatorMay`, by the authenticator).

- **`approvedBy` / `revokedBy`** = `principal.actorRef` (`operator:<operatorId>`) — provenance.
- **`authorityBasis` / `revocationBasis`** = `operator-permission:<permission>;role:<role>;credential:<class>`
  — *why* that actor could make the decision, from trusted fields only.

The command can state neither (closed schema); nothing about who approved, why,
or for which organization comes from request data.

**What a caller constructing `DestinationGovernanceAuthority` directly must
guarantee** (the store checks shape, not authenticity): the context was built
from an authenticated principal by trusted server code, its `organizationId`
is the organization that principal acts for, and `actorRef`/`authorityBasis`
describe that principal and the permission it was authorized under. The
administrative service is the only constructor in production code (structural
test). Neither field is a signature: no cryptographic proof of approval exists
in P0-03, and none is claimed.

## 7. Approval Lifecycle

```
                 approve                    revoke
never-approved ──────────▶ approved ──────────────────▶ revoked
                              │  ▲                        │
                 now ≥ expiresAt │ approve (new event)      │ approve (new event)
                              ▼  │                        │
                           expired ◀───────────────────────┘ (back to approved)
```

State is a pure function of one organization's history for one destination
and a trusted instant (`deriveDestinationApprovalState`). Every arrow labelled
*approve* or *revoke* appends an event; *expired* appends nothing.

**Precondition — registered first.** `approve` requires
`registry.lookup(destination).membership === 'known'`; otherwise
`DESTINATION_APPROVAL_DESTINATION_UNKNOWN`, nothing written, nothing
registered, not even the idempotency key consumed. Approval never registers.
Registration establishes stable identity and provenance; approval adds
organization-scoped governance on top. Because the registry is append-only, a
destination found `known` stays known, so the two files need no shared
transaction.

### Examples

**Example 1 — known, never approved**

```
Destination D (network-a:abc123):   registry  KNOWN
Organization A:                     NO ACTIVE APPROVAL   → { state: 'never-approved' }
Result:                             not approved         (isDestinationApprovalActive = false)
```

**Example 2 — approved for A only**

```
Destination D:     registry  KNOWN
Organization A:    APPROVED  { approvedBy: 'operator:admin-1',
                               authorityBasis: 'operator-permission:destination.approve;role:organization-administrator;credential:operator',
                               approvedAt: '2026-10-02T12:00:05.000Z', expiresAt: null, sequence: 1 }
Organization B:    NO ACTIVE APPROVAL  → { state: 'never-approved' }; history(B) = []
```

**Example 3 — approved, then revoked**

```
Organization A:    APPROVED (seq 1) then REVOKED (seq 2, approvalSequence 1, revokedBy 'operator:responder-1')
Current state:     { state: 'revoked', approval: <seq 1, unchanged>, revocation: <seq 2> }  — NOT ACTIVE
History:           [approved#1, revoked#2]   — the approval remains, approvedAt untouched
```

**Example 4 — re-approval**

```
approve#1 → revoke#2 → approve#3       state: approved (approval #3); history keeps all three
approve#1 (expires 13:00) … 13:00 → approve#2   state: approved (#2); #1 remains as recorded
```

## 8. Revocation

- **Scoped** to `(authority.organizationId, destinationKey)`; A's revocation
  never touches B's approval of the same destination (tested both ways).
- **Attributable and durable**: `revokedBy`, `revocationBasis`, `revokedAt`
  (store clock, inside the write transaction), and the `approvalSequence` it
  ends, in an appended `revoked` event.
- **Never destructive**: the approval event is not updated or deleted. The
  current state reports both the approval and its revocation.
- **Outcomes**: active → `revoked`; latest event already a revocation →
  `already-revoked` with that revocation; never approved or already expired →
  `not-active`, no event (expired stays *expired*, not *revoked* — they are
  different facts).
- **Structurally constrained**: a trigger refuses a `revoked` row that does not
  name the organization's latest, still-active approval of the destination;
  `UNIQUE (approval_sequence)` refuses a second revocation of one approval.

## 9. Expiration

Implemented, optional, deterministic.

- `expiresAt` is `null` (no expiry) or a canonical instant
  (`YYYY-MM-DDTHH:MM:SS.sssZ`, exact round trip), and must be later than the
  instant the approval is recorded; otherwise `INPUT_INVALID`, nothing written.
- **Expired when `now >= expiresAt`** — the repository convention
  (`approval-authority/evaluation.ts`, `approval-runtime` expiration policy).
  Tested at `expiresAt − 1 ms` (approved), exactly `expiresAt` (expired), and later.
- `now` is the store's injected clock, sampled on every read and inside every
  write transaction. A non-canonical answer is `UNAVAILABLE` — no state is
  derived against an unknown time. No `Date.now()` anywhere (structural test).
- No background job. Expiry writes nothing and never mutates `approvedAt` or
  any other historical field; the expired approval stays in history and in the
  `expired` state result.
- Because expiry is derived from trusted time, a clock that moves backwards
  reads an approval as active again (tested and documented): the clock is part
  of the trust base, as everywhere else in Frontera.

## 10. Persistence and History

`createSqliteDestinationApprovalStore(dbPath, { now, registry, busyTimeoutMs? })`
(`src/enterprise/destination-approval/sqlite-destination-approval-store.ts`),
its own database file, schema `aoc.destination-approval.schema.v1`. Additive
only; no existing table, file or migration touched; no new dependency.

```sql
destination_approval_versions  (id, schema_version, migration_state, recorded_at)
destination_approval_events    (sequence PK ≥ 1 store-assigned & contiguous, organization_id, destination_key,
                                namespace, identifier, transition CHECK IN ('approved','revoked'),
                                actor_ref, authority_basis, recorded_at, expires_at, approval_sequence UNIQUE,
                                previous_event_digest, event_digest, schema_version,
                                CHECK (approved ⇒ approval_sequence NULL; revoked ⇒ approval_sequence NOT NULL, expires_at NULL))
destination_approval_commands  ((organization_id, idempotency_key) PK, operation, request_digest, outcome,
                                event_sequence, destination_key, actor_ref, recorded_at, record_digest, schema_version)
destination_approval_head      (id = 1, event_sequence, event_count, event_digest, command_count, head_digest, …)
triggers: no UPDATE / DELETE on events or commands; one active approval per (org, destination);
          a revocation must end that organization's latest active approval
```

There is **no status column**: current state is always derived.

**Why a hash chain and head, not only append-only triggers.** The model is the
emergency-control store's (`emergency-control-record.ts`), chosen because the
failure mode is the same: a *deleted revocation* would silently re-activate an
approval — fail **open**. Triggers stop the store's own SQL; they do not stop
a raw writer. So every event is hash-chained (`previous_event_digest`), the
one-row head anchors the latest digest and the event and command counts, and
**every read walks the whole chain**, re-parses each destination through P0-01,
recomputes its key and digest, recounts the command journal, and re-derives
state. O(governance decisions), bounded by administrator actions, never by
request traffic. Initialization is classified before any `CREATE` (a missing
head in an initialized file is damage, never regenerated as genesis), in one
`BEGIN IMMEDIATE`. `WAL` + `synchronous = FULL`.

**Fail closed.** A deleted revocation, deleted approval, rewritten old event,
flipped transition, added expiry, moved organization, re-spelled destination,
deleted or stale head, deleted idempotency record, dropped tables, or unknown
record schema version is `DESTINATION_APPROVAL_CORRUPT` for every read and
write — never `approved`, never `never-approved`, never repaired (each tested).
An unknown file schema version, or approval tables without a version record,
refuses to open, unmutated. Verification is store-wide: damage anywhere
refuses reads for every organization — the closed side of that trade-off.

**Audit history.** `history({ organizationId, destination })` reconstructs,
oldest first: *Organization O approved D at T by A under basis B*, and *O
revoked D at T2 by A2 under basis B2, ending approval #n*. This is approval
provenance, **not** the final cross-action governance receipt.

Limits, stated: digests are unkeyed SHA-256 (storage integrity, not a
signature — a writer who recomputes every digest is not stopped); a wholesale
file rollback is not detected (the grant store's GS-002 gap); single-host
SQLite.

## 11. Idempotency

Reuses the operator plane's convention (`operator-control`: idempotency key +
request digest, `…_IDEMPOTENCY_CONFLICT`), with its key grammar
(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`).

| call | result |
| --- | --- |
| `approve(D, key k1)` | `approved`, event #1 |
| same request, `k1`, again (×10) | `approved`, the same record, `replayed: true`; nothing written |
| `approve(D, k2)` while #1 active | `already-approved`, **the original** record (original approver, terms); command recorded, no event |
| `k1` with a different destination / expiry / operation / actor | `DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT`, nothing written |
| `revoke(D, r1)` → `revoke(D, r1)` | `revoked` → same, `replayed: true` |
| `revoke(D, r2)` after revoked | `already-revoked`, the original revocation |
| **`approve(D, k1)` retried after `revoke`** | **replays the original `approved` result — the destination stays revoked** |

The last row is why every accepted command is journaled, including no-ops: a
delayed retry of an approval must never silently re-approve after an explicit
revocation. A request digest covers operation, destination key, expiry and
actor (not the instant). Keys are per organization.

**Concurrency.** Each write is one `BEGIN IMMEDIATE` (clock sampled after the
lock). Proven with genuinely parallel worker threads on separate connections,
barrier-released, 3 rounds each: six concurrent approvals with distinct keys →
exactly one `approved`, five `already-approved`, one event; five concurrent
retries of one key → applied once, four replays; 12 workers racing approvals
and revocations across two organizations → each organization's history
alternates and verifies; four first-openers of a new file → one version row,
one head. Underneath, the one-active-approval and revoke-active-only triggers
and the command primary key refuse contradictory state independently.

## 12. Registry Relationship

- P0-02 is **unchanged**: no file, schema, semantics or test modified. The
  registry still holds no governance vocabulary (its boundary test still passes).
- Approval reads membership through `DestinationRegistryReaderPort` only, never
  `register` and never the registry's tables (structural test).
- **Registration still does not imply approval**: every registered destination
  is `never-approved` for every organization until one approves it (tested).
- Approval stores `destination_key` plus a defensive copy of
  `namespace`/`identifier` for auditable reconstruction; on every read the copy
  is re-parsed through P0-01 and must reproduce the key (a re-spelled row is
  `CORRUPT`). P0-01's `executionDestinationKey` remains the only key algorithm.

## 13. Counterparty Relationship

Unchanged. No grant format, signed artifact, Kernel contract, approval subject
or `counterparty` semantics were touched. The intended later path remains:

```
ExecutionDestination → executionDestinationKey → trusted destination governance (this task)
  → later: bind destinationKey to the existing counterparty axis, or a dedicated axis
```

That binding is not decided here.

## 14. Security Invariants

| # | invariant | how |
| --- | --- | --- |
| 1 | Approval is never implied by registration, syntax, request data or prior use | separate store; explicit `approve` only; tests |
| 2 | Approval never leaks across organizations | org from trusted authority on write; org required on read; no cross-org query (structural test); two-tenant tests |
| 3 | A request cannot self-assert approval | closed schemas refuse `approved`, `status`, `organizationId`, `approvedBy`, `authorityBasis`, …; P0-01 refuses them on the destination |
| 4 | Only an authenticated, permitted operator approves or revokes | CTRL-02 authenticator + `destination.approve` / `destination.revoke`; tests for 401/403 and every role |
| 5 | Provenance is durable and immutable | appended events; frozen records; triggers; digests |
| 6 | Revocation never erases history; a vanished revocation is detected | appended `revoked` event; chain + head verification |
| 7 | At most one active approval per (org, destination) | `BEGIN IMMEDIATE` derivation + trigger; parallel race tests |
| 8 | Expiry is deterministic | injected clock; `now >= expiresAt`; no background job; no `Date.now()` |
| 9 | Damage is never read as approved or never-approved | `CORRUPT` on any verification failure; 13 damage tests |
| 10 | Identity is P0-01's, verbatim | P0-01 ingress; P0-01 key; no normalization or second key algorithm (structural test) |
| 11 | Retries are deterministic and never re-approve after revocation | per-org idempotency journal with request digests |
| 12 | No Kernel, policy, grant, execution, signer, rail, network or hosted DB reach | structural boundary test |

## 15. Trusted-Context Integration Point

P0-04 should hand a trusted-context resolver a **`DestinationApprovalReaderPort`**
(read-only — it cannot reach `approve`/`revoke`) and call:

```ts
const state = approvalReader.read({ organizationId: <bound organization, server-derived>,
                                     destination: <server-resolved ExecutionDestination> });
const destinationApproved = isDestinationApprovalActive(state);
```

alongside `DestinationRegistryReaderPort.lookup` for membership. Both reads are
synchronous (`better-sqlite3`), so they can sit inside a commit-boundary check
without an `await`. Both throw on unreadable/corrupt state; the resolver must
treat a throw as *unavailable* (withhold), never as *not approved* or
*approved*. The request never supplies either fact.

Also deferred to integration: choosing the approval database path and composing
the store and `createDestinationApprovalAdministration` into the Enterprise
Host; HTTP routes (`/api/admin/destinations/…`), which require a deliberate
`release/api-surface.v1.json` freeze update, SDK surface update and console
client methods — and should be coordinated with CTRL-04 rather than duplicated.
The service's methods (header + closed command) are already shaped like the
CTRL-01/02 services the HTTP adapter routes to.

## 16. Tests

New:

- `src/enterprise/__tests__/destination-approval.test.ts` — 54 tests:
  - known-but-unapproved is `never-approved`; unknown cannot be approved (nothing registered, no key consumed); every registered destination unapproved for every org;
  - approve for A with full provenance (`approvedBy`, `authorityBasis`, `approvedAt` from the clock, `expiresAt`, `sequence`); B stays `never-approved` with empty history and no leakage; A's revocation leaves B's approval; per-org idempotency keys; two namespaces / case-different spellings separate;
  - identity and the registry record unchanged (registry schema still six columns);
  - approval fields refused on destination, command, query and authority; malformed authority (missing/`'true'`/blank/whitespace/control/accessor) refused; malformed expiry, keys, destinations, organizations refused; expiry not after the decision instant refused;
  - caller mutation after the call reaches nothing; returned records, states and histories frozen;
  - idempotency: 10 replays deterministic; `already-approved` keeps the original terms; conflicts for different destination/expiry/operation/actor; **late approval retry after revocation does not re-approve**; revocation replays and `already-revoked`; `not-active` for never-approved and expired;
  - revocation provenance and retained approval; expiry boundary (−1 ms / exact / later / clock moved back); history unchanged by expiry; approve→revoke→approve→revoke; re-approval after expiry;
  - **restart**: approval, revocation, history and idempotency journal survive close → reopen; initialization idempotent over three openings;
  - schema has no status/active column; raw `UPDATE`/`DELETE` refused; raw second active approval, wrong-org / expired / non-latest revocation, malformed transition shapes refused by SQLite;
  - closed store, non-canonical clock (read and write), construction without clock/registry/path refused;
  - **fail closed**: 12 damage variants → `CORRUPT` for reads (both orgs), history, approve and revoke; a tampered idempotency record cannot steer a replay; unknown schema version refused unmutated; tables without a version record refused;
  - administrative service: provenance/basis/org from the principal; forged `organizationId`/`approvedBy`/`authorityBasis`/`approved`/`status`/`actorRef` refused; 401 without/unknown credential, 403 for a customer key, `OPERATOR_PERMISSION_DENIED` for responder/observer/legacy approval, observer/legacy revocation, legacy read; responder revokes; refused callers write nothing; two Hosts / two orgs over one store isolated;
  - organization predicate equals `isCanonicalCustomerIdentifier` on a corpus;
  - **concurrency** (worker threads, separate connections, barrier): 6 parallel approvals × 3 rounds → one approval; 5 parallel same-key retries → one write; 12 racing approve/revoke across two orgs × 3 rounds → consistent verifiable histories; 4 parallel first-openers → initialized once.
- `src/enterprise/__tests__/destination-approval-concurrency-worker.ts` — race participant (scaffolding).
- `src/features/destination-runtime/tests/destination-approval-derivation.test.ts` — 6 tests: pure derivation, expiry boundary, revoked vs expired, re-approval, refusal of every impossible history shape, closed command.
- `src/features/destination-runtime/tests/destination-approval-boundaries.test.ts` — 14 structural tests: imports (port: itself, P0-01, P0-02 reader; durable: destination runtime, SQLite, fs/path/crypto, operator-plane types **type-only**); no Kernel / grant / policy / governed-action / trusted-context / execution / signer / adapter / HTTP / rail SDK / hosted DB; no ambient clock/randomness/process/timers; no rail, wallet, amount, asset or counterparty vocabulary; no second key algorithm or normalization; never registers or touches registry storage; never updates/deletes history; ports exactly `read`+`history` / `approve`+`revoke`; queries require `organizationId`; commands carry no org/actor/basis/state; only the administrative service builds an authority; not exported from the P0-01, P0-02 or Enterprise public barrels.

### 16a. Results

See §20a.

## 17. Files Changed

| file | change |
| --- | --- |
| `src/features/destination-runtime/approval/destination-approval.ts` | new — records, state, ports, authority type, errors, input checks, pure derivation |
| `src/features/destination-runtime/approval/index.ts` | new — approval entry point |
| `src/features/destination-runtime/tests/destination-approval-boundaries.test.ts` | new — structural boundary |
| `src/features/destination-runtime/tests/destination-approval-derivation.test.ts` | new — derivation unit tests |
| `src/features/destination-runtime/README.md` | documents approval |
| `src/enterprise/destination-approval/destination-approval-record.ts` | new — canonical forms and digests |
| `src/enterprise/destination-approval/sqlite-destination-approval-store.ts` | new — durable store |
| `src/enterprise/destination-approval/administration.ts` | new — operator-plane administrative service |
| `src/enterprise/destination-approval/index.ts` | new — barrel |
| `src/enterprise/operator-control/roles.ts` | **+2 permissions** (`destination.approve` → organization-administrator; `destination.revoke` → organization-administrator, responder) |
| `src/enterprise/__tests__/destination-approval.test.ts` | new |
| `src/enterprise/__tests__/destination-approval-concurrency-worker.ts` | new |
| `docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md` | new — this document |

Not changed: P0-01 domain, P0-02 registry (feature and enterprise), Kernel,
policy evaluator, governed action, context resolution / trusted context, grant
runtime, grant issuance/verification, bounded grant store, execution adapters,
HTTP adapter, `release/api-surface.v1.json`, SDK packages, CTRL-03 console,
`src/enterprise/index.ts`, `package.json`.

**On the `roles.ts` change.** It is the one edit outside new files. It is
additive (no existing role loses or gains any pre-existing permission; the
CTRL-02 role-matrix test, which enumerates the CTRL-01/02 services, is
unaffected), and it is what makes approval *structurally* require an
authenticated administrator instead of a self-declared string. Its visible
effect elsewhere: `GET /api/admin/organization` lists the two new permissions
for organization administrators (and `destination.revoke` for responders).

## 18. Explicitly Out of Scope

Not implemented, deliberately: trusted-context wiring, Kernel/policy use of
approval, HOLD/DENY/WITHHELD for unknown or unapproved destinations, the $75k
policy, reevaluation / resume of the same action, grant binding of
`destinationKey`, counterparty changes, HTTP routes, Host composition, console
UI, per-agent/asset/amount/action approval scope, approval reasons/tickets,
approval quorum or four-eyes, signed approval receipts, approval listing,
deletion, XRPL / Testnet / signer / payment execution / Lumx / Lightning.

## 19. Impact on ANDREW-P0-04

P0-04 can proceed. It needs to:

1. Compose `createSqliteDestinationRegistry` and
   `createSqliteDestinationApprovalStore` (registry reader injected) into the
   Host with chosen file paths.
2. In the trusted-context resolver, resolve the destination server-side, then
   call `registry.lookup(destination)` and
   `approvalReader.read({ organizationId: <bound org>, destination })`, exposing
   facts such as `destinationMembership` and `destinationApproval` — never
   accepting them from the request.
3. Map a thrown `DestinationApprovalError` / `DestinationRegistryError` to an
   *unavailable* fact that withholds.
4. Decide (P0-04/P0-05) the unknown- and unapproved-destination outcomes
   (HOLD vs DENY) — not decided here.

Open items carried forward: HTTP/console routes (coordinate with CTRL-04);
optional tenant scoping of registry membership; whether governance should later
scope approval more narrowly (per agent / asset / ceiling) — additive to this
model as new event fields under a new schema version.

## 20. Final Verdict

**A. DESTINATION APPROVAL COMPLETE — READY FOR ANDREW-P0-04**

Organization-scoped, explicit, attributable, revocable, optionally expiring
destination approval exists as durable, verified, append-only history behind a
read-only port P0-04 can consume, with an operator-plane administrative service
that derives authority from the authenticated principal. Registry semantics,
destination identity, grants, counterparty, Kernel and execution are unchanged.

### 20a. Test Results

WSL2 Linux, Node v22.23.1, after `npm ci`:

| step | result |
| --- | --- |
| `npm run typecheck` / `npm run build` (`tsc -b`) | exit 0 |
| `npm run lint` | node16 imports, architecture and public-surface lint passed |
| focused: `destination-runtime/tests/*` + `destination-registry.test` + `destination-approval.test` | 205 tests, 205 pass (P0-01 + P0-02 included) |
| new P0-03 tests | 74 (54 enterprise + 6 derivation + 14 boundary), 74 pass |
| `npm run test:root` | 9136 tests, 9121 pass, **2 fail (inherited)**, 9 skipped, 4 todo |
| `npm run test:workspaces` | 1089 tests, 1089 pass, 0 fail |
| **total** | **10225 tests, 10210 pass, 2 fail, 9 skipped, 4 todo** |

Against P0-02 (10151 / 10136 / 2 / 9 / 4): +74 tests, +74 passes, no new
failure. The two failures are the inherited CRLF/source-scanning artifacts —
`authority-administration-service.test.ts:334` (CTRL-01 route-matcher regex)
and `structural-boundaries.test.ts:282` (`loadEnterpriseConfiguration`
regex) — untouched. The CTRL-02 role matrix and structure suites, CTRL-03
console role tests, grant / counterparty, Kernel, CORE-08 neutrality and
structural-boundary suites are part of `test:root` and pass.
