# ANDREW-P0-02 — Destination Registry

| | |
| --- | --- |
| Task | ANDREW-P0-02 — Andrew Demo — Destination Registry |
| Branch | `feat/andrew-p0-02-destination-registry` |
| Baseline | `6aa865bff47ec15ed40ae167d230ca61fc90f92c` (`feat/andrew-demo`, P0-00 + P0-01 merged) |
| Status | Implemented, uncommitted, not pushed |

> **P0-02 does not implement destination approval.** It records which
> destinations Frontera *knows*. A registered destination is exactly as
> unapproved as an unregistered one.

## 1. Objective

Give Frontera a small, durable, deterministic registry that can answer, from
trusted server-side state and never from a request's claim:

1. Is this exact `ExecutionDestination` known? → `unknown` | `known`
2. If known, which canonical record represents it?
3. Who or what recorded it, and when?
4. Is that still true after a process restart?
5. Does a retried or concurrent registration stay one record?
6. Is the destination's P0-01 identity preserved byte-for-byte?

Four concepts stay separate:

| concept | question | owner |
| --- | --- | --- |
| Destination identity | what is the destination? | P0-01 (`destination-runtime/domain`) |
| **Registry membership** | **does Frontera know about it?** | **P0-02 (`destination-runtime/registry`, `enterprise/destination-registry`)** |
| Governance / approval | may it be used, under which authority and scope? | P0-03+ (not implemented) |
| Rail validity | is it a valid address on its rail? | rail-specific code (not implemented) |

## 2. Starting Baseline

Verified before any change:

| check | result |
| --- | --- |
| path | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-02` (the P0-02 isolated worktree) |
| branch | `feat/andrew-p0-02-destination-registry` |
| working tree | clean |
| `HEAD` | `6aa865b` = `feat/andrew-demo` (`merge: Andrew P0-01 destination semantics`) |
| P0-01 present | `src/features/destination-runtime/{domain/execution-destination.ts, tests/, README.md}`, `docs/demo/andrew/ANDREW-P0-01-DESTINATION-SEMANTICS.md` |

As in P0-00/P0-01, the worktree's `.git` file points at a Windows path that WSL
`git` cannot resolve, so git was run read-only with Windows Git (`git.exe`). The
pointer was not modified. Toolchain: WSL2 Linux, Node v22.23.1, `npm ci`.

## 3. Architectural Placement

The repository's existing split, reused exactly (precedent:
`features/emergency-control-runtime` + `enterprise/emergency-control`):

```
src/features/destination-runtime/
  domain/                         P0-01 identity — unchanged
  registry/                       P0-02 — port, record, input checks, in-memory provider
    destination-registry.ts
    in-memory-destination-registry.ts
    index.ts                      separate entry point; the root index.ts does NOT export it
  tests/
    destination-boundaries.test.ts            P0-01, now scoped to domain/ + index.ts
    destination-registry-boundaries.test.ts   P0-02
src/enterprise/destination-registry/          P0-02 — durable better-sqlite3 provider
  sqlite-destination-registry.ts
  index.ts
src/enterprise/__tests__/
  destination-registry.test.ts                contract (both providers) + durability + concurrency
  destination-registry-concurrency-worker.ts
```

Why:

- **Feature runtimes are pure; storage lives in the enterprise layer.** Every
  durable store in the repository (`execution-outcome-store`,
  `emergency-control`, `bounded-grant-store`, …) is a `better-sqlite3` module
  under `src/enterprise/`, implementing a port declared by a feature runtime.
- **SQL stays out of the P0-01 value object.** `domain/` is untouched. The
  registry is a separate entry point, so `destination-runtime/index.ts` remains
  the import-free identity primitive its P0-01 boundary test describes.
- **Not composed into the Host, not in the public barrel.** `src/enterprise/index.ts`
  is unchanged (it is part of the frozen API surface); nothing wires the
  registry yet.

## 4. Registry Model

```ts
interface DestinationRegistration {
  readonly destination: ExecutionDestination;   // P0-01 identity, frozen copy
  readonly destinationKey: string;              // executionDestinationKey(destination)
  readonly registeredBy: string;                // provenance of the *recording*
  readonly registeredAt: string;                // injected clock, canonical ISO instant
}
```

Nothing else. No `approved`, `approvalStatus`, `approvedBy`, `approvedAt`,
`revoked`, `revokedAt`, `expiry`, `allowed`, `trusted`, `authorized`, `status`
or label — in the type, the SQL schema, or any result.

API (`src/features/destination-runtime/registry/index.ts`):

```ts
interface DestinationRegistryReaderPort {
  lookup(destination: ExecutionDestination): DestinationLookup;
}
interface DestinationRegistryPort extends DestinationRegistryReaderPort {
  register(input: { destination: ExecutionDestination; registeredBy: string }): DestinationRegisterResult;
}

