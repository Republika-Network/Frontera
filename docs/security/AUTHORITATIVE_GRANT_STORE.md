# Authoritative Grant Store

- Status: canonical. This is the authoritative statement of how bounded grants and their revocations are persisted, what that persistence guarantees, and where the guarantee stops.
- Established by: Security & Containment Architecture track, **Prompt 4**.
- Owns: **NB-009**.
- Companion documents: `AUTHORITY_ARTIFACT_AUTHENTICITY.md` (canonical: **Prompt 5** — the cryptographic authenticity attached beside the digests described here; read it for anything about signatures, keys or rotation), `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` (canonical: the effect-path inventory and the no-bypass proof this store is the root of), `SECURITY_INVARIANTS.md` (canonical: what Frontera claims), `TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`, `THREAT_MODEL_V1.md`, `SECURITY_CONTAINMENT_BASELINE_AUDIT.md`.
- **Amended by Prompt 5.** The schema became `aoc.bounded-grant-store.schema.v2` and both tables carry four `NOT NULL` signature columns. This document's persistence *semantics* are unchanged — the amendments are marked inline and confined to §8, §9, §10.3, §20 and §22.
- **Amended by CORE-01.** The schema is now `aoc.bounded-grant-store.schema.v3`: a signed **revocation-state commitment** row, a `sequence` on each revocation, every signed record bound to a store id, and append-only triggers as defense in depth. "Not revoked" is now a signed statement rather than the absence of a row, which closes threat L (§5) for a database-only writer. Amendments are marked inline in §5, §9.1, §11.2, §15, §17 and §20; the full design is `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §26.
- Implementation: `src/enterprise/bounded-grant-store/`, `src/features/grant-runtime/domain/grant-store-port.ts`, `src/features/grant-runtime/services/in-memory-bounded-grant-store.ts`.

---

## 1. Purpose

Prompt 3 established that the strongest execution guarantee in this repository — SEC-INV-011, "no `ExecutionAdapter` call occurs unless the authoritative bounded grant has been re-read from the store and a usable exercise assessment covers the exact attempted action at that instant" — is **a chain of checks against one store**:

```
caller proposes attempt
    -> grant id
    -> authoritative store re-read
    -> current grant
    -> current revocation state
    -> exact action assessment
    -> adapter execution
