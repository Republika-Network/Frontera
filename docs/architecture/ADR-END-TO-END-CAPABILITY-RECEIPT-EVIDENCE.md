# ADR: End-to-end capability presentation and verified executor receipt evidence (G-02C1D)

**Status:** Accepted for G-02C1D (reference only, synthetic)
**Extends:** `ADR-SIGNED-EXECUTOR-RECEIPTS.md` (G-02C1C), `ADR-DURABLE-CONSUMPTION-SYNTHETIC-EXECUTION.md` (G-02C1B), `ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md` (G-02C1A), the G-02C0 binding gate and the G-02B issuer
**Security statement:** `docs/security/G-02C1D-END-TO-END-RECEIPT-EVIDENCE.md` · invariants SEC-INV-406 … SEC-INV-414 (and SEC-INV-376, amended)
**Founder decisions:** D1 (the one presentation header) and D8 (the additive evidence store), authorized for this milestone. A read-only receipt retrieval route is **not** authorized and not built (§7).

## Context

Through G-02C1C every piece of the governed-execution path existed, but not as one path: the G-02C0 gate issued and verified a capability for the exact request and then discarded it; the reference executor could verify, consume, perform and receipt — but only for capabilities a test handed it; and nothing on the Host read a receipt. G-02C1D joins them, without changing any protected contract.

## Compatibility map (what each integration point needed)

| Integration point | Before | G-02C1D | Protected contract changed? |
|---|---|---|---|
| G-02A capability wire format | closed, 18 fields | unchanged | no |
| G-02B issuer, custody, issuance ledger | one caller (the gate) | unchanged; the recorder **reads** `read(executionId)` through a structural read-only view | no |
| G-02C0 binding `frontera.http-request-binding.v1` | over the frozen mapped request | unchanged; computed over the request **without** the presentation header | no |
| G-02C0 verdict | `{ proceed: true } \| { proceed: false }` | `{ proceed: true; presentation?: string } \| { proceed: false }` | **yes — D1, SEC-INV-376 amended** |
| Generic HTTP mapper | reserved header names | + `frontera-execution-capability`, `frontera-execution-receipt` (mapping, credential header, provider reference) | additive refusal |
| Generic HTTP transport | reads the provider-reference header | + reads every raw value of the receipt header, never joined | additive |
| Generic HTTP adapter result / P11 | status classification | unchanged; an internal observer sees the exchange **after** the result is fixed | no |
| G-02C1A executor binding reconstruction | leaves out exactly the presentation header | unchanged | no |
| G-02C1B flow and statuses | 201 / 202 / 422 / 502 / 503 / 4xx | unchanged; the answer may add one receipt header | no |
| G-02C1C receipt, signer, receipt ledger, verifier | | unchanged; + a transport codec; the verifier composed by the Host | no |
| P12 | resolution authority | untouched | no |

## Decision

### 1. One presentation header (D1)

- The gate's proceed carries the canonical G-02C1A presentation of **exactly** the capability it just issued and verified — after the emergency re-read, never on a refusal. It holds no copy afterwards.
- The adapter accepts a verdict only as own data properties `proceed` (exactly `true`) and, optionally, `presentation` (a non-empty unpadded base64url string of at most 8 192 characters). Anything else — another property, an accessor, a malformed value — is a refusal: nothing is resolved or sent.
- It appends the value under the one reserved name as the **last** header of a frozen **copy** of the bound request. The binding was already computed over the request without it; method, origin, target, every mapped header, the credential and the body are untouched.
- The name lives in one module (`execution-adapters/generic-http/governed-headers.ts`); the mapper reserves it, so no action or configuration can supply, replace or duplicate it. The transport's headers are one map, so a second value under the name could not be written even by a defective caller.

### 2. Receipt delivery

- `frontera.executor-receipt-transport.v1`: base64url of the canonical `{ format, receipt, signature }`, where `receipt` is the receipt text **as the executor's receipt ledger persisted it** and `signature` its persisted envelope. A transport encoding, not a new receipt format. Bounded to 8 192 characters.
- The executor's flow keeps the encoding of the receipt it issued while forming each answer (keyed by that answer, never inside the diagnostic record) and adds it as the one `frontera-execution-receipt` header. A duplicate delivery replays the persisted receipt and performs nothing. No receipt is built from a status; no effect runs to obtain one; an answer without a persisted receipt carries no header.
- The verification-only gateway names no receipt: it adds whatever headers the flow's `answerHeadersOf` returns, never in place of its own. The flow returns at most the receipt header.

### 3. Host verification and issuance correlation

A recorder per gated adapter, run once per presented exchange:

