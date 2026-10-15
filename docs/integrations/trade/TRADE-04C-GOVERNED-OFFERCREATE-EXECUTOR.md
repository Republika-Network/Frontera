# TRADE-04C — Governed XRPL OfferCreate Executor, Protected Submission, Durable Sequence Authority & Secure Host Composition

- **Milestone:** TRADE-04C — Governed OfferCreate Executor (Frontera Governed Trading — XRPL / XLS-75 Design Partner Edition)
- **Branch:** `feat/trade-04c-governed-offercreate-executor` (local commits only; not pushed, no PR)
- **Status:** IMPLEMENTED — offline, fake-ledger qualified. **Verdict: CONDITIONAL** (§35).
- **Approval gates:** G2 and G4 narrowly authorized by the user for this milestone and implemented within that scope; G1 not authorized and untouched; G3 (TRADE-04B) preserved, not broadened.

> Frontera never mistakes permission to sign an XRPL transaction for authorization to execute a
> particular trade. Only the exact OfferCreate bound to a valid grant may traverse the controlled
> signer and submission path — and then only once.

## 1. Baseline SHA and merged dependencies

| Item | Value |
|---|---|
| Baseline | `main @ d9339a5d11ad61ccd9cb7f7dbd3ed5bf0513990d` (PR #189, TRADE-04B merged) — verified an ancestor of the branch, working tree clean, `origin/main` had no newer commit |
| Merged dependencies | TRADE-00 … TRADE-02 (PR #184), TRADE-03 with K1/K2 (PR #186), TRADE-04A shared transport (PR #187), TRADE-04B protected signer (PR #189); PAY-02 … PAY-09; CORE-02, CORE-04, CORE-05, CORE-07, P7 … P12, ASSURE-01 |
| Concurrent changes | none on `main` after the baseline touching Host, Payment, CORE-07, XRPL or the execution runtime; no other TRADE-04C branch or PR |
| NO_BYPASS at baseline | eleven of seventy-three effect paths under bounded-grant control (EP-069, EP-071, EP-072 the provider effects; EP-073 deployment-gated and composed by nothing) |
| Durable stores at baseline | fifteen in `scripts/portability/store-registry.mjs`; CORE-07 slots: the three authority stores plus `xrpl-submission-reservations`, `payment-business-operation-state`, `payment-refund-state`, `payment-initiation-reservations` (namespaced) |

## 2. Executive summary

TRADE-04C makes the governed trade path executable end to end, offline:

```
customer trading engine
 → authenticated customer admission → TRADE-03 admitProposal (the edge compiles the intent itself)
 → POST /api/governed-actions → envelope (P9, CORE-03) → Kernel, with TRADE-03's CORE-04 provider (fresh trusted reads, risk assessment)
 → deterministic policy → CORE-05 approvals → emergency control → P10 ceiling → bounded grant → P7 → P11 write-ahead claim
 → TRADE-04C executor  (grant binding → validated delegation, key and owner-Sequence re-reads → closed OfferCreate)
 → TRADE-04B signer (EP-073) → independent signature checks → durable, CORE-07-anchored reservation
 → submitReserved: the submit site's durable single-use claim → THE one XRPL submit request (EP-069's, now EP-074 for trade)
 → validated finality reads → P11 outcome (completed = the transaction applied; never "filled") → P12 for uncertainty
```

What is new: an execution adapter (`src/enterprise/xrpl-trade-execution/trade-offer-executor.ts`), a durable
trade owner-Sequence interlock with its own CORE-07 slot, a read-only P12 trade resolution authority, a
trade evidence projection, Host configuration (`xrplTradeExecution`) and Host composition, a
reservation-gated submission client in the XRPL SDK client file (G2), a transaction-neutral restart
quarantine in the shared transport, delegate signing-key authority from validated AccountRoots, and a
digest-keyed attestation lookup on the TRADE-03 edge. Every capability that can sign or send is built in
exactly one place and has exactly one caller.

What it is not: not live. Every ledger fact in qualification came from a deterministic, labelled fake ledger
(`FakeXrplLedger`); nothing was funded, nothing was submitted to any XRPL network, and evidence records say
`ledgerProvenance: 'injected-ledger-client'`. Live Testnet qualification is TRADE-05.

## 3. Architecture and trust boundaries

| Boundary | Trusts | Distrusts |
|---|---|---|
| Customer trading engine → TRADE-03 edge | nothing; the edge compiles the intent for the authenticated identity | every fact the engine might state (prices, exposure, delegation) |
| Governed path → executor | the `ValidatedExecutionAction` (proven inside the grant by `GrantExecutionService`) | nothing else: the executor re-derives every term |
| Executor → TRADE-03 attestation | integrity by digest: the grant's `tradeProposalDigest` names one canonical proposal | the attested record's content — it is re-validated, re-hashed and recompiled |
| Executor → XRPL server | availability; validated answers proven by the shared reader (network id, validation, regression, hash conflict) | unvalidated, stale, regressed, conflicting, oversized or malformed answers |
| Executor → delegate signer (EP-073) | availability only | every answer: correlation, pinned identity, canonical blob, field set, signing bytes, pinned key, signature, hash — and then again the executor's own comparison |
| Submit site → trade interlock | the durable claim | the caller: the claim is derived from the blob itself |
| Trade interlock → CORE-07 witness | monotonic history outside the restore domain | the local file's freshness |

## 4. Exact execution call graph

```
bootEnterpriseHost
  loadEnterpriseHostConfiguration → parseXrplTradeExecutionSection            (closed section; pins; credential by env name)
  assertProcessHoldsNoXrplKey                                                   (+ FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_*, owner/delegate key names)
  assertXrplDomainsDisjoint → assertXrplSequenceOwnership([payment, trade])     (before any interlock or signer)
  composeXrplPaymentRail                                                         (unchanged, when configured)
  composeXrplTradeExecution
    createSqliteTradeSequenceInterlock(scope {domain, network}, sequenceAccounts, freshness)   (genesis/establish at CORE-07)
    createDelegatedOfferSigner(createHttpDelegatedOfferSignerTransport) → probe             (MISMATCH → refuse)
    createXrplReservedSubmissionClient(configuration, interlock) ×2 (executor, read-only resolver)
    createTradeOfferExecutionAdapter → readiness                                             (network mismatch → refuse)
    createTradeResolutionAuthority(readOnlyTradeLedger)
  createEnterpriseServer(…adapters += trade.adapter, modules, P12 authorities += trade.authority)

POST /api/governed-actions → GovernedActionOrchestrator → … → GrantExecutionService → ExecutionAdapterRegistry (route: trade action only)
  TradeOfferExecutionAdapter.execute(action)
    bind(action, attested.attestedProposal(digest))                                           → NOT_BOUND / PROPOSAL_UNATTESTED
    simulated-source attestation without the in-code acknowledgement                          → SIMULATED_FACTS
    configured pair / network                                                                 → PAIR_NOT_CONFIGURED
    serialized(owner):
      interlock.recorded(executionId)                                                         → PREVIOUSLY_RECORDED (unconfirmed, hash)
      preflight: reader.validatedLedger → quarantine → TRADE-02 verifier.verify(pins ≥ V)
                 → reader.ledgerEntry(account_root delegate) → assessXrplDelegateSigningKey
                 → reader.ledgerEntry(account_root owner) → readXrplOwnerSequence
                 → span check [V, V+span] → Expiration vs close_time(V) → grant notAfter
                 → buildOffer → interlock.blocking (witness probed)
      signer.signDelegatedOffer → independent equality checks                                 → SIGNER_* / SIGNATURE_REJECTED
      interlock.reserve (CORE-07 transition)                                                  → RESERVATION_FAILED / SEQUENCE_IN_FLIGHT
      ledger.submitReserved(executionId, blob)
          xrplSubmissionClaimOf(blob) → interlock.claimSubmission (CORE-07 transition) → requestSubmit (the one `submit`)
      readXrplSubmission → tem… settle malformed | provisional → awaitFinality (validated tx reads)
      interlock.settle / markUnconfirmed
```

## 5. Grant-to-transaction binding

The adapter receives no proposal and no blob. It receives the validated action — action, resource,
organization, subject, amount, the seven trade parameters, `notAfter`, correlation — and:

1. requires exactly the seven trade dimensions, each a `token`, none duplicated, none extra;
2. takes `tradeProposalDigest` and looks up what TRADE-03's edge **attested** under that digest — the exact
   canonical proposal whose readings it returned to the Kernel for a reliable SATISFIED assessment and an
   AUTHORIZED delegation, with the identity it was admitted for (`TradeAttestedProposalSource`; bounded:
   ≤ 3600 s, ≤ 4096 records, oldest forgotten first — forgetting only makes an execution fail closed);
3. re-validates that proposal (`validateTradeProposal`) and requires its recomputed digest to equal the
   granted digest — a price, quantity, flag, expiration or account changed after the grant has another
   digest and so another grant;
4. recompiles it for the attested identity (`compileTradeProposal`) and requires action, resource, the
   amount (exact decimal equality, no floating point) and all seven parameters to equal the action's, and
   the action's organization and subject to equal the attested organization and Kernel actor;
5. builds the closed TRADE-04B `PreparedDelegatedOffer` **only** from that proposal: `Account` = owner,
   `Delegate` = delegate, `TakerGets` = what the owner gives, `TakerPays` = what it receives (canonical drops
   and issued values, 40-hex currency codes preserved), `Flags` = TRADE-01's flag sum, optional
   `Expiration`; `Sequence`, `Fee` and `LastLedgerSequence` come from §9, never from a caller.

Substitution of every dimension is tested independently (`trade04c-executor.test.ts` A), and the submitted
blob's every field is asserted against the proposal (A2). The executor additionally refuses any signature
whose returned `transaction`, owner, delegate, key or status differs from what it asked for, before the
reservation (C).

## 6. CORE-04 and TRADE-03 reliance

Reused unchanged: TRADE-03's admission, its CORE-04 provider (fresh trusted reads, `assessTradingRisk`,
readings only for SATISFIED + AUTHORIZED), the trading-risk policy rules, and CORE-05 approvals. The one
addition to the edge is the read-only `attested` lookup (§5.2) — recorded only when readings were returned.
A profile admitting simulated sources is executable only with `TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT`
passed **in code** (qualification only; never configuration). TRADE-03's advisory aggregate exposure,
active-order snapshots and one-pending-binding-per-(actor, owner) limit are unchanged and remain limitations
(§29).

**Finding F-1 — found by TRADE-04C, corrected under explicit authorization.** TRADE-03's edge assessed
every source fact at the Kernel's evaluation instant (`query.at`, captured before the provider is asked),
so a real TRADE-02 verifier — or any source honestly stamping its read time — was refused as from the
future (`DELEGATION_RELIANCE_FROM_FUTURE`, `REFERENCE_FROM_FUTURE`): 22–27 of 40 trials at any latency,
~100 % on the shipped Host. The first TRADE-04C Host fixture compensated with a 5 s clock lag on the
governance-side verifier (and TRADE-03's harness with 1–2 s back-dated sources); that workaround was never
qualified behavior and has been **removed**. The correction (TRADE-03 §38): the edge reads the trusted Host
clock once after every source answered — the reliance instant — requires `at ≤ relianceAt < binding
expiry`, and assesses every fact against it with zero future tolerance; CORE-04 readings stay stated at
`at` with unchanged absolute ends. With honest, real-time sources the shipped-Host Scenarios A–F pass, and
Scenario A executed 100 of 100 times under concurrent load with exactly one signature and one send each.

## 7. XLS-75 delegation and key preflight

Immediately before signing, from validated ledgers only (TRADE-04A reader; TRADE-02 verifier — no second
interpretation):

1. `server_info`: the configured network id and a validated ledger at most `maxValidatedLedgerAgeSeconds`
   old → reference `V` (index and hash);
2. TRADE-02 `verify` with pin `minimumValidatedLedgerIndex = V`: `AUTHORIZED` with `OfferCreate` granted and
   nothing outside the trading scope, for exactly this owner, delegate and network;
3. the **delegate's** `AccountRoot`: the pinned delegate key is the master key with `lsfDisableMaster`
   clear, or the account's `RegularKey` (`assessXrplDelegateSigningKey`; account id = RIPEMD160(SHA256(key))
   derived with `node:crypto`, cross-checked against the SDK for 44 keys of both algorithms);
4. the **owner's** `AccountRoot`: its `Sequence`;
5. every observation's ledger index within `[V, V + observationSpanLedgers]` (default 2).

Refused, with nothing signed: no delegation, revoked, another transaction type only, permissions beyond the
trading scope, another delegate, disabled master, foreign regular key, absent delegate root, another network,
unvalidated, stale (behind `V`), conflicting hash, unreachable, too old, malformed `Sequence`, spread beyond
the span (17 cases, `trade04c-executor.test.ts` B). TOCTOU is bounded, not eliminated: the ledger can change
after the last read; the window is the span plus the `LastLedgerSequence` horizon, recorded in evidence.

## 8. Network identity

The trade network is a TRADE-01 network (XRPL Testnet id 1, Devnet id 2); mainnet is not representable in the
section, the executor, the reserved submission configuration (`isPermittedXrplNetworkId(id, false)`), the
interlock scope (`networkId ≥ 1`) or the Host's ownership check. Every validated read re-proves the network;
a network mismatch at boot refuses composition. As TRADE-04B §11 records, for Testnet/Devnet the signed
blob carries no `NetworkID`: network binding is configuration plus the owner's per-network `Sequence` and
the short `LastLedgerSequence` window, not cryptography.

## 9. Fee, Sequence, expiration and ledger horizon

| Field | Source | Bound |
|---|---|---|
| `Sequence` | the owner's validated `AccountRoot` | blocking rule (§13); never the delegate's |
| `Fee` | configuration `feeDrops` | ≤ `maximumFeeDrops` ≤ 1 XRP; also the signer client's and the signer's own ceilings; never autofilled, never escalated |
| `LastLedgerSequence` | `V + lastLedgerOffset` | 2 … 200 (the shared historical bound every XRPL restart quarantine assumes, equal to PAY-03's), and within the signer client's horizon |
| `Expiration` | the attested proposal | must be after `close_time(V)` |
| execution horizon | the grant's `notAfter` | nothing is signed at or after it |

No SDK autofill is used, so no field outside TRADE-04B's closed set can appear (asserted on every submitted
blob). Delegated fee model: the delegate signs and pays the fee; the owner's `Sequence` is consumed (TRADE-00
§5). A fixed fee may be too low under network load (`terINSUF_FEE_B`/queueing); the executor never raises it
— such an order expires and is reconciled as not included.

