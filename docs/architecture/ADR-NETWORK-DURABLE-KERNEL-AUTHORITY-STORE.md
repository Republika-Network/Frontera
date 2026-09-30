# ADR: Network-Durable Kernel Authority Store Contract

- **Status:** Accepted
- **Increment:** FRONTERA-PROD-01
- **Builds on:** [`ADR-DURABLE-KERNEL-AUTHORITY.md`](ADR-DURABLE-KERNEL-AUTHORITY.md) (P0-PKG-07)
- **Supersedes:** nothing. No authority semantics change.
- **Conformance suite:** `src/enterprise/__tests__/kernel-authority-store-conformance.ts`, run by
  `kernel-authority-store-conformance.test.ts`

## Context

`KernelAuthorityStore` is the durable source of the operator-provisioned
recognition/authority world `AocKernel.evaluate()` decides against. It has two
implementations: an in-memory store (tests, fixtures, local development) and a
SQLite store (the durable provider, and the one the shipped Enterprise Host
requires in production).

SQLite remains a correct choice for local development and for a single
long-lived host that owns its file. It is not a correct choice for every
deployment that must decide against Frontera authority. The first external
consumer, PMFreak, runs Frontera's evaluation runtime in-process on a
horizontally scaled, serverless-style host: each instance has its own
ephemeral filesystem, nothing is shared between instances, and nothing is
shared with the operator process that provisions authority. FRONTERA-PROD-00
selected the target: a **network-durable Postgres provider owned by
Frontera**, read by consumers with read-only credentials, written only by
operators.

Before a third provider is written, this ADR establishes that the store's
behaviour is a Frontera domain contract rather than a description of what
SQLite happens to do, and fixes the contract a new provider is certified
against.

## Decision

1. **`KernelAuthorityStore` is the canonical storage abstraction.** Its seven
   methods, its error taxonomy and the invariants below are the contract.
   Nothing about SQLite -- tables, pragmas, locking, file layout -- is.
2. **One conformance suite.** Memory, SQLite and every future provider pass
   the same behavioural cases with identical assertions. A provider supplies
   setup, teardown and (optionally) access to its persisted representation; it
   never supplies an expectation.
3. **Frontera owns every provider implementation, the authority schema and its
   migrations.** A consuming application does not define, migrate or extend
   the authority schema, and receives no credential that can write it.
4. **Authority remains append-only.** There is no update or delete; every change
   is an appended event; revocation is terminal.
5. **Fail-closed is mandatory.** A provider that cannot open, read, verify or
   reach its storage raises; it never answers from an empty or partial world.
6. **No provider fallback.** A configured provider that fails is never replaced
   by another (in particular never by memory). This was already true of the
   composition root and is now a contract rule for every provider.
7. **Exact digest semantics are preserved.** A provider must return the exact
   logical values the existing digests were computed over (see *Digest
   canonicalization*). The golden digests in the conformance suite are the
   compatibility requirement.

## The contract

### Method matrix

Behaviour below is taken from both implementations and their tests, not from
the interface alone. "Scoped read" means `requireKernelAuthorityReadAccess`:
a non-system context must name an organization (`TENANT_SCOPE_REQUIRED`), and
it must be the one read (`ACCESS_SCOPE_VIOLATION`); a system context may read
any organization it names.

