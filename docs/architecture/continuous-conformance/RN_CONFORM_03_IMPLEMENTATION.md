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

* The registry holds no issuer key (INV-07): it holds a `StatusSignerPort` and its own requester key,
  with which it authenticates each signing request (Ed25519, domain `frontera:conformance-status-signing-request:v1\n`;
  no HMAC — the repository forbids shared-secret signers in the Enterprise runtime).
  Tests scan the database file and the signer journal for key material.
* The signer (in-process, CORE-02 structured pattern) authenticates the requester against its pinned
  public key, accepts only `signStatusAssertion` / `signStatusRefusal`, re-parses the payload,
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

Verifier continuity (`vs_high_water`, its own file) is judged on **committed state**, with the
sequence used to detect equivocation (§13, review P1-A/P2-A/P2-B):

| Presented, relative to the mark | Result | Latched |
|---|---|---|
| Below the **state floor** (highest `stateVersion` from any authentic artifact, raised even when continuity is unproven) | `ROLLBACK_DETECTED` | no — a genuine stale artifact is not tampering; latching would let anyone deny service |
| A FRESH view of the floor state with an issuer sequence at or below that of the newest signed non-FRESH view of it (**freshness floor**, ordered by sequence, not time) | `ROLLBACK_DETECTED` | no |
| Same sequence, other digest; next sequence not linking; same `stateVersion` naming another transition; another issuer | `CONFLICT_DETECTED` | **yes** (append-only, persisted; no API clears it — recovery is an explicitly provisioned new verifier store) |
| Next sequence, linked | accepted (`NEXT`) | — |
| Older or non-adjacent sequence of the **same** state | accepted (`OLDER_SAME_STATE`, `GAP_SAME_STATE`) — online and stapled share one chain, so honest gaps are normal | — |
| Newer state across a gap | online: accepted and recorded (`GAP_ACCEPTED_ONLINE`); offline: `CONTINUITY_UNPROVEN`, **not** recorded, until an online check re-anchors | — |

Marks are kept per (issuer, credential). The trusted clock is latched forward; > 5 s behind is
`CLOCK_ROLLBACK`, and validity, credential term and evidence freshness are judged against the later of
the presented and the latched time (a clock stepped back within the tolerance extends nothing). Every verifier-store key is
guarded against `INSERT OR REPLACE`, and the store refuses to open unless every table and trigger has
exactly its schema's SQL. Without a store the verifier reports `continuity: NOT_TRACKED`.

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

## 13. Independent review (AI reviewer, static only — not an accredited audit)

