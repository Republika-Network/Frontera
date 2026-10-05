# ANDREW-P0-09 — Linked Reconsideration / Complete Governed Flow

| | |
| --- | --- |
| Task | ANDREW-P0-09 — a withheld governed action, explicitly reconsidered after governance state changed, without bypassing idempotency |
| Branch | `feat/andrew-p0-09-linked-reconsideration` |
| Baseline | `8ba7b82577700da294ed227fcffb8219a1edb946` (`feat/andrew-demo`: P0-00 … P0-08 + `origin/main` `e3383b7`) |
| Status | **VERIFIED** — qualified offline (§6) and proven live on XRPL Testnet (§7): linked reconsideration executed one real 10 RLUSD payment, tx `7857B27CC2467B467C6EA5731AE919DBC43866A23C0B467C1AD03815FC76DCAC`, ledger 21304560, `tesSUCCESS`; merged into `feat/andrew-demo` with `--no-ff` |

## 1. The semantic

"Same action" means the **same business intent**, not the same technical
request. A reconsideration is a *fresh* governed request — its own
idempotency key, request id, Kernel evaluation and committed decision — that
**explicitly names** the original withheld request and **proves** it carries
the identical business intent. The original's committed denial is never
re-evaluated, rewritten, upgraded or written to.

```
original request ── denied ── committed, immutable
   │   exact replay of its key  → the same committed denial (Kernel never re-run)
   │   destination approval (P0-03)  → nothing executes
   ▼
reconsideration { of: <original requestId>, reason }   ← its own idempotency key
   ├─ verified BEFORE evaluation (nothing committed on refusal):
   │    original exists in this organization · integrity verifies · same actor ·
   │    original is a root (not itself a reconsideration) · original was denied/indeterminate ·
   │    identical business intent (who + the whole canonical action)
   ├─ committed request correlation := server-derived businessIntentId
   ├─ fresh Kernel / policy / authority / ceiling / destination evaluation
   ├─ reconsideration_link row on ITS OWN evaluation  (→ original requestId, decisionId, intent digest, reason)
   └─ allowed → realization marker (unique per original) → normal grant → normal exercise → XRPL
```

## 2. Phase 0 findings (before any change)

| concept | identifier | where |
| --- | --- | --- |
| request / action | `requestId = aoc.gar:H(org, principal, idempotencyKey)` | `governed-action/identifiers.ts` |
| idempotency | Governance Store scope `governed-action:[org, principal]` + key; payload-digest comparison | `decision-commit.ts` → `resolveIdempotency` |
| decision | `decisionId` / `evaluationId` in the committed, integrity-chained Governance record | `decision-commit.ts` |
| grant | `aoc.grant:…`, issued only from a `VerifiedDecision` | ACE issuance |
| execution | `executionId = aoc.exec:H(requestId, decisionId)` | `identifiers.ts` |
| outcome / resolution | P11 observation (`providerRef` = tx hash), P12 resolution, by `executionId` | outcome / resolution stores |
| ASSURE-01 trace | by `requestId`, rebuilt from canonical records | `evidence/trace-builder.ts` |
| destination approval | P0-03 history: organization, key, sequence, `approvedBy`, `authorityBasis` | approval store |
| business intent | **did not exist** — `correlationId` is caller-chosen and unverified | — |

