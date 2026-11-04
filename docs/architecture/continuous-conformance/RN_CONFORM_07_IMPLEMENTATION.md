# RN-CONFORM-07 — Authoritative Testing Authorization & Evidence Purpose Isolation

**Status:** implemented, synthetic only, **not merged**. Closes RN-CONFORM-05 findings **P2-3** (the coordinator
issued challenges without independently enforcing testing authorization) and **S-1** (requalification evidence could
contaminate credential conformance). RN-CONFORM-06 roadmap item **P1-01** (gaps G-01, G-02, the rate/volume part of
G-33).

> Central invariant: no challenge, observation or conformance evaluation gains authority from a testing
> authorization that does not explicitly cover its subject, operation, environment, purpose and validity window. A
> requalification observation never becomes conformance evidence for a credential.

Nothing here authorizes real testing. Every authorization is `environment: 'synthetic'`, `synthetic: true`; the
store's `synthetic = 1` interlocks are unchanged. No network code, no real operator, no real credential, no ledger
transaction, no Fileverse activation, no certification claim. The Founding Assessment NO-GO, `rn.sv@0.1.0` and every
CC-D decision are unchanged. Level 2 stays **NO-GO** (RN-CONFORM-06); this closes one of its twelve P1 items.

## 1. Model (`testing-authorization.ts`)

`rn.conformance.testing-authorization/2` — a closed, canonical record (22 fields, no optional fields, no URL):

| Field group | Fields |
|---|---|
| Identity | `authorizationId` (immutable), `version` (monotonic), `supersedes` (`null` or the revoked predecessor) |
| Subject | `organizationId`, `platformId`, `integrationId`, `integrationVersion`, `integrationDigest`, `profileId`, `profileVersion` (derived from the registered integration, never from the caller) |
| Purpose | `CONFORMANCE` or `VALIDATOR_REQUALIFICATION` — never interchangeable |
| Scope | explicit, sorted, unique, non-empty lists: `fixtureRefs`, `operations`, `challengeTypes` (≤ 64 each; no wildcard; each must be registered by the integration / backed by its profile) |
| Environment | `environment: 'synthetic'` |
| Window | `notBefore`, `notAfter` (≤ 90 days) |
| Limits | `maxChallengesPerHour` (≤ 10 000), `maxConcurrentChallenges` (≤ 1 000), `maxTotalChallenges` (`null` or ≤ 1 000 000) |

Its canonical digest (`conformanceDigest`) is what two humans approve and what the store pins.

**Lifecycle:** PROPOSED (`prepareTestingAuthorization` — nothing stored) → ACTIVE (`authorizeTesting` — stored with two
consumed `testing.authorize` decisions of the integration's own organization) → REVOKED (`revokeTestingAuthorization`
— one protective, terminal event; idempotent; no humans needed because it only restricts). Expiry makes an
authorization ineligible without any event. There is no update, no reactivation, no override flag: a scope change is
a **new** authorization (`supersedes` = the old id, `version` = old + 1, fresh two-person approval) and the old one must
already be revoked (registry check **and** store trigger).

## 2. Store schema `/4` (`sqlite-conformance-store.ts`)

Signed formats are unchanged: challenges, observations, transitions, status assertions and their signing domains and
digests are byte-identical. The binding is a **server-side association** (WP-07 option B):

| Object | Purpose |
|---|---|
| `cc_order` | single-row durable order counter; advances by exactly one (trigger); the source of every sequence below |
| `cc_testing_authorizations` | immutable authorizations; `activated_seq`; trigger checks the integration columns, the order, the version chain (predecessor revoked), two consumed humans (`TWO_HUMANS('testing.authorize', 'authorization:'‖id, digest, …)`), and refuses a requalification authorization on any credentialed integration |
| `cc_authorization_events` | one `REVOKED` row per authorization, `seq` = the order counter at commit (a backdated revocation is refused) |
| `cc_challenge_authorizations` | one row per challenge, inserted **before** the challenge in the same IMMEDIATE transaction: authorization id, digest, purpose, `issued_seq` (or `LEGACY` for pre-`/4` challenges, writable only by the migration) |
| `cc_observation_purposes` | written by an AFTER INSERT trigger on `cc_observations`: purpose and `accepted_seq`; cannot be forged |
| `cc_challenges_authorized` | BEFORE INSERT on `cc_challenges`: organization, integration digest, profile, operation, challenge type, fixture, window and non-revocation must match the associated authorization; quotas (total, per hour, concurrent) and the integration-wide ceiling (10 000/hour) are counted **inside the write transaction** |
| `cc_observations_attributed` (replaced) | additionally refuses an observation whose challenge has no unrevoked, unexpired, non-LEGACY authorization at acceptance |
| `cc_observations_record_violation` (replaced) | records and counts only `CONFORMANCE`-purpose violations |
| `cc_credentials_purpose_reserved` | refuses any credential on an integration that ever had a `VALIDATOR_REQUALIFICATION` authorization |

