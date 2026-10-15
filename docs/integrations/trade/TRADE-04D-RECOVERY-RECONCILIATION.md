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
| D-1 | A durable **pre-signing intent** on the Host (owner, Sequence, LLS, preimage digest, capability id) anchored in CORE-07 before the signer call. It would close H.1–H.3 on the Host side: the Sequence stays blocked and the window is known | interlock schema v2 + new anchored event kind (incompatible migration) |
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

1. **Pre-reservation signatures (H.1–H.3).** After a signer failure, crash or lost response, or after a failed reservation, the Host holds no Sequence, LLS or capability id. Inclusion of a lost blob is provable only with the signer's hash. Non-inclusion is not provable, and the owner Sequence is not held by the interlock. Frontera provably never sent such a blob; a party holding it could. The fix is gate **D-1** (a durable pre-signing intent).
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
5. Decisions on D-1 (pre-signing intent) and D-6 (signer restart quarantine) before any production claim.
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
