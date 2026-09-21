# Generic HTTP Execution Adapter (P6, Stage A)

> **The caller may describe the governed action. The caller may never describe where or how the network effect is sent.**

The Generic HTTP Execution Adapter is the first concrete provider effect Frontera itself ships. It is a **deterministic translator**:

```
ValidatedExecutionAction  +  trusted deployment configuration  →  one pinned HTTPS request
```

It is **not** a proxy, a generic fetch endpoint, a caller-supplied URL, a caller-supplied provider payload, a second authorization layer, a policy engine, an adapter router, a credential broker, a retry engine, an OAuth client or a scraping tool.

Source: `src/enterprise/execution-adapters/generic-http/`. Tests: `src/enterprise/__tests__/generic-http-execution-adapter.test.ts`, `src/enterprise/__tests__/generic-http-composition.test.ts`. Invariants: SEC-INV-062 … SEC-INV-069 (GEN-HTTP-01 … 08). Effect path: EP-050.

---

## 1. Architecture

```
Customer
  → POST /api/governed-actions                     (EP-049, capability-gated)
  → CustomerIdentityAdmission
  → GovernedActionOrchestrator
  → Kernel decision → committed + verified Governance Record
  → bounded grant → execution claim (write-ahead)
  → ACE exercise: authoritative grant re-read + usable assessment
  → ExecutionAdapterRegistry: trusted selectAdapter → adapter-scoped emergency check
  → Generic HTTP child                              (this document)
      map → resolve → judge every answer → send once → classify
  → node:https.request, to one operator-pinned HTTPS origin   (EP-050)
```

The adapter sits **below** the registry's emergency-control checkpoint. It is an ordinary registry child: it has no emergency-control reader, no router, and no access to anything but the `ValidatedExecutionAction` it is handed.

| Responsibility | File |
|---|---|
| Public configuration contract, error codes, limits | `contracts.ts` |
| Validate → snapshot → freeze the configuration | `configuration.ts` |
| Pure action → request translation (no I/O) | `request-mapper.ts` |
| Public-address / SSRF policy (pure) | `public-address-policy.ts` |
| Node HTTPS transport — **the one network call site** | `node-https-transport.ts` |
| The `ExecutionAdapter` (core + production factory) | `generic-http-execution-adapter.ts` |

The module imports nothing from the Kernel, policy, Governance Store, bounded-grant store, customer identity, obligations, approvals or emergency control — only the provider-neutral execution-runtime port and Node built-ins. `src/features/execution-runtime` stays provider-neutral: it imports no `node:http`, `node:https`, `node:dns` or `node:net`.

## 2. Composition

Adoption is only through `createEnterprise`. There is no public factory and no raw fetch function.

```ts
await createEnterprise({
  // …customerIdentityAdmission, governedActionOrchestrator…
  authorityControlledExecution: {
    grantCapability,
    resolveAuthorityBinding,
    executionAdapterRouting: {
      adapters: [...customAdapters],          // may be [] when generic adapters exist
      genericHttpAdapters: [
        {
          adapterId: 'erp.invoice-payment',
          origin: 'https://api.erp.example',
          method: 'POST',
          path: [
            { kind: 'literal', value: 'v1' },
            { kind: 'literal', value: 'payments' },
          ],
          headers: {
            'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' },
          },
          body: {
            kind: 'json-object',
            fields: {
              invoiceId: { kind: 'source', source: 'resource' },
              vendorId: { kind: 'source', source: 'counterparty' },
              amount: { kind: 'source', source: 'amount.value' },
              currency: { kind: 'source', source: 'amount.unit' },
              organization: { kind: 'source', source: 'organization' },
            },
          },
          credential: { kind: 'bearer', token: process.env.ERP_TOKEN! },
          providerRefHeader: 'x-request-id',
          timeoutMs: 10_000,
        },
      ],
      selectAdapter: (action) => (action.action === 'invoice.pay' ? 'erp.invoice-payment' : undefined),
    },
  },
});
```

- Host adapters plus the constructed Generic HTTP adapters become the children of the **one** registry. Identities must be unique across both lists (`EXECUTION_ADAPTER_ID_DUPLICATE`).
- One adapter instance is **one** pinned integration. A deployment with several destinations composes several entries and lets `selectAdapter` choose. The adapter never routes.
- The customer never sees this configuration and never names `'erp.invoice-payment'`.
- Only the configuration **types** are exported from `./enterprise`, type-only. The factory, policy, mapper, transport and core are not.

