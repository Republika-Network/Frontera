# G-02C1A — Independent Executor Verification Foundation: Security Statement

**Design:** `docs/architecture/ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md`
**Invariants:** SEC-INV-381 … SEC-INV-388 (`SECURITY_INVARIANTS.md` §4.41)
**Profile:** reference only, synthetic CI qualification. The executor verifies and refuses. It never consumes, executes or receipts anything. **Not production-ready.**

## 1. What is in scope, and what is not

| Question | G-02C1A |
|---|---|
| 1. Is the capability signature valid under a key the executor pinned? | **In scope** (G-02A verifier, CORE-02 registry) |
| 2. Does this executor's own trust decision accept it (issuer, audience, organization, trust domain, action, resource, format)? | **In scope** |
| 3. Does it bind exactly the request the executor received? | **In scope** (rebuilt from received bytes) |
| 4. Would it be eligible to be claimed? | **In scope — as an assessment only.** Nothing is claimed |
| 5. Was it actually consumed? | Out of scope (G-02C1B) |
| 6. Was anything actually executed? | Out of scope: nothing is, ever, in G-02C1A |
| 7. Is a receipt authentic? | Out of scope (G-02C1C) |

`assessed-eligible` answers question 4 and nothing after it.

## 2. Threat model

**Assets:** the executor's decision to proceed (in later slices), its pinned trust, its client credential.

**Trust boundary:** the network between the Host and the executor. Everything the executor receives is untrusted: method, target, headers, body and presentation. Its configuration file and environment are trusted, and are operator-controlled.

| Adversary | Can | Cannot (enforced) |
|---|---|---|
| A network attacker or a rewriting proxy | Alter, add, drop, duplicate or reorder bytes; replay a presentation inside its window | Make an altered request verify: every bound field is rebuilt from what arrived; duplicates, framing, upgrades, proxy headers and content codings are refused. The executor binds its **own** origin and requires `Host` to match it |
| A credential thief (gateway credential only) | Reach admission | Present a capability it does not hold |
| A capability thief (presentation only) | Replay it inside the window to this executor | Pass the credential check; or use it for another request, audience, organization, trust domain, action or resource. In G-02C1A replay is harmless, because nothing executes. In G-02C1B the ledger refuses the second use within one consumption domain |
| A compromised or defective Host issuer | Sign a capability for an exact request | Make the executor accept a key it did not pin, an action or resource outside its allow-lists, or a status-required capability |
| A party controlling the configuration file or environment | Change trust | **Not defended**: the executor's trust root is its own operator |

Out of the model: TLS and certificate attacks (TLS is not exercised in CI), host compromise of the executor machine, and denial of service beyond the per-request bounds.

## 3. The trust configuration (`frontera.reference-executor-configuration.v1`)

| Field | Rule |
|---|---|
| `format`, `environment` | Exact; `environment` must be `reference-synthetic` |
| `executorId`, `audience`, `trustDomain`, `organizationIds` | Exact identifiers; no `*`; organizations distinct; no issuer id equal to an own identity; no organization equal to the audience or trust domain |
| `trustedIssuers` | 1–8 issuers, each with 1–8 `ed25519-v1` SPKI PEM public keys. A key id or key material pinned twice is refused. Private keys, certificates, other key types and malformed PEMs are refused. Rotation means overlap: old and new keys pinned together |
| `permittedActions`, `permittedResources` | Exact allow-lists, 1–64 entries, distinct |
| `bindingFormats` | Exactly `['frontera.http-request-binding.v1']` |
| `expectedOrigin` | `https://` + a lower-case FQDN + an optional non-default port without leading zeros |
| `methods` | A subset of `POST`, `PUT`, `PATCH`, `DELETE` (the Host adapter has no GET) |
| `clientCredential` | `{ kind: 'bearer', tokenEnv }` or `{ kind: 'header', name, valueEnv }`. The value comes from the named variable (16–4096 characters) and is held only as a SHA-256 digest. The name may not be reserved, a proxy header or the presentation header |
| `maximumLifetimeMs`, `maximumClockSkewMs` | At most the G-02A maxima (60 s, 5 s) |
| `statusPolicy` | Exactly `offline-only` |
| `listen` | `127.0.0.1` or `::1`, port 0–65535 |

The configuration is frozen after boot. There is no reload, no key discovery and no trust on first use.

