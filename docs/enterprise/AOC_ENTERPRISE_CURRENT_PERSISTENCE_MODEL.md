# Frontera Systems — Current Persistence Model (pre-PR-004 baseline)

This document records, before any PR-004 refactoring, exactly what the Soberanía
Enterprise Host's decision persistence does today — as established by
PR-002 (Enterprise Host v1), the PR-002 iteration (naming/composition), and
PR-003 (Module Lifecycle & Registry). It is the "prove understanding of what
exists" deliverable required before the Governance Store v1 redesign.

Everything below describes the repository state at commit `057a4f8`
(merge of PR-003), branch point of `claude/aoc-enterprise-governance-store-0nlb64`.

---

## 1. Current `GovernanceStore` interface

`src/enterprise/persistence/governance-store.ts`

```ts
export interface GovernanceStore {
  readonly providerKind: 'memory' | 'sqlite';

  persistEvaluation(input: PersistEvaluationInput): Promise<PersistEvaluationResult>;

  getRequestById(requestId: string): Promise<GovernanceRequestRecord | undefined>;
  getEvaluationByRequestId(requestId: string): Promise<GovernanceEvaluationRecord | undefined>;
  getEvaluationByDecisionId(decisionId: string): Promise<GovernanceEvaluationRecord | undefined>;
  getTraceByDecisionId(decisionId: string): Promise<GovernanceTraceRecord | undefined>;

  appendEnterpriseEvent(record: EnterpriseEventRecord): Promise<void>;
  listEnterpriseEvents(filter?): Promise<readonly EnterpriseEventRecord[]>;

  recordEnterpriseVersion(record: EnterpriseVersionRecord): Promise<void>;
  getLatestEnterpriseVersion(): Promise<EnterpriseVersionRecord | undefined>;

  checkConnectivity(): Promise<boolean>;
  close(): Promise<void>;
}
```

Record types defined alongside it:

- `GovernanceRequestRecord` — `requestId`, `correlationId?`, `actorId`,
  `actionType`, `resourceScope`, `organizationId?`, `requestedAt`,
  `receivedAt`, `requestPayload: KernelEvaluationRequest` (the raw
  normalized Kernel request, verbatim).
- `GovernanceEvaluationRecord` — `decisionId`, `requestId`, `status`,
  `reasonCodes`, `summary`, `kernelVersion`, `evaluatedAt`, `correlationId?`.
- `GovernanceTraceRecord` — `decisionId`, `trace: KernelTrace` (whole trace
  as one value).
- `EnterpriseEventRecord` — `eventId`, `eventType`, `requestId`,
  `decisionId?`, `correlationId?`, `occurredAt`, `payload`.
- `EnterpriseVersionRecord` — `bootId`, `enterpriseVersion`,
  `kernelVersion`, `recordedAt`.

`PersistEvaluationOutcome = 'stored' | 'idempotent_replay' | 'conflict'`.

## 2. Existing in-memory implementation

`src/enterprise/persistence/in-memory-governance-store.ts` —
`createInMemoryGovernanceStore()` (synchronous factory). Backing state is
five plain structures: `Map` keyed by `requestId` (requests), two `Map`s for
evaluations (by requestId and decisionId), a `Map` for traces (by
decisionId), and two arrays (`events`, `versions`). No copies are taken on
write or read: the caller's objects are stored and returned by reference,
so a caller mutating a returned record mutates the "persisted" record.

## 3. Existing SQLite implementation

`src/enterprise/persistence/sqlite-governance-store.ts` —
`createSqliteGovernanceStore(dbPath)` (async factory; lazy
`import('better-sqlite3')`). Hand-written SQL, prepared statements, one
`db.transaction(...)` for `persistEvaluation`. `:memory:` supported;
on-disk paths get their parent directory created. Schema is created
inline with `CREATE TABLE IF NOT EXISTS` on every construction — there is
no migration table, no schema-version row, no migration mechanism at all.

## 4. Existing tables

Created in `initSchema()` (same file):

| Table | Purpose |
|---|---|
| `GovernanceRequests` | one row per governance request |
| `GovernanceEvaluations` | one row per Kernel evaluation result (minus trace) |
| `GovernanceTraces` | whole `KernelTrace` as one JSON blob per decision |
| `RuntimeEvents` | append-only Enterprise event ledger |
| `RuntimeVersions` | one row per Host boot (enterprise/kernel version) |

Table names are PR-002 names; the PR-002 iteration deliberately renamed
TypeScript types only, never the schema.

## 5. Existing columns

- `GovernanceRequests`: `request_id` (PK), `correlation_id`, `actor_id`,
  `action_type`, `resource_scope`, `organization_id`, `requested_at`,
  `received_at`, `request_payload` (JSON text of the full
  `KernelEvaluationRequest`).
