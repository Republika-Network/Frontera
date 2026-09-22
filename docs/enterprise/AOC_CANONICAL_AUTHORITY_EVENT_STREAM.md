# AOC Canonical Authority Event Stream (P8, Stage A)

> One verified, ordered, tenant-confined account of what happened to each
> governed action — recorded **after** each fact is established in its
> authoritative home, and read by nothing that decides.

Decision record: `docs/architecture/ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md`.
Source: `src/enterprise/authority-event-stream/`.

## 1. What it is, and the one rule

The canonical authority event stream is part of the **Evidence** layer (F). It
records facts that already happened on the governed-action / bounded-grant path
and makes that lifecycle reconstructable afterwards:

```
AUTHORITY / POLICY / OBLIGATIONS / GRANTS / EXECUTION  →  EVENTS  →  EVIDENCE
```

**A canonical event may report what happened. It may never make it permissible.**
No Kernel, policy, grant, exercise, exercise-control, emergency-control, routing,
adapter, idempotency or replay code reads the stream. Every authoritative answer
keeps its existing owner:

| question | authoritative owner | P8's relation |
| --- | --- | --- |
| what was decided | Governance Store (committed record) | reports it after commit + verify |
| has this execution identity been attempted? | Governance Store attempt reference (the at-most-once claim) | reports the claim; **never** the replay guard |
| does this grant exist / is it revoked? | bounded-grant store | reports issuance and revocation |
| how much aggregate capacity is consumed? | exercise-control ledger (P7) | reports reservation, settlement, release; never reconstructs consumption |
| is execution stopped? | emergency-control store | reports only a withholding the runtime returned |

## 2. Stage A scope

Path-local: governed actions the Governed Action Orchestrator derives
(`aoc.gar:` request ids), in the organization the orchestrator serves. Nothing
else — `evaluate()`, `enforce()`, ACE `authorize()` called directly by host code,
Sovereign Access, Content Protection, Pinata/Stripe paths — is projected, and
nothing here claims system-wide coverage.

### Event vocabulary (closed)

| # | event | emitted after | references | payload | `occurredAt` |
| --- | --- | --- | --- | --- | --- |
| 1 | `governance.decision.committed` | the Governance Record is committed, re-read and digest-verified (any status; also on replay, which resolves to the existing event) | request, evaluation, decision | Kernel status + codes, `evaluatedAt`, `aggregateDigest` | evaluation `persistedAt` |
| 2 | `grant.issued` | issuance returned the grant (`issued` / `already-issued`) and it matched the persisted decision | request, decision, grant | `grantDigest`, `expiresAt`, `authorityBindingDigest?` | `grant.issuedAt` |
| 3 | `grant.revoked` | the grant store returned the revocation (ACE `revokeGrant`) | request, decision, grant | closed revocation `reason` | `revokedAt` |
| 4 | `grant.expiry.observed` | an assessment of this grant reported `GRANT_EXERCISE_EXPIRED` | request, decision, grant | `expiresAt` | `grant.expiresAt` |
| 5 | `execution.attempt.claimed` | the write-ahead claim row was appended **by this call** | request, evaluation, decision, grant, execution | — | claim row `createdAt` |
| 6 | `exercise.reservation.reserved` | the P7 ledger returned `reserved` | request, decision, grant, execution, reservation | `policyDigest`, `authorityBindingDigest` | ledger `reservedAt` |
| 7 | `exercise.reservation.settled` | the ledger recorded settlement | … reservation | `executed` / `execution-unconfirmed` | terminal `recordedAt` |
| 8 | `exercise.reservation.released` | the ledger recorded release | … reservation | `execution-failed` / `grant-exercise` / `emergency-control` / `exercise-control` | terminal `recordedAt` |
| 9 | `execution.outcome.observed` | ACE `exercise()` returned an `ExecutionOutcome` | request, evaluation, decision, grant, execution | status (below), `outcomeRecorded`, adapter attribution, `providerRef?` | `outcome.exercisedAt` |