## 4. Exact binding reconstruction

The executor rebuilds `frontera.http-request-binding.v1` from the received request: received method, configured origin, raw target, every remaining header (names lower-cased, values exact, sorted), the configured credential header name, and the exact body (or `null`).

Admission removes exactly `host` (checked equal to the configured authority), `connection` (checked `close`), the presentation header and the credential header (both checked present once).

There is no path or query normalization (`%C3%A9` ≠ `%c3%a9`; dot-segments are bound as sent), no JSON reparsing (re-spacing, re-escaping or a BOM changes the record), and no header-value trimming beyond what HTTP/1.1 parsing defines.

**The `Content-Length: 0` rule (founder option 6(a)).** For `POST`, `PUT` and `PATCH` with an empty received body, the received `content-length` must appear exactly once with value exactly `0`, and is left out of the record. All seven founder conditions hold:

1. the received body is empty;
2. the record's body is `null`, and the digest comparison proves the Host's was too;
3. the real Host transport writes exactly `Content-Length: 0` for those methods, and none for `DELETE` (captured from the real `sendOnce`);
4. uniqueness is enforced by admission and the value must be exactly `0`;
5. `Transfer-Encoding` is refused, and the strict parser refuses it beside `Content-Length`;
6. a body-less request with a zero length means exactly what it means without one;
7. golden vectors demonstrate interoperability.

A body-less `POST` without the header, or with `00`, is refused. A `DELETE` carrying one keeps it in the record, so it mismatches. With a body, the header is bound as received.

## 5. Golden-vector interoperability requirements

A vector qualifies only if:

- the request is built by the real G-02C0 mapper from a real plan and a validated action;
- its digest is computed by the real `genericHttpRequestBinding`;
- the bytes are written by the real Host transport (`sendOnce` with the exact `https.request` options);
- the bytes are parsed by the executor's own Node parser in another process;
- the executor reports the same digest.

Vectors:

- POST, PUT, PATCH and DELETE without a body;
- POST, PUT and PATCH with a body;
- typed parameters in path, query, header and body;
- percent-encoded path and query;
- several mapped headers;
- a non-default port;
- a header credential.

Three records are also written out by hand from the specification and must equal both digests.

**Negative mutations** are applied to the captured bytes, each with a freshly signed presentation, so only the mutation separates the request from an eligible control. They cover:

- method; hostname and port (both the `Host` line and the signed origin);
- path, dot-segment, percent-encoding case, query value and added query parameter;
- header name, value and removal; duplicate and case-variant duplicate headers; an extra header; proxy headers;
- body bytes, re-serialization, escape, BOM and invalid UTF-8; content coding; chunked framing;
- the `content-length` variants above;
- credential header name (bound), value and wire name;
- presentation missing, duplicated, corrupted, or for another request;
- issuer (unknown, and a key of another pinned issuer), audience, organization, trust domain and expiry;
- GET, HTTP/1.0 and an absolute-form target.

Each must be refused with its specific stage and code.

GET has no positive vector because the Host's Generic HTTP adapter cannot send GET. It is a negative vector.

## 6. CI qualification limits

- **Loopback plain HTTP, not TLS.** The Host transport's options are used unchanged except `protocol: 'http:'`, a loopback agent and `defaultPort: 443` (so `Host` is written exactly as over HTTPS). TLS, SNI, certificate verification, public DNS and real reverse proxies or TLS terminators are **not qualified**.
- **Proxy rewriting is unsupported by design.** A proxy that adds `Via`, `Forwarded` or `X-Forwarded-*`, rewrites `Host`, normalizes the target, re-codes the body or merges headers causes a refusal.
- **Header values with leading or trailing whitespace** do not round-trip through HTTP/1.1 parsing; such a mapped value is refused (fail closed).
- **No consumption, no signed receipts, no production readiness, no exactly-once.**
- **Offline revocation:** an offline executor does not observe a revocation or emergency stop after issuance; the window (≤ 60 s) is the only bound (G02B-R2, G02C0-R1/R2). Status-required capabilities are never eligible before G-02D.

## 7. Adversarial coverage

