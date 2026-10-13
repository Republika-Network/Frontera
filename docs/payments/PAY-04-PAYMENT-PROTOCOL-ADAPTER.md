# PAY-04 — Payment Protocol Adapter Boundary + MPP

> **A payment protocol challenge is a merchant's proposal. It is normalized
> into the canonical `PaymentIntent` and governed on the unchanged path; it is
> never authority.**

- Status: implemented — the protocol-neutral port (`src/features/payment-runtime/domain/payment-protocol.ts`), the MPP adapter (`src/features/payment-runtime/protocols/mpp/`) and the protocol ingress with its business-operation store (`src/enterprise/payment-protocol-ingress/`)
- Decision record: `docs/architecture/ADR-PAYMENT-PROTOCOL-ADAPTER-BOUNDARY.md`
- Builds on: `docs/payments/PAYMENT_ARCHITECTURE.md` (PAY-01), `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12), `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11)
- Master plan: `docs/architecture/FRONTERA-MASTER-PLAN.md` — PAY-04
- Provenance: the unmerged P13 branch (`24dd264`, *feat(payments): add MPP challenge business idempotency*), audited and partly ported — §15
- Post-merge hardening (rollback safety): the challenge-ownership history is anchored at the CORE-07 witness — §8.4, §10.1, §10.2; ADR D13

## 1. What PAY-04 is

PAY-04 is the payment **protocol ingress** layer. It is not a rail.

```text
external payment protocol challenge (MPP: 402 + WWW-Authenticate: Payment …)    untrusted
        ↓  PaymentProtocolAdapter.interpret            normalize + bind (pure)
PaymentProtocolTerms + challenge evidence             or a closed refusal
        ↓  paymentIntentOfProtocolTerms                PAY-01's validator, unchanged
PaymentIntent                                         the canonical intent — no second model
        ↓  business operation + challenge, durable     BEFORE governance
        ↓  compilePaymentIntent                        PAY-01's compiler, unchanged
GovernedActionIntent
        ↓  GovernedActionOrchestrator.govern()         the unchanged governed spine
Kernel → committed decision → (approval) → P10 → bounded grant → P7 → write-ahead claim
        ↓  createPaymentRailExecutionAdapter           PAY-01's bridge, unchanged
PaymentRail (XRPL / RLUSD today; any rail trusted routing selects)
```

Six distinctions carry the design; every section below is one of them made
precise:

| | is not |
|---|---|
| an MPP challenge | authority |
| a challenge's identity | the business operation's identity |
| request idempotency (`idempotencyKey` → `requestId`) | business-operation idempotency |
| a challenge refresh | a payment retry |
| a protocol adapter | a rail adapter |
| binding a challenge to the protected request | the merchant's authenticity |

## 2. Where it lives, and why there

| place | what | why there |
|---|---|---|
| `src/features/payment-runtime/domain/payment-protocol.ts` | The protocol-neutral port: `PaymentProtocolAdapter`, `PaymentProtocolTerms`, the closed refusal vocabulary, the closed reader of an adapter's answer, the trusted protected request and RFC 9530 digest helpers, `paymentIntentOfProtocolTerms`, `PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS` | Inside PAY-01's contract: held to its boundary test (no rail, protocol, issuer, ledger or clock vocabulary; no I/O; no number money) |
| `src/features/payment-runtime/protocols/mpp/` | The MPP adapter: grammar, challenge validation, trusted normalizers / resolver / selector | Below the contract, like `rails/`: the contract never imports it; its own boundary test (`mpp-protocol-boundaries.test.ts`) |
| `src/enterprise/payment-protocol-ingress/` | The protocol-neutral ingress service, business-operation identity, the durable store, the read-only context reader | A **composition edge** of the payment vertical, like PAY-03's `xrpl-payment-rail/`: the only enterprise directory besides that one allowed to import the payment runtime (`payment-runtime-boundaries.test.ts`); it names no protocol and no rail (`pay04-payment-protocol-structure.test.ts`) |

