# Governed Action Orchestrator

**Status: internal orchestration capability, with one capability-gated customer route (`POST /api/governed-actions`, P5).**

> This actor requested this action, the Kernel decided it, that decision was
> durably recorded, and only then could bounded authority be issued and
> exercised.

The Governed Action Orchestrator (`src/enterprise/governed-action/`) is the
first canonical internal path from a trusted customer identity to an external
effect. It connects the customer identity foundation
([`AOC_CUSTOMER_PRINCIPAL_BINDING.md`](AOC_CUSTOMER_PRINCIPAL_BINDING.md)) to
Authority-Controlled Execution
([`AOC_AUTHORITY_CONTROLLED_EXECUTION.md`](AOC_AUTHORITY_CONTROLLED_EXECUTION.md)),
and adds exactly one thing neither had: **order**. The decision is committed to
the Governance Store before any bounded grant for it can exist, and an execution
identity is durably claimed before any adapter runs.

It is composed in-process. Since P5 it has exactly one customer route,
`POST /api/governed-actions`, mounted only when customer identity admission is
composed too (which the orchestrator already requires). That route exposes the
**top** of this path and nothing below it:

```
HTTP -> customer identity admission -> BoundCustomerIdentity -> govern(identity, rawIntent)
```

The admission step lives outside this module
(`src/enterprise/orchestration/govern-governed-action-request.ts`), so the
orchestrator still authenticates nothing. The request body is the
`GovernedActionIntent` this document describes, validated by the same closed
validator; the response body is the `GovernedActionResult`, with one transport
mapping (`src/enterprise/api/governed-action-contract.ts`). Grants, grant
exercise, adapter selection and emergency-control administration remain
unreachable from a caller. `POST /api/governance/evaluate` behaves exactly as
it did. See `docs/enterprise/API_STABILITY_V1.md`.

## Emergency control and server-side adapter routing

Two capabilities were added around this orchestrator after it shipped. Neither
changes what authorizes an action.

**Emergency control** is an optional operational interlock. When composed, the
orchestrator consults it at **admission** — after the decision is committed and
after historical execution replay, and before grant terms, authority binding and
issuance — and reports `withheld` / `emergency-control` when it is active or
unreadable. Three further checkpoints sit below: the bounded-grant commit guard,
the exercise gate after the authoritative grant re-read, and the selected child
adapter.

The ordering is deliberate on both sides. **After replay**, because an
administrative stop declared today must not rewrite what an action did
yesterday: an execution identity already on the record is answered from the
record, and no new grant is minted to tell a caller what already happened.
**Before grant terms**, because the next thing that happens is the minting of new
bounded authority, and an action nobody has attempted must not acquire authority
while execution is stopped.

`GovernedActionWithheldBy` gains `'emergency-control'`, and the ledger records
which layer withheld an effect (`withheld:<layer>:<CODE>…`) so a replay reports
the layer that actually did. See
[`AOC_EMERGENCY_CONTROL.md`](AOC_EMERGENCY_CONTROL.md).

**Server-side adapter routing** lets a deployment register several provider
adapters and route between them. The execution ledger records **which child
adapter performed the effect** (`executed@<adapterId>`,
`execution-failed:<REASON>@<adapterId>`), so two otherwise-identical governed
actions that reached different providers are distinguishable in the durable
record and on replay. That identity comes from trusted routing alone; it is
evidence, and it is deliberately **not** on `GovernedActionResult` — which
provider ran is answerable from the Governance Record, not handed to the caller.

`GovernedActionIntent` is unchanged and remains
closed: it still cannot name an adapter, provider, URL, host, endpoint or
credential, and an intent carrying one is rejected rather than sanitized. See
[`AOC_EXECUTION_ADAPTER_REGISTRY.md`](AOC_EXECUTION_ADAPTER_REGISTRY.md).

## Aggregate / velocity exercise controls (P7)

