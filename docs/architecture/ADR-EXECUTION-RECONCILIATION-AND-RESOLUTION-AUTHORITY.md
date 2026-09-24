# ADR — Execution Reconciliation and Resolution Authority (P12)

- **Status:** Accepted
- **Increment:** P12
- **Depends on:** `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11), `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7),
  `ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md` (P8), `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9),
  `ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md` (P10)
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-111 … SEC-INV-122
- **Leaves for later:** business-level idempotency (P13), provider-specific resolvers and credential
  custody (P14 Stripe, P18 XRPL), receipts and settlement (P15), scheduling and monitoring (P16),
  signatures / KMS / HSM (P20)

## 1. Context

P11 made every governed execution's exact attempt and its **initial** provider observation durable
and immutable. It deliberately left four states unresolved (ADR-DURABLE-MONETARY-OUTCOMES §13):

| state | what P11 knows | P12 classification |
| --- | --- | --- |
| A. claim + attempt, **no observation** | the exact attempt; the effect may or may not have happened | **eligible** (`no-initial-observation`) |
| B. observation `unconfirmed`, `providerRef` present | the provider said "unknown"; a handle exists | **eligible** (`initial-observation-unconfirmed`); the handle is passed to the authority, never dereferenced |
| C. observation `unconfirmed`, no `providerRef` | the provider said "unknown" | **eligible**; whether it can be answered is the authority's business |
| D. P11 record fails verification | nothing trustworthy: not the amount, the asset, the correlation or the reference | **never eligible** — `basis-unavailable / outcome-corrupt`, the authority is not asked. P12 is not a repair mechanism |

P7 had settled the unconfirmed reservation `execution-unconfirmed`: the provider may have acted,
so capacity stayed consumed. P7 had no way to give it back, because its one terminal event per
reservation is immutable — the only release it knew was `release()` on a reservation that had no
terminal event yet.

## 2. Decision

> **An uncertain execution may be resolved only by its durably bound, trusted resolution authority —
> never by the caller, never by replay, never by inference, and never by retrying the effect.
> Reconciliation produces a new durable fact; it never edits history.**

```text
P11 attempt
     │
P11 initial observation? ─────────────┐
     │                                │
     ▼                                │
P12 authority binding                 │
     │                                │
     ▼                                │
trusted reconciliation                │
     │                                │
     ├── unresolved ──────────────────┘
     │
     ▼
P12 definitive resolution
     │
     ├── completed ──→ P7 remains consumed
     │
     └── not completed → P7 reconciliation release
     │
     ▼
