# ADR: Durable TokenizationMandate persistence

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: `ADR-TOKENIZE-CAPABILITY.md` (the governed action itself),
  `ADR-DURABLE-GRANTS-REVOCATION.md` (the durable Access Grant store this
  mirrors), `ADR-ENTERPRISE-GOVERNANCE-STORE.md`,
  `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`,
  `docs/enterprise/AOC_ENTERPRISE_CURRENT_PERSISTENCE_MODEL.md`

## Context

`ADR-TOKENIZE-CAPABILITY.md` introduced `TOKENIZE` as a governed action and
`EnterpriseTokenizationMandate` as the authorization artifact a successful
enforcement produces. That slice shipped one store implementation —
in-memory — so a mandate, its revocation, and its external execution evidence
all vanished when the Enterprise process restarted. An authorization artifact
that cannot outlive its process is not an authorization artifact.

### What the repository already establishes

Surveyed before choosing anything:

- **SQLite is the canonical durable backend.**
  `EnterprisePersistenceProviderKind = 'memory' | 'sqlite'`, and every
  Enterprise entity has both: Governance Store, Passport Store, Assurance
  Store, Access Grant Store, Protected Resource Store.
- **One store per Enterprise entity, one database per store.** No module
  persists inside another's tables. The Passport and Assurance stores even
  take their own `sqlitePath`, explicitly independent of
  `persistence.sqlitePath`.
- **A settled SQLite house style**, identical across all five stores: lazy
  `better-sqlite3` import; `foreign_keys=ON`, `journal_mode=WAL`,
  `synchronous=FULL`, `busy_timeout`; a `*_store_versions` table checked
  *before* any DDL runs, refusing to open a foreign schema version rather
  than migrating or reusing it; hand-written SQL; synchronous
  `db.transaction(...)` for multi-statement writes; `SQLITE_CONSTRAINT`
  translated into the module's own typed error.
- **Current-state tables, not event sourcing, for short lifecycles.** The
  Access Grant Store persists current state because its lifecycle has exactly
  one transition (`active -> revoked`). Mandates have the same shape.
- **A canonical integrity primitive.** `computeDigest` in
  `governance-store/digest.ts` — SHA-256 over `aoc.canonical-json.v1`.
  Documented as integrity detection, not a signature.

### Closest analogue

`src/enterprise/access-governance/sqlite-access-grant-store.ts`. Same
lifecycle shape (issue → at-most-one revocation), same tenancy model, same
"grant references a decision it never embeds" composition.

## Decision

Add `createSqliteTokenizationMandateStore(dbPath, options)` implementing the
**existing, unchanged** `TokenizationMandateStore` port, in its own database,
following the house style above verbatim.

The port required exactly one change: `providerKind: 'memory'` widened to
`'memory' | 'sqlite'`. No method was added, removed, or re-signed. The
in-memory store is retained — it remains the right choice for unit tests,
development, and `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=memory` deployments,
exactly as `createInMemoryAccessGrantStore` is.

### Schema `aoc.tokenization-mandate-store.schema.v1`

Four tables in a dedicated database file:

| Table | Purpose |
|---|---|
| `tokenization_mandate_store_versions` | schema-version guard row |
| `tokenization_mandates` | current-state mandate row |
| `tokenization_executions` | **append-only** external execution evidence |
| `tokenization_mandate_revocations` | at-most-one revocation per mandate |

Invariants are pushed down to the database so they hold against a writer this
process never sees, not merely against its own in-memory bookkeeping:

- `request_ref UNIQUE` — one tokenization request authorizes at most one
  mandate. Replaying a request can never accumulate authorization.
- `execution_id PRIMARY KEY` — one external execution is recorded at most
  once. A replayed execution can never double-count issued units.
- `mandate_id UNIQUE` on revocations — at most one revocation per mandate.
- `(mandate_id, sequence) UNIQUE` — a restart-stable append order for
  evidence, independent of insertion timing or rowid reuse.
- The counter `UPDATE` is guarded on the `execution_count` the call read, so a
  concurrent writer that advanced it first loses the transaction rather than
  silently overwriting an issuance total.

This is a new schema on a new database file. There is no migration of
existing data because no durable tokenization data has ever existed, and no
other module's tables are touched.

### Stored vs derived state

Stored: `status` (`'active' | 'revoked'`), `issued_units`,
`execution_count`, timestamps. Derived on every read, never stored: expired,
exhausted, superseded — `enterpriseTokenizationMandateAuthorizes` computes
them purely from fields that already record the underlying facts. Persistence
did not become an excuse to introduce a second, independently-settable source
of truth for a state the previous slice deliberately refused to store.

### Integrity and corruption behaviour

`terms` is the one structured column, and it is precisely what a scope,
rights, executor, or constraint escalation would have to alter. It is stored
as its canonical serialization alongside `terms_digest`, the repository's own
canonical digest over that serialization. Every read recomputes and compares.

Three fail-closed paths, all typed `TOKENIZATION_RECORD_CORRUPTED`:

1. digest mismatch — the bytes changed after commit;
2. unreadable/malformed JSON column;
3. a row that does not project back onto a valid
   `EnterpriseTokenizationMandate` under the frozen contract's own validator,
   including an unrecognized `status`.

A corrupted record never becomes a usable authorization, and never degrades
into a partial one. No signature scheme was invented; the same limits
documented for the Governance Store's digests apply — this detects
modification, it does not resist a privileged writer who rewrites the row and
its digest together.

## Consequences

- A mandate, its revocation, its issuance totals, and its external execution
  evidence all survive process restart, proven by tests that close a store
  and reopen a new instance over the same file.
- Replay protection strengthened rather than weakened: it moved from an
  in-process `Set` to a database constraint.
- No configuration entry was added, deliberately — see below.

## Alternatives considered

**Persist mandates inside the Governance Store's tables.** Rejected: it
violates the one-store-per-entity precedent every existing module follows, and
would couple the mandate lifecycle to an append-only aggregate store whose job
is recording evaluations, not holding mutable current state.

**Event-source the mandate lifecycle.** Rejected: the lifecycle has one
transition. The Access Grant Store made the same call for the same reason.

**Add `tokenization.sqlitePath` to `EnterpriseConfiguration`.** Rejected for
now. The closest analogue — Access Governance — deliberately has no config
entry because it is not wired into the composition root, and neither is
Tokenization Governance. Adding one implies composition-root wiring, which
would place the module on the published package surface; that is blocked by
the same publishability constraint already documented in
`src/enterprise/index.ts` for Access Governance. The factory takes an explicit
`dbPath`, exactly as `createSqliteAccessGrantStore` does. When Access
Governance earns a config entry, this module should follow in the same change.

**Delete the in-memory store.** Rejected — it is a supported provider, not
scaffolding.

**A digest over the whole mandate row.** Rejected as scope creep: the scalar
columns are individually typed and validated on read, and `terms` is the only
structured payload. Digesting everything would add ceremony without adding a
detection the contract validator does not already provide.