Nothing in the Kernel, the recognition / grant / execution runtimes, the
policy engine, the governed-action orchestrator, CORE-03's registry or any
other enterprise module knows PAY-04 exists. No `mpp*` symbol, no
`payment-required`, `httpauth-payment`, x402 or bolt11 word exists in CORE
(M39, pinned structurally), and PAY-04 added no XRPL word to CORE (the set of
core files naming XRPL is exactly PAY-03's Host composition, pinned).

There is **no HTTP route**, no SDK method, no package entrypoint export and no
Host module. The ingress is a trusted in-process service an embedder composes
beside `AocEnterprise.governedActionOrchestrator` (§13).

## 3. MPP protocol baseline (pinned, unchanged from P13)

| item | value |
| --- | --- |
| Specification repository | `tempoxyz/mpp-specs` at `08e7dd873a69866ae2cde74678fc2eaf6d72d22b` (2026-09-23) — P13's pin |
| Core draft | `draft-httpauth-payment-01` |
| Intent draft | `draft-payment-intent-charge-00` — `charge` is the only intent interpreted |
| Required challenge parameters | `id`, `realm`, `method`, `intent`, `request` |
| Optional | `expires`, `digest`, `description`, `opaque`, `header` |
| `method` | `1*LOWERALPHA`, case-sensitive |
| `intent` | `1*( ALPHA / DIGIT / "-" )` |
| `request` | base64url without padding of JCS (RFC 8785) JSON |
| `opaque` | base64url without padding of a JCS flat string → string map |
| `expires` | RFC 3339 `date-time`; an expired challenge is never used |
| `digest` | RFC 9530 content digest of the protected request's body |
| `header` | absent → the credential would go in `Authorization`; `Payment-Authorization` → that field; any other value → the challenge is unrecognized |
| Unknown parameters | ignored by clients (dropped unread) |
| Duplicate parameters | not specified by the draft — **refused** here |
| Challenge binding (`id`) | server-side (HMAC, AEAD or state); **not verifiable by a client** |

PAY-04 deliberately did **not** move to a newer draft: this repository prefers
deterministic pinned protocol behaviour over a moving Internet-Draft, and no
defect in the pin was found. A later milestone that changes the pin must say
why and re-run the parser suite against it.

**Dependency.** None. P13 audited and rejected `mppx` (0.11.0): its root entry
requires `viem` as a non-optional peer and bundles Stripe, EVM, x402 and
wallet code, and its parser departs from the draft (looser `method`, any token
as `header`, a non-RFC-9530 digest, `request` decoded without a canonicality
check). Re-evaluated for PAY-04 from current code: a repository-contained
parser of ~350 lines is reasonable, deterministic and fully tested; adding a
supply-chain dependency for it is not justified.

## 4. The port

```ts
interface PaymentProtocolAdapter {
  readonly protocolId: string;                 // semantic identifier ('mpp')
  readonly reservedContextKeys: readonly string[];
  interpret(challenges: unknown, context: PaymentProtocolInterpretationContext): PaymentProtocolInterpretation;
}
// context: { organizationId, businessOperationId, protectedRequest (trusted, canonical), observedAtEpochMilliseconds (trusted clock) }
// answer : { interpreted: true, terms: PaymentProtocolTerms, challenge: { key, fields } }
//        | { interpreted: false, refusal: 'challenge-invalid' | 'challenge-expired' | 'challenge-unsupported'
//                                       | 'challenge-ambiguous' | 'request-binding-mismatch'
//                                       | 'normalization-failed' | 'counterparty-unresolved' }
interface PaymentProtocolTerms { destination: PaymentDestination; amount: MonetaryAmount; reference?: string; rail?: string }
```

It answers exactly: *trusted protected request + protocol challenge(s) +
trusted interpretation configuration → canonical payment terms, or a closed
refusal.* An adapter never authorizes, decides policy, selects authority,
chooses an execution adapter, executes, signs, submits, holds a credential,
calls a rail, resolves settlement or retries.

`interpret` is synchronous and pure. Its answer is **untrusted executable
output**: `readPaymentProtocolInterpretation` reads it once from own data
properties, closed at every level, holds the destination to PAY-01's grammar,
the amount to the single P9 ingress (canonical text, a registry asset, within
scale, strictly positive), `reference` and `rail` to PAY-01's own grammars,
and the challenge evidence to a closed, bounded, public shape (a secret-shaped
field name refuses the whole answer). A getter, a Proxy, a promise, a number
amount, or any undeclared key (`authorized`, `ceiling`, `grant`, `source`,
`purpose`, `idempotencyKey`, …) is not an answer.

The port is protocol-neutral by construction: an x402 adapter (PAY-08) would
implement the same `interpret` over its own carrier and produce the same
`PaymentProtocolTerms` — no change to PAY-01, the ingress or CORE.
*Delivered by PAY-08* (`PAY-08-X402-PROTOCOL-ADAPTER.md`): the x402 v2 adapter
implements exactly this port, composed into this ingress unchanged; for the
same payment, MPP and x402 compile to the same governed intent and governed
request (`pay08-x402-structure.test.ts`). The x402 challenge identity is the
payment instrument (`x402:2:<network>:<payment hash>`), so §8.4's
one-challenge-one-operation rule and its CORE-07 anchor apply as written.

## 5. The MPP adapter

### 5.1 Parser (`mpp-grammar.ts`, `mpp-challenge.ts`)

Reviewed from P13, rewritten where needed, re-proven by its own tests:

- an **RFC 9110 §11 tokenizer** for `#challenge` lists — `token BWS "=" BWS (token / quoted-string)`, token68, several challenges per field value and several field values — which decides whether a comma separates two parameters or two challenges by lookahead, never by `split(',')`; a comma inside a quoted string is data; quoted-pair unescaping is exact;
- a **duplicated known parameter** (in any case) makes the challenge invalid — never first-wins, never last-wins;
- **strict base64url**: the alphabet, no padding, no `4n + 1` length, the decoded size bounded from the length **before** allocation, zero trailing bits (one spelling per byte string). P13 used `Buffer` round-tripping; PAY-04 decodes by hand so the adapter needs no Node API;
- **fatal UTF-8**;
- **bounded JCS JSON**: a JSON object whose decoded text equals its RFC 8785 serialization (sorted members, ECMAScript number and string spelling, no whitespace), depth ≤ 16, ≤ 256 members, no `__proto__` / `constructor` / `prototype` member anywhere, no lone surrogate (not I-JSON). A duplicate member, a non-shortest number, whitespace or a byte order mark fails the round trip. P13 reused the Governance Store's canonical JSON; PAY-04 owns a JCS check so the adapter imports nothing from the enterprise layer;
- **strict RFC 3339**, computed in exact integer arithmetic **without `Date`** (P13 used `Date.UTC`, which maps years 0–99 to 1900–1999); years 1970–9999, no leap second, fractional seconds truncated to milliseconds (which can only make an expiry earlier);
- **strict RFC 9530**: an RFC 8941 dictionary of byte strings in canonical padded base64 of the algorithm's exact length; `sha-256` and `sha-512` recognized, others ignored, a duplicate key or a member parameter refused;
- **bounds**: 16 KiB of field values, 16 values, 16 challenges, 32 parameters per challenge, 8 KiB per parameter, 512-character `id`, 256-character `realm`, 6 KiB decoded `request`, 2 KiB decoded `opaque`;
- **total**: the adapter catches everything; malformed input is `challenge-invalid`, never a Host crash.

A malformed `Payment` challenge beside a valid one is skipped, not fatal (the
selector still has to choose explicitly). A malformed field value refuses the
whole set. `description` is display-only by the draft: checked for its bound,
then dropped — it never reaches interpretation, selection, evidence or a
store (P13 stored it).

### 5.2 Binding to the protected request

The trusted network layer describes the protected request
(`readPaymentProtectedRequest`, closed): `target` (an opaque identifier of
what is being purchased — never a URL, credential-shaped value or path the
envelope grammar refuses), `method`, optional `expectedRealm`, and the RFC 9530
`contentDigest` of the exact body it carries. A `POST`, `PUT` or `PATCH`, or
any digested request, is body-bearing, and a body-bearing request without a
digest is refused.

A challenge binds the request only if its `realm` equals `expectedRealm` (when
known) and — exactly when the request has a body — its `digest` shares a
recognized algorithm with the request's digest and agrees on every shared
one. A challenge `digest` on a bodiless request binds nothing and is refused.
Otherwise: `request-binding-mismatch`.

> **Binding is not authenticity.** Nothing a client holds can prove that the
> merchant authored a challenge: its `id` is bound under a server secret.
> PAY-04 binds a challenge to the request it pays for, checks its expiry, and
> interprets it only through trusted configuration; it never calls a challenge
> authentic. A forged challenge can at most propose terms that trusted
> normalization, trusted counterparty resolution, trusted selection and the
> whole governed path must then accept.

### 5.3 Expiry

`expires` is compared with the **trusted clock's instant**, which the ingress
hands the adapter (`observedAtEpochMilliseconds`); the adapter reads no clock.
A challenge at or past its expiry is unusable (`challenge-expired`). Expiry
never expires the business operation: a refreshed challenge is another
instance of the same operation (§8).

Through the ingress, a governed execution is only ever reached inside a
`prepareAndGovern` call that has just validated an unexpired challenge: an
expired one — including an old challenge replayed — is refused before
governance. A payment withheld for approval executes later only when the
caller presents a current challenge again (or calls the orchestrator directly,
outside PAY-04). The remaining window is the duration of that one governance
call; a future credential step must still re-check `expires` with its own
clock before it uses the challenge.

### 5.4 Trusted method normalization

A host composes one **method normalizer** per `methodId` (`charge` only),
snapshotted at composition (membership frozen; duplicates refused). It maps the
method's own request — base units, currency spelling, recipient — into:

```ts
{ amount: { value: string, unit: string }, merchantReference?: string, reference?: string }
```

and nothing else. Its answer is read as untrusted output (closed keys, data
descriptors, then the single P9 ingress — no float, no `NaN` / `Infinity`, no
exponent, no rounding, no excess precision, strictly positive, a registry
asset). `merchantReference` is input to counterparty resolution only;
`reference` becomes PAY-01's business reference (bound exactly by the grant,
part of the business terms). A normalizer may also declare, **as composition**,
the PAY-01 rail *preference* its payments carry — never read from a challenge.
A normalizer cannot name a source account, purpose, destination, action,
adapter, ceiling, grant or identity.

