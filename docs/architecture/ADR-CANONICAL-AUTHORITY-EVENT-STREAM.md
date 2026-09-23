# ADR: The canonical authority event stream (P8, Stage A)

- Status: accepted
- Phase: P8, Stage A (amended by the P8 independent-review hardening: §1a, §8)
- Status of implementation: implemented in `src/enterprise/authority-event-stream`
  (event contract, identity, validation, hash chain, store port, in-memory and
  SQLite stores, projector, write-only recorder), with one write-only observer
  port in `src/features/exercise-control-runtime` and two write-only call sites
  (`governed-action/orchestrator.ts`, `execution-governance/service.ts`).
  Composed automatically with the Governed Action Orchestrator; absent otherwise.
- Related: `ADR-AUTHORITY-CONTROL-LAYERING.md` (layer F: Evidence),
  `ADR-ENTERPRISE-GOVERNANCE-STORE.md`, `ADR-EXERCISE-AGGREGATE-CONTROLS.md`,
  `ADR-USAGE-EVENT.md`, `ADR-EVIDENCE-CORRELATION.md`,
  `docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md` (the operator-facing
  design), `docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md`

## Context

After P2–P7 the governed-action / bounded-grant lifecycle is fully governed, but
its facts live in five places, each with its own owner and its own shape:

| where | what it holds | its role |
| --- | --- | --- |
| Governance Store aggregate | the committed decision, its trace, embedded Host events | authority record of the decision |
| Governance Store references | `authorization_artifact`, `execution_record` attempt and outcome rows | evidence, with one **negative** behavioural use: the at-most-once claim |
| bounded-grant store | grants and revocations | authority |
| exercise-control ledger | reservations and their terminal events | authority (aggregate consumption) |
| emergency-control store | the interlock's own event chain | authority (operational stop) |

Reconstructing "what happened to this governed action, in what order" means
joining all of them, knowing which identity links which, and knowing which
record's instant means what. Nothing gives an auditor one ordered,
tamper-evident account — and nothing may: any such account must be unable to
become a sixth source of authority.

## Decision

### 1. A canonical stream exists, and it is evidence — never authority

```
AUTHORITY / POLICY / OBLIGATIONS / GRANTS / EXECUTION
                     ↓
                 EVENTS (P8)
                     ↓
                 EVIDENCE
```

Never `EVENTS → authorization decision`. The stream records facts that already
happened in their authoritative home. It cannot grant, widen, route, mint,
satisfy a quota, decide policy, replay an adapter or turn evidence into
permission, because nothing that does any of those things can reach it:

- No authority-bearing module imports the store, the reader, the verifier, the
  projector or its health. The **only** thing lifecycle code may name is the
  write-only `AuthorityEventRecorder` interface, as a type, in exactly two files.
- Every recorder method returns `void`: there is no answer to read, **and
  nothing to await** (§1a).
- Every call site reports inside its own catch-all and discards the result, so a
  missing, failing, stuck or corrupt stream changes no outcome.
- `authority-event-stream-boundaries.test.ts` fails the build on any of these.

The existing owners keep every authoritative question: the Governance Store (the
committed decision and the at-most-once execution claim), the bounded-grant store
(grants, revocations), the exercise-control ledger (aggregate consumption), the
emergency-control store (the stop).

### 1a. Durable projection is not part of authority control flow (hardening)

Being unable to *decide* anything is not enough: evidence must also not be
something an authority path **waits for**. The first implementation had each call site `await` the
recorder inside a `try`/`catch`. That catches a **rejected** projection and does
nothing at all about a **pending** one, and the independent review was right to
call it a blocker: a store that hung would have held a committed decision before
its grant was issued, sat between the durable write-ahead claim and the adapter
crossing (leaving a claimed execution that can never be retried), kept a P7
reservation consuming while `admit()` never returned — P7 has no TTL and no
sweeper — and withheld a revocation's confirmation from its caller.

So the contract is not "a promise we are careful with"; there is no promise:

```
authoritative fact -> recorder.x(fact)   [validate, build, enqueue, return]
                                 |
                projector  ------+--> per-stream serial queue --> store.append(...)
```

- `AuthorityEventRecorder` and `ExerciseControlObserver` methods return `void`.
  An authority-bearing module cannot hold, await or branch on durable projection
  because no value representing it ever reaches one.
- Reporting itself does no I/O. Even the first append of an idle stream starts
  one microtask later, so a synchronous driver such as `better-sqlite3` never
  runs its transaction inside the reporting call's own stack frame.