| Method | Input → output | Errors | Guarantees |
|---|---|---|---|
| `appendEvent(ctx, input)` | operator context + `{organizationId, entityKind, entityId, eventType, payload, occurredAt?, idempotency?}` → `{event, record, replayed}` | `OPERATOR_CONTEXT_REQUIRED` (not `system`, or no `actorId`), `VALIDATION_ERROR` (empty org/id, unknown kind/type, non-object payload, invalid monetary constraint), `ENTITY_CONFLICT`, `ENTITY_REVOKED`, `ENTITY_NOT_FOUND` (revoke of unknown), `IDEMPOTENCY_CONFLICT`, `EXTERNAL_SUBJECT_CONFLICT`, `STORE_UNAVAILABLE` (closed) | Atomic. Decides via the shared `decideKernelAuthorityAppend`. Replay appends nothing and returns the existing head event and record; an unclaimed idempotency key is still pinned on a replay. Appended event is `sequence = n+1`, linked to the previous digest, stamped with the injected clock/id and the operator's `actorId`. |
| `getRecord(ctx, org, kind, id)` | → record or `null` | scoping, `INTEGRITY_FAILED`, `STORE_UNAVAILABLE` | Reconstructed from the event chain (never from a projection); verified against the independently-stored head where the provider keeps one. `null` only when never provisioned. |
| `listRecords(ctx, query)` | `{organizationId, entityKind?, trustDomainId?, status?}` → records | scoping, `INTEGRITY_FAILED`, `STORE_UNAVAILABLE` | Only the named organization. Revoked records included unless `status` filters them. Ordered by kind (declared order) then id. Any unintelligible record fails the whole call -- never skipped. |
| `listEvents(ctx, org, kind, id)` | → events, oldest first | scoping, `STORE_UNAVAILABLE` | `[]` when never provisioned. Returns stored events as persisted (it does not itself verify the chain). |
| `findActorByExternalSubject(ctx, org, subject)` | `{system, subjectId}` → actor record or `null` | scoping, `INTEGRITY_FAILED`, `STORE_UNAVAILABLE` | A read: never creates a binding. Returns the bound actor **including when revoked** (status `revoked`), so a consumer can deny truthfully. |
| `health()` | → `KernelAuthorityStoreHealth` | never throws | See *Health*. After close: `unhealthy`, not readable, not writable. |
| `close()` | → void | never throws | Idempotent. Every subsequent call except `health()` raises `STORE_UNAVAILABLE`. |

### Invariants, and what is *not* the contract

| # | Behaviour | Classification |
|---|---|---|
| A | An entity is provisioned once; an identical re-provision replays, a different one is `ENTITY_CONFLICT` | DOMAIN CONTRACT |
| B | No update/delete path; every change is an appended event | DOMAIN CONTRACT |
| C | Revocation is terminal; re-provision of a revoked id is `ENTITY_REVOKED`; re-revocation replays; a *new* id is always provisionable | DOMAIN CONTRACT |
| D | Idempotency key: same key + same payload (and entity) replays; otherwise `IDEMPOTENCY_CONFLICT`; keys are organization-scoped; a key is claimed even by a replaying call | DOMAIN CONTRACT |
| E | `(organization, system, subjectId)` binds to exactly one actor; the binding outlives the actor's revocation (the subject cannot be rebound to a replacement actor in that organization) | DOMAIN CONTRACT (the "outlives revocation" half is current behaviour, ratified here, see *Open questions*) |
| F | Every read and write is organization-scoped; same ids in two organizations are independent | DOMAIN CONTRACT |
| G | Per-entity sequences start at 1 and are contiguous; events are ordered by sequence | DOMAIN CONTRACT |
| H | Events are digest-chained (`previousEventDigest`); digests are recomputed on read, never trusted; tampered payload, broken link, gap, lost tail (against the stored head) and head mismatch are `INTEGRITY_FAILED` | DOMAIN CONTRACT (detection of a lost tail requires the provider to keep an independently-written head: STORE CONTRACT for every durable provider) |
| I | Current state is reconstructed from events; a projection is a cache and is never trusted over them | DOMAIN CONTRACT |
| J | Storage provider choice does not change any `AocKernel` decision, including resource-scope semantics (`S` covers `S:child`, not `S0`) | DOMAIN CONTRACT |
| — | Only operator contexts (`system: true` + `actorId`) write | DOMAIN CONTRACT |
| — | Raw driver errors never escape; every failure is a `KernelAuthorityError` code | STORE CONTRACT (currently violated under cross-connection races: finding F1) |
| — | The store honours an injected `now` and `nextId` | STORE CONTRACT (needed for reproducible digests) |
| — | Schema version is checked at open and a foreign version is refused untouched | STORE CONTRACT (the check); how the schema is created is SQLITE IMPLEMENTATION DETAIL |
| — | Schema created on open (`CREATE TABLE IF NOT EXISTS`) | SQLITE IMPLEMENTATION DETAIL. A network provider must not do this: schema is applied by Frontera-owned migrations |
| — | WAL, `synchronous = FULL`, `busy_timeout`, `db.transaction`, better-sqlite3's synchronous execution | SQLITE IMPLEMENTATION DETAIL |
| — | Four tables, their columns, foreign keys and indexes | SQLITE IMPLEMENTATION DETAIL |
| — | `listRecords` replays each record's chain with one query per record | PERFORMANCE IMPLEMENTATION DETAIL (a network provider should load an organization's heads and events in bulk) |
| — | Projection row keeps payload/status copies | PERFORMANCE IMPLEMENTATION DETAIL (only its head columns carry contract weight) |

### Digest canonicalization

