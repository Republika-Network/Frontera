# PAY-06 — Lightning Rail Adapter

> **The same Frontera CORE, unchanged, governs Lightning.** A canonical
> `PaymentIntent` in BTC to a Lightning destination compiles through PAY-01,
> is decided and granted by the unchanged spine, reaches the Lightning rail
> only through PAY-01's bridge, becomes at most one logical Lightning payment
> for one verified BOLT11 invoice, and is settled by PAY-05 only on a verified
> preimage — through the rail, resolution and finality ports exactly as they
> stood before Lightning existed.

- Status: implemented — `src/features/payment-runtime/rails/lightning/` (the rail),
  `src/enterprise/lightning-payment-rail/` (embedder composition edge: LND node
  adapter, durable interlock, P12 and PAY-05 authorities)
- Decision record: `docs/architecture/ADR-LIGHTNING-RAIL.md`
- Master plan: PAY-06 · Invariants: SEC-INV-263 … SEC-INV-275 · Threat model: §7.32 ·
  Effect path: EP-071

## 1. Why Lightning is the proof

XRPL (PAY-02 / PAY-03) was the first rail, delivered before any second one,
so it could have shaped the ports. Lightning differs from it on every axis
that would expose rail-specific authority logic:

| axis | XRPL | Lightning |
| --- | --- | --- |
| payment model | account-based ledger transaction | invoice-based, HTLC routed |
| proof of payment | validated transaction | payment preimage |
| finality | deterministic ledger close | HTLC settlement |
| fees | fixed network fee | routing fees, path-dependent |
| counterparty | destination address (+ tag) | invoice payee node + payment hash |
| asset | issued assets | BTC only |
| signing | external customer signer (PAY-03) | the payer node signs internally |

PAY-06 implemented Lightning **without changing any generic contract**: not
`PaymentIntent`, not the compiler, not `PaymentExecutionRequest`, not
`PaymentRail`, not the bridge, not P11, not P12's `ExecutionResolutionAuthority`,
not PAY-05's `PaymentFinalityAuthority`, its evidence or its receipt. The only
change outside the payment vertical is one rail-neutral CORE-07 slot name
(`payment-initiation-reservations`, §12) — the same kind of addition PAY-03,
PAY-04R and PAY-05 each made. That is the design test's answer: the ports were
rail-neutral.

## 2. The path

```
PaymentIntent { destination: { kind: 'lightning-invoice', reference: '<payee>:<payment hash>' }, amount: { value: '0.0025', unit: <BTC asset> }, rail: 'lightning-btc', … }
   ⋮ compilePaymentIntent → governed path → Kernel / policy / P10 / grant / P7 / claim        (PAY-01 + CORE, unchanged)
createPaymentRailExecutionAdapter({ rail: createLightningRail({ configuration, node, invoices, interlock }), binding })
   ↓ PaymentExecutionRequest
Lightning rail  (rails/lightning)
   prepare (asset, exact msat, source, destination) → interlock.recorded? → invoice (trusted source) → strict BOLT11
   → node: network, identity, its own decoding == ours → RESERVE (durable, CORE-07) → expiry again → sendPayment ONCE
   ↓ PaymentRailResult: completed | not-completed | unconfirmed (+ payment hash)
P11 → P12 (Lightning resolution authority, read-only, by payment hash) when unconfirmed
PAY-05 → Lightning finality authority (read-only): preimage hashes to the payment hash → settled → receipt
```

## 3. Rail-neutrality audit

| layer | change |
| --- | --- |
| Kernel, grant, recognition, generic policy, P7, P10, governed-action path, P11, P12 contracts, CORE-04, P9 | **none** — no Lightning word, no Lightning import (`pay06-lightning-structure.test.ts`) |
| PAY-01 contract (intent, governance, execution request, rail port, bridge) | **none** |
| PAY-04 protocol port and MPP | **none** — MPP names no rail; protocol terms with a Lightning destination become a canonical intent |
| PAY-05 finality port, evidence, settlement, receipts, obligations, refunds | **none** — Lightning proof travels as `lightning.`-prefixed facts |
| CORE-07 | one slot name, rail-neutral: `payment-initiation-reservations` |
| XRPL rail | **none**; XRPL and Lightning never import each other |

Each generic contract was checked against Lightning and found sufficient:
`destination { kind, reference }` carries payee + payment hash within PAY-01's
grammar; `externalReference` carries the payment hash; P12's query carries the
P11 handle and amount the authority binds to; PAY-05's evidence carries a
`providerRef`, the canonical terms and up to 16 normalized facts; `finalizedAt`
is optional and Lightning omits it (§15). No deficiency justified a generic
change, so none was made. PAY-07 owns the multi-rail conformance suite.

## 4. Specification baseline (pinned)