When a deployment composes `authorityControlledExecution.exerciseControls`,
ACE's exercise — the step after this orchestrator's write-ahead claim — also
requires exact-equality revalidation of the grant's authority binding, a valid
trusted policy snapshot and an atomic, durable reservation across every
applicable aggregate count, amount and rolling-velocity limit, re-reads and
re-assesses the grant, revalidates the binding and re-reads the emergency
control after the reservation, and settles
or releases the reservation from the outcome. See
[`AOC_EXERCISE_CONTROLS.md`](AOC_EXERCISE_CONTROLS.md).

What changes here, and what does not:

- **The public contract is unchanged.** Internally a refusal is
  `withheld / exercise-control`; publicly it is the existing
  `withheldBy: 'exercise'`, with `EXERCISE_CONTROL_*` reason codes and the
  existing withheld HTTP status. No new status, no new `withheldBy` value, no
  new request field, no SDK change, no route.
- **No quota leaks.** A result carries no reservation, limit, bucket, remaining
  capacity, policy digest or binding digest.
- **The evidence ledger gains one layer**, `withheld:exercise-control:<CODE>…`,
  validated against the exercise-control vocabulary and replayed as
  `withheld / exercise`. Historical rows read exactly as before. This is
  evidence of *why* nothing ran; the consumption state itself is the separate
  exercise-control ledger, which this orchestrator never holds and never
  reconstructs from evidence.
- **Replay precedes everything, as before.** An execution identity already on
  the record is answered from the record: no reservation, no provider call.
- **The write-ahead claim is unchanged.** P7's reservation is keyed to the same
  execution identity and is a second, independent guard; neither replaces the
  other.
- **The caller still cannot name anything.** `limit`, `limits`, `limitId`,
  `scopeKey`, `quota`, `budget`, `velocity`, `window`, `windowSeconds`,
  `maximum`, `maxCount`, `maxAmount`, `reservation`, `reservationId`,
  `exerciseControls`, `aggregateControls` and `authorityBindingDigest` are
  undeclared intent fields, and reserved `assertedContext` keys.


## Canonical lifecycle

```
BoundCustomerIdentity + GovernedActionIntent
  1  validate the identity (customer plane, served organization)
  2  validate the intent — closed; undeclared properties are rejected
  3  derive requestId      = H(org, principal, idempotencyKey)
  4  build the KernelEvaluationRequest — actor and organization from the identity only
  5  resolve idempotency   — Governance Store, BEFORE the Kernel
  6  Kernel.evaluate()     — the only decision producer (ACE issuance core)
  7  appendEvaluation()    — COMMIT the decision, whatever its status
  8  re-read + verify()    — the committed record, digest-checked, bound to this request
  9  status gate           — denied / indeterminate / approval_required stop here
 10  derive executionId    = H(requestId, decisionId)
     replay                — an attempt/outcome already on the committed record is
                             answered from it, BEFORE any mutable gate below
     grant terms           — trusted host policy; no expiry → withheld
 11  authority binding     — resolved at issuance, re-resolved inside the commit
 12  issue bounded grant   — from the PERSISTED decision (ACE issuance core)
     authorization_artifact reference (evidence)
 13  ACE assessExercise    — pure read
     execution_record "attempt" reference — WRITE-AHEAD, at most once per executionId
     ACE exercise          — re-reads the grant; adapter gets a ValidatedExecutionAction
 14  execution_record outcome reference; customer-safe result
```

## The persist-before-grant invariant

**GOV-ACT-01 — no bounded grant is issued for a governed action unless the
Kernel decision that authorized it has already been durably committed to the
Governance Store.**

`AuthorityControlledExecutionService.authorize()` evaluates and issues in one
call, so it cannot host a commit between the two. Rather than duplicate its
logic, its body was moved unchanged into an internal module,
`src/enterprise/execution-governance/issuance-core.ts`:

