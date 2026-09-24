# ADR — MPP Challenge Adapter and Business-Level Idempotency (P13)

- **Status:** Accepted
- **Increment:** P13
- **Depends on:** `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9), `ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md` (P10),
  `ADR-DURABLE-MONETARY-OUTCOMES.md` (P11), `ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md` (P12),
  `ADR-EXERCISE-AGGREGATE-CONTROLS.md` (P7), `docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md`
- **Security invariants:** `docs/security/SECURITY_INVARIANTS.md` SEC-INV-123 … SEC-INV-137
- **Leaves for later:** MPP credential construction, credential-header emission, Stripe method semantics,
  credential custody and provider execution (P14); receipts, settlement and obligations (P15); payment
  observability (P16); XRPL (P18); signatures / KMS / HSM (P20)

## 1. Context

A governed machine asks an external merchant for a resource. The merchant answers
`402 Payment Required` with one or more `WWW-Authenticate: Payment …` challenges (the Machine
Payments Protocol). Before P13, Frontera had no way to turn that answer into a governed action, and
no notion of *which purchase* a challenge belongs to. Two hazards follow directly from the protocol:

- **Challenges refresh.** A merchant issues a new challenge `id`, `expires` and `opaque` on every 402.
  A client that treats a challenge as the identity of its purchase pays again every time it retries.
- **Challenge identity is not verifiable by the client.** The `id` is bound by the issuing server
  under a secret the client never holds.

Frontera already has technical idempotency: `(organization, principal, idempotencyKey)` derives one
governed `requestId`, resolved in the Governance Store before the Kernel, and `requestId +
decisionId` derives one `executionId`, which the write-ahead claim executes at most once. What it
did not have is the business layer above it: *is this still the same purchase, even though the
challenge, its expiry, the rail or the network request changed?*

## 2. Decision

> **A machine payment is a governed action, not a new authority model. An MPP challenge requests a
> payment; it grants no authority, and its identity is not the identity of the purchase. One stable,
> caller-named business operation maps deterministically to one governed request — across challenge
> refreshes, transport retries, restarts and rail alternatives — and is durable before governance.**

```text
EXTERNAL MERCHANT: 402 + WWW-Authenticate: Payment …
      │
      ▼
P13 CHALLENGE BOUNDARY  (src/enterprise/mpp-challenge)
  parse (RFC 9110 §11)      validate (draft-httpauth-payment-01)
  realm / body digest       against the trusted protected request
  expiry                    against the injected clock
  trusted method normalizer → exact P9 amount
  trusted counterparty resolver → Frontera counterparty
  trusted selector          → exactly one challenge, no first-wins
      │
      ▼
P13 BUSINESS OPERATION STORE  (src/enterprise/mpp-business-operation-store)
  (org, principal, businessOperationId) → semantic digest, derived key, requestId
  append-only challenge history
      │  durable BEFORE governance
      ▼
GovernedActionIntent { action, resource, counterparty, amount, idempotencyKey = derived }
      │
      ▼
Kernel → committed decision → bounded grant → P10 → P7 → P11 prepare → P12 bind → claim → adapter
      │
      └── P14 LATER: adapter reads the challenge by ValidatedExecutionAction.correlation.requestId
```

No `MppKernel`, `PaymentDecision`, `PaymentGrant`, MPP policy engine, MPP budget or second
execution path exists. The Kernel, P10, P7, P11 and P12 are unchanged and unaware of MPP.

## 3. Protocol baseline

| item | value |
| --- | --- |
| Specification repository | `tempoxyz/mpp-specs`, `main` at `08e7dd873a69866ae2cde74678fc2eaf6d72d22b` (2026-09-23) |
| Core draft | `draft-httpauth-payment-01` (IETF individual submission, posted 2026-09-09) |
| Intent draft | `draft-payment-intent-charge-00` |
| Licence of the drafts | CC0 1.0 (repository `specs/`) |
| Required challenge parameters | `id`, `realm`, `method`, `intent`, `request` |
| Optional challenge parameters | `expires`, `digest`, `description`, `opaque`, `header` |
| `method` | `1*LOWERALPHA`, case-sensitive |
| `intent` | `1*( ALPHA / DIGIT / "-" )`; only `charge` is supported |
| `request` | base64url, no padding, of JCS (RFC 8785) JSON |
| `opaque` | base64url, no padding, of a JCS flat string → string map; echoed unchanged |
| `expires` | RFC 3339 date-time; clients must not submit credentials for expired challenges |
| `digest` | RFC 9530 content digest of the request body (`sha-256=:…:`) |
| `header` | absent → credential in `Authorization`; `Payment-Authorization` → that field; any other value is an unrecognized challenge |
| Unknown parameters | ignored by clients |
| Duplicate parameters | not specified by the draft |
| Challenge binding | server-side and implementation-defined (HMAC, AEAD or state); clients cannot verify it |

### 3.1 Parser ownership

The official TypeScript SDK (`mppx` 0.11.0, MIT) exposes a challenge parser, but its root entry
requires `viem` as a non-optional peer and bundles Stripe, EVM, x402 and wallet code; it also
departs from the draft (a looser `method` pattern, any token accepted as `header`, a non-RFC-9530
body digest, `request` decoded with no canonicality check and re-serialized). P13 therefore owns a
**narrow local parser** (`mpp-challenge/protocol.ts`) and adds **no dependency**:

- an RFC 9110 §11 tokenizer for `#challenge` lists — `token BWS "=" BWS (token / quoted-string)`,
  token68, multiple challenges per field value and multiple field values — which decides whether a
  comma separates two parameters or two challenges by lookahead, never by `split(',')`;