## 3. Configuration contract

Closed and declarative. **Any undeclared key, at any level, is refused at startup** — there is no `allowPrivateNetwork`, `allowLoopback`, `allowInsecureHttp`, `followRedirects`, `maxRedirects`, `retry`, `proxy`, `agent`, `dispatcher`, `lookup`, `resolver`, `transport`, `fetch`, `rejectUnauthorized`, `tlsVerify`, `customSocket`, `requestBuilder`, `rawRequest`, `rawHeaders` or `rawBody`, and passing one fails composition rather than being ignored. No callbacks, templates, JavaScript, expressions or JSONPath.

| Field | Rule |
|---|---|
| `adapterId` | Recordable: 1–64 chars of `[A-Za-z0-9._:/-]`, alphanumeric first. |
| `origin` | Exact origin: `https://` + DNS hostname + optional port. See §4. |
| `method` | `POST`, `PUT`, `PATCH` or `DELETE`. No `GET`: this adapter produces effects, not reads. |
| `path` | Array of segments (≤ 32). Each is `{ kind: 'literal', value }` or `{ kind: 'source', source }`; always required. |
| `query` | `name → binding` (≤ 64). |
| `headers` | `name → binding` (≤ 32). HTTP-token names, case-insensitive, no duplicates, no reserved names (§7). |
| `body` | `{ kind: 'json-object', fields: name → binding }` (≤ 64 fields). Flat. |
| `credential` | `{ kind: 'bearer', token }` (token68) or `{ kind: 'header', name, value }`, where `value` is a canonical opaque token of visible ASCII (`\x21`–`\x7e`) with **no space or tab anywhere** — refused, never trimmed, so HTTP whitespace (OWS) normalization cannot change the credential value the `providerRef` reflection filter protects. |
| `providerRefHeader` | One response header name. Not `Location`, `Content-Location` or `Refresh` (URL-bearing), not `Authorization`, `Proxy-Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`, `Cookie` or `Set-Cookie` (authentication/credential-bearing), and not the configured credential header (case-insensitive). |
| `timeoutMs` | Integer 100 … 60000. Default 10000. No "0 = unlimited". |

Configuration errors (`GenericHttpConfigurationError`, thrown from `createEnterprise` before any store is opened): `GENERIC_HTTP_OPTIONS_INVALID`, `GENERIC_HTTP_ADAPTER_ID_INVALID`, `GENERIC_HTTP_ORIGIN_INVALID`, `GENERIC_HTTP_METHOD_INVALID`, `GENERIC_HTTP_PATH_INVALID`, `GENERIC_HTTP_MAPPING_INVALID`, `GENERIC_HTTP_HEADER_INVALID`, `GENERIC_HTTP_CREDENTIAL_INVALID`, `GENERIC_HTTP_LIMIT_INVALID`. Messages never echo a configured value.

**Immutability.** Construct → validate → snapshot → freeze, the discipline the registry already applies. Every option is read exactly once, at composition, into a frozen plan the adapter owns. Mutating the original `origin`, `path`, `query`, `headers`, `body.fields`, `credential`, `providerRefHeader`, `timeoutMs` or `adapterId` afterwards changes nothing. A throwing getter or Proxy trap during composition is `GENERIC_HTTP_OPTIONS_INVALID`, never traffic-time behaviour.

## 4. Mapping sources and value semantics

A `source` reads **exactly one** field of `ValidatedExecutionAction`:

`subject` · `action` · `resource` · `counterparty` · `organization` · `amount.value` · `amount.unit` · `notAfter` · `correlation.requestId` · `correlation.decisionId` · `correlation.executionId`

Not sources, and refused at startup: `boundedGrantId` (internal authority plumbing, never a provider value), `assertedContext` (never reaches the execution boundary), the original customer body, the API key, the `Authorization` header, provider configuration, `process.env`, and any inherited object name.

- `required` defaults to **true**. A required source the action lacks (`counterparty`, `organization`, `amount`) stops the request **before any network I/O**, as `failed / ADAPTER_ERROR`. `required: false` omits the destination field.
- Path, query and header positions: strings exact; numbers in deterministic decimal (no exponent); boolean literals `"true"`/`"false"`; a `null` literal is a configuration error.
- JSON body: strings stay strings, `amount.value` stays a number, boolean and `null` literals keep their type. No parse, no interpolation, no merge, no nesting.
- `__proto__`, `prototype` and `constructor` are refused as destination keys even from trusted configuration; the body is built on a null-prototype object.
- The request is built fresh from the frozen plan and the action. No mutable caller or configuration object reaches the transport.