```
authorize()          = core.evaluate()  ->                         core.issueFromDecision()
governed action      = core.evaluate()  ->  appendEvaluation()  ->  core.issueFromDecision()
                                            re-read + verify
```

`authorize()`, `assessExercise()`, `exercise()` and `revokeGrant()` keep their
signatures and behaviour, and the existing ACE suites pass unmodified.
`issueFromDecision()` accepts a decision it did not produce, and a caller able
to supply one could supply `status: 'allowed'`. So the core is **not** exported
from `execution-governance/index.ts` or from any public entrypoint. Only the
composition root, the ACE service and the governed-action module
(`orchestrator.ts`, plus `decision-commit.ts` for its type) import it, and a
structural test pins that list.

### Module layout

The orchestrator is split along its trust boundaries and lifecycle phases:

| Module | Owns |
| --- | --- |
| `kernel-request.ts` | Identity → Kernel request. Reads the four identity fields and builds the request. |
| `decision-commit.ts` | Idempotency → Kernel → `appendEvaluation` → re-read/`verify` → reconstruct → bind. It is the **only** producer of a `VerifiedDecision`, and that type has no transient-decision field. |
| `execution-ledger.ts` | Every Governance reference write: the authorization artifact, the write-ahead claim and the outcome. |
| `orchestrator.ts` | The order between phases: status gate, grant terms, `issueFromDecision(persisted)`, exercise, and result mapping. |

A structural test pins the call sites. Only `decision-commit.ts` calls
`evaluate`, `appendEvaluation` and `verify`. Only `orchestrator.ts` calls
`issueFromDecision`, and it passes `decision: persisted`. Only
`execution-ledger.ts` calls `appendReference`.

### The synchronous commit guard

Grant issuance commits under a synchronous `commitGuard`, and Governance Store
reads are asynchronous. The orchestrator does not put I/O inside the guard:

1. The Kernel evaluates.
2. The Governance Record commits.
3. The committed record is re-read (`getByEvaluationId`) and verified
   (`verify`) asynchronously, and its `aggregateDigest` must equal the one the
   append returned.
4. The grant source is projected from that record and deep-frozen.
5. Issuance begins.
6. The synchronous `revalidateSource` closes over the frozen snapshot. It
   refuses a foreign correlation. Without a host-configured ACE
   `revalidateSource` it answers the frozen snapshot; with one it answers the
   host's *current* source unchanged, so the grant-store commit guard
   re-proves eligibility, subject, scope and validity against the
   authorization as it stands now. The grant's identity and `sourceDigest` are
   still derived from the committed record. A current source that is
   `undefined`, ineligible or narrower than the grant refuses the issuance.
7. ACE's synchronous authority-binding re-resolution still runs inside the
   commit boundary. A binding that changes at all between issuance and commit
   refuses.

This is sound because the Governance Store is append-only by construction. The
`GovernanceStore` interface has no update or delete method. The in-memory
provider deep-freezes committed aggregates, and the SQLite provider issues no
`UPDATE` against evaluation rows; its only `UPDATE` is the reference-chain head
upsert. Every aggregate is digest-sealed and chained. A committed decision
therefore cannot be silently changed in place through any API. As with the
whole Governance Store, this does not defend against a privileged writer who
edits the database file directly (see "Integrity model and its limits" in
`AOC_ENTERPRISE_GOVERNANCE_STORE.md`).

## GOV-ACT-05: the grant source is the persisted decision

The decision issued from is `toKernelEvaluationResult(record)`: the Store's
canonical reconstruction, never hand-built from JSON. Before issuance the
orchestrator requires all of the following, and otherwise fails closed with
`GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH`:

- The record's request id, organization and actor match the bound request.
- The record's `payloadDigest` equals the canonical digest of the request being
  issued for.
- The reconstructed decision id and status equal the record's own.
- When this call ran the Kernel, the transient and persisted decisions project
  to the **same** grant source, byte for byte (`grantSourceDigest`).

