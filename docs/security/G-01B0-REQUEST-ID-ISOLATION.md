# G-01B0 — Request-id cross-path isolation

Status: implemented on Draft PR #194 (base `a378a14`). Not merged.
Invariants: SEC-INV-335, SEC-INV-336 (`docs/security/SECURITY_INVARIANTS.md` §4.34).

## 1. The problem

The Governance Store holds one request-id space: `request_id` is UNIQUE across the whole store (`sqlite-governance-store.ts`, `governance_requests`; the in-memory store keys `evaluationIdByRequestId` the same way). Two paths write into it:

| Path | Request id | Who chooses it |
|---|---|---|
| `POST /api/governance/evaluate` (advisory) | `body.requestId`, or `enterprise-request-<uuid>` | the caller |
| `POST /api/governed-actions` (enforceable) | `aoc.gar:` + digest(organization, principal id, idempotency key) | the server — from values an outsider can know |

`resolveIdempotencySync` answers a probe first from its idempotency claim and, when that claim is absent, from a bare request-id lookup. An evaluate caller with any key valid for the organization could therefore commit a record at a victim principal's *future* governed request id, and the governed path would then:

- refuse the victim permanently (`GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`) when the planted payload differed; or
- adopt the planted advisory decision as the victim's committed decision when it was equivalent — the victim received `denied`, `withheld` (approval) or `system_error` carrying the planted decision id, and the same held inside the append transaction (the probe-to-append race).

An adopted `allowed` record never executed: the advisory Kernel has no grant projection, so issuance failed closed.

## 2. The fix

**L1 — ingress (SEC-INV-335).** `validateGovernanceEvaluateRequestBody` refuses, with 400 `INVALID_REQUEST`, a `requestId` that is not a non-empty string or that begins with `aoc.` after `trim()`, in any case (`isServerDerivedIdentifierNamespace`, `governed-action/identifiers.ts`). Validation runs before the Governance Store is consulted. Every identifier the governed path derives lies in that namespace.

**L2 — provenance (SEC-INV-336).** In both Store providers, a probe that carries the governed-action path's own claim (`probesGovernedActionClaim` → the PROD-03-01 predicate `isGovernedActionIdempotencyClaim`) is answered by that claim alone. A record standing at the request id without it is a `request-id` conflict, never a replay — on the pre-Kernel probe and inside the append transaction, since both use the same function. The governed path writes its claim and its request row in one transaction, so no legitimate governed record lacks the claim. L2 is what neutralises records planted before L1 existed.

Unchanged: the Kernel and its contracts, CORE-07, grants and their signatures, P7/P11/P12, the Store schema (no migration), evaluate-route idempotency (no claim, `org:`/`global` scopes), legitimate governed retries, concurrency and principal scoping. No new public error code.

## 3. Compatibility

- Evaluate callers sending a `requestId` that starts with `aoc.` (any case, after trim) now receive 400. No production or SDK use was found; only tests did this.
- Evaluate callers sending a non-string `requestId` — including `null`, which previously fell back to a generated id — now receive 400. Omitting the field still generates one.
- The PROD-03-01 and PROD-03-02 regressions that planted an `aoc.gar:` record through the evaluate route now assert the 400 and seed the historical record directly (`seedHistoricalEvaluateRecord`, `prod02-recovery-fixture.ts`), preserving their classification and resolvability assertions.
- A governed request id occupied before G-01B0 stays refused for that key (fail closed, never adopted); the principal must use another idempotency key.

## 4. Evidence

Suite: `src/enterprise/__tests__/g01b0-request-id-isolation.test.ts`. The commits are ordered so CI records the layers independently (GitHub Actions, `validate` job, root suite of 12 270 tests):

| Commit | Contents | CI run | Result |
|---|---|---|---|
| `693e3a1` | tests only | 39539133468 | 20 failures, every one a G-01B0 case or the PROD-03-01 seed test; all unchanged-behaviour controls pass — the vulnerability, recorded |
| `fb93a32` | + L2 | 39539647437 | 8 failures, exactly the L1-dependent tests; all 12 L2 tests pass in both providers — removing L1 is detected |
| `4de06bd` | + L1 | 39540021797 | 1 failure: the PROD-03-02 R8 regression that also planted an `aoc.gar:` id through the route (fixed in the following commit) |

Removing L2 with L1 present is detected by construction: the L2 tests plant records directly in the Store and never pass through the evaluate route, and they failed whenever L2 was absent (run 39539133468). The final green run is recorded on PR #194.

## 5. Deferred

- **G-01A** — actor and organization on the evaluate route remain caller-asserted; an org-scoped key may omit the organization; unscoped keys.
- **G-01B1** — the cross-tenant request-id existence oracle (409 echoes the id); evaluate probes run in the system context; per-principal namespacing of evaluate request ids; other readers of a governed request id without a provenance check (refund `releaseBasis`, the reconsideration target, operational views); in-process vertical services accept any `requestId`; operator reporting of request ids occupied before G-01B0; the in-process `requestId` getter re-read.
- **G-01C** — the full G01-A…L adversarial suite.