### 5.5 Trusted counterparty resolution

`resolveCounterparty({ organizationId, methodId, intent, realm, merchantReference?, target, method })`
— trusted, synchronous — answers a PAY-01 `PaymentDestination` or nothing.
The realm and the merchant reference are context, never authority; a
merchant string is never copied into a destination. Anything other than
exactly `{ kind, reference }` in PAY-01's grammar — or a throw, or a promise —
is `counterparty-unresolved`. Whether that destination may be paid at all is
still the governed counterparty bound and policy's question.

### 5.6 Trusted challenge selection

When several challenges are usable, the trusted selector is asked — **even for
one** — and must return the `id` of exactly one candidate. An unknown id, an
id two candidates share, a non-string, a promise or a throw is
`challenge-ambiguous`. The selector sees only usable, normalized, frozen
candidates (`id`, `realm`, `method`, `intent`, `expires?`, `amount`,
`destination`, `reference?`, `rail?`). The merchant's ordering never selects:
reversing the challenges yields the same interpretation (tested).

When no challenge is usable, the refusal reported follows a fixed precedence —
`request-binding-mismatch`, then `challenge-expired`, `normalization-failed`,
`counterparty-unresolved` — so the merchant's order cannot choose it either.

## 6. Trust boundary

| input | source | trust |
| --- | --- | --- |
| identity | `BoundCustomerIdentity`, read through the orchestrator's own `boundScopeOf` | trusted |
| `businessOperationId` | the trusted in-process caller (the application layer) | a name only; grants nothing |
| `payment.source`, `payment.purpose`, `envelope` | the trusted in-process caller | PAY-01's own fields; the governed path decides |
| `protectedRequest` | the host's network layer | trusted description; no URL, header, cookie or body |
| challenge carrier | the merchant | **untrusted** protocol data |
| amount, business reference | a trusted method normalizer | its output is untrusted executable output: closed, then P9 |
| destination | the trusted counterparty resolver | a merchant string never becomes one |
| choice between challenges | the trusted selector | asked even for one |
| rail preference | trusted method composition | never from a challenge; PAY-01's exact-bound `rail` |
| action, P9 classification, CORE-03 registry | trusted Host composition | unchanged |