| Threat | Result | Test |
|---|---|---|
| Forged signature; unpinned key; key of another pinned issuer; signing-domain substitution; no domain | refused at verification | in-process suite; process suite |
| Malformed, non-canonical, extra-field capability; every non-canonical envelope spelling; algorithm substitution; oversized or malformed base64url | refused at presentation | in-process suite (codec table) |
| Wrong audience, organization, trust domain, action or resource | refused at policy | both suites |
| Expired; issued too far ahead; lifetime over the profile or configured maximum | refused at verification | in-process suite |
| Status-required | assessed ineligible (403) | both suites |
| Wildcard or ambiguous configuration | startup refused | in-process suite; process suite (refused-to-start) |
| Duplicate headers; CL+TE; chunked; pipelining and a hidden second request; HTTP/2 preface; h2c and WebSocket upgrades; CONNECT; `Expect`; folded headers; partial requests | refused | process suite |
| Oversized body, header block, header count or presentation | 413 / 431 / 431 / 403 | process suite |
| Secrets, presentations, capabilities or bodies in diagnostics or responses | none; the rebuilt digest is returned only on an assessed outcome | process suite; pipeline suite |
| Removal of each load-bearing control | 23 mutants detected | `g02c1a-reference-executor-mutation.test.ts` |
| Import closure; no signing, ledger, effect or receipt; no Host surface; protected contracts | pinned | `g02c1a-reference-executor-structure.test.ts` |

No effect handler exists, so no refusal can reach one. The pipeline returns a frozen five-field record, and the gateway's only use of it is to answer.

## 8. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02C1A-R1 | The executor's resource allow-list is checked against the capability's `resource`, which the issuer's mapper derived; the executor does not re-derive the resource from the request target. The binding still fixes the exact request | G-02C1B (per-resource route policy, if wanted) |
| G02C1A-R2 | `executionId` and `subjectActorId` are bound only by the signature. The executor cannot check them against the request unless the plan maps them into it, in which case the binding covers them | documented |
| G02C1A-R3 | Replay inside the window to this executor is answered again (no ledger); harmless only because nothing executes | G-02C1B |
| G02C1A-R4 | An operator can map a header named `frontera-execution-capability` in a Host plan today; the executor would then see two and refuse, or remove a bound header and mismatch — fail closed. G-02C1D must reserve the name in the mapper, and the G-02B structure pin forbidding `execution-capabilit` in execution-adapters code needs a founder-approved amendment | G-02C1D |
| G02C1A-R5 | TLS, DNS and proxy topologies are not qualified | later qualification |
| G02C1A-R6 | The configuration file is trusted as written. Duplicate JSON keys resolve last-wins in `JSON.parse` | documented |
| G02C1A-R7 | Gateway credential compared in constant time over digests, but held in process memory; no KMS | reference only |
| G02C1A-R8 | The executor does not restrict its own environment; the harness starts it with a minimal one and the child reports the variable names it sees | G-02C1B (refuse unexpected variables, if wanted) |
| G02C1A-R9 | An early 413 or 431 closes a socket that may still hold unread request bytes; on some stacks a reset can discard the answer before the client reads it. The refusal stands either way; only the client's view of its status can be lost | documented |
| G02B-R1 … R12, G02C0-R1 … R7 | Unchanged | as before |

## 9. Independent adversarial review

An independent read-only review of the full diff found no input that is assessed eligible for a request other than the signed one, and no bypass of the credential, the allow-lists, pinned trust or the status-required refusal. The findings were fixed as follows:

| Finding | Fix |
|---|---|
| Bytes after a `Connection: close` request (llhttp: data after close) logged the first request's assessment while the client got a 400 | A socket-level refusal now refuses the request in flight on that socket; it is reported refused and never answered |
| Resets and broken pipes were reported as malformed requests | Only parser (`HPE_*`) and request-timeout errors are reported; others just close the socket |
| A missing `Host` was answered by Node unreported | `requireHostHeader: false`; admission refuses `HOST_MISSING` |
| Header timers checked only every 30 s | `connectionsCheckingInterval: 1000` |
| HTTP/2-preface and folded-header tests could pass with no assessment | Both now require a reported admission-stage refusal |
| The environment check observed the harness, not the child | The child reports the variable names it sees; SEC-INV-381 reworded |
| Credential names admission always refuses were accepted by the configuration; over-limit registries mis-coded; digest returned on verification refusals | Shared refusal list; `LIMIT_INVALID`; digest only on assessed outcomes |