P8 / Governance evidence
```

### 2.1 Three concepts, kept apart

| concept | owner | values |
| --- | --- | --- |
| **initial observation** | P11, immutable | `confirmed-completed`, `confirmed-not-completed`, `unconfirmed`, absent |
| **reconciliation** — asking a trusted authority | the P12 service, explicit and in-process | `resolved`, `unresolved` |
| **resolution** — the definitive answer after uncertainty | the P12 store, immutable | `confirmed-completed`, `confirmed-not-completed` + an existing `ExecutionFailureReason` |

**Why P11 is never rewritten.** The original uncertainty genuinely existed. "At T0 Frontera did
not know; at T1 a trusted authority established it did not complete" is the true history. Writing
`confirmed-not-completed` into P11 would claim Frontera knew at T0.

**Why a resolution is a separate fact.** It has a different source (a resolution authority, not
the execution adapter), a different time, and a different trust boundary. It commits to the P11
attempt digest, its own binding digest, and — when it resolves an `unconfirmed` observation —
that observation's digest, so it proves exactly which uncertainty it answered.

**Resolution is not settlement.** It answers "did the original provider effect complete?". Not
funds, bank settlement, ledger finality, receipts, obligations or refunds (P15).

**Resolution is not authority.** Nothing here passes through the Kernel, grant issuance, the
Authority Graph or policy packs. The effect was authorized once; a resolution never rewrites that
decision, raises a ceiling, issues a grant or changes an amount.

## 3. The resolution authority

```ts
interface ExecutionResolutionAuthority {
  readonly authorityId: string;
  resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult>;
}
```

- **Trusted host / operator integration**, composed at `createEnterprise()`. It is trusted to
  answer provider truth. **Compromise of it can falsely return capacity** (a lying "not
  completed") **or falsely keep it consumed** (a lying "completed"). That is a new trust boundary,
  stated as one (`TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`), not hidden behind "adapter".
- **Read-only with respect to the original effect.** It may query provider state; it must not
  execute, resubmit or mutate the original action to learn it. Frontera never calls an
  `ExecutionAdapter` to reconcile.
- **No spending authority.** The query carries the verified P11 attempt as context (ids, action,
  exact amount text) and the P11 `providerRef`. The answer has no field for an amount, asset,
  grant, budget, decision or correlation, and one would be refused.
- **Closed answer.** `resolved / confirmed-completed [providerRef]`,
  `resolved / confirmed-not-completed + failure [providerRef]`, or `unresolved`. No
  probability, score or confidence. `confirmed-not-completed` requires one of the **existing**
  `PROVIDER_REJECTED | PROVIDER_UNAVAILABLE | PROVIDER_RESPONSE_INVALID | ADAPTER_ERROR`; an
  authority that cannot classify a non-completion truthfully answers `unresolved`. The v1 wire
  gains no fifth reason.
- **Normalized as external output.** Read from own **data** descriptors only (an accessor or a
  Proxy `get` trap is never consulted), exactly the declared keys, copied into a fresh frozen
  object. A non-string `providerRef` is refused; a string that `isRecordableProviderRef` rejects is
  omitted — P11's rule, reused — and never changes certainty.
- **No credentials cross the port**, and none is persisted. A future Stripe (P14) or XRPL (P18)
  resolver owns its own.

**No generic resolver exists.** Generic HTTP's `providerRef` is opaque and there is no generic
status protocol; P12 core never parses, dereferences or `fetch`es it, and adds no status URL
configuration. Without a host-composed authority for that provider, its executions stay
unresolved — correctly.

## 4. Binding before the claim

```text
P11 prepare attempt  →  P12 bind resolution authority  →  write-ahead claim  →  provider
```

With reconciliation enabled, the orchestrator binds each new execution to one composed authority
**after** P11 preparation and **before** the claim. The host's `selectAuthority(context)` is
trusted, synchronous, snapshotted at composition and sees only the prepared attempt's fields —
never asserted context, the body, headers or credentials. It must return exactly one composed id:
a throw, a promise, an object, a blank or unknown id stops the request with the existing
`system_error / GOVERNED_ACTION_EXECUTION_CLAIM_FAILED`, before the claim and the provider, and
the request stays retryable. There is no fallback authority and no "first wins".

A retry after a crash between binding and claim **reuses** its binding; the selector is asked only
when none exists. A binding is immutable: the same `(execution, attempt, authority)` is
idempotent, another authority is `EXECUTION_RESOLUTION_CONFLICT`.

**Why before the claim.** It makes state A — claim, no observation — reconcilable **without
guessing**. The alternative, running today's selector or routing after a restart, would answer
"which provider did yesterday's execution reach?" from configuration that may have changed. P12
never does that: reconciliation reads the durable binding, and a bound authority that is no longer
composed is `authority-unavailable / not-composed`, never substituted.

**Legacy executions.** Pre-P12 executions have no binding and are **not** silently assigned one.
A trusted operator may call `adoptResolutionAuthority({ organizationId, executionId, authorityId })`
for a claimed, P11-recorded, still-uncertain execution. It binds (`origin: 'adopted'`); it never
declares an outcome. Pre-P11 executions have no attempt digest and are not eligible.

## 5. Persistence: a dedicated store

`src/enterprise/execution-resolution-store/` — its own SQLite file
(`executionResolution.sqlitePath`, `AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH`, default
`.data/execution-resolutions.sqlite`), never the P11 file. P11 owns attempt + initial
observation; P12 owns binding + definitive resolution.

| table | PK | commits to (digest) |
| --- | --- | --- |
| `execution_resolution_bindings` | `execution_id` | organization, execution, P11 attempt digest, authority, origin, `boundAt`, `recordedAt`, schema |
| `execution_resolutions` | `execution_id` | organization, execution, attempt digest, binding digest, basis observation digest?, authority, certainty, failure?, providerRef?, `resolvedAt`, `recordedAt`, schema |

`aoc.canonical-json.v1` + SHA-256, domain-separated. WAL, `synchronous = FULL`, `BEGIN
IMMEDIATE` per write decision, busy timeout, unknown schema refused before mutation, every read
re-validated and re-digested, triggers refuse `UPDATE`/`DELETE`, no repair-on-read. A resolution
requires the binding on record (`EXECUTION_RESOLUTION_NOT_BOUND` otherwise); the identical answer
(any `resolvedAt`) is idempotent, any other is a conflict. Tenant-confined, no `system` escape.
**Integrity is not authenticity** (P20).

## 6. Reconciliation: explicit, trusted, one query

`AocEnterprise.executionReconciliation.reconcile({ organizationId, executionId })`:

1. Load and verify the P11 attempt — corrupt → `basis-unavailable / outcome-corrupt`.
2. Verify the **existing** Governance write-ahead claim (`executionClaimRecorded`, the same
   definition replay uses) — prepared-but-unclaimed is `not-eligible / not-claimed`: it never
   reached a provider and stays retryable under P11.
3. Initial observation confirmed → `not-eligible / initial-observation-definitive`; withheld →
   `not-eligible / withheld`.
4. Load and verify the P12 binding — absent → `authority-unavailable / unbound`.
5. A definitive resolution already on record → **do not ask again**; finish any pending P7 row.
6. Ask the bound authority **once**, outside every transaction; normalize.
7. `unresolved` → nothing written, nothing released. A later explicit call may ask again.
8. Append the resolution **first**; then the P7 row; then evidence.

No `setInterval`, cron, poll loop, startup scan or retry queue. No customer route or SDK method.
**Unresolved may stay unresolved forever**: time is never evidence, and "no provider record" is a
definitive answer only if the bound authority itself declares it so.

**Concurrency.** Calls for one execution in one process share one in-flight reconciliation (one
query). Across processes two read-only lookups may race; the store's `BEGIN IMMEDIATE` admits one
resolution — identical answers converge, a different one is `conflict`, and only the winner
reaches P7. No transaction is held across a network call.

## 7. Replay

```text
verified definitive P12 resolution          (only for P11 states A–C)
  ↓ if absent / unreadable / corrupt / not matching this attempt and this uncertainty