An MPP challenge can therefore never raise a spending ceiling, introduce a
grant, change account authority, override an emergency stop, weaken an
obligation, choose an execution adapter, supply a signer or credential, supply
an asset or issuer the trusted registry does not map, or change customer or
organization identity: none of those is a field it can reach.

## 7. The canonical PaymentIntent — reused, not extended

`PaymentIntent` is unchanged. PAY-04 adds no field to it and no field to
`GovernedActionIntent`; the compiled intent carries no protocol vocabulary.

| PaymentIntent field | from |
| --- | --- |
| `source.accountId` | the trusted caller |
| `destination` | trusted counterparty resolution |
| `amount` | trusted method normalization → P9 |
| `purpose` | the trusted caller |
| `reference` | trusted method normalization (a merchant order identity), when stated |
| `rail` | trusted method composition, when stated |
| `idempotencyKey` | **derived** from the business operation (§8) |
| `correlationId` | the trusted caller, when stated |

`paymentIntentOfProtocolTerms` builds the intent through PAY-01's
`validatePaymentIntent` — so a protocol-derived payment is held to exactly the
rules a direct one is — and the ingress compiles it with PAY-01's
`compilePaymentIntent` and validates the result with the orchestrator's own
`validateGovernedActionIntent` (P9 financial, CORE-03 profile and reserved
keys) **before** anything is stored. The structural test pins that the edge
calls the compiler exactly once, hands `govern()` exactly what it compiled, and
never builds envelope fields by hand. A direct `PaymentIntent` with the same
derived key compiles to the very request the protocol governed (tested on the
XRPL rail).

## 8. Business-operation identity

### 8.1 Scope and derivation

```text
business-operation key = (organizationId, principalId, businessOperationId)
idempotencyKey = "aoc.pay.bop:" + sha256(JSON ["aoc.payment.business-operation.v1", org, principal, businessOperationId])
requestId      = deriveGovernedActionRequestId({ org, principal, idempotencyKey })    ← the orchestrator's own function
```

`businessOperationId` is supplied by the trusted application layer: stable
across challenge refreshes, HTTP retries, restarts and protocol alternatives;
new for a deliberately new purchase. It is never a challenge id, a request
id, a timestamp or a per-attempt random value. The scope matches the governed
path's principal isolation; there is no organization-wide namespace.

The derivation is a **pure function of the scope**: no clock, no randomness,
no store read, no challenge field. That is the decision PAY-04's safety rests
on (§10): a refreshed challenge cannot mint a second governed request, and
neither can a lost or rolled-back business-operation store.

### 8.2 Request idempotency is not business-operation idempotency

The governed spine's idempotency is *technical*: one `idempotencyKey` → one
`requestId` → one committed decision → one `executionId` → at most one
adapter call. PAY-04 adds the *business* layer above it and derives the
former from the latter, once. A direct PAY-01 caller using the raw
`businessOperationId` as its key is a different request (tested). A caller
who deliberately submits the exact 76-character derived key under its own
principal produces an ordinary governed request that the business operation
then replays or conflicts with — never a second effect and never another
principal's request.

### 8.3 Semantic digest

`computePaymentBusinessSemanticDigest` — SHA-256 over `aoc.canonical-json.v1`,
domain `aoc.payment.business-semantics.v1` — commits to the scope, the
governed `action`, every `PaymentIntent` field except the derived key and the
correlation id (`source`, `destination`, `amount`, `purpose`, `reference`,
`rail`), and the protected-request binding (`target`, `method`, canonical
`contentDigest`). It excludes the protocol and every challenge-instance value
(`id`, `expires`, `opaque`, `realm`, `method`, `header`).

Same operation + same digest → the same operation (refresh / replay). Same
operation + different digest — a larger amount, another asset, another
destination, another purpose or merchant order, another protected resource or
body — → `business-operation-conflict`, refused **before** governance; the
original stands, never mutated.

### 8.4 Challenge identity

A challenge's identity is `(protocolId, key)` — for MPP the key is
`[realm, id]`. Within one organization **one challenge identity belongs to one
business operation and denotes one challenge**: the same challenge presented
for another operation (M30), or the same identity with different exact
fields, is `challenge-conflict`. A merchant honours a challenge once; paying
twice for one challenge is the duplicate charge this rule prevents.

This rule lives **only** in the business-operation store: the governed key is
derived from the business operation, so the Governance Store never sees a
challenge identity. As merged, a lost or rolled-back store lost the rule with
it, and the same already-paid challenge under a **new** `businessOperationId`
derived a new governed key — a new governed request — and paid again (the
merged regression showed the second rail call). The post-merge hardening
closes that: the store's ownership history is anchored at the CORE-07 witness
(§10.1), so the rule survives restart, loss, stale restore and a coordinated
rollback of the governed spine's stores; the old regression is now a refusal
with zero second rail calls (`pay04-mpp-governed-payment.test.ts`, `CLOSED`;
`pay04-rollback-safety.test.ts`). Business-operation identity is still the
caller's to keep stable.

## 9. Challenge refresh is not payment retry

A refreshed challenge with the same terms derives the same key and compiles to
the same governed intent, so the Governance Store **replays** whatever the
original request already did — the ingress asks for nothing else, and nothing
can ask for more:

| prior governed state | a refreshed challenge yields | rail calls |
| --- | --- | --- |
| never presented | the first governance of the operation | ≤ 1 |
| executed (P11 confirmed-completed) | `executed`, `replayed: true` | 0 more |
| failed (P11 confirmed-not-completed) | `execution_failed`, `replayed: true` | 0 more |
| unconfirmed (P11) | `execution_unconfirmed` | 0 more |
| unconfirmed, then resolved by P12 (either way) | exactly what a direct PAY-01 replay answers (`execution_unconfirmed`, the recorded outcome); the P12 resolution stands and is read through P12 | 0 more |
| denied / withheld | the same governed answer | 0 |

