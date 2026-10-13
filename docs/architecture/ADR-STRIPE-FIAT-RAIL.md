# ADR — Stripe / USD fiat rail (PAY-09)

Status: Accepted (2026-10-13). Context: PAY-01 … PAY-08 merged; PAY-07 proved
rail neutrality across XRPL and Lightning, PAY-08 protocol neutrality across
MPP and x402. PAY-09 was DEFERRED ("former P14 Stripe half, not needed for
CORE PROVEN") and is pulled forward. Detail: `docs/payments/PAY-09-STRIPE-FIAT-RAIL.md`.

## Decision

D1. **One Stripe money model: a PaymentIntent destination charge.** A
governed payment (source = governed account, destination = a Stripe Connect
connected account, amount = exact USD) becomes one PaymentIntent on a trusted
platform account, charging the source's saved PaymentMethod off-session and
transferring the full amount to the connected account. No application fee,
no `transfer_data[amount]`, no `on_behalf_of`. Collection-only, direct
charges, separate charges and transfers, transfers, payouts, manual capture
and refunds are different financial effects and are not combined into this
rail.

D2. **No generic change.** The destination is `{ kind:
'stripe-connected-account', reference: 'acct_…' }` — a host-vocabulary kind
PAY-01 already admits; the reference is the real account id, so governance
binds the account funds go to. Source mapping, Customer and PaymentMethod ids
are rail configuration, not authority. The PaymentIntent id is an opaque P11
reference. PAY-01, P11, P12, PAY-05, ASSURE-01 and CORE-07 are unchanged.

D3. **Create (cannot charge) → bind → confirm once.** `confirm=false` at
creation; the PaymentIntent id is durably bound to the execution before the
one confirmation (`off_session=true`, `error_on_requires_action=true`);
`confirmation_method=manual` so only a secret key can confirm. Every
confirmation that can ever have been sent names a PaymentIntent P12 retrieves
exactly — never a metadata search.

D4. **The durable interlock is the safety mechanism; Stripe idempotency is
defence in depth.** Reservation and binding are append-only, hash-chained,
verified from genesis on every decision, and anchored at CORE-07 in the
existing rail-neutral slot `payment-initiation-reservations`. Idempotency keys
are deterministic (`frontera:<rail>:<execution>:create|confirm`); Stripe's
retention ("at least 24 hours") is never relied on.

D5. **Conservative certainty.** `succeeded` with every bound term exact →
completed; `requires_payment_method` with a payment error or `canceled` →
not completed; `processing`, `requires_action`, `requires_confirmation`,
`requires_capture`, timeouts, resets, 5xx, unreadable or inconsistent answers
→ unconfirmed / unresolved. No automatic second confirmation, ever.

D6. **Account identity is bound.** The credential's account is verified
before every reservation, recorded, and anchored into the interlock file; P12
and finality trust only a reader proving the same account.

D7. **"Settled" means processor-confirmed** under Stripe's PaymentIntent
state — not irreversible, not chargeback-proof. Refunds and disputes remain
post-settlement reversal risks, documented, not modelled.

D8. **Test mode only; no SDK.** Live keys, live accounts and live objects are
refused; no live flag exists. A rail-local HTTPS adapter (fixed origin,
pinned `Stripe-Version: 2026-09-30.endive`, no retry, no redirect, bounded,
closed field copy, key in closure, `client_secret` never read) replaces the
official SDK, whose Node default retries network failures.

D9. **Webhooks are authenticated signals only.** Verified on raw bytes before
parsing; deduplicated; unordered; they yield at most a reconcile hint for P12
and hold no Stripe client.

D10. **PAY-07 unchanged.** Stripe runs the canonical suite through the
unchanged shared world (one asset-keyed fix for a USD rail) and passes 16 / 16
with parity to XRPL and Lightning.

## Consequences

- A fiat rail is governed by the same CORE as two crypto rails, measured
  byte-identical (PAY-07 manifest).
- One payment-initiation interlock per organization: Stripe and Lightning
  cannot both be composed for one organization until CORE-07 gains per-rail
  slots or a multi-rail interlock exists (fail closed meanwhile).
- No real Stripe test-mode run yet (no credentials); live mode, other
  currencies, refunds, disputes, async payment methods and cross-region
  Connect are future, separately qualified work.

## Rejected alternatives

- **Single create-and-confirm POST** — a lost response leaves no object id;
  recovery would need a metadata search or an idempotent re-POST that, after
  key pruning, could charge again.
- **Adding a `stripe-payment-intents` CORE-07 slot** — the rail-neutral slot
  already describes this state; a Stripe word in CORE would repeat PAY-03's
  residual.
- **Destination aliases in configuration** — a config change could redirect a
  granted payment; the real account id in the governed destination cannot be
  redirected by configuration.
- **The official SDK** — automatic retries by default and whole-object
  materialization (`client_secret`) work against the rail's two hardest
  invariants.