## 10. Signer composition

TRADE-04B's `createDelegatedOfferSigner` over `createHttpDelegatedOfferSignerTransport`, pinned (signer id,
network, the configured pairs and delegate keys), with the executor's fee ceiling and `lastLedgerOffset` as
its horizon, is constructed **only** in `composeXrplTradeExecution` and handed **only** to the executor
(`trade04c-governed-executor-structure.test.ts`; NO_BYPASS test). There is no route, no Host module method
and no export that reaches it. The executor passes the exact prepared offer, the validated index `V`, and the
audit references `{ executionId, grantRef: boundedGrantId, grantDigest }` — where `grantDigest` is a
**correlation digest** over the execution's identifiers, *not* an authenticated grant proof (the signer
verifies nothing about it). A returned signature is `signed-not-submitted`: not settlement, not validation,
not policy compliance. No signer retry after any failure. A signer that contradicts its pin is MISMATCH for
the Host's life (Scenario E).

## 11. G2 — submission capability design

Implemented exactly as the narrow authorization requires:

- **One request site.** `src/features/payment-runtime/rails/xrpl/xrpl-sdk-client.ts` still writes
  `command: 'submit'` once, now inside the module-private `openXrplSdkConnection` (`requestSubmit`, not
  exported). It is reached from exactly two places: PAY-02's `submit` (unchanged in meaning: not-connected
  check, one request, `NotConnectedError` → not attempted) and `submitReserved`.
