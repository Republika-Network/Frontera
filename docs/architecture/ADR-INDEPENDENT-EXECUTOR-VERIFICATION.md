# ADR: Independent executor verification foundation (G-02C1A)

**Status:** Accepted for G-02C1A (verification only)
**Extends:** `ADR-GOVERNED-EXECUTION-BINDING.md` (G-02C0), `ADR-EXECUTION-CAPABILITY-ISSUANCE.md` (G-02B), `ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md` (G-02A)
**Security statement:** `docs/security/G-02C1A-INDEPENDENT-EXECUTOR-VERIFICATION.md` · invariants SEC-INV-381 … SEC-INV-388
**Founder decisions:** G-02C1 Phase 0 D1–D15 approved as the intended architecture. G-02C1A implements D2 (in-repo executor run as its own process), D3 (pinned issuer trust), D11 (offline-only status; status-required refused), D15 (CI-only reference qualification), and conditionally approved option 6(a) (the body-less `Content-Length: 0` rule). D1 (Host presentation) is deferred to G-02C1D, D4 (durable consumption) to G-02C1B, D5–D8 (receipts and receipt evidence) to G-02C1C/D.

## Context

G-02C0 binds every gated Generic HTTP request to a capability issued for exactly that request, and verifies it on the Host. The Host can protect itself only against in-process substitution (G02C0-R6). The first real trust boundary is an executor that receives the request over the network, owns its own trust, and checks the capability against **what it received**, not against anything the Host tells it.

## Decision

### 1. A separate process with a pinned closure

`src/enterprise/reference-executor/` runs as its own OS process (`scripts/run-reference-executor.mjs`). Its runtime import closure is exactly:

- its own modules (configuration, admission, binding reconstruction, verification pipeline, gateway, launcher);
- the presentation codec (`src/enterprise/execution-capability-presentation/`);
- the G-02A codec and standalone verifier;
- the CORE-02 verification primitives (registry, envelope, errors);
- `aoc.canonical-json.v1` and its digest;
- `node:crypto`, `node:fs`, `node:http`.

It loads no Host, Kernel, orchestrator, grant store or runtime, issuance, gate, adapter registry, P11/P12 store, signer or database. A structure test pins the static closure; a process test pins what the compiled launcher actually loads.

### 2. Closed trust configuration

One JSON document (`frontera.reference-executor-configuration.v1`), validated at boot and frozen: executor id, exact audience, organizations, trust domain, pinned issuers and Ed25519 SPKI public keys (rotation by overlap), exact action and resource allow-lists, the one binding format, the expected HTTPS origin, the methods, the client credential (by environment variable), lifetime and skew limits, `offline-only` status policy, and a loopback listener in the `reference-synthetic` environment. Unknown keys, wildcards, empty registries, a key id or key material pinned twice, other algorithms, non-public or non-Ed25519 PEMs, self-trust, unknown formats, other status policies and non-loopback listeners refuse startup. No key is ever taken from a capability and nothing is discovered at runtime. The credential is held only as a SHA-256 digest.

### 3. One presentation envelope

`frontera.execution-capability-presentation.v1` is unpadded base64url of the canonical JSON `{ bindingFormat, capability, format, signature }`, carried in exactly one header, `frontera-execution-capability`. `bindingFormat` must equal the signed capability's `actionBinding.format`. Every other spelling (padding, stray bits, foreign alphabet, invalid UTF-8, whitespace, reordering, re-escaping, duplicated keys, extra or missing fields, other versions, other algorithms, malformed envelopes) is refused. The codec signs nothing and verifies no signature. The envelope holds no grant, nonce, policy, approval, credential, key, path or evidence.

### 4. Admission and exact reconstruction from received bytes

The gateway is a loopback `node:http` server with the strict parser, every header line counted, bounded headers, body and time, and one request per connection. Upgrades, `CONNECT` and `Expect` are refused through their own server events.

Admission requires HTTP/1.1, a permitted method, an origin-form target, unique header names, visible-ASCII values, exactly one `Host` equal to the configured authority, `Connection: close`, exactly one presentation header and the credential header. It refuses transfer and trailer framing, upgrades, expectations, proxy headers, content codings, a body that is not strict UTF-8, and a length that is not the body.

Admission removes exactly four headers, each checked and none ignored: `host`, `connection`, the presentation header and the credential header. The binding `frontera.http-request-binding.v1` is then rebuilt by the executor's own code (no Host import):

- the received method;
- the **configured** origin;
- the raw target, never decoded or normalized;
- every remaining header, lower-cased and exact, sorted by name;
- the configured credential header name;
- the exact body text, or `null`.

The body is never reparsed as JSON. The only exception is `content-length` for a body-less `POST`, `PUT` or `PATCH`: it must be present exactly once and exactly `0`, and is then left out, because the Host's Node client adds it on its own and the record's `body: null` already says the same. Golden vectors over the real transport demonstrate this. In every other case `content-length` is bound as received.

### 5. The pipeline, in order

1. admission;
2. client credential (constant time);
3. presentation decoding;
4. the executor's own policy (pinned issuer, audience, organization, trust domain, action and resource allow-lists, binding format);
5. binding reconstruction;
6. G-02A verification (pinned keys, this executor's context, the rebuilt record);
7. eligibility (`offline-permitted` only).

The answer is an assessment: `refused`, `assessed-ineligible` or `assessed-eligible`, with the stage, a closed code and, after the credential, the rebuilt digest. A valid signature alone is never enough.

### 6. Verification only

There is no consumption ledger, no claim, no effect handler, no signer and no receipt. Every answer is a 4xx: an eligible assessment is `409`, which the Host's Generic HTTP classifier reads as `PROVIDER_REJECTED` — definitely not completed, which is the truth. Diagnostics are the assessment record only.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Importing the Host's `genericHttpRequestBindingOf` | Shares one implementation across the boundary, so golden vectors could not show independent agreement; the executor restates the record and a test pins the format and field set equal |
| Ignoring `content-length` generally | Would let framing differ from what was signed; the rule is limited to the one header Node's client adds |
| Accepting a digest from the request | The executor would trust the party it is checking |
| A bearer capability in `Authorization` | Recreates a bearer path and collides with the gateway credential |
| Running both sides in one module | Proves nothing about process independence |

## Consequences

- An executor exists that checks a capability against the request it received, with trust it holds itself, in a separate process.
- The Host still presents nothing (D1). G-02C1A fixtures append the presentation header to the mapped request to stand in for G-02C1D.
- Nothing is consumed or executed, and no receipt is produced. Exactly-once is not claimed.

## Deferred

| Milestone | Scope |
|---|---|
| G-02C1B | Durable consumption with the G-02A ledger before a deterministic synthetic effect; outcome model and status mapping |
| G-02C1C | Executor receipts (own key, own domain) and the Host receipt verifier |
| G-02C1D | Host presentation (D1, SEC-INV-376 amended), receipt return, additive evidence store (D8) |
| G-02D | Online status |