`execution.outcome.observed` keeps the runtime's certainty exactly:

| status | carries | never |
| --- | --- | --- |
| `executed` | `adapterId`, `routedBy?`, `providerRef?` | a failure or a withholding |
| `execution-failed` | `failure` (`PROVIDER_REJECTED` / `PROVIDER_UNAVAILABLE` / `PROVIDER_RESPONSE_INVALID` / `ADAPTER_ERROR`) = the one reason code, adapter attribution | a `providerRef` |
| `execution-unconfirmed` | adapter attribution | a `providerRef`, a failure, or "confirmed" |
| `withheld` | `withheldBy`: `grant-exercise` / `emergency-control` / `exercise-control`, that layer's own codes | adapter attribution |

`providerRef` is evidence and correlation only — never dereferenced, never
executable, never proof that anything executed.

### Typical streams

```
denied / indeterminate / approval_required:  1
admission-time emergency stop:               1                       (no grant exists)
executed:                                    1 → 2 → 5 → 9
with P7, executed:                           1 → 2 → 5 → 6 → 7 → 9
with P7, binding changed after reservation:  1 → 2 → 5 → 6 → 8 → 9
revoked while the reservation waited:        1 → 2 → 5 → 3 → 6 → 8 → 9
expired at pre-assessment:                   1 → 2 → 4               (nothing claimed)
exercise threw (outcome unknown):            1 → 2 → 5               (claim, no outcome)
revoked later by an operator:                … → 3
```

### Not in Stage A, deliberately

Raw transport input (headers, credentials, bodies, `assertedContext`, a caller's
`correlationId`); uncommitted Kernel answers; withholdings before a grant exists
(`grant-terms`, `authority-binding`, `grant`, `obligations`, admission and
commit-boundary emergency) — the runtime persists no fact for them beyond the
committed decision; obligation transitions (none occur on this path); a
scheduled expiry (none exists).

## 3. Identity, order, integrity

- **Stream id** `aoc.aes:<32 hex>` from (organization, request id). **Event id**
  `aoc.aev:<32 hex>` from (stream, type, source artifact id). Both through the
  Governance Store's `computeDigest` (`aoc.canonical-json.v1`); verification
  re-derives both from the event's own content.
- **Order**: per-stream sequence from 1, contiguous; the first event is the
  committed decision, and only it; every later event names the preceding digest.
  Not global, not cross-tenant.
- **Digest** (`sha256:`) over schema version, ids, organization, type, sequence,
  both instants, references, payload and previous digest.
- **Head**: one sealed row per stream (sequence + last digest), verified against
  the chain on every append and read, never trusted alone.
- **Idempotency**: same id + same canonical fact → existing event; same id +
  different fact → `AUTHORITY_EVENT_CONFLICT`. Never last-write-wins.
- **Corruption**: payload, type, instant, organization, sequence, previous-digest,
  event-digest, reference or head mutation, event or head deletion — all fail
  verification; `readStream` throws `AUTHORITY_EVENT_STREAM_CORRUPT`, appends to
  that stream are refused, nothing is repaired or truncated. Other streams are
  unaffected. A corrupt stream is an evidence problem: it is never read as
  permission for, or refusal of, a new action.

## 4. Composition and configuration

Composed automatically when `governedActionOrchestrator` is enabled; absent
otherwise (no module, no reader, no file).

| setting | effect |
| --- | --- |
| `persistence.provider = 'sqlite'` | durable store at `authorityEventStream.sqlitePath` / `AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH` (default `.data/authority-event-stream.sqlite`, its own file), schema `aoc.authority-event-stream.schema.v1`, WAL, `synchronous = FULL`, `BEGIN IMMEDIATE` appends, append-only triggers; a file under another schema is refused before mutation |
| `persistence.provider = 'memory'` | process-local store; **not durable** |
| `createEnterprise({ authorityEventStream: { store } })` | a host-supplied `AuthorityEventStreamStore`, used verbatim, never closed by the Host |