All five new tables are immutable (no UPDATE/DELETE) with duplicate guards. Open still demands the exact schema.

### Migration `/3` → `/4` (and `/2` → `/3` → `/4`)

`migrateConformanceStore` is still the only path, explicit, one IMMEDIATE transaction for the whole chain:

1. verify the exact `/2` or `/3` schema (tampered or partial state → `CORRUPT`, nothing written);
2. `/2` only: the RN-CONFORM-05 step unchanged, its output checked against `/3` (history preserved);
3. replace the two triggers, create the `/4` objects, `cc_order = 0`;
4. every existing challenge gets a `LEGACY` association and every observation a `LEGACY` purpose;
5. version swap under the meta guard; the result must equal the current schema.

`LEGACY` rows are re-authenticated as historically valid but are **never** eligible for a new evaluation, and a
`LEGACY` challenge never accepts a new observation. **No authorization is granted to a legacy integration**: after
migration nothing can be issued until two humans approve a new authorization. A crash anywhere rolls back to the exact
original file; a second run is `ALREADY_CURRENT`.

## 3. Enforcement points

| Point | Check |
|---|---|
| Coordinator (`coordinator.ts`) | `ChallengeRequest` requires `authorizationId` and `purpose` (no default, no bypass, no test helper bypass). After the existing integration/profile/operation/validator checks: committed authorization exists; purpose, organization, integration digest, profile, operation, challenge type, fixture match exactly; not revoked; `[now, deadline]` inside the window; quota left. Refusals: `AUTHORIZATION_INVALID`, `AUTHORIZATION_REVOKED`, `AUTHORIZATION_WINDOW`, `QUOTA_EXHAUSTED`. The insert is re-checked by the store trigger, so a second coordinator (or a stale one) cannot over-issue. |
| Idempotency | a redispatch must match the request **and** the stored authorization and purpose; it returns the stored challenge and consumes no quota; a different authorization or purpose under the same key is `IDEMPOTENCY_CONFLICT`. A refused request writes nothing. |
| Evidence (`evidence.ts`, step 5b) | independently re-verifies the association, the authorization's digest, purpose and exact scope, expiry (`AUTHORIZATION_EXPIRED`) and revocation (`AUTHORIZATION_REVOKED`); for a stored row, revocation is compared by `accepted_seq < revocation seq` (durable commit order, not milliseconds — a revocation in the same millisecond is ordered correctly). |
| Lifecycle (`lifecycle.ts`) | engine input contains only `CONFORMANCE`-purpose observations; validator exclusion is still computed from every authenticated row. |
| Federation | `TestingAuthorization` is now the authoritative record; `prepareTestingAuthorization`/`authorizeTesting` delegate to the conformance registry and the federation store keeps a mirror; the scheduler refuses a mirror that differs from, or whose authoritative record is revoked; `revokeTesting` revokes the authoritative record. The requalification purpose is renamed `VALIDATOR_REQUALIFICATION` (the job purpose stays `REQUALIFICATION`). A pre-RN-07 federation mirror (`/1` record) has no authoritative record and is therefore refused (fail closed). |

**Revocation semantics (documented decision).** Revocation stops all **new** execution at once: no challenge, no
dispatch (the scheduler refuses the authorization), no new observation for any of its challenges, even ones already
issued. Evidence accepted **before** the revocation commit stays authentic and remains eligible evidence (revocation
withdraws consent to test, it does not retroactively declare past observations false). Open federation jobs under a
revoked authorization fail at dispatch or observation; they are not separately marked cancelled.