verified P11 initial observation
  ↓ if absent
claim-only unresolved                        (…_ALREADY_ATTEMPTED)
  ↓ only when no P11 attempt exists
pre-P11 Governance summary
```

**Ordinary replay never queries a provider or an authority.** The orchestrator holds a binder and
a read-only resolution reader — no authority, no `resolve`, no reconciliation service
(structurally tested). Resolved completion replays `executed` (`providerRef`: the resolution's,
else P11's — both preserved in their own records), resolved non-completion `execution_failed`
with its reason; both `replayed: true`, `outcomeRecorded: true`. A P12 store that cannot prove its
answer leaves the replay exactly as P11 alone answers it — still `execution_unconfirmed`, never
optimistic. A definitive P11 observation is never consulted against P12 at all.

## 8. P7: a second immutable fact, never a rewritten first one

`exercise_control_reservation_resolutions` — one immutable row per reservation, in the **same**
ledger file, bound to the P12 `resolutionDigest`, written only through the narrow
`ExerciseControlReconciliationPort.reconcileResolution`. The exercise gate is not given it; the
reconciliation service is given only it (a fresh one-method object).

```text
reservation → settled (execution-unconfirmed)          ← stays exactly as written
            → resolution row: confirmed-not-completed  ← new, bound to the P12 digest
```

**Why the original settle event remains.** It was true when written: the provider may have acted.
Rewriting it to `released` would claim the runtime knew at the time.

**Why confirmed-not-completed may return capacity.** A reservation exists to cover an effect that
happened or may have. Once the trusted authority establishes it did not, keeping the capacity
consumed would be an availability loss with no safety justification. `confirmed-completed` never
creates capacity.

**Effective consumption**, applied only to rows **already verified** (a tampered resolution fails
its bucket closed; a deleted one only makes capacity consumed again):

```text
reserved | settled                                   consumes
released                                             does not consume
+ resolution confirmed-completed                     consumes
+ resolution confirmed-not-completed                 does not consume — in every bucket, atomically
resolution contradicted by the ledger's own history  consumes (a contradiction never returns capacity):
  not-completed, then the runtime settled `executed`
  completed, then the runtime released it