- **No generic write.** `createXrplReservedSubmissionClient(configuration, authority)` exposes reads
  (`server_info`, validated `ledger`, closed `ledger_entry`, `tx`) and one write, `submitReserved(executionId,
  blob)`. There is no `submit(blob)`, no autofill, no signer. The authority is bound at construction by
  trusted Host composition — the trade interlock.
- **Reservation required, at the site.** `submitReserved` refuses when not connected (nothing claimed);
  derives the claim from the blob itself (`xrplSubmissionClaimOf`: its own hash, type, `Account`, `Sequence`,
  `LastLedgerSequence`, plus the client's network and the execution id); requires the authority's durable,
  CORE-07-anchored, single-use `claimSubmission` (reserved → submitting, every field equal to the
  reservation) — refusal sends nothing; then makes the one request. A second call for the same execution,
  from any process or after a restart, is refused before anything is sent.
- **Transaction-neutral.** The client names no OfferCreate (the rail directory still may not); the
  authority decides which type its reservations carry (`OfferCreate` only, by schema `CHECK`).
- **Mainnet unavailable**; configuration branded and validated (`wss://`, no credentials/query/fragment).
- **Payment unchanged**: same surface, same submit semantics, same tests (§30).

The socket path of `submitReserved` is qualified structurally (the claim strictly before the one request;
`trade04c-reserved-submission.test.ts`, mutation G2) and by the fake ledger's double, which uses the same
`xrplSubmissionClaimOf` and the real interlock claim. A real XRPL server is TRADE-05.

## 12. G4 — Host composition

`xrplTradeExecution` (governed-action file, closed): `tradeAction`, `network`, `endpoint`, `pairs` (owner,
delegate, delegate signing key), `signer` (endpoint, signer id, bearer credential **by environment variable
name**, timeout), `delegation` (TRADE-02 policy), `feeDrops`, `maximumFeeDrops`, `lastLedgerOffset`,
`observationSpanLedgers`, `maxValidatedLedgerAgeSeconds`, `requestTimeoutMs`, `finalityTimeoutMs`,
`pollIntervalMs`. Validated at load: the action routed exclusively to `xrpl-trade-offer-executor`, listed in
`monetary.financialActions` (P7), the seven trade parameter dimensions declared, distinct from the Payment
action, no adapter id reuse, one delegate per owner, credential resolvable and well-formed. Composition
requires `sqlite` persistence and the external CORE-07 witness (every profile). Boot options (in code only):
`xrplTradeExecution.attested` (required — the embedder's TRADE-03 edge), `ledgerClient` (qualification),
`simulation`, `onTrace`. Without `attested` the Host refuses (`XRPL_TRADE_ATTESTATION_SOURCE_MISSING`).

## 13. Trade-specific durable interlock

`src/enterprise/xrpl-trade-execution/sqlite-trade-sequence-interlock.ts` — its own SQLite file
(`AOC_ENTERPRISE_XRPL_TRADE_INTERLOCK_SQLITE_PATH`, default `.data/xrpl-trade-sequence-interlock.sqlite`),
schema `aoc.trade-sequence-interlock.schema.v1`, built on PAY-03's patterns with nothing removed:

- WAL, `synchronous = FULL`, `BEGIN IMMEDIATE` decisions; version guard before `CREATE`; scope (domain id,
  network id) immutable by trigger;
- one immutable row per execution: owner, `Sequence`, `LastLedgerSequence`, `minLedger`, hash, closed
  evidence (§26), `OfferCreate` by `CHECK`; identity and state digests;
- lifecycle `reserved → submitting → unconfirmed → settled` (or `submitting → settled`, or
  `reserved → settled` on a ledger fact), forward-only by trigger, mirrored by an append-only transition log
  with a closed `detail`;
- **open = every state but settled**; the shared blocking rule (`xrplSequenceWindowBlocks`) over every
  record whose window is still open, verified before belief; releases are ledger facts only — **there is no
  `not-submitted` release** (a signed blob exists outside the process, at the signer);
- reserving refuses an owner outside the configured sequence accounts and a reference index that does not
  match `minLedger`;
- nothing is ever deleted; every read re-verifies digests, the log and completeness; any mismatch is
  `TRADE_INTERLOCK_CORRUPT`, never repaired;
- cross-process: two connections on one file and one witness never both reserve a competing `Sequence`
  (the witness's compare-and-advance decides).

## 14. CORE-07 witness and freshness

New slot kind `trade-sequence-reservations` in `AUTHORITY_STATE_KINDS` (rail-neutral name, so CORE carries
no XRPL vocabulary; single per organization). The anchored history is a hash chain over **reservations and
submission claims** (`trade_anchored_events`, `UNIQUE (kind, execution_id)`). Every reserve and every claim
is one CORE-07 transition (prepare → local `BEGIN IMMEDIATE` commit → finalize). Characterized
(`trade04c-trade-interlock.test.ts`):

| Situation | Behavior |
|---|---|
| initial enrollment | genesis enrolled at the witness before the local anchor commits |
| startup reconciliation | history established before the store is handed to anything |
| witness unavailable | open refused; `blocking` (before every signature) and `reserve` refused |
| stale restore / rollback (lost reservation) | `ROLLBACK_DETECTED` at open |
| lost submission claim (restore between reserve and claim) | `ROLLBACK_DETECTED` — claims are anchored |
| crash before local commit (witness prepared) | nothing reserved; next open `PENDING_RECOVERY` (refused, never guessed) |
| crash after commit, before finalize | next open reconciles and keeps the record |
| unsupported schema version / other scope | refused unmutated |
| existing store with records but no anchor | never anchored after the fact |
| tampered identity, state, evidence, deleted row or event | `TRADE_INTERLOCK_CORRUPT` (verification mode) |
| opened for execution without the witness | refused |

A trusted-source change (another witness, key or organization) is CORE-07's own pinning; unchanged.

## 15. Payment/Trade account isolation

`assertXrplDomainsDisjoint` in `enterprise-host.ts` runs `assertXrplSequenceOwnership` over every configured
XRPL submission domain — Payment: `rail.sourceAccounts[].address`; Trade: `pairs[].ownerAccount` (never the
delegates) — from configuration, **before** the Payment interlock, the trade interlock or any signer is
touched. Same owner, same network: refused (`HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID`; Host test proves the
trade interlock file was never created). Same account on different networks: allowed (separate `Sequence`
spaces, separate domains). Distinct owners: allowed. Duplicate trade owner: refused at parse. Empty /
malformed: refused. Configuration is read once and frozen; a change applies only at the next boot, which
re-runs the check. Across a configuration change that *moves* an account between domains, the restart
quarantines of both domains (≥ 204 validated ledgers and close-time proof after start, both bounded by the
same historical offset 200) prove every earlier transaction's window closed before the new domain signs;
the trade interlock also refuses to reserve for an account no longer configured. G1 remains unimplemented.

## 16. P11 write-ahead claim

Unchanged: the governed path records the P11 claim before invoking the adapter; the executor never claims,
re-claims or retries. The P11 execution id is the interlock key; one record per execution, ever.

## 17. P12 uncertain outcome handling

| Outcome | Adapter result | Interlock |
|---|---|---|
| denied, approval-required, risk-withheld, emergency stop | never reaches the executor | — |
| not bound / unattested / simulated / pair | `failed ADAPTER_ERROR` | none |
| delegation, key, ledger, Sequence, quarantine, expiration, blocked | `failed` (closed detail) | none |
| signer unavailable / refused / signature rejected | `failed` | none |
| reservation failed | `failed ADAPTER_ERROR` | none |
| signed, not sent (no connection at the submit site) | `unconfirmed trade-signed-not-submitted` | `reserved` (open) |
| sent, outcome unknown / unreadable / error after send | `unconfirmed` | `unconfirmed` |
| `tem…` | `failed PROVIDER_REJECTED` | `settled malformed` |
| validated `tesSUCCESS` | `completed`, ref = hash (applied; **not** a fill) | `settled validated-success` |
| validated `tec…` | `failed PROVIDER_REJECTED` (fee consumed) | `settled validated-failure` |
| complete search, validated index ≥ LLS | `failed PROVIDER_REJECTED trade-transaction-expired` | `settled expired` |
| no validated result by the finality budget | `unconfirmed trade-finality-unknown` | `unconfirmed` |

`frontera.xrpl-trade-ledger` (P12): read-only (`connect`, `server_info`, validated index, `tx`), bound to the
trade action; answers only from ledger facts for the one recorded transaction whose grant, decision and
request match the query; absence is never evidence; it never submits, re-signs or rebuilds (Scenario F).

## 18. Backup/restore implications

`xrpl-trade-sequence-interlock` joined the registry (16 stores), condition `xrpl-trade-execution`, opened by
restore tooling in verification mode only (no scope, no witness, writes nothing); the pilot Compose kit
lists its path on the state volume. A restored older copy is refused at the next start by the witness
(§14) — exactly PAY-03's posture. Production enablement additionally needs the TRADE-05 drill (backup,
restore, witness reconciliation on a real deployment).

Since the PROD-03 integration (§36), a backup's `coverage.deployment` records `xrplPaymentRail` and
`xrplTradeExecution`, and a coverage record that omits or mistypes either is refused as malformed.

## 19. Security effect inventory changes

| Inventory | Change | Meaning preserved |
|---|---|---|
| NO_BYPASS §5 | **EP-074** added (PROVEN — PATH LOCAL); EP-073 now composed in exactly EP-074's path, still DEPLOYMENT-GATED | twelve of seventy-four |
| NO_BYPASS §7.6 | EP-069 row: one request, two callers; EP-073 row: composed only by the executor composition | still nine outbound sources |
| `no-bypass-effect-paths.test.ts` | adapter holders += executor; signer factory users = the trade composition; reserved client users = the trade composition; `submitReserved` caller = the executor; `requestSubmit` reached twice | strengthened |
| `xrpl-rail-boundaries.test.ts` | unchanged (one `submit`, one `client.submit`, no OfferCreate in the rail directory) | unchanged |
| TRADE-04A tripwire | `assertXrplSequenceOwnership` caller = the Host; trade interlock openers = trade composition + registry; ordering pinned | the tripwire fired as designed and now pins the declaration |
| TRADE-04B reachability | edge importers += exactly the three executor-edge files | still no route, Host module or export |
| TRADE vertical | third approved composition edge `src/enterprise/xrpl-trade-execution` | still no CORE→TRADE dependency |
| TRADE-03 structure | importers of the edge = the executor edge, type-only | still composed by no production module |
| PAY-04 M39 / PAY-07 manifest | the executor edge classified out of CORE, scanned on its own | unchanged rules |
| CORE-07 kinds | `trade-sequence-reservations` added (single, rail-neutral) | closed list |
| Store registry / pilot kit | 16 stores; path listed | complete coverage |

## 20. Proof of a single network submission site

`command: 'submit'` occurs once in the repository (`xrpl-rail-boundaries.test.ts`, `no-bypass-effect-paths.test.ts`,
`trade04c-reserved-submission.test.ts`); `new Client(` once (same file); `requestSubmit(` exactly twice in
that file; `.submit(` callers = PAY-02's rail only; `.submitReserved(` callers = the executor only;
`createXrplReservedSubmissionClient` callers = the trade composition only. The executor edge contains no
SDK import, `Client`, `fetch`, socket, autofill or `submit(` (`trade04c-governed-executor-structure.test.ts`).

## 21. No-bypass proof

An order reaches the signer only through: an authenticated customer → TRADE-03 admission → the governed path
→ a grant whose digest names the attested proposal → the registry route → the executor's binding and
validated preflight. A signature reaches the network only through: a durable reservation → the submit site's
durable claim for exactly that blob. Each capability is built once and called once (§20). The residual is
the signer credential (§28): whoever holds it can obtain signatures **outside** this path; Frontera cannot
prevent that cryptographically today.

## 22. Negative and adversarial test matrix

| Suite | Tests | Covers |
|---|---|---|
| `trade04c-executor.test.ts` | 44 | A (binding: valid, unattested, subject/org/resource/action/amount, seven substitutions, missing/extra/duplicate/typed parameters, tampered attestation, expired grant, simulated facts, pair/network), B (17 ledger/delegation/key cases, revoked-before-signing, quarantine), C (signer tampering ×8, unavailable, horizon, configuration), D/E (duplicate & restart, concurrent same-owner, open window blocking, timeout uncertainty + P12, expired window + proven non-inclusion, tec/tem/unreadable, signed-not-sent, interlock/witness unavailable, crash after sign) |
| `trade04c-trade-interlock.test.ts` | 15 | reservation/blocking, 8-way concurrency, two processes, input refusals, claim binding ×7 + double claim (same/other connection/restart), lifecycle, CORE-07 table §14 |
| `trade04c-account-authority.test.ts` | 8 | key derivation vs SDK (44 keys), master/regular/disabled/changed key, malformed roots, owner `Sequence` |
| `trade04c-reserved-submission.test.ts` | 11 | G2 configuration, closed surface, not-connected, blob-derived claim, ordering pins, Payment surface |
| `trade04c-governed-execution-host.test.ts` | 16 | Scenarios A–F on the shipped Host; boot refusals (overlap, attestation missing, env key material ×3, signer identity, configuration ×9) |
| `trade03-f1-reliance-time.test.ts` | 32 | F-1 (TRADE-03 §38): honest real-time trials (3 × 200, each asserted to its exact expected outcome), 2 s delay, binding boundary, stale/future/malformed facts, organization, source, revocation, replay, profile expiry, clock regression (O, O2, O3), evidence and no-extension, 10 compiled-module mutants, 3 classifier self-tests |
| `trade04c-governed-executor-structure.test.ts` | 17 | edge files, imports, reachers, routes, single builders and callers, order, post-submit uncertainty, no effects, bounds, ownership declaration and rule (same/different network, delegates, malformed), negative fixtures |
| `trade04c-mutation.test.ts` | 23 | §23 |
| `trade04c-prod03-host-integration.test.ts` | 5 | §36: PROD-03 policy-source rule and Payment/Trade sequence isolation, alone and together; nothing opened on refusal |
| `trade04c-r8-trade-policy.test.ts` | 19 | §37: R8-A … R8-G — unrelated / missing / hand-built / review-less / binding-less providers, approvalPolicy-only and beside the provider, forgery (wrapper, prototype look-alike, rule-dropping wrapper), binding (another edge or profile version, trust domain, owner scope), factory and provenance immutability; on the shipped Host: in-limit executes once, 800 RLUSD withheld with unauthorized / self / rejected / revoked / authority-revoked approvals never executing and a valid one executing exactly the grant-bound transaction once; structure pins |
| `trade04c-r8-mutation.test.ts` | 1 (5 baselines, 10 mutants) | §37 mutation table |
| `portability-store-registry.structure.test.mjs` (+4) | 13 | §36: every flag a store condition reads is type-checked and written by the backup |

Governed-path refusals (policy denial, approval required/revoked/expired, missing/expired/revoked grant,
wrong principal/organization, risk ceiling, stale or missing trusted facts, emergency stop) are refusals
**before** the executor; they are exercised on the shipped Host here (B, C) and exhaustively in the
unchanged CORE-04/CORE-05/P10/TRADE-03 suites, with the executor's zero-signature, zero-send counts asserted.

**Validation after the F-1 correction, 2026-10-14 (local, WSL2 on `/mnt/c`; no CI run — the branch is not
pushed).** Typecheck, build, lint and release coherence pass. Full root suite: 11 656 tests, 11 643 pass,
**0 fail**, 9 skipped, 4 todo. Workspaces: 1 103 / 1 103. Isolated protocol-tarball validation
(`AOC_PROTOCOL_TARBALL=vendor/aoc-protocol-0.2.0-rc.1.tgz`, every child process's complete output captured):
every step passes, including `test` (11 656 root tests, 11 642 pass, 0 fail, 10 skipped, 4 todo; every
workspace suite green). Publishability and the clean-room consumer pass.

**Earlier failures, reported as they were.** Before the correction, two full root runs each had failures that
passed when re-run alone: run 1 — 18 (inventory pins since updated, plus PAY-07 Lightning MRC-13, a PAY-08
witness timeout and the launcher); run 2 — 4 (PAY-03 restart, PAY-08 LIFE, the launcher, Host preflight);
the first tarball run exposed a real typing defect (fixed); the second had 3 test failures its validator did
not name. None recurred in the runs above. That is not proof their causes are gone. One concrete candidate
cause was measured during the F-1 work: this host's wall clock steps **backwards** by ~0.8–1.3 s about every
30 s (WSL2 time re-sync) — a plausible, **unproven** cause of timing-sensitive failures (deadlines, witness
timeouts, PAY-03's close-time quarantine). CI on a stable Linux runner must confirm.

## 23. Mutation results

23 compiled-module mutants (`trade04c-mutation.test.ts`): **18 detected, 5 contained, 0 surviving
undetected.**

Detected: remove the bounded-parameter check; remove the subject/organization binding; change `TakerGets`
after the grant; accept observations outside the ledger window; skip delegate-key verification; use the
delegate's `Sequence`; skip blocking before signing; treat provisional success as settled; report an
uncertain submission as failed; accept a signature for another transaction; accept a wrong signer key;
claim ignoring the hash; skip blocking at reservation; release an uncertain window without ledger evidence;
ignore CORE-07 freshness before signing; an unanchored claim; disable the boot overlap check; submit without
the durable claim.

Contained (the property still holds because an independent boundary refuses — listed, not hidden): remove
the attested-digest binding (the digest dimension of the parameter comparison); skip the delegation-scope
reading (TRADE-02's assessment); submit before reservation and blind retry after uncertainty (the submit
site's durable single-use claim); a claim allowed twice (the schema's `UNIQUE (kind, execution_id)`).

Not mutated here (CORE, unchanged and qualified by their own suites): "remove bounded-grant check" and
"remove approval requirement" — the executor never sees an action the grant or CORE-05 refused.

## 24. Scenario A–F results (offline, shipped Host, labelled fake ledger)

| Scenario | Result |
|---|---|
| **A — allowed** | executed; 1 signature, 1 send; submitted blob = the attested proposal; evidence `validated-applied`, `injected-ledger-client`, grant id equal to the P11 execution's; replay: 0 further effects |
| **B — economic ceiling** | above the notional maximum: risk VIOLATED, denied, 0/0; above the P10 ceiling: not executed, 0/0; altered intent: 0/0 |
| **C — approval** | withheld by approval, 0/0; approved → resumed → executed once; approved but delegation revoked meanwhile → refused by the executor's re-read, 0/0; emergency stop → withheld, 0/0 |
| **D — delegation revoked** | TRADE-03 assessed SATISFIED/AUTHORIZED (read 1); executor's re-read (read 2) finds none → 0 signatures, 0 sends |
| **E — tampering** | signer signs another `TakerPays`; content binding refuses; nothing reserved or sent; signer MISMATCH for the Host's life |
| **F — uncertain** | transport fails after the send: 1 attempt, `unconfirmed`, no retry; P12 `unresolved` until validated, then `confirmed-completed`; still 1 send |

## 25. Performance figures

`node scripts/trade/bench-governed-offer-executor.mjs --iterations 100 --host-iterations 40`, WSL2 on
`/mnt/c`, Node 22.23.1, single process, fake ledger, loopback signer and witness. Milliseconds.

| Stage (executor, n = 100) | median | p95 | p99 |
|---|---|---|---|
| grant binding (validate, digest, recompile) | 1 | 1 | 1 |
| validated ledger reference + quarantine | 0 | 1 | 1 |
| delegation re-read (TRADE-02) | 1 | 3 | 5 |
| account roots (key authority + owner Sequence) | 0 | 1 | 1 |
| blocking (incl. witness probe) | 6 | 12 | 14 |
| protected signing (HTTP + client verification) | 25 | 45 | 70 |
| durable reservation (SQLite + witness prepare/finalize) | 54 | 188 | 218 |
| reserved submission (durable claim + witness + fake send) | 51 | 181 | 274 |
| finality reads (fake) | 1 | 2 | 2 |
| **executor total** | **159** | **386** | **578** |

Interlock alone (n = 100): anchored reserve 61 / 134 / 280; anchored claim 53 / 128 / 295. Shipped Host end
to end (n = 40): 478 median, 1046 p95 (p99 not reported, n < 100); executor 174 / 532; governed-path
overhead (admission, envelope, Kernel with the trade provider's risk assessment, policy, approvals,
emergency, P10, grant, P7, P11, evidence persistence) 306 / 567. ≈ 6 orders/s sequential per process,
dominated by the two witness round trips. **This is fake-ledger latency, not XRPL throughput**: ledger
close (~3–5 s), validation and network latency are absent; the owner `Sequence` from a *validated* ledger
plus the blocking rule allow at most one in-flight order per owner per validated ledger; TRADE-03 admits one
pending binding per (actor, owner). No HFT-readiness claim.

## 26. End-to-end evidence schema

`tradeExecutionEvidenceOf(record)` → `frontera.trade-execution-evidence.v1`, a projection of the verified
interlock row (never a second store), joined to the ASSURE-01 trace by `requestId`, `decisionId`,
`boundedGrantId` and `executionId` (whose `providerRef` is the transaction hash):

```
{ schema, executionId, status: signed-not-submitted | submission-attempted | submission-uncertain | validated-applied
                               | validated-rejected | malformed-rejected | proven-not-included,
  ledgerProvenance: xrpl-network | injected-ledger-client,
  authority: { organizationId, subject, requestId, decisionId, boundedGrantId, proposalDigest },
  ledger: { networkId, referenceLedgerIndex, referenceLedgerHash, delegationLedgerIndex, delegateRootLedgerIndex,
            ownerRootLedgerIndex, delegationAssessmentDigest, delegationFactsDigest, keyAuthority },
  order: { ownerAccount, delegateAccount, preparedDigest, sequence, lastLedgerSequence, minLedger, fee },
  signature: { signerId, signerRequestId, signingPublicKey, transactionHash },
  reservation: { state, settlement?, submissionAttempts, reservedAt, transitions[] }, digest }
```

Policy and risk profile versions, trusted facts and their provenance, approvals and the decision are the
ASSURE-01 trace's (unchanged). No key, credential, blob, price strategy or engine context is recorded
(asserted: the signer token, the delegate seed and the blob do not appear).

## 27. Customer integration contract

The customer keeps its trading engine, strategy, market signals and owner key. It (1) authenticates as a
customer principal; (2) hands each order as a `frontera.trade-proposal.v1` to the embedder's trusted gateway,
which calls `admitProposal` and submits the returned intent; (3) receives `executed` / `withheld` / `denied` /
an unconfirmed execution id; (4) owns the XLS-75 delegation (narrowest permission: `OfferCreate`) and may
revoke it at any time — the executor's re-read honours revocation before every signature. Owner accounts
used for governed trading must be **dedicated**: not configured for Payment (enforced) and not used by the
customer's own direct submissions (not enforceable by Frontera — a direct submission on the owner account
competes for its `Sequence`). Requires XLS-75 enabled on the network.

## 28. Signer credential and custody limitations

**BLOCKED as a production security claim:** "only Frontera-granted orders can be signed by the delegate."
Whoever holds the delegate signer's bearer credential can request a signature for any closed, in-bounds
OfferCreate for a configured pair without any grant; the signer verifies no grant, and the TRADE-04B audit
digest is correlation, not proof. Implemented controls: the client is built in exactly one place and called
only by the executor; no route; credential by environment-variable name only, never echoed, never in
evidence or logs; https (plain http only to literal loopback); the signer pinned to its identity, network and
exact pair set; the Host refuses reference-signer variables and owner/delegate key names in its environment.
For **isolated Testnet qualification** (TRADE-05) this is adequate if the signer listens only on a private
network segment reachable from the Host alone and the credential lives only in the Host's secret store.
A compromised delegate signer (or key) is outside Frontera's enforcement: it can sign — and itself submit —
any offer XLS-75 permits.

**Recommendation (not implemented; needs its own approval):** a per-order, cryptographically grant-bound
signer authorization — the Host (or the CORE-02 external authority signer) issues a short-lived signed
capability over `{ executionId, grant digest, prepared-offer digest, owner, delegate, network, LLS, expiry }`;
the signer verifies it against a pinned authority key, enforces single use and its own expiry, and refuses
any request without one. That moves the authorization check into the custody boundary.

## 29. Reference-price / exposure limitations

TRADE-03 unchanged: market, exposure and active-order facts are snapshot-advisory; no atomic aggregate
exposure or live active-order cap is claimed (TRADE-07); the qualification's sources are simulated fixtures,
executable only under the in-code acknowledgement; a profile requiring authoritative facts with no
production source fails closed. On resume after approval, CORE-05 does not re-run the Kernel, so prices are
not re-assessed; the executor re-reads delegation, key and `Sequence`.

## 30. Comparison against PAY invariants

| PAY-02/03/05 invariant | Trade |
|---|---|
| one `submit` request, no retry | the same request; one send per execution, enforced at the site |
| reserve before submit | reserve **and** a durable claim at the site |
| interlock never deletes, forward-only, verified reads | same, plus anchored claims |
| CORE-07-anchored history | anchored reservations **and** claims |
| restart quarantine | same rule, transaction-neutral, same historical bound |
| `not-submitted` release | **none** (stricter) |
| validated success = completion | validated `tesSUCCESS` = the OfferCreate applied, **not** a fill |
| P12 read-only, absence never evidence | same |

Payment behavior is unchanged: the full PAY-02/03/05/06/07/08/09 suites pass unmodified except inventory
assertions that now name the new composition (§19).

## 31. Explicitly deferred to TRADE-04D

Offer-state reconstruction from validated metadata (resting, partially filled, filled, killed, expired,
`tec` with fee consumed); OfferCancel; operator tooling for `reserved`/`unconfirmed` records; recovery
drills on a real ledger; per-owner throughput beyond one order per validated ledger (pending-Sequence
chaining).

## 32. Explicitly deferred to TRADE-05 (live Testnet, separately authorized)

Funded Testnet owner and delegate accounts, a real XLS-75 delegation, the reference (or customer) signer on
a private segment, the real `submitReserved` socket path against rippled (including `entryNotFound`
shapes), fee behavior under load, real finality and P12 resolution, a backup/restore drill, and evidence with
`ledgerProvenance: 'xrpl-network'`. Nothing in TRADE-04C contacted a live ledger.

## 33. Remaining risks and approvals

| # | Risk / item | Status |
|---|---|---|
| R1 | signer bearer credential bypass (§28) | BLOCKS the production claim; recommendation needs approval |
| R2 | F-1: TRADE-03 reliance at the Kernel instant vs a real verifier | **corrected** (TRADE-03 §38); residual: a backward-stepping host clock refuses (fail closed) — production hosts must slew, not step |
| R3 | real-network behavior of `submitReserved` / `ledger_entry` error shapes | TRADE-05 |
| R4 | fixed fee under load | documented; no escalation by design |
| R5 | customer direct submissions on the owner account | contractual (§27) |
| R6 | G1 (shared accounts) | not authorized; refused at boot |
| R7 | throughput (one order per owner per validated ledger) | documented; TRADE-04D |
| R8 | a trade Host accepted any policy source: under a PROD-03 `approvalPolicy` ruling another profile, an order TRADE-03 marked APPROVAL_REQUIRED executed with no approval (§36, §37) | **corrected** (authorized): mandatory TRADE-03 policy provenance, enforced at boot (§37) |

## 34. Commercial readiness assessment

Credible as a **Design Partner offline demonstration**: the governed path, exact grant binding, validated
re-reads, protected signer, durable single-use submission and honest uncertainty are implemented and
qualified, and the evidence explains a trace without exposing strategy. Not production-ready and not
Testnet-proven: R1–R3 stand between it and a live pilot.

## 35. Final verdict

**CONDITIONAL.** All TRADE-04C acceptance criteria that can be met offline are met (AC-01 … AC-17, AC-19 …
AC-25); AC-18 holds (no live writes); AC-26 is satisfied as a precondition only (TRADE-05 needs separate
authorization). Conditions: R1 (signer authorization), TRADE-05 live qualification, TRADE-04D recovery. (R2, F-1,
is corrected.)

## 36. Integration with `main` @ `9dfca30` (PROD-03, #188)

`main` gained PROD-03 after this branch's baseline; it was merged in (`git merge --no-ff origin/main`, the four
TRADE-04C commits kept). Two files conflicted, both additively:

- `host/enterprise-host.ts` — kept PROD-03's `policyPackProviderOf` and `assertOnePolicySource`, and
  TRADE-04C's `trade` argument to `toCreateEnterpriseOptions`, `assertXrplDomainsDisjoint`, the trade
  composition and P12 selection. Both checks are pure functions of configuration in the same
  pre-composition `try` of `bootEnterpriseHost` (before any rail, interlock, signer or store is composed);
  sequence isolation runs first, so a configuration wrong both ways reports
  `HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID` deterministically.
- `host/host-configuration.ts` — `approvalPolicy` and `xrplTradeExecution` side by side in imports, the typed
  section, the closed key list (unknown keys still refused), parsing and propagation. Neither reads the other.

**Cross-feature finding 1 — backup coverage flags (fixed).** PROD-03's coverage validator type-checked a fixed
list of deployment flags that omitted `xrplPaymentRail` (already so on `main`) and TRADE-04C's
`xrplTradeExecution`, and the backup never wrote either. A coverage record without the flag was judged
complete without the matching interlock (reproduced; a restore into a trade Host still refused it through
`missingForTarget`). Approved fix ("strict flags"): the backup writes both, the validator requires every flag a
store condition reads (`DEPLOYMENT_FLAGS`, pinned against `conditionHolds` by test). Coverage backups taken
before this change lack the two flags and are refused: take a fresh backup.

**Cross-feature finding 2 — R8, an execution-governance bypass (corrected, §37).** First seen as a missing
defence-in-depth layer (an altered intent reached review and was refused at the executor's step 1), then
reproduced as a real bypass: with an `approvalPolicy` ruling only a non-trading profile, an 800-RLUSD order
TRADE-03 assessed APPROVAL_REQUIRED was **executed — 1 signature, 1 submission, zero approvals**, because
`trade-risk-review` is a TRADE-03 policy-pack rule and that composition carried none.

**F-1 trial classification (revised).** See TRADE-03 §38: no trial is skipped; each is asserted to its exact
expected outcome from the recorded trusted-clock reads, refusals must carry clock causes only, and
deterministic injection plus classifier self-tests cover both regression shapes.

## 37. R8 — mandatory trading policy provenance (security correction)

**Root cause.** TRADE-03's controls that decide whether an assessed order may proceed are policy-pack rules
(`tradeRiskPolicyRules`): `trade-risk-review` (APPROVAL_REQUIRED → CORE-05 approval), the exact binding of the
seven trade parameters, amount and asset to the assessed proposal, the verified delegation, the pinned profile
and the presence of every material fact. The Kernel's policy port is opaque, and the Host accepted any provider
that satisfied `GOVERNED_ACTION_CONTEXT_POLICY_REQUIRED` — an unrelated pack, or (after PROD-03) a file
`approvalPolicy` for another profile. What still held without those rules: VIOLATED (no readings → the Kernel
denies), CORE-04 freshness/trust, P10/P11/P12, emergency stop, the executor's validated re-reads and exact
binding. What was lost: human review, and policy-level proposal binding. The executor cannot replace them: it
is action-neutral by design (CORE-08) and never sees approvals.

**Correction (authorized; production files `trade-risk-context/trade-risk-policy-provider.ts` (new),
`trade-risk-context/trade-risk-context.ts`, `trade-risk-context/index.ts`, `host/enterprise-host.ts`,
`host/host-configuration.ts` — two refusal codes).**

- `createTradeRiskPolicyPackProvider(edge, { trustDomainId })` binds only to an edge `createTradeRiskContext`
  produced (recorded in that module's private registry) and reads the edge's pinned profile reference, action,
  network and owners from it. It compiles exactly `tradeRiskPolicyRules` — the existing definitions — scoped to
  the trust domain, the trade action and `<network>:<owner>` for every pinned owner, and refuses unless the
  compiled set is exactly `TRADE_RISK_MANDATORY_POLICY_RULE_IDS` (stated independently of the builder) with each
  rule's mandatory effect (`trade-risk-review` → `require_approval`; every other → `deny`). Rules are frozen data
  captured at construction; each evaluation runs on a freshly compiled, frozen runtime. The provider is frozen;
  its provenance is recorded in a private registry keyed by that object, so a wrapper, copy or prototype
  look-alike carries none. No additional rules this milestone.
- The Host (`assertTradePolicyComposed`, in the pre-composition block, before any XRPL store, signer or
  executor): with `xrplTradeExecution`, a file `approvalPolicy` is refused (`HOST_TRADE_POLICY_SOURCE_CONFLICT`);
  otherwise the exact object `policyPackProviderOf` hands the Kernel must carry provenance, the mandatory rule
  set, the configured trade action, the Host's trust domain and organization, the Host's `contextProvider` and
  the executor's attestation source as its edge's, and every configured owner in scope
  (`HOST_TRADE_POLICY_REQUIRED`). Hosts without trade execution — PROD-03 included — are unchanged.

**Approval enforcement on the shipped Host (`trade04c-r8-trade-policy.test.ts`).** In-limit order: executed
once (1 signature, 1 submission). 800 RLUSD: TRADE-03 APPROVAL_REQUIRED → withheld by approval, 0 / 0; an
unprovisioned actor's and the requesting agent's approvals are refused (still withheld, 0 / 0); a valid approval
→ executed exactly once, the submitted blob's `Account`, `TakerGets` and `TakerPays` equal the proposal, the P11
execution is recorded, a replay signs and sends nothing. Rejected, revoked-before-resume and
approver-authority-revoked: never executed, 0 / 0. Expiry and quorum are CORE-05's (approval-lifecycle,
approval-authenticity, CTRL-04 workflow suites). Profile change (R8-G): a provider qualified for another profile
version cannot serve the Host (refused both ways); CORE-05 subjects bind the profile key and digest, the
admitted-context digest and the requirement snapshot (approval-lifecycle: another context or requirement is
superseded, never approved). An end-to-end restart on the same state was attempted and is **not** used as
evidence: the fixture's restart path does not restore P10 (`FINANCIAL_AUTHORITY_UNRESOLVED` with the profile
unchanged too).

**Mutations (`trade04c-r8-mutation.test.ts`, one process per mutant, every edit applied exactly once, five
unmutated baselines hold).**

| Mutant | Configuration | Result |
|---|---|---|
| guard removed | approvalPolicy for another profile | **detected** — executed, APPROVAL_REQUIRED, 1 signature, 1 submission (the original R8 defect) |
| unmarked provider accepted | hand-built rules without review | **detected** — executed 1 / 1 |
| provenance read through the prototype | look-alike inheriting from the genuine provider | **detected** — executed 1 / 1 |
| review requirement omitted (review → allow, factory effect check removed) | mandatory provider | **detected** — executed 1 / 1 |
| review rule effect weakened | mandatory provider | contained — factory effect check (`TRADE_RISK_POLICY_PROVIDER_INVALID`) |
| review rule removed | mandatory provider | contained — factory rule-set check |
| review rule removed + factory checks removed | mandatory provider | contained — Host rule-set check (`HOST_TRADE_POLICY_REQUIRED`) |
| proposal binding removed (rule builder) | mandatory provider | contained — factory rule-set check |
| edge binding removed from the guard | provider qualified for profile @4 on an @3 Host | contained — `trade-risk-profile-pinned` denies, 0 / 0 |
| approvalPolicy conflict accepted | approvalPolicy for another profile | contained — provenance check (`HOST_TRADE_POLICY_REQUIRED`) |
