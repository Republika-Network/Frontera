# TRADE-04D — Durable Recovery, Validated-Ledger Reconciliation & Delegated Signer Crash Safety

> **Status:** IMPLEMENTED (offline; fake-ledger qualified). §1 is the Phase 1 architecture checkpoint, written before any production edit and unchanged in substance; §2–§16 record what was built and qualified.
> **Baseline:** `origin/main` @ `66ca5b8` (TRADE-04C-S1, PR #191), with TRADE-04A `11db917`, 04B `d9339a5` and 04C `ffcf599` as ancestors.
> **Network:** none. No live XRPL access and no transactions. TRADE-04D is offline-qualified; TRADE-05 is separately authorized.

**Invariant:** no recovery path may produce an additional signature or XRPL submission for an execution that was already attempted.

---

## 0. Baseline (Phase 0)

| Check | Result |
|---|---|
| Worktree / branch | `Frontera-trade-04d` / `feat/trade-04d-recovery-reconciliation`, clean |
| HEAD vs `origin/main` | both `66ca5b8f59037879e868729eebe5fd5febe15139`; no divergence |
| Ancestry | `11db917` (04A), `d9339a5` (04B), `ffcf599` (04C), `66ca5b8` (04C-S1): all ancestors |
| Focused baseline (`trade04*` and `xrpl-transport` suites, built `dist`) | 635 tests, 634 pass, 1 fail. The failure is `trade04c-mutation` › *release-an-uncertain-window…*: `AUTHORITY_FRESHNESS_UNAVAILABLE` ("witness did not answer within 2000 ms") under parallel load. Alone, the file passed twice: 23/23 each run. Classified as load-induced, with evidence |

---

## 1. Architecture and security checkpoint (Phase 1)

### A. Existing durable state transitions

Four durable records in three custody domains describe one governed trade execution.

| Record | Owner / custody | States | Writer |
|---|---|---|---|
| P11 attempt + initial observation (`execution-outcome-store`) | Host | prepared → terminal `{provider: completed \| failed(reason) \| unconfirmed(providerRef?)}` or `{withheld}`. Append-only; **no `detail`** is stored | governed-action lifecycle |
| P12 binding + resolution (`execution-resolution-store`) | Host | bound(authorityId) → resolved(confirmed-completed \| confirmed-not-completed) | P12 service (`reconcile`, operator attestation) |
| Trade interlock row (`sqlite-trade-sequence-interlock.ts`) | Host, CORE-07 slot `trade-sequence-reservations` | `reserved → submitting → unconfirmed → settled{validated-success \| validated-failure \| malformed \| expired}`; `reserved → settled` only on a ledger fact. Forward-only triggers, never deleted, every read re-verified | executor (`reserve`, `markUnconfirmed`, `settle`), the submit site (`claimSubmission`), and the P12 trade authority (`settle`) |
| Signer capability row (`reference-capability-ledger.ts`) | **customer-operated signer** | `consumed → signed(hash) \| signing-failed`; forward-only, never deleted; `capability_id` PK, `execution_id` UNIQUE | reference signer only |

The executor's order of operations (`trade-offer-executor.ts`) is bind → `recorded()` → validated preflight → `blocking()` → capability issued (CORE-02, not durable on the Host) → signer call → verify → `reserve()` (anchored) → `submitReserved()` (claim anchored, then the one `submit`) → validated finality → `settle`/`markUnconfirmed`.

### B. P11 and P12 resolution contracts

- **P11** has one write-ahead claim per `executionId` and one initial observation, never reopened. A trade outcome is `completed` (validated `tesSUCCESS`), `failed` (refused before submission, `tem`, validated `tec`, or proven expiry) or `unconfirmed` (with a `providerRef` = tx hash whenever a signature was verified).
- **P12** (`execution-reconciliation/service.ts`) runs only on an explicit `reconcile(executionId)`; there is **no background loop**. It asks the bound authority once, outside any transaction, and accepts only the closed answer. `unresolved` writes nothing. A definitive answer is appended first, then the P7 capacity row.
- **Trade authority** (`trade-resolution-authority.ts`) is read-only toward the ledger (four reads). It matches action, executionId, providerRef, grant, decision and request against the interlock row, then answers from validated evidence only: `tesSUCCESS` → completed; `tec…` → not-completed; proven non-inclusion → not-completed; anything else → `unresolved`. Its one write is `interlock.settle` (bookkeeping, forward-only).

### C. CORE-07 witness and rollback protections

- The interlock's anchored history is a hash chain over **reservations and claims**. A stale restore that lost either is `regressed`/`forked`; a witness-prepared event the file does not hold is `pending-recovery`, refused until trusted operational recovery. Every read passes `observe()` (the process floor); `blocking()` also probes the witness.
- `markUnconfirmed`/`settle` are **not** anchored. Rolling one back reopens a record (conservative: it blocks again and P12 re-reads the ledger). It never releases one.
- A store holding records but no anchor is never anchored after the fact. Without the witness, the store is never opened for execution.
- **The signer ledger has no external anchor.** S1 states this limitation (S1 §(threats), line 47): deleting rows or restoring an older copy re-enables consumed but unexpired capabilities (lifetime ≤ 60 s, skew 5 s).

### D. Signer v2 capability-consumption lifecycle

1. The Host's executor obtains a CORE-02 capability from the authority (`issuer.issue`). It binds `executionId`, `boundedGrantId`, org, proposal digest, network, owner, delegate, signing-preimage digest, `Sequence`, `Fee` and `LastLedgerSequence`, with ≤ 60 s lifetime. **The Host does not persist the capability or its id** (the id appears only in the in-memory trace).
2. The signer verifies the capability, then `consume()` (IMMEDIATE, `synchronous=FULL`) **before** touching the key. It then signs and calls `markSigned(hash)`, or `markFailed` on failure. If `markSigned` fails, the row stays `consumed` and the signature is still returned.
3. `openReferenceCapabilityLedger` **creates the file when absent**, and the launcher opens it that way. A lost or deleted ledger is therefore silently recreated empty. This violates Phase 6 requirement 7 and is fixed in TRADE-04D (§K, item S-1).

### E. Ownership of identifiers

| Identifier | Minted by | Uniqueness enforced by | Bound into |
|---|---|---|---|
| `executionId` | governed-action path (P11 claim) | P11 claim; interlock `UNIQUE`; signer ledger `UNIQUE` (separate store) | capability (signed), interlock identity digest, P12 query |
| `boundedGrantId` | P10 grant store | P10 | P11 attempt, capability, interlock evidence |
| owner `Sequence` | XRPL owner AccountRoot (ledger) | XRPL itself (at most one tx per Sequence); interlock blocking window; G4 Trade/Payment disjointness at boot | capability, signed tx, interlock row |
| tx hash | signer (SHA-512Half of the signed blob, re-verified by the TRADE-04B client) | interlock identity (immutable), claim checks | interlock row, P11 `providerRef`, signer `markSigned` |

**Two independent `executionId` uniqueness domains.** The interlock (Host) and the signer ledger (customer) agree only when both hold the same `executionId` with the same hash. The CORE-02 capability (authority-signed) is the only artifact binding them, and the Host keeps no copy. Recovery therefore treats disagreement as **inconsistent evidence** (class 12) and never reconciles it.

### F. Where signed bytes exist, and whether they survive a crash

| Location | Survives a crash? |
|---|---|
| Signer process memory, between `sign` and the HTTP response | No |
| HTTP response in transit (loopback) | No |
| Host executor memory, from signature verification to `submitReserved` | No |
| Trade interlock | **Never stores the blob**: only hash, owner, Sequence, LLS, minLedger and evidence digests |
| Signer ledger | Hash only (when `markSigned` succeeded); never the blob |
| XRPL network / peers | Once submitted, yes (outside Frontera) |

Consequences: Frontera can **never** resubmit (no stored blob), so "retry" is impossible by construction. A lost blob can reach the network only through a party holding it. The signer protocol forbids the signer from submitting; a compromised signer can sign anything anyway (S1 residual).

### G. Reconstructable without signing or submitting

- Any interlock row (`reserved`/`submitting`/`unconfirmed`/`settled`). The row holds hash, owner, Sequence, `[minLedger, LLS]` and network, so a validated `tx` lookup can prove inclusion with its result, or prove non-inclusion once validated ≥ LLS with a complete search.
- Whether Frontera could have submitted: only a `submitting`+ row (claim anchored) permits it. A `reserved` row was **never** sent by Frontera. The submit site refuses without the claim (G2), and a claim is anchored before `submit`.
- Offer effects: the validated tx metadata (`AffectedNodes`) for the row's hash, plus a validated `ledger_entry {offer:{account, seq}}` snapshot at an identified ledger.

### H. Not reconstructable: must remain uncertain

1. **Capability issued, then signer failure, timeout or crash, with no reservation.** P11 records `failed(PROVIDER_UNAVAILABLE)` with no detail and no hash. The Host holds no Sequence, LLS or capability id. Frontera **provably never submitted** (no reservation → no claim → no `submit`). Whether a signature exists is known only to the signer ledger (customer custody, unanchored). Ledger non-inclusion **cannot** be proven without the window: a hash-only lookup can prove inclusion, never absence.
2. **Signature verified, then `reserve()` failed or was blocked.** The blob existed in Host memory only and was never sent. The same Host-side gap applies: no durable hash on the Host.
3. **`consumed` with no hash** (signer crash between consume and `markSigned`, or a `markSigned` failure). Whether a signature was produced is unknowable from any record.
4. **Restored or rolled-back signer ledger.** An absent row never proves no signature.
5. **Window open, or ledger history incomplete.** The outcome is pending; elapsed time is never evidence.

### I. Automatic vs operator-mediated

- **Automatic (unchanged):** none. P12 runs only on explicit `reconcile`. The executor's own finality loop is the only automatic reading, and it settles only on validated facts.
- **TRADE-04D additions, read-only:** the recovery assessment and offer-state reading. Running them changes no durable lifecycle, settles nothing and releases no Sequence. The answer is an *assessment*, kept separate from any permission to act.
- **Operator-mediated (existing, unchanged):** P12 `reconcile` (trade authority) and PROD-03-02 operator attestation where bound. TRADE-04D adds no write action, re-sign, raw submit or forced release.

### J. Not weakening Payment or the shared transport

- `src/features/xrpl-transport/` is unchanged: `readXrplInclusion` and `xrplNonInclusionProven` are reused verbatim and wrapped, never replaced.
- G2: the single `command: 'submit'` in `xrpl-sdk-client.ts` is untouched. The recovery reader is built from the four-read `readOnlyTradeLedger` plus validated `ledger_entry` reads only. It has no submit, no signer and no reserved-submission client.
- G4: no Payment store, interlock or ownership rule is touched. G1 stays refused at boot.

### K. Changes and their approval class

**Within the authorized boundary (to be implemented):**

| # | Change | Class |
|---|---|---|
| R-1 | `trade-ledger-evidence.ts`: a strict, read-only validated-evidence reading. It wraps `readXrplInclusion`/`xrplNonInclusionProven` and adds network identity, hash, Account, TransactionType, Sequence and LLS binding, `ledger_index` ∈ `[minLedger, LLS]`, `ledger_hash` provenance, and validated-index ordering. A mismatch is **unresolved**, never a closure | extends the Trade P12 reading (stricter) |
| R-2 | The trade P12 authority and the executor's finality loop use R-1 (same outcomes for genuine evidence; strictly fewer closures otherwise) | strengthening, no new authority |
| R-3 | `trade-offer-state.ts`: a pure classification of validated metadata, plus a validated offer snapshot `ledger_entry {offer}`, with ledger index and hash on every assertion | read-only, no oracle |
| R-4 | `trade-recovery-assessment.ts` (pure): the 12-class assessment over the P11 view, interlock row, untrusted signer observation and ledger evidence | read-only |
| R-5 | `trade-recovery-coordinator.ts` plus an in-process `recovery(executionId)` on the composed trade execution, next to the existing `evidence()`; an operator diagnostic projection | read-only, no route |
| S-1 | Reference signer ledger: **never auto-create** a missing ledger. Creation becomes an explicit `create` act; the launcher gets an explicit `init-consumption-ledger` command. Plus a read-only `inspect(executionId)` (fail-closed) | customer reference signer, stricter; protocol v2 unchanged |

**Requiring approval (NOT implemented; presented as decisions):**

| Gate | Proposal | Why gated |
|---|---|---|
| D-1 | A durable **pre-signing intent** on the Host (owner, Sequence, LLS, preimage digest, capability id) anchored in CORE-07 before the signer call. It would close H.1–H.3 on the Host side: the Sequence stays blocked and the window is known | interlock schema v2 + new anchored event kind (incompatible migration). **Authorized and implemented 2026-10-15 — §17** |
| D-2 | Expose the recovery diagnostic as an authenticated `/api/admin/operations/...` route | new endpoint |
| D-3 | External freshness anchoring of the signer ledger (a customer-side witness) | new trust boundary |
| D-4 | A signer-protocol read operation for capability state | protocol v2 change |
| D-5 | A P11 durable `detail` (to distinguish a signer failure from a preflight refusal) | P11 schema/semantics |
| D-6 | Signer restart quarantine (refuse signing for ≥ max lifetime + skew = 65 s after start). This would neutralize replay after a restore that needs a restart, without an anchor. Within boundaries, but it changes the reference signer's availability contract and every signer-starting suite, so it is offered, not imposed | operational decision |

None of R-1…R-5 or S-1 introduces a CORE-07 slot, a migration, a signing capability, an operator write action or a submission path. The existing invariants are preserved, so **no STOP is required**, and implementation proceeds within the boundary.

### L. Roadmap discrepancy

TRADE-04C §31 lists under TRADE-04D: offer-state reconstruction, OfferCancel, operator tooling, real-ledger recovery drills and pending-Sequence chaining. TRADE-00 §12.2/§18 places metadata offer-effect classification with TRADE-04/05, and live lifecycle tracking, governed OfferCancel and net-exposure reconciliation in TRADE-07. **Resolution for this authorization:**

| Item | Placement |
|---|---|
| Offer effect from validated metadata; point-in-time validated offer snapshot | **TRADE-04D** (read-only) |
| Read-only operator recovery diagnostic | **TRADE-04D** (in-process; route = D-2) |
| Offline crash and recovery drills | **TRADE-04D** |
| Real-ledger recovery drills | TRADE-05 |
| Governed OfferCancel; continuous lifecycle tracking; net-exposure reconciliation | TRADE-07 (unchanged from TRADE-00) |
| Pending-Sequence chaining / throughput (R7) | TRADE-07 (not authorized here; TRADE-04C §31 annotated, not rewritten) |

---

## 2. State machines

**Durable lifecycles (unchanged by TRADE-04D).** No state, transition, trigger or schema was added.

```
Trade interlock (Host, CORE-07-anchored: reserve + claim)
  reserved ──claimSubmission (G2 submit site)──▶ submitting ──▶ unconfirmed ──▶ settled{validated-success|validated-failure|malformed|expired}
     │                                              └──────────────────────────▶ settled
     └──(ledger fact only)────────────────────────────────────────────────────▶ settled

Signer capability ledger (customer signer, not anchored)
  (none) ──consume (before the key)──▶ consumed ──▶ signed(hash)
                                          └────────▶ signing-failed
```

**Recovery assessment (new, read-only; changes neither lifecycle).**

```
                 ┌─ interlock unreadable ─────────────────▶ corrupt → 12 inconsistent-evidence │ stale/unanchored/unreachable → 11 indeterminate
 assess(id) ─────┤
                 ├─ any cross-input contradiction ─────────▶ 12 inconsistent-evidence  (never reconciled)
                 ├─ validated ledger fact for the row ─────▶ 8 validated-success │ 9 validated-failure │ 10 proven-not-included
                 ├─ row open, ledger unavailable/incomplete ▶ 11 indeterminate
                 ├─ row open, window still open ────────────▶ 5 reserved-not-claimed │ 6 submission-claimed │ 7 submission-response-unknown
                 └─ no row ─┬─ signer: signed(hash) ────────▶ 4 signed-not-reserved
                            ├─ signer: consumed / failed ───▶ 3 capability-consumed-unsigned
                            ├─ signer: absent (P11 claimed) ▶ 2 capability-not-consumed
                            └─ otherwise ───────────────────▶ 1 no-trade-record  (proven when P11 holds no claim)
```

## 3. Recovery decision table

`assessTradeRecovery` (`trade-recovery-assessment.ts`). Inputs: the P11 view (authoritative for what the governed path recorded), the interlock row, the signer's report (a hint), and validated evidence (the only source of outcome). Every answer carries `automatedRecovery.permitted: false`.

| # | Class | Proven by | Certainty | Frontera submission | Sequence |
|---|---|---|---|---|---|
| 1 | `no-trade-record` | no row; no consumption evidenced | `proven` when P11 holds no claim (P11's claim precedes every capability); otherwise `indeterminate` | never | not reserved |
| 2 | `capability-not-consumed` | no row; P11 claimed; signer reports `absent` | indeterminate (signer not authoritative) | never | not reserved |
| 3 | `capability-consumed-unsigned` | no row; signer `consumed` (no hash) or `signing-failed` | indeterminate: a signature is `possible` | never | not reserved |
| 4 | `signed-not-reserved` | no row; signer `signed(hash)` | indeterminate: inclusion unprovable without the window | never | not reserved |
| 5 | `reserved-not-claimed` | row `reserved` | pending | never (no claim) | blocked by the rule |
| 6 | `submission-claimed` | row `submitting` | pending; delivery unknown | claimed | blocked by the rule |
| 7 | `submission-response-unknown` | row `unconfirmed` | pending | claimed | blocked by the rule |
| 8 | `validated-success` | validated `tesSUCCESS`, bound | proven: the OfferCreate **applied** | claimed (or `included-without-frontera-claim`) | released by ledger fact once settled |
| 9 | `validated-failure` | validated `tec…`, bound | proven; fee consumed | claimed | as 8 |
| 10 | `proven-not-included` | `xrplNonInclusionProven`, or a settled `tem` submit answer | proven | — | as 8 |
| 11 | `indeterminate` | ledger unavailable, timeout, incomplete history, freshness unproven | indeterminate | unknown or claimed | `unknown` → held |
| 12 | `inconsistent-evidence` | 15 named contradictions (`TRADE_RECOVERY_INCONSISTENCIES`) | refused | — | held |

Contradictions refused, never reconciled: interlock corrupt; execution id, P11 identity (request/decision/grant/organization) or P11 `providerRef` differing from the row; a P11 hash with no trade record (a lost or rolled-back store); a row with no P11 claim; a withheld execution with a row; P11 or P12 outcome against the ledger; the signer reporting another execution, another hash, or no signature where the Host verified one; a consumption for an execution P11 never claimed; a settlement against a fresh ledger read; any ledger binding mismatch.

Refusal reasons (closed): `assessment-only`, `execution-already-attempted`, `signed-bytes-not-retained`, `sequence-held-until-ledger-fact`, `evidence-inconsistent`, `freshness-unproven`. Existing paths named for information only: `p12-reconcile` (open row, consistent evidence) and `operator-attestation` (indeterminate or inconsistent).

## 4. Signer capability recovery

| Requirement (Phase 6) | Result | Evidence |
|---|---|---|
| 1 `consumed` without hash stays consumed | yes: forward-only trigger; reopen → `consumed` | `trade04d-signer-recovery.test.ts`; Scenario D (crash after consumption) |
| 2 `signed` never signed again | yes: `capability-consumed` / `execution-consumed` | signer suite; Scenario D restart: 0 signatures |
| 3 `signing-failed` permanently consumed | yes (`markSigned` cannot revive it) | signer suite |
| 4 a crash before the blob returns cannot trigger replacement signing | yes: the execution id is unique in the ledger (`execution-consumed`); P11 never reopens the claim | Scenario D. **Contained, not prevented:** a caller bypassing P11 obtains a replacement *capability* (no Host record of issuance, gate D-1), which signs nothing |
| 5 a restart does not clear the replay ledger | yes; mutant `replay-ledger-forgets-at-restart` detected | mutation suite |
| 6 a ledger read error is fail-closed | yes: `inspect` throws; `inspectReferenceCapabilityLedger` → `unavailable` | signer suite |
| 7 a missing or corrupt ledger is never recreated | **fixed (S-1)**: was create-when-absent; now refused unless `create: true` / `init-consumption-ledger`; a damaged file is refused even with `create` | signer suite; mutants `implicit-creation-*` |
| 8 a stale restore is not silently authoritative | on the Host: `absent` never closes anything, and contradicting a Host-verified signature is `inconsistent-evidence`. The signer itself cannot detect it (§14) | Scenario J |
| 9 expiry does not establish absence | yes: no clock in the assessment; an expired row reads `consumed` | assessment and signer suites; scenario R/S |
| 10 signer/Host disagreement preserved | yes: `inconsistent-evidence` | assessment suite |

Custody separation holds: the Host never opens the signer ledger. The customer's operator runs `node scripts/run-reference-xrpl-offer-signer.mjs inspect-capability <executionId>` and hands the JSON to the Host operator, whose `recovery(executionId, { signer })` treats it as `TradeSignerObservation`.

## 5. Validated-ledger evidence contract

`readTradeLedgerEvidence` / `readTradeInclusion` (`trade-ledger-evidence.ts`) wrap `readXrplInclusion` and `xrplNonInclusionProven`, unchanged. Read order: `connect`, `server_info` (network), validated index (**first**), bounded `tx` lookup over `[minLedger, LastLedgerSequence]`, validated index, `server_info` again.

| Phase 4 case | Answer |
|---|---|
| inclusion, `tesSUCCESS` | `included / tesSUCCESS` (applied), with the ledger index, `ledger_hash` when stated, the frozen body and metadata |
| validated `tec` | `included / tec` (fee consumed) |
| malformed / other result classes | a validated `tem/tef/ter/tel` is impossible → `result-unrecognized`; a `tem` **submit** answer settles `malformed` (existing executor rule) → class 10 |
| proven non-inclusion | `not-included` with the searched range |
| incomplete history | `history-incomplete` |
| unavailable / inconsistent observations | `ledger-unavailable`, `validated-index-unreadable`, `transaction-not-validated` |
| network identity mismatch | `network-mismatch` (before) / `network-changed` (after) |
| ledger-index disagreement | including ledger > validated index after; validated index regressing |
| hash mismatch | `transaction-hash-mismatch` |
| wrong owner, delegate, type, Sequence, LLS | `wrong-account`, `wrong-delegate`, `wrong-transaction-type`, `sequence-mismatch`, `last-ledger-sequence-mismatch` |
| including ledger outside the window | `ledger-outside-window` |
| read timeout | `read-timeout` |
| unknown result | `transaction-unreadable` |

Every row except the first three and proven non-inclusion is **unresolved**. The P12 trade authority (R-2) and the executor's finality loop now read through this contract. For genuine evidence, outcomes are identical to TRADE-04C. Otherwise they close strictly fewer cases. One visible nuance: a validated result outside `tesSUCCESS`/`tec`, which a real ledger cannot hold, used to end the executor's finality as `unconfirmed (trade-result-unrecognized)`. It is now an unbound answer: the loop keeps reading and ends as `unconfirmed (trade-finality-unknown)`. Both remain `unconfirmed`, and P12 then reads the same way.

**Fixture realism (disclosed).** TRADE-04C's fake ledger answered `tx` with a minimal shape (`hash`, `validated`, `ledger_index`, `meta.TransactionResult`). It now answers rippled's API v2 shape: `tx_json` decoded from the real signed blob, `ledger_hash`, `meta.AffectedNodes`, and an Offer object for `ledger_entry {offer}`. Adversarial knobs were added. No TRADE-04C assertion was changed. Two pinned structural tests were updated for intended changes only: the edge's file inventory, and the source text of one mutation site whose mutant is unchanged.

## 6. Transaction versus offer-state semantics

`readOfferCreateEffect` reads the validated transaction's **own metadata**. `readTradeOfferSnapshot` is an independent validated `ledger_entry {offer: {account, seq}}` through the shared validated reader. `assessTradeOfferState` combines them (`trade-offer-state.ts`).

| Evidence | Effect | Later snapshot → interpretation |
|---|---|---|
| `tecKILLED` | `killed` | `not-placed` (present → `state-unknown`) |
| other `tec` | `transaction-failed` | `transaction-failed` |
| own `CreatedNode` Offer, the transaction's amounts | `offer-resting` | present → `resting-as-of-snapshot`; absent later → `no-longer-present-as-of-snapshot` (cause **not** inferred) |
| own Offer, amounts no larger, one smaller | `partially-executed-remainder-resting` (remainder as the ledger states it) | as above |
| no own Offer + `tfFillOrKill` | `executed-in-full` | `not-placed` |
| no own Offer otherwise | `applied-not-resting`: full crossing, cancelled IOC remainder or unplaced remainder, not distinguished | `not-placed` |
| inconsistent (two own offers, IOC/FoK leaving an offer, own offer modified, amounts grew, unreadable flags, no ledger hash) | `unknown` | `state-unknown` |

Every assertion records the ledger index and hash. A missing `ledger_hash` in the `tx` answer is filled from the validated header, or the reading is `unknown`. Not computed: executed quantity, fill price, liquidity, aggregate exposure. There is no market-data oracle. Continuous lifecycle tracking is TRADE-07.

## 7. Non-inclusion proof requirements

Only `xrplNonInclusionProven(reading, validatedIndexReadBeforeLookup, LastLedgerSequence)` holds as proof: `txnNotFound` with `searched_all: true` over `[minLedger, LastLedgerSequence]`, after the validated index (read first) reached `LastLedgerSequence`. The following are never proof: `searched_all: false`, `entryNotFound`, any other server error, a timeout, a missing submit response, a signature without a known window, a capability past its expiry, or elapsed time. A record released by the blocking rule (validated index ≥ `LastLedgerSequence`) is released by a protocol fact, not a timer. Mutants `last-ledger-sequence-boundary` and `complete-non-inclusion-proof` are detected.

## 8. Crash-consistency guarantees

| Crash point | Durable state | Assessment | Effects on restart |
|---|---|---|---|
| before capability consumption | P11 claim | 1 / 2 | 0 signatures, 0 submissions |
| after consumption, before signing | signer `consumed` | 3 | execution refused by the signer |
| after signing, before the response | signer `signed(hash)` | 4 | execution refused by the signer; never reserved, never sent |
| after reservation, before the claim | row `reserved` | 5 → 10 after the window | never sent by Frontera |
| after the claim, before the send | row `submitting` | 6 → 10 | 0 sends |
| after the send, before local settlement | row `submitting`, tx on ledger | 6 → 8 | P12 settles; 1 send total |
| response lost | row `unconfirmed` | 7 → 8/9/10 | P12 settles; 1 send total |
| during CORE-07 preparation | witness `pending` | store refused at open (`PENDING_RECOVERY`, TRADE-04C test) | executor not composed |

Two coordinators and two P12 reconciliations racing on one execution produce identical assessments and exactly one settlement transition (Scenario K).

## 9. CORE-07 and backup preservation

- No CORE-07 slot, ownership or semantics changed. The coordinator refuses a read when the interlock's freshness status is `regressed`, `forked`, `pending-recovery`, `unbound` or `not-anchored`, and reports `interlock-freshness-unproven` when the witness is unreachable. Mutants `core07-failed-status-ignored` and `rollback-error-read-as-empty` are detected.
- A rolled-back trade interlock, behind its reservation **or its claim**, is refused at open (Scenario J, §8 K).
- PROD-02/03: `DEPLOYMENT_FLAGS` and the store registry are unchanged. The Host backup covers `xrpl-trade-sequence-interlock.sqlite` (strict, conditional on `xrplTradeExecution`). The signer ledger is **customer custody** and is deliberately not in the Host backup. Restoring an older signer ledger is the customer's operation and is subject to §14.

## 10. Operator diagnostics

`composeXrplTradeExecution(...).recovery(executionId, { p11?, signer?, offerSnapshot? })` sits beside `evidence()`. It is in-process only, with no route (D-2), and returns `{ assessment, diagnostic }`. The diagnostic (`frontera.trade-recovery-diagnostic.v1`) answers:

| Question | Field |
|---|---|
| Which execution; organization, owner, delegate, network | `executionId`, `organizationId`, `ownerAccount`, `delegateAccount`, `networkId` |
| Last durable interlock state | `lastDurableState`, `settlement` |
| Signer capability | `signerCapability` (`consumed`, `signed`, `signing-failed`, `absent`, `unavailable`, `not-supplied`) |
| Claim recorded | `submissionClaimRecorded` |
| Authoritative XRPL result | `ledgerResult` (status, reason, engine result, ledger index and hash, validated index) |
| Offer state | `offer` (interpretation, effect, ledger index and hash, snapshot ledger), **no amounts** |
| Owner Sequence still blocked | `sequence` |
| What is uncertain; what would settle it | `uncertainties`, `evidenceNeeded` |
| Why automation is refused | `automatedRecoveryRefused` |
| Supporting evidence | `evidence` (hash, grant, request, decision, reservation time, transitions, reference ledger) |
| Permission | always `'none'` |

It never carries a key, credential, bearer token, signed blob, amount, price or strategy (pinned structurally and asserted on the shipped Host, Scenario A).

## 11. Fault-injection scenarios

| Scenario | Where | Result |
|---|---|---|
| A normal confirmed | shipped Host | 1 capability, 1 signature, 1 submission; `validated-success`, consistent; offer `resting-as-of-snapshot` |
| B denied | shipped Host | executor never invoked; `no-trade-record` proven |
| C approval | shipped Host | 0 effects while withheld; 1 execution after approval |
| D signer crash (3 variants) | executor rig + real HTTP signer and ledger | classes 4 / 3 / 2; restart: 0 signatures, 0 submissions |
| E response lost | rig and shipped Host | pending (Sequence held, competing order refused) → `validated-success`; P12 settles; 1 send |
| F indeterminate | rig | timeout, unreachable ledger, incomplete history: `indeterminate`; nothing settled |
| G proven expiration | rig | `proven-not-included`; P12 settles `expired`; the same execution → previously recorded |
| H validated `tec` | rig | `tecUNFUNDED_OFFER` → failed; `tecKILLED` → killed / not placed |
| I resting / partial / filled / removed | rig | exactly the metadata- and snapshot-proven classes |
| J rollback | rig | interlock refused at open; signer restore → `inconsistent-evidence`, 0 new effects |
| K concurrent | rig | identical assessments; one settlement |
| L adversarial | rig | 8 tamperings + wrong network + fabricated metadata: no settlement; no offer claim |
| Phase 8 A, E/G/H, F/N, K, M, O, Q, R/S, T | rig and interlock | §8, §9 |

TRADE-04C Scenarios A–F and the S1 suites ran unchanged as preservation tests (§16).

## 12. Mutation results

`trade04d-mutation.test.ts` covers 23 mutants: **20 detected and 3 contained**. None survives unexplained.

| Area | Mutants (detected unless marked) |
|---|---|
| Evidence contract | transaction-hash-binding, owner-account-binding, sequence-binding, network-identity-checks-both, last-ledger-sequence-boundary, inclusion-beyond-validated-index, complete-non-inclusion-proof, result-code-classification, validated-result-class-only; network-identity-check-before-lookup (**contained** by the post-lookup check) |
| Offer state | partial-fill-read-as-resting, fill-or-kill-required-for-full-execution, snapshot-before-inclusion-accepted |
| Assessment | signer-restore-trusted, sequence-released-without-ledger-index, authority-to-outcome-binding |
| CORE-07 / rollback | core07-failed-status-ignored, rollback-error-read-as-empty |
| P12 binding | resolver-grant-binding |
| Signer ledger | replay-ledger-forgets-at-restart, implicit-creation-both-guards; implicit-creation-guard (**contained** by `fileMustExist`) |
| No repeat | no-repeat-recorded-check (**contained** by the signer's execution uniqueness and the interlock's `execution-recorded` reservation) |

Phase 10 items already qualified elsewhere, and re-run in §16: submission-claim requirement and no-resubmit (TRADE-04C `submit-before-reservation`, `unanchored-claim`, `claim-allowed-twice`, `blind-retry-after-uncertain-submission`); signer consumption, single use and execution uniqueness (S1 `ignore-consumption`, `no-single-use`, `no-execution-uniqueness`); Trade/Payment Sequence separation (TRADE-04C boot-overlap mutant); CORE-07 before signing (TRADE-04C).

## 13. Remaining uncertainties

1. **Pre-reservation signatures (H.1–H.3).** After a signer failure, crash or lost response, or after a failed reservation, the Host holds no Sequence, LLS or capability id. Inclusion of a lost blob is provable only with the signer's hash. Non-inclusion is not provable, and the owner Sequence is not held by the interlock. Frontera provably never sent such a blob; a party holding it could. The fix is gate **D-1** (a durable pre-signing intent). *Closed on the Host side by D-1 (§17): the window is recorded and held before the capability exists, and non-inclusion is provable from the owner's validated Sequence. What remains is §17.9.*
2. P11 `failed` after a possible signature means "Frontera never submitted", not "the ledger proves non-inclusion". P11 stores no `detail` to distinguish the two (**D-5**).
3. The XRPL server is trusted for what it validated; ledger proofs are not verified.
4. Offer history between the including ledger and a snapshot is not reconstructed (TRADE-07).

## 14. Signer-ledger rollback limitations

SQLite durability (`synchronous=FULL`, WAL) survives crashes. It does **not** detect restoration of an older copy or a malicious rewrite on the signer host. After such a restore, capabilities consumed in the lost history are consumable again until they expire (lifetime ≤ 60 s, skew 5 s). The Frontera executor never re-presents one (P11, interlock), so exploiting this needs the bearer credential, a captured capability **and** write access to the signer host. Within existing boundaries:

- **Done:** no implicit recreation (S-1); recovery treats the signer's report as a hint; contradictions surface as `inconsistent-evidence`.
- **Offered, not imposed (D-6):** a signer restart quarantine of ≥ 65 s neutralizes replay after any restore that requires a restart, without an anchor. Until it is decided, the operational rule is: **after restoring a signer ledger, keep the signer stopped for at least 65 s before serving.**
- **Needs a separate security decision (D-3):** external freshness anchoring of the signer ledger. This is a new trust boundary in customer custody, and TRADE-04D stopped short of it.

## 15. TRADE-05 prerequisites

1. Separate authorization for funded Testnet accounts, a real XLS-75 delegation and live writes.
2. Confirm on a real rippled that `tx` (API v2) carries `tx_json` and `ledger_hash` as the evidence contract reads them. The `ledger_hash` fallback to the validated header is implemented, but the shape is not proven live.
3. Confirm real `ledger_entry {offer}` and `entryNotFound` shapes, and real offer metadata for resting, partial and IOC/FoK cases.
4. A live recovery drill: response loss, restart, Host backup and restore, and the signer ledger initialization procedure.
5. Decisions on D-1 (pre-signing intent) and D-6 (signer restart quarantine) before any production claim. *(D-1 implemented, §17. D-6 assessed, not implemented, §18.)*
6. Unchanged: the R1 residuals of TRADE-04C-S1, the customer-operated v2 signer, and G1 not authorized.

## 16. Validation and final qualification verdict

Validation ran sequentially on the built worktree (`/mnt/c` under WSL2). Logs were kept outside the repository.

| Step | Result |
|---|---|
| 1 TRADE-04D suites | **156 / 156** |
| 2 TRADE-04A / 04B / 04C / S1 + shared transport | **635 / 635** (final run; an earlier run failed two pins that TRADE-04D had to update, below) |
| 3 CORE-02 custody | 200 / 200 |
| 4 CORE-04 / 05 / 07 (+ kernel authority, trusted context) | 363 pass, 0 fail, 8 skipped, 4 todo (of 375) |
| 5 P11 / P12 | 193 / 193 |
| 6 PAY-02 / 03 / 05 / 07 / 08 / 09 + XRPL rail | 599 / 599 |
| 7 NO_BYPASS / security invariants / CORE-06 structure | 87 / 87 |
| 8 Backup / restore (PROD-02, portability) | 91 / 91 |
| 9 PROD-03 deployment and operations | 353 / 353 |
| 10–13 typecheck, build, lint, release integrity | pass |
| 14 full root suite (inside the protocol-tarball validation, a clean temporary install) | 12149 tests: **12133 pass, 2 fail**, 10 skipped, 4 todo. Both failures are `AUTHORITY_FRESHNESS_UNAVAILABLE` ("witness did not answer within 2000 ms") in `authority-state-freshness-grants` and `pay08-x402-governed-payment`, files TRADE-04D does not touch. Alone, both pass twice (61 / 61 each run). The baseline showed the same timeout class (§0) |
| 15 all workspaces | 1103 / 1103 |
| 16 protocol tarball | every step PASS except `test` (row 14) |
| 17 publishability | pass |
| 18 clean-room consumer | pass (`ok: true`) |

Regressions found and fixed during validation (honest record):

1. `xrpl-rail-boundaries` (PAY-02 SDK import boundary): the fixture imported `xrpl` directly. It now uses TRADE-04B's allowed `decodeBlob`.
2. `xrpl-transport-boundaries`: the pinned importer list now names the four read-only TRADE-04D modules; the P12 authority left it, reading through the evidence contract.

Environmental failures, with evidence:

- Full root runs directly on `/mnt/c` reported spawned children failing with `ENOENT … uv_cwd`, and one `/posture` launcher timeout. The shell's working-directory handle went stale mid-run, and the npm steps after it failed the same way.
- Every affected file passed alone: PAY-03 / 04 / 05 130 / 130, launchers and preflight 24 / 24, TRADE-04C and S1 Host 36 / 36. The same suite in a clean temporary install showed only the two witness timeouts above.

No security assertion was weakened. Updated pins: the TRADE-04C edge file inventory, the source text of one TRADE-04C mutation site (same mutant), the shared-transport importer list, and S1 tests that now create a fresh signer ledger explicitly.

**Verdict: READY FOR PR.** Within the authorized boundary, TRADE-04D:

- reconstructs outcomes from durable records and validated evidence only;
- never adds a signature, capability use or submission on any qualified recovery path;
- preserves uncertainty where the records cannot remove it;
- touches no CORE-07 ownership, schema, route, signing capability or submission path.

It is not production-ready and not Testnet-proven. That still needs:

- TRADE-05, separately authorized;
- a decision on D-1, the Host-side pre-signing intent that would close §13.1;
- a decision on D-6, or a separately decided D-3, for signer-ledger rollback (§14);
- the S1 residuals.

---

## 17. D-1 — The durable pre-signing intent (authorized 2026-10-15)

> Addendum. §§0–16 above are TRADE-04D's original qualification record and are not rewritten. D-1 was authorized explicitly as a narrowly scoped production change: a Trade interlock schema migration and CORE-07 integration within the existing slot. No CORE-wide schema, Payment store, authority root or effect path changed.

### 17.1 The gap, and its order

Before D-1 the executor:

1. selected the owner Sequence;
2. had CORE-02 issue the capability;
3. contacted the signer;
4. only then reserved the Sequence durably.

A crash between steps 3 and 4 left a possibly valid blob with no Host record (§1.H.1–H.3). Now:

```
preflight (validated reads; non-binding blocking probe, witness probed)
  → recordIntent      durable + anchored ('intent' event); holds the owner Sequence window          ← before any capability
  → issuer.issue      CORE-02 capability for exactly the intent's preimage
  → markSigning       durable + anchored ('sign' event), binds the capability id                   ← before the signer is contacted
  → signer            signature verified independently (unchanged)
  → reserve           continues exactly this `signing` intent → `bound`; anchored ('reserve')
  → claim / submit / finality   unchanged (G2)
```

No refusal at any step releases the intent. *(Revised by the final security review, §19: the first version abandoned the intent on a refusal before `markSigning`. That was unsafe because CORE-02 issuance is external.)*

### 17.2 The intent: what it binds

`trade_intents` holds one row per execution id, ever (`UNIQUE`). Each row binds:

- the execution id;
- the owner, its `Sequence`, `LastLedgerSequence` and `minLedger` (the reference validated index + 1);
- the `signingPreimageDigest` the capability will name;
- closed evidence: organization, subject, request, decision, bounded grant, proposal digest, delegate, signing key and key authority, the **prepared-offer digest** (which commits to the whole OfferCreate, Fee included), the delegation assessment and facts digests, the reference ledger index and hash, the delegation and AccountRoot observation indices, fee, ledger provenance, **trust domain** and **network**;
- once `signing`, the capability id.

Integrity follows the reservation pattern: identity and state digests, an append-only transition log, forward-only and immutability triggers, the capability id bound once, and nothing ever deleted. Every read re-verifies the row, and a mismatch is refused, never repaired.

### 17.3 State machine

```
intended ──markSigning (anchored 'sign')──▶ signing ──reserve (anchored 'reserve')──▶ bound ─▶ reservation lifecycle (unchanged):
   │                                           │                                              reserved → submitting → unconfirmed → settled
   │                                           └──expireIntent (P12, owner-Sequence proof)──▶ expired
   └──────────────┴── expireIntent (only a qualified owner-Sequence proof for exactly this window) ──▶ expired
```

- **Open, and blocking under the shared rule `xrplSequenceWindowBlocks`:** `intended`, `signing`. A `bound` intent's window is held by its reservation.
- **Release without a ledger fact:** none. There is no abandoned state (§19).
- **Release by the ledger:** the validated index reaching `LastLedgerSequence` (the same G4 rule as a reservation), or `expired`, recorded only on the owner-Sequence proof. Elapsed time is never an input.

Under v2, `reserve` refuses unless the execution's intent is `signing` and binds the reservation exactly: owner, `Sequence`, LLS, `minLedger`, and every shared evidence value, `preparedDigest` included. The reservation, the `signing → bound` transition and the `reserve` event commit in one transaction. The `reserved → submitting → unconfirmed → settled` semantics, the claim and every settlement are unchanged.

### 17.4 CORE-07

Slot `trade-sequence-reservations` is unchanged. Its hash chain now also covers `intent` and `sign` events, in commit order. A restore that loses an intent or a signing marker is `ROLLBACK_DETECTED` at the next open (tested), as is one that loses a reservation or a claim. A crash with the witness prepared but the file not committed is `PENDING_RECOVERY`, and no capability was issued against it (tested).

`expired` is a local transition, like `settle`. It only ever releases, so a restore that loses it re-blocks: conservative.

### 17.5 Migration v1 → v2

- **When.** Only on the Host's open for execution, and only **after** every v1 record verified and CORE-07 established the history. A stale or rolled-back v1 copy is refused by the witness first and left unmigrated (tested). Verification tooling (backup/restore, no scope, no witness) opens a v1 file read-only and never migrates it.
- **How.** One immediate transaction, additive only:
  - create the intent tables, the migration record, the v2 anchored-event table and the `trade_anchored_history` view;
  - freeze the v1 event table against inserts, keeping every row, digest and trigger;
  - seed the v2 event row ids to continue after the last v1 row;
  - record the version.

  Nothing is dropped, rebuilt, reset or re-anchored. The witnessed head is recomputed through the view and must equal the pre-migration head, or the transaction aborts.
- **Legacy.** The migration record (digest-checked, immutable) keeps the reservation and event ceilings. Reservations at or below them predate D-1 and need no intent. Any later one must continue a `signing` intent. Legacy windows still block, and legacy claims still work; they are anchored in the v2 table.
- **Refused, unmutated:**
  - a v2 version row whose tables or view are incomplete;
  - a v1 file carrying v2 tables;
  - a forged v2 version row on v1 tables;
  - a tampered or deleted migration record.
- **Backup/restore.** `store-registry.mjs` accepts both versions (`TRADE_INTERLOCK_SUPPORTED_SCHEMA_VERSIONS`). A restored v1 backup is verified as v1, and the Host migrates it only once it proves fresh. Coverage and conditional-store flags are unchanged.

### 17.6 Recovery, P11/P12, diagnostics

- **Assessment:**
  - It reads the intent: `assessment.intent`, with the capability id and window in the diagnostic.
  - `intended` → `capability-not-consumed`, **pending**, signature `not-sent-by-host`, uncertainty `capability-issuance-unknown`. The Host never handed the capability to the delegated signer, but one may exist (§19).
  - `signing` with no reservation → new class 13 `signing-attempted`, or the signer-reported classes 2–4.
  - A signer consumption reported against an intent the Host never sent → `inconsistent-evidence`, as is a capability id mismatch.
- **Owner-Sequence proof** (`trade-sequence-evidence.ts`, read-only, shared validated reader):
  - A validated `AccountRoot` at `L ≥ LastLedgerSequence` with `Sequence` still equal to the intent's proves the intent's transaction was never included, whatever its hash.
  - `Sequence` above it means consumed by *some* transaction: never a closure.
  - Below it, absent, unreadable, wrong network or stale: unresolved.
- **P12** (existing trade authority, extended):
  - `signing` → only the owner-Sequence proof → `expireIntent` → `confirmed-not-completed PROVIDER_REJECTED`.
  - Anything else → unresolved.
  - P11 claims are never reopened.
- **Executor.** An execution with any intent (or reservation) is answered `unconfirmed trade-execution-previously-recorded` before any ledger read or capability. A restart after a signer crash no longer issues a replacement capability: the §1.H/§4.4 *contained, not prevented* note is now **prevented**.

### 17.7 Fault injection and mutation (counts are explicit in every test)

Each row lists the effects counted as capabilities / signatures / submissions.

| Fault | Result |
|---|---|
| Crash before the intent commit | 0 / 0 / 0, no intent; a fresh order then runs once |
| Crash during witness preparation of the intent | 0 / 0 / 0; next open `PENDING_RECOVERY`; file holds no intent |
| Crash after the intent commit, before issuance | 0 / 0 / 0; `intended`; window held; restart refuses; P12 unresolved until the owner-Sequence proof past LLS, then `expired` |
| Crash after issuance, before the marker | 1 / 0 / 0; as above |
| Issuance answered a timeout, but the capability exists and is intercepted | intent stays `intended`; a competing order is refused; the credential holder can sign only the intent's exact transaction; if it consumes the Sequence, P12 stays unresolved (§19) |
| Crash after consumption / after signing, before the response | 1 / 1 / 0; `signing`; a forged release is refused; window held; restart refuses with **no** new capability; past LLS the owner-Sequence proof → `proven-not-included`, P12 `expired` |
| Crash at the old reservation point (signed, `reserve` never ran) | 1 / 1 / 0; window held; if the customer's copy consumes the Sequence → `sequence-consumed-by-unknown-transaction`, P12 unresolved |
| Duplicate execution ids | one intent ever; `execution-recorded` |
| Same-owner contention | an open intent blocks until LLS, or until a qualified proof for exactly its window; forged, foreign-window and foreign-owner proofs are refused |
| Concurrent processes (two connections, one witness) | one intent per contested Sequence; forged releases racing a signing marker never commit |
| Restart with an unresolved intent | still blocking; executor refuses |
| Stale backup | losing an intent or a signing marker → `ROLLBACK_DETECTED` |
| Lost submission claim | unchanged, refused (§16 K) |
| Incomplete / unavailable / wrong-network / stale ledger | unresolved; window held |
| Proven non-inclusion | owner Sequence unconsumed at `L ≥ LLS` only |
| Corrupted / partially migrated store | refused, unmutated |
| Witness unavailable | intent refused; 0 / 0 / 0 even with the pre-signing probe bypassed |

Mutation suite `trade04d-d1-mutation.test.ts` (after §19): **20 mutants, 16 detected, 4 contained**. Each contained mutant names the independent boundary that contains it:

- a reservation on an uncontacted intent → the forward-only trigger;
- an ignored `blocked` outcome → the closed outcome check;
- an ignored prior intent → the intent's own `execution-recorded` and its window;
- an absent `AccountRoot` read as proof → the AccountRoot parse.

Pre-existing mutants whose verdict D-1 changed, recorded rather than hidden:

| Mutant | Was | Now | Contained by |
|---|---|---|---|
| TRADE-04C `skip-delegate-key-verification` | detected | contained | the intent's closed evidence (no `keyAuthority`, nothing issued) |
| TRADE-04C `skip-sequence-blocking-before-signing` | detected | contained | the anchored intent's binding blocking check |
| TRADE-04C `skip-sequence-blocking-at-reservation` | detected | contained | the same check |

### 17.8 Behaviour changes callers can see

1. After the signer was contacted, even if it refused, the owner Sequence stays held until the validated ledger passes `LastLedgerSequence` or P12 records the owner-Sequence proof. The next order on that owner is `trade-sequence-in-flight` until then. A signer's refusal is its word, not proof that no signature exists (requirement: never assume that a missing Host-side signature means the transaction could not exist).
1a. *(§19)* The same holds after any refusal at capability issuance: refused, revoked, timed out, or a capability that does not bind. Once the intent exists, its window is held until the ledger closes it.
2. A duplicate execution after an intent is `unconfirmed trade-execution-previously-recorded` (no `providerRef` when no hash was ever recorded), instead of reaching the signer.
3. `reserve` without a `signing` intent is refused (`TRADE_INTERLOCK_INTENT_REFUSED`).
4. *(§20, H-1)* From the issuance call on, those refusals are reported to P11 as `unconfirmed` (no `providerRef`), not `failed`: the P7 capacity stays settled and the execution is closed by P12 on the ledger fact.

### 17.9 What D-1 does not close

- **Outcome when the Sequence was consumed and no hash is known.** If the signer was contacted and the owner's Sequence advanced, the Host cannot tell, without the hash, whether its transaction or another one consumed it. It stays `signing-attempted` and unresolved. A signer-reported hash can be looked up by an operator through the existing transaction evidence. P11 still records `failed` for a signer failure (pre-existing TRADE-04C semantics, unchanged by D-1; refining it is D-5). *(Corrected by H-1, §20: P11 now records `unconfirmed` for every refusal after the issuance call; D-5, a durable P11 `detail`, is unchanged and still open.)*
- **The Host trusts its own process between `issue` and `markSigning`.** A capability issued but never marked exists only in memory. A compromised Host process is outside this boundary.
- The signer ledger's rollback exposure (§14) is unchanged in the signer, but D-1 changes its consequence; see §18.

### 17.10 Validation (D-1)

| Step | Result |
|---|---|
| D-1 suites (`trade04d-d1-intent`, `trade04d-d1-mutation`) | 19 / 19 and 20 / 20 |
| Targeted preservation: TRADE-04A/B/C/S1/04D, CORE-02, CORE-07 and freshness, P11/P12, PAY-0x, XRPL rail, PROD-02/03, backup/restore/portability (107 files) | **2049 / 2049** |
| Boundaries: shared transport, TRADE-02 rail, security invariants, NO_BYPASS, CORE-06 | 158 / 158 |
| Typecheck, lint, publishability | pass |
| Workspaces | 1103 / 1103 |
| Full root suite (final tree) | 12189 tests: **12175 pass, 1 fail**, 9 skipped, 4 todo. The one failure is the S1 separate-process scenario (`PROVIDER_UNAVAILABLE`), the load-dependent restart-quarantine fixture margin below; it passes alone |

Boundary pins held, not widened. The first full run failed the shared-transport and TRADE-02-rail importer pins. The fix keeps both boundaries: the Host composition builds the validated reader it hands P12, and the evidence module carries its own `AccountRoot` parser, pinned equal to TRADE-02's.

Two failure classes under full-suite load are environmental, with evidence:

- **`trade04c-s1-host` Scenario A through a separate signer process.** Its trace shows `trade-restart-quarantine` with zero signing requests: a TRADE-04C preflight refusal *before* any D-1 code. The fixture's fake ledger dates its close times from its own construction, and `passQuarantine()` leaves a 44 s margin to the executor's start. Under load, Host boot exceeds it; a run under 16 CPU burners reproduced it. It passes alone 3 / 3.
- **External-authority launcher.** `/posture` timeouts, the §16 class; 2 / 2 alone.

## 18. D-6 — Signer restart quarantine: assessment (not implemented)

**Question.** Does a ≥ 65 s refusal to sign after the reference signer starts (capability lifetime ≤ 60 s + 5 s skew) mitigate the signer-ledger rollback exposure (§14)?

**What it would cover.** After a restore of an older consumption-ledger copy *that requires a restart*, every capability consumed in the lost history has expired by the signer's clock before the signer serves. A replay is then refused as expired.

**Why it is not sufficient alone:**

1. **No restart needed.** An in-place rewrite of the SQLite file by another process with write access, or a swap the running process picks up, needs no restart. The quarantine never runs.
2. **Clock dependence.** Expiry is checked against the signer's wall clock, and the signer refuses only `issuedAt` more than 5 s in its future. If the signer's clock is behind real time by Δ > 5 s at or before the restart, a captured capability stays valid Δ − 5 s past the quarantine. A monotonic quarantine does not help, because expiry is wall-clock. A clock stepped *backward after* the start extends both equally, which is safe; a *forward* step shortens both equally, which is also safe. So D-6 holds only under the clock-accuracy assumption capability expiry already makes.
3. **Customer custody.** The quarantine is a property of the reference signer. A customer running a modified or different v2 signer may omit it, and the Host cannot verify or attest it. It is a reference-implementation hardening, not a Host guarantee.
4. **It protects the signer's single-use record, not the Host's accounting.**

**What D-1 changes.**

- A capability can be replayed only within its ≤ 60 s (+ skew) lifetime. That is far inside the transaction's window, since LLS is ≤ 200 ledgers past the reference.
- The capability names exactly the intent's preimage, so a replay can only produce a signature over the *same* transaction: same Sequence, so at most one inclusion.
- Every capability that ever left the Host belongs to an intent the Host has already recorded as `signing`. The Host never releases that window, and never answers P11/P12 "not completed", without the validated owner-Sequence proof past LLS. After that point the transaction can never be included.

So after D-1, a signer rollback can at most produce an extra signature of an already-accounted transaction. It can no longer produce an *unaccounted* one, and the Host-side consequence of the §14 exposure is closed.

**Recommendation.**

- D-6 is **not necessary** for the Host's correctness after D-1, and it is **not sufficient** for signer-ledger freshness (reasons 1–3).
- It remains a cheap hardening of the reference signer's single-use property, with an availability cost: 65 s unavailable on every start. It is offered as an operator decision, unchanged.
- Full freshness of the signer ledger still needs **D-3** (external anchoring in customer custody, a new trust boundary), as before.
- Neither D-6 nor D-3 is implemented.

**Operational rule, unchanged:** after restoring a signer ledger, keep the signer stopped for at least 65 s on an accurate clock before serving.

## 19. Final security review of D-1 (2026-10-15)

### 19.1 The issuance-to-marking interval: a gap was found and closed

CORE-02 capabilities are signed by the **external authority signer**. `createExternalAuthoritySigner` calls it over a network transport, with a per-attempt timeout and bounded retries of the availability family. The Host builds the capability's content; the signature is produced and returned across that boundary. The first D-1 version abandoned an `intended` intent in three places:

- the executor, on any issuance failure;
- the executor, on a capability that did not bind or a marker it could not record;
- P12, for any `intended` intent left by a crash.

That reasoning held only if no capability could exist without the Host having handed it to the signer, and that is false. The cases:

| Case | Can a valid capability exist outside the Host? | Before | Now |
|---|---|---|---|
| Request never attempted (crash after `recordIntent`) | no | abandoned | held until a ledger fact |
| Explicit refusal by the issuer's local checks (grant missing, revoked, out of terms) | no: refused before the authority signer is asked | abandoned | held (fail-closed; cost: the owner waits for LLS) |
| Authority-signer timeout or unavailability, outcome unknown | **yes**: the remote signer may have signed, possibly more than once on retry | abandoned | held |
| Issued, not yet exposed beyond the Host | yes, on the authority-signer channel | — | held |
| Issued, then a crash before `markSigning` | yes | P12 abandoned it | held |
| Issued, then CORE-07 failure during `markSigning` | yes | abandoned | held |
| Concurrent release and marking | — | compare-and-set | no release path exists; forged releases racing the marker never commit (tested) |
| A caller with the signer credential and an intercepted capability | yes | could sign **after** the window was released, competing with a new order on the same Sequence, while P12 had reported "not completed" | can sign only the intent's exact transaction; the window stays held; P12 never reports "not completed" unless the Sequence is proven unconsumed past LLS (tested end to end, §17.7) |

**Correction (smallest that proves the property).** Abandonment is removed entirely. No `abandonIntent`, no `abandoned` state, and the forward-only trigger admits `intended → signing | expired` and `signing → bound | expired`. An issuance marker was considered and rejected: it would need another anchored write per order, and it would still have to treat a timed-out issuance as possibly successful. The only extra cases it could release early are crashes between `recordIntent` and the marker, which the ledger releases within LLS anyway.

**The property, and why it holds.** Once an intent exists, its owner `Sequence` window is released only when no transaction with that `Sequence` and `LastLedgerSequence` can be included any more:

- the validated index reached `LastLedgerSequence` (the shared G4 rule); or
- a validated owner `Sequence` still unconsumed at or past it.

A capability that survives the release — it lives ≤ 60 s + 5 s skew, while LLS is ≤ 200 ledgers past the reference — can only sign the intent's exact preimage. The capability binds `signingPreimageDigest`, and so `Sequence`, `LastLedgerSequence` and Fee. Such a signature can never be included. One capability per execution and no repeat are unchanged: an execution with an intent is never issued, signed or sent again.

### 19.2 Release authority

- **Before.** `expireIntent(executionId, detail)` trusted its caller. The owner-Sequence requirement was a convention of the P12 caller.
- **Now.** `expireIntent(executionId, proof)` refuses unless `proof` is an object `readTradeSequenceEvidence` itself produced, branded in a module-private `WeakSet`. It must also be for exactly the intent's owner, `Sequence` and `LastLedgerSequence`, at a validated ledger at or past LLS, with the `Sequence` unconsumed. The release records the proof's ledger index and hash in the transition detail.
- **Refused (tested):**
  - a bare execution id;
  - a plain object asserting finality;
  - a genuine proof for another `Sequence` or another owner;
  - an unknown execution;
  - forged releases racing a signing marker from a second connection.
- **Structurally pinned:**
  - nothing in the edge mentions abandonment;
  - only `trade-resolution-authority.ts` calls `expireIntent`, and only with `readTradeSequenceEvidence`'s result;
  - the executor cannot release.
- **Mutants:** `release-without-a-qualified-proof` and `proof-for-another-owner-accepted` are detected.
- **No operator override exists.**
- **Residual.** The validated reader handed to P12 (built by the Host composition from the shared transport) is trusted for what an XRPL server validated (SEC-INV-328). The brand proves the answer went through the qualified reading, not that the server was honest. `blocking`, `recordIntent` and `reserve` still take the caller's validated index, as before D-1. The executor derives it from the shared validated reader.

### 19.3 Assessment and P12 after the correction

- **Assessment.** `intended` → `capability-not-consumed`, **pending**, signature `not-sent-by-host`, uncertainty `capability-issuance-unknown`. It is never *proven* on the Host's record.
- **P12.** Resolves `intended` and `signing` alike, on the proof only.
- **Signer report.** A signer consumption reported for an `intended` intent stays `inconsistent-evidence`. Here it is the signal of a capability used outside the Host.

### 19.4 The S1 separate-process test: fixture timing, corrected

- **Cause.** `FakeXrplLedger` dates its close times from its own construction (4 s per ledger). `passQuarantine()` advanced a fixed 260 ledgers, so the ledger 204 back closed 224 s after construction. The executor's real restart quarantine requires that ledger to close more than 180 s after the *executor* started. A Host that booted more than ~44 s after the fake was built therefore stayed quarantined (`trade-restart-quarantine`, zero signing requests).
- **Correction (fixture only).** `passQuarantine()` still validates at least 260 ledgers, then keeps validating ledgers (4 s apart, close times never rebased) until the ledger 204 back closes after *now* + 180 s. The executor started before the call, so that bounds its anchor. The restart quarantine, LastLedgerSequence limits, clock reliance, CORE-07 and every production timeout are unchanged.
- **Evidence:**
  - `trade04d-fixture-quarantine.test.ts`, with a mocked clock, failed for 50 / 120 / 600 s boot delays before the correction (3 / 7 fail) and passes after (7 / 7). It also pins that a too-short ledger history is still quarantined, and that close times are never rebased.
  - The real S1 separate-process test with a 50 s boot delay injected: fails before (`trade-restart-quarantine`), passes after.
  - Unmodified, under the 16-CPU-burner load that first reproduced it: 3 / 3 pass, durations 60 s, 77 s and 130 s (the original failure was at 92 s).

### 19.5 Final validation (after `9a1cdea`, `2656dfa`)

Logs were kept outside the repository; every exit code is as recorded.

| Step | Exit | Result |
|---|---|---|
| build / typecheck / lint | 0 / 0 / 0 | pass |
| Focused (118 files: TRADE-04A–04D incl. D-1 and fixture, CORE-02, CORE-07 and freshness, P11/P12, PAY-0x, XRPL rail and transport, NO_BYPASS, security invariants, CORE-06, PROD-02/03, backup/restore/portability) | 0 | **2263 / 2263** |
| Full root suite (in tree) | 0 | **12198 tests: 12185 pass, 0 fail**, 9 skipped, 4 todo |
| Workspaces | 0 | 1103 / 1103 |
| Release coherence, release integrity, portability smoke | 0 / 0 / 0 | pass |
| Publishability, clean-room consumer | 0 / 0 | pass |
| Protocol-tarball validation (isolated install) | **1** | every step PASS except `test`. Run 1: 12198 tests, 12183 pass, **1 fail** (not named: the script keeps only the output tail). Run 2, instrumented to keep full output: 12182 pass, **2 fail** |

The two failures in the instrumented tarball run:

- `trade04d-d1-mutation` `release-without-a-qualified-proof`: `AUTHORITY_FRESHNESS_UNAVAILABLE`, "witness did not answer within 2000 ms", during the guard's setup on the *shipped* module, before any mutation applied. This is the CORE-07 witness-timeout class seen in every earlier full run.
- `prod02-disaster-recovery-host`: HTTP 503 on a CORE-05 approval command, in a Host that composes no trade executor.

Both files pass alone, 22 / 22 twice. **The root suite is not represented as fully passing in the isolated tarball install:** under that install's load, CORE-07 witness timeouts remain.

Mutation (D-1): 20 mutants, 16 detected, 4 contained. TRADE-04C, S1 and 04D mutation suites: all pass within the focused run.

## 20. H-1 — Post-intent outcome certainty (authorized 2026-10-20)

> Addendum, from the TRADE-04D integration readiness review. §§0–19 are not rewritten.

### 20.1 The finding

After `recordIntent`, the executor reported every refusal through one catch as a terminal `failed`. That covered:

- capability issuance unavailable or timed out;
- a capability that did not bind;
- a signing marker that could not be recorded;
- a delegated signer that was unreachable, refused, or answered out of protocol;
- a signature that failed the independent check;
- a reservation that failed after a verified signature.

`failed` is P11's terminal observation. It releases the P7 capacity, and P12 is never consulted for it. Yet in every one of those cases a valid capability, and possibly a signature, could exist outside the Host until the ledger passes `LastLedgerSequence`. That is the premise of §19: issuance is external, and a signer's refusal is its word. A crash at the same point already took the honest path (`ALREADY_ATTEMPTED` → P12). Only the non-crash path claimed certainty.

The recovery assessment would also have marked such a record `p11-outcome-contradicts-ledger` had the transaction been included out of band.

### 20.2 The correction (smallest that proves the property)

The change is local to `trade-offer-executor.ts`:

- **A flag.** `capabilityMayExist` is raised immediately before the issuance call. It is lowered only when the issuer refused with one of `CAPABILITY_NEVER_REQUESTED`: `CAPABILITY_ISSUER_UNBOUND`, `…_UNSUPPORTED`, `…_REQUEST_INVALID`, `…_GRANT_UNAVAILABLE`, `…_GRANT_NOT_FOUND`, `…_GRANT_REVOKED` or `…_REFUSED`. These are the refusals `delegated-offer-capability-issuer.ts` makes **before** `sign.call`, plus the unbound slot. A structural test pins the set against the issuer's source.
- **The outer catch.** While the flag is raised, it answers `unconfirmed` with the refusing step's `detail` and **no** `providerRef`. P11 reconciliation therefore stays bound to the intent rather than to a hash the Host never recorded: a P11 reference without a trade record is `p11-reference-without-trade-record`.
- **What does not change.** No new detail, outcome type, state, store, route, retry, re-signing or re-issuance. The intent and idempotency invariants, P11/P12, the TRADE-04C-S1 capability and signer protocol, and every refusal before the issuance call (`failed`, as before) are untouched.

| Path | Before | After |
|---|---|---|
| Any refusal before the issuance call (binding, preflight, `recordIntent` failed or blocked) | `failed` | `failed` |
| Issuer refusal before its signing call (`CAPABILITY_NEVER_REQUESTED`) | `failed` | `failed` (non-issuance proven) |
| `CAPABILITY_SIGNING_UNAVAILABLE`, `CAPABILITY_SIGNATURE_INVALID`, or an unrecognized issuer error | `failed` | `unconfirmed` |
| A capability that does not bind | `failed` | `unconfirmed` |
| `markSigning` failed (capability issued) | `failed` | `unconfirmed` |
| Signer unreachable, refused, out of protocol, or busy / not verified | `failed` | `unconfirmed` |
| Signature fails the independent check | `failed` | `unconfirmed` |
| Reservation failed or blocked after a verified signature | `failed` | `unconfirmed` |
| From the claim on (§1, TRADE-04C) | `unconfirmed` / ledger | unchanged |

A signer refusal made by the client before sending is also `unconfirmed`: the capability already exists. The certainty boundary is the capability's possible existence, not whether the Host sent it. A narrower rule would rest on the same trust in the authority-signer channel that §19.1 declined to assume.

### 20.3 Consequences callers can see

1. The governed result is `execution_unconfirmed` (HTTP 409) instead of `execution_failed` (502) for the paths above.
2. P7 capacity is **settled**, not released, until P12 resolves the execution.
3. Closing such an execution needs an explicit P12 `reconcile` once the validated ledger passes `LastLedgerSequence`. The trade authority then answers `confirmed-not-completed` on the owner-Sequence proof (§17.6), or stays unresolved if the `Sequence` was consumed.
4. A replay of the request is answered from P11 and never reaches the executor.

### 20.4 Tests

- **`trade04d-h1-post-intent-outcome.test.ts`**
  - The seven pre-issuance refusals stay `failed`, with nothing issued, signed or sent, and the window held.
  - Nine post-issuance paths are `unconfirmed`, with no `providerRef`, nothing sent, the window held, and a repeat adding no capability, signature or submission.
  - P12 is unresolved before `LastLedgerSequence` and `confirmed-not-completed` after it.
  - A consumed `Sequence` stays unresolved.
  - After a restart, there is no replacement capability, and P12 closes the `intended` intent.
  - On the shipped Host: `execution_unconfirmed`, the P7 reservation is `settled` / `execution-unconfirmed`, and a replay does not call the executor.
  - Structure: the classification is pinned against the issuer's source, every issuer failure is classified, and the flag order is pinned.
- **`trade04d-h1-mutation.test.ts`**: five mutants, each expected *detected*:
  - the uncertain refusal reported as `failed`;
  - the flag never raised;
  - an issuance timeout treated as proven non-issuance;
  - a proven refusal reported as uncertain;
  - the flag raised before the intent.
- **Updated to the corrected semantics** (outcome assertions only; no security assertion weakened):
  - `trade04c-executor.test.ts`: signature rejected, signer unavailable, client-side horizon refusal, reservation failed;
  - `trade04c-s1-capability.test.ts`: the issuance table gains an expected outcome per row, and the crossing capability is `unconfirmed`;
  - `trade04d-d1-intent.test.ts`: issuance timeout;
  - `trade04d-recovery-scenarios.test.ts`: Scenario D, signer died after consumption.

### 20.5 L-2 — read-only inspection

`inspectReferenceCapabilityLedger` now opens `readonly: true` (SQLITE_OPEN_READONLY), and is query-only besides. Before, it opened a writable connection that was only asked not to write. On the customer's signer host, inspection can now neither write, checkpoint nor recover the ledger it reads.

This is pinned structurally in `trade04d-recovery-structure.test.ts` and recorded in SEC-INV-330. **To confirm when the suites run:** a read-only WAL connection must still read a ledger whose `-wal`/`-shm` files are absent, after the signer stopped. `trade04d-signer-recovery.test.ts` and Scenario D inspect exactly that state.

### 20.6 Validation status

**Not executed.** The change and its tests were written on 2026-10-20 in the `Frontera-trade-04d` worktree on `/mnt/c` (Windows host, WSL2). The founder's direction is that project code is not run in that environment without an isolated workspace, and none had been provisioned. Nothing here is a test result.

Required before merge, in an isolated workspace, on a clean LF export:

- `npm ci`, typecheck, build, lint;
- the two H-1 suites;
- the four updated suites;
- TRADE-04A/B/C/S1/04D and their mutation suites;
- CORE-02, CORE-07, P11/P12, PAY-0x, NO_BYPASS / security invariants / CORE-06, PROD-02/03, and backup/restore;
- the full root suite, workspaces, release coherence, publishability and the clean-room consumer.

Each must be recorded with its exact command, counts, failures and SHA.

## 21. Upgrade, backup and downgrade — the forward-only interlock schema (accepted 2026-10-20)

**Decision (founder).** Interlock schema v2 is accepted as a forward-only migration. The conditions are that backups and downgrade limits are explicit. This section states them; SEC-INV-333 carries the residual.

- **Migration is irreversible.** The first TRADE-04D Host that opens a v1 interlock for execution migrates it in place (§17.5). No tool migrates back. A pre-TRADE-04D runtime refuses a v2 file at open ("a schema version this runtime does not implement"), unmutated.
- **Back up before upgrading.** Take and verify the PROD-02 backup (`OPERATIONS_RUNBOOK.md` §5) with the current release, which still holds the v1 file. Drain trading first: no reservation `reserved`, `submitting` or `unconfirmed`. Record `/version`. That backup is the only way back.
- **No supported binary downgrade after the first v2 intent.** The migration leaves the witnessed head unchanged, so the v1 backup and the old release remain usable **only until the upgraded Host records its first intent**. Every intent, signing marker, reservation and claim advances the CORE-07 history. After that, a restored v1 backup is behind the witness and is refused (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`, §17.4). Rolling back then means losing every trade record since the backup, and that is refused by design.
- **Never.** Never reset, rescope or re-enroll the witness to make an older interlock open. It would reopen Sequences whose transactions may still be included.
- **Operations.** This section is the operator reference. The pilot runbook (`docs/pilot/OPERATIONS_RUNBOOK.md`) stays rail-neutral: governed trading is outside the pilot scope, and the PROD-03-04 documentation guard forbids naming a rail there.