**BOLT #11** and **BOLT #9** at `lightning/bolts`
`14901bdcacee53d95b46dc276b0f09c85d7d71fd` (2026-03-09; `11-payment-encoding.md`
SHA-256 `d2ede88b25ca3017e8cce7cc313a88d3b6a780d34ded2d403b996b2a8c7e9810`). The
spec's own test vectors are pinned verbatim in
`rails/lightning/tests/bolt11-spec-vectors.ts` with this decoder's answer.

| element | behaviour |
| --- | --- |
| encoding | Bech32 (BIP-0173) without the 90-character limit, replaced by a deployment bound (default 2 048, absolute 7 089 — LND's); one case only (uppercase read as lowercase), mixed case refused |
| prefix | `lnbc` mainnet · `lntb` testnet · `lntbs` signet · `lnbcrt` regtest; anything else refused |
| amount | digits, no leading zero, `m` / `u` / `n` / `p`; `p` must end in `0`; exact `BigInt` msat; zero refused |
| timestamp | 35 bits; must not be beyond `maximumClockSkewSeconds` in the future (rail) |
| payment hash `p` | exactly one, `data_length` 52 |
| payment secret `s` | exactly one, `data_length` 52 (required since bolts #1242) |
| description `d` / `h` | exactly one of them; `d` valid UTF-8 (fatal); neither is ever returned or interpreted |
| `n` | `data_length` 53; when present the signature is verified under it and must be low-S |
| signature | compact secp256k1 over SHA-256(hrp ‖ padded data); without `n`, the payee is **recovered** with the stated recovery id (high-S accepted) |
| expiry `x` | minimal encoding; default 3 600 s; checked with a margin by the rail |
| `min_final_cltv_expiry_delta` `c` | minimal encoding; default 18; above `maximumFinalCltvExpiryDelta` (default 1 008) refused by the rail |
| features `9` | minimal; an unknown **even** bit refused; odd bits ignored; every feature dependency set, transitively — `basic_mpp` (16/17) → `payment_secret` (14/15) → `var_onion_optin` (8/9), a feature present when either bit of its pair is set; supported required bits: 8, 14, 16, 48 |
| route hints `r` | whole 51-byte hops starting with a compressed key, ≤ 8 fields — counted, never interpreted |
| fallback `f` | counted, ≤ 4; never used |
| metadata `m` | allowed; never returned |
| unknown tags | skipped (they stay covered by the signature), ≤ 8 |
| duplicates | `p`, `s`, `d`, `h`, `n`, `x`, `c`, `9`, `m` at most once |

**Feature dependencies.** BOLT 11 says a reader **MUST NOT attempt the
payment** when the `9` field does not set every known, transitive feature
dependency; the decoder checks each edge of `BOLT11_FEATURE_DEPENDENCIES`
(hence the closure): `basic_mpp → payment_secret` and `payment_secret →
var_onion_optin`. The first is in BOLT 9's table at the pinned commit. The
second is **not listed there any more** — both bits are `ASSUMED` since
bolts #1310, and BOLT 9 leaves an ASSUMED feature's semantics to the earlier
revisions that defined it, where `payment_secret` depends on
`var_onion_optin`. Frontera keeps that edge deliberately (a fail-closed
policy, not a claim about the pinned table): an invoice offering
`payment_secret` without `var_onion_optin` is malformed under the revisions
defining the feature, and is refused with nothing sent. Real invoices set
both (LND writes 9, 14, 17); every pinned spec vector still decodes as before.
An invoice with no `9` field sets no feature, so no dependency applies.

**Deliberate deviations, both conservative:** the spec vector "Same, but
including fields which must be ignored." carries wrong-length `p`/`h`/`s`/`n`
fields marked "(ignored)", but the pinned requirement text says a reader
**MUST fail** on a wrong fixed length (bolts #1243 removed the old skip rule
and left the vector stale) — refused. The vector "Non canonical signature
(high-S) with 'n' field defined" is refused as intended, but first for a
duplicated `s`; the high-S-with-`n` rule is proven on a generated invoice.

**The high-S recovery vector** recovers `02d0139c…` with its stated recovery
id. Its signature also verifies under `03e7156a…` — any ECDSA signature
verifies under two keys, and the recovery id picks one. Literal recovery is
what libsecp256k1's `secp256k1_ecdsa_recover` (bolts #1284) and btcec's
`RecoverCompact` (LND) compute, confirmed by independent point arithmetic. This
is exactly why the payee is recovered, never merely verified under an expected
key: an invoice whose recovery id is flipped still "verifies" under the real
payee, while the node pays the key it recovers.

Not implemented: BOLT12 offers, LNURL, keysend / spontaneous payments, AMP, x402.

## 5. Decoder decision and dependency audit

**Decision: a narrow, strict decoder in the repository** (`lightning-bech32.ts`,
`lightning-bolt11.ts`), with the only cryptography delegated to mature code:

- `@noble/curves` **2.4.0** (exact pin) — secp256k1 public-key recovery, which
  Node's crypto cannot do. Already shipped in the runtime as a transitive
  dependency of `xrpl` 5.3.0 (`docs/legal/OPEN_SOURCE_DEPENDENCIES.md`): MIT,
  audited, zero dependencies beyond `@noble/hashes` 2.4.0 (also already
  present); promoting it to a direct dependency added one line to the
  lockfile and **no new package**. It is an ES module, loaded with `import()`
  from this CommonJS build, from one production file only
  (`lightning-signature.ts`), and used only to recover and verify — never to
  sign or generate keys.
- Node's own OpenSSL (`node:crypto`) — SHA-256, and an **independent second
  verification** of every signature under the recovered (or `n`) key. Two
  implementations must agree before a payee is believed.

Why not a BOLT11 library: the widely used `bolt11` package pulls in
`bitcoinjs-lib`, native `secp256k1`, `bn.js` and `lodash` and returns
permissive, partially-validated objects; `light-bolt11-decoder` does not verify
signatures at all; neither enforces the pinned spec's MUST-fail rules
(wrong fixed lengths, missing `s`, non-minimal fields, feature dependencies).
Bech32 is a checksum encoding, not cryptography; the decoder is ~300 lines,
total (any input yields a closed refusal), and pinned by every spec vector.

## 6. Destination, invoice identity and counterparty binding

```
PaymentDestination { kind: 'lightning-invoice', reference: '<payee node key>:<payment hash>' }   (131 chars, PAY-01 grammar)
governed counterparty  lightning-invoice:<payee>:<payment hash>                                   (Kernel, policy, P10, grant)
```

The BOLT11 text (typically longer than PAY-01's 200-character reference, and
not authority) is resolved at execution from the embedder's trusted
`LightningInvoiceSource` by payment hash (`createLightningInvoiceBook` is a
minimal in-memory one). Whatever it returns is decoded and paid only if
**payee, payment hash, amount and network** all equal the governed payment —
an invoice source can withhold a payment, never redirect one. The node's
own `DecodePayReq` must then equal Frontera's decoding on payee, payment hash
and amount (a parser differential is a refusal: the node pays what it decodes).

The interlock binds the execution to: payment hash, payee, network, **payer
node identity**, invoice digest (SHA-256 of the canonical invoice text — its
identity, without storing route hints or descriptions), exact amount, the fee
cap and the expiry instant.

**The payer node.** A payment hash names an invoice, not a payment: any node
can try to pay the same invoice, and each keeps its own record of its own
attempt. So the reservation records `payerNodeId` — the compressed identity
key from the **same** `nodeInfo` reading that proved the network and ruled out
a self-payment (`checkNode` returns it; no second read) — and only that node
can later establish P12 or finality facts for the execution (§14, §15). Public
identity only; never a credential. An execution already reserved is never
re-bound: recomposed against another node, the rail answers from the
reservation (`unconfirmed`, `lightning-execution-previously-initiated`) and
sends nothing.
The description and description hash are merchant metadata and never
authority; route hints are routing data the node reads from the invoice, never
identity, authority or evidence.

## 7. Money and asset

PAY-06 moves **BTC only**, under one trusted P9 asset id with registry scale ≤ 11.

```
1 BTC = 100 000 000 sat = 100 000 000 000 msat
canonical BTC decimal  ⇄  integer msat        (text and BigInt only)
```

A value needing a sub-millisatoshi digit, zero, a negative, an exponent or a
number, or more than Bitcoin's supply (21 M BTC, which also bounds LND's int64
msat fields) is refused, never rounded. Node-reported msat values are parsed
from decimal text; a JSON number is never money. No FX, no conversion oracle,
no other asset.

**Amountless invoices are refused** in PAY-06 (`lightning-invoice-amountless`):
the conservative default. Supporting them would mean binding the governed
amount into the node call (`amt_msat`) — a future, explicit extension.

## 8. The node port and the LND adapter

The rail sees a narrow port of domain facts (`lightning-node-port.ts`):
`nodeInfo` (network, identity), `decodeInvoice` (the node's reading),
`paymentStatus(hash)` (one logical payment's state) and `sendPayment` (the one
money-moving operation). Answers are read closed into neutral observations —
`succeeded` (preimage, amount, fee), `failed` (terminal, a neutral reason),
`in-flight`, `not-found` — so no vendor enum, string or transport detail
reaches P11, P12 or a settlement.

**Reference node: LND** (`src/enterprise/lightning-payment-rail/lnd-rest-node.ts`),
over REST with Node's own `https` — no SDK, no gRPC stack. Chosen because
its router API has every property the rail needs natively: an explicit
`fee_limit_msat` enforced by pathfinding before any HTLC is sent; one logical
payment per payment hash with a deterministic status (`FAILED` only once no
HTLC is in flight); preimage, payment hash, delivered amount and fee on the
record; status by hash after any restart (`TrackPaymentV2`); its own invoice
decoding; and macaroons, which let the authorities' credential be one the node
itself refuses to send with. One backend only (no Core Lightning adapter yet).

| port | LND REST |
| --- | --- |
| `nodeInfo` | `GET /v1/getinfo` |
| `decodeInvoice` | `GET /v1/payreq/{invoice}` |
| `paymentStatus` | `GET /v2/router/track/{hash}` — first update, then closed (hash URL-safe base64, padded) |
| `sendPayment` | `POST /v2/router/send` — `payment_request`, `fee_limit_msat`, `timeout_seconds`, `allow_self_payment: false`, `amp: false`, `no_inflight_updates: true` |

**Credential boundary.** The macaroon (hex) and the pinned TLS certificate live
in the adapter's closure only; errors are a closed reason — no status text,
body, header or LND message is propagated (a node echoing a secret cannot
place it anywhere). `createLndRestLightningNodeReader` builds an object with
**no `sendPayment` at all**; the reference composition gives it a macaroon baked
with `offchain:read info:read` only, and LND refuses a send with it (regtest
R0). The rail's macaroon is baked with `offchain:read offchain:write info:read`.

**Transport.** One endpoint: `https:` with the node's certificate pinned as the
only trust anchor, or `http:` to a **literal loopback IP address** only —
`127.0.0.0/8` or `[::1]` (LND `--no-rest-tls`); no credentials, path, query or
fragment; `agent: false`; no redirects; bounded deadline and size; no retry.
Plain `http:` never names a host — `http://localhost` is refused at
configuration: `localhost` is a hostname the hosts file, NSS or DNS resolve,
and a plaintext request carries the macaroon in its headers, so a poisoned
resolver would receive the credential. A literal address is decided from the
URL alone, before any request exists (the WHATWG parser canonicalizes numeric
spellings such as `127.1` without a lookup; IPv4-mapped `[::ffff:127.0.0.1]`
is refused). Over `https:` a hostname is fine: the macaroon travels only inside
a session whose certificate matched the pinned one.

A TCP connection **never established** (including a deadline before it was)
is `LightningSendNotAttemptedError` — not one byte left the process. Once the
node's port accepted the connection, anything — a timeout, a reset, a TLS
handshake that never completed — is unknown (`unconfirmed`, P12).

**One node per port.** The rail reads the payer's identity once, before the
reservation, and does not re-read it just before the send (another failure
window that would still not prove where the send lands). That rests on the
composition: one `LightningNodePort` is one node — the reference adapter is
bound to one endpoint, one pinned certificate (each LND node's own) and a
macaroon only that node's root key verifies, so a substituted node fails the
TLS pin or rejects the macaroon. The P12 and finality authorities check the
identity themselves on every read (§14, §15).

**Not PAY-03's external signer.** XRPL needs a customer-controlled signer
because the Host would otherwise hold the account key. A Lightning node signs
commitments and HTLCs internally; there is no transaction blob for Frontera to
sign or verify, and inventing a fake signer abstraction would add nothing. The
analogue is capability separation: the Host holds only a narrowly baked
payment macaroon, the authorities a read-only one, and no key at all.

## 9. Network configuration

`network` is required, with no default: `mainnet` · `testnet` · `signet` ·
`regtest`. `mainnet` is refused unless `allowMainnet: true` is stated beside it
(PAY-02's posture). Before any send — and on every P12 or finality read — the
invoice prefix and the node's reported chain network must both equal it.
PAY-06 was qualified on regtest only; no mainnet funds were used.

## 10. Routing-fee policy

The governed amount is what the **payee receives**. The routing fee is a
separate execution cost, capped by trusted configuration only:

```
feeLimitMsat = min(maximumFeeMsat, ⌊amountMsat × maximumFeePpm / 1 000 000⌋)     (either may be omitted; one is required)
```

Integer arithmetic; a cap of 0 means zero-fee routes only (LND semantics), never
"unbounded". The cap is handed to the node as `fee_limit_msat` **before** the
send — LND's pathfinding never launches an HTLC whose route exceeds it — and
checked again on every answer: a node reporting a fee above it is never
success (P11 `unconfirmed`, P12 unresolved, PAY-05 `contradicted`). The actual
fee is recorded as a bounded accounting fact (`lightning.fee-msat`) in the
finality evidence, beside the cap. The fee is never added to the governed
amount.

**Fee accounting residual.** P7 and P10 govern the principal only, exactly as
for XRPL (where the network fee is also outside the governed amount). Making
monetary governance fee-inclusive is a generic design question for a future
milestone; PAY-06 does not change P7 semantics, and enforces its own trusted
cap regardless.

## 11. One governed execution → at most one payment send

```
governed execution (grant, P7, claim) → prepare → interlock.recorded? ─yes→ unconfirmed (its payment hash), nothing sent
   → invoice decode + binding → node checks (reads) → interlock.reserve (durable, CORE-07) → expiry again → sendPayment ONCE → P11
```

Never `send → remember`. The interlock (`sqlite-lightning-payment-interlock.ts`)
is append-only and hash-chained, with `UNIQUE` execution and payment-hash
columns; every reservation is one CORE-07 transition (witness probe → decide on
the verified head → witness prepare → `BEGIN IMMEDIATE` re-decide and insert →
finalize). It holds **no status column**: P11 holds the initial observation,
P12 the resolution, and the node can always be asked again by payment hash.

| situation | result |
| --- | --- |
| the same execution again (replay, restart, another process) | `unconfirmed`, `lightning-execution-previously-initiated`, the recorded hash — never a second send |
| the same execution with another invoice | `unconfirmed`, `lightning-execution-invoice-conflict`, the **recorded** hash; nothing rewritten |
| the same execution, the rail recomposed against another payer node | `unconfirmed`, `lightning-execution-previously-initiated`; the reservation keeps its payer; zero sends (PAYER-8) |
| another execution, the same payment hash | `not-completed`, `lightning-payment-hash-reserved`, before the node — even for the same amount |
| four Hosts racing one execution / one hash on one file and one witness | exactly one reaches the node (IL-5, IL-6) |

**Node routing is not Frontera retrying.** LND may try several routes, HTLCs
and parts inside the one `SendPaymentV2` — one payment hash, bounded by the
cap and the `timeout_seconds` the one call carries. Frontera never calls
`sendPayment` a second time for an execution, and the rail has no retry code
path (structurally tested).

**Crash matrix** (each with no second send):

| boundary | durable state | on re-entry |
| --- | --- | --- |
| L1 before the reservation | none | nothing was sent; the claim governs re-entry as for any execution |
| L2 after the reservation, before the node call | reservation | never sent again; P12: the node does not know the hash → unresolved (residual §21) |
| L3 node accepted, before the answer | reservation | never sent again; P12 reads the same hash |
| L4 success answered, before P11 | reservation | never sent again; P12 resolves completed |
| L5 failure answered, before P11 | reservation | never sent again; P12 resolves not completed |
| L6 after an unconfirmed result | reservation + P11 | P12 resolves when the node is terminal |
| L7 restart, then P12 | as above | P12 reads; zero sends |

## 12. Rollback safety, CORE-07 and backup

A local SQLite file cannot prove it is the newest one. A stale restore of the
interlock would lose exactly the reservations of payments already initiated;
with P11's claim restored with it, the same execution could look new, and a
second execution could take a hash an earlier one paid. The node's own
duplicate-payment refusal (LND refuses an in-flight or paid hash) is defence in
depth, **not** the guarantee — and LND does permit a new payment for a hash
whose earlier payment failed. So the interlock is **always** anchored at the
CORE-07 witness, in the rail-neutral operational slot
`payment-initiation-reservations` (sequence = reservations ever made, digest =
the hash chain): genesis enrolled before written; older, lost, forked or
pending history refused at open; no reservation — so no send — while the
witness is unreachable. There is no unanchored durable mode. The slot name
carries no Lightning word: CORE-07 does not learn Lightning exists.

The payer node identity is part of every entry's canonical content, so of its
entry digest, the chain and the witnessed state digest: a rewritten
`payerNodeId` is refused locally (PAYER-9: digest mismatch; PAYER-10a: chain
broken), and a perfectly re-hashed local forgery is refused by the witness
(PAYER-10b) — exactly like any other reservation field.

**Schema v2 (`aoc.lightning-payment-interlock.schema.v2`).** Adding
`payerNodeId` changed the entry shape (entry digest domain `…entry.v2`). There
is no migration from v1 — the pre-merge PAY-06 shape, which no release
shipped: a v1 file is refused at open by the version guard (unmutated), and a
payer-less entry is refused by the shape check. A payer is never inferred for
an old reservation: reading whichever node is configured now would defeat the
binding.

| state | rollback makes … | money-moving? | decision |
| --- | --- | --- | --- |
| Lightning interlock | an initiated payment look new; a paid hash look free | **yes** | anchored at CORE-07; IL-9 – IL-11 |
| settlement records / receipts | PAY-05 unchanged: availability only, re-derived identically from the node | no | not anchored (SET-LN-8 / 9) |

**Backup.** Embedder-composed: `lightning-payment-interlock` (schema v2) is listed in
`EXCLUDED_DURABLE_STATE` (`scripts/portability/store-registry.mjs`); the
embedder backs the file up with the Governance Store, P11 and P12 it belongs to
and keeps the witness outside that backup domain. A stale or lost copy is
refused at open; recovery is restoring the newest file or trusted recovery at
the witness. The witness and the interlock restored as one snapshot is
CORE-07's deployment prohibition.

## 13. P11 certainty mapping

Existing vocabulary only (`lightning-classification.ts`, shared by the rail,
P12 and PAY-05 so they can never disagree):

| node fact | P11 |
| --- | --- |
| succeeded; preimage hashes to the payment hash; amount exactly governed; fee ≤ cap | `confirmed-completed`, ref = payment hash |
| `FAILED` (terminal — LND sets it only once no HTLC is in flight), any reason | `confirmed-not-completed` `PROVIDER_REJECTED`, neutral detail (`lightning-no-route`, `-routing-timeout`, `-incorrect-payment-details`, `-insufficient-balance`, `-payment-canceled`, `-payment-failed`) |
| in flight (held HTLC, still routing, a shard pending) | `unconfirmed` |
| RPC deadline; disconnect after the connection was established; unreadable or inconsistent answer (another hash, a preimage that does not hash, another amount, a fee above the cap) | `unconfirmed` |
| connection never established | `not-completed` `PROVIDER_UNAVAILABLE` (the hash stays reserved) |
| any refusal before the send | `not-completed`, the rail's detail |

**HTLC timeout.** A local timeout proves nothing: the payment may still be in
flight, settling, or persisted by the node. It is `unconfirmed`, P7 capacity
stays consumed, and P12 reads the same hash later. Success is never inferred
from time, an HTLC sent, a route attempted or an invoice disappearing; failure
is never inferred from a timeout, a disconnect, an unreachable node or an
unknown payment.

## 14. P12 Lightning resolution authority

`createLightningResolutionAuthority({ configuration, node: reader, interlock })`
— id `frontera.lightning-btc-node`, composed into P12 unchanged. It reads the
execution's reservation (written before the send, so every possibly-initiated
payment has one), requires the P11 attempt's handle and amount to match it,
requires the node to be **the reservation's payer** — `nodeInfo` identity equal
to `payerNodeId`, on the reservation's network — and only then asks for
**that** payment by hash:

| node | answer | P12 |
| --- | --- | --- |
| the payer | succeeded and consistent | `confirmed-completed` |
| the payer | terminally failed | `confirmed-not-completed PROVIDER_REJECTED` |
| the payer | in flight, not found, unreachable, inconsistent | unresolved |
| **another node**, same network | succeeded, failed, anything | unresolved |
| the payer's key on another network; a malformed identity | — | unresolved |

Nothing is recorded when unresolved. Another node's record is about its own
attempt to pay the same invoice — it proves nothing about this execution, so a
reader composed against the wrong node can neither complete nor fail it (it
would otherwise release P7 capacity for a payment still in flight, or record
success for money this node never sent). Absence is never evidence. P12
itself binds the resolution to the attempt digest, the current P11 observation
and this authority (P12-LN-6). Read-only: a `LightningNodeReader`, no send.

## 15. PAY-05 finality: the preimage

`createLightningFinalityAuthority({ configuration, node: reader, interlock })` —
id `frontera.lightning-btc-finality`, method `lightning.preimage.v1`,
implementing `PaymentFinalityAuthority` **unchanged**.

`final` requires: this rail and asset; a mapped source; the governed
destination's payee and payment hash equal the reservation's; the exact amount;
the P11 / P12 handle equal to the payment hash; the node proving it is **the
payer the reservation bound** (`nodeInfo` identity = `payerNodeId`, on the
reservation's network) and reporting the payment **succeeded** with a preimage that decodes to
exactly 32 bytes and whose SHA-256 is the payment hash; the delivered amount
exact; the fee within the reserved cap. A malformed preimage → `not-final`; a
well-formed one that does not hash → `contradicted` (`lightning.preimage-mismatch`);
another amount → `lightning.amount-mismatch`; a fee above the cap →
`lightning.fee-bound-exceeded`; a terminal failure → `lightning.payment-failed`;
anything else (pending, unknown, another network, another hash) → `not-final`.
Contradictions record nothing (PAY-05's rule). **Another node** — another
identity, even on the same network — is `not-final` whatever it reports
(succeeded with a valid preimage, failed, malformed): an identity mismatch is
the absence of relevant evidence, never a contradiction.

**Evidence** (deterministic — same payment, any restart, any answer ordering or
optional field → the same content and receipt digests):

```
providerRef = payment hash
facts: lightning.amount-msat · lightning.fee-limit-msat · lightning.fee-msat · lightning.invoice-digest
       lightning.network · lightning.payee-node · lightning.payer-node · lightning.payment-hash
       lightning.preimage-commitment
```

No route, hop, channel, attempt, node timestamp or debug string. **No
`finalizedAt`**: a payer node's settle time is its local clock, not an instant
the network established; PAY-05 does not require it, and omission keeps the
canonical identity stable.

**Preimage disclosure.** The preimage is never recorded — not in P11 (the
payment hash is the handle), the interlock, P12, the settlement or the receipt.
Evidence carries `lightning.preimage-commitment` = SHA-256 over a domain tag and
the preimage: whoever later holds the preimage (the node operator) can prove the
settlement was about exactly it, without the record disclosing it. (`SHA256(preimage)`
alone is the payment hash, already public.) PAY-05's disclosure tiers already
hide finality facts from every tier.

## 16. Receipts, obligations, refunds and ingress

- **Receipts:** PAY-05's generic, deterministic `frontera.payment-receipt.v1` —
  no Lightning receipt type.
- **Payment obligations:** a Lightning settlement satisfies a CORE-04 payment
  obligation through PAY-05's bridge unchanged (exit proof E:
  required → the payment made for the obligation → preimage finality →
  independent discharge → CORE-04 `verified`; a self-report never verifies).
  Resuming the same committed decision afterwards is rail-independent and
  proven on the shipped Host by `pay05-exit-proof-host.test.ts`.
- **Refunds:** PAY-05's refund is a new governed payment; with Lightning as the
  refund rail it needs a **new invoice from the refund beneficiary** — a
  settled BOLT11 invoice cannot be reversed or re-paid, and PAY-06 provides no
  spontaneous / keysend payment. The embedder's refund counterparty mapping
  must yield a `lightning-invoice` destination for a fresh invoice that its
  invoice source holds. XRPL refunds are unchanged.
- **Direct PAY-01** is the primary path (every exit proof). **MPP (PAY-04)**
  hard-codes no rail: protocol terms naming a Lightning destination and rail
  become a canonical `PaymentIntent` (structural test). No MPP Lightning method
  is added.

## 17. Trust boundaries

- **The node** is trusted to route, to enforce the fee cap it is handed and to
  report truthfully. Narrowed by: completion requiring the payee's preimage
  (unforgeable), exact comparison of amount and fee with the reservation, the
  network check, the payer-identity check (P12 and finality read only the node
  the reservation bound), its own decoding compared with Frontera's, a
  read-only credential for authorities. A compromised node operator can mis-report a
  failure as success only with a preimage it cannot obtain, but can lie about
  delivered amount and fee (reported facts) and can deny service.
- **The invoice source** is trusted to supply text; it can withhold, never
  redirect (§6).
- **The witness** — CORE-07's trust and deployment assumptions, unchanged.

## 18. Composition, health and effect paths

**Embedder-composed** (like PAY-04 and PAY-05): no Host configuration, Host
module, route, deployment-kit entry or package export. Node credentials and
topology are deployment-specific; composing them in the shipped Host is
future productization, not a PAY-06 exit requirement.

**Health:** `rail.readiness()` → `{ status: 'ready', network }` or
`{ status: 'unavailable', detail }` (reads `getinfo` only; never initiates a
payment); the interlock's `health()` → readable, writable, schema, CORE-07
freshness, reservation count — no hash, invoice, payee, amount, macaroon or
certificate.

**Effect paths:** one new — **EP-071**, the Lightning payment send, PROVEN —
PATH LOCAL (ten of seventy-one). Decoding is pure; the interlock is a local
safety record whose witness transitions are an existing EP-057 trigger that can
only refuse; the P12 and finality authorities are EP-054-kind read-only status
queries through the same adapter file's reader.

## 19. Qualification

| suite | covers |
| --- | --- |
| `lightning-bolt11.test.ts` | every pinned spec vector; B11-1 … 12; recovery-id flip; high-S with and without `n`; FEAT-1 … 12 (transitive feature dependencies, signed invoices) |
| `lightning-amount.test.ts` | MONEY-1 … 8; hrp amounts; fee-cap arithmetic |
| `lightning-rail.test.ts` | P11-LN-1 … 8; B11-3, 4, 6, 12 – 15; MONEY-9, 10; node checks; interlock and source failures; logs; readiness; in-process concurrency |
| `lightning-rail-boundaries.test.ts` | imports, the one send site and its ordering, no retry vocabulary, no network / signing / credential in the rail, dependency pin |
| `pay06-lightning-interlock.test.ts` | IL-1 … 12 with a real witness; cross-thread races (independent SQLite connections and witness clients); tamper; pending recovery; lost finalize; PAYER-1, 8, 9, 10; v1 / payer-less refusal |
| `pay06-lightning-governed.test.ts` | exit proofs A – E on the unchanged spine; P12-LN-1 … 8; SET-LN-1 … 11; P7 release / hold; governed duplicate; over-ceiling; PAYER-2 … 7, 11, 12 |
| `pay06-lnd-rest-node.test.ts` | the LND adapter against a fake LND: requests, mapping, not-sent vs unknown (TCP-connect boundary, http and https), deadlines, determinism; HTTP-1 … 10 (literal-loopback plaintext); credential canaries through a full governed run and every configuration refusal |
| `pay06-lightning-structure.test.ts` | CORE purity; generic ports unchanged; read-only authorities; credential confinement; XRPL ↔ Lightning independence; MPP compatibility |
| `pay06-lightning-regtest.test.ts` | opt-in, real LND (§20) |

## 20. Real Lightning qualification (regtest)

`node scripts/pay06/lightning-regtest.mjs up` starts Bitcoin Core 29.1 and three
LND v0.20.5 nodes in Docker — alice (Frontera's payer) → carol (router, 5 000
msat + 1 000 ppm) → bob (payee) — funds and opens channels, and bakes alice's
two macaroons (plus carol's certificate and a read-only macaroon baked on
carol, for the payer-identity case R7 only). Then `FRONTERA_LIGHTNING_REGTEST_PAY06=1` runs the governed
flow through the real adapter, with bob's invoices (plain and hold) created by
bob's own `lncli`. Product code never depends on Docker.

Run of 2026-10-12, requalified after the pre-merge hardening on Bitcoin Core
v29.1.0 and LND v0.20.5-beta (regtest; 8 / 8 passed):

| case | result |
| --- | --- |
| R0 | LND's real invoices decode identically in Frontera and in LND's `DecodePayReq`; the read-only macaroon's send is refused by LND; bob unpaid |
| R1 exit A | 250 000 sat routed through carol: P11 `confirmed-completed`, fee **255 000 msat** (carol's real fee, within the 300 000 msat cap), `awaiting-finality` → preimage-verified `settled`, receipt verified, reservation and evidence name alice as payer; one send |
| R2 exit D | cap 25 000 msat below every route: never completed; bob unpaid; no HTLC above the cap; P11 `unconfirmed` while LND held a capped attempt, LND then `FAILED (timeout)`, P12 `confirmed-not-completed`; one send |
| R3 exit B | a real held HTLC (bob's hold invoice): P11 `unconfirmed`; restart; P12 unresolved while held; bob settles; P12 `confirmed-completed`; `settled` on the resolution basis; one send |
| R4 exit C | bob cancels the invoice: LND terminal failure → P11 `confirmed-not-completed`; `not-settleable`; one send |
| R5 | held HTLC, bob cancels: `unconfirmed` → P12 `confirmed-not-completed` |
| R6 | the same invoice under a second governed execution fails closed before LND; LND itself refuses a direct duplicate of the paid hash |
| R7 payer identity | alice pays bob's hold invoice (held; the reservation names alice); carol — a real second node on the same network — tries the same invoice herself and LND records **her** payment `FAILED (incorrect payment details)` while alice's is still in flight: P12 through a carol reader is **unresolved** (nothing recorded) and finality through carol is **`not-final`**, never a contradiction; bob settles; P12 through alice → `confirmed-completed`, `settled`, evidence `lightning.payer-node` = alice; one send. Before the hardening, the carol reader's `FAILED` would have been recorded as `confirmed-not-completed` for a payment that then settled |

**What the real node taught (fixed or encoded before this run):** LND's REST
gateway requires the payment hash in the track path as URL-safe base64 **with
padding** (the unpadded form is refused — fixed in the adapter and its tests);
LND's "not found" is HTTP 404 with a streamed `{"error":{"code":5}}` body; and
with a fee cap below every whole route, LND may send one multi-part shard whose
own fee fits and keep it **in flight** until the payee's MPP timeout, with
`failure_reason NO_ROUTE` already set while the status is still `IN_FLIGHT` —
so "fee cap exceeded" is, per node semantics, definitive or unconfirmed, never
success. The rail's conservative mapping handled it without change.

A live testnet run was **not** performed (no reliable funded infrastructure);
the regtest run uses real nodes for every semantic. No mainnet.

## 21. Residuals

- **Node trust** (§17): amount and fee are node-reported; a compromised node
  can deny service or mis-report those facts (never forge completion).
- **Payer identity is the node's own report.** The P12 / finality binding
  compares `getinfo`'s `identity_pubkey` with the reservation: it stops a
  reader composed against another honest node (the reviewed failure), not a
  compromised node that claims another node's key — which is node trust above,
  narrowed for the reference adapter by the pinned certificate and a macaroon
  only the payer node's root key verifies.
- **The `payment_secret → var_onion_optin` edge** is enforced from the
  revisions that define those ASSUMED features (§4), not from the pinned
  table: an implementation that stops writing bit 8/9 beside 14/15 would see
  its invoices refused — fail-closed, nothing sent.
- **A shared payer node:** LND accepts a new payment for a hash whose earlier
  payment failed. If another client of the same node re-pays a hash after
  Frontera recorded a definitive failure, the payment can later succeed while
  P11 says not completed. The node — at least its paying macaroon — must be
  dedicated to Frontera.
- **Crash between reservation and send** leaves the execution unresolved: the
  node does not know the hash and absence is never evidence; an operator
  resolution through P12 closes it (as PAY-03's equivalent).
- **Amountless invoices, keysend, AMP, BOLT12, LNURL:** not supported.
- **Fee-inclusive governance:** P7 / P10 govern the principal; the fee is
  capped by trusted configuration, not by the authority's ceiling.
- **Embedder-only:** the shipped Host composes no Lightning component and does
  not back up the interlock; one LND backend; no Core Lightning adapter.
- **Payee identity is a node key**, not a merchant identity — binding, not
  authenticity (as PAY-04's challenge binding).
- **Qualification:** regtest with real nodes; no live testnet, no mainnet.
