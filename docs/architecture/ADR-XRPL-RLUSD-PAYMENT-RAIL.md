# ADR: XRPL / RLUSD is a PaymentRail under the PAY-01 adapter boundary; ambiguous submissions map to unconfirmed and are never retried (PAY-02)

- Status: accepted
- Phase: PAY-02 — XRPL / RLUSD Payment Rail Adapter
- Status of implementation: implemented in `src/features/payment-runtime/rails/xrpl/`;
  qualified by `rails/xrpl/tests/xrpl-rlusd-rail.test.ts` (rail contract),
  `rails/xrpl/tests/xrpl-rail-boundaries.test.ts` (structure),
  `src/enterprise/__tests__/pay02-xrpl-rlusd-rail.test.ts` (real governed path)
  and the opt-in `pay02-xrpl-testnet-smoke.test.ts` (XRPL Testnet).
- Depends on: `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01, unchanged),
  `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11),
  `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12),
  `ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md` (CORE-02, the signer pattern).
- Rail documentation: `docs/payments/XRPL_RLUSD_RAIL.md`.
- Numbering: the master plan's sequence names XRPL "PAY-04" behind a protocol
  milestone (PAY-02) and a rail-boundary milestone (PAY-03). This milestone
  delivers the XRPL rail first, as PAY-02, on the rail contract PAY-01 already
  defined; the signer port it introduces is rail-specific, and a reusable rail
  conformance suite remains PAY-03 scope.

## Context

PAY-01 defined what a payment is and the one interface a rail implements,
`PaymentRail { railId, execute }`, reachable only through
`createPaymentRailExecutionAdapter`. The first real rail has to move a real
asset — RLUSD, an issued currency on the XRP Ledger — without changing
anything PAY-01 or the governed path decides, without putting a key anywhere
near a payment request, and without ever turning an ambiguous submission
into either a false failure (a second payment) or a false success.

## Decision

1. **A rail, not a path.** `createXrplRlusdRail` returns a `PaymentRail`. It is
   composed only through PAY-01's bridge — below decision, approval, ceiling,
   grant, exercise, emergency interlock, P7 reservation and write-ahead claim
   — and decides nothing. No PAY-01 type, rule or export changed.
2. **Destinations are PAY-01 destinations.** Two kinds, `xrpl-account` and
   `xrpl-tagged-account` (`<classic>:<tag>`); the destination tag is part of
   the governed counterparty, so it is bound by the grant. X-addresses are
   refused: one destination, one spelling.
3. **Everything ledger-specific is trusted configuration.** Network (no
   default; mainnet needs a second explicit flag), endpoint, issuer, currency
   code, source-account mapping, fee ceiling, `LastLedgerSequence` offset. The
   server must report the configured `network_id` before every preparation.
4. **Exactly one transaction shape.** An issued-currency `Payment` with
   `Flags: 0`, the canonical decimal value unchanged (proven exactly
   representable by string arithmetic), no memo, path, `SendMax` or caller
   field. Autofill may add only `Sequence` and a fee under the ceiling.
5. **Signing is a port.** `XrplTransactionSigner` signs exactly a prepared
   payment for one account; the rail verifies the returned blob signs exactly
   what it prepared before submitting. No production signer ships; the
   software signer is test-only and structurally confined to `tests/`.
6. **Finality, not submission.** A submit answer is provisional. `completed`
   only for a validated `tesSUCCESS` delivering exactly the granted amount;
   `not-completed` only for a validated `tec…`, a `tem…`, provable expiry past
   `LastLedgerSequence` with complete history, or a refusal before submission;
   **everything else after submission is `unconfirmed`**, carrying the
   transaction hash (known before submission) for P12.
7. **No retry.** One `submit` call site, at most once per `execute`; lookups
   are reads; `fail_hard: true`. Nothing resubmits, re-signs, re-prepares or
   re-sends after a reconnect. An unconfirmed payment is resolved by the
   existing P12 operator resolution; there is no XRPL-specific resolution path.
8. **Confined SDK.** The official `xrpl` package (ISC), pinned exactly, is a
   development dependency, imported by three rail files only; one file opens
   connections and submits (EP-069). It is not a runtime dependency of the
   published artifact, and nothing in the core or the PAY-01 contract imports
   it.

## Consequences

- Frontera's governance model, P11 schema, P12 flow, disclosure tiers and
  public surface are unchanged; NO_BYPASS gains one path-local effect path,
  EP-069 (nine of sixty-nine).
- A host that wants the rail in production must compose a real signer and
  promote `xrpl` to a runtime dependency of its own deployment — both
  deliberate later decisions.
- Some payments that a looser rail would report failed are reported
  `unconfirmed` and need an operator; that is the intended cost of never
  paying twice.

## Not decided here

Production key custody, an XRPL resolution authority for P12, trustline and
balance preflight, issuer transfer fees, multi-signing, Host-config and
deployment-kit composition, mainnet qualification, and the cross-rail
conformance suite.
