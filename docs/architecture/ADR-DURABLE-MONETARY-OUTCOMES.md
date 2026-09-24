# ADR — Durable Monetary Outcomes and Provider Certainty (P11)

- **Status:** Accepted
- **Increment:** P11
- **Depends on:** `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`, `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7),
  `ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md` (P8), `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9),
  `ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md` (P10)
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-102 … SEC-INV-110
- **Hands off to:** P12 (execution reconciliation and resolution authority)

## 1. Context

Through P10 the governed-action path was:

```text
durable write-ahead claim  →  adapter  →  ExecutionOutcome in memory
                           →  Governance Store execution_record summary  (executed@adapter, …)
```

The write-ahead claim correctly prevented a second invocation of an execution identity. What it
did not do was preserve what that invocation **did**:

- The outcome summary held a compact string. It had no amount, asset, `providerRef`, `routedBy`,
  observation instant or artifact digest. Replaying an executed result lost its `providerRef`.
- The summary could fail after the effect. When `recordOutcome` failed, the live caller learned
  `executed` with `outcomeRecorded: false`. After a restart, the claim with no decodable outcome
  replayed as `ALREADY_ATTEMPTED`, so a success the provider had confirmed could no longer be
  reconstructed.
- Nothing durable recorded the exact monetary context of an attempt before it crossed the
  provider boundary. A crash after the claim left an opaque execution id and no amount.

P8 (evidence only, asynchronous, allowed to lose events, never read) and P7 (reservation capacity;
its `settled` means "capacity stays consumed", not "funds settled") were each the wrong owner for
this.

## 2. Decision

> **Once an authorized execution reaches or may reach a provider, Frontera preserves exactly what
> it knows about that attempt, its monetary effect and the provider's certainty, in durable,
> immutable form that survives restart and can be replayed without invoking the provider again.**

A dedicated **execution outcome store** (`src/enterprise/execution-outcome-store/`) owns two
immutable facts per execution identity:

| record | written | holds |
| --- | --- | --- |
| **attempt** | before the write-ahead claim | tenant; evaluation, request, decision, grant and execution ids (references only); action; exact amount + asset (P9 canonical text); `preparedAt`; `attemptDigest` |
| **initial observation** | after the runtime returned the outcome | either `provider`: certainty, adapter attribution, optional `providerRef`, closed failure reason (non-completion only), `observedAt`. Or `withheld`: layer and that layer's own reason codes. Plus `attemptDigest` and `observationDigest` |

A machine payment remains a governed action. There is no payment kernel, payment outcome model or
rail-specific field. The durable outcome belongs to the existing governed execution.

### 2.1 Why a new store

| candidate | why not |
| --- | --- |
| Governance Store `execution_record` | Frozen schema `aoc.governance-store.schema.v1`; references are compact evidence; `externalVersion` is not a place for a canonical JSON document |
| P8 authority event stream | Evidence only, asynchronous, may lose events, never read by authority or replay |
| P7 exercise-control ledger | Owns capacity, not provider state |
| Bounded-grant store / Kernel Authority Store | Authority stores; an outcome is not authority |

Nothing else owns provider execution state, so a new, small, provider-neutral store is the
narrowest honest owner. The Governance `execution_record` rows stay as they are. The `attempt`
row is still the write-ahead claim and the only at-most-once guard. The outcome row becomes the
compact **summary** of the canonical observation (§5).

## 3. Provider certainty is one vocabulary, derived once

```text
ExecutionAdapterResult   ExecutionOutcome.status   ProviderEffectCertainty
completed             →  executed               →  confirmed-completed
failed                →  execution-failed       →  confirmed-not-completed
unconfirmed           →  execution-unconfirmed  →  unconfirmed
(no provider reached) →  withheld               →  — none: a withholding, not a certainty
```

`providerEffectCertaintyOf` / `executionStatusOfCertainty` (execution runtime) are the only
mappings. The store records the certainty and never a status next to it, so the two cannot
disagree. There is no fourth value, no confidence score and no inference.

**Certainty is not settlement.** `confirmed-completed` means the execution provider confirmed that
the effect it was asked to perform completed. It says nothing about irrevocable funds, bank
settlement, ledger finality, receipt verification or obligation discharge (P15).

**Certainty is not authorization.** No path that allows, denies, issues, reserves, admits or
routes reads this store. A past success is never permission for another action.

## 4. Initial observation, not the final word

The observation is the **initial** observation of this attempt, recorded once. If the response was
lost, the initial certainty is `unconfirmed`. If reconciliation later learns the provider
completed, P12 records a **new** resolution fact. It never rewrites this one, because the original
uncertainty genuinely existed. The same execution id with a different observation is
`EXECUTION_OUTCOME_CONFLICT`. It is never last-write-wins, never chosen by timestamp, and a
reference or attribution difference counts as a different fact.

## 5. Order, and why

