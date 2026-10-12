# MPP payment protocol adapter (PAY-04)

> **An MPP challenge is a merchant's proposal. It becomes the canonical
> `PaymentIntent` and is governed on the unchanged path; it is never
> authority.**

The first implementation of PAY-04's protocol-neutral `PaymentProtocolAdapter`
(`../../domain/payment-protocol.ts`). Pinned to `draft-httpauth-payment-01` and
`draft-payment-intent-charge-00` (tempoxyz/mpp-specs `08e7dd8`), unchanged from
P13. Architecture: `docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md`. Decision
record: `docs/architecture/ADR-PAYMENT-PROTOCOL-ADAPTER-BOUNDARY.md`.

| file | what it owns |
| --- | --- |
| `mpp-grammar.ts` | RFC 9110 challenge tokenizer, strict base64url, fatal UTF-8, bounded JCS-canonical JSON, RFC 3339 — pure, total, no dependency. |
| `mpp-challenge.ts` | One `Payment` challenge validated against the draft: required parameters exactly once, duplicates refused, unknown parameters dropped unread. |
| `mpp-payment-adapter.ts` | `createMppPaymentProtocolAdapter`: binding, expiry, trusted method normalizers, trusted counterparty resolution, trusted selection → `PaymentProtocolTerms` + challenge evidence. |

What this adapter will never do: authorize, decide policy, select authority,
read a clock, perform I/O, hold or build a credential, sign, call a rail,
submit, resolve settlement or retry. It is imported by no rail and imports no
rail; `tests/mpp-protocol-boundaries.test.ts` fails the build if that changes.