The transient result never wins. When the two disagree, neither is issued from.
On a replay no transient decision exists, and the persisted one is the only
candidate. The persisted result must also carry a `grants` block, which only the
grant-aware Kernel produces, so a record committed by the legacy evaluate
Kernel can never be issued from.

`grant.sourceDigest` is asserted to equal the digest of the source projected
from the persisted record: **GRANT ⊆ PERSISTED AUTHORIZATION**.

## Trust inputs and ownership

| Concern | Owner | Notes |
| --- | --- | --- |
| Who is calling | Prompt 2 admission | The orchestrator never authenticates. It imports no credential matcher, parses no header and reads no API key. |
| Actor, organization | `BoundCustomerIdentity` | GOV-ACT-03. Only `principal.plane`, `principal.principalId`, `principal.organizationId` and `actor.actorId` are read. The organization must be the one this instance serves. |
| Trust domain | Host (`trustDomainId`) | Composition configuration, never caller input. |
| Decision | `AocKernel` | The only decision producer. Statuses and reason codes are restated verbatim from the committed record. |
| Decision record | Governance Store v1 | The canonical aggregate. No new schema, store or file. |
| Grant terms (expiry, narrowing) | Host (`grantPolicy`) | **Required**, no default. `undefined` withholds (`grant-terms`). |
| Authority binding | Host (`resolveAuthorityBinding`, via ACE) | Unchanged. Unresolved or malformed withholds; a change at commit refuses. |
| Grant | ACE issuance core | Issued from the persisted decision. Never returned to the consumer. |
| Exercise | ACE `assessExercise`/`exercise` | Unchanged: re-reads the authoritative grant; revocation and expiry are checked at that instant. |
| Adapter input | `ValidatedExecutionAction` | Built by ACE. The orchestrator never calls an adapter. |
| Store authority | Tenant scope | Every Store call runs as `{ system: false, organizationId, actorId }`. The customer is never turned into `system: true`, and the layer contains no `system: true` literal (structural test). |

## Governed Action Intent

```ts
interface GovernedActionIntent {
  action: string;                 // → action.type, grant action bound
  resource: string;               // → action.resourceScope, grant resources bound
  counterparty?: string;          // → action.counterpartyId, grant counterparty bound
  amount?: { value; currency };   // → action.amount/currency, grant amount ceiling
  assertedContext?: object;       // → request.context (verified by the Kernel, never reaches an adapter)
  correlationId?: string;
  idempotencyKey: string;         // required; scoped to (organization, principal)
}
```

Validation is **closed**. An intent carrying any undeclared property is
rejected with `GOVERNED_ACTION_INTENT_INVALID` before the Kernel runs, and
nothing is recorded. Examples of such properties are `actorId`,
`organizationId`, `system`, `externalSubject`, `principalId`, `grantId`,
`grantExpiresAt`, `authorityBinding`, `executionId`, `requestId`, `adapterId`,
`url` and `payload`. The asserted context may not carry identity or authority
keys at its top level, and it is bounded in keys and depth.

Every other JSON key is data, `__proto__` included. The validated copy, the
Governance Store's redacted projection and the Kernel's request snapshot all
*define* each key rather than assigning it, so an own `__proto__` key reaches
the Kernel, is covered by the payload digest, and never replaces a prototype.
Two contexts that differ only in that key are different payloads.

Every intent axis maps onto an existing `GrantScope`/`ValidatedExecutionAction`
axis. There is no payload, provider body or metadata channel to an adapter.
The conceptual `workflow` field is **deliberately omitted**. No canonical
Kernel field carries it, and using it to select grant terms would make an
unpersisted caller value an input to trusted policy. It needs a design
decision before it exists.

## Idempotency

- `requestId = "aoc.gar:" + H(org, principalId, idempotencyKey)`: one logical
  request, one stable id. The caller never supplies a request id.