PAY-04 defines no retry and no retry generation. A payment P12 proved did not
complete is **not** retried by a refresh; a new purchase needs a new
`businessOperationId`. Protocol refresh can never overrule P12.

## 10. The durable business-operation store

`createSqlitePaymentBusinessOperationStore(path, { now, freshness: { boundary } })`
(production: anchored at the CORE-07 witness, §10.1) and
`createInMemoryPaymentBusinessOperationStore` (tests and development; volatile,
no history across a restart). Protocol-neutral: one business operation,
whatever protocol presented it, with protocol challenges underneath as
evidence. The ingress composes nothing else: a durable store without a witness
is a configuration error.

| table | key | holds |
| --- | --- | --- |
| `payment_business_operations` | `PRIMARY KEY (organization_id, principal_id, business_operation_id)`; `UNIQUE (organization_id, governed_request_id)` | the business terms (money as `TEXT`), semantic digest, derived key and request id |
| `payment_protocol_challenges` | `PRIMARY KEY (…operation, challenge_sequence)`; `UNIQUE (organization_id, challenge_identity)` | each accepted challenge: protocol, key, identity, digest, exact fields (JSON of strings) |

- `WAL`, `synchronous = FULL`, busy timeout; the schema guard
  (`aoc.payment-business-operation-store.schema.v1`) runs **before** any
  `CREATE TABLE`; a foreign or unversioned file is refused unmutated.
- One `BEGIN IMMEDIATE` per write: load and verify the operation and **every**
  challenge row, and the operation owning the presented challenge identity;
  decide created / existing / conflict and appended / existing; sample
  `recordedAt` under the lock; insert. The operation and its first challenge
  are written atomically. At most 64 challenges per operation; a further one is
  refused without evicting anything.
- Triggers refuse `UPDATE` and `DELETE`. No status, outcome, "retry requested",
  credential or secret column: what an execution did is P11's and P12's.
- **Verify-first**: opening re-verifies every row (`verifyAll()`); every read
  re-validates each row, recomputes its record digest, the semantic digest, the
  derived key and request id, each challenge's identity and digest, and
  requires positions 1…n and at least one challenge. Corrupt state is
  `PAYMENT_BUSINESS_OPERATION_CORRUPT` — never repaired, never "absent".
- Tenant scope on every call; no `system` escape.

**Concurrency.** The primary key, the unique challenge-identity index and
`BEGIN IMMEDIATE` decide — not process memory. Worker threads with independent
connections released from one barrier: identical writers converge on one
operation (`created` once, `existing` otherwise, one request id); 10 USD racing
11 USD yields one semantic identity and conflicts for the other; one challenge
raced for three operations binds to exactly one. In process, 20 concurrent
presentations produce one governed request and one rail call.

**Restart.** The SQLite file is the operation's durable memory: after a restart
(and the witness reconciliation, §10.1) a refresh finds the same operation
(`existing`, next position) and replays; conflicts survive restarts.

**Anchored races.** With the witness, every accepted challenge is also a
compare-and-advance at the witness: worker threads, each with its own
connection **and its own witness client**, racing one challenge for three
operations produce exactly one owner and exactly one witnessed transition;
racing refreshes leave the file and the witness in exact agreement. A writer
that loses the witness to another is retried a bounded number of times before
governance, or refused — never a payment retry
(`pay04-business-operation-concurrency.test.ts`).

### 10.1 Rollback safety — the CORE-07 anchor (post-merge hardening)

*Threat:* an older copy of the business-operation store is restored, or the
store is lost, after a challenge was paid (or became unconfirmed) — and the
same challenge is then presented under a **new** `businessOperationId`.

*Why the merged design was insufficient.* The governed key is derived from
the scope, never read from the store, so after a rollback the **same**
operation still compiles to the same `requestId`: same terms replay at the
Governance Store, and changed money terms hit its idempotency conflict. That
protects one operation. It cannot protect a challenge repackaged as a **new**
operation: a new `businessOperationId` derives a new key, a new governed
request, and the governed spine — which never sees a challenge identity —
executes a second purchase. Merged PAY-04 pinned that as a "caller-dependent"
residual (D9). It is not safe to depend on the caller: an application whose own
state was restored from the same backup may mint the new id in good faith.

*Decision (ADR D13).* The state whose loss reopens eligibility is anchored at
the CORE-07 external witness, in the protocol-neutral slot
`payment-business-operation-state`:

```text
sequence = number of challenge rows ever accepted            (each = a challenge identity becoming owned;
                                                              an operation's creation is its first row)
entry    = H("aoc.payment.business-operation-ownership-entry.v1", organization, principal, businessOperationId,
             businessSemanticDigest, governedRequestId, challengeIdentity, challengeDigest, position)
digest   = H("aoc.payment.business-operation-ownership.v1", previous, entry)   in commit (rowid) order
genesis  = H("aoc.payment.business-operation-ownership.v1", storeId, organization, 0)
```

Domain-separated `aoc.canonical-json.v1` digests. Row substitution, ownership
reassignment, the same position with another owner, a substituted store and
another organization's slot each change the digest or the binding. Refreshed
challenges are anchored too: every new challenge identity becomes owned, and a
later cross-operation check depends on it. Nothing else is anchored —
timestamps, exact fields and the protected-request terms stay local under the
record digests; the semantic digest is anchored through each row.

