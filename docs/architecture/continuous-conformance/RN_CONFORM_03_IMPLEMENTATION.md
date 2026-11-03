# RN-CONFORM-03 — Signed Credential Status Verification: Implementation Record

> **Status: IMPLEMENTED — synthetic, local-only, non-production.**
> A third party can verify, from a signed artifact and pinned keys alone, whether a synthetic
> integration's RN-CONFORM-02 credential is currently ACTIVE with fresh evidence for a given operation.
> No public endpoint, no Enterprise Host route, no deployment, no real keys, no real credentials, no
> ledger transaction, no Fileverse traffic, no `$SOBE`. Every artifact carries
> `designation: SYNTHETIC-NON-PRODUCTION`. `rn.sv@0.1.0` (`sha256:e71fafe1…3a58`) and the Founding
> Assessment commercial **NO-GO** are unchanged. Nothing here is a certification.

## 1. Baseline and dependency

| Item | Value |
|---|---|
| Base | `origin/main` `f54a109b` (#265) |
| RN-CONFORM-01 | PR #261, merged as `f36d9dd5` |
| RN-CONFORM-02 | PR #263, squash-merged as `681d9a06` (tree identical to its verified head `ff9e76f8`) |
| Branch / worktree | `feat/rn-conform-03-credential-status-verification` at `C:\Users\Usuario\Republika-worktrees\CONFORM-03\frontera` (fresh from `origin/main`) |
| Execution policy | No code executed in the Windows/WSL worktree; all executable validation is GitHub CI |

## 2. Modules

| File | WP | Responsibility |
|---|---|---|
| `conformance/status-contracts.ts` | 01 | `rn.conformance.status/1` assertion and `rn.conformance.status-refusal/1` refusal: closed schemas, exact-canonical-text parser, lifetime rule, digests |
| `conformance/signing.ts` (extended) | 01 | Two new domains: `frontera:conformance-status:v1\n`, `frontera:conformance-status-refusal:v1\n` |
| `conformance/status-signer.ts` | 02 | Pinned issuer key registry (validity windows, revocation, issuer binding) and the isolated synthetic signer behind `StatusSignerPort` |
| `conformance/status-projection.ts` | 03 | Read-only projection of the committed head, verified history and engine freshness |
| `conformance/status-registry.ts` | 03–06, 09 | Online / stapled issuance, linearization, bounded retries, signed refusals, public transitions |
| `conformance/status-verifier.ts` | 05–07, 10 | `verifyConformanceStatus` and the durable verifier store (high-water marks, latches, trusted clock) |
| `conformance/status-http.ts` | 08, 09 | The read-only binding as a pure request handler; fixed-window rate limiter |
| `conformance/anchor-intent.ts` | 11 | Simulated ledger anchor intent (`XRPL_TESTNET`, `prepared`) |
| `conformance/sqlite-conformance-store.ts` (extended) | 03, 06, 11 | `cc_status_assertions`, `cc_anchor_intents`, their triggers and reads |
| `conformance-status-local/server.ts` | 08 | Loopback-only, disabled-by-default test listener (the only `node:http` code) |

Nothing changes RN-CONFORM-02's conformance rules, lifecycle or engine. The RN-CONFORM-02 structure
suite gained exactly one, named exception: the local listener and its test may import the module.

## 3. Status assertion schema (deltas from INTEGRATION_CONTRACTS.md §5)

All §5 fields are present. Deltas, each to bind something the sketch left implicit:

| Field | Sketch | Implemented | Why |
|---|---|---|---|
| `profile` | `{id, version}` | `{id, version, digest}` | Bind the exact pinned profile definition |
| `sdk` / `adapter` | `{version}` | `{package, version}` / `{name, version}` | Bind what the version is of |
| `evidenceFreshness` | `{oldestRequiredEvidenceAt, freshUntil}` | adds `status` (`FRESH`, `STALE`, `INCOMPLETE`, `UNDER_INVESTIGATION`, `PROTECTIVE_ACTION_PENDING`, `EVIDENCE_TAMPERED`) | ACTIVE with an open dispute or a pending suspension must not read as fresh |
| `anchors` | ledger anchors | always `[]` | A *prepared* intent is not an anchor; no hash is ever invented |
| `designation` | — | `SYNTHETIC-NON-PRODUCTION` | Explicit non-production marking |
| `sequence` | "≥ stateVersion" | 1, 2, 3 … per credential | Sequence and state version are independent counters |
| Errors | "signed UNAVAILABLE assertions" | signed **refusals** for recognized requests; **unsigned** `503 UNAVAILABLE` when nothing can be signed | Never claim a signature that does not exist |

Signing: `Ed25519(domain ‖ aoc-canonical-json/1(payload))`, payload = artifact without `signature`;
CORE-02 envelope (`ed25519-v1`, `aoc.authority-artifact.v1`), closed to exactly four members, signature
of exactly 64 bytes, `keyId = sha256(SPKI DER)` resolved only against the verifier's pinned set. An
artifact is accepted only as its exact canonical text (one byte representation).

## 4. Key management (CC-D-07, provisional)

* The registry holds no private key (INV-07): it holds a `StatusSignerPort` and a requester secret.
  Tests scan the database file and the signer journal for key material.
* The signer (in-process, CORE-02 structured pattern) authenticates the requester (HMAC-SHA256,
  constant-time), accepts only `signStatusAssertion` / `signStatusRefusal`, re-parses the payload,
  refuses another issuer, a lifetime > 15 min or `issuedAt` beyond ± 5 s of its clock, **recomputes the
  projection itself** and refuses unless the payload equals it (`NOT_CURRENT`), and enforces
  `sequence = last + 1` linked to the last digest **in its own journal**, a separate file outside the
  registry database's restore domain (`SEQUENCE_DIVERGED`).
* Keys have validity windows; the signer uses the newest valid, unrevoked key (rotation).
* Verifier policy: a key must be valid at `issuedAt` **and** still valid and unrevoked now. A status is
  a statement about the present, so revocation or expiry withdraws trust immediately; there is no
  historical acceptance of status assertions. (Transition history keeps its own RN-CONFORM-02 policy.)
* HSM/KMS and a separate signer process are production decisions (not taken).

## 5. Freshness: three clocks (CC-D-05, provisional)

| Concept | Value | Enforced by |
|---|---|---|
| Credential term | 90 d (RN-CONFORM-02 profile) | Verifier `EXPIRED_CREDENTIAL`; an assertion's `validUntil` is capped at `credentialValidUntil` |
| Assertion lifetime | ≤ 15 min (online default 5 min, stapled 15 min, refusals 60 s) | Issuer, signer, store trigger and verifier |
| Evidence freshness | per requirement (RN-CONFORM-02 engine) | `evidenceFreshness.status = FRESH` and `freshUntil > now` |

Verifier window: `issuedAt − 5 s ≤ now < validUntil`; the tolerance never extends `validUntil`. The
verifier store latches the highest trusted time; a clock more than 5 s behind it is `CLOCK_ROLLBACK`.

## 6. Linearization and sequence (INV-03, INV-05)

Issuance: snapshot + projection outside any lock → (test barrier `afterPrepare`) → `BEGIN IMMEDIATE`
→ re-projection → equal? → chain head → sign (barrier `beforeSign`) → append → `COMMIT`. **The
linearization point is the re-projection inside the IMMEDIATE transaction** — the same write lock every
credential transition needs, so no transition can commit between it and the append. A moved head
retries (≤ 3), then `RETRY_EXHAUSTED` (nothing signed). The `cc_status_assertions` trigger independently
refuses any row that is not `max(sequence) + 1`, does not link to its predecessor's digest, does not name
the **currently committed** head, exceeds 15 min, or runs backwards in time; the table is append-only.

Verifier continuity (`vs_high_water`, its own file): next link → accepted; same digest → idempotent;
lower sequence or lower state version → `ROLLBACK_DETECTED` (latched); same sequence with another
digest, a wrong predecessor or another issuer → `CONFLICT_DETECTED` (latched); a gap → recorded and
`CONTINUITY_UNPROVEN` offline, accepted online (the nonce proves currency). Latches are append-only and
persist across restarts; **no API clears one** — recovery is an out-of-band procedure (a new, explicitly
provisioned verifier store). Without a store the verifier reports `continuity: NOT_TRACKED`.

## 7. Online and offline protocols

**Online** (`POST /conformance/v1/status`): `{credentialId, nonce (≥ 128 bits base64url), expect:{platformId,
organizationId, integrationId, integrationVersion, integrationDigest, profileId, profileVersion}, operation}`.
The nonce is echoed and unique per issuer (`NONCE_REUSED` refusal). Mismatches → signed refusals
(`SUBJECT_MISMATCH`, `PROFILE_MISMATCH`); another organization's credential is indistinguishable from an
unknown one (`UNKNOWN_CREDENTIAL`). `Cache-Control: no-store`.

**Stapled** (`GET /conformance/v1/credentials/{id}/status`): reused only while it still states exactly
the current projection; otherwise reissued. `max-age` ≤ remaining signed validity. **An offline ACTIVE
issued before a suspension stays valid until its `validUntil` (≤ 15 min): offline mode is not
instantaneous revocation**; the verdict reports `remainingValidityMs`.

Verifier result categories: `CONFORMANT`, `NOT_CONFORMANT`, `INVALID_SCHEMA`, `INVALID_SIGNATURE`,
`UNTRUSTED_ISSUER`, `NONCE_MISMATCH`, `SUBJECT_MISMATCH`, `PROFILE_MISMATCH`, `SCOPE_MISMATCH`,
`STALE_EVIDENCE`, `EXPIRED_ASSERTION`, `EXPIRED_CREDENTIAL`, `CLOCK_ROLLBACK`, `ROLLBACK_DETECTED`,
`CONFLICT_DETECTED`, `CONTINUITY_UNPROVEN`, `UNAVAILABLE`. Only `CONFORMANT` is conformant.

## 8. HTTP binding (local only)

Routes `POST /conformance/v1/status`, `GET …/credentials/{id}/status`, `GET …/credentials/{id}/transitions?after=&limit=`
(≤ 50), `GET /conformance/v1/keys` (a convenience; keys are pinned out of band). Closed request schema,
4 KiB body limit, 512-byte URL limit, unknown query parameters refused, per-client fixed-window rate
limit, `X-Conformance-Designation` header. The handler is pure; the only listener
(`conformance-status-local/server.ts`) starts only with the literal `rn-conform-03-local-synthetic-test-only`,
binds only `127.0.0.1`/`::1`, verifies the bound address, refuses non-loopback peers and any `Host`
header other than its own address (DNS rebinding), and has header/request timeouts. It is imported by
nothing but its test; it is not in `release/api-surface.v1.json`, not routed by the Enterprise Host
adapter, not exported, and has no deployment configuration. The API freeze is untouched.

## 9. Privacy (CC-D-13, provisional — legal approval pending)

Public responses carry identity and scope needed for verification, state, freshness, expiry and the
latest transition digest. They carry no evidence package, observation, validator or operator id, human
principal, decision id, signature other than the issuer's, or key material. Public transitions expose
state-version, code, from/to, reason, time, digests and the **number** of human approvals only.

## 10. Simulated anchor (WP-11)

`cc_anchor_intents` stores one prepared intent per transition: credential, transition id and digest,
profile version, canonical payload digest, `networkIntent = XRPL_TESTNET`, `confirmationState = prepared`
(both CHECK-constrained), preparation time. There is no column for a ledger hash; a trigger refuses an
intent for a transition that does not exist with that digest; rows are immutable. Preparing an intent
never touches the lifecycle, and its failure never delays a suspension (INV-11). Compatible input for a
future RN-CONFORM-03X adapter (which needs CC-D-06).

## 11. Tests

| Suite | Covers |
|---|---|
| `conformance-status-contracts` | WP-01 schema/purpose/unknown-field/canonical/envelope/domain/key-id/issuer; WP-02 signer authentication, operations, issuer, lifetime, clock, NOT_CURRENT, sequence, key expiry/revocation/rotation, INV-07 |
| `conformance-status-issuance` | INV-08 no decision state written; nonce echo/reuse/format; signed refusals without leaks; **barrier races** (suspension between snapshot and signing; bounded exhaustion; transition blocked while signing; two issuers on two connections); chain and trigger refusals; **registry restore vs signer journal**; signer/registry/lock outages; history tamper; freshness semantics (stale, missing operation, dispute, suspended-with-fresh, expired credential, term cap) |
| `conformance-status-verifier` | Window boundaries and skew; invalid intervals; clock rollback (persisted); every subject/profile/scope substitution; continuity (next, same, rollback latched and persisted, older ACTIVE after SUSPENDED, conflict, broken link, gap offline/online, stateless); concurrent verifier stores; store tamper refusal; never-throw |
| `conformance-status-end-to-end` | §16 Steps 1–10 in one run; anchor intents (determinism, binding, DB refusals, INV-11) |
| `rn-conform-03-local-status-server` | Handler routes, limits, cache rules, refusals, outage, rate limit; listener enablement, loopback-only, Host check, oversized body, connection refused, timeout; exposure scan (no Host/config/script/deploy reference, no export, no ledger dependency, not in API freeze) |
| `conformance-structure` (RN-CONFORM-02) | Still: no network in the module, rn.sv digest and NO-GO unchanged; plus the one listener exception |

Results: see the PR (CI is the only execution environment).

## 12. Limitations and deferred work

* Synthetic issuer, keys and requester secret; the signer runs in-process behind a port. A separate
  process, HSM/KMS and production key enrollment are not done (CC-D-07).
* The signer reads the same database (a read-only view in production); compromise of the database
  host is a compromise of both views. Its journal is in a separate file.
* A signer journal entry made just before a failed registry append "burns" that sequence: issuance for
  that credential then fails closed (`SEQUENCE_DIVERGED`) until an operator-run recovery. No automatic
  recovery exists, by design (it would require trusting the registry's chain).
* After a registry restore the registry can still serve its old, unexpired stapled assertion; only
  verifiers with a high-water mark detect it, and stateless verifiers accept it within ≤ 15 min.
* Offline verification is bounded-staleness, not revocation.
* The rate limiter is in-memory and test-only. No authentication on status reads (by design, §5 of
  STATUS_VERIFICATION.md); production abuse controls are out of scope.
* Latch recovery is out-of-band only.
* Public disclosure contract needs legal approval (CC-D-13).
* RN-CONFORM-03X: a ledger adapter consuming `cc_anchor_intents` after CC-D-06. RN-CONFORM-04/05:
  Fileverse PEP fixtures, real validators.