The store's clock is the Host's injected clock (`kernelProviders.clock.now`).

## 5. Reading the stream

`AocEnterprise.authorityEventStream` — present when the stream is composed and
its store is available — is a frozen two-method object for trusted in-process
operator and audit code:

```ts
readStream({ organizationId }, streamId)   // verify-first; throws on corruption or another tenant
verifyStream({ organizationId }, streamId) // reports { valid, eventCount, head, failures }
```

`streamId = deriveAuthorityEventStreamId({ organizationId, requestId })`. There is
no append, update, delete, health or close on it, no HTTP route, no SDK method,
and nothing that authorizes is handed it.

## 6. Failure semantics and health

The `aoc.enterprise.authority-event-stream` module (`optional`; its
initialization never throws) reports:

| module health | meaning |
| --- | --- |
| `healthy` | store readable and writable; no projection has failed |
| `degraded` | at least one projection failed (`failed`, `lastFailureCode` in details) |
| `unhealthy` | the store could not be opened, is closed, or reports unhealthy |

Details carry counters (`appended`, `existing`, `failed`, `outOfScope`) — never a
path, a payload or an id. In every case governed actions behave exactly as they
would with no stream: a failed projection cannot make an uncommitted decision
committed or a committed one uncommitted, cannot mint or revoke a grant, cannot
reserve, settle or release, cannot change routing or invoke an adapter again,
and cannot turn `executed`, `execution-failed`, `execution-unconfirmed` or
`withheld` into anything else. The Host stays `ready`.

## 7. Relation to other evidence

- **Governance Store references** remain the at-most-once guard and the
  per-evaluation evidence rows; P8 reuses their identities and never replaces them.
- **P7 exercise-control ledger** remains authority for consumption; P8 observes
  its proven transitions through a write-only observer port on the gate
  (`ExerciseControlObserver`), which the gate calls after the ledger answered and
  whose failure it discards.
- **`EnterpriseUsageEvent`** is the pure R004 contract for observed use of an
  `EnterpriseAccessGrant`; it is not this stream, and neither replaces the other.
- **`EnterpriseEvidenceCorrelation`** is an unordered graph of which artifacts
  belong together; the stream is ordered occurrence and carries opaque references
  to the same artifacts without embedding a correlation.
- **Agent Passport / emergency-control chains** are per-aggregate histories of
  other domains; their primitives (canonical digest, chained events, sealed head)
  are reused, not their aggregates.

## 8. Limits

Integrity, not authenticity (unkeyed SHA-256; whole-stream rewrite with a
re-sealed head, or deletion of a whole stream with its head, is not detectable
from inside the file). One SQLite file serializes one host. No global order, no
exactly-once, no WORM, no distributed consensus, no cross-region copy, no
retention or cleanup, not in portability v1 backup/restore. Stage A coverage is
path-local. Signatures and KMS/HSM are P12; model convergence is P9.

## 9. Tests

`authority-event-stream-domain.test.ts` (vocabulary, identity, digest input,
closed contract, unsafe values, certainty rules, chain verification),
`authority-event-stream-sqlite.test.ts` (shared contract on both stores, restart,
triggers, schema refusal, seventeen raw-SQLite corruption cases),
`authority-event-stream-concurrency.test.ts` (worker-thread races: unique facts,
duplicate facts, conflicting facts; chain verified after every race),
`authority-event-stream-governed-action.test.ts` (real path: every outcome, P7
facts, replay, projection failure never becoming authority),
`authority-event-stream-composition.test.ts` (composition, durability, ownership,
degradation, tenant confinement, secret leakage through the full Host with a
Generic HTTP adapter), `authority-event-stream-boundaries.test.ts` (the stream
cannot authorize).
