# ADR: x402 v2 as a second protocol at PAY-04's boundary — the paying side, executed only where a Frontera rail already performs the scheme's payment (PAY-08)

- Status: accepted
- Phase: PAY-08 — x402 Protocol Adapter
- Status of implementation: `src/features/payment-runtime/protocols/x402/` (the
  pure adapter) and `src/enterprise/x402-payment-protocol/` (the composition
  edge: the `exact` / `lnbtc` binding, presentation, post-settlement proof,
  `PAYMENT-RESPONSE` evidence). Embedder-composed; no Host route, module,
  configuration or package export.
- Depends on: `ADR-PAYMENT-PROTOCOL-ADAPTER-BOUNDARY.md` (PAY-04, including
  D13), `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01),
  `ADR-PAYMENT-SETTLEMENT-RECEIPTS-AND-OBLIGATIONS.md` (PAY-05),
  `ADR-LIGHTNING-RAIL.md` (PAY-06), `ADR-PAYMENT-RAIL-CONFORMANCE-SUITE.md` (PAY-07).
- Upstream pin: `x402-foundation/x402` @ `f8f83309706b14cc696962f0a002eeeb66c3dc26`, protocol version 2.
- Canonical documentation: `docs/payments/PAY-08-X402-PROTOCOL-ADAPTER.md`.

## Context

x402 v2 separates `PaymentRequired`, `PaymentPayload`, the transport
representation, scheme / network logic and a facilitator's `/verify` and
`/settle`. Its examples are EVM; its `exact` scheme has per-network bindings,
two of which are on networks Frontera has rails for: `exact` on XRPL and
`exact` on Bitcoin Lightning (`lnbtc`). PAY-04 already owns protocol ingress:
a synchronous, pure `PaymentProtocolAdapter` port, a business-operation store
anchored at CORE-07, and the rule that everything is durable before
`govern()`. Frontera's two rails each perform a payment **themselves**, once,
below a grant.

## Decisions

**D1 — A protocol adapter, at PAY-04's port, on the paying side.** x402 is
implemented as a second `PaymentProtocolAdapter` (`protocolId: 'x402'`) beside
MPP, composed into the unchanged PAY-04 ingress. Frontera is the client: no
resource-server or facilitator mode (a reference server exists in tests only).
No second ingress, no x402 store, no x402 execution or payment id.

**D2 — Network-neutral adapter, trusted bindings.** The adapter parses the v2
types strictly and selects by **trusted execution mappings** matched exactly on
`(scheme, network, asset)`; it names no network. What a scheme means on a
network is a trusted `X402NetworkBinding` composed for it. Merchant order never
selects; trusted mapping priority does, and two different offers under the
best mapping are refused as ambiguous.

**D3 — Execute only where a rail already performs the scheme's payment.**
`exact` on `lnbtc` is a *client-submitted* method: the payer pays the BOLT11
invoice itself and presents the preimage. That is exactly PAY-06's governed
send, so x402 adds no money-moving path. `exact` on XRPL is
*facilitator-submitted*: the client hands the merchant a signed, unsubmitted
transaction. Releasing such authority would be a new execution mode below the
grant (a new rail behaviour), so XRPL x402 is parsed but not executable, and
so is every EVM / Solana offer. PaymentIntent is not reshaped for any of them.

**D4 — Flows.** `upfront` is supported for `lnbtc` only (its only flow);
`authorization` is enabled by no binding; `escrow` is never executable
(composition refuses it); unknown flows are skipped (spec §6.1).

**D5 — Instrument identity is PAY-04's challenge identity.** x402 has no
server-issued challenge id. The challenge key is `x402:2:<instrument>` where the
binding names the merchant-unique payment instrument (lnbtc: `<network>:<payment
hash>`, the scheme's consumption key); the evidence is the exact selected
requirement. PAY-04's rules then hold unchanged and CORE-07-anchored: one
invoice, one business operation; a changed term under the same invoice is a
conflict; a changed invoice under the same operation is a different purchase.
Not chosen: a content-only requirement digest (identical requirements recur
for honest repeat purchases) and an operation-scoped key (PAY-04's context has
no principal, and changing the port was not justified).

**D6 — Synchronous port, asynchronous verification: prepare, then read.**
PAY-04's `interpret` is synchronous; PAY-06's BOLT11 decoder verifies
signatures asynchronously. Decoding is a pure function of the invoice text, so
the edge awaits `adapter.prepare(carrier)` (PAY-06's decoder per mapped
candidate) and then calls the existing ingress; `interpret` reads only the
memo, refusing anything unprepared. The port is not changed. The memo doubles
as the rail's trusted invoice source (by payment hash **and** payee). Not
chosen: an asynchronous port (a PAY-04 contract change for every protocol) or
trusting structural decoding until the rail re-verifies (governance would run
on unverified payee data).

**D7 — The resource is the request, exactly.** A trusted resolver maps PAY-04's
opaque `target` to the URL (and bound header values) the network layer sent;
`resource.url` must be byte-identical; the scheme's request hash is recomputed
from that trusted request and must equal both the server's echo and the
invoice's signed description hash. PAY-04's protected-request binding (target,
method, RFC 9530 digest) stays the semantic one. No URL normalization, no URL
stored, nothing fetched.

**D8 — Exact amounts under trusted scale.** `amount` (atomic) ÷ 10^scale, text
only, with the scale from the mapping and P9 validating the result. Never from
`extra.decimals`, `extra.name` or the asset text.

**D9 — The PaymentPayload exists only after PAY-05 settlement.** The edge
builds `PAYMENT-SIGNATURE` from PAY-04's verified context (the exact governed
requirement), PAY-05's `readSettlement` (`settled`, same request, destination
and amount), and the preimage from PAY-06's read-only node reader, verified
against the governed payment hash. No key, no signature, no wallet SDK. The
value is returned redacted except through `reveal()`. Extension echo is exact:
server extensions unchanged; client names only added, never overwriting.

**D10 — No facilitator, no outbound HTTP.** The paying side never calls
`/verify` or `/settle` and makes no request; `PAYMENT-RESPONSE` and HTTP 200
are evidence read against the governed terms, never PAY-05 settlement.

**D11 — One additive rail-side field.** PAY-06's decoder returns the signed
description hash (`descriptionHash`) when present. Nothing else in a rail
changes; the rail never reads it.

## Consequences

- x402 reaches money only through `ingress.prepareAndGovern` → `govern()` →
  the bounded grant → PAY-01's bridge → PAY-06's one send (EP-071). NO_BYPASS:
  unchanged, ten of seventy-one.
- MPP and x402 produce the same governed intent for the same payment through
  the same ingress: PAY-04's boundary is protocol-neutral in fact, not only by
  intent.
- CORE, PAY-01, PAY-04, PAY-05, P11 and P12 are unchanged; PAY-07's CORE
  manifest gains two `outside` classifications.
- Residuals (`PAY-08-X402-PROTOCOL-ADAPTER.md` §23): upfront commits before the
  resource; no merchant authenticity; the request resolver is trusted;
  refreshed challenges conflict; embedder-composed only; simulator-qualified.