Every event digest is `sha256` over `aoc.canonical-json.v1`
(`governance-store/canonical-json.ts`) of the event's own fields:
`eventId, organizationId, entityKind, entityId, eventType, sequence, payload,
provisionedBy, occurredAt, persistedAt, schemaVersion, runtimeVersion` and,
only when present, `previousEventDigest`. Canonical JSON sorts object keys by
UTF-16 code unit, preserves array order, omits `undefined` properties,
normalizes `-0` to `0`, and rejects non-finite numbers, `bigint`, functions and
symbols.

A provider must therefore return, for every event, **the exact logical values
that were digested**:

| Value | Requirement |
|---|---|
| Payload | The same JSON value: same keys, same strings (every code point, including characters a database type may reject or normalize), same numbers, same array order. Key order is irrelevant; canonicalization owns it. |
| Timestamps (`occurredAt`, `persistedAt`) | The **exact string written**. `occurredAt` is operator-suppliable and is not normalized: `2026-03-01T13:00:00.5+01:00` must come back as written, not as the same instant re-rendered. |
| `sequence` | A JavaScript `number`, not a string or `bigint`. |
| `previousEventDigest` | Absent on the first event -- the property is **absent, not `null`**. A `null` enters the canonical form and changes the digest. |
| `eventDigest`, head digest | The exact `sha256:<hex>` string. |
| `eventId`, `organizationId`, `entityId`, `provisionedBy`, `schemaVersion`, `runtimeVersion` | The exact strings, as recorded (in particular `runtimeVersion` is the writer's, not the reader's). |

Intended constraint for a Postgres provider (FRONTERA-PROD-02 decides the
schema): digest-bearing payloads may need to be stored as `TEXT` rather than a
semantically-normalizing type such as `jsonb` when normalization would alter
the digest input; digest-bearing timestamps must round-trip exactly, which a
`timestamptz` column does not; sequences must be read back as JS numbers.

The conformance case *canonical digests (golden)* provisions a fixed sequence
(non-ASCII text, a quote, out-of-order keys, nested arrays, an idempotency key,
an operator-supplied non-normalized timestamp, a revocation) under a constant
clock and a counted id source, and compares every event digest with pinned
constants. Memory and SQLite each reproduce them independently. **They are
compatibility constants: a provider is conformant only if it reproduces them
byte-for-byte, and changing one means every persisted store has changed
meaning.**

### Concurrency and transaction requirements

SQLite gets its guarantees from one synchronous `db.transaction` and file
locking. Those mechanics are not the contract. A provider must provide:

1. **One atomic append.** The decision, the event, the head/projection update,
   the idempotency claim and the external-subject binding commit together or
   not at all.
2. **No lost update at an authority head.** Two writers appending to the same
   entity cannot both commit at the same sequence.
3. **Atomic idempotency registration.** One key, one payload, organization-wide.
4. **Unique external-subject binding**, enforced by the storage itself, not
   only by a read-then-write check.
5. **A coherent reconstruction snapshot.** A chain and its head are read from
   one consistent state; `listRecords` returns one consistent world.

The suite asserts these in two halves, with identical assertions for every
provider:

- **Safety** (hard assertion, every provider): under a race of independent
  participants, at most one logical mutation commits and the resulting state
  is that of one serial order -- one event for an entity, one bound actor per
  subject, one revocation at sequence 2.
- **Classification** (every provider): every losing participant receives what
  the serial order makes of its request -- a replay, or the named conflict --
  and never a raw driver error.

What `race` exercises per provider is stated, not implied: memory runs
participants as concurrent calls on one store object (in-process only);
SQLite runs each participant on its own worker thread with its own connection
to one database file. A network provider must race independent connections
(and FRONTERA-PROD-02 must additionally prove it across processes).

### Provider kind

`providerKind` is `KernelAuthorityStoreProviderKind`, derived from
`KERNEL_AUTHORITY_STORE_PROVIDER_KINDS = ['memory', 'sqlite']`. What a kind
guarantees is declared once in `KERNEL_AUTHORITY_STORE_PROVIDER_PROPERTIES`
(`durable`) and read through `isDurableKernelAuthorityStoreProvider`; the
Kernel Authority module no longer infers durability from `=== 'sqlite'`.

`postgres` is **not** added. A kind is added only in the change that ships its
implementation and passes this suite: naming a provider nothing can construct
would let configuration select it and force every exhaustive check to invent
an answer for it. The Enterprise Host's own `AOC_ENTERPRISE_PERSISTENCE_PROVIDER`
is a separate vocabulary and already refuses unknown values under the strict
Host validator; it is unchanged.