**Why the original replays as a denial:** `decision-commit.ts` resolves
idempotency **before** the Kernel; a `(scope, key, payload)` match returns the
original committed record ("The original committed decision is the answer. The
Kernel is not re-run."), and the orchestrator answers from its persisted
status. P0-09 leaves this untouched.

**Smallest safe place:** an optional, closed intent field; the read of the
original in `decision-commit.ts` (the one place a committed record is
verified); the two evidence rows in `execution-ledger.ts` (the one place
evidence is written); one evidence-only reference type; one optional trace
sub-object. No Kernel, grant, approval-store, transport, receipt or outcome
change.

## 3. Implementation

| file | change |
| --- | --- |
| `governed-action/intent.ts` | optional closed `reconsideration: { of, reason }` — `of` a governed request id, `reason` ∈ `destination-approved` · `authority-changed` · `policy-changed` · `context-changed`; anything else refused as an invalid intent |
| `governed-action/reconsideration-lineage.ts` (new, pure) | reason vocabulary; `businessIntentDigest` (sorted-key canonical JSON of organization, actor and the whole canonical action, over the Store's own request projection — excludes request id, times, correlation, asserted context); `assessReconsiderationTarget` (self · not found / other organization · unverifiable · other actor · not original · not withheld · intent mismatch) |
| `governed-action/decision-commit.ts` | `readReconsiderationOriginal`: tenant-scoped read + integrity verification of the original, and the new request projected as the Store projects it |
| `governed-action/execution-ledger.ts` | `recordReconsiderationLink` (on the reconsideration's own evaluation) and `claimReconsiderationRealization` (marker id derived from the original request id — the Store's unique reference id refuses a second realization) |
| `governed-action/orchestrator.ts` | verify before commit; bind the committed correlation to the business-intent id; record the link after commit (any status); claim realization immediately before issuance; new withholding layer `reconsideration` |
| `governed-action/identifiers.ts` | `deriveBusinessIntentId = aoc.intent:H(org, originalRequestId)`; link and realization reference ids |
| `governed-action/contracts.ts` | the intent field; nine `GOVERNED_ACTION_RECONSIDERATION_*` reason codes; `withheldBy: 'reconsideration'` |
| `governance-store/contracts.ts` | evidence-only reference type `reconsideration_link` |
| `evidence/trace-contracts.ts`, `trace-builder.ts` | optional `request.lineage`, **rebuilt** from the link row and the original's own verified record, with `lineage.*` checks; only reconsiderations get it, so every other trace is byte-identical |

### Identifier semantics

| identifier | original | reconsideration |
| --- | --- | --- |
| idempotency key | its own | its own (different) |
| `requestId` | `H(org, principal, key₀)` | `H(org, principal, key₁)` |
| decision / evaluation | its own, immutable | fresh |
| business intent id | `aoc.intent:H(org, requestId₀)` (derivable) | the same, carried as the committed correlation |
| grant / execution | none, ever | fresh, only if the fresh decision allows |

### Why idempotency cannot be bypassed

- The original key replays the original record (unchanged code path).
- A reconsideration's committed request carries the server-derived
  business-intent correlation, so it is never byte-identical to a plain request:
  **reusing an original's key for a reconsideration is an idempotency conflict**
  (tested), never a replay — the original record can never gain a link row.
- Replaying a reconsideration's own key replays its own record (link row
  `existing`, realization `claimed` by itself, executed execution answered from
  the record).

### Why authority cannot be inherited or manufactured

The reconsideration's decision is a new Kernel evaluation under current state;
grants are issued only from it; the original's record never gains an
authorization or execution reference (trace check
`lineage.original-never-authorized`). The link and marker rows are evidence
(`reconsideration_link`), read by nothing that decides. Destination approval
is read only as a trusted fact by the fresh evaluation.

### One intent, at most one realization

The realization marker is claimed by the first reconsideration that reaches
issuance (after a fresh *allowed* decision and every pre-issuance gate). Any
other reconsideration of the same original is then withheld
(`GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED`) before a grant. A retry of
the realizing reconsideration's own key finds its own claim and continues
through the normal gates (so a reconsideration withheld by the ceiling stays
withheld on retry, and the original cannot be realized by another).

## 4. ASSURE-01 trace linkage

`GET /api/evidence/traces/{reconsiderationRequestId}` → `stages.request.lineage`:

```json
{ "role": "reconsideration", "businessIntentId": "aoc.intent:…", "intentDigest": "sha256:…",
  "reason": "destination-approved",
  "reconsiders": { "requestId": "aoc.gar:<original>", "evaluationId": "…", "decisionId": "…", "status": "denied", "reasonCodes": [ … ] },
  "realizedOriginal": true }
```

Verification adds `lineage.original-record` (integrity), `lineage.original-identity`,
`lineage.original-decision`, `lineage.original-was-withheld`, `lineage.original-is-root`,
`lineage.original-never-authorized`, `lineage.same-business-intent` (recomputed from
both committed payloads), `lineage.business-intent-id`, `lineage.reason`,
`lineage.realization-before-authority`. A **forged** link row appended through the
Store API onto an unrelated request is caught (`verified: false`;
`lineage.same-business-intent` and `lineage.business-intent-id` fail — tested).
The original's own trace is unchanged (no lineage), so its denial stays
historically exactly what it was.

## 5. Tests

| suite | tests | covers |
| --- | --- | --- |
| `andrew-p009-reconsideration-host.test.ts` | 16 | the complete story on the composed Host with the real P0-08 transport (scripted ledger); malformed linkage (6 shapes); missing / self / chained target; amount, destination and caller-correlation drift; allowed original not reconsiderable; original key reused → idempotency conflict; fresh ceiling on a reconsidered USD 125,000; forged link row fails trace verification |
| `andrew-p009-reconsideration-unit.test.ts` | 9 | intent digest exclusions and sensitivity (8 fields); closed reasons; accept/refuse matrix incl. other organization, other actor, unverifiable, not original, not withheld (2 statuses), intent mismatch |
| `andrew-p009-live-testnet.test.ts` | live | gated by its own flag `FRONTERA_ANDREW_P009_LIVE=1` |
| changed: `assure01-trace-structure.test.ts` | +1 | builder may import the pure lineage module; that module is pinned pure (imports, no store call, no clock) |
| changed: `trusted-destination-context-structure.test.ts` | — | intake key set gains `reconsideration`, whose own keys are pinned to `of` and `reason` |

The task's 17 required properties map to: 1 missing original; 2 link row / trace
`reconsiders`; 3 distinct `requestId`s and decisions; 4 shared business-intent id
and digest; 5 replay returns the original decision (×3); 6 approval → 0/0/0; 7
reconsideration before approval denied; 8 after approval executed; 9 the only grant
names the reconsideration; 10 no grant names the original, original has no link
rows, `lineage.original-never-authorized`; 11 one signature / submission across
replays and a second reconsideration; 12 trace lineage + verify; 13 & 14 other
organization / other actor (unit) and tenant-scoped reads; 15 malformed /
self / chained (cycle-impossible); 16 fresh ceiling; 17 no-bypass suite
unchanged and green.

## 6. Qualification

After a forced full rebuild (`tsc -b --force`) on this branch:

| check | result |
| --- | --- |
| build / typecheck / lint | pass / pass / pass |
| P0-09 suites | host **16 / 16**, unit **9 / 9** |
| transport package (P0-08, unchanged) | 39 / 39 |
| focused regression — 346 files: P0-01 … P0-09, CTRL-04, ASSURE-01, PROD-02, no-bypass, grant, execution, outcome, resolution, reconciliation, receipt, XRPL transport, governed-action, governance-store, destination-approval, approvals, evidence, operator, structural, security invariants, CORE-06 | **5,131 / 5,132** |
| the one failure | `structural-boundaries` R004.B — the inherited CRLF artefact of this Windows checkout (`destination-approval` passed in this run) |
| mutation campaign | **18 / 18 killed by tests**: self-reference allowed; other organization accepted; unverifiable original accepted; other actor accepted; chains allowed; allowed original reconsiderable; intent mismatch accepted; digest ignores the action; correlation not server-bound; caller correlation drift accepted; link never recorded; realization never claimed; duplicate realization treated as own; trace trusts the link digest; trace trusts the correlation; trace omits lineage; extra keys in `reconsideration`; any string is a reason (three were first compile-killed and re-expressed to compile, then killed by tests) |
| structural pins changed, with intent kept | ASSURE-01 builder imports (+ the pure lineage module, pinned pure); P0-04 intake key set (+ `reconsideration`, pinned to `of`/`reason`). The governed-action composition rules — only `decision-commit.ts` verifies, only `execution-ledger.ts` appends evidence — hold **unchanged**: the implementation was restructured to respect them |
| `git diff --check`, conflict markers, secret scan | clean (see commit) |

## 7. Live Testnet (Phase 5) — VERIFIED (2026-10-05)

### 7.1 Fixture reset (setup provenance — NOT governed evidence)

P0-08's live payment had left the 10 RLUSD with the demo recipient. Before the
P0-09 run, at the project owner's instruction, a one-time **external test-fixture
reset** returned them to the treasury: a plain XRPL Testnet Payment signed with
the recipient's own Testnet key by a standalone setup script (no product code,
not routed through Frontera), after verifying `network_id` 1, both accounts, the
RLUSD issuer and both trust lines. Reset tx
`65D5629D34F9F51DD99DF3942600A3430BED34A2441E775E73B6E829BB3C21D6`, validated
ledger 21304536, `tesSUCCESS`, delivered exactly 10 RLUSD; afterwards treasury 10,
recipient 0. It is recorded only so the fixture's history is complete; it is not
part of the governed story below.