```text
decision committed → grant issued → pre-assessment (usable)
  → P11 PREPARE attempt            idempotent; "prepared", never "attempted"
  → write-ahead claim              the at-most-once guard, unchanged
  → ACE exercise → adapter → P7 settle | release   (inside GrantExecutionService.finish)
  → P11 initial observation        observedAt from the injected clock, after the result was normalized
  → Governance outcome summary     only after the observation committed; digest = observationDigest
  → P8 execution.outcome.observed  enqueued, never awaited
  → response
```

- **Preparation before the claim.** If preparation came after the claim, a failed preparation would
  strand a request: the claim would exist and forbid a retry of an attempt that never reached a
  provider. Before the claim, a failed preparation stops the request with `system_error` /
  `GOVERNED_ACTION_EXECUTION_CLAIM_FAILED`, with no claim and no adapter call, and the request
  stays safe to retry. Preparation is idempotent: a retry finds its own attempt (with its first
  `preparedAt`) rather than a conflict. **Prepared does not mean attempted.** The claim remains
  the durable fact that an attempt became load-bearing.
- **Exactly what the adapter receives.** The attempt's amount is the exercise request's amount,
  which `GrantExecutionService` hands to the adapter verbatim as `ValidatedExecutionAction.amount`
  after containment proved it. It is P9 canonical text, P10 authority-contained, grant-contained
  and P7-reserved. It is never re-parsed from the original payload.
- **Observation after P7.** P7 finalization stays inside the execution runtime's exhaustive
  `finish()`. P11 does not move it, and a persistence failure cannot change a settle or release
  that already happened.
- **Summary after observation.** Governance evidence can never claim a terminal outcome that the
  canonical store does not hold.
- **P8 after both.** P8 mirrors the fact. It is never its only copy, and never read back.

## 6. Replay

```text
claim exists AND P11 attempt exists:
    observation exists      → replay it: executed(+providerRef) | execution_failed(failure) |
                              execution_unconfirmed / …_OUTCOME_UNCONFIRMED | withheld(layer)
    observation absent      → execution_unconfirmed / …_ALREADY_ATTEMPTED
    unreadable / corrupt    → execution_unconfirmed / …_ALREADY_ATTEMPTED   (never optimistic, no fallback)
claim exists AND no P11 attempt (pre-P11 history):
    legacy outcome summary decoded exactly as before P11; nothing is synthesized
claim absent:
    not a replay — the request proceeds (idempotent preparation, then the claim)
```

The two unknowns stay distinct. `…_OUTCOME_UNCONFIRMED` means the provider said "unknown", and that
answer is on record. `…_ALREADY_ATTEMPTED` means no answer is on record. P12 needs both. Replay
never calls the provider, never reads P8 and never consults process memory.

**Legacy.** A pre-P11 row such as `executed@adapter-a` replays as `executed` with no `providerRef`.
Historical absence stays absence: no `providerRef`, `observedAt` or routing is invented, and
nothing is migrated.

## 7. Crash windows — the unavoidable distributed gap

> No local store can atomically commit with an external provider effect. P11 therefore does not
> claim exactly-once execution or complete outcome capture across process death. It durably
> records the exact attempt context before the provider crossing and durably records the provider
> observation when one is obtained. A claim with no terminal observation remains unresolved and is
> owned by P12.

| window | durable state afterwards | replay |
| --- | --- | --- |
| crash after preparation, before the claim | attempt, no claim | safe retry: same attempt, claim, one execution |
| preparation fails | nothing new | `system_error` / `…_CLAIM_FAILED`; retry is safe |
| claim fails | attempt, no claim | `system_error` / `…_CLAIM_FAILED`; retry is safe |
| crash after the claim, before the adapter | attempt + claim | `…_ALREADY_ATTEMPTED`; never retried (a general runtime cannot prove the adapter was not reached) |
| crash during the adapter / after the effect, before the observation | attempt + claim (+ P7 reservation, possibly unfinalized) | `…_ALREADY_ATTEMPTED`; never retried |
| observation write fails | attempt + claim + P7 finalized | live: provider truth with `outcomeRecorded: false` + `…_OUTCOME_UNRECORDED`; replay `…_ALREADY_ATTEMPTED` |
| Governance summary write fails | attempt + claim + observation | live and replay both answer from the observation; `outcomeRecorded: true` |
| P8 fails, rejects or never settles | unchanged | unchanged |

The live process still knows what the adapter reported when the observation write fails, so the
immediate result keeps that truth: `executed` is never rewritten to `failed`, and nothing is
released or retried. After a restart the confirmation is gone, and it is never reconstructed from
memory that no longer exists. This gap is one of the reasons P12 exists.

## 8. `providerRef` is a handle, never proof

- It may now accompany **any** provider certainty, including `unconfirmed` (a `202 Accepted`
  carrying a job id) and `confirmed-not-completed` (a rejection carrying a request id). A reference
  never changes certainty.
