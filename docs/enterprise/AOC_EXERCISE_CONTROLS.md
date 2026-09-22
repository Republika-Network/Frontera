# AOC Exercise Controls (P7)

> **The grant covered this attempt. Does repeated use of it still fit the
> trusted aggregate limits, and does the authority it was issued under still
> stand exactly?**

Aggregate / velocity exercise controls, a durable reservation ledger, and
exercise-time authority-binding revalidation for the bounded-grant execution
path. Decision record: `docs/architecture/ADR-EXERCISE-AGGREGATE-CONTROLS.md`.

**Opt-in and path-local.** Nothing here applies unless a host composes
`authorityControlledExecution.exerciseControls`, and nothing here applies to any
path that does not run through bounded-grant execution.

---

## 1. Why

A `BoundedGrant` proves each attempt fits: holder, action, resource,
counterparty, organization, amount ceiling, correlation, expiry, revocation,
integrity. It does not bound how many times, or how much in total, it is used
before it expires. P7 adds that — as additional **narrowing** only. It can stop
an effect the grant covered; it can never permit one the grant did not.

## 2. Composition

```ts
createEnterprise({
  authorityControlledExecution: {
    grantCapability, executionAdapterRouting, resolveAuthorityBinding,
    exerciseControls: {
      policy: (query) => [
        { limitId: 'grant-uses',   scopeKey: `grant:${query.boundedGrantId}`, metric: 'count',  maximum: 3, window: { kind: 'lifetime' } },
        { limitId: 'actor-spend',  scopeKey: `actor:${query.subject}`,        metric: 'amount', maximum: '10000', unit: 'USD', window: { kind: 'rolling', seconds: 86_400 } },
        { limitId: 'org-velocity', scopeKey: `org:${query.organization}`,     metric: 'count',  maximum: 60, window: { kind: 'rolling', seconds: 60 } },
      ],
      revalidateAuthorityBinding: (query) => currentBindingFor(query), // synchronous, read-only
      // ledger?: ExerciseControlLedgerPort  — host-owned; omitted → durable SQLite
    },
  },
});
```

| member | required | trust |
| --- | --- | --- |
| `policy` | **yes** | trusted host code; synchronous; no I/O |
| `revalidateAuthorityBinding` | **yes** | trusted host code; synchronous; read-only |
| `ledger` | no | host-supplied store, host-owned and host-closed |

Startup is refused (`EXECUTION_EXERCISE_CONTROLS_INVALID`) — before any store,
ledger file or listener exists — when the policy or the resolver is missing or
not a function, when a supplied ledger does not implement the port, or when no
ledger is supplied and `exerciseLedger.sqlitePath` is empty.

**Default ledger.** With no `ledger`, the composition root opens the durable
SQLite ledger at `exerciseLedger.sqlitePath`
(`AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH`, default
`.data/exercise-ledger.sqlite`) — **always the durable one**, whatever
`persistence.provider` says, because an aggregate limit whose consumption is
forgotten on restart fails open. The file is never opened or created when P7 is
not composed. A ledger the composition root opened is closed on `close()`; a
host-supplied ledger is never closed by the Enterprise.

An `aoc.enterprise.exercise-control` module is registered (optional
criticality) and reports the ledger's readable/writable health.

## 3. The canonical gate, with P7

```
authoritative grant read
  → containment assessment            unusable → withheld / grant-exercise
  → emergency control                 active or unreadable → withheld / emergency-control   (no reservation)
  → authority-binding revalidation #1 → withheld / exercise-control                          (no reservation)
  → trusted policy snapshot           invalid → withheld / exercise-control                  (no reservation)
  → ATOMIC RESERVATION                refused / conflict / unavailable → withheld / exercise-control
  → authority-binding revalidation #2 changed → RELEASE, withheld / exercise-control
  → emergency control re-check        stopped → RELEASE, withheld / emergency-control
  → adapter / registry                adapter-scoped stop → RELEASE, withheld / emergency-control
  → settle | release                  from the observed outcome
```