| step | behaviour |
| --- | --- |
| **open** | Verify-first as before, then reconcile with the witness **before** the store is handed to anything. Older history (stale restore) → `ROLLBACK_DETECTED`; an empty file under a slot held beyond genesis (a lost or replaced store) → `ROLLBACK_DETECTED`; a different state at a witnessed position, or one ahead of it → `FORK_DETECTED`; a prepared transition the file lacks → `PENDING_RECOVERY`; another store or organization → binding mismatch. Each refuses the open; nothing is repaired, re-enrolled, truncated or recreated from current input. A new, empty store enrolls its genesis at the witness before its first use. |
| **every presentation** | The witness is compared with the file first (`probe`) — even an exact replay that writes nothing. Not `ready` → `store-freshness-unverified`, before governance. |
| **every accepted challenge** | One CORE-07 transition: witness `prepare` (expected head → successor) → `BEGIN IMMEDIATE` commit, which re-checks that the head and the decision are unchanged, samples `recordedAt` under the lock and inserts → `finalize`. Completed before `record` resolves — so before `govern()`. |
| **running process** | Every read observes the head against the newest checkpoint this process established (local, no network). |

Crash and failure analysis (each refuses, or recovers conservatively; no
window where a payment executes and the witness never learned the ownership —
the prepare precedes the commit, which precedes `govern()`):

| case | outcome |
| --- | --- |
| C1 before `prepare` | nothing written anywhere; the presentation was refused or never governed |
| C2 after `prepare`, before the local commit | witness holds a successor the file lacks: `PENDING_RECOVERY` at the next open (and in-process); indistinguishable from "committed, then rolled back", so refused until trusted operational recovery (F7) |
| C3 after the local commit, before `finalize` | local head = witness-prepared successor: the payment may proceed (ownership is already prepared — a restore of the prior image is refused); further presentations refuse until `finalize` succeeds; the next open or transition finalizes it (F8) |
| C4 after `finalize` | consistent |
| C5 crash or failure inside the local transaction | SQLite rolls it back: C2. In process, a failed commit makes the session refuse for the life of the process (F7 / C5) |
| C6 witness unavailable | open refused; every presentation refused before governance; no timeout-to-success (F6) |
| C7 local disk failure | the store refuses (`store-unavailable`); a lost or replaced file is refused at the next open (F2, F3) |

*Coordinated local rollback.* With the witness outside the local restore
domain, restoring the business store **together with** the Governance Store,
P7 and P11 to one older image — erasing every local at-most-once record of the
payment — is still refused: the business store is refused at open, so nothing
can govern (F4: the restored P11 and Governance Store have demonstrably
forgotten the payment; zero second rail calls).

*Same-snapshot assumption.* If one backup restores the business store **and**
the witness together, the witness is defeated: nothing can then tell the old
image from the current one. This is a deployment prohibition exactly like
CORE-07's and PAY-03's: the witness must never share the local state's backup,
restore or snapshot domain (`ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md`).

*Defence in depth.* The derived key (§8.1) is kept: it still turns a
forgotten **same** operation into a replay, independent of the store.

*Composition and availability.* The ingress refuses a durable store that is
not composed under a CORE-07 boundary of its orchestrator's organization (read
from CORE-07's composition record, not from the store); an anchored store
serves exactly that organization. Protocol payments therefore depend on the
witness's availability: an outage stops them. Availability loss is accepted;
duplicate-payment eligibility is not. The volatile in-memory store remains
composable for tests and development only: it keeps no history across a
restart.

**Health.** `health()` reports `freshness`: CORE-07's `ready`, `unavailable`,
`regressed`, `forked`, `pending-recovery` or `unbound` (`not-anchored` for an
unanchored or volatile store); a failed status is unhealthy and unwritable. No
challenge, digest, witness credential or preimage appears in it.

### 10.2 Pre-hardening files, enrollment, recovery and backup

*Pre-hardening files.* PAY-04 was merged before this hardening, so a
non-empty, unanchored business-operation file may exist. It is **never
anchored after the fact**: opened with a witness, it is refused — a history
the witness has not seen from its first challenge could already have lost one.
Two safe exits:

1. **Retire it.** Keep it for audit and start a new anchored file — only once
   every challenge it records can no longer be presented: each has expired
   (the adapter refuses an expired challenge before the store), or the
   merchant has otherwise invalidated it. A challenge without `expires` cannot
   be retired this way.
2. **Enroll it** — the explicit CORE-07 enrollment ceremony,
   `createSqlitePaymentBusinessOperationStore(path, { now, freshness: { boundary, enrollment } })`
   with a trusted `AuthorityStateEnrollmentContext` (`operator: true`,
   `operatorId`, `attestation: 'verified-local-state-is-current'`). The file is
   fully verified, its store id is derived from that verified history, the
   witness enrolls it as the baseline, and only then is the anchor written. The
   operator attests what CORE-07 cannot check: that this file is the newest
   state. A refused ceremony writes nothing; enrollment never rebinds a slot.

An anchored file is written under the file schema
`aoc.payment-business-operation-store.schema.v2` (its records keep the v1
record format), so a runtime that predates the hardening — which would write
without the witness — refuses it, and this runtime refuses to open it without
its witness.

*Recovery.* There is no API that clears a refusal. A stale or lost file is
recovered by restoring the **newest** file (the witness then accepts it); a
pending transition, a fork or a lost newest file needs trusted operational
recovery at the witness, as for every CORE-07 slot. Neither recovery calls
governance, retries, or replays a payment; only a new ingress request can.

