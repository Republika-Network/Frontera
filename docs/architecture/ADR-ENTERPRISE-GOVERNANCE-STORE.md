# ADR: Frontera Systems Governance Store v1

- Status: Accepted (PR-004)
- Deciders: Frontera Systems architecture
- Related: `ADR-ENTERPRISE-HOST-NAMING.md`, `ADR-ENTERPRISE-MODULE-LIFECYCLE.md`,
  `docs/enterprise/AOC_ENTERPRISE_GOVERNANCE_STORE.md`,
  `docs/enterprise/AOC_ENTERPRISE_CURRENT_PERSISTENCE_MODEL.md`

## Context

- PR-002 gave the Enterprise Host minimal decision persistence: requests,
  a slim evaluation row, the trace as one JSON blob, an event ledger, and
  boot versions — five tables, point lookups only.
- PR-003 made that persistence a required lifecycle module, so readiness
  already depends on it.
- Soberanía's product promise is traceability: future Evidence, Passport,
  Audit, Replay, and Assurance layers must be able to reference and
  verify past decisions reliably.
- The PR-002 storage was not a canonical audit record: the full Kernel
  result was dropped, no version/lifecycle context was captured per
  decision, nothing was queryable by organization/actor/reason code, no
  integrity semantics existed (a modified row was undetectable), update
  semantics were undefined (nothing but discipline prevented mutation),
  and idempotency was requestId-only with JSON.stringify equality.

## Decision

Create the Frontera Systems Governance Store v1
(`src/enterprise/governance-store/`):

- **append-oriented** storage with no public update/delete surface;
  corrections are future appended records (`GovernanceCorrectionRecord`
  reserved);
- **one canonical serialization** (`aoc.canonical-json.v1`) and **SHA-256
  digests** (`sha256:<hex>`) for all integrity computation;
- **complete evaluation aggregates** persisted atomically: request,
  evaluation (full sanitized result), normalized trace steps, normalized
  reason codes, embedded evaluation events, version+lifecycle metadata,
  and integrity metadata with a store-scoped hash chain
  (`previousAggregateDigest`, monotonic `chainPosition`);
- **first-class idempotency**: tenant-scoped caller keys
  (`Idempotency-Key`, `UNIQUE(scope, idempotency_key)`) plus requestId
  uniqueness; resolution before Kernel re-execution; replay answers from
  the stored aggregate;
- **reconstruction** (`reconstruct`/`getBy*`, structured
  complete/incomplete/corrupted results) and **integrity verification**
  (`verify`, full recomputation from stored payloads);
- **tenant scope enforced by the Store** via
  `GovernanceStoreAccessContext` on every read/query;
- **both providers preserved** (in-memory and SQLite) behind one
  interface, kept semantically identical by a shared aggregate builder,
  shared verifier, and shared contract tests;
- **persistence invariant**: a failed commit is an infrastructure failure
  (503/500) — never a "successful" governed response;
- **no full event sourcing** — the platform keeps its current
  architecture; the Store is a durable record, not the system of record
  for state reconstruction;
- **no external anchoring in v1** — digests are an integrity mechanism,
  explicitly documented as neither signatures nor non-repudiation.

## Consequences

Positive:

- durable, complete decision history (the full sanitized Kernel result is
  finally preserved);
- stronger auditability: who/what/which org/which versions/which modules
  answered every evaluation;
- deterministic reconstruction without re-running the Kernel;
- integrity verification and tamper detection, including chain linkage;
- Passport/Evidence readiness via the generic reference mechanism;
- an honest foundation for Assurance;
- safer retries: tenant-scoped idempotency with exact conflict semantics.

Negative:

- a larger schema (11 tables vs 5) and more storage per decision;
- migration complexity (PR-002 databases are migrated, marked, and kept);
- integrity computation overhead on every append;
- append-only correction is more ceremony than in-place edits;
- retention/deletion governance remains unresolved and is now explicitly
  someone's future problem (documented, not hidden).

## Rejected alternatives

- **Keep the minimal PR-002 persistence** — cannot answer the audit
  questions Soberanía promises; no integrity, no reconstruction.
- **One opaque JSON blob per decision** — simple, but unqueryable and
  unverifiable at any useful granularity.
- **Convert the platform to event sourcing** — a rewrite with system-wide
  risk; the mission explicitly forbids it and the Store does not need it.
- **Blockchain-anchor every record** — external trust anchoring before
  the basics exist would be decorative cryptography; deferred.
- **Move to PostgreSQL now** — nothing in the repository requires it;
  SQLite remains the durable reference implementation.
- **Mutable CRUD records** — contradicts the audit purpose; updates make
  history negotiable.
- **Build the Evidence Runtime immediately** — Evidence Bundles need this
  durable substrate first; PR-005 is the recommended next step.