- It is carried only when `isRecordableProviderRef` accepts it (execution runtime, provider-neutral):
  1 to 512 printable ASCII characters, trimmed, and shaped like no bearer or basic credential, JWT,
  PEM block, URL, cookie pair or authorization header. Anything else is omitted, never truncated or
  redacted, and the outcome is unchanged. Generic HTTP applies the same rule plus its
  credential-echo check.
- Generic HTTP keeps a safe configured reference on every **actual response** (completed, rejected,
  or an unconfirmed 202 / 3xx / 408 / 5xx), and never where no response exists (DNS, connect or TLS
  failure, a reset after send).
- On `failed` and `unconfirmed`, a malformed (non-string) reference is dropped rather than
  invalidating the result, so it can never turn an effect that may have happened into
  `ADAPTER_ERROR` (which would release capacity).
- The frozen v1 wire is unchanged: `providerRef` stays a field of `executed` only. `executed`
  replay now returns it for P11 executions. The failed and unconfirmed references are kept
  internally for P12.

`detail` (adapter diagnostic text) is never persisted.

## 9. Integrity, tenancy, immutability

- **Integrity.** `attemptDigest` and `observationDigest` are SHA-256 over `aoc.canonical-json.v1`
  (the Governance Store's primitive, reused), each domain-separated. The observation digest commits
  to the attempt digest, execution id, organization, kind, certainty, attribution, reference,
  failure or withholding, `observedAt`, `recordedAt` and schema version. Every read re-validates the
  closed contract and recomputes both digests. A failure is `EXECUTION_OUTCOME_CORRUPT`, never
  repaired, and replays as `…_ALREADY_ATTEMPTED`. **Integrity is not authenticity:** a writer who can
  rewrite a row and its digest consistently is not detected. There is no signature,
  non-repudiation or external anchor (P20).
- **Tenancy.** Every call carries exactly one organization scope with no `system` escape. A record
  of another organization is refused on read and write.
- **Immutability.** Append-only by port. SQLite triggers refuse `UPDATE` and `DELETE` on both
  tables. `execution_id` is the primary key of both, so there is one attempt and one observation.
  Every write decision is one `BEGIN IMMEDIATE` transaction (`WAL`, `synchronous = FULL`). The
  in-memory store holds the same contract and is **not durable**.
- **Plain data only.** The observation is built from the runtime's normalized `ExecutionOutcome`
  (adapter-controlled objects were already copied into plain values by
  `readExecutionAdapterResult`), copied again into a fresh plain object and frozen before
  persistence.

## 10. Exact money

The amount is stored as `TEXT` and bound as a JavaScript string, and validated as P9 canonical money
on write and on every read. `"9007199254740993.01"` and `"0.1"` survive a restart byte for byte.
`100 USD` and `100 xrpl:USD/rIssuer` are different assets. There is no `Number`, no `parseFloat`,
no rounding and no FX.

## 11. Composition, configuration, operations

- Composed **automatically** with `governedActionOrchestrator`. The orchestrator requires the port,
  and there is no mode in which governed executions run without it. It uses durable SQLite at
  `executionOutcome.sqlitePath` (`AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH`, default
  `.data/execution-outcomes.sqlite`) under `persistence.provider = 'sqlite'`, and the process-local
  store otherwise. A host may supply its own store (`executionOutcomes.store`), which is never closed
  by the Host.
- A store that cannot be opened **fails startup**. This differs from P8: preparation is
  load-bearing.
- Health: module `aoc.enterprise.execution-outcomes`, `criticality: 'optional'`. The frozen
  evaluate surface does not depend on it, and governed execution fails closed on its own.
- Read surface: `AocEnterprise.executionOutcomes` (read-only, tenant-scoped) for trusted in-process
  operator and audit code, and for P12.
- Backup: like the P7 ledger, grant store, emergency-control store and P8 stream, the file is **not**
  in portability v1 backup/restore. Durability qualification of the whole store set is P17.

## 12. Non-goals

No reconciliation, polling, status lookup or background job (P12). No retries of any kind. No
business or provider idempotency key (P13/P14). No receipts, settlement state machine, refunds or
finality (P15). No Stripe, MPP or XRPL code or field (P13, P14, P18). No KMS/HSM authenticity (P20).
No timers, TTLs or sweepers: a missing observation stays missing.

## 13. Handed to P12

*Resolved by P12* (`ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` §1): the first three
states are eligible for trusted reconciliation through the execution's durably bound resolution
authority; a record that fails verification is never reconciled. This store is unchanged by P12 —
a resolution is a separate fact in a separate store.

- A claim exists and no observation exists (the attempt context is readable).
- The observation's certainty is `unconfirmed`, with a `providerRef` available.
- The observation's certainty is `unconfirmed`, with no `providerRef`.
- A record that fails verification (corrupt or tampered) and replays as `…_ALREADY_ATTEMPTED`.