**Backup.** The Host composes no payment protocol ingress, so the store is
still not a Host store: it stays in the PROD-02 registry's
`EXCLUDED_DURABLE_STATE` (`payment-business-operations`), and `backup:v1` does
not cover it. An embedder that composes it backs its file up itself (with the
Governance Store it belongs to), and must keep the CORE-07 witness **outside**
that backup domain; a stale restore of the file is then detected by the
witness at the next open. `verifyAll()` remains the deep integrity check.

## 11. Reserved context keys (L-7)

A governed request's `assertedContext` must not be able to spell a business
operation, a challenge, a credential or a protected request. PAY-04 adds
**nothing** to the core's built-in reserved list. It supplies its words
through CORE-03's existing trusted extension, `governance.reservedContextKeys`:

- `PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS` (protocol-neutral): `businessOperation`, `businessOperationId`, `challenge`, `challengeId`, `merchantRealm`, `paymentChallenge`, `paymentChallenges`, `paymentCredential`, `paymentProtocol`, `protectedRequest`;
- each adapter's own `reservedContextKeys` (MPP: `mppChallenge`, `mppChallengeId`, `mppIntent`, `mppMethod`, `mppRealm`).

The ingress refuses to compose unless the registry it is handed reserves every
one of them (keys are matched regardless of case), so a deployment cannot run
PAY-04 with the protocol words unreserved. The compiled intent is validated
against that registry before anything is stored.

## 12. Effect paths and NO_BYPASS

PAY-04 adds **no effect path** (nine of seventy, unchanged). Parsing and
normalization are pure. The business-operation write is a local state record,
like the PAY-03 interlock — never authority and never able to cause an
execution. The ingress is one more trusted in-process caller of
`GovernedActionOrchestrator.govern()` (EP-049's orchestration entry, without
HTTP), and it reaches EP-011 / EP-069 only through it. Structurally pinned:
the edge holds no `ExecutionAdapter`, names no `PaymentRail`, calls no
`execute`, `submit` or `sign`, makes no network call, retries nothing, calls
`govern()` exactly once — after the durable record and after every refusal —
and nothing outside the edge composes it.

## 13. Composition (embedder)

```ts
const governance = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS, actionClasses, resourceClasses, profiles,
  reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS],
});
// … createEnterprise({ governedActionOrchestrator: { enabled: true, governance, … }, … })
const mpp = createMppPaymentProtocolAdapter({ methods: [/* trusted normalizers */], resolveCounterparty, selectChallenge, assets });
// CORE-07, reused: the same builder, witness configuration (AOC_ENTERPRISE_AUTHORITY_FRESHNESS_*) and credential as the
// authority stores and PAY-03 — no second witness, no new secret. Required: the ingress refuses a durable store without it.
const boundary = await buildAuthorityStateFreshnessBoundary(configuration);
const store = await createSqlitePaymentBusinessOperationStore(path, { now, freshness: { boundary } });
const ingress = createPaymentProtocolIngress({
  orchestrator: enterprise.governedActionOrchestrator, store, adapters: [mpp],
  binding: createPaymentGovernanceBinding({ action }), monetary, governance, now,
});
const outcome = await ingress.prepareAndGovern(identity, {
  businessOperationId, protocol: 'mpp', challenges: wwwAuthenticateValues,
  protectedRequest: { target, method, contentDigest? }, payment: { source: { accountId }, purpose }, envelope?,
});
```

Outcomes: `governed` (with the governed result, `operation: created | existing`,
`challenge: appended | existing`, its position), `refused` (a closed refusal
— every one **before** governance, including `store-freshness-unverified`
when the store cannot prove its history current at the witness), or
`inconsistent` (the orchestrator answered for another request id — a
composition fault, reported, never masked). The ingress refuses to compose a
durable store without its witness, or one anchored for another organization.
`createPaymentProtocolContextReader(store)` hands later work the verified
operation and its latest challenge by the trusted governed request id only.

## 14. Not in PAY-04 — and residual risks

Not implemented: x402 (PAY-08 — since delivered, at this port), Lightning (PAY-06), settlement / receipts
(PAY-05), Stripe (PAY-09), multi-rail qualification (PAY-07), MPP credential
construction or emission (proof of payment toward the merchant), merchant
authentication, any retry or resubmission, an HTTP route, Host composition of
the ingress, wallet UI, custody.

Residual risks:

1. **No merchant authenticity** (§5.2) — by protocol design.
2. **Embedder-composed only** — the shipped Host has no caller of the ingress
   and does not back its store up; an embedder owns both, and must keep the
   witness outside that backup (§10.2).
3. **Same-snapshot restore of the store and the witness** defeats the anchor
   (deployment prohibition, as CORE-07 / PAY-03) — §10.1.
4. **The governed spine's own stale restore** (Governance Store, P11, P7)
   **alone** — with the business store current — is PROD-02 residual 2,
   unchanged and identical for direct payments. Restored **together with** the
   business store, it is refused at the business store's open (§10.1, F4).
5. **Selection and normalization quality** are the host's: PAY-04 makes them
   trusted, fenced and closed, not correct.
6. **No credential handoff yet**: the context reader exists; nothing reads it
   to construct a credential.
7. **Witness availability** (§10.1): an unreachable or failed witness stops
   protocol payments, and contended writers across processes may be refused
   before governance. *Closed by the post-merge hardening:* challenge
   uniqueness across operations was not rollback-safe as merged (a new
   `businessOperationId` for an already-paid challenge after a store loss or
   stale restore paid again); it now is.
