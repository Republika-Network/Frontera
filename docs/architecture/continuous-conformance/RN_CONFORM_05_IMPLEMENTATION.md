# RN-CONFORM-05 — Federated Validator Operations (implementation record)

**Status:** synthetic, non-production implementation. **CC-D-02 is not approved for production.** No real
operator, endpoint, customer, ledger or token is involved. Nothing in this record is a certification, and no
AI review referenced here is an accredited security audit.

## 1. Executive result

RN-CONFORM-05 adds the operational layer that lets separately managed validators witness challenges:
operator identities with a lifecycle, validators pinned to operators, Ed25519 key **generations** enrolled by
proof of possession and two humans, signed heartbeats, a durable operator-aware scheduler with fenced leases
and bounded retries, a standalone witness-only validator runtime with a durable outbox, automatic quarantine,
two-person release with requalification, and revocation.

**Central rule, enforced by construction:** a validator witnesses an authorized challenge and signs an
observation. It never decides conformance. Classification, corroboration and every credential transition stay
with the RN-CONFORM-02 engine and lifecycle (unchanged); status stays with RN-CONFORM-03 (unchanged).

**What remains synthetic:** every operator is a Republika-controlled synthetic label
(`designation: SYNTHETIC-FEDERATION-NON-PRODUCTION`, `independenceVerification: NOT_VERIFIED`). Multiple
processes or keys **do not** prove multiple independent organizations (FV-01). The transport is in-process.

## 2. Baseline

