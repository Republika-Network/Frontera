# ADR — Payment Protocol Adapter Boundary, MPP and Business-Operation Idempotency (PAY-04)

- **Status:** Accepted
- **Milestone:** PAY-04 (planned as PAY-02 under MASTER-01; historically P13)
- **Depends on:** `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01), `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9),
  `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11), `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12),
  `ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md` (CORE-03, reserved keys L-7),
  `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07, decided against here)
- **Detail:** `docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md`
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-238 … SEC-INV-245; threat model §7.30
- **Supersedes:** the unmerged P13 ADR `ADR-MPP-CHALLENGE-AND-BUSINESS-IDEMPOTENCY.md` on branch `24dd264` (never on `main`)

## 1. Context

A governed machine asks a merchant for a resource; the merchant answers with a
payment protocol challenge (MPP: `402` + `WWW-Authenticate: Payment …`). Three
hazards follow from the protocol itself:

1. **The challenge is untrusted** — it states terms; it cannot carry authority.
2. **Challenges refresh** — a new `id`, `expires` and `opaque` per 402. A
   client that treats a challenge as the identity of its purchase pays again
   on every refresh.
3. **A client cannot authenticate a challenge** — its `id` is bound under a
   server secret.

P13 (`24dd264`) addressed all three before PAY-01 existed: it built the
governed envelope by hand, lived beside the core enterprise modules and added
`mpp*` words to the core's reserved-key list. Current `main` has the canonical
`PaymentIntent`, its compiler, a rail port, CORE-03's reserved-key registry,
PROD-02's store registry and CORE-07's freshness witness. The Master Plan
requires that an MPP challenge produce a governed payment intent through the
unchanged spine, with no `mpp*` symbol in CORE.

## 2. Decisions

**D1 — A protocol is an ingress, not a rail.** The boundary is
`PaymentProtocolChallenge → PaymentProtocolAdapter → PaymentIntent`. A protocol
adapter normalizes and binds; it never authorizes, executes, signs, submits,
holds a credential, calls a rail, resolves settlement or retries. Which rail
executes is trusted routing's call; MPP → XRPL is composition, never law.

**D2 — The port is protocol-neutral and lives in PAY.**
`PaymentProtocolAdapter.interpret(challenges, { organizationId,
businessOperationId, protectedRequest, observedAtEpochMilliseconds })` returns
`PaymentProtocolTerms` (a PAY-01 destination, P9 money, PAY-01's optional
`reference` and `rail`) plus challenge evidence, or one of seven closed
refusals. It lives in PAY-01's contract (`domain/payment-protocol.ts`), held to
its boundary test; adapters live below it in `protocols/`, like rails in
`rails/`. x402 (PAY-08) implements the same port.

**D3 — The canonical `PaymentIntent` is reused, unchanged.** No new intent
model, no new `PaymentIntent` field, no new envelope field. The adapter's terms
become a `PaymentIntent` through PAY-01's validator
(`paymentIntentOfProtocolTerms`); the trusted half — source, purpose,
idempotency key — is never the protocol's. The ingress compiles with PAY-01's
`compilePaymentIntent` and never hand-builds a `GovernedActionIntent`.

**D4 — Everything the challenge says passes through trusted configuration.**
Trusted method normalizers (exact P9 money; a merchant order reference),
trusted counterparty resolution (a PAY-01 destination; a merchant string is
never copied), trusted selection (asked even for one; never first-wins), a
trusted protected-request description (realm, body digest), and a trusted
clock instant. Every trusted function's answer is still read as untrusted
executable output: closed keys, data descriptors, PAY-01 grammars, P9.

**D5 — Binding is not authenticity.** PAY-04 binds a challenge to the request
it pays for (realm, RFC 9530 body digest, expiry) and states plainly that it
cannot verify the merchant authored it.

**D6 — Business-operation identity is derived, and the governed key is derived
from it.** `(organization, principal, businessOperationId)` →
`idempotencyKey = "aoc.pay.bop:" + sha256(domain-tagged JSON)` →
`requestId` by the orchestrator's own derivation. The derivation reads no
clock, randomness, store or challenge. A challenge id is not the business
operation id; a request id is not either.

**D7 — Refresh replays; it never retries.** Same operation, same semantics,
new challenge → the same governed request → the Governance Store replays
whatever happened (executed, failed, withheld, unconfirmed, P12-resolved).
Same operation, different semantics → conflict before governance. PAY-04
defines no retry and cannot cause one; P12 stays the only authority for an
ambiguous outcome.

**D8 — A protocol-neutral durable business-operation store.**
`payment_business_operations` + `payment_protocol_challenges` (SQLite;
`BEGIN IMMEDIATE`; append-only triggers; verify-first; money as `TEXT`; no
status, credential or secret column; schema-version guarded). One operation per
scope (primary key) and one operation per challenge identity (unique index): a
challenge captured for one purchase cannot pay for another.

**D9 — No CORE-07 anchor for the business store.** Because the governed key is
derived (D6), a lost or rolled-back business store cannot make a paid or
unconfirmed operation eligible for a second payment: same terms replay at the
Governance Store; changed money terms hit its idempotency conflict. What a
rollback loses — challenge history and protected-request conflict detection —
moves no money for an existing operation. It does lose the cross-operation
challenge-uniqueness record (D8), so a caller that then mints a new business
operation for an already-paid challenge pays again — accepted as a
caller-dependent residual rather than anchoring the index, which would make
every protocol payment depend on the witness; revisitable per deployment. The spine's own stale-restore
residual (PROD-02 residual 2) is unchanged and identical for direct payments.

**D10 — Reserved keys through CORE-03 (L-7).** Protocol-neutral words
(`PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS`) and each adapter's own
(`MPP_RESERVED_CONTEXT_KEYS`) reach the core only as trusted
`governance.reservedContextKeys` configuration; the ingress refuses to compose
unless the registry reserves all of them. The core's built-in list is
unchanged.

**D11 — Library / service boundary, no endpoint, no Host composition.** The
ingress is a trusted in-process service composed by an embedder beside
`AocEnterprise.governedActionOrchestrator`. It is a second payment composition
edge (`src/enterprise/payment-protocol-ingress/`) beside PAY-03's, and names no
protocol or rail. No route, SDK method, package export, Host configuration or
Host module. The store is therefore classified in PROD-02's registry as
excluded durable state (embedder-owned backup), with D9's reasoning.

**D12 — Pin the protocol; no dependency.** `draft-httpauth-payment-01` /
`draft-payment-intent-charge-00` at mpp-specs `08e7dd8`, P13's pin, unchanged.
The parser is repository-contained; `mppx` stays rejected.

## 3. Consequences

- PAY-01's contract gains one protocol-neutral file and its barrel exports;
  `PaymentIntent`, the compiler, the bridge and the rail contract are
  unchanged. PAY-02 and PAY-03 are unchanged.
- The core is unchanged: no file outside the payment vertical and its two
  composition edges changed, and the structural tests pin that no protocol
  word entered it.
- NO_BYPASS: no new effect path (nine of seventy).
- A deployment that wants MPP must compose it (D11) and register the reserved
  keys (D10); a deployment that does not is unaffected.

## 4. Alternatives rejected

- **Merge P13 as-is** — hand-built envelope, core reserved keys, enterprise
  placement, P17-era backup stance (Master Plan L-7 and PAY-01 forbid them).
- **Challenge id as the governed key** — refresh would mint a second payment.
- **A business store as the duplicate barrier, CORE-07-anchored** — makes
  availability depend on the witness for no safety gain (D9).
- **An MPP endpoint on the Host** — a second way in; the existing governed
  ingress already exists and the exit criterion does not need one.
- **`mppx`** — dependency footprint and a parser more permissive than the
  draft.
