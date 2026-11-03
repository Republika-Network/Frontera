# RN-CONFORM-02 — Synthetic Continuous Conformance Circuit: Implementation Record

> **Status: IMPLEMENTED — synthetic, in-process, non-production.**
> No HTTP route, no Enterprise Host composition, no public export, no network, no XRPL, no Fileverse,
> no real keys, no real customers, no real credentials. Every record carries `synthetic: true`, and the
> store refuses anything else. The "two operators" are two synthetic labels; nothing here shows that
> independent validator operators exist. `rn.sv@0.1.0` and its golden digest are unchanged; the
> Founding Assessment commercial decision remains **NO-GO**. `$SOBE`, tokens, staking, slashing and
> rewards are absent. No external certification is claimed.

## 1. Baseline

| Item | Value |
|---|---|
| Repository | `Republika-Network/Frontera` |
| Base | `origin/main` `f36d9dd5` (RN-CONFORM-01, PR #261, merged) |
| Branch / worktree | `feat/rn-conform-02-synthetic-circuit` at `C:\Users\Usuario\Republika-worktrees\CONFORM-02\frontera` (fresh; no other worktree touched) |
| Runtime | Windows Node v22.22.0 for the native SQLite module (`better-sqlite3` ^12.11.1); Linux Node v22.23.1 for pure-JS scripts |
| Protocol | `@aoc/protocol` `0.2.0-rc.3` (vendored tarball, `protocol-consumer.lock.json`) |

## 2. Modules (`src/enterprise/conformance/`)

| File | Responsibility (WP) |
|---|---|
| `canonical.ts` | Restricted `aoc-canonical-json/1` adapter, digests, single-read snapshots (WP-02, CC-D-01) |
| `signing.ts` | Conformance signing domains, key-id derivation, Ed25519 sign/verify over the CORE-02 envelope (WP-06, §9) |
| `contracts.ts` | Closed record types, state/outcome vocabularies, challenge catalogue, structural validators (WP-01) |
| `profile.ts` | The two pinned profile definitions and the content-addressed profile registry (WP-03) |
| `human-authority.ts` | Synthetic human directory and the two-person authority check (CC-D-04) |
| `registry.ts` | Platforms, integration versions, synthetic operators, validator enrollment, key revocation, quarantine (WP-03, WP-04) |
| `coordinator.ts` | Signed challenge issuance, idempotent re-dispatch, CSPRNG nonces (WP-05) |
| `evidence.ts` | The evidence acceptance boundary and the rejection taxonomy; redacted evidence custody (WP-06, WP-07) |
| `engine.ts` | The pure, deterministic evaluator: classification, corroboration, disputes, investigations, freshness (WP-09, CC-D-03) |
| `sqlite-conformance-store.ts` | The dedicated SQLite store and its integrity triggers (WP-08) |
| `lifecycle.ts` | The credential state machine T1–T8 (WP-10) |
| `verifier.ts` | History verification and the fail-closed in-process status check; a local high-water mark (WP-11) |

Test harness and suites: `src/enterprise/__tests__/conformance-*.ts` (§8 below). The PR #263 Codex-review
remediation is recorded in §14. Differential probe:
`scripts/protocol/check-conformance-canonicalization.mjs`.

## 3. Trust boundaries

| Boundary | What crosses it | Control |
|---|---|---|
| Validator → evidence boundary | A bounded JSON **string** (≤ 16 KiB) | Parsed once into a frozen plain-JSON snapshot; closed schema; signature under the **enrolled** key only; challenge, nonce, subject, profile, time, replay and custody checks (`evidence.ts`) |
| Coordinator → validator | A signed challenge | `frontera:conformance-challenge:v1` signature; re-verified on every acceptance |
| Humans → lifecycle/registry | Two signed decisions | `frontera:conformance-human-decision:v1`; exact action, subject, organization and action-binding digest; distinct principals and keys; permission per role; consumed in the same transaction as the record they authorize |
| Lifecycle → store | Evaluations, transitions, consumed decisions | SQLite triggers (§6) enforce the invariants on every connection |
| Store → verifier | Committed rows only | Every digest, signature, chain link, edge and human approval recomputed; nothing trusted from columns or the head |

## 4. Canonicalization (CC-D-01)

**Decision implemented:** `aoc-canonical-json/1` with a plain-JSON restriction.

Frontera's gates forbid importing any Protocol subpath from `src/`, `packages/` or `tests/`
(`check-protocol-consumption.mjs`, `check-node16-imports.mjs`). The adapter therefore restates the
profile for a narrowed domain, as the FV receiver already does, and
`scripts/protocol/check-conformance-canonicalization.mjs` (the exempt protocol-tooling location)
compares its bytes with the **installed** Protocol `canonicalizeJSON` and Frontera `canonicalSerialize`.
No Protocol source, historical Assurance serialization or historical digest was changed.

**Accepted domain:** `null`, booleans, well-formed UTF-16 strings, safe integers (not `-0`), dense
plain arrays, plain objects (prototype `Object.prototype` or `null`) with own enumerable string-keyed
data properties; depth ≤ 32, ≤ 4 096 nodes, strings ≤ 8 192 code units. Everything else throws with a
closed reason; nothing is normalized. RFC 8785 compatibility is **not** claimed.

**Differential result (14 accepted vectors, 22 refused):** all accepted vectors are byte-identical in
all three implementations, including key-insertion order, nesting, empty containers, BMP and astral
Unicode, UTF-16 code-unit key order, and control-character escapes. Recorded divergences on refused
inputs:

| Input | Protocol `canonicalizeJSON` | Frontera `canonicalSerialize` | Adapter |
|---|---|---|---|
| `{a: undefined, b: 1}` | throws | `{"b":1}` | `UNDEFINED_VALUE` |
| `[1, undefined]` | throws | `[1,null]` | `UNDEFINED_VALUE` |
| `{at: new Date(…)}` | `{"at":{}}` | `{"at":"2026-…Z"}` | `DATE_VALUE` |
| `{m: new Map(…)}` | `{"m":{}}` | throws | `NON_PLAIN_OBJECT` |
| class instance | own enumerable fields | throws | `NON_PLAIN_OBJECT` |
| `Uint8Array` / `Buffer` | `{"0":1,"1":2}` | throws | `BINARY_VALUE` |
| `-0` | `0` (collides with `0`) | `0` | `NEGATIVE_ZERO` |
| sparse `[1,,3]` | `[1,,3]` (**not valid JSON**) | `[1,,3]` (**not valid JSON**) | `SPARSE_OR_DECORATED_ARRAY` |
| lone surrogate | `"\ud800"` (escaped) | `"\ud800"` | `MALFORMED_UNICODE` |
| getter property | value read | value read | `ACCESSOR_PROPERTY` |
| symbol key | dropped | dropped | `SYMBOL_KEY` |
| `0.1`, `7.9e-10`, `1e21` | `0.1`, `7.9e-10`, `1e+21` | same | refused (integers only) |
| cycle | `RangeError` (stack overflow) | throws | `CYCLE` |

The sparse-array result is a latent defect in **both** existing implementations (follow-up F-1).

## 5. Identity, signatures, operators and humans

* **Domains** (`CONFORMANCE_SIGNING_DOMAINS`): `frontera:conformance-{challenge,observation,transition,human-decision}:v1\n`.
  `AUTHORITY_SIGNING_DOMAINS` was **not** extended: its exhaustive dispatcher belongs to Host
  authority artifacts. A test pins that no conformance domain is a prefix of, or prefixed by, any
  CORE-02 domain. (`status` and `anchor` domains belong to RN-CONFORM-03/03X.)
* **Envelope and verification:** the CORE-02 `AuthoritySignature` (`ed25519-v1`,
  `aoc.authority-artifact.v1`) and `createAuthoritySignatureRegistry` are reused unchanged.
* **Key ids:** `sha256:<hex(SPKI DER)>`, the fingerprint already used by `executor-receipt` and
  `reference-executor`. A key id is always recomputed from the trusted key; a submitted key or key id
  never establishes trust (a `publicKeyPem` field in an observation is `UNKNOWN_FIELD`).
* **Synthetic operators:** each carries `synthetic: true` and the fixed statement "Synthetic test
  operator. Not a legal entity, not independent of Republika, and not evidence that an independent
  validator operator exists." Corroboration counts **operators**, never validators or submissions.
* **Human authority (CC-D-04):** enrollment, issuance, reinstatement after
  `CRITICAL_VIOLATION_CONFIRMED`/`CONFLICTING_EVIDENCE`, and non-timeout revocation each need one
  `attest` and one `approve` decision from two different principals with two different keys, for the
  exact action, subject, organization and action-binding digest, unexpired (≤ 15 min lifetime),
  unrevoked, permitted, and never consumed before. All checks run before anything is consumed;
  consumption is a `PRIMARY KEY` row written in the same transaction as the authorized record, so a
  replay fails even under a race. Protective suspension needs no human.
* **Why not `createHumanDecisionBootstrapAuthorizer` directly:** its port is AUTH-03's bootstrap
  decision format and WebAuthn passkey service. The adapter keeps its semantics over synthetic Ed25519
  approval keys. **Limitation:** no passkey, no user-verification flag, no AUTH-03 identity chain.

## 6. SQLite design (WP-08, §8)

Dedicated file, tables prefixed `cc_`; no Assurance table is read or written. WAL, `synchronous=FULL`,
`foreign_keys=ON` on the store's connection, every write in `BEGIN IMMEDIATE`.

**The invariant** — a confirmed critical-failure evaluation cannot be committed while the credential
head is ACTIVE — is enforced by triggers only, because SQLite has no deferred triggers and foreign keys
are a per-connection setting (better-sqlite3 enables them; another client need not). The write path is
restructured so the atomic record is **one row**:

1. `cc_evaluations` carries the pre-signed protective transition in `pt_*` columns.
2. `BEFORE INSERT ON cc_evaluations` refuses: an evaluation not computed on the current head
   (`credential_state_version` ≠ head → `cc:stale head`, the CAS); a column/JSON mismatch; a critical
   failure (or any required suspension) against an ACTIVE head without `pt_*`; a critical failure whose
   protective reason is not `CRITICAL_VIOLATION_CONFIRMED`; a protective transition for a non-ACTIVE head.
3. `AFTER INSERT ON cc_evaluations` inserts the transition; `BEFORE INSERT ON cc_transitions` checks
   genesis, contiguity, chain, allowed edges, eligibility of activations (an eligible evaluation on the
   immediately preceding head, none failing after it), two consumed human decisions for T2, T5-after-
   violation, T6/T7, the suspension timeout for automatic revocation, and terms for expiry;
   `AFTER INSERT ON cc_transitions` advances `cc_heads`.
4. `cc_heads` accepts only writes equal to the latest transition; every other table is UPDATE/DELETE-
   refused.
5. Every table has a `BEFORE INSERT` duplicate guard on each of its identity keys, because
   `INSERT OR REPLACE` deletes the conflicting row without firing DELETE triggers, `INSERT OR IGNORE`
   silently skips (including the nested transition insert), and an upsert becomes an update. The
   single `AFTER INSERT` trigger on `cc_evaluations` re-checks its postconditions — the protective
   transition exists and the head is not ACTIVE next to a failure — and the head advance re-checks
   that the head equals the new transition. `RAISE(ABORT)` is not affected by a conflict clause.
6. The open-time check compares the name **and SQL text** of every table, index and trigger with the
   schema, so a same-name trigger with a weakened body is refused.
7. *(PR #263 remediation, §14)* `AFTER INSERT ON cc_observations` records every accepted violation in the
   append-only `cc_confirmed_violations`, with the number of distinct operators that reported a violation
   of the same subject, profile, control and operation within the corroboration window. A critical row
   at or above `minDistinctOperators` is a **confirmed critical violation**, durable from the moment the
   corroborating observation is accepted. The T5 guard requires two consumed human decisions whenever
   such a row was accepted at or after the credential's last activation. The T2 guard refuses issuance at
   or after `candidate_until_ms`.

Stored **observations** are re-authenticated before every evaluation and every verification
(`authenticateStoredObservation`: signature under the enrolled key, stored digest, every column
against the signed payload, operator, coordinator challenge signature, nonce, assignment, the engine's
classification, evidence-package attribution). The lifecycle never evaluates a row that fails; the
verifier reports `EVIDENCE_TAMPERED`. Activation and automatic reinstatement re-establish eligibility
inside the write transaction (`commitTransition` precheck).

Any `RAISE` aborts the whole statement, so the evaluation, transition and head change commit together
or not at all. The store refuses to open a file whose trigger set is not exactly its schema's.
Triggers stop unintended application-level mutation; they do **not** stop an administrator who drops
them or replaces the file — that is detected by the history verifier and the open-time check, not
prevented.

## 7. Engine, lifecycle and verifier

* **Engine (CC-D-03):** classification is computed from the challenge's expected outcome (the
  validator's `outcomeClass` is recorded and compared, never used). k = 2 distinct operators within
  30 min confirms or verifies; a single report → investigation (`UNDER_INVESTIGATION`), deadline 30 min,
  then SR-4 suspension (`CORROBORATION_UNAVAILABLE`), never revocation; a contemporaneous or later
  conformant observation from another operator → `CONFLICTING` (never a pass), resolved only by
  conformance from ≥ 2 operators other than the reporter (≥ 3 operators in all) or confirmed by a
  second violating operator; unresolved past the deadline → SR-4 `CONFLICTING_EVIDENCE`. A confirmed
  violation stands until a full success window lies after it. Freshness per requirement with a 6 h
  grace, then SR-2 `EVIDENCE_STALE`. While SUSPENDED, pre-suspension evidence does not count.
* **Profiles:** `rn.conformance.integration@0.1.0` (the RN-CONFORM-01 draft, pinned
  `sha256:c3fa6377…3e43`) **cannot** activate here — CR-03/CR-04 have no challenge, CR-11 needs human
  review, CR-12 has no defined SDK (CC-D-10). The circuit runs `rn.conformance.synthetic-circuit@0.1.0`
  (pinned `sha256:89ff278a…b432`), which covers CR-01, 02, 05, 06, 07, 08, 09, 12 and declares CR-03,
  04, 10, 11 *not covered*. Both carry `normative: false`, `commercialActivation: false`.
* **Lifecycle:** T1 registration; T2 issuance (eligible + two humans); T3 candidate expiry (30 d);
  T4 protective suspension (automatic, atomic); T5 reinstatement (after a violation: remediation
  declaration + full revalidation + two new single-use decisions from two distinct humans — the same
  people who approved issuance may approve again; after `EVIDENCE_STALE`/
  `CORROBORATION_UNAVAILABLE`: automatic once revalidated — unless a critical failure was confirmed
  at any time during the suspension, which forces the two-person path); T6 revocation from SUSPENDED (two humans,
  or automatically after 30 d suspended — the only automatic revocation); T7 revocation from ACTIVE
  (two humans); T8 expiry (90 d). REVOKED and EXPIRED are terminal. A prepared action binds its
  evaluation and is refused if tampered, older than 15 min, or if the head moved; eligibility is re-
  established at commit.
* **Bounded evaluation (§14, finding 2):** an evaluation reads, through an index, only the newest
  `MAX_EVALUATION_OBSERVATIONS` (4 096) observations within the evaluation horizon (longest freshness +
  grace + window + investigation timeout ≈ 7 d 7 h). More than that is `evidenceTruncated`: no success can
  be established (fail closed: SR-2 on an ACTIVE credential, never eligible otherwise), while violations
  among the newest observations still confirm under SR-1. Each result cites at most 4 supporting
  observations per operation. The full history stays in the store and is audited by
  `verifyEvidenceHistory` in pages of 512.
* **Operation coverage (§14, finding 4):** each enforcement requirement is evaluated for every covered
  operation separately; G08 once. The requirement is the weakest of its operations.
* **Verifier:** existence in the caller's organization, full history verification, exact subject and
  profile digest, committed state ACTIVE, term, operation covered and not excluded, critical evidence
  fresh *now*, no pending protective action, no open investigation, and an optional local high-water
  mark (rollback/conflict). Never throws; every doubt is a refusal.

## 8. Tests

All in `src/enterprise/__tests__/`, run as compiled `dist/…/*.test.js` with `node --test`. 79 tests in 8 suites, all passing (Windows Node v22.22.0, `node --test`, two suites per command).

| Suite | Covers |
|---|---|
| `conformance-canonicalization` | Golden bytes/digests, 24 refusal reasons, single-read snapshots, the differential probe, domain separation, key ids, signature negatives |
| `conformance-identity-registry` | Profile pins and coverage, integration registry refusals, profile/SDK downgrade, synthetic operators, enrollment with every approval failure mode, key substitution/reuse, direct-DB enrollment, adapter edge cases |
| `conformance-evidence` | Challenge signing, binding, idempotency, eligibility, CSPRNG nonces; acceptance; **every** rejection reason; conflict retention and quarantine; redaction |
| `conformance-sqlite-integrity` | The seven §8 demonstrations against real SQLite through a raw connection with foreign keys off; immutability of every table; CAS/gap; tamper and re-chain detection; restart replay; tenant scoping |
| `conformance-engine-lifecycle` | Classification; quorum per operator; window; investigations and timeouts; disputes and three-operator resolution; freshness and grace; full-profile non-activation; human gates; reinstatement rules; revocation, timeout, expiry, terminal states; version isolation |
| `conformance-end-to-end` | Stages A–N in one run: `CANDIDATE → ACTIVE → SUSPENDED → ACTIVE` (T1, T2, T4, T5; stateVersion 1–4) |
| `conformance-review-regressions` | One test per independent-review finding (§13): conflict clauses, REPLACE/upsert, injected and rewritten evidence rows, laundered reinstatement, same-name trigger replacement, borrowed evidence packages |
| `conformance-structure` | No network/HTTP/XRPL/token code; imported by nothing outside its module and tests; no Assurance imports; no committed private keys; rn.sv digest and NO-GO unchanged |
| `conformance-remediation` | The five Codex findings on PR #263 (§14), each with the reported scenario reproduced on real SQLite, its store-boundary and raw-connection variant, restart, and boundaries |

The harness's baseline now runs every enforcement challenge for **each** covered operation
(`document.export`, `document.open`) and G08 once — 11 challenges instead of 6 — because evidence for
one operation no longer counts for another (§14, finding 4).

## 9. Deviations from the RN-CONFORM-01 contracts

| Contract | Deviation | Reason |
|---|---|---|
| Identifiers `<kind>_<ULID>` | `<kind>_<32 hex>` from 16 random bytes | No new dependency |
| `IntegrationVersion.integrationDigest` inside the record | Digest computed over the record and stored beside it | No self-referential digest |
| `testEndpoints` with URL/authorization | `{endpointId, environment:'synthetic', fixtureRef}` only | No endpoint authorization exists (CC-D-12) |
| Observation `expectedOutcome` enum | Adds `deployment_digest_match`; observed outcome adds `digest_reported` | G08 is a digest comparison, not a denial |
| Rejection `DUPLICATE` (identical resubmission = no-op) | Identical resubmission is `REPLAYED` (rejected, retained) | Mission: "replayed event rejected" |
| Validator states `enrolled/active/quarantined/revoked` | Enrolled + append-only `KEY_REVOKED`/`QUARANTINED` events; release from quarantine not implemented | RN-CONFORM-05 |
| `CredentialTransitionV1` | Adds `organizationId`, `transitionCode`, `integrationDigest`, `profileId`, `evaluationDigest`, `actionBindingDigest`, `remediationDigest`, `synthetic` | Exact binding and auditability |
| `CONFLICTING_EVIDENCE` reinstatement | Requires remediation + two humans (not automatic) | Profile §6 lists only stale/unavailable/retired as automatic |
| Freshness requirement CR-09 under a dispute | Judges freshness only; disputes are reported by their own requirement | A bug found by the tests: an open investigation was being turned into SR-2 |

## 10. Known limitations and non-production constraints

* Synthetic federation only: operator ids are labels; one process signs for all validators.
* Human approvals are synthetic Ed25519 keys, not AUTH-03 passkeys; the store trusts that consumed
  decision rows were verified (the history verifier re-verifies their signatures when given the
  directory).
* The transition signing key and coordinator key are in-process test keys (custody: CC-D-07).
* No scheduler, heartbeat, assignment randomness or validator health (RN-CONFORM-05).
* The in-process verifier is not a status assertion: no signed status, nonce protocol, stapling, key
  distribution, endpoint or anchoring (RN-CONFORM-03/03X).
* The engine scans all observations for one integration digest per evaluation; fine for synthetic
  volumes, not tuned for production.
* Triggers do not protect against an administrator replacing the database file (§6).
* T07 of the threat model (fixture ≠ production) is untouched: everything here is a fixture.
* *(§14)* An **unconfirmed** single-operator dispute that is never evaluated for longer than the
  evaluation horizon (≈ 7 d 7 h) falls out of the bounded read: the credential then fails closed on
  stale evidence (SR-2) instead of SR-4 `CONFLICTING_EVIDENCE`. Confirmed violations are not affected
  (they are recorded durably). A scheduler that evaluates more often than the horizon closes this;
  scheduling is RN-CONFORM-05.
* *(§14)* For a profile with `minDistinctOperators` > 2 the recorded-violation count over ± one window
  over-approximates corroboration; it can only require humans more often, never less.
* *(§14)* Revocation policy is withdrawal, not rewriting: a validator revoked or quarantined at
  evaluation time is excluded from every later evaluation, including for evidence accepted before.
* *(§14)* A raw writer can still insert forged rows; they are refused on re-authentication and only
  ever add recorded violations (stricter), never remove one.

## 11. Deferred work and follow-ups

* **RN-CONFORM-03:** signed `rn.conformance.status/1` assertions (`status` domain), online nonce mode,
  stapled offline assertions, external key distribution, verifier-side high-water mark persistence,
  simulated anchor record; status key custody (CC-D-07), privacy (CC-D-13).
* **RN-CONFORM-03X:** XRPL Testnet anchor class in xrpl-sovereign-access after CC-D-06.
* **RN-CONFORM-04:** synthetic Fileverse reference PEP and G03/G04 challenges; CC-D-10, CC-D-12.
* **RN-CONFORM-05:** standalone validators, real operator independence (CC-D-02), scheduling,
  heartbeats, quarantine release, key rotation.
* **F-1:** both existing canonicalizers emit invalid JSON for sparse arrays (`[1,,3]`) — a Protocol
  issue and a Frontera governance-store issue; report upstream; no digest changed here.
* **F-2:** CC-D-14 registry defects (`deprecate()` frozen check, `aoc.saf` deep-freeze) remain open.

## 12. Threat-model deltas (THREAT_MODEL.md)


| Threat | Change from RN-CONFORM-01 |
|---|---|
| T01/T02/T03 validator compromise, malice, collusion | Operator-level k = 2, single-report investigation, three-operator dispute rule **implemented and tested** (synthetic) |
| T04/T05 forged / replayed evidence | Signature under enrolled key, nonce echo, `eventId`/`(challenge, validator)` uniqueness **implemented and tested** |
| T08/T21 unauthorized suspension / insider override | Two-person synthetic authority with durable consumption; DB refuses activation without an eligible evaluation or against a later failure **implemented** |
| T09 stale ACTIVE | In-process verifier fails closed on stale evidence, pending action or open investigation; offline assertions still RN-CONFORM-03 |
| T10/T22 registry compromise / rollback | Hash-chained signed transitions, trigger-enforced append-only store, open-time trigger-set check, local high-water mark; whole-file replacement still only *detected* |
| T19 cross-tenant | Organization in every key and read; trigger-checked platform/integration/credential tenancy |

## 13. Independent review (AI reviewer; not an accredited audit)

A separate reviewer agent examined the diff against the mission §13 checklist and demonstrated each
confirmed finding with a proof-of-concept against the built code. All were fixed and each has a
regression test; the original proofs of concept were re-run and are now refused.

| # | Sev | Finding | Fix |
|---|---|---|---|
| P0-1 | P0 | `INSERT OR IGNORE` of a critical evaluation whose `pt_transition_id` collided made the nested transition insert silently ignored: a critical failure committed with the head ACTIVE | Duplicate guards on every identity key; one ordered AFTER trigger with postcondition `RAISE(ABORT)`s; head-advance postcondition |
| P1-1 | P1 | `INSERT OR REPLACE` bypassed immutability (no DELETE trigger fires): head rewound to ACTIVE v2; observations rewritten | `BEFORE INSERT` duplicate guards on all tables including `cc_heads` |
| P1-2 | P1 | Verifier and engine used `cc_observations` columns without re-authenticating them | `authenticateStoredObservation` before every evaluation and verification; `EVIDENCE_TAMPERED` verdict |
| P1-3 | P1 | A violation confirmed while suspended for `CORROBORATION_UNAVAILABLE` could be auto-reinstated without humans | Two-person path whenever a critical failure was confirmed during the suspension — in the lifecycle, the T5 trigger and the history verifier |
| P2-1 | P2 | Open-time check compared trigger names only | Compares name and SQL of all tables, indexes and triggers |
| P2-2 | P2 | Activation eligibility re-checked outside the write transaction | `commitTransition` precheck runs under the IMMEDIATE lock |
| P2-3 | P2 | Integrity tests did not exercise conflict clauses or same-name trigger replacement | `conformance-review-regressions` |
| P3-1 | P3 | An observation could cite another validator's evidence package | Package `challengeId`/`validatorId` must equal the observation's |
| P3-2 | P3 | Docs said "two new humans"; code requires two new decisions | Docs corrected; same principals may approve again (decisions are single-use) |

Remaining risks: see §10. In particular the database cannot verify signatures, so a writer with raw
access can still insert *structurally* valid rows; such tampering is detected by the verifier
(transition, decision and observation signatures are all re-verified), not prevented.

## 14. PR #263 Codex review remediation (founder decision: fix all five before merge)

Five P2 findings were posted by the Codex reviewer on `6b21a5b9`. None was accepted as residual risk.
Each fix below has a regression test in `conformance-remediation.test.ts` that reproduces the reported
scenario on real SQLite through the real services.

| # | Codex thread (location) | Root cause | Fix | Regression test | Invariant |
|---|---|---|---|---|---|
| 1 | `lifecycle.ts:145` | Whether reinstatement needed humans was derived only from **committed evaluations**. A violation corroborated while SUSPENDED for `EVIDENCE_STALE`/`CORROBORATION_UNAVAILABLE`, followed by revalidation before anyone called `evaluate()`, left no trace once later successes cleared it in the engine — `reinstateAutomatically` returned ACTIVE without humans (a residual of P1-3). | Confirmation is recorded **at acceptance** by trigger in the append-only `cc_confirmed_violations` (§6 item 7), independent of evaluations and transitions. The lifecycle, the T5 store guard and the history verifier all require two humans when a confirmed critical violation was accepted since the last activation. | `Codex finding 1 — …` (A–I: stale suspension → unevaluated corroborated bypass → persisted → full revalidation → automatic refused; DB refuses T5 via store and raw connection; record cannot be deleted/updated; restart; one human / same human / other proposal refused; two humans reinstate; history verifies) + active-period variant + single-operator negative | I1, I2, I8 |
| 2 | `engine.ts:117` | Every evaluation embedded **every** usable observation id (per requirement and again overall); the record is digested under a 4 096-node canonicalization limit, so ≈ 2 172 observations made `evaluate()` throw `TOO_MANY_NODES` and no protective suspension could commit. Reads were unbounded scans and corroboration was O(n²). | Bounded supporting evidence per result; indexed newest-first read within the evaluation horizon, capped at 4 096 with an explicit fail-closed `EVALUATION_CAPACITY_EXCEEDED`; sliding-window corroboration (O(n log n)); full history kept and audited by `verifyEvidenceHistory` (paged). | `Codex finding 2 — …` (> 2 200 accepted observations: evaluation conformant, record size equal to a fresh credential's, deterministic; fresh corroborated bypass → SUSPENDED; full history re-authenticates with 0 defects); horizon test (old A+B evidence cannot satisfy quorum); capacity test (SR-2 with explicit reason, verifier refuses, SR-1 still fires) | I3, I7 |
| 3 | `sqlite-conformance-store.ts:385` | T2 checked only the 90-day credential term; the 30-day candidate deadline was enforced only by `applyTimeRules`, so a candidate could be issued after its term if that rule had not run. | T2 refused at the store when `effective_at_ms ≥ candidate_until_ms` (deadline exclusive for issuance, inclusive for T3 expiry — exactly complementary); the lifecycle refuses `prepare('issue')` and `commit` with `CANDIDATE_TERM_ENDED`; the history verifier reports `TERM_VIOLATION`. | `Codex finding 3 — …` (1 ms before the deadline succeeds; at the deadline: replayed preparation with two valid approvals, fresh preparation, fully formed two-human T2 through the store and a raw connection all refused, after a restart; T3 still expires; verifier refuses a late T2 written with the triggers dropped) | I6 |
| 4 | `engine.ts:205` | Accepted observations carried no operation; the engine aggregated by control only, so `document.open` evidence satisfied `document.export`. | The operation is stored (column, trigger-checked against the challenge, re-checked against the signed observation) and carried into the engine; each enforcement requirement is evaluated per covered operation and combined as the weakest (§7). G08 is operation-independent. Integrations are limited to 16 covered operations. | `Codex finding 4 — …` (A–F: open-only evidence → export `INSUFFICIENT_EVIDENCE`, not eligible; export bypass not masked by fresh open success → SR-1; full evidence activates) + G (a changed declared scope is a new integration digest; old evidence is not reused; the new operation needs its own evidence) | I4 |
| 5 | `evidence.ts:319` | Re-authentication of stored rows re-checked signatures and bindings but not the challenge **deadline** or the enrolled key's **validity interval**, so signed-but-late observations inserted through the store were counted. | One acceptance contract (`checkObservationAuthority` steps 2–8, `checkObservationCustody` step 10) used by both `submitObservation` and `authenticateStoredObservation`, evaluated as of the row's recorded acceptance time; plus column checks for operation and millisecond times. Policy: historical checks for validity; revocation/quarantine at evaluation time withdraws a validator's evidence without reporting it as forged. | `Codex finding 5 — …` (late rows → `CHALLENGE_EXPIRED`, backdated acceptance → `FUTURE_DATED`, verifier `EVIDENCE_TAMPERED`, never counted, same after reopen; invalid rows never complete quorum; key expired at observation time → `KEY_NOT_VALID`; honest evidence stays valid after its key and challenge expire; tampered stored challenge → `CHALLENGE_UNKNOWN`; revoked key withdraws without `EVIDENCE_TAMPERED`) | I5 |

**Interactions checked.** Recorded violations (1) are per control **and operation**, consistent with the
per-operation engine (4): a violation of `document.open` by A and of `document.export` by B is not a
corroboration. They do not depend on the bounded read (2), so a confirmed violation can never fall
out of view. The capacity bound (2) applies across all operations of (4): truncation denies every
success, so per-operation coverage cannot be satisfied from a partial read.

**Unchanged.** No HTTP, network, XRPL, Fileverse or token code; `rn.sv@0.1.0` and its digest
(`conformance-structure`); the Founding Assessment commercial NO-GO; the two pinned profile digests.
The store schema changed (new columns, table, indexes and triggers); it is a new synthetic store, and
the open-time schema check refuses any file created by the previous version.
