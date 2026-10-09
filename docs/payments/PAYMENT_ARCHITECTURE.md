# Payment Architecture (PAY-01)

> **A payment is a governed action. It compiles down to the envelope, is
> decided on the unchanged governed path, and reaches a rail only as a
> granted, normalized instruction.**

- Status: implemented in `src/features/payment-runtime`
- Decision record: `docs/architecture/ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md`
- Rail contract: `docs/payments/PAYMENT_ADAPTER_CONTRACT.md`
- Master plan: `docs/architecture/FRONTERA-MASTER-PLAN.md` — PAY-01

PAY-01 is the first payment-specific layer on top of Frontera's rail-neutral
core. It answers one question: *what is a payment, from Frontera's governance
perspective, before any specific rail executes it?* It does **not** implement
any rail, hold any key, sign anything, submit anything, poll any settlement or
convert any asset.

## 1. Why payments are a vertical, not a core feature

Frontera's core is a governed-action boundary:

```
identity → authority → action intent → obligations → approval → decision
         → grant → execution → outcome → evidence
```

Every one of those stages already handles money. P9 gives the envelope an
exact `MonetaryAmount` in a trusted asset registry; P10 sources per-payment
ceilings from durable authority; P7 enforces cumulative exposure at exercise;
P11 records a three-way provider certainty; P12 resolves an uncertain effect.
None of them knows what a payment *is*, and none of them should: the moment
the core names a rail, it stops being able to govern the next one.

So the payment vocabulary lives in one feature module that the core never
imports (`payment-runtime-boundaries.test.ts` fails the build otherwise):

```
Governed Action  (core, unchanged)
   ↑ compiles to
PaymentIntent    (payment-runtime)  ── validatePaymentIntent · compilePaymentIntent
   ⋮ governed path decides, grants, reserves, claims
PaymentExecutionRequest             ── preparePaymentExecution(ValidatedExecutionAction)
   ↓
PaymentRail      (host-composed)    ── behind createPaymentRailExecutionAdapter → ExecutionAdapter
   ↓
rail-specific implementation        (later milestones)
```

## 2. The payment intent

```ts
interface PaymentIntent {
  source: { accountId: string };                 // the governed account funds leave from
  destination: { kind: string; reference: string };
  amount: { value: string; unit: string };       // P9 MonetaryAmount
  purpose: PaymentPurpose;                       // closed vocabulary
  reference?: string;                            // business reference, a token
  rail?: string;                                 // rail preference, a token
  idempotencyKey: string;
  correlationId?: string;
}
```

Only payment-specific semantics. Everything generic stays with the envelope:

| concern | owner |
| --- | --- |
| who requests (actor, principal, organization) | the bound customer identity |
| when | the orchestrator's clock |
| the payment's identity | governed request id, derived from `idempotencyKey` scoped to `(organization, principal)` |
| authority, ceilings, cumulative exposure | Kernel Authority (P10), exercise controls (P7) |
| decision, obligations, approval, grant | the Kernel and the governed path |
| which rail executes | trusted server-side adapter routing |

A caller who attaches any of those — or `metadata`, a memo, a key, a
credential, anything undeclared — is refused, not ignored.

### Amount

The P9 `MonetaryAmount`, through P9's single ingress (`parseMonetaryAmount`),
unchanged. Decimal **text**, never a number; one canonical spelling
(`"10.50"` → `"10.5"`); never rounded; precision bounded by the asset's
trusted scale; strictly positive. A JavaScript number, `NaN`, `Infinity`, a
sign, an exponent, a separator or a leading zero is refused. No drops, token
decimals or unit conversion exist in the payment model — the scale belongs
to the registry definition.

### Asset

The asset **is** a P9 asset identifier resolved against the deployment's
trusted registry; unknown fails closed. `describePaymentAsset` gives a purely
descriptive reading of the grammar P9 already admits (`namespace:CODE/qualifier`)
— fiat (`USD`), a stablecoin (`stable:USDX`), a network's native asset
(`net:COIN`), a same-coded asset disambiguated by a qualifier
(`net:USDX/acme-bank`) — without giving any namespace a meaning. The third
segment is called a *qualifier*, not any rail's word for it (master plan L-8).
Nothing reads the description to decide anything.

### Source