```

Every link is a check *against the store*. The proof is therefore worth exactly what the store is worth, and NB-009 recorded that the store was the least hardened component in the path: one in-memory implementation, two `Map`s, an unkeyed digest on grants and no digest at all on revocations.

This document states what the store is now, what it guarantees, and — at least as importantly — the six or seven things it still does not.

## 2. Security Role

The bounded-grant store is **privileged asset A-01**. It is the only place an issued bounded grant exists, and the only place a bounded-grant revocation exists. It is read on every exercise attempt and written only by the issuance and revocation paths.

It is not a cache, not a projection and not an audit log. A grant that is not in this store does not exist; a revocation that is in this store is the fact that a grant may no longer be exercised. Nothing downstream is entitled to a second opinion about either, and nothing downstream holds one — see §6, GS-INV-002, and `execution-layer-boundaries.test.ts`.

## 3. Relationship to Prompt 3 No-Bypass Proof

Prompt 4 **strengthens the root** of the Prompt 3 proof without widening the proof's scope.

| Prompt 3 property | After Prompt 4 |
|---|---|
| The grant is re-read on every attempt, with no cache | Unchanged, and now additionally pinned by `bounded-grant-store-boundaries.test.ts` across the whole exercise path |
| The caller supplies only an id | Unchanged (SEC-INV-012), and the exercise path is now typed against a **read-only** port so it cannot reach `issue` or `revoke` at all |
| Revocation is visible to the very next exercise | Unchanged, and now survives a restart when the durable store is configured |
| The commit guard is synchronous | Unchanged, and honoured inside a real SQLite transaction rather than only inside a synchronous section |
| The adapter is invoked from exactly one call site, after the gate | Unchanged — `no-bypass-effect-paths.test.ts` still passes without modification |
| **The store is in-memory, unkeyed, singly implemented** | **Changed.** A second, durable, transactional, integrity-verifying implementation exists, and revocation is now first-class authority state |

The classification of EP-011 remains **PROVEN — PATH LOCAL**. Prompt 4 does not make it system-wide, does not add an effect path, and does not change what the proof covers. It makes the one thing the proof depends on considerably harder to subvert by accident, restart, crash or partial write — and no harder to subvert by a privileged writer, which §17, §19 and §22 state plainly.

## 4. Current Store Model Before Prompt 4

Reconstructed from source rather than from Prompt 3's summary. Every row was re-verified.

### 4.1 The port

`src/features/grant-runtime/domain/grant-store-port.ts` declared one interface:

```ts
interface BoundedGrantStorePort {
  issue(input: IssueBoundedGrantInput): Promise<IssueBoundedGrantOutcome>;
  read(grantId: string): Promise<ReadBoundedGrantResult>;
  revoke(input: RevokeBoundedGrantInput): Promise<RevokeBoundedGrantOutcome>;
}
```

`IssueBoundedGrantInput.commitGuard` is `() => GrantCommitPrecondition` — **synchronous by type**, so a store must call it with no `await` between the read that decides and the write that records.

### 4.2 Evidence table

| # | Question | Answer from source (before Prompt 4) |
|---|---|---|
| 1 | Port interface | `BoundedGrantStorePort` — `issue`, `read`, `revoke`. No `close`, no `health`, no listing, no delete |
| 2 | Implementations | **Exactly one**: `createInMemoryBoundedGrantStore` (`in-memory-bounded-grant-store.ts:36`). Two `Map`s: `grants`, `revocations` |
| 3 | Composition-root wiring | `composition-root.ts:474` — `options.authorityControlledExecution.grantStore ?? createInMemoryBoundedGrantStore()` |
| 4 | Default implementation | In-memory, unconditionally, for every persistence provider |
| 5 | Issuance path | `createGrantIssuanceService.issueGrant` → 6 checks → `store.issue({ grant, commitGuard })` (`grant-issuance-service.ts:256`) |
| 6 | Read path | `GrantExecutionService.assess` / `.exercise` → `store.read(id)` on **every** attempt (`grant-execution-service.ts:90, 154`); also `GrantIssuanceService.assessExercise` |
| 7 | Exercise path | read → clock sampled **after** the awaited read → `assessBoundedGrantExercise` → adapter, once, only if usable |
| 8 | Revocation path | `AuthorityControlledExecutionService.revokeGrant` → `GrantIssuanceService.revokeGrant` → `store.revoke` |
| 9 | Serialization format | None. Live object references held in `Map`s; nothing was ever serialized for storage |
| 10 | Digest / integrity | `boundedGrantDigest` — unkeyed SHA-256 over `serializeBoundedGrant` with `digest` held empty. Verified at **assessment** time (`grant-exercise.ts:61`, `grant-exercise-assessment.ts`), **not** at store-read time |
| 11 | What `commitGuard` protects | Duplicate issuance, prior revocation as preclusion, and re-validation of the source authorization, eligibility, subject, scope containment and validity ceilings — all inside the store's critical section |
| 12 | What it does **not** protect | Anything after issuance: it has no role in read, exercise or revocation. It also does not protect the *policy* the source decision was made under (NB-008) |
| 13 | Where revocations were stored | A **separate** `Map<string, GrantRevocation>`, keyed by grant id, in the same process, **with no integrity metadata of any kind** |
| 14a | Could issuance partially commit? | No — one synchronous section, single `Map.set` |
| 14b | Could revocation partially commit? | No — one synchronous section, single `Map.set` |
| 14c | Could reads observe intermediate state? | No — no `await` inside any critical section |
| 14d | Could restart resurrect authority? | No — restart lost **everything**, which fails closed |
| 15 | Direct writers | `GrantIssuanceService` (`issue`, `revoke`) only. Reached from `AuthorityControlledExecutionService.authorize` / `.revokeGrant` |
| 16 | Direct readers | `GrantExecutionService` (`read`), `GrantIssuanceService.assessExercise` (`read`) |
| 17 | Can a host retain a reference and bypass the API? | **Yes.** A host that supplies `grantStore` keeps the reference. This is unchanged by Prompt 4 and is a deployment trust condition (§18, D-GS3) |

### 4.3 The honest reading of "in-memory"

In-memory was **not** simply weaker. Losing a grant and its revocation *together* fails closed: the next exercise reads `GRANT_EXERCISE_NOT_FOUND` and the adapter is not called. The dangerous state was never "no persistence"; it was **partial persistence**:

| | grant survives | revocation survives | result |
|---|---|---|---|
| A (in-memory restart) | no | no | authority disappears — **FAILS CLOSED** |
| B (naive durability) | yes | no | revoked authority usable again — **FAILS OPEN** |

State B is what this entire design exists to make unreachable. GS-INV-005 states it as a rule; §7 and §11 are how it is enforced rather than promised.

## 5. Threat Model

Classification vocabulary: **BLOCKED** (the store prevents it), **PARTIALLY BLOCKED** (detected or narrowed, not prevented), **NOT ADDRESSED**, **DEPLOYMENT-DEPENDENT**, **OUTSIDE CURRENT PROMPT**.

| # | Threat | Classification | Why |
|---|---|---|---|
| A | Crash **during** issuance | BLOCKED | One `db.transaction`. An uncommitted transaction rolls back; no grant row exists, so no authority exists. Tested: `guard-throws`, `guard-refused` |
| B | Crash immediately **after** issuance acknowledgement | BLOCKED | `synchronous = FULL` + WAL: the commit is durable before `issue` resolves. Tested: `issue-survives` |
| C | Crash **during** revocation | BLOCKED | The revocation row and the grant's reference to it are written in one transaction. There is no window in which one exists without the other |
| D | Crash immediately **after** revocation acknowledgement | BLOCKED | As B. This is the fail-open shape (state B in §4.3), and it is the one the design is organised around. Tested: `revoke-survives`, `restart-monotonic` |
| E | Database / file corruption | PARTIALLY BLOCKED | Detected on every authoritative read (record digest, artifact digest, canonical round-trip, schema version) and refused. **Detection, not prevention**: the store cannot stop the bytes from being changed |
| F | Manual row modification by an operator | PARTIALLY BLOCKED | Same as E. A casual edit is caught. See G/H for the difference that matters |
| G | Attacker modifies a grant but **not** its digest | BLOCKED | `verifiedGrant` refuses. Tested: `grant-corrupt`, `grant-noncanonical`, `revocation-corrupt`, `revocation-vocabulary` |
| H | Attacker modifies a grant **and recomputes the unkeyed digest** | **NOT ADDRESSED HERE — BLOCKED BY PROMPT 5** | The digest is unkeyed by design, so a writer who can re-seal defeats every integrity check *in this document*. Prompt 5 attached a detached signature beside each digest: a database-only writer who recomputes every unkeyed digest can no longer produce usable authority (`AUTHORITY_ARTIFACT_AUTHENTICITY.md` §20 row C). Still not addressed for a writer who also holds the signing key (AA-001) |
| I | Attacker **deletes** the revocation row | BLOCKED (as a partial write) | The grant row still references it. The mismatch is inconsistent authority state and the read **refuses** — the grant becomes unreadable rather than exercisable. Tested: `revocation-deleted` |
| J | Attacker clears the grant's reference but leaves the revocation row | BLOCKED | Symmetric to I. Tested: `pointer-cleared` |
| K | Attacker deletes the **grant** row | BLOCKED (fails closed) | No grant → `GRANT_EXERCISE_NOT_FOUND` → no adapter call. Deleting a grant only removes authority. With the revocation row orphaned, the read refuses outright. Tested: `orphan-revocation` |
| L | Attacker rewrites **both** the revocation row and the grant's reference, consistently — including deleting both | **BLOCKED since CORE-01** for a database-only writer (was NOT ADDRESSED; MASTER-00 showed deletion of both made the grant live) | The signed revocation-state commitment no longer describes the rows → `REVOCATION_STATE_INCONSISTENT`. `revocation-state-integrity.test.ts` E |
| M | Duplicate issuance of the same identity | BLOCKED | `grant_id PRIMARY KEY` plus the in-transaction existence check. Resolves to `already-issued` with the **existing** grant, never a second row. Tested: `duplicate-issue` |
| N | Duplicate revocation | BLOCKED | `grant_id PRIMARY KEY` on the revocation table plus the in-transaction check. Idempotent, and the **first** revocation stands — never re-dated, never re-reasoned. Tested: `revoke-idempotent` |
| O | Replay of a stale database copy | **NOT ADDRESSED across restart** | See §17. Nothing in the store is anchored outside the file. Since CORE-01 a *running* store refuses a commitment older than one it has verified |
| P | Rollback to an older database snapshot | **NOT ADDRESSED across restart** | See §17. A backup taken before a revocation restores a live grant once the process restarts. **Do not claim anti-rollback** → CORE-07 |
| Q | Concurrent exercise and revocation (same process) | BLOCKED | `better-sqlite3` is synchronous; a read transaction and a revoke transaction cannot interleave. The read either sees the committed revocation or precedes it |
| R | Concurrent exercise and revocation (different processes) | PARTIALLY BLOCKED | SQLite serializes writers and WAL readers see a consistent snapshot. See §12 for exactly what this does and does not amount to |
| S | Concurrent issuance of the same identity | BLOCKED | One grant and one `already-issued`, never two grants (M) |
| T | Concurrent issuance and a binding change | BLOCKED (unchanged from Prompt 3) | `SEC-INV-017` — any change to the authority binding between measurement and commit refuses issuance. The guard runs inside the transaction |
| U | Process restart | BLOCKED | §13. Restart may **remove** authority (fail-closed recovery) and can never add any |
| V | Store unavailable | BLOCKED (fails closed) | §14. Exercise withholds; the adapter is not called. There is no cached grant, no last-known-good and no caller copy to fall back to. Tested: `unavailable-exercise` |
| W | Database locked / busy | BLOCKED (fails closed) | `busy_timeout` bounds the wait; after it, the operation fails and the failure is a refusal, never an authorization |
| X | Malformed persisted serialization | BLOCKED | `parseStoredGrant` is total and the canonical round-trip equality makes it unforgiving. Tested: `grant-noncanonical` |
| Y | Schema-version mismatch (database level) | BLOCKED | The store refuses to **open**, before `CREATE TABLE IF NOT EXISTS` runs, so a foreign database is not even mutated by the attempt. Tested: `db-schema` |
| Z | Schema-version mismatch (row level) | BLOCKED | A row carrying an unrecognized `schema_version` is refused on read, never reinterpreted under the current schema. Tested: `row-schema` |
| AA | Host retains a store reference and calls it directly | **NOT ADDRESSED** | §16, D-GS3. No process boundary exists. Prompt 7 |
| AB | Grant minted under a maliciously modified policy pack | **OUTSIDE CURRENT PROMPT** | §17 of `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`, NB-008. The store will faithfully persist such a grant. **Prompt 14** |
| AC | Filesystem-level replacement of the database file | **DEPLOYMENT-DEPENDENT** | §18. Application code cannot prevent an operator with write access to the data directory from replacing the file. **Prompt 17** |

Prompt 4 does **not** solve privileged DBA or host compromise, and this document never says it does.

## 6. Security Invariants

Enforced by the durable store unless a row says otherwise. Each names how it is enforced and where it is measured.

| ID | Invariant | Enforcement | Evidence |
|---|---|---|---|
| **GS-INV-001** | AUTHORITATIVE READ. Every bounded-grant exercise obtains current grant state from the authoritative store at the time of exercise. | STRUCTURAL + TEST | `grant-execution-service.ts` re-reads per attempt; `no-bypass-effect-paths.test.ts` pins read-before-gate-before-adapter |
| **GS-INV-002** | NO CALLER-SUPPLIED AUTHORITY. A caller may identify a grant but may not provide or override the authoritative contents used for exercise. | TYPE-LEVEL + STRUCTURAL + TEST | `GrantExerciseRequest` declares no grant-content field; `no-bypass-effect-paths.test.ts` enumerates the banned fields |
| **GS-INV-003** | DURABLE REVOCATION. Once a revocation reports success, that grant remains revoked after process restart. | RUNTIME + TEST | `revoke-survives`, `restart-monotonic` |
| **GS-INV-004** | NO REVOCATION LAG. Exercise correctness never depends on asynchronous propagation, a cache, a polling loop, a sweeper or a background process. | STRUCTURAL + TEST | `bounded-grant-store-boundaries.test.ts` bans caches and timers across the store, the exercise path and layer E |
| **GS-INV-005** | MATCHED DURABILITY. Any grant state that survives restart has revocation state of equal or stronger durability. | ARCHITECTURAL + RUNTIME | One file, one transaction, one fsync discipline (§7). There is no configuration in which one is durable and the other is not |
| **GS-INV-006** | ATOMIC AUTHORITY TRANSITIONS. No state is exposed in which a persisted grant is visible while its committed revocation state is lost or partially applied. | RUNTIME + TEST | Single-transaction revoke; the two-record cross-check refuses every partial state. `revocation-deleted`, `pointer-cleared` |
| **GS-INV-007** | FAIL CLOSED ON CORRUPTION. Authority state that fails integrity validation never yields a usable grant. | RUNTIME + TEST | `verifiedGrant`, `verifiedRevocation`, `currentRevocation` all throw; the exercise path turns a throw into "no grant". `exercise-corrupt` |
| **GS-INV-008** | INTEGRITY ON EVERY AUTHORITATIVE READ. Verification happens when authority state is read for authorization-sensitive use — not only at write time. | RUNTIME + TEST | `runRead` runs both verification helpers inside the transaction; pinned structurally |
| **GS-INV-009** | REVOCATION INTEGRITY. Revocation records carry integrity protection comparable to grant records. | RUNTIME + TEST | `storedRevocationRecordDigest`; `revocation_digest TEXT NOT NULL`. `revocation-corrupt`, `revocation-vocabulary` |
| **GS-INV-010** | SINGLE CURRENT AUTHORITY VIEW. A grant id resolves deterministically to one current authority state. | SCHEMA + RUNTIME | `grant_id PRIMARY KEY` on both tables; `read` returns exactly the grant named or nothing |
| **GS-INV-011** | NO SILENT REPAIR. Corrupt authority state is never re-generated, skipped or normalized into a usable grant. | RUNTIME + TEST | Canonical round-trip equality in `parseStoredGrant`; no `UPDATE`/`DELETE` of authority state exists in the store except the one-time revocation link. `grant-noncanonical`, `row-schema` |
| **GS-INV-012** | NO BACKGROUND CORRECTNESS DEPENDENCY. Correctness holds when every background job is stopped. | STRUCTURAL + TEST | No timer, interval, cron or sweeper exists in the store, the exercise path or layer E |
| **GS-INV-013** | SYNCHRONOUS ACKNOWLEDGEMENT. A mutation reports success only after the state preserving it is committed. | RUNTIME + TEST | `db.transaction(...)` returns after COMMIT; `synchronous = FULL`. `revoke-commit` reads the committed row through a second connection |
| **GS-INV-014** | RESTART MONOTONICITY. Restart may remove authority through fail-closed recovery; it may never increase it. | RUNTIME + TEST | `restart-monotonic`; every corruption path in §5 removes readability rather than adding it |
| **GS-INV-015** | EXERCISE SEMANTICS PRESERVED. Prompt 3's immediate authoritative re-read and assessment ordering are unchanged. | TEST | The Prompt 3 suite passes unmodified (§20 of the result document) |
| **GS-INV-016** | COMMIT GUARD PRESERVED. Issuance's `commitGuard` remains synchronous and semantically equivalent or stronger. | TYPE-LEVEL + STRUCTURAL + TEST | The port's type is unchanged; the durable store calls it inside the transaction with no `await` in the section, pinned by an explicit structural test |
| **GS-INV-017** | NO NEW FREE-FORM AUTHORITY PAYLOAD. Persistence introduces no arbitrary metadata that influences authorization outside the bounded-grant schema. | SCHEMA | Every column is either the canonical grant, an integrity digest, a schema version, or bookkeeping no decision reads (§8) |
| **GS-INV-018** | TENANT / BINDING STABILITY. Persistence preserves every grant binding field exactly; restart weakens or discards none. | RUNTIME + TEST | The canonical round-trip makes field-for-field equality the condition of being readable at all; `issue-survives` asserts `deepEqual` |

## 7. Persistence Architecture

### 7.1 Why SQLite, and why not a new subsystem

The repository already runs SQLite (`better-sqlite3`, a declared dependency) as the durable backend for **twelve** stores: Governance, Passport, Assurance, Kernel Authority, Access Grant, Governed Authority, Representation, Protected Resource, and the four mandate stores. `createSqliteAccessGrantStore` is the shape `grant-store-port.ts` itself names as the model to follow. Every requirement this store has is already met by that convention:

| Requirement | How SQLite meets it |
|---|---|
| Transactions | `db.transaction(...)`, synchronous, no interleaving in-process |
| Immediate reads | Same connection, same file, no replication lag |
| Deterministic writes | Hand-written SQL, no ORM, no implicit coercion |
| Crash consistency | WAL journalling with `synchronous = FULL` |
| Grant **and** revocation state | Two tables in one file — the property GS-INV-005 depends on |
| Integrity metadata | Digest columns, verified on read |
| Schema initialization | The existing `*_store_versions` guard pattern |
| Restart | Reopen the file; that is the whole test harness |
| Test isolation | A temp directory per test, or `:memory:` |

Adding a new storage subsystem would have been a larger change with a weaker argument. There was no architectural blocker, so none is reported.

### 7.2 Where it lives, and why not in `execution-governance`

`src/enterprise/bounded-grant-store/`. Two constraints forced this and both are structural tests, not preferences:

1. `grant-layer-boundaries.test.ts` forbids `src/features/grant-runtime` from importing `node:fs`, naming `better-sqlite3`, or using a dynamic `import(`. Layer E declares the port; it must not implement one against a database.
2. `authority-controlled-execution-boundaries.test.ts` forbids any dynamic `import(` under `src/enterprise/execution-governance`, and every SQLite store in this repository loads its driver with `await import('better-sqlite3')`.

So the durable store is its own module under `src/enterprise/`, exactly like every other durable store, and both boundaries stay intact.

### 7.3 Pragmas

| Pragma | Value | Why |
|---|---|---|
| `foreign_keys` | `ON` | A revocation cannot reference a grant that does not exist |
| `journal_mode` | `WAL` | Readers do not block the writer; crash-consistent commit |
| `synchronous` | **`FULL`** | Stronger than a pure audit store would need. An acknowledged revocation that a power loss could still lose is precisely the failure this store exists to remove (GS-INV-013) |
| `busy_timeout` | configured, default 5000ms | A locked file fails after a bounded wait rather than blocking forever — and the failure is a refusal (§14) |

## 8. Grant Data Model

```sql
CREATE TABLE bounded_grants (
  grant_id          TEXT PRIMARY KEY,
  grant_json        TEXT NOT NULL,   -- serializeBoundedGrant(grant), canonical bytes
  grant_digest      TEXT NOT NULL,   -- sha256: over the record envelope
  revocation_digest TEXT,            -- NULL until revoked; see §9
  committed_at      TEXT NOT NULL,   -- bookkeeping; no decision reads it
  schema_version    TEXT NOT NULL,
  -- Prompt 5. NOT NULL, so the database itself refuses to hold an unsigned
  -- authority row: "forgot to sign" is a write that fails, not a row that
  -- reads as authority.
  signature_algorithm TEXT NOT NULL,
  signing_key_id      TEXT NOT NULL,  -- a CLAIM, resolved against trusted config
  signature           TEXT NOT NULL,  -- base64url Ed25519, detached
  signature_version   TEXT NOT NULL
);
```

- **`grant_json` is the canonical form**, not a convenience serialization. `parseStoredGrant` reconstructs the grant and then requires `serializeBoundedGrant(reconstructed) === grant_json`. A row that would have to be normalized to be read is refused instead (GS-INV-011).
- **No status column.** `bounded-grant.ts` refuses a lifecycle status on the artifact because it would be "a second, independently-settable source of truth for the same fact". The persistence model does not reintroduce one.
- **No expiry column, no index on expiry.** Expiry is derived at read time from the instant the caller passes in. A column would invite a sweeper, and GS-INV-012 forbids one being load-bearing.
- **No use counter, no quota, no consumption column.** NB-006 stays open and honest — see §18.
- `committed_at` exists for operators. Nothing in the authorization path reads it; expiry is still derived from the injected instant, never the database clock.

## 9. Revocation Data Model

```sql
CREATE TABLE bounded_grant_revocations (
  grant_id          TEXT PRIMARY KEY REFERENCES bounded_grants(grant_id),
  revoked_at        TEXT NOT NULL,
  reason            TEXT NOT NULL,   -- the closed seven-value vocabulary
  issuer_ref        TEXT NOT NULL,
  revocation_digest TEXT NOT NULL,
  committed_at      TEXT NOT NULL,
  schema_version    TEXT NOT NULL,
  -- Prompt 5. Identical shape and identical strength to the grant's.
  signature_algorithm TEXT NOT NULL,
  signing_key_id      TEXT NOT NULL,
  signature           TEXT NOT NULL,
  signature_version   TEXT NOT NULL
);
```

**A revocation is authority state, not audit metadata**, and the schema says so four times: `NOT NULL` on its digest, `PRIMARY KEY` on the grant id, a foreign key to the grant it governs, and — since Prompt 5 — a signature at the same strength as the grant's. A deployment where the grant is signed and the revocation is not would make the revocation the cheaper record to forge, and forging a revocation *away* is how authority comes back.

**Schema version.** Adding these columns took the store from `aoc.bounded-grant-store.schema.v1` to `.v2`. A v1 database is **refused at open** by the existing version guard, which runs before `CREATE TABLE IF NOT EXISTS` and so does not mutate what it refuses. Unsigned rows are never reinterpreted as signed, and are never auto-signed under the current key — see `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §18 for why that migration must never be automatic.

### 9.1 The two-record cross-check

`bounded_grants.revocation_digest` holds the digest of the revocation record. Both are written in the same transaction. On every authoritative read the two must agree, and **every disagreement refuses**:

| Grant's pointer | Revocation row | Result |
|---|---|---|
| `NULL` | absent | not revoked — the grant is returned |
| set | present, digests agree | revoked — grant **and** revocation are returned |
| set | **absent** | **REFUSED** — a committed revocation is referenced but its record is gone |
| `NULL` | **present** | **REFUSED** — a revocation exists that the grant does not reference |
| set | present, digests **differ** | **REFUSED** — the grant references a different revocation than the one recorded |

This is deliberately **not** a second settable source of truth. It never answers a question the revocation row does not; its only job is that removing either half leaves evidence. And the direction matters: a disagreement can only ever be resolved toward "usable", so it is never resolved at all.

It defeats **partial** deletion (threats I and J). On its own it does **not** defeat a writer who rewrites or deletes both halves consistently (threat L) — the first row of the table above is exactly what such a writer produces.

> **CORE-01 amendment.** The first row no longer means "not revoked". Every authoritative read first verifies the signed revocation-state commitment and checks that the revocation rows present are exactly the ones it covers; a grant is "not revoked" only when that signed set does not list it. The pointer cross-check above is kept, but it is only ever a reason to refuse. See `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §26.

### 9.2 What refuses to make a grant usable

A grant does **not** become exercisable because a revocation record cannot be parsed, its table is unavailable, its digest fails, its reason is outside the closed vocabulary, or a migration cannot interpret it. Every one of those throws, and the exercise path reads a throw as "no grant".

## 10. Integrity Model

### 10.1 What is verified, and when

| Layer | Mechanism | Verified |
|---|---|---|
| Record envelope (grant) | `storedGrantRecordDigest` — unkeyed SHA-256 over format + id + schema version + canonical grant | On **every** authoritative read |
| **Signature (grant)** | **Ed25519 over the domain-separated record envelope, against the trusted key registry (Prompt 5, §10.3)** | **On every authoritative read** |
| **Signature (revocation)** | **Ed25519 under a distinct signing domain (Prompt 5, §10.3)** | **On every authoritative read** |
| Artifact (grant) | `boundedGrantDigestMatches` — the grant's own `digest` field | On every authoritative read **and** again at assessment |
| Canonical form (grant) | `serializeBoundedGrant(parsed) === grant_json` | On every authoritative read |
| Identity (grant) | `grant.id === row.grant_id` | On every authoritative read |
| Schema version (row) | `row.schema_version === BOUNDED_GRANT_STORE_SCHEMA_VERSION` | On every authoritative read |
| Record envelope (revocation) | `storedRevocationRecordDigest` | On every authoritative read |
| Vocabulary (revocation) | `isGrantRevocationReason` | On every authoritative read |
| Cross-reference | grant pointer vs revocation record (§9.1) | On every authoritative read |

The envelope digest and the artifact digest are both checked because they detect different substitutions: the artifact digest travels with the artifact and cannot vouch for *which row it is filed under*; the envelope binds the id and the schema version as well.

### 10.2 The boundary, stated plainly

> **Digest integrity is not cryptographic authenticity.**

- These digests are **unkeyed**. Anyone who can write a record can recompute its digest.
- They are **not signatures**. They carry no non-repudiation and no independent verifiability.
- They prove nothing about *who* wrote a record.
- Nothing about *these digests* may be described as tamper-proof.

What they do prove: a record whose bytes differ from the bytes that were digested is detected and refused, rather than used. That is real and it is worth having — it is also the ceiling of an unkeyed mechanism.

### 10.3 What Prompt 5 added beside them

Prompt 5 attached the key boundary at exactly the point this section anticipated. Each persisted record now also carries a **detached Ed25519 signature** over the same canonical bytes (`serializeStoredGrantRecord` / `serializeStoredRevocationRecord`), under an artifact-specific signing domain, in four columns beside each digest — verified inside `verifiedGrant`, `verifiedRevocation` and `currentRevocation`, the three call sites named in §23.

The two mechanisms are **both** retained, and in this order: digests first, signature second.

| | Unkeyed digest | Signature |
|---|---|---|
| Detects | corruption, partial writes, casual mutation | a writer who recomputed the digests |
| Needs a key to check | no | public key only |
| Proves who wrote it | no | yes — a trusted authority key vouched for these bytes |
| Failure code | `BOUNDED_GRANT_STORE_STATE_CORRUPT` | `BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED` |

Digests are checked first deliberately: they are cheap, need no key, and distinguish "the disk moved" from "no trusted key vouches for this" — two conditions that call for opposite operator responses.

**The verifier holds public material only**, so the reading path can check authority it cannot mint. The signing key is reached only from `issue` and `revoke`.

The scope of the claim has not widened: this is the **durable** store. And the signing key is, in this release, **resident in application process memory** — so "a writer who can re-seal defeats every check" is now false only for a writer who cannot reach that key. See `AUTHORITY_ARTIFACT_AUTHENTICITY.md`, particularly §21 (AA-001) and §24.

## 11. Transaction Semantics

### 11.1 Issuance

```
validate (6 checks, before the store is touched)
  -> BEGIN
  -> existence check         -> already-issued (verified) and stop
  -> preclusion check        -> refused GRANT_REVOKED and stop
  -> commitGuard()           -> refused and stop            [synchronous, no await]
  -> INSERT grant row
  -> read back through the same verification path
  -> COMMIT  (durable: synchronous = FULL)
  -> acknowledge
```

No `await` appears anywhere inside the transaction — pinned by a structural test that extracts the transaction body and asserts it. A guard that returns not-permitted writes nothing; a guard that **throws** rolls the transaction back and nothing is written either.

### 11.2 Revocation

```
resolve the grant row       -> refused GRANT_NOT_FOUND and stop
  -> BEGIN
  -> existing revocation?    -> verified, cross-checked -> already-revoked and stop
  -> dangling pointer?       -> REFUSED (corrupt)
  -> INSERT revocation row
  -> UPDATE grant.revocation_digest       [same transaction]
  -> COMMIT  (durable)
  -> acknowledge
```

**CORE-01 amendment.** The same transaction now also verifies the signed revocation-state commitment before anything is decided, and advances it (sequence + 1, new set digest, new signature — signed before the transaction, re-checked for staleness inside it) together with the row and the pointer. There is no instant at which the row exists and the commitment does not cover it. Full flow: `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §15.

A grant whose own record is corrupt **can still be revoked**. That is deliberate: recording a revocation never increases authority, and refusing to revoke an untrustworthy grant would leave it with no revocation recorded against it — the one direction this store must never take. Revocation needs the identity, and the identity is the primary key.

### 11.3 Exercise

```
store.read(id)   [one transaction: both tables, integrity verified, cross-checked]
  -> clock sampled AFTER the awaited read
  -> assessBoundedGrantExercise   (tamper, revocation, expiry, then every bound)
  -> adapter.execute(validatedAction)   -- once, only if usable
```

**No database transaction is held open across the provider effect.** The security goal is authoritative *pre-effect* state, not two-phase commit with a payment rail. Holding a write transaction across a network call would make the availability of a provider into the availability of authorization — risk R1 in `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §9.

## 12. Concurrency Semantics

Stated precisely, because the temptation to overstate it is real.

| Scenario | Single process | Multiple processes, one file |
|---|---|---|
| Issuance vs issuance, same id | **One grant, one `already-issued`.** `better-sqlite3` is synchronous; transactions cannot interleave | One grant, one `already-issued`. `grant_id PRIMARY KEY` and SQLite's single-writer rule enforce it at the database |
| Issuance vs revocation | Serialized. The preclusion check and the guard run in the issuing transaction | Serialized by SQLite's write lock |
| Revocation vs revocation | **Idempotent.** The first stands; the second reads `already-revoked` | Same, enforced by `PRIMARY KEY` on the revocation table |
| Exercise read vs revocation | The read either sees the committed revocation or precedes it. There is no partial view | WAL gives the reader a consistent snapshot. A read that began before a revocation committed may return the pre-revocation state — see below |
| Restart between operations | §13 | §13 |

> **A second store now shares these semantics.** The durable emergency-control store (`docs/enterprise/AOC_EMERGENCY_CONTROL.md` §8) is a separate SQLite file with the same pragmas, the same synchronous access model and the same single-host deployment assumption recorded here. Its read is synchronous for a reason that is specific to this store: it is called inside `BoundedGrantStorePort.issue`'s `commitGuard`, where an `await` is forbidden.

### 12.1 What is **not** claimed

- **Linearizability across processes is not claimed.** Under WAL, a reader holds a snapshot. A read transaction that began before a revocation committed in another process returns the pre-revocation state. The window is the duration of one `read` — microseconds — and it is the same window the in-memory store has between `await store.read(...)` returning and the assessment running. It is not zero, and this document does not pretend it is.
- **Multi-process correctness is a deployment assumption, not a proven property** (D-GS2). The repository composes one Enterprise Host per authority organization; that is the configuration these semantics were reasoned about. A multi-writer deployment over a shared SQLite file on a network filesystem is outside what is established here, and NFS-hosted SQLite is a known-bad configuration independent of anything in this repository.
- **No distributed guarantee of any kind is invented.** There is no consensus, no lease, no fencing token and no quorum, and nothing above should be read as implying one.

## 13. Restart Semantics

| Sequence | Outcome | Test |
|---|---|---|
| issue → close → reopen → read | Grant present, field for field | `issue-survives` |
| issue → revoke → close → reopen → read | Grant present **and** revoked | `revoke-survives` |
| issue → revoke → restart → exercise | Withheld; adapter invocation count `0` | `restart-monotonic` |
| issue → restart → re-issue same identity | `already-issued`; exactly one row | `duplicate-issue` |
| issue → revoke → restart → re-revoke | `already-revoked`; the **first** reason and instant stand | `revoke-idempotent` |
| corrupt grant → reopen → read | Refused, fail closed | `grant-corrupt`, `grant-noncanonical` |
| corrupt revocation → reopen → read | Refused, fail closed | `revocation-corrupt`, `revocation-vocabulary` |
| delete revocation row → reopen → read | **Refused**, not "live again" | `revocation-deleted` |
| clear the grant's pointer → reopen → read | **Refused** | `pointer-cleared` |
| delete grant row, orphan the revocation → read | Refused | `orphan-revocation` |
| foreign row schema version → read | Refused, never reinterpreted | `row-schema` |
| foreign database schema version → open | Refused, and the database is **not mutated** | `db-schema` |

**Restart monotonicity (GS-INV-014):** every path above either preserves authority exactly or removes it. None adds any. Restoring an older *snapshot* is a different operation and is covered in §17 — it is **not** restart, and it is **not** protected against.

## 14. Store Failure Semantics

| Operation | Store unavailable | What is explicitly **not** done |
|---|---|---|
| `read` (exercise) | Throws `BOUNDED_GRANT_STORE_UNAVAILABLE`; the exercise path turns it into `GRANT_EXERCISE_NOT_FOUND` and **withholds**. Adapter invocation count `0` | No cached grant. No last-known-good. No caller copy. No degraded mode |
| `read` (corrupt state) | Throws `BOUNDED_GRANT_STORE_STATE_CORRUPT`; same withholding | No repair. No skip. No normalization |
| `issue` | Throws; the caller sees a failure, never an issuance | Success is never reported before the commit |
| `revoke` | Throws; the caller sees a failure, never a revocation | Success is never reported before the commit |

Two error codes, in their own taxonomy (`BoundedGrantStoreError`) rather than folded into `ExecutionGovernanceError` — every code there is a *wiring* defect and these are runtime conditions, which call for opposite operator responses.

Messages name the grant id and the condition. They name **no** SQL, no file path, no driver text and no row contents: a caller who can read the store's internals from an error message has been handed a map of the authoritative state.

## 15. Composition / Dependency Injection

```
AocEnterprise (composition root)          knows SQLite, knows the path
  -> buildBoundedGrantStore(configuration)
       persistence.provider === 'sqlite'  -> createSqliteBoundedGrantStore(boundedGrant.sqlitePath)
       otherwise                          -> createInMemoryBoundedGrantStore()
  -> AuthorityControlledExecutionService   knows BoundedGrantStorePort
       -> GrantIssuanceService             knows BoundedGrantStorePort   (issue, revoke, read)
       -> GrantExecutionService            knows BoundedGrantReaderPort  (read only)
            -> ExecutionAdapter
```

- The exercise service depends on **`BoundedGrantReaderPort`** — new in this phase. It declares `read` and nothing else, so `issue` and `revoke` are not merely banned by a structural test there, they are not reachable. `BoundedGrantStorePort extends BoundedGrantReaderPort`, so every existing caller that injects the whole store still compiles: the narrowing is on the consuming side, where the capability is used.
- The execution runtime imports no storage implementation, no database driver and no filesystem — pinned structurally.
- `execution-governance` stays storage-agnostic — pinned structurally.
- **CORE-01:** under `persistence.provider === 'sqlite'`, a host-supplied `grantStore` must be the authenticated durable store (runtime brand); anything else is refused with `EXECUTION_GRANT_STORE_NOT_AUTHENTICATED` before any store is opened. Under `memory` persistence any store is accepted and module health reports `grantStore: 'unauthenticated'`.
- The composition root closes **only** the store it opened. A host-supplied store is the host's to close: it may be shared, and closing someone else's authoritative store on shutdown would make a second Host's grants unreadable.

## 16. Direct Writers and Readers

| Holder | Read | Issue | Revoke | Delete / overwrite | Production reachable |
|---|---|---|---|---|---|
| `GrantExecutionService` (exercise path) | **yes** | no — not in its type | no — not in its type | no — no such method exists | yes, via `assessExercise` / `exercise` |
| `GrantIssuanceService` | yes | yes | yes | no | yes, via `authorize` / `revokeGrant` |
| `AuthorityControlledExecutionService` | indirect | indirect | indirect | no | yes; **not HTTP-reachable** — no route issues, extends, revokes or exercises a grant |
| Composition root | no | no | no | no | it builds the store and closes it |
| A host that supplies `grantStore` | yes | yes | yes | **whatever its own implementation allows** | yes — **D-GS3** |
| Anything with filesystem write access to the database file | yes | yes | yes | yes | **D-GS1** — outside application control |

### 16.1 What was narrowed, and what was not

**Narrowed:** the exercise path, to a read-only port (§15). This is behaviour-preserving and type-enforced.

**Not narrowed, deliberately:** the port has no `delete`, no `overwrite`, no `list` and no `truncate`, and never did — so there was no destructive capability to remove. Adding a capability-split beyond the reader port would have been a redesign the prompt scopes out, and `grant-store-port.ts` is already the narrowest surface that supports issuance, exercise and revocation.

**No process isolation is claimed.** A host retaining a store reference remains a deployment trust condition until the containment prompts. Prompt 7.

## 17. Backup and Restore Risk

This is the most easily missed property in the whole design, so it gets its own section and a blunt statement:

> **Restoring an older database snapshot can resurrect a grant that was revoked after that snapshot was taken.**

Concretely: take a backup at T0 while a grant is live; revoke it at T1; restore the T0 backup at T2. Every integrity check passes — the restored records are internally consistent, correctly digested and correctly cross-referenced, because they *were* correct at T0. The store has no way to know that a later state existed.

**Classification: NOT ADDRESSED — DEPLOYMENT SECURITY REQUIREMENT.**

- There is no anti-rollback mechanism in this store, and **none is claimed**.
- Digest chaining alone would not solve it either, unless the chain head is anchored **outside** the database — in a signed, monotonic, externally-held value. That is not implemented.
- The mitigation available today is operational: treat a restore of the authority store as a security-relevant operation, and re-apply revocations recorded after the snapshot.
- **CORE-01** narrows this without closing it. Removing revocation rows is no longer enough: a rollback now needs a *previously captured* signed commitment together with the rows it covered, and a process that already verified a newer commitment refuses the older one. A restarted process cannot tell the difference. External anchoring is **CORE-07**.

Owners: **Prompt 5** may strengthen authenticity in a way that makes an external anchor possible; **Prompt 17** and operational controls own restore governance.

## 18. Deployment Assumptions

| ID | Assumption | Consequence if false |
|---|---|---|
| **D-GS1** | The database file's directory is writable only by the Frontera process user. The path comes from `AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH` (default `.data/bounded-grants.sqlite`), resolved at **boot**, never from a request. | An operator or process with write access can replace the file, re-seal records, or roll the store back. Application code cannot prevent this and does not claim to. Prompt 17 |
| **D-GS2** | One writer process per database file; local filesystem. | Multi-writer semantics beyond §12 are not established. SQLite over a network filesystem is a known-bad configuration |
| **D-GS3** | A host that supplies its own `grantStore` supplies one that honours the port's contract, and does not retain the reference for out-of-band mutation. | The no-bypass proof is only as good as the injected store. No process boundary enforces this |
| **D-GS4** | Backups of the authority store are governed as security-relevant artifacts (§17). | Rollback restores revoked authority |
| **D-GS5** | The durable store is actually configured in production (`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`). | The deployment runs the in-memory store: grants and revocations are lost together on restart, which fails **closed** but means no durability claim holds |
| **D-GS6** | The policy packs and authority world grants are minted under are themselves trustworthy. | The store will faithfully persist a grant minted under a maliciously modified policy pack. **NB-008, Prompt 14** |

## 19. Residual Risks

| ID | Risk | Why it remains | Owner |
|---|---|---|---|
| **R-GS-01** | A writer who can rewrite a record **and** recompute its unkeyed digest defeats every integrity check here (threats H and L). | The digest is unkeyed by design; a key boundary is out of scope for this prompt. | **Prompt 5** |
| **R-GS-02** | Snapshot rollback restores revoked authority (§17). | No external anchor exists. | Prompt 5 / Prompt 17 |
| **R-GS-03** | Filesystem-level replacement of the database file. | Application code cannot prevent it. | Prompt 17 |
| **R-GS-04** | A host retaining a store reference mutates authority out of band. | No process boundary. | Prompt 7 |
| **R-GS-05** | A grant minted under a maliciously modified policy pack is persisted faithfully and durably. Grant-store integrity does **not** imply authority-policy integrity. | NB-008 is untouched by this prompt, and durability arguably makes such a grant *outlive* the process in which the policy was tampered with. | **Prompt 14** |
| **R-GS-06** | A usable grant may be exercised an unbounded number of times within its window, and now survives restart while doing so. | No consumption model exists and inventing one here is structurally banned. | **Prompt 13** |
| **R-GS-07** | Cross-process read/revoke linearizability is not established (§12.1). | Single-Host deployment is the assumption. | Recorded; no owner assigned |
| **R-GS-08** | There is no global emergency deny consulted by this store. | **Partially addressed by Prompt 4, and deliberately not inside this store.** A durable operational interlock now exists (`docs/enterprise/AOC_EMERGENCY_CONTROL.md`) and is consulted *around* the bounded-grant path: at Governed Action admission, **inside this store's own synchronous `commitGuard`** at issuance, after the authoritative `runRead` at exercise, and at the selected child adapter. It lives in its own module and its own database file rather than in `runRead`, because a store that could withhold for an operational reason would be making a second kind of decision about a grant it is only supposed to report. What remains open is convergence: the Action Enforcement path's `emergencyDeny` is still separate and process-local. | **Prompt 12** |

## 20. Findings

### GS-001 — Authority-record integrity is unkeyed, so a privileged writer can re-seal

- **Severity:** MEDIUM · **Affected path:** EP-011, EP-012, EP-013 · **Asset:** A-01
- **Evidence:** `bounded-grant-record.ts` computes both record digests with unkeyed `createHash('sha256')`; `bounded-grant.ts:144-152` states the same limit for the artifact digest.
- **Threat:** a writer with database or filesystem access rewrites a grant with wider bounds, recomputes both digests, and every check in §10.1 passes.
- **Existing mitigation:** casual and accidental mutation is detected and refused; the canonical round-trip closes normalization; the two-record cross-check closes partial deletion.
- **Remediation in this prompt:** integrity extended to revocations, verified on every authoritative read, fail-closed, no silent repair. **The keying gap is not closed.**
- **Residual risk:** R-GS-01. **Future owner: Prompt 5.**
- **Disposition after CORE-01:** the un-revocation gap MASTER-00 found in the Prompt 5 disposition below (delete the revocation row and clear the pointer) is **closed** by the signed revocation-state commitment. GS-001 is now CLOSED for a database-only writer without qualification, and still OPEN for a key or configuration holder.
- **Disposition after Prompt 5: CLOSED for a database-only writer.** A detached Ed25519 signature over the same canonical bytes is verified on every authoritative read against a composition-supplied trusted public key. A writer with write access to the database file, and no access to a signing key, can alter a record and recompute every unkeyed digest and still produce nothing the read path will return — proven by the central test in `authority-artifact-authenticity.test.ts`. **Still OPEN** for a writer who also holds the signing key or can rewrite the key configuration: the key is process-resident in this release (AA-001) and the registry is deployment-controlled (AA-002). See `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §22.

### GS-002 — Snapshot rollback can restore revoked authority

- **Severity:** MEDIUM · **Affected path:** EP-011 · **Asset:** A-01
- **Evidence:** §17. No monotonic counter, chain head or external anchor exists in the schema.
- **Threat:** restoring a backup taken before a revocation makes the revoked grant exercisable again, with every integrity check passing.
- **Existing mitigation:** none in code. Operational only.
- **Remediation in this prompt:** **none.** Documented honestly rather than papered over.
- **Residual risk:** R-GS-02. **Future owner: Prompt 5 (anchor) / Prompt 17 (restore governance).**
- **Disposition after CORE-01: STILL OPEN, narrowed** — needs a captured earlier signed state rather than row deletion; detected while the process runs; not across a restart. Owner: **CORE-07**.
- **Disposition after Prompt 5: STILL OPEN — NOT ADDRESSED.** Signatures authenticate, they do not timestamp. Every artifact in a restored snapshot is validly signed, including grants whose revocations were rolled back with them, so a signature check passes exactly as a digest check did. Restated as AA-003. No anchor was added; none is claimed.

### GS-003 — The durable store is available but is not the default for every deployment

- **Severity:** LOW · **Affected path:** EP-011, EP-012, EP-013
- **Evidence:** `composition-root.ts` selects the durable store only when `persistence.provider === 'sqlite'`; that provider defaults to `memory`.
- **Threat:** a deployment that believes grants are durable but never set the variable runs the in-memory store.
- **Existing mitigation:** the failure mode is fail-**closed** (grants and revocations are lost together); the composition option's doc comment states the selection rule; D-GS5 records it.
- **Remediation in this prompt:** the conditional claim language in §21 and §22 — no artifact may say "Frontera durably stores grants" without the configuration clause.
- **Residual risk:** a misconfigured deployment loses grants on restart. It never gains any.
- **Future owner:** Prompt 17 (deployment topology), which owns default posture across the product.

### GS-004 — Revocation records previously carried no integrity protection at all

- **Severity:** MEDIUM (as it stood) · **Status: CLOSED for the durable store, unchanged for the in-memory store**
- **Evidence:** before this prompt, `GrantRevocation` was held in a plain `Map` with no digest; NB-009 recorded it as an input to Prompt 5.
- **Threat:** in a durable implementation built without this property, the revocation would have been the cheaper record to forge — inverting the fail-closed direction.
- **Remediation in this prompt:** `storedRevocationRecordDigest`, `revocation_digest TEXT NOT NULL`, verification on every authoritative read, closed-vocabulary validation, and the §9.1 cross-check.
- **Residual risk:** the in-memory store still holds revocations as live objects with no digest. That is correct for it — nothing is serialized, so there are no bytes to protect, and process memory integrity is SEC-TRUST-001.

### 20.1 Disposition of inherited findings

| Finding | Disposition | Basis |
|---|---|---|
| **NB-009** | **PARTIALLY CLOSED — REFINED** | The three defects it named are now separable. *In-memory only*: **closed** — a production-capable durable implementation exists, selected by configuration. *Singly implemented*: **closed** — two implementations, contract parity asserted from one script. *Unkeyed*: **OPEN**, carried forward as GS-001 to Prompt 5. The specific fail-open shape NB-009 warned about — "a durable store that persists grants while losing or lagging revocations" — is **closed** by GS-INV-005/006 and tested |
| **NB-006** | **OPEN — ACCEPTED CURRENT SEMANTICS** | No consumption model was added; the durable schema has no counter, quota or decrement column, and a structural test pins that. Durability makes the existing property *persist across restart*, which is a widening of exposure in time and is recorded as R-GS-06. **Prompt 13** |
| **NB-008** | **OPEN — OUTSIDE PROMPT 4** | Untouched. §17 above and R-GS-05 preserve the distinction: grant-store integrity does **not** imply authority-policy integrity. **Prompt 14** |
| **SEC-TRUST-003** | **REFINED** | "The default bounded-grant store is in-memory" is still true of the default persistence provider, and is now false of a SQLite-configured deployment |

## 21. Security Claims

Defensible, in exactly this wording:

1. > "When the durable bounded-grant store is configured, issued grants and revocations survive process restart with transactional persistence, authoritative re-read and fail-closed integrity validation."

2. > "On the bounded-grant execution path, authorization is checked against current authoritative persisted grant and revocation state immediately before effect execution."

3. > "A revocation that the store has acknowledged cannot be lost to a crash, a restart, or a partial write, because the revocation record and the grant's reference to it commit in one transaction to one durable file."

4. > "Persisted grant and revocation state is integrity-verified on every authorization-sensitive read, and state that fails validation yields no usable grant — it is never repaired, skipped or normalized."

5. > "Restart cannot increase authority under the implemented store semantics."

6. > "Frontera now has a hardened durable authoritative grant store **when configured**."

Every one of claims 1–5 is PATH-LOCAL to bounded-grant exercise, issuance and revocation, and claim 6 carries its configuration clause. Restating any of them without that scope is an overclaim.

## 22. Claims We Must Not Make

| Claim | Why it is false or unproven |
|---|---|
| "The grant store is tamper-proof." | Still false. Prompt 5 blocks a *database-only* writer; an attacker holding the signing key or the key configuration forges freely (AA-001, AA-002) |
| "Grants are cryptographically signed / authenticated." | **True as of Prompt 5, for the durable store only** — `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §23. It was false when this document was written, and it remains false for the in-memory store and for every other authority artifact in the repository. SEC-INV-U01 is now PARTIALLY IMPLEMENTED, not satisfied: the signing key is process-readable |
| "A privileged host or DBA cannot modify authority." | They can. D-GS1, D-GS3, R-GS-03, R-GS-04 |
| "Rollback of an old database snapshot cannot restore old authority." | It can. §17, GS-002. **Not proven, not implemented** |
| "All Frontera authority is now durable." | False. Recognition state, approvals, capability-token revocation, the policy pack registry and the Action Enforcement `emergencyDeny` all remain in-process. The bounded-grant store changed in Prompt 3; Prompt 4 added a separately-configured durable emergency-control store on its own file, under the same `persistence.provider === 'sqlite'` condition and with the same in-memory default |
| "Frontera has a global kill switch." | False. Prompt 4 added a durable operational interlock for the **bounded-grant / Governed Action path only**, and it is opt-in. `AocKernel.enforce()`, Sovereign Access and Content Protection honour nothing of the sort (SEC-INV-U05) |
| "Frontera durably stores grants by default." | False as stated. The durable store is selected when `persistence.provider === 'sqlite'`; the default provider is `memory` (GS-003, D-GS5) |
| "The store guarantees linearizable multi-process reads." | Not claimed and not established. §12.1 |
| "Revocation is enforced at the provider." | Out of scope here entirely. Provider-side enforcement is `src/enterprise/access-governance`'s separate concern |
| "A bounded grant authorizes a single use." | Still false. NB-006, R-GS-06 |
| "Digest verification is signature verification." | It is not. §10.2 |

## 23. Inputs to Prompt 5

> **Consumed.** Prompt 5 is implemented; see `AUTHORITY_ARTIFACT_AUTHENTICITY.md`. The attachment point below was followed as written — a detached signature over the same two canonical serializations, in columns beside each digest, verified in the same three helpers, with no change to the control flow. The table is retained as the record of what was handed over. The row "what must **not** change about store semantics" was honoured in full and is re-verified by the 28 unmodified durability tests.

**Prompt 5 — Introduce Cryptographic Authenticity for Authority Artifacts.**

| Question | Answer |
|---|---|
| Which persisted artifacts need authenticity? | `bounded_grants` rows and `bounded_grant_revocations` rows. **Both**, and at the same strength — a revocation weaker than a grant inverts the fail-closed direction (GS-004) |
| Current canonical serialization | `serializeStoredGrantRecord(grant)` and `serializeStoredRevocationRecord(revocation)` in `bounded-grant-record.ts`. Deterministic, lexicographic, whitespace-free, schema-version-bound, round-trip-verified |
| Current digest fields | `bounded_grants.grant_digest`, `bounded_grant_revocations.revocation_digest`, and the artifact's own `BoundedGrant.digest`. All three unkeyed SHA-256 |
| Which records use unkeyed digests | All of the above, plus the Governance Store's `computeDigest` (out of scope here) |
| Where verification occurs | `verifiedGrant`, `verifiedRevocation` and `currentRevocation` in `sqlite-bounded-grant-store.ts` — all inside the read transaction; and `boundedGrantDigestMatches` again at assessment. **These are the exact call sites a signature check attaches to** |
| Which privileged writer can re-seal | Anyone with write access to the database file or the process. D-GS1, D-GS3, SEC-TRUST-001 |
| What key boundary Prompt 5 must introduce | A signing key the application process cannot read (SEC-INV-U01/U02). Suggested shape: a `signature` column beside each digest, a detached signature over the same canonical bytes, verified in the same three helpers. The read path already fails closed on a failed check, so the control flow needs no change |
| What must **not** change about store semantics | The synchronous `commitGuard` type; the per-attempt re-read with no cache; the reader-port narrowing on the exercise path; the no-sweeper property; the two-record cross-check; the absence of any consumption model; the fail-closed direction of every refusal |
| The one thing to keep distinct | **Storage integrity** (this document: the bytes are the bytes that were written) versus **cryptographic authenticity** (Prompt 5: the bytes were written by an authorized issuer, provably, to a party that does not hold the writing key). Prompt 4 delivers the first and claims only the first |

---

## Change Control

1. A new `BoundedGrantStorePort` implementation must be added to §4.2 and §16 before it ships, and must satisfy every GS-INV in §6.
2. A GS-INV may only be strengthened by evidence. Changing the prose is not promotion.
3. §21's claims travel with their scope. A restatement omitting "when the durable store is configured" or "on the bounded-grant path" is an overclaim.
4. §22 is not advisory. Adding a §21 claim that contradicts a §22 row requires deleting that row, and deleting it requires the evidence that makes it false.
5. Findings close on evidence, not on documentation. GS-001 and GS-002 close when a key boundary and an external anchor exist, not when this document is edited.
6. Any column added to either table must be justified against GS-INV-017 (no free-form authority payload) and GS-INV-012 (nothing that invites a sweeper).