- strict base64url (alphabet, no padding, exact round trip), fatal UTF-8, bounded JSON, and a JCS
  round trip through `aoc.canonical-json.v1` (sorted UTF-16 keys, ECMAScript string and number
  serialization — RFC 8785 for JSON-parsed data);
- strict RFC 3339 and RFC 9530 (dictionary of byte sequences; `sha-256` and `sha-512` recognized,
  others ignored).

**Conformance source.** The specification repository publishes no client parsing vectors; its only
vectors are the server-side HMAC ones. Their `request` / `opaque` encodings and resulting ids are
used as parse vectors, and every other case is built from the draft's normative text
(`mpp-challenge-protocol.test.ts`).

### 3.2 Strictness beyond the draft (fail closed)

- A duplicated known parameter makes the challenge invalid — never first-wins or last-wins.
- `request` and `opaque` must be JCS-canonical; a duplicate member, whitespace, key order or
  alternative number spelling fails the round trip.
- `__proto__`, `constructor` and `prototype` are refused as JSON member names.
- A structurally invalid Payment challenge is never usable; a malformed field value refuses the set.
- Bounds: 16 KiB of field values, 16 values, 16 challenges, 32 parameters per challenge, 8 KiB per
  parameter, 6 KiB decoded `request`, 2 KiB decoded `opaque`, JSON depth 16 and 256 members.

## 4. Challenge authenticity: the limitation, stated

> **Frontera cannot authenticate an MPP server's HMAC or stateful challenge binding from the client
> side. P13 validates the challenge's structure, its request binding, its expiry and its trusted
> business interpretation; the merchant verifies its own challenge binding when a future P14
> credential is submitted.**

Nothing in P13 says "authentic" about a challenge. A well-formed challenge is a *proposal*.

## 5. What is trusted, and from where

| input | source | trust |
| --- | --- | --- |
| identity | `BoundCustomerIdentity` from customer admission | trusted, read via the orchestrator's `boundScopeOf` |
| `businessOperationId`, `action` | trusted in-process caller | names only; the Kernel still decides |
| `protectedRequest.resource` | the host's trusted mapping of the external request | the governed `resource` — never the realm, never a URL |
| `protectedRequest.httpMethod` / `expectedRealm` / `contentDigest` | the host's network layer | trusted descriptor; no URL, query, header, cookie or body |
| challenge fields | the merchant | untrusted protocol data |
| amount | a trusted **method normalizer** (`methodId` + `charge`) | its output is untrusted executable output: read from data descriptors, closed keys, then P9 |
| counterparty | a trusted **counterparty resolver** | a merchant string never becomes a counterparty by copying |
| choice between challenges | a trusted **selector** | synchronous, snapshotted, asked even for one candidate |

The method normalizer owns method semantics: base units, the method's currency spelling and its
mapping to a P9 asset. P13 core never guesses decimals, never maps a currency symbol to an asset,
never converts between assets, and contains no Stripe, EVM or XRPL vocabulary. The normalizer's
answer has three fields — `amount`, `merchantReference?`, `externalId?` — and anything else
(`authorized`, `ceiling`, `budget`, `grant`, `paid`, `counterparty`, `businessOperationId`,
`idempotencyKey`, a getter, a Proxy, a promise, a number amount) refuses the challenge.

`realm` is a protection-space identifier. It is compared to the expected realm when the network layer
knows one, and passed to the counterparty resolver as context; it is never an organization,
principal, actor, counterparty or authority.

### 5.1 Request-body binding

A body-bearing protected request (`POST`, `PUT`, `PATCH`, or any request the network layer digested)
is eligible only when the challenge carries a `digest` that shares a recognized algorithm with the
trusted `contentDigest` and agrees on every shared one. A body-bearing request without a trusted
digest is refused outright, and a challenge `digest` on a request without a body is refused. P13 never
hashes `body.toString()`: the network layer supplies RFC 9530 digests (`computeContentDigest` is
provided for exact bytes). No body is persisted.