type DestinationLookup =
  | { membership: 'unknown'; destinationKey: string }
  | { membership: 'known';   registration: DestinationRegistration };

type DestinationRegisterResult =
  | { outcome: 'registered'; registration: DestinationRegistration }
  | { outcome: 'existing';   registration: DestinationRegistration };   // the original record

createInMemoryDestinationRegistry({ now })                    // features — not durable
createSqliteDestinationRegistry(dbPath, { now, busyTimeoutMs? })  // enterprise — durable; adds close()
```

Errors are `DestinationRegistryError` with one of
`DESTINATION_REGISTRY_INPUT_INVALID`, `DESTINATION_REGISTRY_UNAVAILABLE`,
`DESTINATION_REGISTRY_CORRUPT`. None of them is an authorization outcome.

Deliberately absent: `has()` (the `membership` discriminant already is the
answer, and conventions here favour explicit result types over booleans),
`getByKey()` (no caller needs a key-only lookup; every caller holds a
destination), update, rename, delete, approve, revoke, expire. The reader port
is separate so a future consumer that only needs membership cannot reach
`register`.

**Synchronous by design,** like `EmergencyControlReaderPort`: `better-sqlite3`
answers synchronously, so a later trusted-context resolver or commit-boundary
recheck can consult membership without an `await` between read and decision.

## 5. Identity and Keying

- Every destination, on `register` and on `lookup`, enters through P0-01's
  `parseExecutionDestination`. A destination carrying any extra field
  (`approved`, `trusted`, `status`, …), an accessor, a malformed namespace or a
  malformed identifier is refused with `DESTINATION_REGISTRY_INPUT_INVALID` —
  never read as `unknown`.
- The key is P0-01's `executionDestinationKey` (`<namespace>:<identifier>`).
  No second identity algorithm, no hash, no separator of the registry's own; a
  structural test fails the build if one appears.
- Nothing is trimmed, case-folded or Unicode-normalized. SQLite columns use
  the default `BINARY` collation (no `NOCASE`, tested), so comparison is
  byte-exact and case-sensitive, as in P0-01.
- `network-a:abc` ≠ `network-b:abc` ≠ `network-a:ABC`. Prefix namespaces
  (`network-a` vs `network-a.testnet`) and separator confusion (`net` / `a:b`
  vs `net.a` / `b`) never collide; a namespace containing `:` is refused at
  ingress.
- **No namespace list.** Any namespace P0-01 accepts can be recorded. Which
  namespaces a deployment serves is trusted configuration's fact — recorded
  here as a P0-04 item, not hardcoded.

## 6. Persistence

`createSqliteDestinationRegistry` follows `sqlite-execution-outcome-store.ts`:

```sql
CREATE TABLE destination_registry_versions (id, schema_version, migration_state, recorded_at);
CREATE TABLE registered_destinations (
  destination_key TEXT PRIMARY KEY,
  namespace       TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  registered_by   TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  UNIQUE (namespace, identifier)
);
-- triggers: BEFORE UPDATE / BEFORE DELETE → RAISE(ABORT, 'registered destinations are immutable')
```

- Schema `aoc.destination-registry.schema.v1`, in **its own database file**
  chosen by the caller. Purely additive: no existing table, column, file or
  migration is touched. No new dependency (`better-sqlite3` is already used by
  the repository's other stores).
- `journal_mode = WAL`, `synchronous = FULL`: a registration is durable before
  `register` returns.
- Initialization is one `BEGIN IMMEDIATE` transaction that reads the version
  before any `CREATE`. An empty file is initialized and recorded `current` once;
  reopening appends nothing; a file under an unknown schema version is refused,
  unmutated. All three are tested.
- Every row read is re-validated: re-parsed through P0-01, its key recomputed
  and compared with both the stored key and the lookup key, `registered_by`
  and `registered_at` re-checked. Failure is `DESTINATION_REGISTRY_CORRUPT` —
  never `unknown`, never repaired.
- Local only. No Supabase, no hosted database, no network.

## 7. Idempotency

**The first record stands; a retry is `existing` with the original record.**

| call | result |
| --- | --- |
| `register(D, by: A)` on an empty registry | `registered`, record `{D, key, A, t1}` |
| `register(D, by: A)` again | `existing`, the same record — clock not sampled, nothing written |
| `register(D, by: B)` | `existing`, the same record — **still `A`, `t1`** |
| `register(D', …)` where `D'` differs only in case | `registered` — a different destination |

This matches `execution-outcome-store` (`prepared`/`existing`, never
last-write-wins). A retry with different provenance is not a conflict: the
fact being recorded is membership, which is identical, and the original
recording remains the authoritative provenance. The retry's provenance is
**not** recorded (no event log in P0-02); its caller can see from the returned
record that it was not the registrant.

Duplicates are prevented structurally three times over: the `BEGIN IMMEDIATE`
check-then-insert under the write lock, the `destination_key` primary key, and
`UNIQUE (namespace, identifier)` (which also refuses a raw row with a forged key).

## 8. Provenance

- `registeredBy`: an opaque, descriptive reference (1–256 printable ASCII
  characters, no whitespace) to the operator, service or process that recorded
  the destination — e.g. `operator:ops-1`. Same model as emergency control's
  `issuerRef`.
- `registeredAt`: sampled from the injected `now()` **inside** the write
  transaction, after the lock is held. A non-canonical instant refuses the
  write (`DESTINATION_REGISTRY_UNAVAILABLE`). No `Date.now()` anywhere in the
  registry (structurally tested).

Limitation, stated: there is no signature or digest over a row, so
`registeredBy` proves nothing cryptographically. It is not a credential, not
an authority, and never means "approved by". A stronger actor type
(`approval-authority`, `operator-control`) exists only in the enterprise
service layer; importing it into a feature port would invert the layer
dependency, so it was not reused. A later task composing the registry into an
operator surface should populate `registeredBy` from the authenticated
principal, never from request data.

## 9. Unknown vs Known Semantics

```
Destination identity:
  namespace  = network-a
  identifier = abc123

Registry:
  register → { outcome: 'registered', registration: { …, registeredBy: 'operator:ops-1', registeredAt: … } }
  lookup   → { membership: 'known', registration: … }      known = true

Governance approval:
  NOT IMPLEMENTED
```

```
Destination identity:
  namespace  = network-a
  identifier = xyz789

Registry lookup:
  { membership: 'unknown', destinationKey: 'network-a:xyz789' }      NOT FOUND
```

`unknown` is the absence of a record — **not** "denied", "blocked" or "held".
What an unknown destination means for an action is a governance decision for
P0-03. A malformed destination or an unreadable store is an error, never
`unknown`, so an outage or a bad input cannot quietly turn into "not known".

**No request self-assertion.** A governed action request cannot say
`destinationKnown = true`: the registry exposes no such input, P0-01 refuses
any destination carrying one, and membership is something a trusted resolver
derives by calling `lookup`. P0-02 does not modify the governed-action request
or the context resolver; the future integration point is a trusted-context
source that calls `DestinationRegistryReaderPort.lookup` on the server-resolved
destination.

## 10. Why Registration Is Not Approval

**REGISTERED ≠ APPROVED.** A record means only: *Frontera has a durable record
identifying this destination.* It does not mean the destination may receive
funds, is trusted, is approved, or is allowed for any agent, organization,
asset, amount or action. Enforced by:

- the record type has exactly four fields (tested on the type and at runtime);
- the SQL table has exactly six columns, none governance (tested);
- `register` refuses any request or destination carrying `approved`,
  `approvedBy`, `approvedAt`, `approvalStatus`, `status`, `trusted`, `allowed`,
  `authorized`, `revokedAt`, `expiresAt`, `known` or `label` (tested);
- no result serializes anything matching approval/trust/status/revocation/
  expiry/grant vocabulary (tested);
- the registry source contains no such vocabulary in code, and imports no
  Kernel, grant, policy, approval, execution or governed-action module
  (structural test).

## 11. Relationship to Counterparty

Unchanged. No grant format, signed artifact, Kernel contract, approval subject
or `counterparty` semantics were touched. The likely future relationship, not
wired:

```
ExecutionDestination
  → executionDestinationKey  (also the registry's primary key)
  → existing counterparty identity axis (P0-01 proved every key is an admissible counterparty value)
```

So a later task can check membership and bind the very same key as the grant
counterparty without a grant-format change. Whether to do that or to add a
dedicated destination axis is a P0-03+ decision.

## 12. Security Invariants

| # | invariant | how |
| --- | --- | --- |
| 1 | Registration never implies approval | no governance field anywhere; extra fields refused; structural vocabulary ban |
| 2 | Membership cannot be self-asserted by a request | no input for it; derived only by `lookup` on trusted state |
| 3 | One destination, one record | `BEGIN IMMEDIATE` + PK + `UNIQUE(namespace, identifier)`; parallel worker-thread race test |
| 4 | Identity is never re-spelled | P0-01 ingress on every input; P0-01 key; BINARY collation; no trim/fold/normalize (structural test) |
| 5 | Identity is immutable | frozen copies in and out; `UPDATE`/`DELETE` triggers; no update/delete API |
| 6 | Provenance is never rewritten | first record stands on retry; `UPDATE` refused |
| 7 | Damage is never read as `unknown` | every row re-validated; failure is `CORRUPT` |
| 8 | No ambient time or randomness | injected clock only (structural test) |
| 9 | Different namespaces never collide | namespace is part of the key; prefix/separator tests |

## 13. Tests

New:

- `src/enterprise/__tests__/destination-registry.test.ts` — the contract run
  against **both** providers (in-memory and SQLite), plus SQLite-only
  durability and concurrency:
  - unknown → `unknown` with key; register → `registered`; lookup → `known`, identity deep-equal to P0-01, `sameExecutionDestination`, key = `executionDestinationKey`;
  - same identifier / different namespace; prefix and separator confusion;
  - case preserved and significant; whitespace / zero-width / Cyrillic / combining / full-width spellings refused, not repaired;
  - exact duplicate and different-provenance retry → `existing`, original `registeredBy`/`registeredAt`, clock not sampled; ten replays deterministic;
  - malformed destinations (null, string, array, `Map`, missing/empty fields, 192-char and 1,000,000-char identifiers, 65-char namespace, non-string) refused for both `register` and `lookup`;
  - approval-implying metadata on the destination or the request refused, nothing recorded;
  - malformed `registeredBy` and accessor-bearing requests refused;
  - record/lookup shapes exact; no approval vocabulary in any result;
  - caller mutation after `register` reaches nothing; returned records frozen;
  - non-canonical clock answers write nothing;
  - **restart:** process A registers and closes; process B reopens the same file, reads the identical record, and a re-registration is `existing`;
  - initialization idempotent over three openings (one version row); unknown schema version refused unmutated;
  - schema has exactly six columns; `abc`/`ABC` are two rows;
  - raw `UPDATE`/`DELETE` refused by triggers; raw duplicate refused by PK and by `UNIQUE` even under a forged key;
  - seven corrupted-row variants → `CORRUPT` on lookup and register;
  - closed store refuses; two connections in one process converge;
  - **concurrency:** 6 worker threads × 3 rounds, separate connections, barrier-released → exactly one `registered`, five `existing`, all naming the winner's provenance, one row; 4 workers on a brand-new file → one version row, one registration row.
- `src/features/destination-runtime/tests/destination-registry-boundaries.test.ts` —
  registry imports only itself and P0-01; durable store imports only the
  destination runtime, `better-sqlite3`, `node:fs`, `node:path`; no Kernel /
  grant / policy / approval / execution / governed-action / configuration /
  HTTP / rail-SDK / hosted-DB import; no ambient clock, randomness, network,
  process or code construction; no rail vocabulary or namespace list; no
  approval/trust/authorization/revocation/expiry/status vocabulary; no
  normalization or `NOCASE`; no hashing or second key algorithm; port methods
  exactly `lookup` + `register`; record fields exactly four; not exported from
  the P0-01 barrel or `src/enterprise/index.ts`.

Changed: `destination-boundaries.test.ts` (P0-01) now scans `domain/` and the
root `index.ts` — the identity primitive it describes — instead of the whole
directory; every one of its assertions is unchanged and still applies there.

### 13a. Results

WSL2 Linux, Node v22.23.1, after `npm ci`:

| step | result |
| --- | --- |
| `npm run typecheck` / `npm run build` (`tsc -b`) | exit 0 |
| `npm run lint` | node16 imports, architecture and public-surface lint passed |
| focused: `destination-runtime/tests/*` + `enterprise/__tests__/destination-registry.test.js` | 131 tests, 131 pass (P0-01 tests included) |
| `npm run test:root` | 9062 tests, 9047 pass, **2 fail (inherited)**, 9 skipped, 4 todo |
| `npm run test:workspaces` | 1089 tests, 1089 pass, 0 fail |
| **total** | **10151 tests, 10136 pass, 2 fail, 9 skipped, 4 todo** |

Against P0-01 (10091 / 10076 / 2 / 9 / 4): +60 tests, +60 passes, no new
failure. The two failures are the same CRLF/source-scanning environment
artifacts inherited from P0-00 —
`authority-administration-service.test.ts:334` (CTRL-01 structure) and
`structural-boundaries.test.ts:282` (`loadEnterpriseConfiguration` regex) —
and were not touched. Grant, counterparty, Kernel, CORE-08 neutrality and
structural-boundary suites are part of `test:root` and pass.

## 14. Files Changed

| file | change |
| --- | --- |
| `src/features/destination-runtime/registry/destination-registry.ts` | new — record, ports, results, errors, input checks |
| `src/features/destination-runtime/registry/in-memory-destination-registry.ts` | new — process-local provider |
| `src/features/destination-runtime/registry/index.ts` | new — registry entry point |
| `src/features/destination-runtime/tests/destination-registry-boundaries.test.ts` | new — structural boundary |
| `src/features/destination-runtime/tests/destination-boundaries.test.ts` | scan scoped to the identity primitive |
| `src/features/destination-runtime/README.md` | documents the registry |
| `src/enterprise/destination-registry/sqlite-destination-registry.ts` | new — durable provider |
| `src/enterprise/destination-registry/index.ts` | new — barrel |
| `src/enterprise/__tests__/destination-registry.test.ts` | new — contract, durability, concurrency |
| `src/enterprise/__tests__/destination-registry-concurrency-worker.ts` | new — race participant (test scaffolding) |
| `docs/demo/andrew/ANDREW-P0-02-DESTINATION-REGISTRY.md` | new — this document |

Not changed: `domain/execution-destination.ts`, the root `destination-runtime/index.ts`,
Kernel, grant runtime, governed action, context resolution, approval, any
existing store or schema, `src/enterprise/index.ts`, `package.json`.

## 15. Impact on ANDREW-P0-03

P0-03 can call `DestinationRegistryReaderPort.lookup` to obtain trusted
membership. It must decide, outside this registry:

- **Governance state and its scope** — approval per organization / agent /
  asset / amount / action, with its own provenance, revocation and expiry, in
  a separate record keyed by `destinationKey`. Not columns added here.
- **Tenant scope of membership.** The registry is deployment-wide, as the
  brief frames it ("known to Frontera"). If one organization must not learn
  that another registered a destination, P0-03 should scope approval per
  organization and keep membership out of tenant-facing responses — or a
  later schema version adds an organization column (additive).
- **Trusted-context wiring** — a server-side source that resolves the
  destination and calls `lookup`; the request never supplies membership.
- **Unknown-destination outcome** — HOLD vs DENY is a governance decision; the
  registry only says `unknown`.
- **Counterparty binding** — bind `destinationKey` as the counterparty, or add
  a dedicated axis (§11).
- **Composition** — choosing the registry's file path, composing it into the
  Host, and populating `registeredBy` from an authenticated principal.

For P0-04: which namespaces a deployment accepts belongs to trusted
configuration.

## 16. Explicitly Out of Scope

Not implemented, deliberately: approval, approval status, approval route or
admin command, revocation, expiration, policy evaluation, unknown-destination
HOLD/DENY, obligations, reevaluation, trusted-context integration, Kernel
changes, grant changes, the $75,000 policy, XRPL, Testnet, signer, payment
execution, Lumx, Lightning, UI, external APIs, Host composition, public-barrel
export, event history of retries, deletion.

## 17. Final Verdict

**A. DESTINATION REGISTRY COMPLETE — READY FOR ANDREW-P0-03**

The registry answers `unknown` / `known` durably, deterministically and
idempotently, keyed by P0-01's unchanged identity, with no approval semantics
and no change to the Kernel, grants, counterparty, governed action or any
existing store. The open questions in §15 (governance scope, tenant scope of
membership, trusted-context wiring, unknown-destination outcome) are P0-03's
design work, not defects here.