| Item | Value |
|---|---|
| Repository | `Republika-Network/Frontera` |
| Branch | `feat/rn-conform-05-federated-validator-operations` |
| Worktree | `C:\Users\Usuario\Republika-worktrees\CONFORM-05\frontera` (fresh, from `origin/main`) |
| Base | `e47582dd` (RN-CONFORM-04 squash, #270) |

## 3. Dependency verification

| Mission | PR | Merge commit | Check |
|---|---|---|---|
| RN-CONFORM-01 | #261 | `f36d9dd5` | merged |
| RN-CONFORM-02 | #263 | `681d9a06` | merged |
| RN-CONFORM-03 | #266 | `fc5604ef` | merged |
| RN-CONFORM-04 | #270 | `e47582dd` | merged 2026-11-04; every RN-CONFORM-04 path in the merged tree is byte-identical to the reviewed head `d06fee9b` (the only other change on main is the unrelated FV fix #269) |
| RN-CONFORM-03X | xrpl-sovereign-access #16 | `a2c09b77` | merged; context only — nothing here imports it, no ledger call exists |

The authoritative architecture documents and the current registry, human authority, coordinator, evidence
acceptance, engine, lifecycle, SQLite store, status verifier and reference PEP harness were read before any
edit. Findings that shaped the design (all verified in code):

* The conformance store refuses any schema it did not create (exact table/index/trigger comparison on open, no
  migrations), every row is immutable, a validator holds exactly one inline key, quarantine is the earliest
  `QUARANTINED` event and cannot be released, event kinds are fixed by `CHECK`.
* Stored evidence is re-authenticated against the validator's single enrolled key; a later quarantine or key
  revocation withdraws **all** of that validator id's evidence from later evaluations; exclusion is per
  validator id, corroboration is per operator id.
* No lease, outbox or job-queue implementation exists anywhere in the repository; the closest conventions are
  the epoch-fenced protected-continuity store and `BEGIN IMMEDIATE` compare-and-advance writes.

## 4. CC-D-02 disposition (provisional, synthetic)

Implemented as a **provisional architecture**, not an approval:

1. Republika may operate validators; future legal operators may operate their own.
2. An operator may control many validators; **all validators of one operator are one corroboration source.**
3. A confirmed result needs ≥ 2 distinct eligible operators; disputes need ≥ 3 (existing CC-D-03 engine rules).
4. Independence is **administrative** (two-person operator approval in the coordinator-side registry), never
   inferred from keys; a validator cannot choose, change or add an operator identity.
5. No non-synthetic ACTIVE credential can result: every record is synthetic and CC-D-12 stays synthetic-only.

**Outstanding production decisions (founder):** operator agreement model; eligibility and identity verification;
conflict-of-interest policy; legal responsibility; liability allocation; operating geography; minimum operational
security; financial and commercial terms. The DECISION_REGISTER records CC-D-02 as still **OPEN**.

## 5. Operator identity model (WP-01)

`FederationOperatorRecord` (closed, digest-verified on every read): immutable `operatorId`, `operatorClass`
(`REPUBLIKA` | `CANDIDATE_EXTERNAL`), opaque `administrativeOwnerRef` (an identifier; no personal data fits),
`designation`, `independenceVerification: NOT_VERIFIED` (the only value that exists), the verbatim synthetic
statement, `registeredAt`.

Lifecycle `REGISTERED → APPROVED → ACTIVE ↔ QUARANTINED → REVOKED`, as a versioned append-only log
(`version = previous + 1` and REVOKED-is-terminal enforced by trigger). Approval and reinstatement and revocation
need two humans of the network organization (`operator.approve` / `operator.reinstate` / `operator.revoke`),
each bound to the exact state and version moved from. Activation needs a prior approval. The conformance-store
operator row (what corroboration counts) is created **only after approval**. A quarantined operator quarantines
every validator it runs; reinstating the operator does not release them. Duplicate registration — identical or
not, concurrent or not (F-12) — yields exactly one record.

## 6. Validator enrollment (WP-02)

The RN-CONFORM-02 registry is **extended, not duplicated**: the federation registers a logical validator
(`fed_validators`, pinned to its operator forever, `.k<n>` suffix reserved) and enrolls each key generation in
the existing conformance store as `<validatorId>.k<n>` through the existing two-person `validator.enroll`
path. Steps: eligible operator (APPROVED/ACTIVE) → unique validator id → public key (Ed25519, never a private
PEM, never a key already enrolled anywhere) → **proof of possession** (the candidate key signs a coordinator
nonce in its own domain `frontera:conformance-key-possession:v1`, single use, 10 min) → the enrollment record
must equal exactly what the proof covered → two humans → durable commit → activation (operator ACTIVE, exactly
one ACTIVE generation). The operator in every record comes from the registry, never from the request.

## 7. Signing and custody (WP-03)

The runtime signs through an `ObservationSigner` port (key id + `sign(kind, payload)`); no store holds a private
key. Tests use **ephemeral** keys generated per run (`generateKeyPairSync`), never committed, never derived from
public strings, never logged. Observations keep the `frontera:conformance-observation:v1` domain and
`aoc-canonical-json/1`. Heartbeats use the new `frontera:conformance-validator-heartbeat:v1` domain; the
domain-separation test covers both new domains. The coordinator never sees a validator key.

## 8. Key rotation (WP-04)

A rotation is a **new generation** (proof of possession + two humans) under the same validator and therefore the
same operator — it adds no vote. The previous generation becomes `RETIRED`: never assigned again, but its
conformance-store identity is untouched, so its historical signatures re-authenticate under its own key. A
compromised key is revoked protectively (`KEY_REVOKED`, no humans) and its evidence is withdrawn by the existing
exclusion rule. Rotation is refused while quarantined; quarantined/retired/revoked generations never return
(trigger). Interrupted rotations (crash between the two stores) complete on retry without new approvals, and
the half-written generation is never eligible meanwhile. Test matrix items 1–12 are covered in
`conformance-federation-registry.test.ts` and the scheduler/runtime suites (rotation during an active challenge:
the old generation keeps only its already-issued assignment; during a partition: the outbox belongs to one
generation and is never inherited).

## 9. Heartbeat protocol (WP-05)

`rn.conformance.validator-heartbeat/1` binds validator, operator, generation, key id, a coordinator-issued
session, a strictly increasing sequence (durable in the validator's outbox), `emittedAt`, `READY|DRAINING` and
the capability set (must equal the registered one). Refusals: malformed, unknown, revoked, quarantined, operator
not active, operator mismatch, generation not active, key mismatch / not eligible, bad signature (checked before
any state, so an unauthenticated heartbeat is never attributed), session mismatch, capability mismatch, replayed
or older sequence, equivocation (attributable violation), stale, future-dated, clock rollback. Freshness uses the
coordinator's receipt time. Health (`HEALTHY | DEGRADED | UNREACHABLE | QUARANTINED | REVOKED`) is liveness, not
trust; QUARANTINED/REVOKED come from the lifecycle, so a heartbeat can never lift a quarantine. Defaults
(`FEDERATION_TIMING`, one place, **operational defaults, not SLOs**): interval 60 s, DEGRADED after 120 s,
UNREACHABLE after 300 s (CREDENTIAL_LIFECYCLE §4), max age 120 s, skew 5 s.

## 10. Scheduler (WP-06)

`PENDING → LEASED → DISPATCHED → COMPLETED`, with `RETRY_PENDING`, `EXPIRED`, `FAILED_FINAL`, `CANCELLED`. The
allowed edges, write-once challenge binding, immutable identity columns and terminal states are enforced **by
trigger**. Purposes: `ROUTINE` (one job per (requirement, operation) without two operators' evidence in the
routine window), `INVESTIGATION` (single-operator violation → other operators), `DISPUTE` (violation vs
conformance → operators not yet involved, up to three distinct), `REQUALIFICATION`. Nothing is scheduled outside
a two-person, time-boxed **testing authorization** of the integration's own organization that names only
synthetic fixtures the integration registered; the whole challenge must fit inside the window. The job id is the
coordinator idempotency key, so every retry and every worker obtains the **same** signed challenge (same id,
nonce, deadline); deadlines are fixed per purpose (routine 600 s, investigation/dispute 900 s, both ≤ the 15-min
ceiling and inside `T_confirm`). Bounded queue (512 open jobs), bounded attempts (5), exponential backoff
5 s → 300 s with ≤ 3 s jitter from the injected random source.

## 11. Leasing and fencing (WP-07)

`acquireLease` is one IMMEDIATE transaction with a conditional update; every acquisition advances the
`lease_generation` fencing token (trigger: must advance on a new owner, never decrease). Renewal, challenge
binding and every commit require the current owner, the current token and an unexpired lease; otherwise
`FENCED`. The dispatcher renews (fences) before every outbound delivery, so a worker that lost its lease stops
delivering. An expired lease is released to `RETRY_PENDING` without the worker's cooperation. Concurrency safety
is in SQLite, not in memory. **Delivery is at-least-once with idempotency, not exactly-once.**

## 12. Durable job recovery

Before delivering, the worker reconciles every assignment against the conformance store's committed observations
(the only source of truth for acceptance). Lost acknowledgements, worker crashes before/after dispatch and
coordinator restarts (`F-01`) therefore never duplicate a vote and never lose a pending job. A validator restart
reconciles its outbox first (`isCommitted`) and only then resubmits the identical signed bytes.

## 13. Quarantine (WP-11)

Automatic triggers: contradictory signed observations (evidence acceptance's existing `VALIDATOR_CONFLICT`
quarantine, mirrored by `syncFromConformance`); persistent **authenticated** protocol violations at or above
3 per hour (evidence rejections only reachable after the validator's own signature verified — binding,
assignment, subject, profile — plus equivocating / forged-operator / forged-capability heartbeats). Signature
failures are **not** attributed: anyone can send bytes claiming a validator id (normative clarification recorded
in VALIDATOR_PROTOCOL §1). Missing heartbeats only make a validator unassignable. Effects: every generation is
quarantined in the conformance store first (evidence acceptance and the engine read it), then the federation;
no new assignments; history untouched; no credential is touched — the engine re-evaluates what valid evidence
remains. **Release** creates a new generation (the quarantined identity never returns), needs two humans for
`validator.enroll` **and** two for `validator.reinstate`, keeps the validator quarantined until a bounded
requalification challenge (alongside a reference validator of another active operator) agrees with the
reference, and re-checks key and operator eligibility. Requalification runs only under a `REQUALIFICATION`
testing authorization whose integration has **no credential** (the validator network's own fixture), so a
still-untrusted generation's observation is never a vote on a real credential; the registry derives the result
from the completed job and the stored evidence (it is never told). No heartbeat, activation or rotation path exits quarantine.

## 14. Revocation (WP-12)

Three distinct actions: **key revocation** (one generation, protective), **validator revocation** (two humans
`validator.revoke`; every generation's key revoked; terminal; id never reusable) and **operator revocation** (two
humans `operator.revoke`; every validator and key revoked; terminal). Revocation prevents new assignments
(eligibility), new observations (evidence acceptance), heartbeats and identity reuse; it preserves every
historical record and attribution. Races (issuance, submission, heartbeat, rotation, investigation, two-operator
capacity) resolve by the conformance store's time-stamped event: an observation submitted at or after the
revocation instant is refused by evidence acceptance, and every observation of a revoked generation — including
ones accepted earlier — is excluded from every later evaluation (the existing RN-CONFORM-02 rule), so no timing
ambiguity can leave a revoked validator with a vote. With only two operators eligible, revoking one leaves the
scheduler unable to reach quorum, and the engine fails closed (SR-4).

## 15. Operator-aware assignment (WP-08)

Candidates: ACTIVE validator, ACTIVE operator, exactly one ACTIVE generation eligible in both stores through the
deadline, HEALTHY/DEGRADED, capable (type and profile). One validator per operator (least-loaded, random
tie-break); excluded operators for investigations and disputes. Fewer distinct operators than required →
`QUORUM_INSUFFICIENT` event and no job: capacity is never fabricated, and the engine's existing
investigation/staleness rules take over (SR-3/SR-4). Validators cannot choose targets, profiles, nonces,
integration versions or operators — every binding is under the coordinator's signature.

## 16. Evidence delivery (WP-10)

The runtime verifies the coordinator signature against pinned keys, its own assignment, the authorized target and
fixture, the synthetic environment, profile and challenge-type capability, the deadline (re-checked after
execution) and nonce shape, then executes through an injected executor (never a URL), deposits a redacted
evidence package, signs, **records the signed bytes durably before submitting**, and submits through the existing
evidence service. Every RN-CONFORM-02 acceptance check still applies. A rejection is recorded and returned on
every redelivery; it never becomes an acceptance through retry.

## 17. Conformance engine integration (WP-13)

No engine, lifecycle or status code changed. Evidence acceptance received one narrowly scoped compatibility fix (§24, F-0) and the conformance store one read-only query (`hasCredentialForIntegration`); no schema changed. Scenarios (`conformance-federation-corroboration.test.ts`):
A + D two distinct operator records → `VERIFIED_FAILURE` → automatic T4 → online status `SUSPENDED`; B + G three
validators of one operator → one operator vote, nothing confirmed; C one malicious validator → investigation →
`CONFLICTING` → third operator → resolved, credential stays ACTIVE; E conflict → third operator confirms (no false
pass) / third operator unavailable → no quorum fabricated → SR-4 `CONFLICTING_EVIDENCE` past `T_confirm`;
F operator unavailable → SR-4 `CORROBORATION_UNAVAILABLE`, never a confirmed violation; H crash after signing →
same bytes, one vote.

## 18. Credential lifecycle separation (WP-14/15)

Static tests prove no federation module imports the lifecycle, verifier, status or anchor modules, and none calls
`commitTransition`, `commitEvaluation`, `createCredential`, `insertObservation`, `insertRejection` or
`withStatusIssuance`; the runtime imports no store or registry at all. The only conformance-store writes the
federation performs go through the existing registry: `registerSyntheticOperator` (after two-person approval),
`enrollValidator` (two-person), `quarantineValidator` and `revokeValidatorKey` (protective). Two-person controls
for issuance, reinstatement, revocation and enrollment are unchanged; operator authentication never substitutes
for a human decision.

## 19. Threat-model changes

| Id | Entry point / boundary | Exploit | Protection (existing → new) | Regression | Residual |
|---|---|---|---|---|---|
| T01 compromised validator | signed observation | false signed observations | k-of-distinct-operators → generation revocation, quarantine | Scenario C; key revocation tests | one validator can delay (investigation) |
| T02 malicious validator vs competitor | observation | cause a suspension | SR-3 single report = investigation → operator-aware follow-ups | Scenario C | SR-4 can be provoked by also making others unavailable |
| T03 operator collusion | administrative | two operators fabricate quorum | thresholds → administrative approval of operators | — | **not prevented**: collusion of k genuinely separate operators defeats corroboration |
| T04 replay | evidence | duplicated/reordered observations | eventId + (challenge, validator) uniqueness → outbox idempotency | lost-ack, redelivery tests | — |
| T05 identity forgery | registry | impersonation / operator reassignment | two-person enrollment → PoP, immutable pinning, operator from registry | registry suite | — |
| T06 key theft | signer | malicious rotation | — → PoP + two humans per generation, retire/revoke | rotation matrix | stolen key valid until revoked |
| T07 scheduler compromise | scheduler | omission / adversarial assignment | — → authorization windows, per-operator assignment, events | assignment tests | a compromised coordinator can omit work (detectable only by audit) |
| T08 lease race | job store | stale worker commits | — → fencing token by trigger | lease suite | — |
| T09 heartbeat spoofing | health | fake liveness | — → signed, session-bound, monotonic heartbeats | heartbeat suite | liveness ≠ correctness |
| T10 evidence omission | validator | suppress failing observations | corroboration → follow-up scheduling, QUORUM_INSUFFICIENT events | Scenario F | omission by all operators is undetectable |
| T11 registry rollback | federation store | restore revoked validator | — → pinned state sequence, eligibility re-reads conformance store | F-06 | an unpinned rollback is caught only by the conformance store |
| T12 quarantine bypass | registry | rotate / re-register | — → rotation refused while quarantined, new generation + 4 humans + requalification | quarantine suite | — |
| T13 cross-tenant | assignments | foreign evidence/assignment | per-org bindings → per-org testing authorization, runtime target pinning | tenant tests | — |
| T14 unauthorized endpoint | runtime | probe unapproved target | synthetic endpoints → fixture-ref allowlists, no URL, environment check | runtime suite | — |
| T15 privacy | events | leak content/keys | redacted evidence → bounded, identifier-only events | privacy test | — |
| T16 coordinator key compromise | challenge | forged assignments | pinned coordinator key | runtime tamper tests | a stolen coordinator key forges challenges (out of scope: custody) |
| T17 governance capture | lifecycle | issuance/reinstatement via validators | two-person lifecycle → no federation path to the lifecycle | static separation tests | — |
| T18 corroboration laundering | registry | many validator ids as many operators | per-operator counting → operator pinning, one-per-operator assignment | Scenario B/G | — |
| T19 DoS by investigation | scheduler | endless investigations | — → bounded queue, deadlines, threshold quarantine | F-10 | a malicious operator can repeatedly open investigations until quarantined |
| T20 historical trust | registry | rotation corrupts history | — → generations keep their own key forever | rotation item 7 | quarantine/revocation withdraws that generation's evidence (by design) |

## 20. Security invariants

FV-01 administrative independence (operator approval, synthetic labels) · FV-02 immutable validator identity
(trigger + registry) · FV-03 time-bound key eligibility (both stores) · FV-04 authorized challenges (runtime
checks) · FV-05 no decision authority (static tests) · FV-06 k = distinct operators (engine, Scenario B/G) ·
FV-07 durable idempotency (outbox + reconciliation) · FV-08 fenced stale workers (trigger + lease tests) · FV-09
effective quarantine · FV-10 human authority preserved · FV-11 evidence never rewritten by recovery · FV-12
missing evidence fails closed (Scenarios E/F, F-08) · FV-13 no arbitrary endpoints · FV-14 tenant isolation ·
FV-15 status authority separate · FV-16 mandatory synthetic labelling · FV-17 no production activation (no
listener, no route, no export) · FV-18 no token dependency.

## 21. Adversarial testing

Four suites (`conformance-federation-{registry,scheduler,corroboration,demo}.test.ts`) over real SQLite files:
identity (unknown/duplicate/forged/reused key/unauthorized activation/cross-tenant), signing (wrong domain/key,
expired/revoked/rotated key, tampered challenge, foreign coordinator), scheduling (duplicate dispatch, expiry,
stale assignment, wrong validator, insufficient operators, dispute without third operator, crash, retry
exhaustion), heartbeats (replay, duplicate/older sequence, future, rollback, missing, forged state, revoked key,
quarantined), quarantine (contradiction, threshold, invalid release, rotation/assignment/revocation while
quarantined), durability (concurrent lease, theft, expired token, crash, restart, lost ack, redelivery, duplicate
credit, corrupt row/trigger, rollback) and conformance (Scenarios A–H).

## 22. End-to-end demo

`conformance-federation-demo.test.ts`, CI job `rn-conform-05-demo`: stages 1–13 of the mission, report
`rn.conformance.federation-demo-report/1` + summary + sha256, uploaded as an artifact. Every section carries
`measured`. Reproduce: `npm ci && npm run build && FRONTERA_RN_CONFORM_05_REPORT_OUT=out/report.json node --test dist/src/enterprise/__tests__/conformance-federation-demo.test.js`.
Validator keys are ephemeral, so key ids (and therefore the report digest) differ per run; the story, states and
counts are deterministic.

## 23. CI results

Filled in after the CI run of the final head (below, "CI and review record").

## 24. Independent review findings

Filled in after the independent review (below, "CI and review record").

## 25. Open issues

* CC-D-02 production decisions (§4); CC-D-10/11 open; CC-D-12 synthetic only.
* Network transport, authentication and deployment of validators: a separate mission.
* HSM/KMS-backed signers; operator onboarding and independence verification.
* VALIDATOR_PROTOCOL's `corroboration: 'single-operator'` label is not added to status assertions (all records
  are synthetic-designated already); a production status contract must carry an equivalent.
* The two stores are not one transaction: protective writes go to the conformance store first and the federation
  view is repaired towards restriction (`syncFromConformance`); a production deployment needs this reconciliation
  scheduled, not only invoked.

## 26. Production readiness requirements

Contracted, verified, independent operators; an approved operator agreement and liability model; separately
custodied validator keys (HSM/KMS) with rotation runbooks; an authenticated network transport with deployment
approval; monitoring with alerting on QUORUM_INSUFFICIENT / HEARTBEAT_MISSED / QUEUE_FULL / REGISTRY_DIVERGENCE;
backups with pinned state sequences held outside the store; disaster-recovery drills; SLOs measured, not assumed.

## 27. Future operator onboarding prerequisites

Founder approval of CC-D-02; legal agreement; identity and eligibility verification producing something other
than `NOT_VERIFIED`; conflict-of-interest declaration; operational-security attestation; key ceremony with proof of
possession; two-person approval in the registry; a probation period of requalification challenges.

## CI and review record

**Independent review** (a fresh, read-only AI reviewer given the diff and the focus list, not the author's
conclusions; **not an accredited audit**). No P0. Dispositions:

| Id | Finding | Disposition |
|---|---|---|
| F-0 | (found by CI before the review) a quarantine stamped in the acceptance millisecond made already-accepted evidence fail re-authentication, so the status failed closed as `EVIDENCE_TAMPERED` for the evaluation horizon; one validator could trigger it with a same-millisecond contradiction | **Fixed** in `evidence.ts` (re-authentication of a stored row treats a same-millisecond status event as later; live acceptance unchanged). Reviewer verdict: sound. Regression test |
| P1-1 | a conformance-store-only quarantine could be escaped by rotation (before sync; quarantine + key revocation; key revocation after a conflict) | **Fixed**: enrollment requests mirror the conformance store first and refuse while any current generation is quarantined there; sync evaluates quarantine independently of revocation for every generation state. Regression tests (3 variants) |
| P1-2 | a reinstating generation's requalification observation counted as a vote on the organization's real credential | **Fixed**: `REQUALIFICATION` authorizations only on credential-free integrations; scheduler enforces purpose. Regression test (a lying candidate during requalification changes nothing on the real credential and fails requalification) |
| P2-1 | `completeReinstatement` trusted a caller-supplied pass flag | **Fixed**: derived from the stored job and evidence. Regression tests |
| P2-2 | crash between stores left a conformance identity quarantine/revocation could not reach, and blocked later reinstatement | **Fixed**: the federation PENDING intent is written first. Regression test |
| P2-3 | testing authorization and per-operator assignment are enforced by the scheduler, not by the RN-CONFORM-02 coordinator; a direct `coordinator.issue` caller bypasses them | **Accepted, documented** (changing the RN-CONFORM-02 coordinator contract is out of scope). Votes cannot be inflated (the engine counts operators); the coordinator stays a privileged internal component |
| P2-4 | predictable observation event ids let another validator pre-empt and suppress one | **Fixed**: CSPRNG event ids. Regression test |
| P2-5 | federation operator status does not bind the conformance store; a pre-existing conformance operator id could be adopted | **Partly fixed**: adoption refused (regression test). **Residual**: two humans can still enroll a conformance-store validator directly under a federation operator id the federation has quarantined or revoked; closing it needs operator status in the RN-CONFORM-02 store (follow-up) |
| P3-1 | same-owner takeover of an expired lease raised | **Fixed** + test |
| P3-2 | closing an already-terminal job aborted a run | **Fixed** (conditional close) |
| P3-3 | violation counting gameable by re-encoding / stale timestamps / pre-reinstatement history | **Fixed** (event-id refs; only generations and violations since the last reinstatement). Rejection timestamps are still the scan time (store has no read of `received_at`): **residual** |
| P3-4 | unauthenticated heartbeat refusals and possession requests append rows (log growth) | **Accepted** (synthetic, in-process; production needs rate limits at the transport) |
| P3-5 | free text in an event | **Fixed** |
| P3-6 | the rollback pin is optional and not persisted; a far-future clock raises the high-water mark permanently | **Accepted, documented** (production DR requirement, §26) |
| P3-7 | federation state rows carry decision ids but no database-level two-person check | **Accepted** (mitigated: eligibility re-reads the conformance store, where enrollment is trigger-checked) |
| P3-8 | doc said evidence code unchanged | **Fixed** (§17) |

Test-quality findings (requalification passed by the test itself, organization binding not isolated, weak static
ban list, orphan generation not covered) were addressed by the regression tests above and a strengthened static
check (no direct conformance-store writes, no dynamic imports in federation modules).

**CI** (head `791c2e1c`, code-final): all 15 checks green — validate (main suite **15,041 tests, 15,023 pass, 0 fail**,
11 skipped, 7 todo, of which **66** are the new federation tests), protocol-tarball-consumption, CodeQL, clean-room
consumer, publishability, pilot jobs, `rn-conform-04-demo` and `rn-conform-05-demo` (report sha256
`8c8ef74821ecd7b42c220dfd2feee606280103cfab0dac5d0622ebcfe1a8a702`; the digest differs per run because validator
keys and event ids are ephemeral). Earlier rounds: 5 test failures (three tests assumed operator B would be picked;
Scenario C needed strictly later evidence; F-0), then one explicit-any lint false positive on a comment.

**Process:** no code was executed in the Windows-mounted worktree by the author or any subagent; validation ran in
GitHub CI only. File edits were made with editor tools and small text-substitution scripts.

## Security remediation (founder-authorized, after the cross-boundary gate)

### Remediation matrix

| Finding | Vulnerable path | Exploit | Invariant | Fix | Regression |
|---|---|---|---|---|---|
| P1-1 retired-generation quarantine | `federation-registry.ts` `eligibility()` read only the ACTIVE generation's conformance status | k1 (retired, outstanding challenge) is auto-quarantined by a contradiction; k2 keeps receiving work and voting until a caller-driven sync | S-01 | eligibility (and therefore scheduler capacity and the worker's pre-delivery check) refuses while any current generation is quarantined in the conformance store, and mirrors it | rotate → contradiction on k1 → schedule/dispatch to k2 refused, also after restart; release still needs REINSTATE + requalification |
| P1-2 dispute chronology | `federation-scheduler.ts` `planFollowUps()` counted every operator seen in the window | A, B conformant before C's violation → "3 involved" → no dispute job → engine stays CONFLICTING → SR-4 suspension of a conformant credential | S-06, S-07 | per (control, operation) take the engine's earliest violation not resolved by ≥ 2 other operators' conformant observations **strictly after** it; schedule the operators still missing, allowing operators whose evidence predates it | the exact A, B → C chronology resolves; boundary, duplicate, same-operator, unavailable-third, restart, deadline cases |
| P2-5 operator authority | RN-CONFORM-02 store: operators have no status; enrollment and observation acceptance never consult the federation | quarantined/revoked operator regains its vote through a direct enrollment; `registerSyntheticOperator` mints unapproved operator ids that count as independent votes | S-02, S-03, S-04, S-13 | operator status in the authoritative conformance store (schema `/3`), enforced by trigger at enrollment and observation acceptance, and in TypeScript at issuance, acceptance, re-authentication and evaluation | §Phase E sequence, unknown / unapproved / self-registered / revoked / stale projection / same-millisecond / two fabricated ids |
| P2 job recovery | `expireOverdueJobs()` | all observations committed, crash before COMPLETED, restart after the deadline → EXPIRED; requalification lost | S-09 | reconcile committed observations first; fully evidenced jobs close COMPLETED | crash-after-commit + restart after deadline; partial; none |
| P2 requalification fixture | scheduling-time-only credential-absence check | credential registered on the fixture after scheduling → probation evidence evaluated | S-08 | re-check at dispatch (before issue and before every delivery) and at reinstatement | credential created before dispatch / before completion → refused |

### Migration plan (conformance store `/2` → `/3`)

1. **Representation.** A new append-only table `cc_operator_events(operator_id, seq, kind, at_ms, reason, binding_digest)`,
   `kind ∈ {APPROVED, REINSTATED, QUARANTINED, REVOKED, LEGACY}`. An operator is **eligible** exactly when its latest event
   is `APPROVED` or `REINSTATED`. No event = registered only = ineligible (covers UNKNOWN and REGISTERED).
2. **Mapping of existing identities.** A `/2` operator has no status; migration records one `LEGACY` event per operator
   (`reason MIGRATED_FROM_STORE_V2`). LEGACY is **not eligible**: it preserves the historical acceptance of rows accepted
   before it, and nothing else. Legacy operators become eligible again only through a two-person `operator.approve`.
3. **Migration vs. interface.** A separate authorization interface outside the store could not be enforced by the store's
   own triggers (no cross-database trigger is safe), so status lives in the store itself.
4. **Triggers / preconditions.** Sequential `seq`, non-decreasing `at_ms`, REVOKED terminal, allowed edges
   (APPROVED only from none/LEGACY; REINSTATED only from QUARANTINED; QUARANTINED from an eligible state or LEGACY;
   LEGACY only as the first event); APPROVED and REINSTATED require two consumed humans (`operator.approve` /
   `operator.reinstate`, bound to the operator and the sequence moved from); enrollment requires an eligible operator;
   observation acceptance requires an eligible operator; append-only and duplicate guards as for every table.
5. **Consistency with the federation store.** The conformance store is authoritative and is written first; the federation
   mirrors it (`syncFromConformance` also mirrors operator quarantine/revocation) and its eligibility re-reads the
   conformance operator status, so a lagging federation view can only be *more* permissive on paper, never in effect.
6. **Crash between stores.** Conformance first; a retried federation approval adopts an already-recorded conformance
   approval; a federation-only state is never sufficient for eligibility.
7. **Monotonicity.** By trigger (no update/delete, sequential, REVOKED terminal, time non-decreasing).
8. **Historical observations.** Untouched. Re-authentication checks the operator's status *at the row's acceptance time*
   (either order of same-millisecond events, see F-0), with the LEGACY era accepted; evaluation excludes validators whose
   operator is not eligible *now* (the existing exclusion rule, extended from validator to operator).
9. **Unknown operators fail closed** (no events → ineligible) at enrollment, issuance, acceptance and evaluation.
10. **Synthetic fixtures.** Test harnesses approve their synthetic operators explicitly with two humans; approval is
    operational eligibility for synthetic tests only and never sets independence (`NOT_VERIFIED` stays).

Opening: `/3` is created fresh; a `/2` file is **refused with `SCHEMA_MIGRATION_REQUIRED`** (never migrated implicitly)
and converted only by the explicit `migrateConformanceStore(path)` — one IMMEDIATE transaction that first verifies the
exact `/2` schema (tampered → refused), then adds the table and triggers, replaces the two guarded triggers, records the
LEGACY events and bumps the version. Running it twice is refused (`ALREADY_CURRENT`); an interrupted run rolls back
whole. Old code opening a `/3` file refuses it (schema differs). No row of any existing table is rewritten.

### Independent review of the remediation (fresh read-only AI reviewer; not an accredited audit)

No P0. Dispositions:

| Id | Finding | Disposition |
|---|---|---|
| C-1 (P1) | the "follow-up already in flight" skip matched any integration's job, so one tenant's job could suppress another's dispute (the P1-2 harm across tenants) | **Fixed**: scoped to the same organization and integration digest. Regression test |
| C-2 (P2) | P1-1 stopped assignments but a successor generation could keep *voting* until a sync | **Fixed in the authoritative store**: the VALIDATOR_CONFLICT quarantine and `quarantineValidator` now quarantine the whole lineage (`<base>.k<n>`, same operator, requested at or before the event) in the same transaction; a later two-person REINSTATE successor is unaffected. Regression test (k2's pending challenge is refused at acceptance) |
| C-3 (P2) | operator decisions used a clock-filtered view; a small clock regression could skip the authoritative quarantine and let reinstatement adopt without humans | **Fixed**: decided on the latest event by sequence; protective events are stamped no earlier than the latest event. Regression test |
| C-4 (P2) | a follow-up whose job expired/cancelled/failed was suppressed forever by its deterministic key | **Fixed**: bounded re-scheduling under an attempt suffix (max 8). Regression test |
| C-5 (P3) | while an operator is quarantined, a contradicting second observation is refused without the VALIDATOR_CONFLICT quarantine | **Accepted, documented**: its evidence stays excluded while the operator is ineligible; reinstating an operator is a two-person decision that should review its validators |
| C-6 (P3) | same-millisecond prefix orderings could still look tampered | **Fixed** (every same-millisecond prefix is tested). Unit regression |
| C-7 (P3) | the LEGACY marker could predate a /2 row accepted later than the migration clock | **Fixed** (`at = max(now, max accepted_at_ms)`); `busy_timeout` set. Historical-data regression added (below) |
| C-8 (P3) | planner chronology omits `revalidationSince` and the engine's period-start read | **Accepted** (liveness only; can only under-schedule relative to the engine, never grant) |
| C-9 (P3) | a TEST-ONLY migration fixture is exported from the store module | **Accepted** (named and documented TEST-ONLY; the module is not exported outside itself) |
| S-1 (P2, speculative) | a credential created later on the probation fixture would count finished probation evidence | **Residual, pre-activation gate**: needs a lifecycle-level reservation of requalification integrations (RN-CONFORM-02 change); today the fixture belongs to the validator network organization and is never credentialed by the federation |
| S-2..S-4 (P3) | operator approvals not re-authenticated after insert (raw writer); LEGACY insertable as a first event; re-approving a LEGACY operator restores its /2-era evidence | **Accepted, documented** (raw-writer residual as for validator enrollment; LEGACY grants nothing; re-approval is a two-person decision) |

### P2-3 pre-activation gate (unchanged, mandatory)

Before any externally reachable coordinator or validator network exists, challenge issuance and acceptance must
enforce testing authorization and eligible-operator policy at their authoritative trust boundaries. Today the
coordinator is reachable only inside `src/enterprise/conformance/` and its tests (structure test; no package export,
no Host route; `conformance-status-local/server.ts` imports only `status-http.js`). This remediation adds no new
import path.

### Historical migration regression (real `/2` data)

CI job `rn-conform-05-v2-migration` checks out and builds the **historical** code (RN-CONFORM-04 merge
`e47582dd`, schema `rn.conformance.store/2`) and generates the fixture through its own insertion paths
(`scripts/conformance/rn-conform-05-v2-fixture.mjs`: the historical RN-CONFORM-02 circuit — three synthetic operators,
two-person validator enrollment, signed challenges, evidence custody, 22 signed observations from two operators
(11 each), two committed evaluations, a two-person issuance, then a key revocation of `validator-b` after acceptance).
The historical code itself verified the fixture before migration (history valid at state version 2, head
`sha256:81988ebe…f136`; every observation re-authenticated). The current code
(`conformance-migration-historical.test.ts`) then shows:
- an interrupted migration leaves the file byte-identical (every table digest and the schema), still refused as `/2`;
- the explicit migration changes no row of any `/2` table and no `/2` schema object except the two replaced
  operator-gated triggers; a second run is refused (`ALREADY_CURRENT`);
- every historical observation keeps its digest, attribution, challenge and acceptance time and re-authenticates
  (not treated as tampered); the signed history verifies with identical transition and evaluation digests; the
  protective key revocation is preserved;
- LEGACY operators get no new validator (`OPERATOR_NOT_ELIGIBLE`), no challenge (`VALIDATOR_NOT_ELIGIBLE`) and no
  accepted observation (`OPERATOR_NOT_ELIGIBLE`); in a new evaluation every historical validator is excluded, nothing
  is reported as tampered and no validator-backed critical requirement is VERIFIED_SUCCESS;
- historical decision ids remain single-use after the migration (a new approval reusing them is `ALREADY_CONSUMED`);
- a later operator approval and quarantine change neither historical verification nor attribution;
- all of it again after closing and reopening the store.

The suite is skipped in `validate` (no historical fixture there) and is never faked from `/3` code.

