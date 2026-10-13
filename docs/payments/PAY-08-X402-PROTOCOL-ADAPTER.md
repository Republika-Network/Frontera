# PAY-08 — x402 Protocol Adapter

> **An x402 `PaymentRequired` is a merchant's proposal for payment. PAY-08
> interprets it strictly, translates it into the canonical `PaymentIntent`
> through PAY-04's existing protocol boundary, and governs it on the
> unchanged path. It is never authority, policy, budget, grant or identity.**

- Status: implemented — the x402 adapter (`src/features/payment-runtime/protocols/x402/`) and its composition edge (`src/enterprise/x402-payment-protocol/`)
- Decision record: `docs/architecture/ADR-X402-PROTOCOL-ADAPTER.md`
- Builds on: `PAY-04-PAYMENT-PROTOCOL-ADAPTER.md` (the protocol port, the ingress, business-operation identity and its CORE-07 anchor), `PAYMENT_ARCHITECTURE.md` (PAY-01), `PAY-05-SETTLEMENT-AND-RECEIPTS.md`, `PAY-06-LIGHTNING-RAIL.md`
- Master plan: `docs/architecture/FRONTERA-MASTER-PLAN.md` — PAY-08

## 1. What PAY-08 is — and is not

PAY-08 is a **protocol adapter** at PAY-04's boundary: the second implementation
of `PaymentProtocolAdapter`, beside MPP.

```text
agent request ──► merchant: 402 + PAYMENT-REQUIRED                       untrusted (the discovery request: no payment effect)
        ↓  adapter.prepare (edge: PAY-06's BOLT11 decoder verifies candidate invoices; pure memo)
        ↓  PAY-04 ingress.prepareAndGovern                                the EXISTING ingress, unchanged
        ↓    adapter.interpret: strict x402 v2 decode → exact resource URL → trusted mapping
        ↓      → flow / timeout / amount → trusted lnbtc binding → deterministic selection
        ↓    PaymentProtocolTerms → paymentIntentOfProtocolTerms (PAY-01 validator)
        ↓    business operation + challenge, durable, CORE-07-anchored   BEFORE governance
        ↓    compilePaymentIntent (PAY-01 compiler) → govern()            the unchanged spine
Kernel → P10 → GRANT → P7 → claim → PAY-01 bridge → Lightning rail (ONE send) → P11 → (P12)
        ↓  PAY-05 verifySettlement (preimage finality) → receipt
        ↓  edge: PAYMENT-SIGNATURE built from PAY-04 context + PAY-05 "settled" + read-only proof
agent paid retry ──► merchant validates the proof → 200 + PAYMENT-RESPONSE   protocol evidence, never settlement
```

It is **not** a payment rail, a signer, a facilitator, a wallet, a custody
layer, a settlement engine, an EVM or blockchain implementation, or a
replacement for PAY-01 / PAY-04 / PAY-05. It adds no rail, no `PaymentIntent`
field, no governed-action field, no CORE vocabulary, no store, no CORE-07 slot,
no effect path, no Host route, module, configuration or package export, and no
dependency.