A separate reviewer read the full diff without executing anything, against the 16 questions of the
mission brief. It confirmed questions 1, 3, 4, 7, 9–12 and 16 held; its findings and dispositions:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| CI-5–7 | — | (Found by CI after review.) HMAC requester authentication violated the repository's no-HMAC-signer rule (CTRL-02, CORE-02 structure suites); the `XRPL_TESTNET` label put two conformance files in PAY-04's pinned list of CORE files naming XRPL; a listener test left a socket pending | **Fixed**: Ed25519 request authentication; the two files added to the PAY-04 list with an RN-CONFORM-03 note (label only — no rail logic); deterministic connection teardown |
| CI-1–4 | — | Corrupted import path; an out-of-scope `store`; a key-material marker literal in a `conformance-*` test; the listener's directory named in a module comment | **Fixed** (the first two had already failed CI and were fixed in `b30efc21`) |
| P1-A | P1 | Online and stapled share one chain, so the platform's still-current stapled assertion presented after any online check looked like a rollback, and a latch made it permanent | **Fixed**: continuity judged on committed state (§6); same-state older/gap sequences accepted. Test `review P1-A …` |
| P1-B | P1 | The signer journaled before the registry's append could fail (clock stepped back; nonce raced by a second issuer), burning the sequence and wedging the credential | **Fixed**: nonce and clock re-checked under the lock before signing (`CLOCK_BEHIND`, `NONCE_REUSED`). Tests `review P1-B …` (two) |
| P1-C | P1 | The signer journal kept no state high-water mark: a restored database could get its superseded ACTIVE head signed under a fresh sequence | **Fixed**: the journal records `(stateVersion, transitionDigest)`; the signer and a journal trigger refuse anything older or forked (`STATE_ROLLBACK`). Test `review P1-C …` |
| P2-A | P2 | A gap refused once, then recorded, so presenting the same artifact twice passed | **Fixed**: an unproven gap is not recorded. Test in `… re-anchors the mark` |
| P2-B | P2 | Stale-but-genuine replays latched permanently (denial of service) | **Fixed**: rollback refuses without latching; only equivocation/forks latch. Test `review P2-B …` |
| P2-C | P2 | `INSERT OR REPLACE` bypassed the verifier store's triggers; open-time check counted names only | **Fixed**: duplicate guards on every key; open compares full schema SQL. Test `review P2-C …` |
| P2-D | P2 | Stapled/transitions GETs disclose public subject fields for any id; 404 existence oracle | **Accepted for the synthetic MVP**, documented (§12); CC-D-13 decides |
| P2-E | P2 | Status trigger did not cross-check JSON times/issuer; the stapled cache served JSON selected by columns | **Fixed in the cache** (artifact times, sequence, issuer and nonce must equal the row's); raw-writer junk-row DoS documented (§12) |
| P3 | P3 | `decodeURIComponent` → 503; oversized-body handler could write twice; schema version not bumped; verifier mark lacked transition digest; transitions unsigned; anchor race; WAL-only INV-07 scan; storage growth | First four **fixed** (400; abort guard; `rn.conformance.store/2`; transition digest now in the mark); the rest documented |


## 12. Limitations and deferred work

> **Production activation requires separately approved signing-key custody, disaster-recovery procedures and
> legal/privacy authorization. None of those gates is satisfied by this synthetic implementation.**
> Not implemented here: HSM/KMS custody, backup monotonicity of the signer journal, public disclosure, production
> rate limiting.

**Signer-journal rollback hazard.** The signer's journal is the only record of which sequences, digests and states it
has already signed for each credential; it lives outside the registry database so that a registry restore cannot make
the signer forget. Restoring the journal itself from an older backup does make it forget: it would then accept
`sequence = last + 1` for sequences it already used, and sign a **second, different** assertion for a sequence that
verifiers may already hold — genuine equivocation, which every verifier that saw the original latches as
`CONFLICT_DETECTED`. A journal must therefore never be restored or rolled back; a disaster-recovery design for it
(e.g. monotonic, replicated storage) is part of the production custody gate above.


* Synthetic issuer, keys and requester secret; the signer runs in-process behind a port. A separate
  process, HSM/KMS and production key enrollment are not done (CC-D-07).
* The signer reads the same database (a read-only view in production); compromise of the database
  host is a compromise of both views. Its journal is in a separate file.
* A signer journal entry made just before a failed registry append "burns" that sequence: issuance for
  that credential then fails closed (`SEQUENCE_DIVERGED`) until an operator-run recovery. Everything the
  append could refuse (nonce reuse, a clock behind the last assertion, the head) is checked under the
  lock **before** the signer is asked, so only an I/O failure or crash can burn a sequence. No automatic
  recovery exists, by design (it would require trusting the registry's chain).
* `GET …/status` and `…/transitions` answer for any credential id (the stapled assertion is meant for
  public presentation; ids are 128-bit random). They disclose the subject's public identity, scope and
  public transition fields to anyone holding the id, and a 404 reveals non-existence (review P2-D,
  accepted for the synthetic MVP; CC-D-13 legal review must decide before production). The online POST
  never reveals another organization's credential.
* A raw database writer can append a structurally valid but unsigned row at the head of a credential's
  status chain; it cannot forge a signature, but it wedges issuance for that credential (`SEQUENCE_DIVERGED`)
  — denial of service, detected, not prevented.
* The public transitions endpoint returns digests, not signed records, so a verifier can check linkage but
  not the registry signature; full signed history needs an authenticated channel (deferred).
* The signer's tolerance of ± 5 s around its clock can make an assertion's effective life up to 5 s longer
  than its stated `validUntil − issuedAt` relative to true time.
* After a registry restore the registry can still serve its old, unexpired stapled assertion; only
  verifiers with a high-water mark detect it, and stateless verifiers accept it within ≤ 15 min.
* Offline verification is bounded-staleness, not revocation.
* The rate limiter is in-memory and test-only. No authentication on status reads (by design, §5 of
  STATUS_VERIFICATION.md); production abuse controls are out of scope.
* Latch recovery is out-of-band only.
* Operator hazard (review N-7): restoring the signer journal together with the registry database makes the
  signer re-issue used sequences — real equivocation, which every verifier that saw the originals latches.
  The signer journal must never be restored from backup. A forward clock jump seen by issuer and signer
  makes issuance `CLOCK_BEHIND` until wall time passes the last assertion.
* File-level tampering with a verifier store or the signer journal (replacing the file, or dropping and
  recreating identical triggers) is not prevented; the open-time check detects schema substitution only.
* Public disclosure contract needs legal approval (CC-D-13).
* RN-CONFORM-03X: a ledger adapter consuming `cc_anchor_intents` after CC-D-06. RN-CONFORM-04/05:
  Fileverse PEP fixtures, real validators.

### 13.1 Re-review of the corrected head (AI reviewer, static only)

A second reviewer read `6bd6836d..ffa9fe6d`. No P0/P1. It considered P1-A, P1-B, P1-C, P2-A, P2-B, P2-C (conflict
clauses), P2-E (cache) and the fixed P3s closed, and predicted no CI failures (confirmed: all 13 checks green on
`ffa9fe6d`). New findings:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| N-1 | P2 | (Regression from P1-A) an older FRESH view of a state was accepted after a newer signed degraded view of the same state | **Fixed**: freshness floor. Test `review N-1 …` |
| N-2 | P2 | An unproven-gap newer state was discarded entirely, so the pre-suspension ACTIVE (even the anchor itself) still passed | **Fixed**: state floor raised by every authentic artifact; floors checked before the anchor. Test in `… re-anchors the mark` |
| N-3 | P3 | A clock stepped back ≤ 5 s could accept an artifact up to 5 s past `validUntil` | **Fixed**: judged against the latched trusted time. Test `review N-3 …` |
| N-4 | P3 | Raw file-level tampering (drop/recreate identical triggers, replace or pre-seed the file) is not prevented | **Documented**: triggers stop API misuse and conflict clauses; the open check detects schema substitution, not file replacement |
| N-5 | P3 | Signer journal integrity check was name-only | **Fixed**: full schema SQL comparison at open |
| N-6 | P3 | Marks keyed by credential only: a second pinned issuer could force an `issuer changed` latch | **Fixed**: marks and latches keyed by (issuer, credential) |
| N-7 | P3 | `CLOCK_BEHIND` wedges issuance until wall time passes the last `issuedAt`; restoring **both** registry and signer journal re-uses sequences (genuine equivocation → verifiers latch) | **Documented** operator hazard: never restore the signer journal |
| N-8 | P3 | Verifier store handle leaked on a malformed file | **Fixed** |

### 13.2 Codex findings on `781f93ac` (all three fixed)

| # | Thread location | Root cause | Fix | Regression test |
|---|---|---|---|---|
| C-1 | `status-verifier.ts` freshness floor | The floor compared `issuedAt` strictly; two assertions may share a millisecond, so an earlier FRESH view replayed after a later degraded one | The floor is the **issuer sequence** of the newest non-FRESH view of the floor state (durable, trigger-monotonic, schema `status-verifier-store/3`); a FRESH view with a lower sequence is `ROLLBACK_DETECTED`; a higher-sequence FRESH view is a genuine recovery | `Codex C-1 …` (same-millisecond pair, restart, recovery, no latch, no rollback past SUSPENDED) |
| C-2 | `status-registry.ts` stapled cache | The cache never checked whether its signing key was still usable | A cached staple is served only if its key is `USABLE` under the trusted key set (default: the signer's published keys); otherwise it is reissued under the current key, or `UNAVAILABLE` | `Codex C-2 …` (expired and scheduled-revoked key; old staple rejected; replacement under the new key; signer down → fail closed; racing issuers → one sequence) |
| C-3 | `status-contracts.ts` scope lists | The status schema capped exclusions at 16 while admission had no bound | One bound, `MAX_DECLARED_EXCLUSIONS = 64`, enforced at admission (`registry.ts`) and by the parser; a stored scope beyond the bounds is never stated partially (`SCOPE_NOT_REPRESENTABLE`, fail closed). No integration record format or digest changed | `Codex C-3 …` (0, 16, 17, 64 stated completely; 65 refused; parser agrees; no substitution; stored oversize → fail closed) |

The verifier store schema is now `rn.conformance.status-verifier-store/3`; a store created by an earlier version is
refused at open ("not intact") and must be re-provisioned — synthetic verifier stores are never migrated.

**Gate A hardening.** The RN-CONFORM-02 structure suite compared paths by string prefix, so any sibling
`src/enterprise/conformance-*` directory counted as the module (and could import it unnoticed). It now uses a
directory boundary, and the only exemption is the named listener directory and its test; a negative test pins that a
sibling or look-alike directory is neither the module nor exempt.