### 5.2 Expiry

`expires` is checked against the injected clock at ingestion; a challenge at or past its expiry is
unusable. Expiry **never** expires the business operation: a refreshed challenge after expiry is
another instance of the same operation. P14 must re-check `expires` with its own clock before it
builds a credential (`isMppChallengeUsableAt`); ingestion-time validity is not claimed to last.

## 6. Business operation identity

- **Scope:** `(organizationId, principalId, businessOperationId)`. It matches the governed-action
  principal isolation: one principal cannot pre-claim another principal's business identifiers, and
  nothing is shared across organizations. No organization-wide namespace is introduced.
- **Stable** across a replayed challenge, a refreshed challenge, an HTTP retry, a process restart, a
  method alternative and a lost response. **New** for a deliberately new purchase — P13 never infers
  "same URL" or "same challenge" means "same purchase", and never dedupes challenges globally.
- **Never** a challenge `id`, `expires`, `opaque`, a `providerRef`, an `executionId`, a `requestId`, a
  timestamp or a per-attempt random value. It is a name; it grants nothing.

### 6.1 Business semantic digest

`computeMppBusinessSemanticDigest` — SHA-256 over `aoc.canonical-json.v1`, domain
`aoc.mpp.business-semantics.v1` — commits to:

| included | excluded (challenge-instance or transport volatility) |
| --- | --- |
| organization, principal, businessOperationId | challenge `id`, `expires`, `opaque` |
| governed `action`, Frontera `resource`, Frontera `counterparty` | `description`, `header`, `realm` |
| exact `amount.value` and `amount.unit` (P9) | payment `method` |
| MPP intent (`charge`) | the method's raw recipient (`merchantReference`) |
| protected request HTTP method | arrival time, header formatting |
| canonical RFC 9530 body digest, when there is a body | |
| `externalId`, when the trusted normalizer states one | |

`method` and the raw recipient are excluded so that two rails whose trusted normalizers and resolver
yield identical amount, asset, counterparty, resource and intent are one purchase. `externalId`, a
merchant order identity the method defines, is included: a different merchant order is a different
purchase. It never replaces `businessOperationId`.

The same `businessOperationId` with a different digest — 10 → 11 USD, USD → USDC, merchant A → B,
resource, action, body, HTTP method or external order — is `business-operation-conflict`, refused
before governance, and the original operation is never updated.

### 6.2 Governed identity derivation

```text
idempotencyKey = "aoc.mpp.bop:" + sha256(JSON ["aoc.mpp.business-operation.v1", org, principal, businessOperationId])
requestId      = deriveGovernedActionRequestId({ org, principal, idempotencyKey })   ← the orchestrator's own function
```

Deterministic across restarts, no clock, no randomness. `requestId` is computed by importing the
orchestrator's derivation — P13 cannot disagree with it — and the service checks that the governed
result's `requestId` equals the prediction (`inconsistent` otherwise; never masked). An ordinary
governed-action caller's key cannot *accidentally* equal a derived key; a caller who deliberately
submits the exact 76-character derived key under its own principal produces an ordinary governed
request that the P13 operation then replays or conflicts with — never a second effect, never another
principal's request.

The existing Governance Store idempotency stays the second barrier and the only one inside the
spine: a refreshed challenge produces the byte-identical `GovernedActionIntent`, which replays the
committed decision before the Kernel. No second idempotency mechanism is added to the Kernel.

## 7. Durable store (`src/enterprise/mpp-business-operation-store/`)

Its own SQLite file (`mppBusinessOperation.sqlitePath`, `AOC_ENTERPRISE_MPP_BUSINESS_OPERATION_SQLITE_PATH`,
default `.data/mpp-business-operations.sqlite`) under `persistence.provider = 'sqlite'`; a
process-local store otherwise, which gives **no** business idempotency across a restart. Never the
Governance Store, the P7 ledger, P11, P12, the Kernel Authority Store or P8.

| table | key | holds |
| --- | --- | --- |
| `mpp_business_operations` | `PRIMARY KEY (organization_id, principal_id, business_operation_id)`; `UNIQUE (organization_id, governed_request_id)` | the terms, semantic digest, derived key and request id; money as `TEXT` |
| `mpp_challenge_instances` | `PRIMARY KEY (organization_id, principal_id, business_operation_id, challenge_sequence)` | each accepted challenge, exact strings; `description` as bounded untrusted text |

- `WAL`, `synchronous = FULL`, busy timeout; the schema guard
  (`aoc.mpp-business-operation-store.schema.v1`) runs **before** `CREATE TABLE IF NOT EXISTS`.
- One `BEGIN IMMEDIATE` per write: load the operation **and every challenge row**, verify all of them,
  decide created / existing / conflict and appended / existing, sample `recordedAt`, insert. The
  operation and its first challenge are written atomically.