| x402 concept | is not |
| --- | --- |
| a `PaymentRequired` | authority, approval, policy, a grant, a budget, an organization identity |
| an x402 `scheme` / `network` | a Frontera rail (a trusted mapping relates them; nothing infers one from the other) |
| `resource.url` | a URL Frontera fetches (it is compared exactly with the URL the agent's network layer already sent) |
| a `PaymentPayload` | something built before governance (it is built only after PAY-05 recorded the payment settled) |
| a facilitator | a party Frontera talks to (the paying side never calls `/verify` or `/settle`) |
| `PAYMENT-RESPONSE`, HTTP 200 | Frontera settlement (PAY-05 is the only authority on funds finality) |

## 2. Pinned upstream baseline

| item | value |
| --- | --- |
| Repository | `x402-foundation/x402` (Apache-2.0) |
| Commit | `f8f83309706b14cc696962f0a002eeeb66c3dc26` (2026-10-10, `main` at implementation time) |
| Protocol version | **x402 v2** (`x402Version: 2`). v1 is not implemented: a v1 document is refused, v1 header names are never read |
| Files used | `specs/x402-specification-v2.md` (types, flows §6.1, facilitator §7, errors §9) · `specs/transports-v2/http.md` (HTTP representation) · `specs/schemes/exact/scheme_exact.md` (the `exact` scheme, method families) · `specs/schemes/exact/scheme_exact_lnbtc.md` (the executed binding) · `specs/schemes/exact/scheme_exact_xrpl.md` and `scheme_exact_evm.md` (audited; not executable here, §11) |
| Fixtures | the HTTP spec's `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` example headers and the lnbtc test vector (requirement, invoice, request-binding digests), pinned verbatim with their file digests in `protocols/x402/tests/x402-spec-vectors.ts` — compact vectors, no specification text |

Not followed: mutable `main`. A later milestone that moves the pin must say
why and re-run the parser and binding suites against it.

**Dependency.** None added. The official TypeScript SDK was audited and not
used: it is a client / server / facilitator framework with wallet and chain
integrations, its normalization would sit between merchant bytes and
Frontera's governance, and the core types are small. PAY-08 is a
repository-contained strict parser over the pinned types (~1 300 lines,
pure), plus PAY-06's own BOLT11 decoder and Node's `crypto` at the edge.

## 3. Role: Frontera is the governed paying side

PAY-08 implements Frontera as the **client** of x402: an agent's request meets
a 402; Frontera interprets the requirement and governs whether its principal
may pay it; if granted, the existing rail pays; after PAY-05 records the
payment final, Frontera hands the agent's network layer the proof for its paid
retry. PAY-08 is not a resource server and not a facilitator. A reference
resource server exists **only in tests** (`pay08-x402-world.ts`), written
independently from the spec, to prove interoperability of a full round trip.

PAY-08 accepts the merchant's response and the trusted description of the
original request; it is **not** an HTTP client or proxy. It sends nothing,
fetches nothing, follows no redirect, and never replays the paid request.

## 4. Where it lives

| place | what | boundary |
| --- | --- | --- |
| `src/features/payment-runtime/protocols/x402/` | `x402-codec.ts` (canonical base64, fatal UTF-8, strict bounded JSON with numbers as source text), `x402-messages.ts` (v2 types read closed; HTTP carrier; `PAYMENT-SIGNATURE` encoder; `SettlementResponse`), `x402-payment-adapter.ts` (mappings, flows, timeout, exact amounts, bindings port, selection, evidence) | pure, synchronous, network-neutral; imports only PAY-01's domain and P9; no Node API, crypto, clock, I/O, rail or MPP (`tests/x402-protocol-boundaries.test.ts`) |
| `src/enterprise/x402-payment-protocol/` | `x402-lightning-binding.ts` (the `exact` / `lnbtc` binding, the invoice-verification memo, the `http:1` request hash), `x402-presentation.ts` (prepare, then the existing ingress), `x402-payment-signature.ts` (post-settlement `PAYMENT-SIGNATURE`, redacted wrapper, read-only proof source), `x402-payment-response.ts` (`PAYMENT-RESPONSE` as evidence) | the one place x402 meets a rail; imports the x402 adapter, PAY-06's barrel (decoder, destination, preimage check, read-only reader type), PAY-04 / PAY-05 read surfaces and `node:crypto`; holds no rail, send, adapter, signer, key, facilitator or network client (`pay08-x402-structure.test.ts`) |

Nothing in the Kernel, grant runtime, P7, P10, P11, P12, ASSURE-01, PAY-01's
generic contract, PAY-04's ingress, the XRPL or Lightning rails, MPP or the Host
imports or names x402 (structural, §20).

## 5. Trust model

| input | source | trust |
| --- | --- | --- |
| identity, `businessOperationId`, source account, purpose | the trusted in-process caller (PAY-04, unchanged) | trusted; the protocol cannot reach them |
| `protectedRequest` (`target`, `method`, `contentDigest`) | the network layer (PAY-04, unchanged) | trusted |
| request URL and bound header values | the trusted request resolver `resolveRequest({ organizationId, target, method })` | trusted; the network layer's description of what it sent |
| execution mappings (scheme, network, asset → unit, scale, binding, flows, timeout max, rail) | deployment configuration, snapshotted at composition | trusted |
| network binding (`exact` / `lnbtc`) | composition | trusted code; its answer is still read closed |
| the 402 response: status, headers, every `PaymentRequired` field, `extra`, extensions, invoice | the merchant | **untrusted** |
| invoice cryptography (signature, payee) | PAY-06's decoder, awaited in `prepare` | verified, then memoized by exact text |
| finality | PAY-05 through the rail's finality authority | the only settlement authority |
| the proof (preimage) | the payer node, read-only | verified SHA-256 → the governed payment hash before use |
| `PAYMENT-RESPONSE`, HTTP status | the merchant | evidence only |

A merchant can therefore propose amount, asset, `payTo`, network, scheme,
timeout and resource. It cannot raise a ceiling, choose a rail, pick a source
account, mint a grant, change identity, select among its own offers, set a
monetary scale, widen a timeout, add a flow, or make Frontera fetch anything.

## 6. HTTP representation and decoding

Exactly the pinned v2 HTTP transport:

| header | direction | PAY-08 |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | server → client with **402** | read: the carrier is `{ status, headers }`; status must be 402; exactly **one** field named `payment-required` (case-insensitive) — two fields, even identical, are refused, never merged or first-wins; a comma-joined value is not base64 and is refused |
| `PAYMENT-SIGNATURE` | client → server | built (§14), never parsed from a merchant, never logged or stored |
| `PAYMENT-RESPONSE` | server → client | read as evidence (§16) |

Legacy `X-PAYMENT` / `X-PAYMENT-RESPONSE` are not accepted (the pinned spec
deprecates them). The response body is not read for x402 data.

Decoding is strict and bounded: the value length is checked first (16 KiB);
base64 is the standard alphabet with padding, read **canonically** (whole
quanta, zero pad bits — one accepted spelling per byte string; base64url,
unpadded or whitespace-broken text refused); UTF-8 is decoded fatally (no
overlong, surrogate, > U+10FFFF, truncated sequence or byte order mark); JSON is
parsed by hand: a duplicated member name refuses the document,
`__proto__` / `constructor` / `prototype` never become keys, lone surrogates
are refused (I-JSON), trailing text refuses, depth ≤ 16, ≤ 512 members,
strings ≤ 8 KiB, numbers ≤ 64 characters and kept as **source text**, never
JavaScript numbers. Parsed objects are frozen null-prototype records; no
getter, proxy trap or spread ever runs on merchant data.

## 7. The PaymentRequired parser

Closed at every level: `PaymentRequired` (`x402Version`, `error?`, `resource`,
`accepts`, `extensions?`), `ResourceInfo` (`url`, `description?`, `mimeType?`,
`serviceName?`, `tags?`, `iconUrl?`), `PaymentRequirements` (`scheme`,
`network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds`, `extra?`), each
extension (`info`, `schema`). Any undeclared member refuses.

| field | rule |
| --- | --- |
| `x402Version` | exactly the integer `2` (not `"2"`, not `2.0`), read first |
| `resource.url` | absolute `https` / `http`, printable ASCII, no fragment, no user information, ≤ 2 048; **never normalized** |
| display metadata | `description` ≤ 1 024; `mimeType` a media type ≤ 128; `serviceName` printable ASCII ≤ 32; `tags` ≤ 5 × printable ASCII ≤ 32; `iconUrl` an absolute http(s) URL — validated, then **dropped** |
| `error` | ≤ 1 024, validated, **dropped** (never evidence, digest, policy or log) |
| `accepts` | 1 … 16 |
| `scheme` | `[a-z0-9][a-z0-9-]*`, ≤ 32 |
| `network` | CAIP-2 by its own grammar (`[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}`) — any namespace parses; parsing is not support |
| `amount` | atomic units: `[1-9][0-9]*`, ≤ 40 digits — no zero, sign, leading zero, point, exponent or separator |
| `asset`, `payTo` | printable non-space ASCII, ≤ 128 / ≤ 256 |
| `maxTimeoutSeconds` | canonical integer 1 … 86 400 |
| `extra` | an object, ≤ 16 members, ≤ 4 KiB serialized, numbers only canonical integers; the protocol-reserved `paymentFlow` / `assetTransferMethod` must be bounded text; otherwise opaque |
| `extensions` | ≤ 8, names `[A-Za-z0-9][A-Za-z0-9._-]*` ≤ 64, each exactly `{ info: object, schema: object }`, ≤ 4 KiB each, ≤ 6 KiB together |

A structurally malformed entry refuses the whole message (it is one JSON
document); a well-formed entry Frontera cannot execute is skipped by selection.

## 8. Resource and request binding

PAY-04's protected-request binding is reused, not replaced: `target`, `method`
and the RFC 9530 `contentDigest` enter PAY-04's semantic digest unchanged, and
a body-bearing request is still refused without a digest. PAY-08 adds two
checks on top, both against trusted data:

1. **The resource is exactly the request.** The trusted resolver maps PAY-04's
   opaque `target` to the URL the network layer actually sent;
   `PaymentRequired.resource.url` must be **byte-identical** to it. No URL
   equivalence is invented — another path, a dropped, added or reordered query
   parameter, a trailing slash, a host case change or another scheme is
   `request-binding-mismatch` (tested). The URL itself is never stored.
2. **The scheme's own request binding** (`lnbtc` `http:1`): the binding
   recomputes the request hash from the trusted request — method, the exact
   URL, the body's SHA-256 taken from PAY-04's RFC 9530 digest (SHA-256 of the
   empty string for a bodiless request), and the value hash of every header the
   server binds, taken from the **trusted** field values (absent ≠ empty; a
   header the network layer did not describe is not bindable and refuses) — and
   requires `extra.requestHash` and the invoice's signed description hash to
   both equal it. The merchant's echo is never the expected value.

So a requirement issued for resource A, method GET or body X cannot pay for
resource B, a POST, or body Y — refused before the store and before
governance (`pay08-x402-governed-payment.test.ts`).

## 9. Requirement selection

```text
for each accepts[] entry:
  trusted mapping matched EXACTLY on (scheme, network, asset)      none → skipped (unsupported)
  flow = extra.paymentFlow ?? the binding's mechanism default      unknown / not enabled / escrow → skipped
                                                                   (the default must be one of the binding's own
                                                                   declared flows — else composition fails)
  maxTimeoutSeconds ≤ mapping.maximumTimeoutSeconds                above → skipped
  binding.interpret(...)                                           its closed refusal, or usable
choose: the usable offers of the FIRST mapping in configuration order;
        canonical-identical offers collapse to one; two different ones → challenge-ambiguous;
        one instrument under two different terms anywhere → challenge-ambiguous
none usable: request-binding-mismatch > challenge-expired > normalization-failed > counterparty-unresolved > challenge-unsupported
```

Merchant order never selects (every permutation of a mixed offer list yields
the same answer — tested); index 0 has no meaning; changing the trusted
mapping order changes the choice, explicitly. Duplicates: identical offers in
any spelling (member order, whitespace) are one; conflicting duplicates are
refused. Only `exact` can be mapped (composition refuses another scheme).

## 10. Amounts and asset scale

x402 `amount` is in atomic units. The P9 value is `amount ÷ 10^atomicScale`,
computed on text (pad, split, strip trailing zeros) — no `Number`, no float,
no rounding; P9's single ingress then validates it against the mapping's unit
(which must be in the registry, with a scale ≥ the atomic scale, checked at
composition). The scale is **trusted configuration only**: never `extra.name`,
`extra.version`, `extra.decimals`, the asset text or anything else the merchant
sends. An unmapped asset is not executable. For `lnbtc` the atomic unit is the
millisatoshi and the scale is 11 (`net:BTC`, PAY-06's own). Matrix AMT-1 … AMT-10:
`x402-payment-adapter.test.ts`.

## 11. Schemes, networks and rails

| x402 offer | Frontera | why |
| --- | --- | --- |
| `exact` on `lnbtc:000000000933ea01ad0ee984209779ba` (Bitcoin testnet), `BTC`, `upfront`, `bolt11`, `http:1` | **executable** through PAY-06's Lightning rail | a client-submitted method: the payer pays the invoice itself — exactly the governed rail's one send |
| `exact` on `lnbtc:000000000019d6689c085ae165831e93` (mainnet) | executable by configuration (binding `mainnet`), with PAY-06's mainnet opt-in | same binding; not qualified on mainnet |
| `exact` on `xrpl:*` | **not executable** — parsed, never mapped | a facilitator-submitted method: the client must hand the merchant a *signed, unsubmitted* XRPL transaction that the merchant's facilitator submits. PAY-02 / PAY-03 submit through Frontera's own interlock; releasing a signed blob is a different money-moving effect, which would be a new rail mode — out of scope. The IOU `amount` is also decimal text, not atomic units |
| `exact` on `eip155:*`, `solana:*`, others | not executable | no Frontera rail; no EVM rail is invented, and `PaymentIntent` is not distorted to mimic EVM fields |
| `upto`, `batch-settlement`, `auth-capture`, other schemes | refused at composition, skipped at selection | not implemented |
| `mcp:1` request binding | unsupported (refused) | only `http:1` |

The network → rail relation is configuration (`X402ExecutionMapping.rail`,
PAY-01's exact-bound rail preference) plus the binding's own network check
(the invoice's BOLT11 currency must be the network's: `tb` testnet, `bc`
mainnet). Nothing is inferred from merchant text.

## 12. The `exact` / `lnbtc` binding

The paying side's half of `scheme_exact_lnbtc.md` "Client Payment
Construction", in order, every check against trusted data:

| check | refusal |
| --- | --- |
| `scheme` `exact`, concrete network, `asset` `BTC` | `challenge-unsupported` |
| `extra` keys ⊆ the binding's six; `paymentFlow` **explicitly** `upfront`; `assetTransferMethod` absent or `bolt11`; profile `http:1` | `challenge-unsupported` |
| `payTo` a compressed secp256k1 key, 66 lowercase hex; `amount` ≤ Bitcoin's supply in msat | `normalization-failed` |
| `requestHash` 64 lowercase hex; `requestBindingParams` exactly `{ headers }`, lowercase tokens strictly ascending, no `payment-signature`; computed hash = stated | `request-binding-mismatch` |
| invoice verified by PAY-06's decoder during `prepare` (signature; payee recovered or `n`-field low-S), currency = network, amount = `amount` msat exactly, expiry = `maxTimeoutSeconds` exactly, created ≤ now + 60 s skew | `normalization-failed` |
| description **hash** present and = the computed request hash (an inline `d` refuses) | `request-binding-mismatch` |
| invoice payee = `payTo` | `counterparty-unresolved` |
| now < creation + expiry | `challenge-expired` |

Answer: destination `lightning-invoice:<payTo>:<payment hash>` — PAY-06's
governed destination, an exact and injective translation (never `payTo`
copied into a generic field) — and the instrument `<network>:<payment hash>`,
the scheme's canonical consumption key.

*Prepared, then read.* PAY-04's port is synchronous; PAY-06's decoder verifies
signatures asynchronously. A decoding is a pure function of the invoice text,
so the edge's `createX402Presentation` awaits `adapter.prepare(carrier)` —
which lets the binding run PAY-06's decoder on every mapped candidate — and
only then calls the existing `ingress.prepareAndGovern`. `interpret` reads the
memo; an invoice that was not prepared or did not verify is refused. The same
memo is the rail's trusted invoice source (`verifier.invoices`): it returns an
invoice only for a verified reading with exactly the governed payment hash
**and** payee, so it can withhold a payment, never redirect one.

*One payment hash, one invoice text* (hardening, SEC-INV-295). The rail asks
for an invoice by payment hash and payee only, but what the binding verified
is one exact invoice **text** — its signature, its signed description hash
(the request binding), payee, amount, network and expiry. Two validly signed
texts can share payment hash, payee, amount and network and differ in the
description hash. So the memo keeps, per **(payee, payment hash)** — exactly
what the rail asks by — the SHA-256 identity of the one text it verified (only
the payee's own key can sign a second text for its pair; another node reusing
the payment hash is another pair, never served for this payee and unable to
poison it):

```text
unseen      + A          → unique(A)
unique(A)   + A          → unique(A)          (exact replay keeps working)
unique(A)   + B, B ≠ A   → ambiguous          (B is not cached as a reading)
ambiguous   + anything   → ambiguous          (for the process lifetime)
```

An ambiguous pair is neither a reading for `interpret` (refused
`normalization-failed`, before PAY-04's store or `govern()`) nor an invoice for
the rail (withheld: PAY-06 refuses `invoice-unavailable` before any node
call) — never first-, last- or latest-wins, whichever text was governed. The
identity record is **not** evicted with the bounded readings
(`maximumEntries`, default 256): eviction can neither clear an ambiguity nor
let a substitute take over the pair of an evicted (perhaps governed, in
flight) text. It is bounded separately (`maximumPaymentHashes`, counting
pairs: default 16 384, at most 262 144, never below `maximumEntries`); once
full, the memo refuses every new pair instead of forgetting an old one, and the
deployment recomposes. The memo is process memory and never authority — a pure
verification cache and invoice source that can only withhold. A restart starts
it empty: a payment governed before the restart is never resumed through it
(P12 resolves an uncertain one), a re-presentation is verified again, and
PAY-04's one-instrument-one-operation record and PAY-06's durable
payment-hash interlock still hold across the restart.

*PAY-06's one change.* The decoder now also returns `descriptionHash` (the
signed `h` field, lowercase hex) when the invoice carries one. Additive and
rail-neutral; the rail itself never reads it (pinned structurally); PAY-06's
tests and PAY-07's conformance suite pass unchanged.

## 13. PaymentIntent, PAY-01 and PAY-04 reuse

| PaymentIntent field | from |
| --- | --- |
| `source.accountId`, `purpose`, `correlationId` | the trusted caller (PAY-04) |
| `destination` | the binding (§12) |
| `amount` | atomic → decimal under the trusted scale (§10), through P9 |
| `rail` | the trusted mapping |
| `reference` | none (lnbtc has no merchant order identity) |
| `idempotencyKey` | derived by PAY-04 from `(organization, principal, businessOperationId)` |

The intent is built by PAY-01's `validatePaymentIntent` (via PAY-04's
`paymentIntentOfProtocolTerms`) and compiled once by `compilePaymentIntent`;
the edge constructs no `GovernedActionIntent`. Everything PAY-04 owns is
reused unchanged: business-operation identity, the derived governed key and
request id, the semantic digest, the durable store and its CORE-07 anchor,
"durable before governance", and the closed refusals. **No x402-specific
execution id, payment id or replay store exists.**

*Requirement identity.* x402 carries no server-issued challenge id, so the
challenge key PAY-04 records is `x402:2:<instrument>` (for lnbtc,
`x402:2:<network>:<payment hash>`), and the evidence fields are the exact
selected requirement (`requirement`: its canonical JSON — every core field and
every `extra` member, invoice included), its parts (`scheme`, `network`,
`asset`, `pay-to`, `amount`, `max-timeout`, `payment-flow`), the `binding`, the
`instrument` and, when present, the server's `extensions`. Display metadata,
`error` and the URL are never recorded. PAY-04's rules then apply verbatim:

| presentation | result |
| --- | --- |
| same operation, same requirement, same resource | the same governed request: replayed, no second payment (BOP-X1, also after a restart) |
| same operation, any money term changed (new invoice: amount, payee, timeout) | `business-operation-conflict` (different destination / amount) |
| same operation, same invoice, a term the invoice contradicts (amount, timeout, payTo) | refused by the binding before the store |
| same operation, same invoice, any other exact term changed | `challenge-conflict` |
| same operation, another asset / network / scheme | `challenge-unsupported` (not mapped) |
| same operation, another resource / method / body | `request-binding-mismatch` or `business-operation-conflict` |
| another operation, same invoice | `challenge-conflict` — one invoice, one payment, anchored at CORE-07 |
| a deliberately new purchase | a fresh 402 (fresh invoice) under a new `businessOperationId` |

No `govern()` call happens on any refusal (asserted by count). A stale restore
of the business-operation store is refused at open; an unreachable witness
refuses every presentation (`store-freshness-unverified`) — PAY-04R's
guarantees, exercised through x402 (BOP-X11, BOP-X12).

*Refresh.* Because a fresh lnbtc invoice is a new payment hash, a refreshed
x402 challenge for the same operation is a different purchase and conflicts;
the paid retry uses the original invoice, as the binding intends.

## 14. Payment flows, PaymentPayload and custody

| flow | PAY-08 |
| --- | --- |
| `upfront` (settle → resource) | **supported for `lnbtc` only** — the binding's only flow. The payment is committed before the resource runs; that is inherent in the method (a preimage exists only after payment) |
| `authorization` (verify → resource → settle) | not executable: no mapped binding is facilitator-submitted (§11); a mapping may enable it only for a binding that declares it, and none does |
| `escrow` (settle → resource → settle) | never executable — refused at composition and skipped at selection; Frontera has no two-settlement model, and it is not mapped onto PAY-05 |
| unknown | never constructed (spec §6.1), skipped |

**Ordering.** Governance happens before anything that resembles payment
authority exists: the 402 is interpreted, governed, paid **by the rail under a
grant**, and settled by PAY-05 — and only then does the edge build the
`PAYMENT-SIGNATURE` (`createX402PaymentSignatureBuilder`):

1. PAY-04's context reader by the trusted governed request id → the exact
   accepted requirement and extensions (re-read and re-bound to the governed
   destination; never taken from a fresh merchant message);
2. PAY-05 `readSettlement` for that execution → `settled`, for **this**
   request, destination and amount — otherwise `not-settled` /
   `settlement-mismatch`;
3. the proof source (PAY-06's read-only node reader, `paymentStatus` only — no
   path to `sendPayment`) → the preimage, which must hash to the governed
   payment hash (`proof-unavailable` / `proof-invalid`; asked once, never
   retried);
4. `PaymentPayload { x402Version: 2, accepted: <the governed requirement>,
   payload: { preimage }, extensions }` → canonical base64.

No signature is created anywhere: `lnbtc` needs none (the preimage is the
proof), Frontera holds no key, seed or wallet secret, and no wallet SDK is
imported. Building twice yields the same value — a deterministic proof of one
payment, not a second one.

**Extension echo** (spec §5.1.2 / §5.2; hardening, SEC-INV-296). The pinned
spec: the client MUST echo the server's extensions, MUST preserve all
server-provided information, MAY append its own, and MUST NOT delete or
overwrite the server's. So a client addition (`clientExtensions`) is either

- a **new extension name** — a whole extension, `{ info, schema }`; or
- **new `info` members under a server extension** — `{ info }` (the server's
  `schema` may be repeated, and then must be identical). Nested objects merge
  additively, one level at a time.

The result keeps the server's `schema` and every server `info` member exactly;
changing, retyping or deleting one, or a different `schema`
(`extension-schema-overwrite`), is refused as `extension-overwrite`.
Restating a server member with the very same value is refused too
(fail-closed: it adds nothing, and "client contributes only members the server
did not state" stays checkable). The merge is a closed copy — nothing is
spread — and the merged whole is held to every extension bound again. Client
additions change only the `PaymentPayload`: never the governed requirement,
the semantic digest or PAY-04's recorded challenge (whose `extensions` field
remains the server's, exactly).

**Bounded before serialized** (hardening, SEC-INV-296). A caller's
`clientExtensions` is runtime data, not parser output. Every extension tree is
therefore first copied by `copyX402Json` under explicit budgets — depth (15,
one level kept for the enclosing document), members plus elements (512,
checked from an object's key count and an array's length **before** any member
is read) and a running lower bound of the serialized size (6 KiB) — and only
then measured and serialized. The copy reads own data descriptors only (no
getter runs), accepts only plain objects (`Object.prototype` or `null`),
plain arrays without holes, strings, booleans, `null` and `X402JsonNumber`,
and refuses a shared or cyclic object (one `WeakSet`), a symbol key, any other
prototype, a JavaScript number and a reserved member name; a Proxy trap that
throws is a closed refusal. Parser output always fits these budgets and passes
unchanged. The built header is then read back with the resource server's own
reader before it is returned.

**`PAYMENT-SIGNATURE` handling.** The value is bearer proof. It is returned
inside `X402PaymentSignature`, whose `toString`, `toJSON` and `inspect` render
`[x402 PAYMENT-SIGNATURE: redacted]`; only `reveal()` returns it, for the HTTP
layer that sends the paid request. It is never stored, logged, put in an
error, evidence, a receipt or the trace (canary-tested across every store
file, receipt, settlement read, trace and governed intent).

**PaymentPayload binding.** `accepted` is byte-for-byte the governed
requirement; the payee and payment hash are the governed destination; the
amount the governed amount. A payload for one operation is never built from
another's payment (`settlement-mismatch`); altered copies fail the merchant's
own check (PP-1 … PP-12).

## 15. Facilitators

Frontera as the paying side **never calls a facilitator**: in the `upfront`
`lnbtc` flow the resource server calls `/settle` (never `/verify`), and the
client only presents the proof. PAY-08 therefore has no facilitator client,
no verify or settle capability, no facilitator credential and no retry. A
facilitator's word is never authority and never Frontera settlement. Any
future facilitator integration (a resource-server mode) must keep `/verify`
read-only and separate from `/settle`, carry credentials only in trusted
composition, and never retry an ambiguous settle — none exists today.

## 16. PAYMENT-RESPONSE and HTTP 200

`readX402PaymentResponseEvidence(carrier, context)` reads exactly one
`PAYMENT-RESPONSE` field and compares it with the governed terms: network,
transaction = the payment hash, `payer` absent (lnbtc forbids it), `amount`
absent or equal. The transaction rule (hardening, SEC-INV-292): the pinned
`SettlementResponse` always carries `transaction`, empty when nothing was
broadcast — but **never empty for `errorReason: settlement_pending`**, which
the parser refuses (`settlement-response-pending-without-transaction`), so it
is `unreadable`. Any non-empty `transaction` claims to identify a payment and
must be the governed payment hash whatever `success` says (success, failure or
pending); a success must name it; an empty one on a failure claims nothing. It answers `evidence` (`serverReportsSuccess`, `consistent`,
`mismatch?`, a bounded `errorReason` token) or `unreadable`. It **writes
nothing**: a merchant's `success: true` and an HTTP 200 leave PAY-05's state
exactly where it was (tested: still `awaiting-finality` until
`verifySettlement`). A bare 200 without the header is no evidence at all.

## 17. P11, P12 and PAY-05 stay the rail's

x402 defines no P11 certainty, no P12 authority and no settlement semantics.
An x402-originated Lightning payment is recorded by the Lightning rail in P11,
resolved by the Lightning P12 authority (held HTLC → `execution_unconfirmed` →
settled by the payee → reconciled → `settled`, tested) and settled by PAY-05
through the Lightning finality authority. Presenting the same requirement
again while unconfirmed replays the unconfirmed request; it never retries.

## 18. Network safety: SSRF and redirects

PAY-08 makes **no outbound request**. `resource.url` is merchant-controlled and
is never fetched; it is only compared with the URL the agent's network layer
already used. There is therefore no SSRF surface (localhost, link-local,
RFC 1918, cloud metadata, DNS rebinding) and no redirect to follow with
credentials attached: the embedder's HTTP layer sends the discovery and paid
requests and owns its own egress policy (PAY-06's hardened transport rules
apply to the Lightning node adapter, unchanged).

## 19. Secret hygiene

| secret | where it may exist |
| --- | --- |
| `PAYMENT-SIGNATURE` value | inside `X402PaymentSignature` only, until the HTTP layer sends it |
| preimage | the payer node; inside the builder call; inside the header value |
| node macaroon / TLS | PAY-06's node adapter only (unchanged) |
| facilitator credential | none exists |

Canaries assert their absence from the business-operation store, P11, P12,
PAY-05, the receipt, the ASSURE-01 trace, the governed intents, the rail
instructions, every SQLite file and WAL, renderings and errors.

## 20. Structural guarantees and NO_BYPASS

- No x402 / lnbtc / x402-header / facilitator word in any CORE source PAY-07
  measures, and none in PAY-04's wider core scan; the built-in reserved-key
  list is unchanged; `X402_RESERVED_CONTEXT_KEYS` reach CORE-03 as
  configuration only (the ingress refuses to compose without them).
- The x402 adapter imports no rail and nothing of MPP; MPP imports nothing of
  x402; no rail (XRPL, Lightning) or rail edge names x402.
- The edge holds no `PaymentRail`, `ExecutionAdapter`, `createLightningRail`,
  `sendPayment`, signer, key, network client or facilitator; never calls
  `govern`, `verifySettlement` or a store write; reads PAY-05 before the proof
  and the proof before encoding (order pinned).
- **NO_BYPASS: unchanged, ten of seventy-one.** PAY-08 adds no effect path:
  parsing, selection and payload encoding are pure; the business-operation
  write is PAY-04's local record; the edge reaches execution only through
  `ingress.prepareAndGovern` → `govern()` → EP-071. Releasing the proof to the
  merchant is the embedder's HTTP request after a settled payment, not a
  payment.
- **Protocol-boundary neutrality** (MPP + x402): the same payment presented
  through MPP and through x402 compiles to the same governed intent and the
  same governed request; on one store the second protocol is the same
  business operation (a new challenge under it), never a second purchase.

## 21. Canonicalization

| case | material? | why |
| --- | --- | --- |
| CAN-1 JSON member order, whitespace | no | canonical serialization |
| CAN-2 `accepts` order | no | selection by trusted priority |
| CAN-3 header-name case | no | HTTP field names are case-insensitive |
| CAN-4 base64 spelling | — | only the canonical padded spelling is accepted; any other is refused |
| CAN-5 / CAN-6 description, service name, tags (and their order), `error` | no | display metadata, dropped |
| CAN-7 amount, CAN-8 `payTo` | **yes** | requirement evidence and business terms |
| CAN-9 resource | **yes** | another URL does not bind; another target is another business operation |
| CAN-10 extensions | **yes**, for the challenge evidence | an extension change under the same instrument is `challenge-conflict`; it never changes the business terms |
| any `extra` member | **yes** | part of the requirement evidence |

## 22. Not in PAY-08

Not implemented: x402 v1; schemes other than `exact`; any network other than
`lnbtc` (EVM, Solana, XRPL and the rest parse but are not executable); the
`authorization` and `escrow` flows; `mcp:1` and other request-binding profiles;
a resource-server or facilitator mode; facilitator clients; XRPL
facilitator-submitted payments; EVM signing; MCP and A2A transports; an HTTP
client or proxy; Host composition; a new rail; Stripe (PAY-09).

## 23. Residual risks

1. **Upfront is pre-resource.** Under `lnbtc` the payment commits before the
   resource runs; a merchant that then fails or refuses leaves the payment
   made. The spec defines no refund; a refund is a new governed payment
   (PAY-05). Governance still decides first, and the proof is only released
   after PAY-05 settlement.
2. **No merchant authenticity.** The invoice proves the payee node; nothing
   proves which business runs it. Payee policy is governance's (the governed
   counterparty is the payee key and payment hash).
3. **The trusted request resolver is trusted.** It maps PAY-04's opaque target
   to the URL and header values the network layer sent; a wrong mapping binds
   the wrong request.
4. **Bound headers** need canonical field values from the network layer
   (RFC 9421 §2.1 normalization is the embedder's); a non-canonical value is
   refused, not normalized.
5. **Refreshed challenges conflict.** A fresh invoice under the same operation
   is a different purchase (fail-closed); the agent keeps the original
   invoice for its paid retry.
6. **The proof source is the payer node**, read-only: an unavailable node
   delays the proof (refused, never retried), never the payment.
7. **Embedder-composed only**, like PAY-04, PAY-05 and PAY-06: the shipped Host
   composes no x402 path.
8. **Testnet-shaped qualification**: the end-to-end proof runs on PAY-06's
   deterministic node simulator with a test-only reference merchant; no live
   x402 merchant, testnet node or mainnet was exercised by PAY-08.
9. **The invoice memo is per process.** A payment-hash collision is detected
   only among the texts one memo has verified; a restart forgets it (the
   durable PAY-04 instrument record and PAY-06 interlock still hold), and a
   saturated identity record refuses new x402 Lightning payments until the
   deployment recomposes.

## 24. Test map

| matrix | file |
| --- | --- |
| PR-1 … PR-20, header decoding, official vectors, CAN-1 / CAN-3 / CAN-4, PP-7 / PP-8 (encoder), EXT-MERGE-1 … EXT-MERGE-9, EXT-BOUND-1 … EXT-BOUND-10, RESP-7 (parser) | `protocols/x402/tests/x402-messages.test.ts` |
| SEL-1 … SEL-10, AMT-1 … AMT-10, flows, FLOW-CFG-1 … FLOW-CFG-6, timeout, CAN-2 / CAN-5 … CAN-10, composition | `protocols/x402/tests/x402-payment-adapter.test.ts` |
| adapter purity, network neutrality, no MPP / rail coupling | `protocols/x402/tests/x402-protocol-boundaries.test.ts` |
| lnbtc spec vectors (request hashes, invoice, binding), client checks, time, headers, verifier, INV-COLL-1 … INV-COLL-8, PP-7 / PP-9 … PP-12 (builder), RESP-1 … RESP-7 | `src/enterprise/__tests__/pay08-x402-lightning-binding.test.ts` |
| exit proof, paid round trip, denial, over-ceiling, BOP-X1 … BOP-X12, resource / method / body replay, P12, HTTP-200 / PAYMENT-RESPONSE trust, RESP-8 / RESP-9, INV-COLL-5 (governed stack), extension echo (governed stack), secret canaries, PP-1 … PP-6 | `src/enterprise/__tests__/pay08-x402-governed-payment.test.ts` (world: `pay08-x402-world.ts`) |
| CORE purity, edge boundaries, ordering, MPP ↔ x402 conformance | `src/enterprise/__tests__/pay08-x402-structure.test.ts` |
| PAY-04, PAY-06, PAY-07 regression | the unchanged suites (structural allow-lists extended by one classified entry each) |

Facilitator matrices (FV, FS) do not apply: no facilitator integration exists.
