# SDK Public API Audit — @aoc-enterprise/enterprise-host-sdk 1.0.0 (PR-RC Objective 4)

Audited as if publishing to a public registry. Every claim verified against the built package (`dist/`), the sources, and the test suite; the frozen surface is now machine-enforced by `scripts/check-sdk-surface.mjs` (part of `npm run validate:v1-release`).

## Public exports — Verified, frozen

Runtime exports (exactly five; enforced by the surface check):

| export | kind |
|---|---|
| `createEnterpriseHostClient(options)` | factory |
| `EnterpriseHostApiError` | error class |
| `EnterpriseHostTimeoutError` | error class |
| `EnterpriseHostNetworkError` | error class |
| `isEnterpriseHostApiError(error)` | type guard |

Type-only exports: `EnterpriseHostClient`, `EnterpriseHostClientOptions`, wire types (`GovernanceEvaluateRequest/Response`, evidence/passport/assurance request-response mirrors), `FetchLike`/`FetchResponseLike`, `EnterpriseErrorEnvelope`. All types are structural mirrors of the frozen HTTP surface with open index signatures, so additive Host fields flow through without an SDK release.

## Internal leakage — None found

- SDK sources import **nothing** outside the package (machine-checked: only `./`-relative imports); zero imports from `src/enterprise/**` or any workspace package.
- No Enterprise runtime types, store types, kernel types, or digest helpers appear in the declaration files (`dist/*.d.ts` reference only the SDK's own modules).
- No experimental or underscore-prefixed symbols; no `@internal` markers needed because nothing internal is exported.

## Versioning — Verified

Package version `1.0.0`, aligned with the Host and the frozen `aoc-enterprise-host-http.v1` surface. The README states the stability contract: additive Host changes are non-breaking; SDK majors track surface majors.

## Typed responses & error mapping — Verified

- Every method returns a typed promise; unknown-shaped domains use `Readonly<Record<string, unknown>>` intersections rather than `any`.
- Non-2xx responses throw `EnterpriseHostApiError` carrying `status`, stable `code` (parsed from the frozen envelope, `UNKNOWN` for the three documented non-enveloped responses), `details`, and the verbatim `body`. Timeout → `EnterpriseHostTimeoutError` (with the configured budget); no-response → `EnterpriseHostNetworkError` (with `cause`). Tested against a scripted stub host including the 404-envelope, timeout, and unreachable-host paths.
- Governed non-2xx outcomes (evaluate 422 denial, verify 409 invalid) are documented in the README as domain outcomes surfaced through `EnterpriseHostApiError` — callers inspect `status`/`body`.

## Timeout behavior — Verified

`timeoutMs` (default 30 000) aborts via `AbortSignal.timeout`; the tests pin both the timeout path (slow route aborted at 150 ms) and the non-timeout path. Guidance per operation class is in the README.

## Retry guidance — Verified (documented, deliberately not implemented)

The client never retries. README "Retries" section specifies: GETs and verify endpoints always safe; `evaluate` only with the same `Idempotency-Key` (409 on payload mismatch); `issuePassport` only with the same body `idempotencyKey`; other writes not blindly retryable; backoff guidance for network errors and 503s.

## Documentation & examples — Verified

README covers construction, auth, health, governance/evidence/assurance examples, the full error table, timeout budgets, retry rules, and the stability contract. The SDK's own test file doubles as an executable transport-contract example.

## Module format — Verified, with documented characteristics

- **CJS** output (`tsc` `module: Node16` under the package's non-`"type": "module"` manifest), `main` + `exports` map with `types`. Consumable from both `require()` and `import` (Node interop; the surface check imports it as ESM and the interop artifacts `default`/`__esModule` are excluded from the frozen surface).
- **Tree shaking:** CJS is not tree-shakeable by standard bundlers. Accepted for v1 and mitigated by size: the package is 4 small modules, zero dependencies (~6 KB compiled). Dual ESM/CJS build is a post-v1 nice-to-have, noted in Known Issues.
- **Zero runtime dependencies** (machine-enforced); requires global `fetch` (Node ≥ 18; the workspace pins Node ≥ 22) or an injected `FetchLike`.

## Addendum — 1.1.0: `governAction()` (P5)

An additive, reviewed change. Version `1.0.0` → `1.1.0` (MINOR: one new client
method mirroring one new, capability-gated Host endpoint; nothing removed or
changed).

- **Runtime exports: still exactly the five above.** `governAction` is a method
  on the existing `EnterpriseHostClient`, not a new factory. New **type-only**
  exports: `GovernedActionIntent`, `GovernedActionAmount`,
  `GovernedActionResult`, `GovernedActionResultStatus`,
  `GovernedActionDecisionRef`, `GovernedActionWithheldBy`,
  `GovernedActionExecutionFailure` — structural mirrors
  declared in `src/types.ts`, not imported from the Host.
- **`GovernedActionIntent` is closed** (no index signature, unlike the other
  request mirrors), so `adapterId`, `provider`, `url`, `actorId`,
  `organizationId` and the like fail to compile; the SDK tests pin this with
  `@ts-expect-error`. `GovernedActionResult` declares no grant, digest, adapter
  or credential field, and its closed vocabularies — `decision.status` and
  `execution_failed.failure` — are mirrored exactly, never widened to `string`
  (also `@ts-expect-error`-tested).
- **Governed-action response decoding.** For `governAction()` only, the
  response is decoded on **every** HTTP status, 2xx included.
  `GovernedActionResult` domain responses are returned — including on 409, 422,
  502, 503 and 500 — when the body proves the full wire shape (known `status`;
  `reasonCodes` all strings; optional `requestId`/`correlationId`/`executionId`
  strings; a well-formed `decision` with a known status; `replayed`/
  `outcomeRecorded` booleans and a known `failure` or `withheldBy` where the
  status requires them) **and** arrives under the HTTP status the Host pairs
  with it. Enterprise error envelopes throw with their code; invalid,
  unrecognized or mismatched-status protocol responses throw with code
  `UNKNOWN` and the raw body. Unknown additive fields are tolerated; nothing is
  coerced. This is transport decoding, not a decision. Every other method — `evaluate()` included — keeps the original
  rule that any status ≥ 400 throws; a test pins `evaluate()`'s 422 behaviour.
- **Credential:** the client's existing `apiKey` is the only input; no actor,
  organization or auth option was added. Zero dependencies, unchanged.

## Verdict

The SDK exposes only intended public APIs; no internal implementation details leak. Surface, dependency-freedom, and self-containment are enforced by the release gate, not just documented.