`{ accountId }` — a reference to a resource this deployment already governs.
It becomes the envelope's `resource`, so the Governance Profile's resource
class (an exact list, no wildcard) **is** the set of accounts a payment may be
drawn from, and authority is granted over it like any other resource. No key,
signer, wallet or rail-specific address form.

### Destination

`{ kind, reference }` — explicit, serializable, opaque. `kind` is a host's own
word for what sort of reference this is (`account`, `beneficiary`,
`payment-address`); `reference` is an opaque identifier: no whitespace, no
`/`, no URL, no credential shape, at most 200 characters. It becomes the
envelope's `counterparty` as `<kind>:<reference>` — one injective encoding —
so policy, the Kernel and the grant's counterparty bound see it on the axis
they already govern. Whether a destination is trusted is authority's and
policy's question, not this contract's.

### Purpose

A closed vocabulary — `vendor-payment`, `treasury-transfer`, `settlement`,
`reimbursement`, `payroll`, `purchase`, `refund` — enough for deterministic
policy to treat payroll differently from a purchase, and no accounting model.

## 3. Governance mapping

| PaymentIntent | GovernedActionIntent | governed axis |
| --- | --- | --- |
| (host binding) | `action` | Kernel `action.type`, grant action bound |
| `source.accountId` | `resource` | `resourceScope`, grant resource set |
| `destination` | `counterparty` (`<kind>:<reference>`) | `counterpartyId`, grant counterparty bound |
| `amount` | `amount { value, currency }` | P9, P10 ceiling, P7 exposure |
| `purpose` | `parameters.paymentPurpose` | CORE-03 token, `exact` |
| `reference` | `parameters.paymentReference` | CORE-03 token, `exact` |
| `rail` | `parameters.paymentRail` | CORE-03 token, `exact` |
| `idempotencyKey` | `idempotencyKey` | replay / conflict |

What a host composes:

1. the payment action identifier (`createPaymentGovernanceBinding`) — host
   vocabulary, not a constant — listed in `monetary.financialActions`;
2. `PAYMENT_PARAMETER_DIMENSIONS` in `governance.parameterDimensions`, and a
   Governance Profile over its payment action class × its governed accounts'
   resource class with `PAYMENT_PROFILE_PARAMETERS`;
3. P10 `max_amount` / `spending_limit` constraints on the authority that
   delegates payments — the per-payment ceiling and cumulative exposure;
4. a rail, composed through `createPaymentRailExecutionAdapter`.

Miss (1) or (2) and the envelope refuses the payment before evaluation. There
is no fallback in which a payment is governed as something less.

### Policy context

Policy sees the payment exactly where it sees any governed action: action and
action class, resource (source) and resource class, `counterpartyId`
(destination), `amount`/`currency`, and the typed parameters
`paymentPurpose`, `paymentReference`, `paymentRail`. Policy packs read them
through the existing generic predicates. No parallel policy engine exists.

### Limits

- **Per-payment ceiling:** P10, `max_amount` on durable authority, enforced at
  issuance (`FINANCIAL_AUTHORITY_CEILING_EXCEEDED`).
- **Cumulative exposure:** P10 `spending_limit`, enforced by P7 at exercise
  with an atomic reservation; settled on completed and unconfirmed, released
  only on a definitive non-completion.
- **Allowed asset:** the registry, and the ceiling's own asset (a different
  asset is incomparable, never converted).
- **Source / destination restriction:** the grant's resource set and
  counterparty bound, and policy over `resourceScope` / `counterpartyId`.

PAY-01 defines the inputs; it adds no rules engine and no exposure ledger.

### Idempotency

The envelope's, unchanged. The governed request id is derived from
`(organization, principal, idempotencyKey)`; the same payment under the same
key replays the committed decision and the recorded outcome, and never reaches
the rail twice; a different payment under the same key is refused
(`GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`). Compilation is deterministic (equal
payments compile to byte-identical intents), so the request digest is a
function of the payment alone. `executionId` is derived from the committed
decision and is stable across replays; a rail uses it as its own idempotency
key toward its provider.

## 4. Execution boundary

Nothing payment-specific runs until the governed path has: decided, committed
the decision, satisfied obligations and approval, issued the bounded grant,
re-read it from the authoritative store, proven the exact attempt inside it,
passed the emergency interlock, reserved P7 capacity, and written the
write-ahead claim. Only then does the execution runtime hand a
`ValidatedExecutionAction` to the composed adapter — and for a payment that
adapter is `createPaymentRailExecutionAdapter(...)`.