There is still exactly one route to `ExecutionAdapter.execute(...)` (plus the
registry's child call). With P7 composed, no adapter call happens without a
reservation. Every exit after the reservation passes through one finalization
helper whose disposition is exhaustive over `ExecutionOutcome`.

## 4. The limit contract

```ts
type ExerciseControlLimit =
  | { limitId; scopeKey; metric: 'count';  maximum: /* positive safe integer */ number; window }
  | { limitId; scopeKey; metric: 'amount'; maximum: /* canonical decimal */ string; unit: string; window };
type ExerciseControlWindow = { kind: 'lifetime' } | { kind: 'rolling'; seconds: /* 1 … 31_536_000 */ number };
```

- `limitId` — `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`.
- `scopeKey` — opaque host data, ≤ 512 UTF-8 bytes, no control characters, no
  surrounding whitespace. The runtime never parses it and invents no grouping:
  the host policy chooses buckets.
- ≤ 32 limits per exercise; a duplicate `(limitId, scopeKey)` is refused.
- Exactly these keys: an extra key (an adapter hint, a URL) is refused.
- The policy's answer is read once into a frozen snapshot; a throw, a promise, an
  accessor, a misbehaving `Proxy` or any out-of-contract value is
  `EXERCISE_CONTROL_POLICY_INVALID`.
- An empty answer is valid: no aggregate limit applies, and the execution
  identity is still reserved.

**The policy query** holds only trusted, contained material: `boundedGrantId`,
`subject`, `grantIssuedAt`, `grantExpiresAt` (from the authoritative grant),
`action`, `resource`, `counterparty?`, `organization?`, `amount?` (each already
proven inside the grant), `correlation`, and the exercise instant `at`. No raw
intent, no `assertedContext`, no provider URL, header, credential or adapter
configuration, no store and no Kernel handle. It is frozen.

## 5. Semantics

**Count.** One unit per reserved execution identity. `reserved` and `settled`
count; `released` does not.

**Rolling windows** age by **reservation** time, never settlement time: a
reservation counts while `reservedAt > at − seconds`. A reservation apparently
in the future counts, so a clock set back frees nothing.

**Amount.** The attempt must state an amount (`EXERCISE_CONTROL_AMOUNT_REQUIRED`)
in exactly the limit's unit (`EXERCISE_CONTROL_UNIT_MISMATCH`); usage already
recorded in a bucket under a different unit or metric is never converted and
refuses the bucket (`EXERCISE_CONTROL_UNIT_MISMATCH`). Canonical decimal text:
`0`, or `[1-9][0-9]*` optionally followed by `.[0-9]*[1-9]` — no sign, exponent,
leading zero or trailing fractional zero; maxima ≤ 128 digits. The attempt's
JavaScript number is converted once (`1e-7 → 0.0000001`, `0.1 → 0.1`); every
sum is `BigInt`. `0.1 + 0.2` under `0.3` is exactly full.

**All or nothing.** Every applicable limit is admitted together inside one
transaction, or the reservation is refused and nothing is written.

## 6. Reservations

- **Identity.** `aoc.exercise-reservation:<sha256(boundedGrantId, executionId)[0..32]>`
  — deterministic, never random.
- **Fingerprints.** A canonical request digest (grant, execution id, subject,
  action, resource, counterparty, organization, canonical amount, correlation),
  a canonical policy digest (the sorted effective limit set — return order does
  not matter; any actual change does), and the grant's binding provenance.
- **Re-delivery.** The same id with the same request, policy and provenance →
  `EXERCISE_CONTROL_EXECUTION_ALREADY_RESERVED`; the adapter is not invoked
  again. Any difference → `EXERCISE_CONTROL_RESERVATION_CONFLICT`. The same
  execution id under a *different* grant is a conflict too: an execution
  identity is one attempt.
- **Finalization.** `executed` and `execution-unconfirmed` settle;
  `execution-failed` (including an adapter throw or malformed result) and every
  post-reservation withholding release. One immutable terminal event; identical
  repetition is idempotent; settle-after-release and release-after-settle are
  refused.
- **Failure to finalize** leaves the reservation `reserved` — still consuming —
  and never rewrites the provider outcome.

Generic HTTP (P6) statuses therefore map as: 200/201/204 → settle; other 2xx,
3xx, 408, 5xx and post-TLS ambiguity → `execution-unconfirmed` → **settle**;
ordinary 4xx → `PROVIDER_REJECTED` → release. P6's status mapping is unchanged.

## 7. Durable SQLite ledger

Schema `aoc.exercise-control-ledger.schema.v1`; WAL, `foreign_keys = ON`,
`synchronous = FULL`, bounded `busy_timeout`.

| table | role |
| --- | --- |
| `exercise_control_reservations` | immutable base record (unique `execution_id`) |
| `exercise_control_reservation_limits` | one row per applicable limit and its usage; indexed `(limit_id, scope_key, reserved_at_ms)` |
| `exercise_control_terminal_events` | at most one per reservation (primary key) |
| `exercise_control_bucket_heads` | sealed per-bucket rule-row count — a cross-check, never a source of truth |

- **Admission** is `BEGIN IMMEDIATE`: the write lock is held from the first
  usage read to `COMMIT`. Two independent connections — or worker threads —
  racing for the last unit never both win (`exercise-control-concurrency.test.ts`).
- **Append-only**: triggers refuse `UPDATE` and `DELETE` on reservations, rule
  rows and terminal events, and `DELETE` on bucket heads.
- **Validation on every read that counts**: schema version, record digest, rule
  digests, rule count and ordinals, reservation instant, reservation-id
  derivation, policy digest, terminal-event digest and vocabulary, and the
  bucket head. Any failure → `EXERCISE_CONTROL_LEDGER_STATE_CORRUPT` →
  `EXERCISE_CONTROL_LEDGER_UNAVAILABLE`, no adapter. Never repaired.
- **Unknown schema version** is refused at open, before anything is mutated.
- **No expiry and no startup cleanup.** Reopening changes no reservation.
- **Exact text.** Usage and maxima are `TEXT`; nothing sums a floating column.

## 8. Exercise-time authority-binding revalidation

At issuance, ACE computes `grantAuthorityBindingDigest(binding)` — SHA-256 over
`serializeGrantAuthorityBinding`, which covers `kind`, `authorityKind`,
`authorityRef`, `expiresAt` (bounded) or `kind`, `sourceKind`, `justification`
(no-temporal), in fixed order — and commits it onto the grant as
`authorityBindingDigest`. The commit-boundary field-by-field comparison is
unchanged and still load-bearing.

At exercise, `revalidateAuthorityBinding` is asked which binding holds now. Its
digest must equal the grant's exactly:

| situation | result |
| --- | --- |
| same binding | proceeds |
| changed `authorityRef`, same expiry | `EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED` |
| shortened (or extended) horizon, even if it still outlasts the action | `…_CHANGED` |
| bounded ↔ no-temporal, changed justification or source kind | `…_CHANGED` |
| `undefined`, throw, promise, malformed or accessor-bearing binding | `EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE` |
| grant without provenance (pre-P7) | `…_UNVERIFIABLE` |

Checked twice — before and after the reservation. **Residual TOCTOU:** this is
not a distributed transaction. Frontera revalidates immediately before crossing
its execution boundary; a binding can still change after the last check and
before or during provider execution. No atomic external binding,
linearizability, two-phase commit or exactly-once is claimed.

**Backward compatibility.** `authorityBindingDigest` is optional in the grant
artifact. A pre-P7 grant keeps its canonical bytes, deterministic id and digest,
and its SQLite row reopens unchanged. It executes exactly as before when P7 is
not composed, and is withheld as unverifiable when P7 is composed.

## 9. Emergency control interaction

Active or unreadable before the reservation → no reservation, no adapter. Activated
during the reservation → the re-check sees it, the reservation is released, no
adapter. An adapter-scoped stop in the registry → the authenticated
`EmergencyControlWithheldError` is reported as `withheld / emergency-control`
exactly as before, and the reservation is released. An emergency stop is never
classified as an aggregate limit, a provider failure or a grant failure.

## 10. Public surface

- Internal `withheldBy: 'exercise-control'` maps to the **existing** public
  `withheldBy: 'exercise'`, carrying `EXERCISE_CONTROL_*` reason codes, with the
  existing withheld HTTP status (409). The request shape, the status union, the
  `withheldBy` union, the SDK (1.1.0, five runtime exports, zero dependencies)
  and the 28 frozen endpoints are unchanged.
- No result carries a reservation, reservation id, limit id, scope key,
  remaining quota, policy digest, binding digest or ledger state.
- No route (`/api/limits`, `/api/quotas`, `/api/budgets`, `/api/reservations`, …)
  and no SDK method exists. P7 has no HTTP administration surface.
- A caller cannot name any P7 structure: `limit`, `limits`, `limitId`,
  `scopeKey`, `quota`, `budget`, `velocity`, `window`, `windowSeconds`,
  `maximum`, `maxCount`, `maxAmount`, `reservation`, `reservationId`,
  `exerciseControls`, `aggregateControls` and `authorityBindingDigest` are
  undeclared intent fields, and reserved `assertedContext` keys.

## 11. Evidence and replay

The Governed Action execution ledger records an exercise-control withholding as
`withheld:exercise-control:<CODE>,<CODE>…`, validated against the closed
exercise-control vocabulary, and replays it as `withheld / exercise` with the
recorded codes. Historical rows (the unlayered Prompt 3 form, `grant-exercise`,
`emergency-control`, and every P6 effect encoding) read exactly as before.
Replay reserves nothing and calls no provider; the governed-action ledger
remains the only owner of historical outcome replay.

## 12. Reason codes (`EXERCISE_CONTROL_REASON_CODES`)

`EXERCISE_CONTROL_POLICY_INVALID`, `…_LEDGER_UNAVAILABLE`, `…_LIMIT_EXCEEDED`,
`…_AMOUNT_REQUIRED`, `…_UNIT_MISMATCH`, `…_EXECUTION_ALREADY_RESERVED`,
`…_RESERVATION_CONFLICT`, `…_AUTHORITY_BINDING_UNVERIFIABLE`,
`…_AUTHORITY_BINDING_CHANGED`. Disjoint from every other vocabulary; owned by
`src/features/exercise-control-runtime`. Never placed in
`BoundedGrantExerciseAssessment.reasonCodes`.

## 13. Limits and residual risks

- The policy and the binding resolver are **trusted** host code.
- Process compromise, or a filesystem writer able to rewrite the ledger and
  re-seal every digest (or delete whole reservations consistently), defeats it:
  digests are unkeyed integrity, not authenticity; no KMS/HSM.
- A rule row whose indexed timestamp is rewritten backwards is not read by a
  rolling range scan (its bucket head still matches); it fails validation the
  moment its reservation is read, finalized or counted by a lifetime bucket.
- One SQLite file serializes one host's processes. No distributed consensus;
  separate databases on different hosts do not share quota; SQLite on a network
  filesystem that does not honour its locking is not a distributed lock.
- No reservation reconciliation, no automatic abandoned-reservation recovery,
  no exactly-once, no atomic transaction with the provider.
- Amount input precision is bounded by the caller's JSON / JavaScript number.
- No FX or unit conversion.
- Stage-A scale: admission is linear in a bucket's indexed rows.

## 14. Out of scope

Canonical event stream (P8), model convergence (P9), XRPL adapter or signer,
KMS/HSM, process sandbox, network namespace, egress firewall, distributed quota
(Redis, etcd, consensus, cross-region), reconciliation, manual release API,
stale-reservation cleanup, provider polling, exactly-once, FX or unit
conversion, dynamic provider limits, customer-defined quota, quota routes,
risk/behaviour AI, Live Data Rail, Pinata or Stripe migration.
