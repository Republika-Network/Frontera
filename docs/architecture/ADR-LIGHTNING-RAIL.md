# ADR: Lightning is a second payment rail behind the unchanged ports — strict BOLT11 binding, one durable CORE-07-anchored reservation before the one node send, node uncertainty mapped onto existing P11 certainty, read-only P12 and preimage finality (PAY-06)

- Status: accepted
- Phase: PAY-06 — Lightning Rail Adapter
- Status of implementation: implemented in `src/features/payment-runtime/rails/lightning/`
  and `src/enterprise/lightning-payment-rail/`; qualified by
  `src/features/payment-runtime/rails/lightning/tests/*.test.ts`,
  `src/enterprise/__tests__/pay06-*.test.ts` and the opt-in real-LND
  `pay06-lightning-regtest.test.ts`.
- Depends on: `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01, unchanged),
  `ADR-XRPL-PRODUCTION-COMPOSITION.md` (PAY-03, the production pattern — adapted, not copied),
  `ADR-PAYMENT-SETTLEMENT-RECEIPTS-AND-OBLIGATIONS.md` (PAY-05, unchanged),
  `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12, unchanged),
  `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07, one slot added).
- Canonical documentation: `docs/payments/PAY-06-LIGHTNING-RAIL.md`.

## Context

The master plan names PAY-06 the rail-neutrality proof: XRPL, delivered first,
could have shaped the PAY-01 rail port, the P12 resolution port and the PAY-05
finality port. Lightning differs from XRPL on every axis that matters —
invoices instead of accounts, a preimage instead of a ledger transaction, HTLC
settlement instead of ledger close, path-dependent routing fees, a payee node
instead of an address, BTC only, and a node that signs internally. Its exit
criterion: the same CORE, unchanged, governs Lightning.

## Decision

1. **No generic contract changes.** Lightning implements `PaymentRail`,
   `ExecutionResolutionAuthority` and `PaymentFinalityAuthority` as they stand.
   Each was checked against Lightning; none had a protocol-neutral deficiency.
   The only change outside the payment vertical is one rail-neutral CORE-07
   slot, `payment-initiation-reservations`.
2. **Destination = payee + payment hash.** `{ kind: 'lightning-invoice',
   reference: '<payee>:<hash>' }` rides PAY-01's governed counterparty
   unchanged, so authority, policy, P10 and the grant bind both. The BOLT11
   text is resolved at execution from a trusted embedder invoice source and
   paid only if payee, payment hash, amount and network all match; the node's
   own decoding must agree.
3. **A strict in-repository BOLT11 decoder, pinned** to bolts `14901bd`, with
   the payee **recovered** (never assumed) via `@noble/curves` 2.4.0 — already
   shipped through `xrpl`, now an exact direct dependency — and every signature
   verified a second time by Node's OpenSSL. Unknown required features, unmet
   feature dependencies (transitively: `basic_mpp → payment_secret →
   var_onion_optin`; the second edge kept from the revisions defining those
   now-ASSUMED features), wrong fixed lengths, non-minimal fields,
   duplicates, missing `s` and amountless invoices are refused.
4. **Exact BTC money:** one trusted BTC asset (scale ≤ 11); BTC decimal ⇄
   integer msat with text and `BigInt`; sub-msat values refused.
5. **A narrow node port with one reference adapter: LND over REST.** Reads
   (`getinfo`, `payreq`, `track`) and one send (`SendPaymentV2` with
   `fee_limit_msat`, no self-payment, no AMP). Credentials (macaroon, pinned
   TLS certificate) stay in the adapter's closure; the authorities receive a
   reader with no send method and a node-enforced read-only macaroon.
   Plaintext `http:` only to a literal loopback IP — never a hostname, since
   the macaroon rides in the headers and a resolver could redirect it. No fake
   external signer: the node signs internally, and capability separation is
   the analogue of PAY-03's custody boundary.
6. **At most one send per governed execution.** A durable, append-only,
   hash-chained interlock with one reservation per execution and per payment
   hash is written — and witnessed at CORE-07 — strictly before the one
   `sendPayment`; an execution already reserved is never sent again; no retry.
   The node's internal route attempts are one logical payment, not a retry.
   The reservation also binds the **payer node identity** read (once) before
   the send — immutable, digested, chained and witnessed (interlock schema v2;
   v1 refused, never migrated).
7. **Routing fees are capped before the spend** by trusted configuration
   (`min(absolute, ppm)` in integer msat), handed to the node as its hard limit
   and re-checked on every answer. The governed amount is what the payee
   receives; the fee is execution cost, recorded as a bounded fact; P7 / P10
   semantics are unchanged (principal only).
8. **Uncertainty is never failure.** Only a terminal node failure with nothing
   in flight is `confirmed-not-completed`; timeouts, disconnects after
   connection, in-flight and unknown are `unconfirmed`; only a TCP connection
   never established is "not sent" (a TLS handshake failure after it is
   unknown).
9. **P12** reads the reserved payment hash from the node, read-only, and only
   from **the payer node the reservation bound** (identity and network); any
   other node is unresolved whatever it says; absence is never evidence.
10. **PAY-05 finality = the preimage**, verified by SHA-256 against the payment
    hash, with exact amount, fee bound, payee and network, read only from the
    reserved payer node (another node is `not-final`, never `contradicted`);
    deterministic evidence (naming the payer node); no `finalizedAt` (a payer-node clock is not authoritative); the
    preimage is never recorded (a domain-separated commitment is).
11. **Embedder-composed**, like PAY-04 / PAY-05: no Host configuration, route,
    module or package export. One new effect path, EP-071 (PROVEN — PATH LOCAL).

## Consequences

- The rail-neutrality design test passed: XRPL had not shaped the ports.
  PAY-07 can run one conformance suite against both rails.
- A new CORE-07 slot and a new embedder-owned durable file (excluded from
  `backup:v1`, witness outside its restore domain).
- `@noble/curves` is a direct runtime dependency (no new package in the tree).
- Lightning refunds need a fresh invoice from the beneficiary; amountless
  invoices, keysend, AMP, BOLT12 and LNURL are out of scope.
- The payer node must be dedicated to Frontera (LND permits re-paying a hash
  whose payment failed).
- The payer binding trusts the node's own identity report: it defeats a reader
  composed against another honest node, not a compromised node that claims
  another's key (node trust).

## Rejected alternatives

- **Widening the generic contracts** (an invoice field on the intent, a
  preimage on the finality port): unnecessary, and it would have made CORE
  rail-aware.
- **A BOLT11 library** (`bolt11`, `light-bolt11-decoder`): heavy native /
  bitcoinjs footprint or no signature verification, and permissive parsing.
- **Verifying the signature only under the expected payee:** a flipped recovery
  id still verifies, while the node pays the key it recovers.
- **Core Lightning, or both backends:** one reference backend now; the port is
  backend-neutral.
- **An unanchored local interlock:** a stale restore could reopen a payment
  hash; the node's own duplicate refusal is defence in depth only.
- **Frontera-level retry or invoice refresh:** never; refresh is the
  application's or protocol's business.
- **Binding P12 / finality by network only:** a payment hash names an invoice,
  not a payment — another node on the same network may have paid (or failed to
  pay) the same invoice. Network identity alone let such a node complete or fail
  this execution; the payer identity is bound instead.
- **Inferring a payer for pre-v2 reservations** from whichever node is
  configured: it would defeat the binding; v1 files are refused.
- **Plain `http://localhost`:** a hostname resolved by the OS; a literal
  loopback IP is deterministic.
