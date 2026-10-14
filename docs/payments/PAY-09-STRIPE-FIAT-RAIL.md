# PAY-09 — Stripe / USD Fiat Rail

> **One governed USD payment becomes at most one Stripe destination charge —
> a PaymentIntent created unable to charge, durably bound to the governed
> execution, and confirmed once — under the unchanged PAY-01 rail port, P11,
> P12 and PAY-05.**

Status: IMPLEMENTED (test-mode, simulator-qualified; multi-rail hardened — one
organization composes Stripe beside Lightning and XRPL, §10.1). Former P14 Stripe half,
deliberately pulled forward; defined from the current architecture, not from
P14's scope. Decision record: `docs/architecture/ADR-STRIPE-FIAT-RAIL.md`.

| Where | What |
| --- | --- |
| `src/features/payment-runtime/rails/stripe/` | The rail (pure): configuration, exact money, identifiers, destination, the external Stripe port, the shared status classification, the idempotency key, the interlock port, `createStripeRail` |
| `src/enterprise/stripe-payment-rail/` | Composition edge: the HTTPS adapter (the one outbound site, NO_BYPASS EP-072), the durable CORE-07-anchored interlock, the P12 resolution authority, the PAY-05 finality authority, the webhook signal boundary |
| `src/enterprise/__tests__/pay09-*.test.ts`, `pay07-stripe-edge.ts` | Governed exit proofs, interlock, HTTPS wire, webhooks, structure; the PAY-07 canonical suite run against Stripe |
| `src/enterprise/authority-state-freshness/` (CORE-07 v2), `pay07-multi-rail-coexistence.test.ts`, `pay09-multi-rail-coexistence.test.ts`, `authority-state-freshness-namespaces.test.ts` | Multi-rail hardening: namespaced CORE-07 slots, same-organization coexistence of every qualified rail (`docs/architecture/ADR-AUTHORITY-STATE-NAMESPACED-SLOTS.md`) |

## 1. What is qualified — exactly

| Axis | Qualified |
| --- | --- |
| Stripe product | Payments API v1, **PaymentIntents**, one **destination charge** per governed payment (Connect, `transfer_data[destination]`) |
| Charge model | `capture_method=automatic`, `confirmation_method=manual`, `allowed_payment_method_types=[card]`, confirmed `off_session=true` with `error_on_requires_action=true`; no `application_fee_amount`, no `transfer_data[amount]`, no `on_behalf_of` |
| Currency | **USD only** (scale 2, cents), from trusted configuration |
| Source | A governed account mapped by trusted configuration to an opaque Stripe Customer id + saved PaymentMethod id |
| Destination | A Stripe Connect connected account id, allowlisted by configuration |
| Mode | **Test mode only.** No live flag exists; live keys, live accounts and live objects are refused |
| API version | `2026-09-30.endive`, sent explicitly on every request |
| SDK | None. A rail-local HTTPS adapter over Node's `https` (§4.3) |
| Rail id | `stripe-usd` |
| Qualification | Deterministic Stripe simulator below the external port + loopback wire tests + the PAY-07 canonical suite. **No real Stripe test-mode run** — no credentials were available (§20) |

Not qualified, and not implied: "Stripe support" in general; any other
currency; live mode; separate charges and transfers, direct charges,
payouts, refunds, manual capture, Checkout, Payment Links, invoices,
subscriptions, bank debits or any asynchronous payment method; disputes.

## 2. Generic contract audit — Stripe fits unchanged

| Generic contract | Stripe mapping | Change? |
| --- | --- | --- |
| `PaymentIntent.source.accountId` | the governed account; configuration maps it to Customer + PaymentMethod (execution configuration, never authority) | none |
| `PaymentIntent.destination {kind, reference}` | `{ kind: 'stripe-connected-account', reference: 'acct_…' }` — the reference **is** the connected account id, so the counterparty the Kernel, policy, P10 and the grant bind is the real account | none (a host-vocabulary kind, as `lightning-invoice` and `xrpl-tagged-account`) |
| `PaymentIntent.amount` (P9) | exact canonical USD decimal → integer cents (text / `BigInt`) | none |
| `PaymentExecutionRequest` | read as is; `executionId` derives the idempotency keys | none |
| `PaymentRail` / `PaymentRailResult` | `completed` / `not-completed` / `unconfirmed`; `externalReference` = PaymentIntent id | none |
| P11 provider reference | the PaymentIntent id — opaque; generic code only binds and compares it | none |
| `ExecutionResolutionAuthority` (P12) | read-only, retrieves the bound PaymentIntent by id | none |
| `PaymentFinalityAuthority` (PAY-05) | read-only; facts under `stripe.`; method `stripe.payment-intent-succeeded.v1` | none |
| `PaymentSettlementRecord`, `PaymentReceipt` | generic, unchanged; one verifier | none |
| CORE-07 | the existing rail-neutral slot `payment-initiation-reservations` | none |
| PAY-07 conformance suite | run unchanged against Stripe — 16 / 16, parity with XRPL and Lightning | none (one asset-keyed fix in the shared *world*: §19) |

