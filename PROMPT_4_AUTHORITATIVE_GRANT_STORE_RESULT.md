# Prompt 4 — Harden the Authoritative Grant Store — Result

- Track: Security & Containment Architecture, Prompt 4.
- Canonical artifact: `docs/security/AUTHORITATIVE_GRANT_STORE.md`.
- Base: `main` @ `1ea820a` (Prompts 0, 1, 2, 2.5, 2.6 and 3 all merged).
- Branch: `claude/great-lamport-7srq7j` — **harness-mandated**, diverging from the prompt's preferred `claude/frontera-authoritative-grant-store`. Reported rather than silently substituted.
- Production behaviour changed: **YES** — a new production-capable durable store, and a composition-root selection rule. See §8.

---

## 1. What this prompt owned

Prompt 3 proved SEC-INV-011 — no adapter call without an authoritative grant re-read and a usable exercise assessment — and recorded that the whole proof is a chain of checks against **one store**, which was in-memory, unkeyed and singly implemented (**NB-009**).

The objective here was to harden that store without widening the proof, without inventing consumption semantics (NB-006), and without claiming anything the code does not do.

## 2. The distinction the design is organised around

|  | grant survives | revocation survives | result |
|---|---|---|---|
| A — in-memory restart | no | no | authority disappears — **FAILS CLOSED** |
| B — naive durability | yes | no | revoked authority usable again — **FAILS OPEN** |

State B is worse than no persistence at all. The governing rule is that a grant's durability is never stronger than its revocation's, and it is enforced structurally rather than promised:

1. **One database file** — no configuration in which one is durable and the other is not.
2. **One transaction** — the revocation record and the grant's reference to it commit together or not at all.
3. **One fsync discipline** — WAL with `synchronous = FULL`, so acknowledgement never precedes durability.
4. **Two records that vouch for each other** — deleting either half leaves evidence, and the read **refuses** rather than resolving the disagreement toward "usable".

## 3. What was built

| Component | Path |
|---|---|
| Durable store | `src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts` |
| Record canonicalization + integrity | `src/enterprise/bounded-grant-store/bounded-grant-record.ts` |
| Store error taxonomy | `src/enterprise/bounded-grant-store/errors.ts` |
| Read-only port for the exercise path | `BoundedGrantReaderPort` in `src/features/grant-runtime/domain/grant-store-port.ts` |
| Composition selection | `buildBoundedGrantStore` in `src/enterprise/composition/composition-root.ts` |
| Configuration | `boundedGrant.sqlitePath` / `AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH` |

It lives under `src/enterprise/` rather than in the grant runtime or in `execution-governance` because two existing structural tests forbid it anywhere else: layer E may not name `better-sqlite3` or use a dynamic `import(`, and `execution-governance` may not use a dynamic `import(` either. Both boundaries stay intact.

## 4. Eighteen store invariants

GS-INV-001 … GS-INV-018, each with an enforcement mechanism and a test. Full table in `AUTHORITATIVE_GRANT_STORE.md` §6. The load-bearing ones: authoritative read (001), durable revocation (003), matched durability (005), atomic transitions (006), fail-closed corruption (007), integrity on every read (008), revocation integrity (009), no silent repair (011), synchronous acknowledgement (013), restart monotonicity (014).

## 5. Findings

| ID | Severity | Title | Disposition |
|---|---|---|---|
| **GS-001** | MEDIUM | Authority-record integrity is unkeyed, so a privileged writer can re-seal | **OPEN** — Prompt 5 |
| **GS-002** | MEDIUM | Snapshot rollback can restore revoked authority | **OPEN — NOT ADDRESSED**, documented honestly |
| **GS-003** | LOW | The durable store is available but not the default for every deployment | **OPEN** — Prompt 17 |
| **GS-004** | MEDIUM | Revocation records previously carried no integrity protection at all | **CLOSED** for the durable store |

### Inherited findings

- **NB-009 — PARTIALLY CLOSED / REFINED.** *In-memory only*: closed. *Singly implemented*: closed. *Unkeyed*: open, carried to Prompt 5 as GS-001. The specific fail-open shape it warned about is closed and tested.
- **NB-006 — OPEN, ACCEPTED CURRENT SEMANTICS.** No consumption model was added; the durable schema has no counter, quota or decrement column, and a structural test pins that. Durability makes the existing property persist across restart — a widening in *time*, recorded as R-GS-06.
- **NB-008 — OPEN, OUTSIDE PROMPT 4.** Untouched. The distinction is preserved explicitly: grant-store integrity does not imply authority-policy integrity, and durability means a grant minted under a tampered policy pack now outlives the process it was minted in.

## 6. What is not claimed

Tamper-proof storage · cryptographic authenticity · anti-rollback · "a DBA cannot modify authority" · "all Frontera authority is now durable" · "Frontera durably stores grants by default" · linearizable multi-process reads · single-use grants. Each row carries its counter-evidence in `AUTHORITATIVE_GRANT_STORE.md` §22.

## 7. Prompt 3's proof

Re-verified from source and re-run unchanged: 237 tests across the no-bypass, structural-boundary, exercise and layer-boundary suites. The adapter is still invoked from exactly one production source, still after the store read and the usable-assessment gate; the caller still supplies only an id; the commit guard is still synchronous by type; no cache and no sweeper exist.

EP-011 remains **PROVEN — PATH LOCAL**. The proof was not widened. Its root was hardened.

## 8. Production behaviour change

**Durable storage is REQUIRED BY PRODUCTION CONFIGURATION — available, not default.**

| Composition | Before | After |
|---|---|---|
| Host supplies `grantStore` | that store | unchanged |
| No `grantStore`, `persistence.provider === 'memory'` (the default) | in-memory | unchanged |
| No `grantStore`, `persistence.provider === 'sqlite'` | in-memory | **durable store**, on `boundedGrant.sqlitePath` |

Exactly the rule every other store in the repository already follows. A deployment that never configured SQLite persistence sees no change and keeps its fail-closed restart behaviour.

## 9. Tests

| Suite | Result |
|---|---|
| `npm run typecheck` / `npm run build` / `npm run lint` | pass |
| `npm run test:root` | **5522 / 5522** |
| `npm run test:workspaces` | **1030 / 1030** |
| New: `bounded-grant-store-durability.test.ts` | 28 |
| New: `bounded-grant-store-boundaries.test.ts` | 20 |

Five deliberate-violation experiments confirmed the new tests are non-vacuous — bypassing integrity verification, dropping the revocation cross-check, unlinking the revocation from its grant, caching a grant on the exercise path, and widening the exercise path back to the mutating port. Every one produced failures; every source was restored byte-for-byte and re-verified green.

## 10. Handoff to Prompt 5

The attachment point is exact: a detached signature over `serializeStoredGrantRecord` and `serializeStoredRevocationRecord`, in a column beside each digest, verified inside `verifiedGrant`, `verifiedRevocation` and `currentRevocation` — three call sites, all already fail-closed, so the control flow needs no change. `AUTHORITATIVE_GRANT_STORE.md` §23 lists what must **not** change about store semantics.

The distinction to keep: **storage integrity** (the bytes are the bytes that were written) versus **cryptographic authenticity** (the bytes were written by an authorized issuer, provably). Prompt 4 delivers the first and claims only the first.