- `GovernanceEvaluations`: `decision_id` (PK), `request_id` (FK),
  `status`, `reason_codes` (JSON array text), `summary`, `kernel_version`,
  `evaluated_at`, `correlation_id`.
- `GovernanceTraces`: `decision_id` (PK, FK), `steps_json` (whole
  `KernelTrace` JSON).
- `RuntimeEvents`: `event_id` (PK), `event_type`, `request_id`,
  `decision_id`, `correlation_id`, `occurred_at`, `payload` (JSON text).
- `RuntimeVersions`: `boot_id` (PK), `runtime_version`, `kernel_version`,
  `recorded_at`.

## 6. Existing indexes

- `idx_governance_requests_correlation_id` on `GovernanceRequests(correlation_id)`
- `idx_governance_evaluations_request_id` on `GovernanceEvaluations(request_id)`
- `idx_governance_evaluations_correlation_id` on `GovernanceEvaluations(correlation_id)`
- `idx_runtime_events_request_id` on `RuntimeEvents(request_id)`
- `idx_runtime_events_correlation_id` on `RuntimeEvents(correlation_id)`

No index on `organization_id`, `actor_id`, `action_type`, `status`,
timestamps, or reason codes — none of those are queryable today.

## 7. Current transaction boundaries

Exactly one: `persistEvaluation` wraps request + evaluation + trace inserts
in one `better-sqlite3` `db.transaction`. `appendEnterpriseEvent` and
`recordEnterpriseVersion` are single autocommit inserts, *outside* any
evaluation transaction — an evaluation's events are not atomic with the
evaluation itself. The in-memory store has no transaction concept; its
`persistEvaluation` performs four `Map.set` calls sequentially (atomic in
practice only because the function is synchronous single-threaded JS).

## 8. Current rollback behavior

