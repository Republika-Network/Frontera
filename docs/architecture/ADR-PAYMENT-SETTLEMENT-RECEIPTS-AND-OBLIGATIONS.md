# ADR: Payment settlement, receipts and payment-obligation semantics (PAY-05)

- Status: accepted
- Milestone: PAY-05 (former P15) — `docs/architecture/FRONTERA-MASTER-PLAN.md`
- Specification: `docs/payments/PAY-05-SETTLEMENT-AND-RECEIPTS.md`
- Related: `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01), `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11),
  `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12), `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7),
  `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` (CORE-04), `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07),
  `ADR-XRPL-PRODUCTION-COMPOSITION.md` (PAY-03), `ADR-PAYMENT-PROTOCOL-ADAPTER-BOUNDARY.md` (PAY-04)

## Context

P11 records the provider's confirmation; P12 resolves an uncertain effect; P7
keeps capacity consumed ("reservation settled"). Each of their ADRs deferred
settlement, finality, receipts, refunds and payment obligations to P15. The
Master Plan's exit criterion for PAY-05 is: *"settled" means funds finality with
evidence, distinct from P7 capacity settlement.* Historical P15 material: no
implementation exists in history; the P11 / P12 ADRs only reserved the scope;
the unmerged Andrew-demo branches' "settlement check" was a pre-signing
representation gate (USD governed, RLUSD on the rail) and an ad-hoc live-test
ledger re-read — the re-read idea is kept (rewritten as a trusted read-only
authority over a closed contract); the representation gate is superseded by
PAY-01/02/03 (trusted asset mapping); nothing was cherry-picked.

## Decisions

**D1 — Settlement is a payment-vertical fact, not a core one.** The contract
lives in `src/features/payment-runtime/domain/` (held to the PAY-01 boundary
test: no rail, network, custody, clock or retry vocabulary) and the composition
in `src/enterprise/payment-settlement/`. The Kernel, grant runtime, policy core,
execution runtime, P7, P11, P12 and CORE-04 are unchanged; the only generic
change is one CORE-07 slot name (D8) and one exact P9 helper
(`subtractCanonicalDecimals`).

**D2 — "Settled" is defined normatively** (spec §2): a completed canonical
basis, a trusted authority's `final` answer, exact evidence, durably recorded.
P11 `confirmed-completed` and P12 `confirmed-completed` are bases, never
synonyms. P7 "settled" is renamed in prose only — *capacity settlement* — and
not in code.

**D3 — One stored state; the rest derived; no stored negative.** `settled` is
the only state PAY-05 writes, and it is terminal. `execution-uncertain`,
`awaiting-finality` and `not-settleable` are derived from P11 / P12 on read, so
there is no duplicate truth. A rail that contradicts a completed execution is
reported (`finality-contradicted`), not recorded. *Rejected:* a stored
`failed` / `not-settled` state — it would let an unavailable authority, a
timeout or a lagging server write a negative, and duplicate P11 / P12.

**D4 — A rail-neutral, read-only finality port with a closed answer**
(`PaymentFinalityAuthority`, spec §5), selected by trusted composition per
payment (the P12 selector pattern). Evidence is normalized and bounded (method,
handle, the canonical terms it verified, an optional rail-established instant,
≤ 16 named facts), never a provider body, and compared exactly with the basis.
*Rejected:* reusing P12's `ExecutionResolutionAuthority` — its answer is
execution certainty and has no evidence channel; widening it would make P12 a
settlement service.

**D5 — No P12 duplication, no dependency between them.** The XRPL finality
reader calls P12's unchanged `readLookup` for the execution half and adds the
settlement-only field checks; P12 imports nothing from PAY-05.

**D6 — Deterministic identities; receipts are pure derivations.**
`settlementId` from `(organization, execution)`; `receiptId` from
`(organization, settlement)`. A receipt carries no local instant and has no
store, so the same settlement content always derives the identical receipt —
after a restart, a restore or a re-verification — and C3 does not exist.
That holds only if the evidence an authority returns for one final transfer is
itself deterministic, so it is a rule of the port (hardening): no
availability- or shape-dependent field enters `final` evidence conditionally —
it is required (absent → `not-final`) or left out. The XRPL authority requires
the validated ledger header's hash and close time for every `final` answer,
never the `tx` answer's optional `ledger_hash`; reconstruction after store loss
is tested byte-identical (spec §15, DET-1 – DET-6). Finality instants are
calendar-valid, not only well-shaped. *Rejected:* a receipt table (a second
record that could diverge or be emitted twice); random ids; optional
enrichment in the canonical proof; anchoring the settlement store at CORE-07
instead of making reconstruction deterministic (it would turn an
availability-only state into a witness dependency without a money-moving
reason).

**D7 — Receipts are integrity-verifiable, not signed.** Frontera's signing keys
are authority-artifact keys (CORE-01/02); reusing them for payment evidence
would blur what a signature attests. ASSURE-02 is not pulled in. The receipt is
verified for integrity (its digest) and correlation (re-derived from the
canonical settlement), and says so.

**D8 — CORE-07 only where rollback moves money.** Settlement records are
reconstructible from immutable external finality — deterministically (D6) —
so their rollback costs availability only — not anchored. Refund accounting is not reconstructible: a
rollback would recreate refundable balance — anchored, always, in one new slot
`payment-refund-state` (no unanchored durable mode, no enrollment path).
Obligation discharges stay in CORE-04's already-anchored store. The witness
proves freshness only; local integrity is a separate layer: the refund
accounting recomputes every entry's digest from its content and the chain from
genesis on every read, and never trusts a cached head because a digest string
is unchanged.

**D9 — Payment obligations through CORE-04, unchanged.** PAY-05 writes one
observation via CORE-04's trusted recorder, citing a configured source whose
verification class CORE-04 decides. No second lifecycle, no `PaymentIntent` in
CORE state. Exact correlation by a **derived** business reference
(`paymentObligationReference`): a payment satisfies an obligation only if it
was made for it. A trusted, payment-specific registry states the expected
amount, destination and (optionally) source; only its successful answer
"none" means not a payment obligation — a registry failure is
`basis-unavailable`, never an authoritative negative. The bridge reports at its own
observation instant (CORE-04 orders reports by time). *Rejected:* matching by
amount / asset / time window; a configurable reference; a bridge-owned "used
receipts" table (the derived reference makes reuse structurally impossible).

**D10 — A refund is a new governed payment** with purpose `refund`, its own
key derived from `(organization, principal, original settlement, refundKey)`,
governed by the existing orchestrator as the requester. Partial refunds are
supported against a durable, CORE-07-anchored refundable balance; reservations
count until a definitive canonical fact proves the refund moved nothing — a
P12 resolution only through the same canonical validator the settlement basis
uses (bound to the attempt, the current P11 observation and its binding). The
refund is compiled (pure) before it is reserved, so a refused input never
strands balance. Refund direction comes from a trusted counterparty mapping, never address
reversal. *Rejected:* modelling a refund as a reversal or negative amount;
reusing P7 as the refund ledger; one-full-refund-only (it would need the same
durable accounting anyway to stop a second full refund).

**D11 — Explicit verification only.** No worker, timer or poll; reads never
contact anything; `verifySettlement` asks at most once.

**D12 — Embedder-composed.** No Host configuration, module, route or package
export (as PAY-04). The stores are classified in `EXCLUDED_DURABLE_STATE` with
explicit embedder backup ownership.

## Consequences

- "Settled" has one meaning in the repository, and a test fails if P11
  completion, P12 completion or a P7 reservation is read as it.
- PAY-06 (Lightning) implements the same port without changing it (spec §16).
- A finality authority is a trust boundary (spec §5); a database writer able to
  forge settlement rows is limited by the basis re-check (spec §7); refund
  accounting availability depends on the CORE-07 witness.
