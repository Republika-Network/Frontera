# G-01B2 — Scoped request namespaces (proposed follow-up milestone)

Status: **proposed, not started, not approved.** Deferred from G-01B1 by founder decision 1.

## Problem it would remove

`request_id` is unique across the whole Governance Store (`governance_requests.request_id UNIQUE`; the in-memory provider's `evaluationIdByRequestId`). Two consequences remain after G-01B1 (P2-1, SEC-INV-351 residual):

1. **Existence oracle.** A caller reusing a request id another organization (or principal) committed gets `409 CONCURRENCY_CONFLICT`; an unused id evaluates. The difference tells the caller that the id is held somewhere.
2. **Squatting.** A caller can commit a victim's deterministic request id first; the victim's own first submission is then refused.

Neither discloses or replays the other record (G-01A `mayReplayTo`, tenant-scoped reads), and generated ids are random. Both disappear only if two scopes can hold the same caller request id.

## Scope to design

- **Namespace definition.** Per organization (and the explicit `global` scope for unscoped / unauthenticated evaluation), or per requesting principal — and how the governed path's server-derived ids (already organization- and principal-bound) fit.
- **Storage.** `UNIQUE(namespace, request_id)` instead of `UNIQUE(request_id)`. SQLite cannot alter an inline UNIQUE constraint: a table rebuild of `governance_requests`, with the `governance_evaluations.request_id` foreign key and the events' `request_id` index revisited; an in-memory index keyed by (namespace, request id).
- **Migration and historical compatibility.** Existing rows backfilled into a namespace derived from their organization; records digests must not change (the namespace must live outside the digested request record, or digests are versioned); chain verification and CORE-07 witnesses unaffected; restore of pre-migration backups.
- **System-level lookups.** `getByRequestId` and `GET /api/governance/requests/{id}` for system scope and auditors become ambiguous when two namespaces share an id: a namespace parameter, a list answer, or a rule. Legacy PR-002 surfaces (`getRequestById`, `listEnterpriseEvents`) likewise.
- **Wire compatibility.** The v1 response echoes the caller's `requestId`, and the Kernel decision carries it; neither may change meaning. Idempotency-Key scopes stay as they are.
- **Consumers.** Every reader by request id (reconsideration, traces, refunds, operator views, evidence) resolves within the caller's namespace; the G-01B1 provenance resolver keeps its semantics.

## Not in scope

G-01C, G-02, TRADE-05; any Kernel authority or CORE-07 change.
