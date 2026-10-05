# ANDREW-P0-09 — Linked Reconsideration / Complete Governed Flow

| | |
| --- | --- |
| Task | ANDREW-P0-09 — a withheld governed action, explicitly reconsidered after governance state changed, without bypassing idempotency |
| Branch | `feat/andrew-p0-09-linked-reconsideration` |
| Baseline | `8ba7b82577700da294ed227fcffb8219a1edb946` (`feat/andrew-demo`: P0-00 … P0-08 + `origin/main` `e3383b7`) |
| Status | Implemented and qualified offline (§6). **Live Testnet step BLOCKED on funding only** (§7): committed on its branch, **not** merged into `feat/andrew-demo` |

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

## 7. Live Testnet (Phase 5)

**BLOCKED (external): Testnet funding only.** P0-08's live payment consumed the
treasury's 10 RLUSD. Read-only preflight (2026-10-05, ledgers 21303592 and
21304142): `network_id` 1; treasury `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` holds
**0 RLUSD**, 10 required; both trust lines present. No live governed request was
made, nothing was signed or submitted, and no evidence was fabricated.

**To complete:** at least 10 Testnet RLUSD to the treasury (tryrlusd.com), then:

```bash
set -a; . ~/.config/frontera-andrew/testnet.env; set +a
node packages/xrpl-testnet-transport/scripts/preflight.mjs          # must print "ready": true
FRONTERA_ANDREW_P009_LIVE=1 \
FRONTERA_XRPL_TESTNET_ENDPOINT='wss://s.altnet.rippletest.net:51233/' \
FRONTERA_ANDREW_ATTEMPT_STORE=$HOME/.config/frontera-andrew/xrpl-attempts-p009-live-1.sqlite \
FRONTERA_ANDREW_EVIDENCE_FILE=$HOME/.config/frontera-andrew/p009-evidence.json \
node --test dist/src/enterprise/__tests__/andrew-p009-live-testnet.test.js
```

The run performs exactly: one original denial (0/0/0); one exact replay (same
decision, 0/0/0); one explicit destination approval (0/0/0); one linked
reconsideration → one fresh grant, exactly one signature, one submission, one
validated payment with exact delivery (transport record and independent ledger
re-read); the reconsideration's ASSURE-01 trace verifying its lineage to the
original; a second reconsideration withheld (already realized); a final replay of
the original still returning the same denial. Then P0-09 is merged into
`feat/andrew-demo`.