- Triggers refuse `UPDATE` and `DELETE` on both tables. There is no status, outcome, credential or
  secret column: what an execution did is P11's and P12's.
- The challenge sequence is store-assigned (1, 2, 3 …) inside the transaction — never caller-chosen,
  never derived from `expires`. An identical challenge (by challenge digest) is idempotent. At most 64
  distinct challenges per operation; a further one is refused without evicting anything.
- Every read re-validates each row, recomputes its record digest, **recomputes the semantic digest,
  the derived key and request id from the terms**, recomputes each challenge digest over the exact
  fields (`description` excluded), requires sequences 1…n without a gap, and requires at least one
  challenge — before any row's sequence can select it. Corrupt state is
  `MPP_BUSINESS_OPERATION_CORRUPT`: never repaired and never read as "no previous operation".
- Tenant scope on every call; no `system` escape.
- Integrity, not authenticity (P20). Not in portability v1 backup (P17), like P7, P8, P11 and P12.

## 8. Order, crash and concurrency semantics

```text
parse → validate → realm/digest/expiry → normalize → resolve counterparty → select
  → validate the adapted intent (the orchestrator's own validator, P9)
  → store.record(operation + challenge)        durable, or nothing below runs
  → orchestrator.govern(identity, intent)
  → requestId agreement
```

Every refusal is before `govern()`: no Kernel evaluation, grant, P7 reservation, P11 preparation,
P12 binding, claim or adapter call. A crash after the record and before governance leaves an
operation whose next presentation governs normally. A crash anywhere inside governance is the
existing orchestrator's: preparation, binding and the write-ahead claim keep at-most-once.

Concurrency: the primary key and `BEGIN IMMEDIATE` decide, across processes (`mpp-business-operation-concurrency.test.ts`
races worker threads on one file). Two equivalent writers converge on one operation and one request;
10 USD racing 11 USD produces exactly one semantic identity and a conflict for the other. In-process,
100 concurrent submissions of one operation produce one governed request and at most one adapter call
(`mpp-challenge-payments-e2e.test.ts`).

### 8.1 Replay of what already happened

A refreshed challenge for an operation whose request already executed, failed, stayed unconfirmed,
or was resolved by P12 replays exactly that, through the existing orchestrator. **P13 never retries.**
Even when P12 proves `confirmed-not-completed` and P7 returns the capacity, the same operation replays
`execution_failed`: the write-ahead claim still stands, and a second payment needs a new
`businessOperationId`. P13 defines no retry-generation model.

## 9. The P14 handoff

`ValidatedExecutionAction` is **not** widened. A future payment adapter is composed with the
read-only `MppChallengeContextReader` and calls
`readByGovernedRequestId(organizationId, action.correlation.requestId)` — the trusted correlation it
is already handed — to receive the verified operation terms, the latest accepted challenge's exact
fields, its sequence and digest, and `credentialHeaderField` (`Authorization` or
`Payment-Authorization`: the **merchant's** field on the **external** request, never Frontera's
customer `Authorization`). Lookup by a caller- or adapter-supplied challenge id does not exist.
Reading a context is not authority: an adapter runs only after the Kernel, the grant and P7.

## 10. Surfaces and compatibility

- `createEnterprise({ mppChallengePayments: { enabled, methods, selectChallenge, resolveCounterparty, store? } })`;
  requires `governedActionOrchestrator`. Composition errors are `MppChallengeConfigurationError`.
- `AocEnterprise.mppChallengePayments.prepareAndGovern(identity, request)` and
  `AocEnterprise.mppChallengeContexts` — trusted in-process only. Health module
  `aoc.enterprise.mpp-business-operations` (optional).
- **No endpoint (28 unchanged), no request or response field, no status, no reason code, no SDK
  change.** `POST /api/governed-actions` is unchanged; P13 words at its top level were already
  refused as undeclared, and `businessOperationId`, `challenge`, `challengeId`, `mppChallenge`,
  `mppMethod`, `mppIntent`, `mppRealm`, `paymentChallenge`, `paymentCredential` and `merchantRealm`
  join the reserved `assertedContext` keys.
- P13 refusals are an internal closed vocabulary (`MPP_CHALLENGE_REFUSALS`), not Kernel denials and
  not on any wire.
- P8: no new event vocabulary. The canonical store already holds the history; evidence would add
  nothing load-bearing.

## 11. Non-goals

No credential construction or emission, no Stripe (method, PaymentIntent, SPT, keys), no EVM, XRPL,
wallet, private key or signature, no provider or merchant network call (P13 performs no network I/O at
all), no automatic retry or challenge refetch, no receipt, settlement, refund or finality, no
subscription or authorize intent, no FX, no new HTTP route, no KMS/HSM.
