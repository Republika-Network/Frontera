# Monetary Runtime (P9)

> **Money is exact data with an explicit asset, and whether an action moves
> money is the host's call.**

A pure primitive every layer of the governed financial-action spine imports —
and it imports nothing. Decision record:
`docs/architecture/ADR-CANONICAL-MONETARY-SEMANTICS.md`.

| file | what it owns |
| --- | --- |
| `domain/canonical-decimal.ts` | The one canonical decimal form, the one boundary normalization (`canonicalizeDecimalText`), exact `BigInt` compare and add. |
| `domain/monetary-asset.ts` | The trusted asset registry: one identifier ↔ one `{ assetId, scale }`, frozen, no aliases, unknown fails closed. |
| `domain/monetary-amount.ts` | `MonetaryAmount`, the single ingress `parseMonetaryAmount`, registry-free well-formedness for downstream layers, and `compareMonetaryAmounts` — `'incomparable'` across assets. |
| `domain/financial-action.ts` | The host-trusted `FinancialActionClassifier`: one input (the action identifier), two classes. |

What it will never do: convert an amount to or from a number, round, truncate,
convert between assets, read a clock, or perform I/O.
`tests/monetary-boundaries.test.ts` fails the build if any of that changes.