### Health

`KernelAuthorityStoreHealth` fields are all storage-neutral and are ratified:
`providerKind`, `status`, `readable`, `writable`, `schemaVersion`,
`migrationState`, `recordCount`. `migrationState` is now the fixed vocabulary
`current | closed | unavailable`. The SQLite store previously put the driver's
error message into it on an unexpected failure; a driver message can name a
file path -- or, for a network provider, a host, user or connection string --
and health is served to anyone who can reach a health endpoint. It now reports
`unavailable`. Health carries no credential, connection string, path, host,
table name, driver message or authority content; provider-specific diagnostics
belong to that provider's operational tooling.

`writable` is reported truthfully. The Kernel Authority *module* refuses to
initialize over a non-writable store; that is correct for the Enterprise Host,
which provisions, and it is not a constraint on a read-only consumer that opens
a store directly.

## Findings recorded by this increment

- **F1 — SQLite race losers receive raw driver errors.** With genuinely
  independent connections (worker threads, one file), the losing writer of a
  race receives `SqliteError: SQLITE_BUSY (database is locked)` instead of the
  replay or conflict the serial order implies: a deferred transaction that has
  read cannot upgrade to a write lock under WAL, and `busy_timeout` does not
  apply. **Safety holds** (exactly one commit, verified repeatedly); the
  classification half of the contract and the "raw driver errors never escape"
  rule do not. The single-connection case (the Enterprise Host) is unaffected.
  Recorded in `KNOWN_CONFORMANCE_GAPS` and reported as TODO. Not fixed here:
  this increment changes no SQLite persistence behaviour. The likely fix is an
  immediate (write-locking) transaction; it belongs to its own reviewed change.
- **F2 — the memory store aliases caller-owned objects.** It keeps and returns
  the payload objects it was given. A caller mutating a payload after
  `appendEvent` changes stored state; the next read fails closed with
  `INTEGRITY_FAILED`. Memory-only, non-durable, fail-closed; not fixed here.

`KNOWN_CONFORMANCE_GAPS` only shrinks. A new provider may not be certified with
an entry of its own.

## Not decided here

- The Postgres schema, column types and indexes.
- The connection-pool implementation and pooler compatibility.
- The migration runner and how migrations ship.
- Production credentials, roles and their provisioning.
- A Frontera network service (FRONTERA-PROD-00 Option C).
- Persistence of decision receipts.

### Open questions

- Whether an external-subject binding should be releasable when its actor is
  revoked (invariant E). Today it is not: a revoked actor's subject can never
  be bound to a replacement actor in that organization. Consumers that revoke
  per-user authority should revoke credentials and grants rather than the
  actor. Changing this is an authority-semantics change and needs its own ADR.

## Consequences

- One contract, several storage adapters. A provider is a storage choice, not
  a semantics choice, and the suite is what makes that claim testable.
- Provider testability improves: integrity, durability and concurrency are
  exercised through provider-declared capabilities (`tamper`, `reopen`,
  `race`), and a missing capability is a visible skip with its reason.
- A Postgres provider can be certified against current SQLite semantics
  before any consumer depends on it, including byte-identical digests.
- SQLite remains supported for local development and single-host deployments.
  Its F1 gap must be closed or explicitly accepted before any deployment has
  more than one process writing the same file.
- The per-provider loop of `kernel-authority-store-contract.test.ts` moved into
  the conformance suite; that file keeps only SQLite implementation tests
  (file durability, schema-version refusal, malformed/unknown persisted rows,
  single-connection serialization).

## Prerequisites for FRONTERA-PROD-02

1. This contract and suite merged.
2. A decision on F1: fixed in SQLite first, or explicitly accepted for
   single-writer deployments. The Postgres provider may not inherit it.
3. Postgres provider added to `KERNEL_AUTHORITY_STORE_PROVIDER_KINDS` and
   `KERNEL_AUTHORITY_STORE_PROVIDER_PROPERTIES` in the same change as its
   implementation; configuration refuses it until then.
4. The provider wired into `kernel-authority-store-conformance.test.ts` with
   `tamper`, `race` (independent connections) and `reopen`, against a real
   Postgres in CI, with no `KNOWN_CONFORMANCE_GAPS` entry.
5. Golden digests reproduced byte-for-byte.
6. Opening a store verifies the schema version and never creates schema.
7. A read-only role can do every read and is refused every write *by the
   database*, independently of `requireKernelAuthorityOperator`.
8. A cross-process race proof beyond worker threads.