- Every append carries the Governance Store idempotency context
  `{ idempotencyKey, scope: governed-action:[org, principal] }`, a namespace
  disjoint from the evaluate route's `org:` / `global` scopes.
- Idempotency is resolved **before** the Kernel, through
  `GovernanceStore.resolveIdempotency`. A retry rebuilds the request with the
  original `requestedAt` read from the existing record, so equivalence is the
  Store's own payload-digest comparison:
  - An equivalent retry replays the committed decision. The Kernel is not re-run.
  - A different payload under the same key is rejected with
    `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`. This includes the same principal
    presenting a different actor, so a retry cannot change the stored actor.
  - A different principal or a different organization produces a different
    request id, so they never collide. Tenant-scoped reads make one tenant's
    record invisible to another.
- A concurrent racer that loses `appendEvaluation`'s transactional uniqueness
  re-resolves once. It adopts the committed decision and discards its own
  transient one. The append transaction's conflict protection is untouched.
- With a grant policy anchored to the committed decision's `evaluatedAt` (the
  recommended shape), a retry that reaches issuance re-derives the **same**
  grant (`already-issued`), never a wider or later one.
- A retry whose execution id is already on the committed record never reaches
  issuance. It is answered from the record before grant terms, the authority
  binding, source revalidation or issuance run, because those describe what
  may happen *now* and must not rewrite what already happened.

## Execution correlation and the write-ahead record

`executionId = "aoc.exec:" + H(requestId, decisionId)` is server-derived and
stable across retries. It deliberately excludes the grant id, whose value
depends on expiry.

Governance references are the evidence trail:

| Reference | `referenceType` | `externalId` | `externalVersion` |
| --- | --- | --- | --- |
| The issued grant | `authorization_artifact` | grant id | — (the grant digest goes in `digest`) |
| Write-ahead claim | `execution_record` | execution id | `attempt` |
| Outcome | `execution_record` | execution id | `executed` \| `withheld:<layer>:<CODE>,…` \| `execution-failed:<reason>` \| `execution-unconfirmed` (P6), each effect-bearing form suffixed `@<adapterId>` when recordable |

Reference ids are deterministic, and the Governance Store refuses a second
append of the same reference id. So the `attempt` row is a durable
**at-most-once** marker for an execution id, written before the adapter. If
that write fails, the adapter is not invoked.

A withheld outcome records the exercise assessment's reason codes in their
assessed order: at least one, each from the closed
`GRANT_EXERCISE_REASON_CODES` vocabulary, none repeated. A replay reports
exactly those codes. A row that does not decode exactly is never reported as
a withheld refusal; the attempt replays as `execution_unconfirmed`.

**GOV-ACT-09: evidence is not authority.** A reference row can only *prevent* a
repeat invocation. Its presence never permits one: the exercise gate reads the
authoritative bounded-grant store and nothing else. A forged
`authorization_artifact` reference is asserted to be unexercisable.

### What level was achieved, precisely

- **Durable at-most-once adapter invocation per execution id.** This holds on
  both Governance Store providers, and across processes with the SQLite
  provider. A retry that finds the outcome on record replays it (`replayed:
  true`) without invoking the adapter. Two concurrent calls invoke the adapter
  at most once.
- **Not exactly-once.** A crash after the `attempt` row and before the adapter
  call leaves an execution that never ran, and a crash after the adapter call
  and before the outcome row leaves one whose effect is unknown. Both are
  reported as `execution_unconfirmed` (`GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED`)
  and are **never retried automatically**. They need reconciliation, which is
  later work. The providerRef of a replayed execution is not recorded, so it is
  not returned on replay.
- **P6: an adapter-reported unconfirmed effect is recorded, not lost.** When the
  adapter itself reports `unconfirmed` (the provider was contacted and the
  result is unknown), the outcome row is the canonical
  `execution-unconfirmed@<adapterId>` and the result is `execution_unconfirmed`
  with `GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED`. A replay answers from
  that row without invoking the adapter. It stays distinguishable from the
  crash case above (`…_ALREADY_ATTEMPTED`, no outcome row), although a caller
  sees the same status for both. A malformed or tampered variant decodes as
  nothing and replays as `…_ALREADY_ATTEMPTED` — never as executed or failed.
  An operator may map `correlation.executionId` into a provider idempotency
  header; exactly-once remains out of reach.

