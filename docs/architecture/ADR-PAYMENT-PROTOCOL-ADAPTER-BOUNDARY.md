# ADR — Payment Protocol Adapter Boundary, MPP and Business-Operation Idempotency (PAY-04)

- **Status:** Accepted — amended by the PAY-04 post-merge rollback-safety hardening (D9 superseded by D13)
- **Milestone:** PAY-04 (planned as PAY-02 under MASTER-01; historically P13)
- **Depends on:** `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01), `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9),
  `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11), `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12),
  `ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md` (CORE-03, reserved keys L-7),
  `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07 — first decided against (D9), then adopted by the post-merge hardening (D13))
- **Detail:** `docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md`
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-238 … SEC-INV-249 (SEC-INV-246 … 249: the post-merge hardening); threat model §7.30
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
challenge captured for one purchase cannot pay for another — across restart,
loss and rollback since the post-merge hardening (D13).

**D9 — No CORE-07 anchor for the business store.** *Superseded by D13.* As
merged: because the governed key is derived (D6), a lost or rolled-back
business store cannot make a paid or unconfirmed operation eligible for a
second payment — same terms replay at the Governance Store; changed money
terms hit its idempotency conflict. A rollback does lose the cross-operation
challenge-uniqueness record (D8), so a caller that then mints a new business
operation for an already-paid challenge pays again; that was accepted as a
caller-dependent residual rather than making every protocol payment depend on
the witness.

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

**D13 — The challenge-ownership history is anchored at the CORE-07 witness
(post-merge hardening; supersedes D9).** An independent post-merge review
showed D9's residual is not caller-dependent in any useful sense: a stale
restore or a lost store makes an already-paid challenge look unowned, and a
new `businessOperationId` for it — which the application layer may mint quite
legitimately, e.g. after its own state was restored with the same backup —
derives a new governed key, a new governed request, and a second rail call
(reproduced on the durable store, completed and unconfirmed). Deterministic
business-operation keys protect rollback for the **same** operation; they
cannot protect a challenge reused under a **new** one, because the governed
spine never sees a challenge identity. Rollback must not reopen
duplicate-payment eligibility, so the record that decides it must be
rollback-resistant:

- **Slot.** One new protocol-neutral CORE-07 state kind,
  `payment-business-operation-state`, beside PAY-03's operational
  `xrpl-submission-reservations`. CORE-07 learns its name and nothing else —
  no protocol, realm, header, method or rail word; it imports no payment code;
  the slot is never enrolled by the authority ceremony. The same witness,
  configuration and credential as CORE-07 and PAY-03; no new witness service,
  secret or signer.
- **What is anchored.** The minimal state whose loss reopens eligibility: the
  ownership history — every accepted challenge row, in commit order, as a
  domain-separated hash chain over (organization, principal,
  `businessOperationId`, business semantic digest, governed request id,
  challenge identity, challenge digest, position), from a genesis bound to the
  store id and organization (sequence = rows). An operation's creation is its
  first row, so its semantic digest is anchored with it. Refreshed challenges
  are anchored too: each new challenge identity becomes owned, and a later
  cross-operation check depends on it. Timestamps, exact fields and the
  protected-request terms stay local, under the existing record digests.
- **Order.** Every accepted challenge is one CORE-07 transition — `prepare` →
  `BEGIN IMMEDIATE` commit (head and decision re-checked) → `finalize` —
  completed before the store answers, so before `govern()`; every
  presentation, even a pure replay, compares the witness with the file first.
  Never govern → execute → anchor afterwards.
- **Open.** Reconciled with the witness before the store is handed to
  anything: older, lost, forked, pending or substituted history refuses.
  Genesis is enrolled before first use. A non-empty pre-hardening file is
  never adopted silently: only the explicit CORE-07 enrollment ceremony
  anchors it (store id derived from its verified history; nothing written if
  the witness refuses). Anchored files are schema v2, so a pre-hardening
  runtime refuses them.
- **Composition.** The ingress composes only a store composed under a CORE-07
  boundary of its orchestrator's organization (read from CORE-07's own
  composition record), or the volatile test store; a durable store without a
  witness is a configuration error. An anchored store serves exactly one
  organization (the slot's).
- **Availability.** An unreachable or failed witness refuses protocol
  payments. Availability loss is acceptable; duplicate-payment eligibility is
  not.
- **Layered, not replaced.** D6's derived key stays: it still makes a
  forgotten **same** operation replay, as defence in depth beneath the anchor.
- **Trust domain.** The witness must be outside the restore domain of the
  business store **and** of the Governance Store, P7 and P11: then even a
  coordinated rollback of all of them is refused (tested). A single snapshot
  restoring the witness with them defeats it — the same deployment
  prohibition as CORE-07 and PAY-03, not a guarantee.

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
- A deployment that wants MPP must compose it (D11), register the reserved
  keys (D10) and compose the durable store under its CORE-07 freshness
  boundary (D13); a deployment that does not is unaffected.
- Post-merge hardening: CORE-07's closed kind list gains one protocol-neutral
  operational slot; nothing else in CORE changes. Protocol payments now depend
  on the witness's availability (D13).

## 4. Alternatives rejected

- **Merge P13 as-is** — hand-built envelope, core reserved keys, enterprise
  placement, P17-era backup stance (Master Plan L-7 and PAY-01 forbid them).
- **Challenge id as the governed key** — refresh would mint a second payment.
- **A business store as the duplicate barrier, CORE-07-anchored** — first
  rejected as "availability for no safety gain" (D9); the post-merge review
  showed the safety gain (cross-operation reuse after rollback), and D13 adopts
  it, as a layer **above** the derived key rather than in place of it.
- **Anchoring the whole business-operation store, or only operation creation**
  — the first anchors timestamps and evidence that move no money; the second
  misses refreshed challenge identities, each of which becomes owned (D13).
- **Recording challenge identities in the Governance Store** — would put
  protocol evidence into CORE and still roll back with it in a coordinated
  restore.
- **A second, PAY-specific witness** — a duplicate freshness mechanism, a
  second credential and a second trust domain to keep apart; CORE-07 already
  supplies exactly the needed compare-and-advance.
- **An MPP endpoint on the Host** — a second way in; the existing governed
  ingress already exists and the exit criterion does not need one.
- **`mppx`** — dependency footprint and a parser more permissive than the
  draft.
