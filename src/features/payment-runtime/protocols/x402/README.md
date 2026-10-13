# x402 payment protocol adapter (PAY-08)

> **An x402 `PaymentRequired` is a merchant's proposal. It becomes the
> canonical `PaymentIntent` and is governed on the unchanged path; it is never
> authority.**

The second implementation of PAY-04's protocol-neutral `PaymentProtocolAdapter`
(`../../domain/payment-protocol.ts`), beside MPP. Pinned to x402 protocol
version 2 at `x402-foundation/x402` `f8f83309706b14cc696962f0a002eeeb66c3dc26`
(`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`,
`specs/schemes/exact/scheme_exact.md`). Architecture:
`docs/payments/PAY-08-X402-PROTOCOL-ADAPTER.md`. Decision record:
`docs/architecture/ADR-X402-PROTOCOL-ADAPTER.md`.

| file | what it owns |
| --- | --- |
| `x402-codec.ts` | Canonical padded base64, fatal UTF-8, strict bounded JSON (duplicate members refused, numbers kept as source text), canonical serialization — pure, total, no dependency, no Node API. |
| `x402-messages.ts` | x402 v2 `PaymentRequired`, `PaymentRequirements`, `ResourceInfo`, extensions, `PaymentPayload`, `SettlementResponse`, read closed; the HTTP carrier (`402` + exactly one `PAYMENT-REQUIRED`); the `PAYMENT-SIGNATURE` encoder with exact server extension echo and additive client info, every extension tree bounded before it is serialized. |
| `x402-payment-adapter.ts` | `createX402PaymentProtocolAdapter`: trusted request (exact resource URL), trusted execution mappings, payment-flow resolution, timeout bound, exact atomic → decimal, trusted network bindings, deterministic selection → `PaymentProtocolTerms` + challenge evidence. |

This directory names no network. A network is understood only through a
trusted `X402NetworkBinding` composed for it; the one PAY-08 ships — `exact`
on Bitcoin Lightning (`lnbtc`) — lives at the enterprise composition edge
(`src/enterprise/x402-payment-protocol/`), the only place x402 meets a rail.

What this adapter will never do: authorize, decide policy, select authority,
read a clock, perform I/O, call a facilitator, hold a key or a proof, build a
`PaymentPayload` before the payment is governed and settled, sign, call a rail,
submit, resolve settlement or retry. It imports no rail and nothing of MPP;
`tests/x402-protocol-boundaries.test.ts` fails the build if that changes.