## Result contract

`GovernedActionResult.status` is one of the following:

| Status | Meaning |
| --- | --- |
| `executed` | The adapter reported completion. Carries `providerRef` (when the adapter returned one), `replayed` and `outcomeRecorded`. |
| `denied` | Kernel `denied`. Carries the Kernel reason codes. |
| `indeterminate` | Kernel `indeterminate`. |
| `withheld` | `withheldBy`: `approval` (Kernel `approval_required`), `obligations`, `grant`, `authority-binding`, `grant-terms`, `exercise`. Each case uses the codes of the layer that owns it. |
| `execution_failed` | The adapter failed (`PROVIDER_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RESPONSE_INVALID`, `ADAPTER_ERROR`). The decision and authorization history are intact. |
| `execution_unconfirmed` | The outcome of an attempt is not known, and the adapter is not invoked again: either an earlier attempt of this execution id is on record without an outcome (`GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED`), or the adapter reported the provider contacted with its result lost (`GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED`, P6). |
| `rejected` | Intent or identity invalid, or an idempotency conflict. |
| `system_error` | Infrastructure failure before any effect: persistence, re-read or verify, mismatch, issuance or evidence failure. |

Correlation fields are `requestId`, `correlationId`, `decision { decisionId,
evaluationId, status, reasonCodes }` and `executionId`. **GOV-ACT-06:** a
result never carries a bounded grant, grant id, scope, digest, expiry,
authority binding, credential, store handle, adapter or system context, and it
is deep-frozen. Adapter failure detail is not echoed.

The orchestrator's own vocabulary is `GOVERNED_ACTION_*`. It is used only where
orchestration is the owner, and it is asserted disjoint from the Kernel,
`CUSTOMER_*`, grant issuance, grant exercise and authority-binding codes.

## Failure matrix

| Failure | Result | Grant | Adapter |
| --- | --- | --- | --- |
| Idempotency probe fails | `system_error` | no | no |
| Kernel throws | `system_error` (nothing persisted) | no | no |
| `appendEvaluation` fails | `system_error` + `GovernanceRecordCommitFailed` event | no | no |
| Record cannot be re-read or does not verify | `system_error` | no | no |
| Persisted and transient disagree | `system_error` | no | no |
| Grant store throws | `system_error` | no | no |
| Authorization reference append fails | `system_error` | issued | no |
| Execution claim append fails | `system_error` | issued | no |
| Grant revoked or expired before exercise | `withheld` / `exercise` | issued | no |
| Adapter fails or throws | `execution_failed` | issued | once |
| Adapter reports `unconfirmed` (P6) | `execution_unconfirmed` / `…_OUTCOME_UNCONFIRMED`, recorded | issued | once |
| Outcome reference append fails | outcome reported, `outcomeRecorded: false` | issued | once |

## Composition

```ts
createEnterprise({
  customerIdentityAdmission: { enabled: true },
  authorityControlledExecution: { grantCapability, executionAdapter, resolveAuthorityBinding },
  governedActionOrchestrator: { enabled: true, trustDomainId, grantPolicy },
});
// enterprise.governedActionOrchestrator.govern(boundIdentity, intent)
```

Composition fails with `GovernedActionConfigurationError`, and there is no
weaker mode, in these cases:

- `GOVERNED_ACTION_CUSTOMER_IDENTITY_REQUIRED`: customer identity admission is
  not enabled.