No generic field, vocabulary word, state kind or payment contract was added.
As first built, no CORE byte changed. The **multi-rail hardening changes CORE
on purpose, in CORE-07 only** (six files under
`src/enterprise/authority-state-freshness/`: the generic namespace dimension,
protocol v2, the reference witness's v2 storage and migration): the PAY-07
CORE source manifest moves from `sha256:aecf58de…aaa1c60b` (`main @ 919c175`)
to `sha256:c5246efd…b67ef87b`, still 564 files, and is identical across the
three rails' runs (`pay07-multi-rail-qualification.test.ts`). No payment,
P11, P12, PAY-05 or ASSURE-01 CORE file changed.

## 3. Why destination charges

The Frontera payment is "move this exact amount from this governed account to
this destination". Stripe's money models differ materially:

| Stripe model | Maps to Frontera? | Decision |
| --- | --- | --- |
| **PaymentIntent destination charge** (charge the payer's saved PaymentMethod on the platform; transfer the full amount to a connected account) | **Yes**: source = the payer's instrument, destination = the connected account, amount = the charge = the transfer (no fee / transfer amount set) | **Qualified** |
| PaymentIntent on the platform alone (collection) | The destination would always be the platform — the governed destination would be meaningless | Rejected |
| Direct charges (on the connected account) | The PaymentIntent lives in the connected account: the platform credential, P12 and finality would act in N accounts; Customer/PaymentMethod would need cloning | Rejected (account context per destination) |
| Separate charges and transfers | Two financial effects (a charge, then a transfer) for one governed payment — two money-moving calls, two failure points | Rejected (a future rail mode) |
| Transfers (platform balance → connected account) | Source would be the platform's balance, not a governed payer instrument | Rejected (a future rail mode) |
| Payouts | Balance → bank account; not a payment between parties | Rejected |
| Authorization + manual capture | Two money-relevant calls; `requires_capture` must never be silently captured by P12 | Rejected (`requires_capture` is inconsistent) |
| Refunds | A reversal of a settled payment — PAY-05 models refunds as new governed payments | Not in PAY-09 (§15) |

Semantics stated, not hidden: without `on_behalf_of` the **platform is the
merchant of record** (settlement merchant) for a destination charge; Stripe
fees, refunds and disputes are debited from the **platform**; the connected
account receives the full governed amount. A deployment whose connected
accounts are in another region than the platform would need `on_behalf_of`
(Stripe's cross-border rule) — not qualified; such a deployment is refused by
Stripe at creation, before anything can charge.

## 4. Official sources consulted (2026-10-13)

| Source | Used for |
| --- | --- |
| `docs.stripe.com/api/payment_intents/object` | status vocabulary, `amount` (eight digits; USD max 99 999 999), `amount_received`, `capture_method` (default now `automatic_async`), `confirmation_method`, `client_secret` ("should not be stored, logged, or exposed"), `latest_charge`, `livemode`, `transfer_data` |
| `docs.stripe.com/api/payment_intents/create` | `confirm` (default false), `off_session` / `error_on_requires_action` "only with confirm=true", `transfer_data`, `on_behalf_of`, `application_fee_amount`, `allowed_payment_method_types` |
| `docs.stripe.com/api/payment_intents/confirm` | `off_session`, `error_on_requires_action`; "If payment fails, the PaymentIntent transitions to the `requires_payment_method` status or the `canceled` status if the confirmation limit is reached" |
| `docs.stripe.com/payments/paymentintents/lifecycle` | status meanings; cancellation "invalidates the PaymentIntent for future payment attempts, releases any held funds, and can't be undone"; a failed attempt returns to `requires_payment_method` |
| `docs.stripe.com/api/idempotent_requests`, `docs.stripe.com/error-low-level` | keys ≤ 255 characters; "remove keys … after they're at least 24 hours old"; results saved only after execution begins; 500s cached and indeterminate; network errors leave the outcome unknown |
| `docs.stripe.com/webhooks` (manual verification), `docs.stripe.com/events/manage-webhook-endpoints` | `t=`/`v1=` scheme, `"<t>." ‖ raw body`, HMAC-SHA256, constant-time comparison, ignore non-`v1`, 300 s library tolerance (never 0), raw body required, events unordered and possibly duplicated |
| `docs.stripe.com/connect/destination-charges` | merchant of record, full-amount transfer, platform pays fees, refunds (`reverse_transfer`) and disputes debit the platform |
| `docs.stripe.com/testing` | official test PaymentMethods (`pm_card_visa`, `pm_card_visa_chargeDeclined`, `pm_card_authenticationRequired`, …); "use test API keys in all API calls" |
| `docs.stripe.com/keys` | `sk_test_` / `rk_test_` / `pk_test_` vs `sk_live_` / `rk_live_`; restricted keys with per-resource permissions |
| `docs.stripe.com/api/versioning`, `docs.stripe.com/changelog/endive` | current version `2026-09-30.endive`; Endive's breaking changes |

### 4.1 API version

`STRIPE_API_VERSION = '2026-09-30.endive'`, the current version on the date
above and the one `stripe-node` 23.0.0 pins. It is sent as `Stripe-Version`
on every request and is a **required** configuration value that must equal
the constant (`CFG-9`) — the account default is never relied on. Endive's
breaking changes were read; the one that touches this model — *"Removes the
payment method types parameter from Payment Intents and Setup Intents"* — is
why the adapter sends `allowed_payment_method_types[0]=card`. None of the
Connect, Checkout, Billing, Treasury or Radar changes touches the four
requests PAY-09 makes. A version upgrade is a deliberate change of one
constant, re-audited.

### 4.2 Date assumptions

Stripe's documentation states current behaviour; nothing here relies on
undocumented behaviour. The status table (§12) and the idempotency window
(§10.4) are restated from the sources above as of 2026-10-13.

### 4.3 SDK decision — none

`stripe` on npm, audited at **23.0.0** (released 2026-10-01): MIT, zero
runtime dependencies, Node ≥ 20, pins `2026-09-30.endive`. Not adopted:

- its Node default `maxNetworkRetries` is **2** — automatic re-sending is what
  the rail must never do for the confirmation, and a default is a value one
  configuration slip away;
- it materializes complete objects — `client_secret`, `next_action`,
  payment-method details — into values the rail would then have to avoid;
- the rail needs four requests. A narrow adapter over Node's own `https`
  (`stripe-https-client.ts`) makes every property visible in one file: fixed
  origin, pinned version, no retry, no redirect, bounded responses, closed
  field copy, key in the closure only. It mirrors PAY-06's LND REST adapter.

The SDK is not a dependency of Frontera (`stripe-rail-boundaries.test.ts`).
The webhook scheme was nevertheless **cross-checked against the SDK**: a
script outside the repository fed headers produced by
`stripe.webhooks.generateTestHeaderString` (23.0.0) to Frontera's verifier
(accepted), fed Frontera-test headers to `stripe.webhooks.constructEvent`
(accepted), and a one-byte tamper (refused).

## 5. Exact money

```
P9 canonical USD decimal (text)  →  integer cents (BigInt)  →  form field `amount` (decimal text)
"0.01" → 1     "1" → 100     "75" → 7500     "75000" → 7500000     "999999.99" → 99999999
```

No float, no rounding, no exponent, no `Number` for money anywhere in the rail
(`stripe-rail-boundaries.test.ts`). Sub-cent, zero, negative, exponent and
non-canonical values are refused; above Stripe's documented eight digits is
refused before anything is contacted. Stripe's integer fields cross the
adapter only as non-negative **safe** integers turned into decimal text; a
float, a string or a huge number makes the answer unreadable. The scale is
trusted configuration (`asset.scale` must be 2), never inferred from Stripe.
Minimum charge: 50 cents by default (Stripe's documented USD minimum),
configurable upward only. Tests: FIAT-1 … FIAT-10 (`stripe-amount.test.ts`).

## 6. Source, destination and the PCI boundary

- **Source.** `fundingSources: [{ accountId, customerId, paymentMethodId }]`
  — exactly those three keys (a fourth key, e.g. a card number, is refused by
  shape, its value never read); one entry per governed account; one governed
  account per PaymentMethod.
- **Destination.** `connectedAccounts: ['acct_…']` — an allowlist; the platform
  itself is refused; duplicates refused. Configuration can refuse a governed
  destination, never substitute one.
- **No raw card data — ever.** Frontera never receives, stores or forwards a
  PAN, expiry, CVC or bank credential. It holds opaque Stripe ids only
  (Customer, PaymentMethod, connected account). The card was saved with Stripe
  by whatever onboarding the deployment runs (out of Frontera's scope). PAY-09
  adds **no PCI scope** beyond what an integration that only references
  Stripe ids has. Structural tests forbid card-data vocabulary in the rail and
  scan the durable interlock file for card numbers, client secrets, keys and
  email addresses.
- **Customer data minimized.** No email, name or address is requested, read
  or stored. The finality evidence carries a domain-separated **commitment**
  to the Customer + PaymentMethod pair, not the ids themselves.
- **Not authority.** A funding source or destination in configuration grants
  nothing; authority is identity, policy, the P10 ceiling, the grant and the
  exercise checkpoint, all settled before the rail is reached.

## 7. Configuration and the test-mode guard

`createStripeRailConfiguration` (branded, frozen) requires `mode: 'test'` (the
only accepted value — there is no live flag in PAY-09), the pinned
`apiVersion`, the `platformAccountId`, `currency: 'usd'`, `asset.scale: 2`,
`captureMethod: 'automatic'`, the funding sources and the connected accounts.
Live mode is refused four times over:

1. configuration: `mode` other than `'test'` → refused (`CFG-2`);
2. HTTPS adapter: only `sk_test_…` / `rk_test_…` keys; `sk_live_` / `rk_live_`
   and anything else refused at composition;
3. before every reservation, the credential's account must be the configured
   platform account in test mode;
4. every PaymentIntent read must say `livemode: false` (a live object is
   inconsistent, never a completion).

## 8. The external Stripe port

`stripe-port.ts`: `StripePaymentReader` (`retrieveAccount`,
`retrievePaymentIntent`) and `StripePaymentPort` (the reader +
`createPaymentIntent` — `confirm=false`, moves no money — +
`confirmPaymentIntent`, **the one money-moving operation**). `readOnlyStripe`
builds a fresh frozen reader with no create or confirm; the P12 and finality
authorities and the webhook boundary get only that (and can be given a
read-only restricted key, enforced by Stripe). Answers are a neutral,
**closed** view — 18 fields, ids prefix-checked, statuses from the documented
vocabulary, cents as text — read by `readStripePaymentIntentView`; an extra
key (e.g. a `client_secret`) makes an answer unreadable.

### 8.1 The HTTPS adapter (EP-072)

| Method | Request |
| --- | --- |
| `retrieveAccount` | `GET /v1/account` |
| `retrievePaymentIntent` | `GET /v1/payment_intents/{id}` (404 `resource_missing` → not found) |
| `createPaymentIntent` | `POST /v1/payment_intents` — `amount`, `currency=usd`, `customer`, `payment_method`, `confirm=false`, `capture_method=automatic`, `confirmation_method=manual`, `allowed_payment_method_types[0]=card`, `transfer_data[destination]`, `metadata[frontera_execution_id]`, `metadata[frontera_rail_id]`; `Idempotency-Key: frontera:stripe-usd:<execution>:create` |
| `confirmPaymentIntent` | `POST /v1/payment_intents/{id}/confirm` — `off_session=true`, `error_on_requires_action=true`; `Idempotency-Key: …:confirm`. A `402` whose body carries the PaymentIntent is read as that PaymentIntent |

Fixed origin `https://api.stripe.com` (system trust store). No configurable
base URL; a simulator is reachable only through `testOrigin`, which accepts
nothing but plain `http` to a literal loopback IP (decided from the URL, never
resolved). `agent: false`; no redirect followed (3xx refused); no retry;
deadline on every call; 1 MiB response bound; errors are closed reasons
(status classes), never Stripe's message, which can echo a key. A TCP
connection that never opened → `StripeRequestNotSentError` (provably not
sent); anything after it → unknown.

### 8.2 Secret boundaries

| Secret | Where it lives | Never in |
| --- | --- | --- |
| API key (`sk_test_` / `rk_test_`) | the adapter's closure, the `Authorization` header | configuration, request, P11, P12, settlement, receipt, ASSURE trace, interlock, logs, errors, health — canary-tested |
| Webhook signing secret (`whsec_`) | the webhook module's closure | anything persisted or returned — canary-tested |
| `client_secret` | **never read**: the adapter does not copy it; an answer containing it is unreadable; the id grammar refuses `_secret_` | every Frontera value |
| Metadata | `frontera_execution_id`, `frontera_rail_id` only — bounded correlation, compared, never authority | — |

## 9. One governed execution → at most one confirmation

```
prepare    asset USD; exact cents within bounds; source → trusted Customer + PaymentMethod; destination → allowlisted account   refusal → not-completed
recorded?  an execution the interlock holds is NEVER created or confirmed again                                             → unconfirmed
account    the credential is the configured platform, in test mode (read)                                                    refusal → not-completed
RESERVE    durable, CORE-07-anchored: every term, the platform account, both idempotency keys                                refusal → not-completed
create     POST PaymentIntent, confirm=false — cannot charge; the answer must restate every term, status requires_confirmation refusal → not-completed
BIND       durable, CORE-07-anchored: execution ↔ PaymentIntent id                                                            refusal → not-completed
confirm    ONCE — the only request that can move money                                                                        → P11
```

**Why create, then bind, then confirm.** A single create-and-confirm POST
would leave a crash between the request and the response with **no
PaymentIntent id** — P12 could then only search by metadata, which is not
identity. Creating with `confirm=false` cannot charge; binding the id durably
before the confirmation means every confirmation that can ever have been sent
names a PaymentIntent P12 can retrieve exactly. `confirmation_method=manual`
means the PaymentIntent can be confirmed only with a secret key — never with a
`client_secret` — so an orphan (created, never bound) can never charge.

**External effects per governed execution:** at most one creation (no money),
exactly zero or one confirmation (money). P12, finality, readiness and
webhooks add zero of either (tests count them).

### 9.1 What "exactly once" means here

Frontera does not claim distributed exactly-once. It claims: **one governed
execution causes at most one Stripe confirmation, of one PaymentIntent bound
to it, under the qualified model** — through the durable interlock (one
reservation, one binding per execution; one execution per PaymentIntent), the
bound object identity, deterministic idempotency keys, and no automatic retry
after any ambiguity.

### 9.2 Crash and ambiguity windows

| Window | What is durable | Outcome |
| --- | --- | --- |
| before the reservation | nothing | nothing at Stripe; the governed path never re-invokes a claimed execution |
| after the reservation, before / during the creation | the reservation | P11 `not-completed` if the rail is alive (creation failed: no money possible); after a crash: no P11 observation, P12 `unresolved` (no PaymentIntent bound — absence is never evidence), the rail never creates for it again (`SIL-7`) |
| after the creation, before the binding | the reservation | an orphan PaymentIntent in `requires_confirmation`; never confirmed (`SIL-10`) |
| after the binding, before the confirmation | reservation + binding | never confirmed again; P12 reads `requires_confirmation` → `unresolved` (a confirmation could still be in flight) |
| the confirmation sent, answer lost / timed out / 5xx | reservation + binding | P11 `unconfirmed`; P12 retrieves the bound PaymentIntent → completed / not completed / unresolved; no second confirmation (`SIL-6`, governed CRASH AFTER REQUEST) |
| the confirmation provably never left (TCP never connected) | reservation + binding | P11 `not-completed PROVIDER_UNAVAILABLE` |

Precedent: PAY-03 / PAY-06 — a crash between reservation and effect stays
P12-unresolved until an operator resolves it (PROD-03-02); the binding-before-
confirmation invariant is what lets an operator establish safely that no
confirmation was sent.

## 10. The durable interlock

`createSqliteStripePaymentInterlock` — PAY-06's pattern, Stripe's terms:

- SQLite, WAL, `synchronous=FULL`, append-only (triggers refuse UPDATE and
  DELETE), version-guarded schema `aoc.stripe-payment-interlock.schema.v1`;
- two entry kinds in one hash chain — `reservation`, `binding` — with
  `UNIQUE (execution_id, kind)` and `UNIQUE (payment_intent_id)`;
- the anchor binds the file to the organization, rail id, mode and **platform
  account**: a file bound to another platform account is refused unmutated;
- **integrity from genesis**: every read and every write decision recomputes
  every row's digest and the whole chain (PAY-06's safer pattern, not PAY-04's
  cached head), plus the history's own rules (a binding follows its
  reservation, once, for a PaymentIntent no other execution holds);
- **multi-process**: witness compare-and-advance + `BEGIN IMMEDIATE` re-decide
  on the same head — four Hosts racing one execution produce one creation and
  one confirmation (`SIL-5`, worker threads, one file, one witness).

### 10.1 CORE-07

The reservation history is anchored under the existing rail-neutral kind
**`payment-initiation-reservations`** (PAY-06): "the append-only history that
binds each governed execution to the one rail-level payment it may initiate".
Every write is a witnessed transition; every read holds the head against the
witness; an unreachable witness refuses before anything is created (`SIL-9`).
PAY-09 adds no state kind.

**Multi-rail hardening (R1 closed).** As first built, the witness kept one
store per `(kind, organization)`, so a Stripe interlock opened where a
Lightning interlock already held the kind was refused at genesis, and vice
versa — reproduced on the merged tree, both orders, as
`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED` from `genesisStoreId`. Fail closed, but
not a multi-rail architecture. CORE-07 now has a **generic, closed namespace
dimension** (protocol v2): `payment-initiation-reservations` is a *namespaced*
kind, and each interlock anchors in `(payment-initiation-reservations,
organization, <its configured rail id>)` — `stripe-usd` here, `lightning-btc`
for PAY-06. CORE gives the namespace no meaning and names no rail; the
namespace is the trusted, validated configuration rail id, never anything from
a request or from Stripe, and a non-canonical rail id refuses the interlock at
open. Every other kind's slot is byte-for-byte unchanged.
`docs/architecture/ADR-AUTHORITY-STATE-NAMESPACED-SLOTS.md`.

Proved for one organization, one witness, one state directory: both open in
either order and both execute (`COEX-1 … COEX-4`, XRPL composed alongside);
advancing one leaves the other's witnessed checkpoint byte-identical
(`COEX-5`, `COEX-6`); a stale restore or a same-sequence fork of one is
refused while the other keeps executing (`COEX-7 … COEX-10`); either store
presented in the other's namespace — relabelled checkpoint, misconfigured rail
id, or the file itself — is refused (`COEX-11`, `COEX-12`); witness outage at
open refuses both, and on one rail's path refuses only that rail before any
effect (`COEX-13`, `COEX-14`); a prepared-but-uncommitted transition refuses
only its own rail; both restart in either order (`COEX-15`, `COEX-16`). A
second Stripe store under the **same** rail id is still refused (`SIL-12`).

### 10.2 Backup / restore

A stale restore of the interlock (losing a binding of a payment already
confirmed) is refused at open with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`; a
lost (empty) file is refused too — the witness holds the slot beyond genesis
(`SIL-8`, PAY-07 MRC-15). Restoring the interlock **and** the witness as one
snapshot defeats this — CORE-07's deployment prohibition, restated.

### 10.3 Idempotency keys

`frontera:<rail id>:<execution id>:create|confirm` — derived from the
server-derived execution identity only (deterministic across processes and
restarts; no random value, no clock); non-sensitive; ≤ 255 characters (an
execution id that would not fit is replaced by its SHA-256, still
deterministic). Both keys are stored in the reservation.

### 10.4 Why Stripe idempotency is not the safety mechanism

Stripe keeps v1 keys "at least 24 hours" and may prune them after; it saves no
result when a request failed validation or collided with a concurrent one.
Frontera's guarantee must survive restarts, long outages, restores and any
retention window, so it is the interlock's. The keys are **defence in
depth**: inside the window a duplicate that reached Stripe collapses onto the
first. Tested: replay after the simulator pruned every key → still zero
additional effects.

## 11. Account identity binding

The credential's account is read (`GET /v1/account`) before every
reservation and must equal `platformAccountId`; the reservation records it; the
interlock file is anchored to it. P12 and finality first prove the reader acts
as **that** account (and is a test-mode credential), then retrieve the bound
PaymentIntent. A reader for another account — even one that, adversarially,
knows a `succeeded` object under the same id — proves nothing: `unresolved` /
`not-final` (`P12-S9`, account-substitution finality test). The Account object
carries no mode flag; the mode is the credential's (test prefix), and every
PaymentIntent's own `livemode` is checked.

## 12. P11 mapping

| Stripe proves | `PaymentRailResult` | P11 |
| --- | --- | --- |
| `succeeded`, every bound term exact, `amount_received` = `amount` | `completed`, ref = PaymentIntent id | `confirmed-completed` |
| `requires_payment_method` **with** `last_payment_error` (the one confirmation failed; e.g. a decline, `authentication_required`) | `not-completed PROVIDER_REJECTED` | `confirmed-not-completed` |
| `canceled` | `not-completed PROVIDER_REJECTED` | `confirmed-not-completed` |
| the confirmation never left the process | `not-completed PROVIDER_UNAVAILABLE` | `confirmed-not-completed` |
| `processing` | `unconfirmed` | `unconfirmed` |
| `requires_action` | `unconfirmed` (never re-confirmed; no interactive flow) | `unconfirmed` |
| `requires_confirmation` / `requires_payment_method` without an error | `unconfirmed` | `unconfirmed` |
| `requires_capture` | `unconfirmed` (automatic capture only; never captured) | `unconfirmed` |
| a timeout, reset, 5xx, unreadable or inconsistent answer | `unconfirmed` | `unconfirmed` |

**Frontera never reconfirms a failed PaymentIntent (trust assumption, C11).**
`requires_payment_method` with a `last_payment_error` is Frontera's *one*
confirmation attempt failing, recorded as `confirmed-not-completed`. Stripe
itself would accept a new confirmation of that same object (with a new
payment method); Frontera never sends one — the execution is reserved and
bound, the rail answers every replay from the record, and nothing in PAY-09
confirms twice. An actor **outside** Frontera holding the platform's Stripe
write authority could still confirm it later. If that happens, Frontera's P11
observation stays `confirmed-not-completed` (P11 is immutable; P12 resolves
only `unconfirmed` initial observations and never rewrites a definitive one),
nothing settles or receipts on the strength of it, and the money that moved is
outside the governed record — reconciled operationally, like any out-of-band
use of the key (R9, R13). Frontera does **not** cancel failed PaymentIntents
automatically: a cancellation is another Stripe mutation with its own
ambiguity windows, and it would not stop a key holder from creating a new
object anyway. Regression: `OUT-OF-BAND RECONFIRMATION (C11)` in
`pay09-stripe-governed.test.ts`.

**SCA.** Off-session with `error_on_requires_action=true`: a payment that
needs the customer fails deterministically (`authentication_required` →
`not-completed`) instead of stopping for a browser challenge. A
`requires_action` that nevertheless appears is `unconfirmed`, never completed
and never confirmed again. PAY-09 builds no UI/SCA flow.

## 13. P12 resolution authority

`createStripeResolutionAuthority` (`frontera.stripe-usd-payment-intents`):
reads the interlock record, requires rail, mode and platform account in scope
and a bound PaymentIntent equal to the P11 handle and amount, proves the
reader's account, retrieves **that** PaymentIntent and applies the shared
classification: `succeeded` exact → `confirmed-completed`; failed / canceled →
`confirmed-not-completed PROVIDER_REJECTED`; everything else — processing,
action, confirmation pending, capture pending, not found, unreachable,
unreadable, any term different, another account — `unresolved`. It holds a
reader only: no create, confirm, capture, cancel or refund exists on it.
Matrix P12-S1 … P12-S12 in `pay09-stripe-governed.test.ts`.

## 14. PAY-05 finality

`createStripeFinalityAuthority` (`frontera.stripe-usd-finality`, method
`stripe.payment-intent-succeeded.v1`), the unchanged PAY-05 port.

**Meaning of "settled" for PAY-09: processor-confirmed successful payment
under Stripe's PaymentIntent state** — the bound PaymentIntent `succeeded`
with `amount_received` equal to the governed amount, on the bound platform
account, to the governed connected account, from the governed source's saved
instrument. It is **not** irreversible funds, legal finality, funds available
for payout, or chargeback-proof settlement; the evidence states it
(`stripe.finality-basis = processor-confirmed`).

| Stripe fact about the bound PaymentIntent | Answer |
| --- | --- |
| `succeeded`, every term exact | `final` |
| another amount / amount received / currency / destination / funding / charge model; `requires_capture`; failed; canceled | `contradicted` (nothing recorded) |
| processing, pending, not found, unreachable, unreadable; another object or execution (metadata); a live object; another account | `not-final` |

Evidence facts (sorted, bounded, deterministic): `stripe.amount-cents`,
`stripe.currency`, `stripe.destination-account`, `stripe.finality-basis`,
`stripe.funding-commitment`, `stripe.latest-charge` (provider metadata, never
parsed), `stripe.mode`, `stripe.payment-intent`, `stripe.platform-account`,
`stripe.status`. No `finalizedAt` (Stripe states no finality instant), no raw
response, no client secret, no Customer or PaymentMethod id. The receipt is
PAY-05's generic `frontera.payment-receipt.v1`, verified by the one verifier.

## 15. Refunds, disputes and reversals — residuals, not impossibilities

Card payments can later be **refunded**, **disputed** (for destination
charges Stripe debits the dispute and fees from the **platform**) or
reversed. PAY-09 does not pretend otherwise and implements none of them:

- refunds stay PAY-05's model — a refund is a new governed payment with its own
  settlement; a Stripe refund operation would be a separate, future rail
  operation (with `reverse_transfer` decided deliberately); no automatic refund;
- disputes are post-settlement reversal risk; a later milestone may consume
  authenticated `charge.dispute.*` events into CORE-04 payment obligations;
- a `settled` PAY-09 payment is therefore never described as irreversible.

## 16. Webhooks — optional signals, not authority

`createStripeWebhookSignals`: verify-before-parse on the **exact raw bytes**
(bounded 64 KiB; `t` + every `v1`; 300 s tolerance; HMAC-SHA256 with the
`whsec_` secret; constant-time comparison; non-`v1` ignored), then a snapshot
`payment_intent.*` event in test mode from the platform (not a connected
account), then the interlock read: **a reconcile hint naming the bound
execution** — never a status, certainty or resolution. Event ids are
deduplicated in a bounded window (delivery hygiene, not payment idempotency);
arrival order is never read as event order; P12 always retrieves the current
PaymentIntent. The module holds **no Stripe client** — no create, confirm,
capture, refund or transfer can follow from a webhook — and writes nothing. No
production webhook ingress (route) ships: an embedder that runs one passes the
raw body and header in. WH-1 … WH-10 in `pay09-stripe-webhook.test.ts`.

## 17. Fees

The governed amount is the **principal**: what the payer is charged and what
the connected account receives (no `application_fee_amount`, no
`transfer_data[amount]`). Stripe's processing fees are debited from the
platform and are not governed by P7 / P10 — a documented residual, as
XRPL's network fee and Lightning's routing fee (PAY-07 R4). No generic fee
governance is invented.

## 18. Effect paths (NO_BYPASS)

One new effect path: **EP-072**, the Stripe confirmation (and the
non-charging creation that precedes it), through the one request primitive of
`stripe-https-client.ts` — PROVEN — PATH LOCAL, below the bounded-grant gate
like EP-069 / EP-071; composition-gated (embedder-composed only; no route,
Host module, configuration or package export). P12, finality and webhook
readers are EP-054-kind read-only queries with no money effect. The webhook
module makes no outbound request. Eleven of seventy-two effect paths are under
bounded-grant control.

The Agent Passport Web application's Stripe **billing** integration is a
separate effect domain (NB-004 / §11.1 of NO_BYPASS) and remains the only
user of the Stripe SDK; PAY-09 does not touch it. A deployment should use a
**different Stripe platform account** for governed payments than for Agent
Passport billing.

## 19. Qualification

| Suite | What it proves |
| --- | --- |
| `stripe-amount.test.ts` | FIAT-1 … FIAT-10 |
| `stripe-rail.test.ts` | CFG-1 … CFG-10, DEST-1 … DEST-6, the P11 table, SCA, ambiguity, not-sent, creation and interlock failures, replay, Stripe-key pruning, concurrency, idempotency keys, log hygiene, readiness |
| `stripe-rail-boundaries.test.ts` | dependency boundary, the one confirmation and its order, no retry vocabulary, no network / SDK, no card data, no client secret, no credential, no float |
| `pay09-stripe-https-client.test.ts` | the wire: key boundary, fixed origin, exact create / confirm forms, closed copy (no `client_secret`), 402 PaymentIntent, closed errors, redirect, size, not-sent vs unknown, a full rail run over loopback |
| `pay09-stripe-interlock.test.ts` | SIL-1 … SIL-12: uniqueness, tamper, triggers, file hygiene, four-Host race, restart, crash windows, stale restore, witness outage, scope; SIL-12 — Stripe beside Lightning of the same organization, each in its own namespaced slot, and a second store under the same rail id refused |
| `pay09-stripe-governed.test.ts` | success → PAY-05 → receipt; denial; over-ceiling; revoked before effect; replay; crash after request → restart → P12; processing; requires_action; definitive failure; out-of-band reconfirmation (C11); P12-S1 … S12; FIN-S1 … S8; account substitution |
| `pay09-multi-rail-coexistence.test.ts` | COEX-5, COEX-6, COEX-9 … COEX-14, pending isolation, namespace provenance — Lightning and Stripe interlocks of one organization at one witness |
| `pay07-multi-rail-coexistence.test.ts` | the PAY-07 coexistence extension: COEX-1 … COEX-4, COEX-7, COEX-8, COEX-15, COEX-16 over the XRPL, Lightning and Stripe edges in one organization (the canonical suite is unchanged) |
| `authority-state-freshness-namespaces.test.ts` | CORE-07 v2: NS-1 … NS-3, LEGACY-1 … LEGACY-4, SCOPE-1 … SCOPE-6, MIG-1 … MIG-4, RESCOPE-1 … RESCOPE-3 |
| `pay09-stripe-webhook.test.ts` | WH-1 … WH-10 |
| `pay09-stripe-structure.test.ts` | CORE and generic-port purity, no Stripe in CORE, EP-072 inventory, PCI and secret structural proofs |
| `pay07-multi-rail-qualification.test.ts` | the canonical suite run against XRPL, Lightning **and Stripe**: 16 / 16 each, identical verdicts, effect counts and generic lifecycles, identical CORE manifest digest, deterministic reports |

**PAY-07.** Stripe runs the unchanged canonical suite through the unchanged
shared world and its own edge (`pay07-stripe-edge.ts`); no case was skipped,
weakened or branched. One harness fix in the shared world: it registered USD
itself and then the rail's asset, so a USD rail would have defined USD twice;
the world now registers the rail's asset once when it **is** the world's USD
(same scale required). It is keyed on the asset definition, not on the rail.

## 20. Real Stripe test-mode qualification — not performed

No Stripe credential was present in the environment (variable names
inspected only; none matched `STRIPE*`), and no Stripe CLI was installed.
Per the milestone rules, implementation proceeded with the deterministic
simulator and loopback wire tests. **No live or test-mode Stripe request was
made by this qualification.** A real test-mode run should exercise, with
official test PaymentMethods only: success (`pm_card_visa`), a decline
(`pm_card_visa_chargeDeclined`), off-session authentication
(`pm_card_authenticationRequired`), retrieval / P12, and an idempotent
duplicate — against a test platform with one test connected account holding
the `transfers` capability.

## 21. Mutation qualification

Each mutation was applied to the real source, the targeted suites run, and
the file restored byte for byte (`git diff --exit-code`).

| # | Mutation | Caught by |
| --- | --- | --- |
| M-S1 | remove the durable reservation before the creation | `stripe-rail.test.ts`, `stripe-rail-boundaries.test.ts`, `pay09-stripe-interlock.test.ts` |
| M-S2 | interlock: drop the one-reservation-per-execution decision | `pay09-stripe-interlock.test.ts` |
| M-S3 | randomize the idempotency key | `stripe-rail.test.ts` |
| M-S4 | confirmation timeout → `not-completed` | `stripe-rail.test.ts`, `pay09-stripe-governed.test.ts` |
| M-S5 | `processing` → completed | `stripe-rail.test.ts`, `pay09-stripe-governed.test.ts` |
| M-S6 | P12 calls confirm | `pay09-stripe-structure.test.ts` (the authority holds only a reader, so the call is also inert at runtime) |
| M-S7 | finality / P12 correlation skips the amount check | `pay09-stripe-governed.test.ts` |
| M-S8 | … skips the currency check | `pay09-stripe-governed.test.ts` |
| M-S9 | … skips the destination check | `pay09-stripe-governed.test.ts`, `stripe-rail.test.ts` |
| M-S10 | finality skips the account identity check | `pay09-stripe-governed.test.ts` (account substitution) |
| M-S11 | accept a live key (both adapter guards removed) | `pay09-stripe-https-client.test.ts` |
| M-S11b | accept `mode: 'live'` in configuration | `stripe-rail.test.ts` (CFG-2) |
| M-S12 | float cents conversion (`parseFloat × 100`) | `stripe-amount.test.ts`, `stripe-rail-boundaries.test.ts` |
| M-S13 | a second PaymentIntent on replay (both rail guards removed) | `stripe-rail.test.ts` (replay, concurrency) |
| M-S14 | a webhook triggers a confirmation | `pay09-stripe-webhook.test.ts` (WH-7), `pay09-stripe-structure.test.ts` |
| M-S15 | `client_secret` copied into the view | `pay09-stripe-https-client.test.ts` |
| M-S16 | the generic `PaymentRail` imports Stripe | `payment-runtime-boundaries.test.ts`, `stripe-rail-boundaries.test.ts` |
| M-S17 | the canonical suite branches on Stripe | `pay07-multi-rail-structure.test.ts` |

Two first-attempt mutations survived because they removed only **one of two
redundant guards**, which is defence in depth working as designed: removing
only the adapter's `_live_` refusal leaves the test-key grammar refusing live
keys, and removing only the rail's early `recorded()` return leaves the
reservation's `execution-recorded` answer stopping the replay. Each was re-run
with both guards removed (rows M-S11 and M-S13) and caught. M-S1's first form
was caught only by the type checker; its re-run with a type-preserving cast
was caught by three suites.

### 21.1 Multi-rail hardening mutations (M-C1 … M-C9)

Applied to the built tree (M-C9 to the TypeScript its structural test reads),
the targeted suites run with `--test-force-exit`, and each file restored and
checked byte for byte by SHA-256. All killed.

| # | Mutation | Failing tests (count) / examples |
| --- | --- | --- |
| M-C1 | remove the namespace from the witness key | 27 — e.g. COEX-1, COEX-10, COEX-11, COEX-12, COEX-13, COEX-14 |
| M-C2a | witness ignores the namespace when reading a binding | 26 — e.g. COEX-1, COEX-10, COEX-11, COEX-12, COEX-13, COEX-14 |
| M-C2b | client ignores the namespace when matching a receipt's binding | 1 — SCOPE-2 (C4) |
| M-C3 | Stripe anchors under Lightning's namespace | 20 — e.g. COEX-1, COEX-10, COEX-11, COEX-12, COEX-13, COEX-14 |
| M-C4 | a stale Stripe interlock accepted after rollback | 2 — COEX-7, SIL-8 |
| M-C5 | a stale Lightning interlock accepted after rollback | 2 — COEX-8, IL-9 |
| M-C6 | the namespace omitted from the canonical (signed) receipt binding | 2 — SCOPE-2, SCOPE-3 |
| M-C7 | a namespaced read falls back to the legacy un-namespaced slot | 2 — MIG-1 / LEGACY-3, RESCOPE-1 |
| M-C8 | merge resolution drops the `trade-runtime` classification | 3 — PAY-07 drift, TRADE "classified outside", TRADE "classification is exact" |
| M-C9 | the namespace taken from payment input instead of `scope.railId` | 1 — namespace provenance (structural) |

A first M-C1 run did not terminate: under the mutation, the coexistence
harness's second edge refused to open (the mutation was detected), but the
already-opened XRPL edge's signer process was left running and held the test
process open. The harness now closes the edges it opened before rethrowing,
and the run was repeated: killed.

### 21.2 Combined-tree re-run (current `main` through `d04b8b6`, TRADE-03)

After `main` (TRADE-03) was merged in, the merge-sensitive mutations were
re-applied to the combined built tree, each file restored byte for byte. All
killed.

| # | Mutation | Failing tests (count) / examples |
| --- | --- | --- |
| M-C8 | the manifest drops `trade-runtime` | 3 — PAY-07 drift, TRADE "classified outside", TRADE "classification is exact" |
| MX-1 | the manifest drops `trade-risk-context` | 1 — PAY-07 drift |
| MX-2 | the manifest drops `stripe-payment-rail` | 1 — PAY-07 drift |
| MX-3 | the P7 unit maximum back to 64 bytes | 3 — K2 (65 / 93 bytes) in the domain, in-memory and SQLite ledgers |
| MX-4 | the witness protocol back to v1 | 5 — MIG-1 / LEGACY-3, RESCOPE-1, … |
| M-C3 | Stripe anchors under Lightning's namespace | 11 — COEX-5, COEX-6, … |
| M-C6 | the namespace omitted from the signed receipt binding | 2 — SCOPE-2, SCOPE-3 |
| M-S5 | `processing` → completed | 9 — PROCESSING, P12-S1, … |
| M-S17 | the canonical suite compares a rail id to `stripe-usd` | 1 — suite vocabulary |

M-S17 in this form first survived: the suite's vocabulary test named XRPL and
Lightning words only. It now also refuses Stripe words, the `stripe-usd` rail
id and the `USD` asset in the suite's code. Separately, the durable-record
secret-hygiene test scanned raw SQLite bytes for any 13–19 digit run and so
matched decimal runs inside random SHA-256 hex digests (about one digest in
twenty-four; the test failed 4 of 30 isolated runs); a digit run adjacent to a
lowercase hex character no longer counts, and a PAN between quotes or
punctuation still does (40 of 40 runs pass).

## 22. Residuals

| # | Residual |
| --- | --- |
| R1 | **Closed** by the multi-rail hardening: payment-initiation slots are namespaced by rail id; Stripe and Lightning coexist in one organization — §10.1 |
| R2 | No real Stripe test-mode run (no credentials) — simulator and loopback wire qualification only — §20 |
| R3 | Live mode not qualified; no live flag exists |
| R4 | `settled` = processor-confirmed; refunds, disputes and reversals remain possible after settlement and are not modelled — §15 |
| R5 | Platform is merchant of record; cross-region connected accounts (`on_behalf_of`) not supported |
| R6 | Stripe fees are not governed (principal only) — §17 |
| R7 | A crash after the reservation and before / between the creation and binding leaves the execution P12-unresolved until an operator resolution (PAY-03 / PAY-06 precedent) |
| R8 | An orphan PaymentIntent (created, never bound) remains in `requires_confirmation` at Stripe; it can never charge (`confirmation_method=manual`, never confirmed by Frontera) but is not cancelled automatically |
| R9 | The credential, the platform account's integrity and Stripe's reports are trusted; a compromised key outside Frontera can confirm or refund directly at Stripe — a deployment-key-custody matter (use restricted keys; a dedicated platform account) |
| R10 | Embedder-composed only: the shipped Host neither composes the Stripe rail nor backs up its interlock |
| R11 | Card only; asynchronous payment methods (bank debits) and their `processing → failed` reversals are not qualified |
| R12 | `PaymentExecutionRequest.notAfter` is not consumed (as on XRPL and Lightning — PAY-07 R3) |
| R13 | Out-of-band reconfirmation (C11, ACCEPTED / TRUST): a failed PaymentIntent can be confirmed again by an actor holding the platform's Stripe write authority; Frontera never does, and never rewrites its P11 `confirmed-not-completed` — §12 |
| R14 | Same-snapshot restore (CORE-07's stated assumption): an interlock and the witness restored together to one earlier consistent moment cannot be told apart from the present — the witness database must never share the interlock's restore domain |
| R15 | A Lightning interlock anchored before the hardening (a v1-witness, un-namespaced slot) is refused until the operator rescopes its slot (`rescopeLegacyAuthorityStateBinding`) — never adopted silently |

## 23. Re-run

```
npm run build
node --test dist/src/features/payment-runtime/rails/stripe/tests/*.test.js
node --test dist/src/enterprise/__tests__/pay09-*.test.js
node --test dist/src/enterprise/__tests__/pay07-multi-rail-*.test.js
node --test dist/src/enterprise/__tests__/authority-state-freshness-*.test.js
```