## 5. Path construction

No string templates. Each segment is encoded with `encodeURIComponent` as **one** path segment and never decoded again. A resource of `https://evil.example/a/../admin?x=1` becomes `https%3A%2F%2Fevil.example%2Fa%2F..%2Fadmin%3Fx%3D1` — data inside one segment, unable to change scheme, host, port, hierarchy, query or fragment. A whole-segment value of `.` or `..`, an empty value or a control character makes the request unbuildable. Literal segments may not be `.`/`..` or contain `/`, `\` or control characters.

## 6. Origin pinning, SSRF policy and DNS-rebinding defence

**Origin.** `https:` only. The raw string must be `https://<hostname>[:port][/]`: userinfo, password, path, query, fragment, backslashes and whitespace are refused before any URL parser normalizes them. IP literals (including `127.1`, `0x7f.0.0.1`, `2130706433`, `[::1]`) are refused — a DNS hostname is required. `localhost`, `*.localhost`, `*.local`, `*.localdomain`, `*.internal`, `*.home.arpa`, reverse-DNS zones, single-label names and trailing-dot names are refused before DNS. The hostname is normalized once.

**Every execution:**

1. resolves the pinned hostname afresh — no DNS result is cached across governed executions;
2. obtains all A/AAAA answers;
3. judges **all** of them — one forbidden answer rejects the whole lookup (`failed / ADAPTER_ERROR`);
4. chooses exactly one approved address (the first);
5. hands `node:https.request` a `lookup` that **ignores the hostname** and returns that address — there is no second resolution to rebind;
6. verifies the TCP peer is that address before TLS begins;
7. keeps TLS SNI, certificate verification and `Host` on the original hostname.

One address selection, one connection attempt: there is no fallback to another A/AAAA answer, because a second connection is a second provider attempt. No DNS answer is an unavailable provider (`PROVIDER_UNAVAILABLE`); so is a resolver error or timeout.