8. **A full challenge history (64) refuses even a replay** through the ingress
   (`challenge-history-full`, fail-closed, no money effect); the caller can
   still read the governed outcome directly.
9. **Expiry is checked at ingestion** (§5.3): the payment executes inside the
   call that validated a current challenge, but the merchant could still let
   that challenge lapse during a slow governance call; the future credential
   step must re-check it.
10. **Pre-hardening files** are refused until retired or explicitly enrolled
    (§10.2); the volatile store keeps no history across a restart (tests and
    development only).

## 15. Historical P13 reconciliation (`24dd264`)

| P13 capability | PAY-04 |
| --- | --- |
| RFC 9110 tokenizer, duplicate refusal, bounds, unknown parameters dropped | **reused** (reviewed; tests rewritten) |
| strict base64url, fatal UTF-8, JCS round trip, prototype-key refusal | **rewritten**: hand-written base64url and JCS so the adapter imports no Node API and nothing from the enterprise layer; lone surrogates refused |
| RFC 3339 expiry | **rewritten** without `Date` (P13's `Date.UTC` mis-dated years 0–99) |
| RFC 9530 digest binding | **reused**, moved to the protocol-neutral port (no `Buffer`) |
| trusted method normalizers, counterparty resolver, selector, snapshots | **reused** as concepts; **rewritten** to produce PAY-01 terms (a `PaymentDestination`, not a counterparty string; `externalId` → PAY-01 `reference`; rail preference as composition) |
| exact P9 money | **reused** (single P9 ingress) |
| realm, body digest, expiry binding | **reused**; the protected request is now a protocol-neutral, closed PAY type, and its `target` is no longer the governed resource (PAY-01 makes the source account the resource) |
| business-operation identity, derived key, orchestrator's request-id derivation | **reused**, renamed protocol-neutral (`aoc.payment.business-operation.v1`, `aoc.pay.bop:`) |
| business semantic digest | **rewritten** over the canonical `PaymentIntent` + binding (P13 hashed its own envelope-shaped terms and `intent: 'charge'`) |
| `mpp-business-operation-store` (SQLite + memory, `BEGIN IMMEDIATE`, append-only, verify-first, money as TEXT, no status / secret) | **rewritten** as the protocol-neutral `payment-business-operation-store` with challenge evidence underneath, a one-operation-per-challenge unique index (new: M30), open-time `verifyAll()`, `description` no longer stored |
| challenge refresh history, refresh ≠ retry, P11 / P12 replay, no retry | **reused** and re-proven on current main (including on the XRPL rail) |
| `GovernedActionIntent` built directly by the MPP service | **rejected** — superseded by PAY-01: the ingress builds a `PaymentIntent` and compiles it with `compilePaymentIntent` |
| `mpp*` / `paymentChallenge` / `merchantRealm` words added to `governed-action/intent.ts`'s built-in reserved list | **rejected** (Master Plan L-7) — supplied through CORE-03's `reservedContextKeys` instead |
| `src/enterprise/mpp-challenge` / `mpp-business-operation-store` beside the core enterprise modules; `createEnterprise({ mppChallengePayments })`; `AocEnterprise` surfaces; a health module; enterprise configuration and env var | **rejected** — protocol code lives under PAY; the ingress is a protocol-neutral composition edge an embedder composes; no core composition, configuration or Host module |
| "Not in portability v1 backup (P17)" | **superseded** by PROD-02: the store is classified in the registry (excluded, with the stale-restore analysis) |
| P14 handoff by `requestId` | **reused** as the protocol-neutral `createPaymentProtocolContextReader`; `credentialHeaderField` stays an MPP helper (`mppCredentialHeaderField`) |
| SEC-INV-123 … 137, SEC-TRUST-010, A-32, threat model 7.23 (P13's numbering) | **superseded** — those numbers are taken on `main`; PAY-04 records SEC-INV-238 … 245 (and the post-merge hardening SEC-INV-246 … 249) and threat model §7.30 |

## 16. Test map

| layer | file |
| --- | --- |
| A parser | `protocols/mpp/tests/mpp-challenge-parser.test.ts` |
| B/C interpretation, normalization | `protocols/mpp/tests/mpp-payment-adapter.test.ts`; port: `tests/payment-protocol.test.ts` |
| D store | `src/enterprise/__tests__/pay04-business-operation-store.test.ts` |
| E concurrency | `pay04-business-operation-concurrency.test.ts` (worker threads, independent connections) |
| F restart / rollback | `pay04-business-operation-store.test.ts`, `pay04-mpp-governed-payment.test.ts` |
| R rollback safety (post-merge hardening, F1 – F12) | `pay04-rollback-safety.test.ts` (reference witness over loopback HTTP, its own database); anchored races in `pay04-business-operation-concurrency.test.ts`; structure in `pay04-payment-protocol-structure.test.ts` |
| G/H PAY-01 compiler, governed path, P11 / P12 | `pay04-mpp-governed-payment.test.ts` |
| I rail neutrality | `protocols/mpp/tests/mpp-protocol-boundaries.test.ts`, `tests/payment-runtime-boundaries.test.ts` |
| J PAY-02 / PAY-03 regression | `pay04-mpp-xrpl-regression.test.ts`, plus the unchanged PAY-01 / PAY-02 / PAY-03 suites |
| K NO_BYPASS / CORE purity | `pay04-payment-protocol-structure.test.ts` |
| L backup / restore | store-level copy-restore and stale-copy tests above; coordinated PAY-04 + Governance Store + P11 + P7 restore (F4); `portability-store-registry.structure.test.mjs` |

The M1 – M40 and I1 – I12 matrices are named in the test titles.
