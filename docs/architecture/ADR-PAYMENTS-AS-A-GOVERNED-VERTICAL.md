# ADR: Payments are a vertical over the governed-action core; rails receive only granted, normalized payment execution requests (PAY-01)

- Status: accepted
- Phase: PAY-01 — Governed Payment Intent & Rail Adapter Contract
- Status of implementation: implemented in `src/features/payment-runtime`
  (payment intent, validation, governance compilation, execution preparation,
  rail contract, rail bridge); qualified end to end on the governed path by
  `src/enterprise/__tests__/pay01-governed-payment.test.ts`.
- Depends on: `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9),
  `ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md` (P10),
  `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7),
  `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11),
  `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12),
  `ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md` (CORE-03),
  `ADR-PROVIDER-ADAPTER-CONTRACT.md`.
- Architecture: `docs/payments/PAYMENT_ARCHITECTURE.md`.

## Context

The MPP-00 audit settled that a machine payment is a governed action, not a
new authority model, and P9–P12 made the spine monetary: exact amounts,
authority-sourced ceilings, aggregate exposure, three-way provider certainty
and out-of-band resolution. What did not exist was a canonical answer to
"what is a payment" — a contract future rails (PAY-03/04), protocols (PAY-02)
and receipts (PAY-05) can share — and every candidate placement risked
either a second governance path (a payment controller calling a rail) or rail
vocabulary leaking into the core.

## Decision

1. **A payment is a specialized intent that compiles down to the
   `GovernedActionIntent` envelope.** Source → `resource`; destination →
   `counterparty` (`<kind>:<reference>`); amount → `amount`; purpose,
   reference and rail → CORE-03 token parameters bound `exact`; idempotency
   key → `idempotencyKey`. No new envelope field, Kernel field, grant axis,
   store or route.
2. **The vertical lives in `src/features/payment-runtime`, and the core never
   imports it.** It imports only `monetary-runtime`, `governed-parameter-runtime`
   and `execution-runtime`. The payment action is host configuration, not a
   constant.
3. **A rail is reached only through an ordinary `ExecutionAdapter`**
   (`createPaymentRailExecutionAdapter`) — one more implementer of the
   existing port, beside the Generic HTTP adapter. It receives a
   `PaymentExecutionRequest` prepared purely from the `ValidatedExecutionAction`
   — values the grant proved — and nothing else. No second adapter
   architecture, no second invocation site, no new effect path (EP-011's
   provider hop; NO_BYPASS §7.1).
4. **Outcomes reuse the execution vocabulary.** `completed` / `not-completed`
   / `unconfirmed` map onto `completed` / `failed` / `unconfirmed`, and so onto
   P11 certainty and P12 resolution, with `ExecutionFailureReason` unchanged;
   payment specifics are a bounded `detail` token. A rail that throws or
   answers unreadably is `unconfirmed`, because it was invoked.
5. **No free-form payment metadata.** Anything that must travel with a payment
   is a declared, bounded, grant-bound value.
6. **Evidence and disclosure are the existing trace and tiers.** No
   payment-specific evidence, trace, resolution or exposure accounting.

## Consequences

- A payment is decided, approved, bounded, reserved, claimed, executed,
  recorded, disclosed and resolved by exactly the code that governs every
  other action; every existing invariant applies to it unchanged.
- The payment's destination is governed as the counterparty: bound in the
  committed decision and the grant, digested in the trace, and disclosed in
  no trace tier. Disclosing it to AUDITOR would need a trace change and is
  left to a later ASSURE increment.
- Source accounts must be enumerated in a resource class (no wildcard) — the
  set of payable accounts is explicit configuration.
- A host that forgets the profile or the financial classification gets a
  refusal before evaluation, never an ungoverned payment.

## Not in PAY-01

Rails, SDKs, signing, custody, submission, settlement polling, FX, liquidity
routing, protocol parsing (PAY-02), the rail conformance suite and signer port
(PAY-03), XRPL (PAY-04), receipts and settlement (PAY-05), and any public HTTP
or package-entrypoint surface.