**Forbidden address space.** IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (including metadata `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`. IPv6 is an allow-list: only global unicast `2000::/3`, minus `2001::/23` (including Teredo), `2001:db8::/32`, `2002::/16` (6to4) and `3fff::/20`. That excludes `::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, every IPv4-mapped and IPv4-compatible form, and NAT64 `64:ff9b::/96` / `64:ff9b:1::/48`. Unparseable, zoned or dotted-tail IPv6 fails closed. The policy is `node:net` plus explicit code — no third-party dependency.

## 7. TLS, headers and body

- **TLS** verification is **hardcoded on**: the transport sets `rejectUnauthorized: true` explicitly instead of relying on Node's default, because the default yields to an ambient `NODE_TLS_REJECT_UNAUTHORIZED=0` and an explicit `true` does not (proven in an isolated child process). The property is internal: it is not a configuration field, not read from the environment, and not reachable by the host or the caller. There is no `ca`, `checkServerIdentity` or `secureContext` option anywhere.
- **Protocol headers are the adapter's.** Configuration cannot set `Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`, `Upgrade`, `Expect`, `Authorization` (only through the bearer credential), `Cookie` or `Set-Cookie`. Names must be HTTP tokens; values must be visible ASCII/space/tab (no CR, LF or NUL); comparison is case-insensitive and collisions are refused.
- With a body the adapter sets `Content-Type: application/json` and computes `Content-Length`; a configured `Content-Length` is impossible.
- A provider idempotency header may be mapped from `correlation.executionId` through ordinary header mapping. None is invented by default, because provider contracts differ.

## 8. Credentials

Operator configuration only: a bearer token (`Authorization: Bearer …`) or one explicit credential header (such as `X-API-Key`), snapshotted at composition. No caller can provide or override it. It is never placed in a URL, query, body, `providerRef` (a provider-supplied reference containing the literal secret is omitted, §10), `ExecutionAdapterResult.detail`, log, event, exception message, `GovernedActionResult`, Governance Record, execution ledger, health report or configuration error.

**Stage A keeps the configured secret in process memory.** It does not provide KMS/HSM isolation, OAuth, refresh or mTLS. Rotating a static credential requires recomposition (restart).

## 9. One attempt; no redirects; no retries; no reuse

- One `execute()` makes **at most one** outbound HTTPS request. The core calls its network runtime's `send` once, with no loop; the transport invokes `https.request` once.
- **No redirects** — not 301, 302, 303, 307 or 308, not one hop, not to the same origin. `Location` is never read. A 3xx is `unconfirmed`, not a failure: a redirect is an unsupported protocol outcome whose *effect* is uncertain — a 303 See Other is a normal reply to a POST that already ran.
- **No automatic retries** on DNS failure, refusal, TLS error, timeout, reset, 429, 5xx, redirect, malformed response or anything else. The provider may have acted even when its answer was lost.
- **No connection reuse** — `agent: false` gives every call a fresh single-use connection, so a later execution cannot inherit a socket opened under an earlier DNS answer, and no environment proxy configuration is consulted.
- `timeoutMs` bounds the whole attempt (resolution + connection + final status).

## 10. Response handling and `providerRef`

The response body is **not** read, parsed, logged or copied anywhere. The moment the final status and headers arrive, the response and request are destroyed, so nothing keeps streaming after `execute()` resolves. Completion is decided by the final status alone; no provider text can move it.

`providerRef` comes only from the one configured response header: exactly one value, 1–512 printable characters. Duplicates are omitted, never joined; malformed values are omitted. It is evidence and correlation only — never a URL to follow, an authority, a grant, an adapter id or a routing instruction.

**`providerRef` is untrusted provider-controlled input.** A provider can echo what it received — including the credential this adapter sent — into the reference header, and the reference is copied outward into the governed-action result. So the adapter keeps, internally and snapshotted at composition, the literal secrets its credential puts on the wire (for a bearer credential both the raw token and `Bearer <token>`; for a header credential the exact configured value), and a reference candidate that **contains** any of them — exact, case-sensitive substring match — is **omitted outright**: not redacted, hashed, logged, recorded or reported. The outcome is unchanged (a 200 stays `completed`, without `providerRef`). A provider therefore cannot reflect the configured secret back through `providerRef`. The guarantee is **literal** non-disclosure of the configured secret. Because a header credential may contain no SP or HTAB (§3), HTTP's own OWS stripping cannot make the value the provider receives differ from the value the filter matches. A provider that otherwise transforms or encodes the credential before echoing it is not detectable here.

## 11. Unconfirmed semantics

P6 adds a third, provider-neutral adapter outcome:

```ts
type ExecutionAdapterResult =
  | { outcome: 'completed'; providerRef?; adapterId? }
  | { outcome: 'failed'; reason; detail?; adapterId? }
  | { outcome: 'unconfirmed'; detail?; adapterId? };   // P6
```

and a matching `ExecutionOutcome` status, `execution-unconfirmed` (assessment, correlation, performing `adapterId`, `routedBy` when routed, `exercisedAt`, bounded `detail`). `readExecutionAdapterResult` normalizes it — read once, primitives only, hostile getters and Proxy traps caught by the caller — and the registry overwrites its attribution from its snapshotted membership, exactly as for the other two.

| Observation | Result |
|---|---|
| request cannot be built from the action | `failed / ADAPTER_ERROR` — no DNS, no socket |
| DNS failure, no answers, resolver timeout | `failed / PROVIDER_UNAVAILABLE` |
| an answer is not publicly routable | `failed / ADAPTER_ERROR` |
| TCP refused, TLS or certificate failure, budget spent before `secureConnect` | `failed / PROVIDER_UNAVAILABLE` |
| **after `secureConnect`**: timeout, reset, remote close, stream error, no final status | **`unconfirmed`** |
| final 200, 201, 204 — the Stage-A definitive success statuses | `completed` |
| any other final 2xx (202 Accepted, 203, 205, 206, 207, 208, 226, …) | **`unconfirmed`** |
| any final 3xx (never followed) | **`unconfirmed`** |
| final 408, any 5xx, any unclassifiable status | **`unconfirmed`** |
| other final 4xx (400, 401, 403, 404, 409, 422, 429…) | `failed / PROVIDER_REJECTED` |

Generic HTTP declares completion **only** for 200, 201 and 204; every other 2xx and every redirect is conservatively `unconfirmed`, with the fixed detail "Generic HTTP provider returned a response that does not confirm the effect." (no `Location` or other response value enters it). `PROVIDER_RESPONSE_INVALID` stays in the provider-neutral vocabulary for other adapters; Generic HTTP never uses a redirect to claim a definite failure. `PROVIDER_UNAVAILABLE` means a failure **proven to precede transmission** — not "I did not get a successful response". A generic provider that answers 500 may have committed the effect first, so 500 is `unconfirmed`. Conservatism is intentional: calling a probably-not-applied effect unconfirmed is acceptable; calling a possibly-applied effect a definite failure is not.

None of these changes the Kernel's decision, and none means "denied".

**Governed-action result.** An immediate unconfirmed outcome is the existing `status: 'execution_unconfirmed'` (HTTP 409, shape unchanged) with the new reason code `GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED`. The existing `GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED` keeps meaning "an attempt row exists and no outcome was ever recorded" (a crash between claim and outcome). The two are distinct internally and in reason codes; a caller sees the same status for both.

**Ledger.** An unconfirmed outcome is recorded as the canonical `execution-unconfirmed@<adapterId>` — never overloaded onto `execution-failed`, never left as a missing row. Replay of that row returns `execution_unconfirmed` / `…_OUTCOME_UNCONFIRMED` without invoking the adapter. A malformed or tampered variant decodes as nothing: it replays as `…_ALREADY_ATTEMPTED`, never as executed or failed, and never permits a second effect. The write-ahead claim still precedes every adapter invocation; no ledger row can authorize anything.

## 12. Exactly-once: what P6 does and does not provide

P6 provides: a durable Frontera execution claim before adapter invocation; at most one outbound attempt per `execute()`; no automatic retry; an operator-mappable provider idempotency value (`correlation.executionId`); honest `execution_unconfirmed` for ambiguous post-send failures; and replay of an execution identity that never invokes the adapter again.

P6 does **not** provide provider-side idempotency guarantees, a reconciliation API, automatic recovery of `execution_unconfirmed`, or exactly-once effect semantics.

## 13. Emergency-control relationship

No new kill switch, route or SDK method. The adapter is a normal registry child, so:

```
trusted registry selects the generic child → adapter-scoped emergency check → blocked ⇒ the child is never invoked
```

A stop on `{ scope: 'adapter', value: '<generic adapterId>' }` withholds before any DNS query or socket (`generic-http-composition.test.ts` K). The adapter holds no `EmergencyControlReaderPort`; the one checkpoint stays in the registry.

## 14. Security boundaries — and what this is not

Correct claim:

> When the governed-action path routes through a Generic HTTP Adapter, that adapter can contact only its configured HTTPS origin, subject to its application-level public-address policy.

**Not** a claim: "Frontera now blocks all unauthorized egress." SEC-INV-U03 — no egress to a provider except from an allowlisted adapter at a controlled network boundary — **remains unimplemented**. Other process code can still open sockets; the Pinata and Stripe paths are untouched; there is no network namespace, firewall or sidecar; SEC-TRUST-004 and SEC-TRUST-006 stand. Adopting this adapter does not retroactively govern Pinata, Stripe, Sovereign Access, Content Protection, `enforce()` or arbitrary host egress.

**Residual risks.**

1. The host process remains trusted.
2. Provider adapter configuration remains trusted.
3. Configured credentials live in process memory.
4. No network namespace or firewall egress enforcement exists.
5. DNS itself may be malicious; a malicious answer naming a forbidden address is rejected, but a public address the operator did not intend is not detectable.
6. A malicious public provider may itself forward the request elsewhere: P6 controls where Frontera connects, not what the provider does.
7. `execution_unconfirmed` is not reconciled in P6.
8. Provider-level exactly-once semantics are not guaranteed.
9. Static credential rotation requires recomposition/restart in Stage A.
10. The mapping language is intentionally limited (flat JSON, header-only `providerRef`, no response parsing).

## 15. Non-goals (Stage A)

GET/data-fetch workflows, response JSON mapping, HTTP/2, WebSockets, multipart or file upload, binary payloads, proxy support, OAuth/OIDC, mTLS, credential refresh, KMS/HSM, retries, reconciliation, process isolation, sandboxing, network-namespace egress control, aggregate spend/velocity controls (P7), a canonical event stream (P8), provider-model convergence (P9), XRPL, Live Data Rail, and Pinata or Stripe migration.