SQLite: `better-sqlite3` rolls the whole `persistEvaluation` transaction
back if any insert throws (verified by
`src/enterprise/__tests__/persistence.test.ts` "rolls back the entire
transaction"). In-memory: no rollback — a hypothetical failure between the
`Map.set` calls would leave partial state (cannot currently happen, but
nothing enforces it). Event/version appends have no rollback story at all.

## 9. Current idempotency behavior

Keyed solely on `requestId`. On `persistEvaluation`, if a request row with
the same `requestId` already exists and the *entire request payload* is
byte-identical under `JSON.stringify` (`isSameRequestPayload` in
`record-mappers.ts`), the original evaluation is returned with outcome
`'idempotent_replay'` and nothing is written. There is no caller-provided
idempotency key, no tenant scoping of the key, and no `Idempotency-Key`
HTTP header support. The Kernel is always re-run before idempotency is
detected (persistence happens after `kernel.evaluate()`), and the
orchestrator then rehydrates the originally stored decision
(`rehydrateReplayedResult` in
`src/enterprise/orchestration/evaluate-governance-request.ts`) by patching
stored fields onto the freshly computed result. Note the
`KernelEvaluationRequest.idempotencyKey` field exists but is *engine*
idempotency (duplicate-suppression inside action-enforcement), not store
idempotency.

## 10. Current conflict behavior

Same `requestId`, different payload → outcome `'conflict'`, nothing
written; the orchestrator maps it to HTTP 409 `CONCURRENCY_CONFLICT`.
`JSON.stringify` equality is key-order-sensitive: two semantically
identical requests whose keys serialize in different order are treated as
a *conflict*, not a replay.

## 11. Current request persistence

`toGovernanceRequestRecord` (`record-mappers.ts`) copies denormalized
columns (actor/action/organization ids, timestamps) and stores the full
`KernelEvaluationRequest` verbatim as `requestPayload` — including
arbitrary caller `context` (which today carries e.g. `passportId`,
`capabilityTokenId`, evidence references). There is no sanitization,
redaction, size limit, or persistence projection. The `Authorization`
header is *not* persisted (it never reaches the store; it stops at
`authenticateAndAuthorize`).

## 12. Current evaluation persistence

`toGovernanceEvaluationRecord` stores decision id, request id, status,
reason codes, summary, kernel version, evaluated-at, correlation id. It
does **not** store the full `KernelEvaluationResult` — `recognition`,
`authority`, `policies`, `approval`, `evidence` sub-results are dropped.
No enterprise version, no evaluation contract id, no digest, no
persisted-at timestamp.

## 13. Current trace persistence

The whole `KernelTrace` (steps + decisionId + kernelVersion) is stored as
one JSON blob keyed by decision id. Steps are not normalized; sequence
uniqueness is not enforced; there is no per-step digest or contract id.

## 14. Current event persistence

`appendEnterpriseEvent` inserts one row per published `EnterpriseEvent`
(only `GovernanceEvaluationRequested` and the completion event types are
ever appended — lifecycle events are published in-process but **never
persisted**). Events are appended *before* (requested) and *after*
(completion) the evaluation's persistence transaction, so a crash can
leave a requested event without an evaluation, or an evaluation without
its completion event. `RuntimeEvents.request_id` is `NOT NULL`, which is
why lifecycle events (no request id) cannot be stored there. No sequence,
no causation id, no digest, no contract version.

## 15. Current version persistence

`recordEnterpriseVersion` is called once per boot from
`createEnterprise()` (`composition/composition-root.ts`) with `bootId`,
`enterpriseVersion`, `kernelVersion`, `recordedAt`. `getLatestEnterpriseVersion`
orders by `recorded_at DESC, rowid DESC`. Per-evaluation version context is
limited to `kernel_version` on the evaluation row; the hosting enterprise
version is *not* recorded per decision, only per boot.

## 16. Current lifecycle-event persistence

None. PR-003 lifecycle events (`EnterpriseLifecycleEvent`) flow through the
in-process publisher only. The store never sees them (blocked structurally
by `RuntimeEvents.request_id NOT NULL`).

## 17. Current resource lifecycle

The store is constructed in `createEnterprise()` (or injected via
`CreateEnterpriseOptions.persistence`), wrapped by the required
`aoc.enterprise.persistence` module
(`src/enterprise/modules/persistence-module.ts`), whose `initialize()`
calls `checkConnectivity()` and whose `shutdown()` calls `store.close()` in
reverse dependency order via the PR-003 lifecycle controller.

## 18. Current SQLite connection ownership

One `better-sqlite3` `Database` per store instance, owned by the closure
returned from `createSqliteGovernanceStore`. Never exposed. `close()`
closes it; there is no guard against use-after-close (better-sqlite3
throws its own error). No busy timeout is configured.

## 19. Current serialization behavior

Plain `JSON.stringify` everywhere: request payload, reason codes, trace
steps, event payloads. No canonical key ordering, no explicit
`undefined`/date handling, no versioned canonicalization. Parsing is plain
`JSON.parse` with `as` casts.

## 20. Current timestamp generation

`receivedAt` comes from the composed Kernel clock
(`deps.clock.now()` in `evaluate-governance-request.ts`);
`requestedAt`/`evaluatedAt` come from the Kernel request/result;
`occurredAt` on events uses the clock or the result's `evaluatedAt`. The
store itself generates **no** timestamps (no `persistedAt`, no
`createdAt`). Test determinism comes from injecting a manual clock via
`KernelProviderSet`.

## 21. Current identifier generation

The store generates **no** identifiers. `requestId` comes from the caller
or `idGenerator.nextId('enterprise-request')`; `decisionId` from the
Kernel; `eventId` from a dedicated Enterprise id generator
(`createEnterpriseIdGenerator` — `${prefix}-${randomUUID()}`); `bootId`
likewise. There are no `recordId`/`evaluationId` concepts.

## 22. Current query capabilities

Point lookups only: request by id, evaluation by request id, evaluation by
decision id, trace by decision id, latest version. Events can be listed
with optional exact-match `requestId`/`correlationId` filters (unindexed
full list otherwise). There is **no** query by organization, actor, action
type, status, reason code, or time range; no pagination; no cursor; no
tenant scoping of reads (any caller with the store can read any tenant's
records). No HTTP read endpoints exist — reads are service-layer only.

## 23. Current delete/update capabilities

The public interface exposes no update and no delete methods — good — but
nothing else enforces immutability: SQLite rows are protected only by the
absence of UPDATE/DELETE statements in this codebase, and in-memory records
are returned by reference and mutable in place. There are no triggers,
constraints, or tests asserting immutability.

## 24. Current integrity guarantees

None beyond SQLite PK/FK constraints. No digests, no canonical
serialization, no hash chain, no verification API, no corruption
detection. A modified `request_payload` or `steps_json` is undetectable.

## 25. Current concurrency assumptions

`better-sqlite3` is synchronous, so within one process the
`persistEvaluation` transaction cannot interleave; the concurrent-burst
tests (`src/enterprise/__tests__/concurrency.test.ts`) rely on this.
Cross-process writers are partially handled by WAL mode but there is no
busy timeout, so a locked database throws `SQLITE_BUSY` immediately. The
in-memory store relies entirely on single-threaded JS synchronicity.
Idempotency under concurrency is enforced by the `GovernanceRequests`
primary key (SQLite) or a `Map` lookup inside a synchronous function
(in-memory) — no cross-process uniqueness for in-memory, by nature.

## 26. Current failure modes

- Store throw during `persistEvaluation` → orchestrator maps to HTTP 500
  `INFRASTRUCTURE_FAILURE` ("The evaluation could not be persisted."),
  after the Kernel already evaluated — the decision is returned to no one
  and lost (correct per invariant, but reported generically, and telemetry
  only increments `persistenceFailureCount`).
- Request row without evaluation row (crash between PR-002 writes is
  impossible in-transaction, but a legacy/foreign database could have it) →
  `persistEvaluation` throws "persistence invariant violated".
- `appendEnterpriseEvent` failure after a committed evaluation → the
  evaluation HTTP response fails with 500 even though the decision *was*
  durably committed (event append is post-commit but pre-response, and
  un-caught).
- `checkConnectivity()` false → `/health` unhealthy, persistence module
  unhealthy, readiness false.

## 27. Current tests

- `src/enterprise/__tests__/persistence.test.ts` — store round-trips,
  idempotent replay, conflict, event filters, version rows, connectivity,
  SQLite whole-transaction rollback (both providers via a variant loop).
- `src/enterprise/__tests__/concurrency.test.ts` — 20 distinct concurrent
  requests; 10-way identical burst converges on one decision; 5-way
  conflicting burst → one winner, four 409s.
- `src/enterprise/__tests__/composition-root.test.ts` — boot version row;
  failing injected store rejects `createEnterprise`.
- `src/enterprise/__tests__/kernel-integration.test.ts`,
  `enterprise-api-endpoint.test.ts`, `health.test.ts`,
  `module-lifecycle-integration.test.ts` — persistence touched indirectly
  (decision persisted after HTTP evaluate, `/health` persistence block,
  required-module readiness).
- Baseline totals on this branch: kernel suites 67/67 pass; enterprise
  suites 102/102 pass (with `better-sqlite3` installed).

## 28. Existing data-loss risks

- Events and versions are outside the evaluation transaction: crash windows
  can orphan a `GovernanceEvaluationRequested` event or lose a completion
  event for a committed decision.
- In-memory store loses everything on process exit by design (documented).
- No backup/migration story: `CREATE TABLE IF NOT EXISTS` means a schema
  change would silently *not* apply to an existing database.
- Full `KernelEvaluationResult` sub-results (`recognition`, `policies`,
  `approval`, `evidence`) are never persisted at all — irrecoverable today.

## 29. Existing mutation risks

- In-memory records are shared by reference; any consumer can mutate
  "persisted" history.
- SQLite rows can be updated by any process with file access; nothing
  detects it (no digests).
- `rehydrateReplayedResult` merges stored fields onto a fresh result —
  a coding change there could silently rewrite replayed history in the
  HTTP response without any store change.

## 30. Files expected to change in PR-004

- `src/enterprise/persistence/governance-store.ts` (interface evolves;
  legacy record types become the v1 canonical model or re-exports)
- `src/enterprise/persistence/in-memory-governance-store.ts` (replaced by
  the v1 in-memory Governance Store)
- `src/enterprise/persistence/sqlite-governance-store.ts` (replaced by the
  v1 SQLite Governance Store + migration)
- `src/enterprise/persistence/record-mappers.ts` (superseded by the
  persistence projection/aggregate builder)
- new `src/enterprise/governance-store/**` (canonical serialization,
  digests, redaction, record model, errors, projection, both store
  implementations, migration)
- `src/enterprise/orchestration/evaluate-governance-request.ts`
  (idempotency-first flow, atomic aggregate append, post-commit events)
- `src/enterprise/composition/composition-root.ts` (store construction,
  lifecycle context supplier, read APIs)
- `src/enterprise/modules/persistence-module.ts` (becomes the Governance
  Store module `aoc.enterprise.governance-store`)
- `src/enterprise/api/enterprise-http-errors.ts` + `adapters/node-http-adapter.ts`
  (new error codes, `Idempotency-Key`, read/verify endpoints)
- `src/enterprise/configuration/enterprise-configuration.ts` (enforced
  store limits), `telemetry/enterprise-telemetry.ts` (store counters),
  `events/enterprise-events.ts` (commit events), `index.ts` (exports)
- tests under `src/enterprise/__tests__/` (new suites + updates where the
  old store surface changes)
- docs: this file, `AOC_ENTERPRISE_GOVERNANCE_STORE.md`,
  `AOC_GOVERNANCE_RECORD_MODEL.md`, `AOC_GOVERNANCE_STORE_OPERATIONS.md`,
  `GOVERNANCE_STORE_MIGRATION_V1.md`,
  `docs/architecture/ADR-ENTERPRISE-GOVERNANCE-STORE.md`
