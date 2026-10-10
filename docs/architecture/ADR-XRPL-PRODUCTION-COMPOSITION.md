# ADR: Production XRPL execution uses external customer-controlled transaction signing, a persistent unresolved-submission interlock, and P12 read-only resolution; the Host never holds customer transaction keys and never automatically resubmits (PAY-03)

- Status: accepted
- Phase: PAY-03 — Production XRPL Composition, External Transaction Signing & Durable Reconciliation
- Status of implementation: implemented in `src/enterprise/xrpl-payment-rail/` and
  `src/features/payment-runtime/rails/xrpl/` (interlock port, restart quarantine,
  pinned-key verification); qualified by `src/enterprise/__tests__/pay03-*.test.ts`,
  `scripts/payments/qualify-xrpl-production-artifact.mjs` and the opt-in
  `pay03-xrpl-testnet-production.test.ts` (XRPL Testnet, separate signer process).
- Depends on: `ADR-XRPL-RLUSD-PAYMENT-RAIL.md` (PAY-02, extended, not changed in
  meaning), `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01, unchanged),
  `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12, unchanged),
  `ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md` (CORE-02, the pattern),
  `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07, assessed, not extended).
- Canonical documentation: `docs/payments/XRPL_PRODUCTION_COMPOSITION.md`.

## Context

PAY-02 proved the XRPL / RLUSD rail on the governed path and on Testnet, but
deliberately shipped no production signer, no Host composition and no
XRPL-specific P12 authority, and protected an unconfirmed transaction's
`Sequence` only in process memory. A restart therefore erased the one fact
that keeps a second payment from autofilling the same sequence and competing
with a still-live first one. The Host could not run the rail without either
holding a customer key or accepting that gap.

## Decision

1. **Explicit composition through existing seams.** An optional, closed
   `xrplPaymentRail` section of the governed-action file composes the rail at
   boot: PAY-02's rail, wrapped in PAY-01's bridge, added to the existing
   execution-adapter registry and reachable only by its configured route.
   Absent, nothing XRPL is loaded or composed. No second governed path, no
   admin route, no package export.
2. **External, customer-controlled signing.** The Host requests signatures from
   an external signer over `frontera.external-xrpl-transaction-signer.v1`
   (one identity call, one narrowly typed operation: sign the prepared
   Payment). Configuration pins the signer id and each account's signing public
   key (no TOFU); every blob is verified locally — same transaction, pinned
   key, valid signature, own hash — before the one submission. One attempt per
   signature. The Host holds a transport credential and public pins only; it
   refuses to start with XRPL key material in its environment. A reference
   signer exists as a separate process for qualification, labelled not-an-HSM.
3. **A durable submission interlock, written before submission.** One SQLite
   record per signed execution, committed (`BEGIN IMMEDIATE`, check-and-insert)
   strictly before `submit`; forward-only lifecycle, never deleted. A record
   blocks a competing sequence on its account while its `LastLedgerSequence`
   window is open; every release is a ledger fact. It is in the PROD-02 store
   registry, backed up and restored.
4. **A restart quarantine instead of witness anchoring.** With the interlock
   composed, the rail prepares nothing until the validated ledger has passed
   `lastLedgerOffset + 4` ledgers beyond the first index it observed. Any
   transaction from before the restart — even one whose record a rollback lost
   — has then left its window. The ledger is the freshness witness; the
   interlock is not CORE-07 anchored.
5. **P12 read-only XRPL resolution.** `frontera.xrpl-rlusd-ledger` is bound
   before the claim to every execution of the rail's payment action and answers
   from validated ledger facts only; anything ambiguous is `unresolved`, and
   absence of a record is never evidence. It has no write capability. P12's
   rules (one binding, one resolution, explicit reconcile only) are unchanged.
6. **No resend, anywhere.** An execution with an interlock record is never
   prepared, signed or submitted again; restart, P12, signer recovery, health
   recovery and operator action trigger no submission.

## Consequences

- The shipped Host can run the XRPL rail in a production shape without a
  customer key, and its ambiguity safety survives restart, a second process on
  the same state, and restore.
- Availability costs: XRPL payments are refused during each restart quarantine
  (≈ 30 s – 1.5 min); a payment crashed before its reservation stays P12
  `unresolved` (it provably submitted nothing, but that proof is not used);
  operators cannot override the ledger authority on XRPL-bound executions.
- New durable state, a new required health module and an optional one; one
  new outbound call site (the signer transport); EP-069 remains the only XRPL
  effect path, now reachable from Host configuration.
- `xrpl@5.3.0` becomes a runtime dependency (exact pin).

## Rejected alternatives

- **Holding the key in the Host (software signer).** Contradicts the custody
  invariant; anything that reads the Host process could move funds.
- **Pre-submit record without signature (two-phase reserve, then attach hash).**
  More crash windows, and a rollback still defeats any inference from absence;
  the quarantine is needed either way.
- **CORE-07 anchoring of the interlock.** Possible, but every payment would
  need a witness round-trip; the ledger already bounds what a stale record can
  hide.
- **Releasing the interlock on P12 / operator resolution.** Unnecessary — the
  ledger fact that justifies a resolution already releases the interlock — and
  an operator's attestation is not a ledger fact.
- **Retrying a failed signing call.** A second signature over the same
  sequence for no gain; one attempt, and a refusal, is honest.
