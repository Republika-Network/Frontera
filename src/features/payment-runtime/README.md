# Payment Runtime (PAY-01)

> **A payment is a governed action. It compiles down to the envelope, is
> decided on the unchanged governed path, and reaches a rail only as a
> granted, normalized instruction.**

Architecture: `docs/payments/PAYMENT_ARCHITECTURE.md`. Rail contract:
`docs/payments/PAYMENT_ADAPTER_CONTRACT.md`. Decision record:
`docs/architecture/ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md`.

| file | what it owns |
| --- | --- |
| `domain/payment-intent.ts` | `PaymentIntent`, the closed purpose vocabulary, and `validatePaymentIntent` — fail-closed, machine-readable violations, P9 amount ingress. |
| `domain/payment-grammar.ts` | The opaque reference, destination-kind and envelope-identifier grammars; secret-shaped property names. |
| `domain/payment-asset.ts` | `describePaymentAsset` — a descriptive reading of a P9 asset identifier. Never authority. |
| `domain/payment-governance.ts` | The CORE-03 payment dimensions and profile parameters, the host binding, the destination ↔ counterparty encoding, and `compilePaymentIntent`. |
| `domain/payment-execution.ts` | `PaymentExecutionRequest` and `preparePaymentExecution` — the prepared payment, derived from a `ValidatedExecutionAction` alone. |
| `domain/payment-rail.ts` | The `PaymentRail` contract, `PaymentRailResult`, and its mapping onto `ExecutionAdapterResult`. |
| `services/payment-rail-execution-adapter.ts` | `createPaymentRailExecutionAdapter` — a rail composed as an ordinary `ExecutionAdapter`. The only place a rail is invoked. |
| `rails/xrpl/` | PAY-02: the XRPL / RLUSD rail (`createXrplRlusdRail`) and its SDK client; PAY-03: the submission-interlock port and restart quarantine. A rail **below** the contract — the contract never imports it. `docs/payments/XRPL_RLUSD_RAIL.md`; production composition (Host, external signer, durable interlock, P12 resolver) in `src/enterprise/xrpl-payment-rail/`, `docs/payments/XRPL_PRODUCTION_COMPOSITION.md`. |

What the contract (`domain/`, `services/`) will never do: implement a rail,
hold a key, sign, submit, poll, convert an asset, read a clock, perform I/O,
decide whether a payment is allowed, or be imported by Frontera's core.
Rails live under `rails/`, each held to its own boundary test.
`tests/payment-runtime-boundaries.test.ts` fails the build if any of that
changes. `tests/payment-rail-fixture.ts` is the test-only reference rail.