## 4. Invariants (WP-11) and where they are tested

| Id | Invariant | Tests |
|---|---|---|
| AUTH-01 | No challenge without a committed authorization; a refusal consumes nothing | `conformance-testing-authorization.test.ts` AUTH-01; demo B |
| AUTH-02 | Purpose, operation, challenge type, fixture, integration covered exactly; no wildcard; only registered scope | AUTH-02; demo C |
| AUTH-03 | Tenant isolation: other organizations can neither use nor approve | AUTH-03 |
| AUTH-04 | Validity window enforced at issuance | AUTH-04; demo E |
| AUTH-05 | Store refuses a challenge without/outside an authorization; LEGACY association only by migration; authorizations and order immutable/forward-only | AUTH-05 |
| AUTH-06 | Revocation stops new challenges and observations; earlier evidence stays auditable; ordering by durable sequence (same millisecond) | AUTH-06; `conformance-evidence.test.ts` 5b; demo D |
| AUTH-07 | No backdated revocation, no forged observation purpose | AUTH-07 |
| AUTH-08 | Scope change only through a new version superseding a revoked authorization; approval binds the exact record; decisions single-use | AUTH-08 |
| AUTH-09 | Two distinct humans of the subject's organization | AUTH-09, AUTH-03 |
| AUTH-10 | Requalification evidence is accepted and auditable but never a violation record | AUTH-10/11; demo G |
| AUTH-11 | An integration that had a requalification authorization can never be credentialed (issuance, ACTIVE eligibility, reinstatement, critical success and status all require a credential) | AUTH-10/11; federation-authority S-1 test; demo G |
| AUTH-12 | Total quota; idempotent redispatch and refusals consume nothing | AUTH-12 |
| AUTH-13 | Per-hour and concurrent limits | AUTH-13 |
| AUTH-14 | Quotas hold across two coordinators on one file and across restart | AUTH-14; demo F |
| AUTH-15 | Limits beyond the synthetic bounds cannot be granted | AUTH-15 |
| AUTH-16 | A requalification authorization is refused on a credentialed integration | AUTH-16 |
| AUTH-17 | Engine input is CONFORMANCE-purpose only | AUTH-17; v2 and v3 historical tests |
| AUTH-18 | No unauthorized issuance path (request without authorization/purpose, or `LEGACY` purpose, is malformed) | AUTH-18 |

Migration: `conformance-migration-v3-historical.test.ts` on a **real `/3` file generated by the historical code**
(main `9ddd66bd`, CI job `rn-conform-07-v3-migration`, generator `scripts/conformance/rn-conform-07-v3-fixture.mjs`):
refusal before migration, interrupted rollback (every table and schema object unchanged), tampered and partial
states refused, no row rewritten, LEGACY associations for every challenge and observation, zero authorizations
granted, history verifies, no new challenge or observation, no LEGACY evidence in engine input, restart. The
RN-CONFORM-05 `/2` historical test now runs the chained `/2` → `/4` migration with the same guarantees.

Demonstration: `conformance-authorization-demo.test.ts`, CI job `rn-conform-07-demo`, report
`rn.conformance.authorization-demo-report/1` + summary, scenarios A (authorized issuance) – H (legacy migration).

## 5. Limits (honest classification)

- **Synthetic only.** Authorizations are records about synthetic fixtures signed by synthetic humans. A real pilot
  still needs P1-08 (the signed pilot agreement as the authorization's source) and every other P1 item.
- **Store-level enforcement is local.** The triggers protect against callers of this module and against raw writers
  who do not drop triggers; a writer with full file access can still drop triggers — the open-time exact-schema check
  then refuses the file. Off-host integrity (backups, external pins) belongs to other roadmap items, not this mission.
- **Quotas are admission limits**, not probe-traffic shaping at the network edge (no network code exists).
- **Same-millisecond ordering** is solved by the order counter for revocation vs. acceptance; time-window checks still
  use the injected clock.
- **AI review only.** The independent review of this PR is an AI review, not an accredited security audit.