- `GOVERNED_ACTION_EXECUTION_REQUIRED`: `authorityControlledExecution` is absent.
- `GOVERNED_ACTION_KERNEL_NOT_PROVABLY_GRANT_AWARE`: the ACE Kernel is
  host-supplied. The root-built Kernel is grant-aware under the declared
  capability by construction.
- `GOVERNED_ACTION_GOVERNANCE_STORE_UNAVAILABLE`: the store cannot append,
  resolve, re-read, verify and reference.
- `GOVERNED_ACTION_CONFIGURATION_INVALID`: the trust domain is not canonical, or
  no `grantPolicy` function was supplied.

The orchestrator is registered as the optional module
`aoc.enterprise.governed-action-orchestrator` only when it is requested. The
public entrypoint exports its types only, so the checksummed
`dist/src/enterprise/index.js` gains no runtime export.

## Local invariants

| Id | Invariant | Where proved |
| --- | --- | --- |
| GOV-ACT-01 | Every canonical governed-action decision is committed before grant issuance. | call-order test: `index(appendEvaluation) < index(issue)` |
| GOV-ACT-02 | A persistence failure results in no grant and no external effect. | failure-matrix tests |
| GOV-ACT-03 | Actor and organization come only from `BoundCustomerIdentity`. | Kernel-request binding and decoration tests |
| GOV-ACT-04 | Caller intent cannot mint, select or mutate authority. | closed-intent injection tests, grant-terms tests |
| GOV-ACT-05 | The grant source is derived from the canonical persisted decision. | `sourceDigest` and tamper-mismatch tests |
| GOV-ACT-06 | A governed action exposes no raw bounded grant to its consumer. | result-shape test |
| GOV-ACT-07 | Every executed action passes the existing exercise gate. | revoked, expired and amount tests |
| GOV-ACT-08 | The adapter receives only `ValidatedExecutionAction`. | adapter-input test; structural "never calls an adapter" |
| GOV-ACT-09 | Governance references are evidence and correlation only. | forged-reference test |
| GOV-ACT-10 | Legacy `POST /api/governance/evaluate` is unchanged. | side-by-side parity test |
| GOV-ACT-11 | *(Narrowed by P5.)* Exactly one HTTP route reaches the orchestrator — `POST /api/governed-actions` — only when customer identity admission and the orchestrator are both composed, and only through admission → `govern()`. No route reaches anything below `govern()`. | `governed-action-composition.test.ts` (adapter, sequence and API-surface scans); `governed-action-api-endpoint.test.ts` |
| GOV-ACT-12 | Execution identity is server-derived. | derivation test |

These are local to this capability and are not promoted to global `SEC-INV`
entries.

## What remains (Prompt 4+)

- An adapter registry and the durable kill-switch reader. Today the
  orchestrator uses ACE's single composed adapter.
- ~~The customer HTTP route and its error mapping.~~ Done in P5
  (`POST /api/governed-actions`).
- Exactly-once external execution and reconciliation of `execution_unconfirmed`.
  P6 delivered the adapter-level "indeterminate" variant (`unconfirmed`,
  recorded as `execution-unconfirmed@<adapterId>`) and lets an operator map
  `correlation.executionId` into a provider idempotency header; neither is
  exactly-once, and nothing reconciles an unconfirmed effect yet.
- Recording `providerRef` for replay.
- Host-supplied execution Kernels, which need a provable grant-awareness check.
- The `workflow` intent axis, which needs a design decision first.
- **Known residual: request-id squatting is a denial of service only.** The
  legacy evaluate route accepts a caller-chosen `requestId`, so a caller with
  an evaluate credential for the same organization could pre-commit a record
  under a governed-action request id. With a different payload, the governed
  action is rejected as an idempotency conflict. With an identical payload, the
  record carries no `grants` block, which only the grant-aware Kernel produces,
  so issuance fails closed. No authority can be obtained either way. Closing
  the DoS needs either a keyed request-id derivation or a reserved `aoc.gar:`
  namespace on the evaluate route, and the evaluate route is frozen.
- Aggregate controls.