1. **Issuance** — the issuance ledger's row for this execution: `issued`, for this adapter's audience and this Host's issuer.
2. **Decode** — exactly one receipt value (none: `receipt-missing`; several: `receipt-duplicated`).
3. **Verify** — the G-02C1C verifier over the **operator-pinned** registry, with exactly **one** executor pinned per gated audience (the one the adapter's requests go to): canonical form, pinned executor and key (a key carried in a receipt is never consulted, nothing is fetched), signature over the receipt domain, the executor's pinned audience, organization and trust domain.
4. **Correlate** — issuer, capability id, execution id, audience, organization, trust domain and the exact action binding of the issued capability; the claim inside the capability's validity window (not before issuance beyond the G-02A skew, never at or after expiry). A signature never implies issuance.
5. **Record** — one observation; a correlated receipt is accepted as evidence or preserved as a conflict (§4).

It runs **detached**, after the adapter has handed its result back, so it can never delay, hold or change the result or the P11 record made from it. It never sends, never re-presents, never resolves anything, and logs no value.

### 4. The evidence store (D8)

`frontera.execution-receipt-evidence-store.v1`, a separate SQLite file the operator initializes and the Host opens (never creates), pinned to the Host's issuer, organization and trust domain. Append-only tables for evidence, conflicts and observations; one receipt per id, digest and (capability, sequence); identical repeats idempotent; a different text for a taken position, an invalid supersession or an unanchored successor preserved as a conflict; forward-only supersession enforced in code and by trigger; every row re-read against its own text at open; the file and its directory private to the Host's user. See the security statement §4 for the full contract.

### 5. Response and outcome semantics

The adapter's classification is untouched (201/200/204 `completed`; other 4xx `failed`/`PROVIDER_REJECTED`; 202, 3xx, 408, 5xx and any loss after the request left `unconfirmed`). Evidence sits beside it:

| Case | Adapter / P11 | Evidence |
|---|---|---|
| A. rejected before consumption (403, 400 …) | `failed` / `PROVIDER_REJECTED` | `receipt-missing` |
| B. consumed, not attempted (422) | `failed` / `PROVIDER_REJECTED` | `consumed-not-attempted` receipt, `consistent` |
| C. attempted, outcome unknown (502, lost answer) | `unconfirmed` | an unknown receipt if delivered, else `receipt-missing` |
| D. completed as observed (201) | `completed` | `completed-observed`, `consistent` |
| E. failed as observed (422) | `failed` | `failed-observed`, `consistent` |
| F. receipt missing or invalid | as the status says | `receipt-missing` / `-duplicated` / `-invalid` / `-uncorrelated` |
| G. valid but conflicting | as the status says | `receipt-conflicting`, both kept |
| H. valid and correlated | as the status says | `receipt-correlated`; a disagreement with the status is `contradicts` |

### 6. Composition

`executionCapabilities.receiptEvidence { storePath, trustedExecutors }` in the governed-action file — closed, validated at boot (a registry the C1C verifier accepts, with exactly one executor for every gated audience, each executor permitted this deployment's organization and trust domain; at least one gated adapter). The composition root refuses an executor key that is an authority key, opens the existing store, and binds each recorder to the Host's own issuance ledger. Without the section nothing is recorded; a gated adapter still presents.

### 7. Not built: read-only receipt retrieval

A receipt lost with its response stays on the executor's ledger and is **not** fetched: the Host has no retrieval route, and adding one would be a new endpoint on the executor and a new Host-to-executor read. Minimal design for a future founder decision: an authenticated, read-only `GET` on the executor keyed by capability id, answering the persisted receipt history in the same transport encoding; the Host would feed each value through the same recorder. Not authorized here; the Host keeps `receipt-missing`.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Binding over the request with the presentation | The executor cannot rebuild a binding over the capability that names the binding |
| A presentation channel through mapping or a credential | Caller- or configuration-controlled; the name must be reserved |
| Receipt in the response body | The transport never reads a body, by design (bounded, no parsing) |
| Evidence inside P11 or P12 | Closed schemas; a receipt must not confer resolution authority |
| Trusting a receipt's own key, or fetching keys | Trust-on-first-use; the registry is pinned |
| Retry or re-presentation to obtain a missing receipt | Would re-present an execution; never |

## Consequences

- One synthetic, CI-qualified path exists from an authenticated request to a verified, correlated, persisted executor statement.
- A receipt proves the executor's statement, not settlement; correlation proves it is about this Host's issuance, not that the effect happened in the world.
- Offline revocation stays limited, ledgers stay rollback-prone and separate, and nothing is globally exactly-once. Not production-ready (security statement §8).