- "We await it but catch errors, therefore it cannot affect the path" is removed
  from this repository's reasoning. A pending promise disproves it.

**What this is not.** It is *logical* decoupling — control flow — and not
latency or thread isolation. Projection runs in this process, on this event
loop. The built-in store is `better-sqlite3`: its `BEGIN IMMEDIATE` append,
including any lock wait and the `synchronous = FULL` `fsync`, is synchronous
work on that loop, and a host-supplied store may be synchronous too. So a slow
or blocking store **can** add process latency to whatever runs next, an
authority path included. What it cannot do is make an authority path wait for
projection to finish, which is what turned a pending append into a stalled
decision, an un-crossed adapter boundary, a stranded reservation or an
unconfirmed revocation. Moving projection off the loop would need a worker, and
Stage A deliberately does not add one (§Non-goals).

`authority-event-stream-boundaries.test.ts` fails the build on `await` of a
recorder, observer, `report(...)` or `observe(...)`, and on any recorder method
that is not `void`. The never-settling regressions in
`authority-event-stream-governed-action.test.ts` (§9 of the hardening) prove the
behaviour end to end rather than by inspection.

### 2. Why none of the existing concepts is the stream

| candidate | why it is not the universal stream |
| --- | --- |
| `GovernanceEventRecord` / `EnterpriseEvent` | Operational Host events (`GovernanceEvaluationRequested`, `GovernanceRecordCommitted`…) embedded in *one evaluation aggregate* or appended standalone for lifecycle/module events. They end at the commit; they know nothing of grants, claims, reservations or outcomes, and their chain is store-scoped, not lifecycle-scoped. |
| Governance Store references | Per-evaluation evidence rows keyed by reference id, whose ordering is the evaluation's reference chain. The attempt row is **load-bearing** (the at-most-once claim): making it the universal stream would couple evidence projection to the replay guard. They do not hold reservations or revocations recorded after the fact. |
| Agent Passport event chain | A per-Passport lifecycle for a different aggregate (an agent's credential), with its own state machine. Its primitives (canonical JSON digest, per-aggregate chain, sealed head) **are** reused; its aggregate is not. |
| emergency-control event chain | The interlock's own store-wide history of operator transitions. It is authority state for the stop, not evidence of a governed action. |
| exercise-control ledger | Authority state for aggregate admission. Evidence must never be read to reconstruct consumption, and consumption must never be written as evidence (P7). |
| `EnterpriseUsageEvent` (`@aoc-enterprise/usage-event`) | A pure contract for observed use of an `EnterpriseAccessGrant` in the R004 access line — no persistence, no order, no chain, and a different grant model. A payment/action execution under a `BoundedGrant` is not an access/content usage observation; forcing it into that vocabulary would misname it. P8 does not replace or rename it; a later convergence (P9) can correlate the two by opaque id. |
| `EnterpriseEvidenceCorrelation` (`@aoc-enterprise/evidence-correlation`) | A graph of *which* immutable artifacts belong together — unordered by design. P8 is *ordered occurrence*. An event carries opaque references to the same artifacts a correlation would name; it does not embed a correlation, and no competing graph is created. |

### 3. Stage A scope: path-local

Stage A covers the current governed-action / bounded-grant lifecycle — requests
the Governed Action Orchestrator derived (`aoc.gar:`) — and nothing else. It is
not a claim that every Frontera module emits one universal stream.

The closed vocabulary, each emitted only after its fact is established:

| event | source fact, and where it is proven | `occurredAt` |
| --- | --- | --- |
| `governance.decision.committed` | the Governance Record committed **and re-read + verified** (`VerifiedDecision`), every status and every replay | the evaluation's `persistedAt` |
| `grant.issued` | `issueFromDecision` returned `grant-issued` (`issued` or `already-issued`) and the grant matched the persisted decision | `grant.issuedAt` |
| `grant.revoked` | the bounded-grant store returned `revoked` / `already-revoked` (ACE `revokeGrant`) | `revocation.revokedAt` |
| `grant.expiry.observed` | an exercise assessment of this grant reported `GRANT_EXERCISE_EXPIRED` (pre-assessment or exercise) | `grant.expiresAt` |
| `execution.attempt.claimed` | the write-ahead `execution_record` attempt row was appended by this call | the claim row's own `createdAt` |
| `exercise.reservation.reserved` | the P7 ledger returned `reserved` | the ledger's `reservedAt` |
| `exercise.reservation.settled` | the ledger returned `settled` / `already-settled` | the terminal event's `recordedAt` |
| `exercise.reservation.released` | the ledger returned `released` / `already-released` | the terminal event's `recordedAt` |
| `execution.outcome.observed` | ACE `exercise()` returned an `ExecutionOutcome` | `outcome.exercisedAt` |

Deliberately **not** events, because the current runtime persists no fact for
them: the transport request itself; an uncommitted Kernel answer; a Kernel that
threw or a commit that failed; admission-time and commit-boundary emergency
withholdings, `grant-terms`, `authority-binding` and `grant`/`obligations`
withholdings before a grant exists (the stream holds the committed decision and
stops); a pre-assessment withholding other than an observed expiry; an exercise
that threw (the stream holds the claim and no outcome — exactly the Governance
Store's "attempted, outcome not on record"). No obligation transition is
invented; none happens on this path.

**Expiry is observed, never scheduled.** There is no timer, sweeper or job. The
event is emitted only when existing code encounters the condition, is keyed by
the grant, and carries the grant's own `expiresAt` as `occurredAt` — so every
later observation of the same expiry resolves to the same event, and nothing
claims a transition was persisted at that instant.

### 4. Identity

- **Stream** = one governed-action request in one organization:
  `aoc.aes:` + digest(`aoc.authority-event-stream.v1`, organizationId, requestId).
  The request id is already server-derived from the bound organization, the bound
  principal and the idempotency key; the organization is an input too, so one
  request id under another tenant is another stream. Later facts (a revocation,
  a reservation terminal) reach the right stream through the grant's own
  correlation (`requestId`) — a trusted reference, read from the authoritative
  grant, never from a caller.
- **Event** = one immutable source fact:
  `aoc.aev:` + digest(`aoc.authority-event.v1`, streamId, eventType, sourceId),
  where `sourceId` is the evaluation, grant, execution or reservation id the
  fact is about. A retry, replay or restart re-derives the same id.
- Both digests go through the Governance Store's `computeDigest`
  (`aoc.canonical-json.v1`); there is no second canonicalization. Verification
  re-derives both ids from each event's own content.

### 4a. Ordering is the projector's queue, durability is still the store's

Removing the `await` must not let two appends for one stream race, so the
projector owns ordering:

- one serial chain per stream — the append for event N+1 is not invoked until
  N's has settled, whatever an async host-supplied store does with scheduling;
- chains are per key, so a stuck or slow stream holds only itself and another
  lifecycle keeps projecting;
- a revocation is reported before its lifecycle is known, so every fact carrying
  a `boundedGrantId` passes through that grant's **intake chain** in report
  order: the revocation's attribution read is a step of that chain, and a later
  fact of the same lifecycle cannot be placed in the stream ahead of it. A slow
  attribution therefore holds that grant's own evidence — a projector-side
  barrier — and nothing else. The committed decision carries no grant and goes
  straight to its stream;
- the queue chooses nothing about an event: sequence, previous digest,
  `recordedAt` and the digest stay the store's, assigned inside its own
  `BEGIN IMMEDIATE` section;
- a chain continues past a failed step, so one lost event does not strand the
  rest of its stream;
- the only scheduling mechanism is a microtask hop. There is no timer, interval,
  worker, retry scheduler or sweeper — and a failed projection is still not
  retried (§8).

Report order for one lifecycle therefore survives asynchronous attribution: a
revocation reported between a claim and an outcome is appended between them.
`occurredAt` is still the revocation instant, and sequence remains append
order.

**Queue depth is visible, never load-bearing.** The projector's health carries
`pending`; the module surfaces it. A number that stops falling is how an
operator sees a stuck store. No authority path reads it, and none waits on it.

### 5. Ordering and integrity

Per stream: sequence 1, 2, 3… assigned by the store; the first event is the
committed decision and carries no previous digest; every later event names the
immediately preceding event's digest. The event digest covers schema version,
event id, stream id, organization, type, sequence, `occurredAt`, `recordedAt`,
references, payload and previous digest. A sealed per-stream **head** (sequence +
last digest, digested) is a cross-check, never trusted before the chain it
summarizes is verified; any disagreement fails verification. Nothing is
repaired, truncated or presented as a verified prefix.

SQLite appends are one `BEGIN IMMEDIATE` transaction: load and verify the stream
and head → resolve the event id → choose head + 1 → sample `recordedAt` → insert
event → advance head. `UNIQUE (stream_id, sequence)` is a second, independent
refusal of a duplicate position. Triggers refuse `UPDATE`/`DELETE` on events and
`DELETE` on heads. Worker-thread races prove no fork, gap, duplicate or loss.

**Integrity, not authenticity.** Unkeyed SHA-256: a writer who can rewrite a
whole stream and re-seal it (or delete a stream with its head) is not detected
from inside the file. Signatures, KMS/HSM and an external anchor are later work
(P12).

### 6. `occurredAt` and `recordedAt`

`occurredAt` is the trusted instant of the source fact, taken from the
authoritative artifact (table above) — never projection time. `recordedAt` is the
store's injected clock, sampled inside the append critical section, never caller
input. Order is append order; `occurredAt` may be earlier than a previous event's
(an expiry observed late; a revocation recorded after the fact).

### 7. Idempotency

Same event id + byte-equivalent canonical fact (everything the projector supplied;
not sequence or `recordedAt`) → the existing event, unchanged. Same id + a
different fact → `AUTHORITY_EVENT_CONFLICT`, nothing written; never
last-write-wins. The stream is **not** the replay guard: a governed-action replay
is answered by the Governance Store's attempt row exactly as before, and the only
event a replay re-projects — the committed decision — resolves to the event
already recorded.

### 8. Failure semantics

A projection that fails — invalid fact, conflict, corrupt stream, closed or
unopenable store, a recorder that throws, an append that rejects or never
settles — is counted in the projector's health
and reported through the `aoc.enterprise.authority-event-stream` module
(`degraded` / `unhealthy`), an existing internal surface. The module is
`optional` and never throws at initialization, so it can neither block startup
nor take the Host out of `ready`. It never changes a decision, grant, revocation,
reservation, routing, adapter invocation or outcome, and it adds no request or
response field. A store that cannot be opened at startup degrades the stream, not
the Host.

Stage A does not retry or reconcile. A projection that failed is lost, and a
projection still queued when the process stops is lost with it: the stream can
be **shorter** than what happened, never different. Verification proves the
integrity and order of what is present; it cannot prove semantic completeness,
so an absent event is never evidence that its fact did not occur. The
authoritative stores remain the record for that.

### 9. Tenancy

Every store call carries an organization scope with no `system` escape; a stream's
organization is fixed by its first event and sealed in its head; appends, reads and
verifies under another organization are refused; a forged stream id is refused on
identity. The projector serves exactly the organization the orchestrator serves.

### 10. Payload discipline

Closed per type: exactly the declared references and payload keys; opaque
server-derived ids, digests, closed vocabularies, canonical instants, recordable
adapter ids and a bounded `providerRef` (≤ 512 chars; never dereferenced, never
executable, never proof of execution). Values shaped like a bearer credential,
basic auth, JWT, PEM key, URL, cookie or authorization header, or containing
control characters, are refused by the store; the projector omits a
`providerRef` of that shape rather than record it. Never copied: the Governance
Record, the grant, the reservation record, the intent, `assertedContext`, the
correlation id a caller chose, headers, URLs, credentials, adapter `detail`,
provider responses. Execution certainty is preserved exactly: `executed`,
`execution-failed` (with its reason), `execution-unconfirmed`, and `withheld`
(with its layer — `grant-exercise`, `emergency-control`, `exercise-control` — and
that layer's own codes); the store refuses payloads that blur them.

## Consequences

- An auditor gets one verified, ordered, tenant-scoped account of each governed
  action, reachable only through the read-only `AocEnterprise.authorityEventStream`.
- No endpoint, SDK method, request or response field is added (28 endpoints; SDK
  `1.1.0`). The public result is unchanged.
- The Kernel, the grant, execution, exercise-control and emergency runtimes do
  not know the stream exists.

## Non-goals

Worker-thread or process isolation for projection (Stage A accepts shared-loop
latency; see §1a); a generic bus; Kafka, NATS, Redis Streams, SSE, WebSocket or
webhooks; a public
read API; cross-tenant or global ordering; cross-region replication; distributed
consensus; exactly-once; WORM storage; signatures, KMS/HSM (P12); behavioural or
risk intelligence; system-wide coverage beyond the governed-action lifecycle;
retention, TTL or cleanup; portability v1 backup of the stream file; model
convergence with `EnterpriseUsageEvent` / `EnterpriseEvidenceCorrelation` (P9);
XRPL.