### 7.2 Preflight

`network_id` 1; validated ledger 21304543 (21304557 at run start); treasury
`rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` **10 RLUSD**; recipient
`rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` trust line present; `ready: true`. Fresh
attempt store `xrpl-attempts-p009-live-1.sqlite`; flag `FRONTERA_ANDREW_P009_LIVE=1`;
amount USD 10 → RLUSD 10 (unchanged).

### 7.3 The governed story — every assertion passed (`1 / 1`)

| step | result | grants / signatures / submissions |
| --- | --- | --- |
| original USD 10 (`andrew-p009-live-original`) while `never-approved` | **denied** — `aoc.gar:a26214e0b8e7c3df6604cee824a2820b`, decision `enforcement-decision-d8038572-da37-4fef-8e9e-5864e2fa3d4c` (`DOMAIN_POLICY_DENIED`, `POLICY_ACTION_PROHIBITED`); recipient RLUSD trust line present (ledger fact, not approval) | 0 / 0 / 0 |
| exact replay of the original key | **the same decision** `enforcement-decision-d8038572-…`, same evaluation `gov-evaluation-muvkj401-2-0sw560uq` | 0 / 0 / 0 |
| destination approval (P0-03) | `approved` by `operator:andrew-admin`, basis `operator-permission:destination.approve;role:organization-administrator;credential:operator`, org `org-core04`, sequence 1, 2026-10-05T18:13:35.674Z — **executed nothing** | 0 / 0 / 0 |
| linked reconsideration (`andrew-p009-live-reconsideration`, `of` = the original, reason `destination-approved`) | **executed** — new request `aoc.gar:f085dcb612e7b4bc98a97e95ee6a20dc`, business intent `aoc.intent:f99865e849dfa75f54e5998584e41388`, **fresh** decision `enforcement-decision-ec787a4e-2ba7-4c46-b0b1-465f85b81f7a` (`allowed`, `ACTION_ALLOWED`), execution `aoc.exec:eb43335f0e029116fef3dc50b425f116` | **1 / 1 / 1** |
| transport attempt (persisted before submit) | sequence 21285933, fee 12 drops, `LastLedgerSequence` 21304562 (= validated 21304558 + 4); `signed` → `submitted` (preliminary `tesSUCCESS`) → `validated-success` | — |
| second reconsideration (`…-2`) | **withheld** `reconsideration` / `GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED` — request `aoc.gar:910a2fb3ba531a8e0568cbdff76667f2` | 1 / 1 / 1 (unchanged) |
| final replay of the original | **still the historical denial**, decision `enforcement-decision-d8038572-…` | 1 / 1 / 1 (unchanged) |