```

The row is decided inside the same `BEGIN IMMEDIATE` lock as admission, so a returned capacity
and new reservations competing for it serialize; there is no side table of "remaining budget".
The ledger refuses (`inconsistent`, nothing written or repaired) a row its own history
contradicts: a released reservation resolved completed, an `unconfirmed` observation whose
reservation was released, a reservation settled `executed` resolved not-completed.

No P7 reservation (no exercise controls, or a crash before admission) is `no-reservation`: the
resolution stands and nothing is fabricated. A host-supplied ledger without the capability is
`not-composed`: capacity stays conservatively consumed.

## 9. Crash ordering — no cross-store atomicity, and none pretended

| window | durable state | behaviour |
| --- | --- | --- |
| binding fails | attempt, no binding, no claim | `system_error / …_CLAIM_FAILED`; provider calls 0; retry safe |
| crash after binding, before claim | attempt + binding | retry reuses the binding; one execution |
| crash after claim | attempt + binding + claim (+ P7 reserved) | replay `…_ALREADY_ATTEMPTED`; reconcilable (`no-initial-observation`) |
| authority unavailable / throws / invalid | unchanged | `authority-unavailable`; no P7 change; no retry of the effect |
| resolution append fails | unchanged | `resolution-unrecorded`; no capacity moves (no durable justification) |
| crash after resolution, before P7 row | resolution durable, P7 unchanged | replay already answers from the resolution; capacity conservatively consumed; next `reconcile` applies the row **without asking the authority** |
| P7 unreachable | resolution durable | `capacity: 'pending'`; the resolution is never deleted; retry never re-asks |
| crash after P7 row, before evidence | resolution + P7 row | replay and capacity correct; P8 / Governance evidence missing — never load-bearing |

**Why the resolution commits before the P7 correction.** Resolution-then-P7 fails in the
conservative direction: a crash between them loses availability, never widens capacity. The
reverse would return capacity with no durable justification.

## 10. Evidence

- P8: `execution.outcome.resolved` (certainty, failure?, authorityId, providerRef?,
  resolutionDigest) and `exercise.reservation.reconciled` (resolution, resolutionDigest) — new
  events, through a separate write-only `ExecutionResolutionEvidenceRecorder`. The original
  `execution.outcome.observed / execution-unconfirmed` event stays. P8 is never read.
- Governance: a new `execution_record` reference (`executionResolutionReferenceId`, distinct from
  the P11 summary's id), `externalVersion` `resolved:<certainty>[:<failure>]`, `digest` =
  resolution digest. The P11 summary is never touched.
- Order: resolution → P7 → P8 → Governance. Evidence can never claim a resolution the canonical
  store does not hold.

## 11. Composition, surfaces, operations

```ts
createEnterprise({
  …,
  executionReconciliation: { enabled: true, authorities: [myResolver], selectAuthority: () => 'my-resolver' },
});
```

- Optional. Omitted, P11 behaviour is unchanged. Enabled, it requires governed actions; ids must
  be unique and recordable; a selector is required; membership is frozen at composition.
- The store opens at startup; one that cannot be opened **fails startup** (no silent memory
  fallback when SQLite was requested). A host-supplied store is never closed by the Host.
- `AocEnterprise.executionReconciliation` (reconcile, adopt) and `AocEnterprise.executionResolutions`
  (read-only), trusted in-process only.
- Health: module `aoc.enterprise.execution-resolutions`, `optional`; it reports store health and
  `authoritiesComposed` — never provider connectivity (P16).
- Portability v1 backup does not include the file, as for P7, P8 and P11 (P17).

## 12. Public contract

No endpoint (28 unchanged), no SDK change, no status, no response field, no reason code, no
`withheldBy` value. `outcomeRecorded: true` now also covers a replay backed by a P12 resolution.
The P12 self-report vocabulary (`resolution`, `resolved`, `reconciled`, `reconciliation`,
`resolutionAuthority`, `resolutionAuthorityId`, `providerResolution`, `providerOutcome`,
`finalOutcome`, `confirmedCompleted`, `confirmedNotCompleted`) joins the reserved `assertedContext`
keys.

## 13. What P12 is not

Not exactly-once: it closes uncertainty only when a trusted authority can later prove what
happened. Not a retry: a proven non-completion returns capacity and nothing else — the claim
stays, the execution id is never re-run, no grant is re-issued (a deliberate second payment is a
new P13 business operation; P13 defines no retry). No
reservation TTL, no timeout-as-evidence, no polling, no receipts, settlement, Stripe, MPP, XRPL,
KMS or HSM.
