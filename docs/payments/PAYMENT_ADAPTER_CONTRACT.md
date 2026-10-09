# Payment Rail Adapter Contract (PAY-01)

What a payment rail implementation must satisfy. Architecture:
`docs/payments/PAYMENT_ARCHITECTURE.md`.

## Interface

```ts
import { createPaymentRailExecutionAdapter, type PaymentRail } from 'src/features/payment-runtime';

interface PaymentRail {
  readonly railId: string; // semantic identifier; recorded as the adapter that performed the effect
  execute(request: PaymentExecutionRequest): Promise<PaymentRailResult>;
}

type PaymentRailResult =
  | { status: 'completed'; externalReference?: string; detail?: string }
  | { status: 'not-completed'; reason: ExecutionFailureReason; externalReference?: string; detail?: string }
  | { status: 'unconfirmed'; externalReference?: string; detail?: string };
```

Composition — the rail is never called any other way:

```ts
const adapter = createPaymentRailExecutionAdapter({ rail, binding: createPaymentGovernanceBinding({ action: 'payment.send' }) });
createEnterprise({ authorityControlledExecution: { executionAdapter: adapter, /* … */ } });
// or one child per rail under executionAdapterRouting, with the trusted selectAdapter.
```

## The request

`PaymentExecutionRequest` — `executionId`, `requestId`, `decisionId`,
`grantId`, `notAfter`, `source { accountId }`, `destination { kind, reference }`,
`amount { value, unit }`, `purpose`, optional `reference` and `rail`. Every
value was bounded by the grant; nothing else is present. The request is
frozen.

## A rail MUST

1. Execute **only** the instruction it is handed. It decides nothing: amount,
   approval, destination trust, authority and emergency stops were settled
   before the request existed.
2. Use `executionId` as its idempotency key toward the provider.
3. Make **at most one** provider submission per `execute()` and never retry
   on its own initiative.
4. Report `completed` only when the provider confirmed the instruction.
5. Report `not-completed` only when the provider provably did not act — with
   a reason from `ExecutionFailureReason` (`PROVIDER_REJECTED`,
   `PROVIDER_UNAVAILABLE` only when the request provably never reached the
   provider, `PROVIDER_RESPONSE_INVALID`, `ADAPTER_ERROR`).
6. Report `unconfirmed` whenever the provider was, or may have been,
   contacted and the outcome is unknown (timeout after send, connection
   reset, 5xx, an accepted-but-pending answer).
7. Keep `externalReference` an opaque provider handle (≤ 512 printable
   characters, never a URL or credential) and `detail` a bounded token
   (`insufficient-funds`), never a provider body.
8. Hold any credential or signing capability in its own trusted composition;
   never place one in a result, a reference or a detail.

## The bridge guarantees

- The rail is invoked only from `createPaymentRailExecutionAdapter`, which is
  invoked only by the execution runtime's gate after a usable grant exercise.
- A validated action that is not exactly a payment under the binding, or a
  payment granted for a different rail, never reaches the rail
  (`failed: ADAPTER_ERROR`, detail `payment-execution-not-prepared` /
  `payment-rail-not-preferred`).
- A rail that throws or returns something unreadable is recorded
  `unconfirmed` (`payment-rail-result-unreadable`) and handed to P12.
- The rail's id and `execute` are snapshotted at composition.
- Unsafe references and details are dropped, never repaired; they never
  change the outcome.

## Qualification

`src/features/payment-runtime/tests/payment-rail-fixture.ts` is the reference
rail — in-memory, no external effect, test-only. A later milestone (PAY-03)
turns these rules into a reusable rail conformance suite.