**Preparation** (`preparePaymentExecution`) is pure and deterministic: it
derives the `PaymentExecutionRequest` from the validated action alone —
source from the grant's resource, destination from its counterparty, the
amount proven within the ceiling, purpose / reference / rail from the
exact-bound parameters, the execution and correlation ids, the grant id and
its `notAfter`. It carries no actor, organization, decision, policy result,
grant scope, digest or secret. A validated action that is not exactly a
payment under the binding is `failed: ADAPTER_ERROR` and the rail is **not**
invoked.

**Rail selection** is the existing trusted server-side routing
(`executionAdapterRouting.selectAdapter`); a payment's `rail` preference is a
governed parameter routing may honour, and a rail asked to execute a payment
granted for a different rail refuses before contacting anything.

## 5. Outcome mapping

```
PaymentRailResult   ExecutionAdapterResult   GovernedActionResult    P11 certainty
completed        →  completed             →  executed             →  confirmed-completed
not-completed    →  failed(reason)        →  execution_failed     →  confirmed-not-completed
unconfirmed      →  unconfirmed           →  execution_unconfirmed →  unconfirmed
throw / unreadable → unconfirmed          →  execution_unconfirmed →  unconfirmed
```

No new outcome vocabulary and no new failure codes: `reason` is the existing
`ExecutionFailureReason`; payment specifics (`insufficient-funds`,
`destination-refused`) are a bounded token `detail`. A rail result that cannot
be read is **unconfirmed**, not failed — the rail was invoked, so a failure
would release capacity and invite a second payment. An unconfirmed payment
enters the existing P12 flow: it is never retried, and an operator resolution
(or a host-composed resolution authority) records whether it completed. There
is no payment-specific resolution.

`completed` is the provider's confirmation of the instruction, **not** final
settlement (P11). Settlement and receipts are PAY-05.

## 6. Evidence and disclosure

No payment-specific evidence or trace system. The payment lands in the
existing records:

| field | where | AUDITOR | PARTNER | CUSTOMER | PUBLIC |
| --- | --- | --- | --- | --- | --- |
| amount, asset | trace `parameters.amount`, P11 attempt | ✓ | — | — | — |
| purpose, reference, rail | trace `parameters.parameters` | ✓ | — | — | — |
| source account | trace `request.resourceScope` | ✓ | — | — | — |
| decision, grant / withhold / deny | trace `decision`, `authority`, `outcome` | ✓ | ✓ | decision, outcome | presence only |
| execution id | trace | ✓ | ✓ | ✓ | ✓ |
| provider reference (`externalReference`) | trace `outcome.providerRef` | ✓ | ✓ | — | — |
| certainty / failure | trace `outcome` | ✓ | ✓ | ✓ | presence only |
| operator resolution | trace `resolution` | ✓ | ✓ (no attester) | ✓ (no attester) | presence only |
| destination | committed decision record and grant; the trace carries the request by digest | not disclosed in any trace tier | — | — | — |

Never present anywhere: keys, recovery phrases, credentials, bearer tokens.
The payment contract refuses secret-shaped properties by name, references are
refused when credential-shaped, provider references and details pass the
execution runtime's recordable-reference rule, and the existing evidence
redaction applies on top. The ASSURE trace distinguishes intent, decision,
approval, grant/withhold/deny, execution, provider outcome and operator
resolution with its existing stages.

## 7. Future rail integration

A rail milestone implements one interface — `PaymentRail { railId, execute }`
— and composes it with `createPaymentRailExecutionAdapter`. It may hold
credentials or signing through its own trusted composition (PAY-03); none of
that crosses the request or reaches evidence. It must use `executionId` as its
provider idempotency key, never resubmit on its own, and report `unconfirmed`
when it cannot prove the outcome. A rail-specific status query for P12 is an
`ExecutionResolutionAuthority`, already a generic port.

Nothing in the payment intent, the governance mapping or the execution request
needs to change for a new rail.

## 8. Not in PAY-01

No rail implementation of any kind, no SDK dependency, no signing or custody,
no submission, no settlement polling, no exchange rates, no liquidity
routing, no destination allowlist beyond the existing counterparty bound and
policy, no protocol parsing (PAY-02), no public HTTP route, no new store and
no export from the frozen package entrypoints.