### 7.4 The XRPL payment

| | |
| --- | --- |
| **transaction hash** | **`7857B27CC2467B467C6EA5731AE919DBC43866A23C0B467C1AD03815FC76DCAC`** |
| **validated ledger index** | **21304560** (closed 2026-10-05T18:13:40Z, inside the grant horizon) |
| **engine result** | **`tesSUCCESS`** |
| **delivered amount** | **`{"currency":"524C555344000000000000000000000000000000","issuer":"rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV","value":"10"}`** — exactly the authorized amount, in the transport record and by an independent ledger re-read |
| from → to | treasury `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` → recipient `rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` |
| Frontera outcome | `executed`, `providerRef` = the hash |

### 7.5 ASSURE-01 lineage (verified)

The reconsideration's trace (HTTP 200, carries the hash) has
`stages.request.lineage`:
`role: reconsideration`, `businessIntentId: aoc.intent:f99865e849dfa75f54e5998584e41388`,
`intentDigest: sha256:312b2933de2c50fb76181a0eda831bce5005f67de91c08a48a631805d33336ff`,
`reason: destination-approved`, `reconsiders: { requestId: aoc.gar:a26214e0b8e7c3df6604cee824a2820b,
evaluationId: gov-evaluation-muvkj401-2-0sw560uq, decisionId: enforcement-decision-d8038572-…, status: denied }`,
`realizedOriginal: true`. `/verify` → **`verified: true`**, all ten `lineage.*` checks
`pass` (original-record, original-identity, original-decision,
original-was-withheld, original-is-root, original-never-authorized,
same-business-intent, business-intent-id, reason, realization-before-authority).
The original's own trace carries **no** lineage — its denial is exactly what it was.

### 7.6 The continuous story

```
aoc.intent:f99865e8…  (one business intent)
  aoc.gar:a26214e0…  original      → denied (d8038572)  ── replayed twice: same denial
  destination approval (sequence 1, organization-administrator)  → no payment
  aoc.gar:f085dcb6…  reconsideration → linked → fresh decision ec787a4e (allowed)
     → grant → aoc.exec:eb43335f… → XRPL 7857B27CC2467B46… (ledger 21304560, tesSUCCESS, 10 RLUSD)
     → ASSURE-01 lineage verified
  aoc.gar:910a2fb3…  second reconsideration → withheld: ALREADY_REALIZED
```

Non-secret evidence JSON: `~/.config/frontera-andrew/p009-evidence.json`;
attempt store: `~/.config/frontera-andrew/xrpl-attempts-p009-live-1.sqlite`
(outside the repository; holds the replay-sensitive signed blob, never a seed).
