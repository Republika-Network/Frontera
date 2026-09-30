# CORE-06 — Governance Core Qualification

**Milestone:** CORE-06 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9), the gate for **GOVERNANCE CORE STABLE** (§11.1).
**Branch:** `feat/core-06-governance-core-qualification`.
**Baseline:** `main` / `origin/main` @ `c5113cff437a6b729c4b9494541362221965b870` (merge of CORE-07, PR #155). Branch = baseline at start; 0 / 0 ahead / behind; clean tree.
**Status of this document:** evidence. It replaces no test. Every statement that a claim holds names the executable test that fails when it does not.

CORE-06 builds no product capability. It qualifies the mechanisms that CORE-01 … CORE-05, CORE-07 and PROD-01 each verified separately **as one composed security boundary**, on the Host Frontera actually ships. It then asks one question:

> Can any production-capable path cause a protected governed effect, or increase the authority available to cause one, without crossing the deterministic security boundary whose protection is claimed?

For the bounded-grant / governed-action path the answer is **no**, within the scope and residuals stated below. For the rest of the monorepo the question is answered row by row in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`. **8 of 62** effect paths are bounded-grant controlled, and CORE-06 does not widen that path-local claim into a system-wide one.

---

## 1. What was qualified, and how

| Evidence | What it proves | Where |
|---|---|---|
| **Integrated Host suite** — 25 tests on one canonical Host | Q1 … Q20 and the exercise-time windows through `bootEnterpriseHost()` (production profile) and `POST /api/governed-actions`. The adapter call count is asserted on every case | `src/enterprise/__tests__/core06-governance-core-qualification-host.test.ts` |
| **Structural suite** — 24 tests | INTEL independence (import closure, 43 CORE directories, manifests); no side door in the Host's embedding options or HTTP surface; the five emergency checkpoints and their order; BLOCKED-matrix coverage; effect-path count consistency | `src/enterprise/__tests__/core06-qualification-structure.test.ts` |
| **BLOCKED-claim evidence** — 10 + 20 tests | The nine BLOCKED rows the audit found with no runtime evidence: crash after acknowledgement (SIGKILLed writer), a failure partway through revocation, exercise racing revocation, concurrent durable issuance, a locked database, and a same-sequence fork under a running approval store | `src/enterprise/__tests__/core06-blocked-claim-evidence.test.ts`; Agent Passport Web rows C, P and the blocked halves of F, T, V: `apps/agent-passport-web/__tests__/apw-tenant-binding-blocked-claims.test.ts` (14), `apw-partial-blocked-claims.test.ts` (6) |
| **Existing suites, re-run and reused** | CORE-01 … CORE-05, CORE-07, PROD-01, CTRL-01, P7 … P12 — see §11 | named per row in §6 |
| **Mutations** | Each protection that CORE-06 relies on was removed once, and it was checked that a named test fails — §9 | — |

---

## 2. The canonical Host, as composed

Derived from source (`scripts/run-enterprise-host.mjs` → `bootEnterpriseHost()` → `toCreateEnterpriseOptions()` → `createEnterpriseServer()` / `createEnterprise()`). Nothing here is hypothetical.

**Secure profile (`AOC_ENTERPRISE_ENV=production|staging`).** The Host refuses to start unless all of the following hold:

- SQLite persistence and required authentication;
- a governed-action file, and Kernel Authority required;
- an authority signer (`software` or `external`);
- an external authority-state witness (CORE-07), checked at load (`host-configuration.ts`).

After composition, and before any socket is bound, it also requires this posture: `persistence: durable`, `authentication: required`, `governedActions: composed`, `authorityStore: authenticated-durable`, `kernelAuthority: composed`, `emergencyControl: composed`, `exerciseControls: composed` and `authorityFreshness: external`. Approvals and obligations must be durable or not configured, never ephemeral (`enterprise-host.ts` `secureProfileShortfalls`). Under external custody the real process environment must hold no authority key (CORE-02R).

**Mandatory with a governed-action file:**

- customer identity admission;
- the grant-aware Kernel, over the durable Kernel-Authority world;
- the authenticated bounded-grant store;
- the orchestrator and P11 outcomes;
- P7 exercise controls, including exercise-time lineage (CORE-04) and P10 ceilings;
- durable emergency control, with one reader shared by five checkpoints;
- the trusted adapter registry, routed by the file's table.

**Optional or capability-gated:**

- Governance Profiles and obligations, from the file;
- the Trusted Context Boundary, which needs the file's `trustedContext`, an in-process `contextProvider` and a `policyPackProvider`;
- durable approvals, composed when a profile declares `approval`;
- the CTRL-01 administration API, mounted only when `administrators` are configured.

**Embedding options.** `bootEnterpriseHost()` accepts exactly `env`, `executionAdapters` (members of the one registry, reachable only through a configured route), `contextProvider` (candidate observations, each admitted or refused by the boundary), `policyPackProvider` and `logger`. It forwards **no** Kernel, provider set, store, signer, freshness boundary or source revalidator (`core06-qualification-structure.test.ts` §23; SEC-INV-178).

**Secure Host versus lenient embedding.** `createEnterprise()` called directly is an embedding. It may run on memory stores, with no authentication (loopback only on the Host), no witness, and a supplied Kernel, stores or adapter. None of the secure-profile guarantees applies to it. CORE-06 qualifies the Host.

**The governed chain, in current-source order** (`POST /api/governed-actions`):

1. Customer admission: credential, organization binding, external subject → actor binding (`admission-service.ts`).
2. `boundScopeOf` re-check, then closed intent validation with the **server-resolved** effective Governance Profile (`intent.ts`). The caller may pin the profile, never choose it.
3. Server-derived request id and idempotency resolution.
4. Kernel evaluation: Trusted Context Boundary → obligations → recognition, policy, preflight → governed authority, context, obligation and grant steps (`AocKernel.ts`).
5. Governance Store commit, then re-read and verify (`decision-commit.ts`).
6. The Kernel status is restated, never reinterpreted. Replay of a recorded execution comes before any mutable gate.
7. **Approval gate** (CORE-05).
8. **Emergency checkpoint 1** (admission).
9. Grant terms, capped at context validity and approval validity.
10. **Obligations re-read** from the discharge store (CORE-04).
11. **Issuance:** grant-aware check, approval resume, authority binding, P10. Inside the signed, freshness-anchored store transaction: **emergency checkpoint 2**, then source revalidation and binding re-resolution.
12. Exercise pre-assessment.
13. **Approval re-assessment**, digest-identical.
14. P11 preparation, then the **durable write-ahead claim**.
15. Exercise gate:
    - authoritative grant read #1 and containment;
    - **emergency checkpoint 3**;
    - P7 admission: **lineage revalidation (CORE-04) / P10** and the durable reservation;
    - grant read #2 and containment;
    - binding revalidation;
    - **emergency checkpoint 4** (`grant-execution-service.ts`).
16. Registry: route selection (no route → failure, no child), then **emergency checkpoint 5** (adapter-scoped), then **exactly one** child `execute` (`execution-adapter-registry.ts`).
17. Reservation finalize, P11 terminal observation, outcome.

The diagram in the CORE-06 brief matches this order, with two refinements from source. Emergency control is consulted **five** times, not once, and the durable claim precedes the exercise gate's reservation, not the reverse. The ordering is pinned by `core06-qualification-structure.test.ts` §32.

**Deliberately bounded rather than re-read** (recorded, not claimed as re-checked at exercise):

- **Obligations** are re-read at issuance only. A verified discharge is terminal in obligation-runtime: a later `refused` observation attaches provenance and moves nothing (`obligation-lifecycle-service.ts`). So there is no "discharge withdrawn after issuance" state to race (T4 is not applicable).
- **Approvals** are re-assessed before the claim, not inside the exercise gate. The gap to the adapter is the P11 preparation, the claim and the exercise gate, and it is bounded by the grant's expiry, which is capped at the approval's `notAfter`. The in-process `authorityControlledExecution.exercise()` (TCB) does not consult approvals.
- **Trusted context** is not re-fetched at exercise. The grant's expiry is capped at the earliest material fact's staleness, so a stale fact cannot be exercised on (OQ-5, CORE-04).
- **Authority** for non-financial actions is not re-checked live at issuance: a revocation between the decision and the grant still mints the grant. It is caught at exercise by lineage revalidation (T1 → exercise withheld). Financial actions are re-checked at issuance and at commit by P10.

---

## 3. Effect-path inventory — re-enumerated from source

The inventory was rebuilt from `src/**`, `packages/**`, `apps/**`, `scripts/**` and `.github/workflows/**` by following every candidate to its effect site. The document's own totals were not the starting point.

- **Current count: 62 production-capable effect paths, EP-001 … EP-062. 8 of 62 are bounded-grant controlled** (EP-011, EP-012, EP-013, EP-049 … EP-053). This is unchanged in the numerator.
- **Added: EP-058 … EP-062.** Each is a real path that no inventory named:
  - EP-058, obligation discharge recording (CORE-04);
  - EP-059, the durable approval commands (CORE-05);
  - EP-060, the reference external signer, a separate process;
  - EP-061, the reference authority-state witness, a separate process, with the enrollment ceremony;
  - EP-062, the **CTRL-01 administration HTTP entry** onto EP-013, EP-021 (revocation only), EP-047 and EP-048.

  All five are DEPLOYMENT-GATED, and none is bounded-grant controlled.
- **Removed: none. Renumbered: none. Reclassified: none.**
- **Stale current-state statements corrected:**
  - "Fifty-five production-capable effect paths" → sixty-two.
  - §2.2 "(Three: EP-011, EP-012, EP-013.)" → eight.
  - §4.2 "the outbound surface is two SDKs" → two SDKs plus three Frontera transports (EP-050, EP-056, EP-057).
  - §4.2 child-process scripts: one → eight.
  - EP-009's default bind: `0.0.0.0` → `127.0.0.1`.
  - EP-013, EP-021, EP-047 and EP-048 claimed "no route" while CTRL-01 routes them; they now name EP-062.
  - EP-023 still said "no caller identity" after NB-008 was closed by CORE-03.
  - EP-025 is now labelled the legacy `ApprovalRuntime`.
  - §15.1's two stale rows (see §6).
  - §18.1 claim 5 said "exactly one" adapter call site (there are two: the gate and the registry's single child call behind it); claim 10 omitted EP-056 and EP-057.
  - §19 and the Master Plan §3.1 row said "3 of 46".
  - SECURITY_INVARIANTS §5 and §8 item 3 said "fifty-seven".
- **Historical statements kept:** the dated milestone paragraphs in NO_BYPASS §5.11, the CHANGELOG and the Master Plan status lines state the count *at that milestone*. They were left as history.
- **Drift guard:** `core06-qualification-structure.test.ts` §42 fails if any current-state count in NO_BYPASS, SECURITY_INVARIANTS, the Master Plan or this document differs from §5.11. The existing `no-bypass-effect-paths.test.ts` still pins contiguity, the totals and the network and SDK sites. A new outbound site fails it (mutation M23).

---

## 4. Bounded-grant no-bypass — re-run on the composed Host

**Protected resource:** the provider effect of a governed action, i.e. whatever the one routed `ExecutionAdapter` does (the Generic HTTP adapter's request, EP-050, or an embedder's registry member).

**Entry points:**

- the customer route `POST /api/governed-actions` (EP-049);
- in process, `AocEnterprise.governAction()` and the legacy `authorityControlledExecution.{authorize, exercise}`. Both are trusted in-process code, and the second reaches the same exercise gate without customer admission or a Governance Record.

There is no other route. SEC-INV-178 pins the absence of issue, provision, un-revoke, force, reset, debug and approval routes.

**Effect site:** exactly **two** production call sites invoke an adapter, and neither is a bypass:

- `grant-execution-service.ts` `await adapter.execute(action)` is the top-level gate. The authoritative re-read, the usable-assessment gate, P7 and checkpoints 3 and 4 precede it in the same function.
- `execution-adapter-registry.ts` `await childAdapter.execute(action)` is registry routing. It is reachable only as the gate's adapter, and invokes at most one child after route selection and checkpoint 5.

The registry holds no Kernel, store, policy, grant writer, approval writer or discharge writer. `packages/provider-conformance-suite`'s `harness.execute` is a certification harness in a private package, not an `ExecutionAdapter`.

**Alternate-path scans (all clean):**

- adapter call sites repository-wide;
- holders of the `ExecutionAdapter` port;
- network client modules, and outbound network I/O (exactly EP-050, EP-056, EP-057);
- Pinata (one site) and Stripe (four, Agent Passport Web);
- no `eval`, `new Function`, `vm`, `Worker`, wallet, chain, RPC or server-side `fetch` in `src/` or `packages/`;
- `child_process` in operator scripts only.

These are held by `no-bypass-effect-paths.test.ts`, `security-invariants.test.ts` and `core06-qualification-structure.test.ts`. A third call site fails them (mutations M1, M17).

**Result: PROVEN — PATH LOCAL, re-run on the composed default Host** (§11.1 item 8). Scope and non-guarantees are unchanged from NO_BYPASS §6.4. In-process Host code that holds the adapter object, the stores, `AocEnterprise` or its `kernelProviders` is inside the TCB. `AocKernel.enforce()`, Sovereign Access, Content Protection, the raw Pinata client, Stripe, issuer signing and operator tooling keep their own classifications (EXCEPTED / PARTIALLY BOUND / DEPLOYMENT-GATED).

---

## 5. Authority-write inventory

Every production writer that can change a later authority decision on the governed path. **Direction:** R = restrictive only, N = neutral, P = potentially permitting.

| Writer | Dir. | Caller / surface | Identity | Tenant | Durable / signed / fresh | Evidence that no alternate writer exists |
|---|---|---|---|---|---|---|
| Kernel Authority provisioning (EP-021) | **P** | in-process `kernelAuthorityProvisioning` | `{system, operator}` enforced **in the store** | yes | SQLite, digest-chained; **not signed, not witnessed** (PROD-01 residual) | `kernel-authority-*` suites; no provisioning route (SEC-INV-178) |
| Kernel Authority revocation (EP-021 via EP-062) | R | in process; administrator over HTTP | server-derived operator | yes | as above | `authority-administration-api.test.ts` |
| Policy-pack writes (EP-023) | **P** | in process, via the composed `policyPackProvider` | recorded writer context (NB-008 closed) | no | in memory | `policy-pack-writer-nb008.test.ts`; no route |
| Governance Profile / trusted-source / obligation-source configuration | **P** | the governed-action file, at boot | file/environment trust (AA-002) | the file's org | strictly parsed; not signed | host boot-refusal suites; no route |
| Bounded-grant issuance (EP-012) | **P** | only from a committed, verified Kernel decision | n/a — derived | grant bound | signed, witnessed | `governed-action-orchestrator`, `issuance-core` suites; SEC-INV-027 |
| Bounded-grant revocation (EP-013 via EP-062) | R | in process; administrator over HTTP | server-derived operator | yes | signed, witnessed | `authority-administration-api`, `revocation-state-integrity` |
| Emergency activate (EP-047) | R | in process; administrator over HTTP | server-derived issuer | scope | SQLite, digest-chained, not signed | `emergency-control-*`, `authority-administration-api` |
| **Emergency release (EP-048)** | **P** | in process; **administrator over HTTP** — the one permitting HTTP authority write | administrator credential, disjoint from customer keys (customer → 403) | scope | as above: a raw-database writer can also clear a stop (`AOC_EMERGENCY_CONTROL.md` §8) | `authority-administration-api.test.ts` ("an ordinary caller cannot resume execution") |
| P7 reserve (EP-051) / settle (EP-052) | R / N | only inside the exercise gate | n/a | yes | SQLite, digest-chained | `exercise-control-*` |
| **P7 release (EP-053)** | **P** | only the gate's single finalization exit (failed or withheld) | n/a | yes | as above | SEC-INV-073; `execution-exercise-control` |
| **P12 resolution row (EP-055)** | **P** (`confirmed-not-completed`) | trusted in-process reconciliation only | bound resolution authority | yes | SQLite | `execution-reconciliation` suites |
| **Obligation discharge (EP-058)** | **P** | in-process `obligationDischarges` | trusted writer context; only an `independent` registered source releases | yes | signed, witnessed | `governed-action-obligations-host`; Q10 here; mutation M20 |
| **Approval commands (EP-059)** | **P** (`approve`) / R | in-process `approvals` | authenticated command context; live approver authority, SOD and quorum re-resolved at submission and use | yes | signed, witnessed | `governed-action-approvals-host`; Q11 / Q12 here; no route |
| Freshness enrollment (EP-061 ceremony) | N / R | operator script, explicit attestation | self-declared operator | slot | the witness | `authority-state-freshness-enrollment` |
| API keys / customer principals / administrators | **P** | environment and file at boot | deployment secret (AA-002) | bound | not signed | `customer-identity-*`, CTRL-01 suites |

**Permitting-direction review.** No potentially-permitting writer is reachable by an unauthenticated or customer caller. The only permitting write reachable over HTTP is emergency release, which requires the administrator credential. Q2 and M14 / M19 / M20 show that a customer cannot name a grant, approval, discharge, profile, adapter or destination. Every other permitting writer is in-process (SEC-TRUST-001) or boot configuration (AA-002). These are the residuals of §10, not closures.

---

## 6. BLOCKED-claim coverage matrix (§11.1 item 9)

**116 BLOCKED-bearing rows** across:

- THREAT_MODEL_V1: 48 (§7.16a 9, §7.16b 10, §7.16d 18, §7.16e 11; the addendum has none);
- AUTHORITATIVE_GRANT_STORE §5: 26;
- AUTHORITY_ARTIFACT_AUTHENTICITY §20: 29;
- NO_BYPASS §15.1: 3;
- AGENT_PASSPORT_WEB_THREAT_MODEL §18: 10.

| Status | Rows |
|---|---|
| PROVEN | 86 |
| PROVEN (CONDITIONAL) — the disposition carries a condition (external witness, external custody, loopback, canonical Host, database-only writer …) and the evidence proves it under that condition. The weaker-mode caveat is kept verbatim | 14 |
| PARTIAL AS DOCUMENTED — PARTIALLY BLOCKED rows whose blocked half is tested | 16 |
| MISSING TEST / STALE CLAIM / OVERCLAIMED / exempted as not applicable | **0** |

**Scope of item 9.** Master Plan §11.1 item 9 reads, verbatim, *"Every "BLOCKED" security claim has a test."* It carries no scope qualifier, and only the milestone's *definition* line speaks of the core. The coverage requirement is therefore applied to **every** BLOCKED-bearing row in the repository's security documents, the Agent Passport Web threat model included. No row is exempted as "not applicable to CORE-06". (The first draft of this qualification did exempt APW rows C and P, which rested on audit evidence only. That reading was not supported by the wording, and it is withdrawn.)

**Resolved by CORE-06:**

- **Nine rows had no runtime evidence**, and CORE-06 added tests for them:
  - AGS B / D and TM §7.16a row 1: crash right after acknowledgement, tested with a SIGKILLed writer process, plus a WAL / `synchronous = FULL` pin for the power-loss half;
  - AGS C: a failure inside the revocation transaction rolls row, link and commitment back together;
  - AGS Q: exercise racing a revocation;
  - AGS S: concurrent durable issuance, with one and with two writers;
  - AGS W and TM §7.16a row 8: a locked database;
  - TM §7.16e same-sequence fork: at runtime under a running **approval** store. It was only lexically pinned before. The fork is in the permitting direction (rejected → approved), and it is refused; `assess` answers `withheld: unavailable`.
- **Two rows were stale** and are now reworded to current code. NB §15.1 "modify revocation state" no longer describes only the in-memory `Map`. NB §15.1 "modify trusted authority databases" now separates the signed stores from the digest-only ones.
- **One row was overclaimed and is narrowed:** TM §7.16a row 8 and AGS W, "locked". Measured: under WAL, a held write lock does **not** block readers. Exercise therefore reads the last committed authoritative state (a committed revocation stays in force), while writes are refused and never acknowledged. "Exercise withholds when locked" was not true, and the wording now says what is.

- **Agent Passport Web: two BLOCKED rows and four PARTIALLY BLOCKED rows had no executable evidence**, and CORE-06 added it (`apps/agent-passport-web/__tests__/apw-tenant-binding-blocked-claims.test.ts`, 14 tests; `apw-partial-blocked-claims.test.ts`, 6 tests). None of the tests changes the application.
  - **Row C** (another tenant's id in body, query or path), at runtime over the real gates:
    - a member of A naming B is refused, because membership is keyed by `(registryId, accountId)`;
    - A's admin token is refused against B's own hash, in the query or at the verifier;
    - query parameters naming A cannot override the path B;
    - A's export id cannot be downloaded through B;
    - A's token cannot rotate B's credential.

    Structurally, over every route (the Next.js routes are not compiled by the app's test harness): exactly four routes read a registry id from the body or query (`account/signup`, `account/claim-registry`, `agent-passports`, `organization-registry/recover`), and each binds it to a credential verified against **that** registry's own hash. Every route under `/organization-registry/[registryId]` passes the path id through a registry gate.
  - **Row P** (a valid Stripe event applied to the wrong tenant), at runtime over the real lifecycle handler. Tenant resolution is Frontera's stored subscription id, then its stored customer id:
    - event metadata naming A cannot redirect B's subscription event;
    - a subscription of A billed to B's customer applies to A;
    - an invoice of B's subscription never touches A;
    - an unlinked event changes no linked registry.

    Structurally, the webhook's checkout branch takes the tenant only from the purchase its session id names. **Stated precisely rather than widened:** event metadata `registry_id` is consulted only when Frontera holds *no* link for the subscription or the customer. That metadata is Stripe-account data Frontera never sets, and no customer surface sets it.
  - **Blocked halves of the PARTIALLY BLOCKED rows:**
    - **T:** a viewer presenting the owner-equivalent admin token for an owner-only permission is denied, never escalated.
    - **V:** every session cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` in production.
    - **F:** no page, component, layout or stylesheet loads a subresource from another origin.
    - **G:** entitlement capacity and single-use purchases (existing tests).

    The unblocked halves (APW-002 and APW-005, among others) stay exactly as the threat model states them.
  - **Non-vacuity:** 12 mutations, all killed (§9).

The matrix is machine-checked by `core06-qualification-structure.test.ts` §16–§18. The check asserts that:

- every THREAT_MODEL_V1 BLOCKED row is present, with its disposition verbatim;
- every Agent Passport Web §18 BLOCKED-bearing row is present, with its disposition verbatim;
- every row names at least one test file that exists, containing the named title;
- no row is MISSING, STALE, OVERCLAIMED or exempted as not applicable.

Mutations M24 and M24b–e each fail the check: removing one row's evidence, dropping a Threat Model row, replacing an APW row's evidence with audit prose, re-exempting an APW row, or dropping an APW row.

**Appended by CORE-08 (2026-09-30).** The ledger stays repository-wide: the thirteen BLOCKED rows CORE-08 added to THREAT_MODEL_V1 §7.24 are rows `TM-7.24-1` … `TM-7.24-13` below, each with named executable evidence (`docs/security/CORE-08-ACTION-NEUTRALITY-QUALIFICATION.md`). The CORE-06 verdict and its 116-row count describe the ledger as CORE-06 closed it.

<!-- core06:blocked-matrix:start -->

| ID | Src | Threat | Disposition | Status | Evidence |
|---|---|---|---|---|---|
| TM-7.16a-1 | TM | Crash or restart loses an **acknowledged revocation** while keeping its grant | **BLOCKED** | PROVEN | `core06-blocked-claim-evidence.test.ts` › “an acknowledged revocation survives the writer being SIGKILLed”; `core06-blocked-claim-evidence.test.ts` › “the store opens its connection in WAL with synchronous = FULL”; `core06-blocked-claim-evidence.test.ts` › “the revocation row, the grant link and the commitment roll back together”; `bounded-grant-store-durability.test.ts` › “a committed revocation survives a restart — the half that must never be lost”; `bounded-grant-store-durability.test.ts` › “a restart never increases authority: a revoked grant is still unusable to the execution path”; `bounded-grant-store-durability.test.ts` › “revocation is never reported as successful without a committed record” |
| TM-7.16a-2 | TM | Crash during issuance leaves a partially usable grant | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “a commit guard that throws leaves the database untouched — the transaction rolls back”; `bounded-grant-store-durability.test.ts` › “a refused commit guard writes no grant, and the refusal is not a partial issuance”; `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down” |
| TM-7.16a-3 | TM | Restart increases authority | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “a restart never increases authority: a revoked grant is still unusable to the execution path”; `bounded-grant-store-durability.test.ts` › “a grant revoked before re-issuance is precluded, and stays precluded across a restart”; `revocation-state-integrity.test.ts` › “L. a revoked grant stays revoked across restarts, and tampering after a restart still fails closed” |
| TM-7.16a-4 | TM | Corrupt grant or revocation record yields a usable grant | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired”; `bounded-grant-store-durability.test.ts` › “a grant record whose bytes are not canonical is refused rather than normalized”; `bounded-grant-store-durability.test.ts` › “a mutated revocation record is refused — the grant does not become usable again”; `bounded-grant-store-durability.test.ts` › “a revocation carrying a reason outside the closed vocabulary is refused”; `bounded-grant-store-durability.test.ts` › “an exercise against corrupt state withholds rather than raising”; `authority-artifact-authenticity.test.ts` › “digest failures are still reported as corruption, and are still checked before the signature” |
| TM-7.16a-5 | TM | **Partial** deletion — the revocation row removed, or the grant's reference to it cleared | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “DELETING the revocation row does not restore authority — the grant stops being readable”; `bounded-grant-store-durability.test.ts` › “CLEARING the grant’s reference to its revocation does not restore authority either”; `revocation-state-integrity.test.ts` › “C. deleting the revocation row fails closed, and execution stays withheld”; `revocation-state-integrity.test.ts` › “D. clearing the grant’s pointer alone fails closed, and execution stays withheld” |
| TM-7.16a-6 | TM | A writer rewrites a record **and** recomputes its unkeyed digest | **BLOCKED as of Prompt 5** for a writer with database access only — see §7.16b. Still **NOT ADDRESSED** for a writer who also holds the signing key or the key configuration | PROVEN (CONDITIONAL) | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too”; `authority-artifact-authenticity.test.ts` › “a revocation altered and re-digested is refused — the signed revocation-state commitment no longer describes it”; database-only writer; the key-holder half is a stated NOT ADDRESSED |
| TM-7.16a-7 | TM | **Restoring an older snapshot restores revoked authority** | **BLOCKED with an external freshness witness** (CORE-07, §7.16e); **NOT ADDRESSED** without one | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls”; `revocation-state-integrity.test.ts` › “a full restore of an earlier authentic state IS detected by a restarted process with a freshness witness”; `revocation-state-integrity.test.ts` › “SCOPED (CORE-07): without a freshness witness, anti-rollback across a restart is NOT claimed — the restored state is believed”; `authority-state-freshness-host.test.ts` › “the same restored files under a Host with no witness are believed — anti-rollback is not claimed without CORE-07 freshness”; the no-witness half is pinned as not claimed |
| TM-7.16a-8 | TM | Store unavailable, locked, or closed | **BLOCKED (fails closed)** | PROVEN | `core06-blocked-claim-evidence.test.ts` › “while another connection holds the write lock: revocation and issuance are refused and never acknowledged”; `core06-blocked-claim-evidence.test.ts` › “a store that cannot answer a read — here, closed — withholds: the adapter is not called”; `bounded-grant-store-durability.test.ts` › “an exercise against an unavailable store withholds, and the adapter is not called”; `bounded-grant-store-durability.test.ts` › “a closed store refuses every operation rather than answering from anywhere else” |
| TM-7.16a-9 | TM | Foreign schema version, at database or row level | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “a database recorded under a foreign schema version is not opened at all, and is not mutated by the attempt”; `bounded-grant-store-durability.test.ts` › “a record written under an unrecognized schema version is refused, never reinterpreted” |
| TM-7.16b-1 | TM | DB-only record mutation with **every** unkeyed digest recomputed | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too”; `authority-artifact-authenticity.test.ts` › “a revocation altered and re-digested is refused — the signed revocation-state commitment no longer describes it”; `revocation-state-integrity.test.ts` › “and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it” |
| TM-7.16b-2 | TM | Signature substitution — another grant's, or a revocation's onto a grant | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a valid signature lifted from another grant does not make this row authoritative”; `authority-artifact-authenticity.test.ts` › “a revocation’s signature moved onto its own grant row does not verify”; `authority-artifact-authenticity.test.ts` › “domain separation is in the signed bytes, not only in the JSON shape”; `authority-artifact-authenticity.test.ts` › “the two signing domains differ, and neither is a prefix of the other” |
| TM-7.16b-3 | TM | An artifact signed by an **unknown** key is accepted | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an unknown keyId fails closed, and is reported as such”; `authority-artifact-authenticity.test.ts` › “retiring a key fails closed rather than falling back to another trusted key”; `authority-artifact-authenticity.test.ts` › “an attacker who signs with their own key cannot make it trusted by naming it in the row” |
| TM-7.16b-4 | TM | An artifact **nominates its own** verification key (trust-on-first-use) | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a signature envelope never carries a public key for the verifier to trust”; `authority-artifact-authenticity.test.ts` › “a persisted row carries no key material either — only a key id”; `authority-artifact-authenticity.test.ts` › “an attacker who signs with their own key cannot make it trusted by naming it in the row”; `authority-authenticity-boundaries.test.ts` › “no verification path reads a public key out of the artifact or the signature envelope”; `authority-authenticity-boundaries.test.ts` › “the registry is built from composition-supplied entries and frozen against later mutation” |
| TM-7.16b-5 | TM | An **unsigned** artifact is accepted as legacy | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a missing signature fails closed, and is distinguishable from a bad one”; `revocation-state-integrity.test.ts` › “J. a commitment with its signature removed is refused as MISSING — never trusted as legacy”; `authority-artifact-authenticity.test.ts` › “a row whose signature column is NULL is refused as MISSING, never trusted as legacy”; `authority-artifact-authenticity.test.ts` › “a database written under the previous unsigned schema version is refused at open, not migrated”; `revocation-state-integrity.test.ts` › “a v2 (pre-CORE-01) database is refused at open and not migrated” |
| TM-7.16b-6 | TM | Algorithm confusion / downgrade | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an unsupported algorithm is refused rather than attempted”; `authority-artifact-authenticity.test.ts` › “an unsupported algorithm is refused at composition, not at read time”; `authority-authenticity-boundaries.test.ts` › “the supported-algorithm registry is closed, and nothing tries algorithms until one works” |
| TM-7.16b-7 | TM | Signature truncation or corruption | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a truncated signature is MALFORMED, not merely invalid”; `authority-artifact-authenticity.test.ts` › “malformed signature material fails closed”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too” |
| TM-7.16b-8 | TM | Signer latency racing the commit guard | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “the commit guard still runs after signing and still refuses at the boundary”; `external-authority-signer-stores.test.ts` › “eligibility withdrawn while the signer works: the preflight passed, the signature is spent, and the post-sign commit guard still refuses” |
| TM-7.16b-9 | TM | **Snapshot rollback** | **BLOCKED with an external freshness witness** (CORE-07, §7.16e); **NOT ADDRESSED** without one (narrowed by CORE-01, §7.16c) | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-grants.test.ts` › “G10: a rollback underneath a running store is still refused on the next read”; `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls”; `revocation-state-integrity.test.ts` › “a RUNNING store detects a restore of an earlier, genuinely signed state (in-process freshness witness)”; `revocation-state-integrity.test.ts` › “SCOPED (CORE-07): without a freshness witness, anti-rollback across a restart is NOT claimed — the restored state is believed”; CORE-01 narrowing = in-process floor; no-witness restart half pinned as not claimed |
| TM-7.16b-10 | TM | Signer unavailable during **revocation** | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `external-authority-signer-host.test.ts` › “revocation fails honestly: 503 AUTHORITY_SIGNER_UNAVAILABLE, recorded: false, no row, no head change — the grant stays exercisable”; `authority-artifact-authenticity.test.ts` › “a revocation that cannot be signed is NOT acknowledged, and writes nothing (AA-004)”; `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down”; `external-authority-signer-host.test.ts` › “the one control that does not depend on the signer still works: an emergency stop is recorded during the outage”; the unrecorded revocation / still-exercisable grant is the stated residual (AA-004) |
| TM-7.16d-1 | TM | Read the authority private key from Host memory, configuration or environment | **BLOCKED** (external custody) | PROVEN (CONDITIONAL) | `external-authority-signer-host.test.ts` › “boots in external mode with NO private key anywhere it can see — environment, process environment, full internal configuration”; `external-authority-signer-launcher.test.mjs` › “the shipped launcher runs a production Host under external custody”; `external-authority-signer-configuration.test.ts` › “loadEnterpriseConfiguration in external mode does not read the private key into configuration”; `external-authority-signer-structure.test.ts` › “buildAuthorityAuthenticity: the external branch returns before any private-key parsing, and has no fallback”; external custody only; software custody unchanged (AA-001) |
| TM-7.16d-2 | TM | Operator believes custody is external while the key is still in the environment | **BLOCKED** | PROVEN | `external-authority-signer-configuration.test.ts` › “the strict environment reading refuses every ambiguous or contradictory custody”; `external-authority-signer-configuration.test.ts` › “the secure Host accepts external custody with no private key, and refuses it with one — before anything is composed”; `external-authority-signer-host.test.ts` › “a private key alongside external custody is refused, not ignored”; `external-authority-signer-launcher.test.mjs` › “the same launch with an authority private key added is refused before listen — never ignored” |
| TM-7.16d-3 | TM | Silent fallback to in-process signing on signer outage | **BLOCKED** | PROVEN | `external-authority-signer-configuration.test.ts` › “an unreachable external signer refuses the Host before a single store file exists — and never falls back to a software key”; `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down”; `external-authority-signer-configuration.test.ts` › “a host-supplied grant store signed in-process is refused under external custody”; `external-authority-signer-structure.test.ts` › “the Host refuses an external configuration whose composed signer is not external, in every profile” |
| TM-7.16d-4 | TM | Endpoint substitution (endpoint serves another key) / same key id with other material | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “startup refuses a signer answering as another key, under another algorithm, or with other public material under the same key id”; `external-authority-signer-host.test.ts` › “endpoint substitution (the endpoint serves another key) and verification-registry substitution are refused at startup” |
| TM-7.16d-5 | TM | Verification-registry substitution alone | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “startup refuses a signer answering as another key, under another algorithm, or with other public material under the same key id”; `external-authority-signer-host.test.ts` › “endpoint substitution (the endpoint serves another key) and verification-registry substitution are refused at startup” |
| TM-7.16d-6 | TM | Trust-on-first-use of the signer's key | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “no TOFU: the advertised public key is only compared”; `external-authority-signer-structure.test.ts` › “the handshake compares the advertised public key with the pinned one — it never adds or trusts it” |
| TM-7.16d-7 | TM | Malicious signer: attacker-key, other-key, other-artifact, cross-domain, malformed, truncated, other-version signatures | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “cross-domain substitution: a genuine signature from any other operation is refused for every operation”; `external-authority-signer-stores.test.ts` › “discharge and approval appends read their new head back inside the write transaction: an untrusted head signature rolls the append back”; `external-authority-signer-structure.test.ts` › “every returned signature is verified locally, under the pinned key, before it is returned to a store” |
| TM-7.16d-8 | TM | Unannounced key change mid-process (even to a still-trusted key) | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “a still-trusted historical key answering mid-process is refused: rotation is configuration, never an answer from the other side” |
| TM-7.16d-9 | TM | Signer hangs | **BLOCKED** (bounded) | PROVEN | `external-authority-signer-contract.test.ts` › “a hanging signer times out per attempt”; `external-authority-signer-review-hardening.test.ts` › “C2 — unavailable on every attempt: refuses after exactly maxAttempts”; `external-authority-signer-contract.test.ts` › “the adapter refuses nonsensical budgets and a pin outside the trusted registry”; `external-authority-signer-stores.test.ts` › “no transaction callback is async, awaits, or reaches the signer” |
| TM-7.16d-10 | TM | Signer outage during issuance / discharge / approval / genesis | **BLOCKED** (fails closed) | PROVEN | `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down”; `external-authority-signer-stores.test.ts` › “obligation discharges: an append during an outage writes no row and leaves the signed head”; `external-authority-signer-stores.test.ts` › “approvals: a command during an outage writes no row and is not accepted”; `external-authority-signer-stores.test.ts` › “genesis: a new store is never initialized unsigned”; `external-authority-signer-host.test.ts` › “issuance, discharge and approval all fail without writing” |
| TM-7.16d-11 | TM | Signer outage during **revocation** | **PARTIALLY BLOCKED** (AA-004) | PARTIAL AS DOCUMENTED | `external-authority-signer-host.test.ts` › “revocation fails honestly: 503 AUTHORITY_SIGNER_UNAVAILABLE, recorded: false, no row, no head change — the grant stays exercisable”; `external-authority-signer-host.test.ts` › “the one control that does not depend on the signer still works: an emergency stop is recorded during the outage”; `external-authority-signer-host.test.ts` › “the signer returns (same key, same port): the stop still withholds, the revocation commits”; `external-authority-signer-host.test.ts` › “the signer dies: /health degrades (never unhealthy), existing authority still reads and verifies”; the still-exercisable grant is the stated AA-004 residual |
| TM-7.16d-12 | TM | Plain-HTTP interception | **BLOCKED beyond loopback** | PROVEN (CONDITIONAL) | `external-authority-signer-contract.test.ts` › “the transport refuses plain http beyond loopback, credentials in the URL, a path, and a short credential”; `external-authority-signer-configuration.test.ts` › “the strict environment reading refuses every ambiguous or contradictory custody”; loopback http: stays allowed by design |
| TM-7.16d-13 | TM | **External store substitution** (CORE-02R): a supplied grant/obligation/approval store built over another signer, another key under the same id, or a wider verifier, under a Host configured for signer A | **BLOCKED** (composition) | PROVEN | `external-authority-signer-review-hardening.test.ts` › “A1 — configured signer A, supplied external store signed by B: refused, and signer B is never used”; `external-authority-signer-review-hardening.test.ts` › “A2 — same key id, different public key: refused”; `external-authority-signer-review-hardening.test.ts` › “A4 — signer A, but a supplied verifier that also trusts an attacker key”; `external-authority-signer-review-hardening.test.ts` › “obligation and approval stores are pinned the same way” |
| TM-7.16d-14 | TM | **Signer / config / store split-brain** (CORE-02R): configuration says A, runtime signs with B, posture says `external` | **BLOCKED** | PROVEN | `external-authority-signer-review-hardening.test.ts` › “the root-built boundary is the configured one: genesis is signed by the configured signer, and posture reports the established custody”; `external-authority-signer-review-round2.test.ts` › “A7 — no composition that runs ACE under external custody reports a not-composed signer” |
| TM-7.16d-15 | TM | **Identity endpoint healthy while signing is broken** (CORE-02R): `/v1/identity` answers; `/v1/sign/*` is unavailable, hangs or returns signatures that do not verify | **BLOCKED** (truthful health) | PROVEN | `external-authority-signer-review-hardening.test.ts` › “identity probes keep succeeding, and health stays unavailable”; `external-authority-signer-review-hardening.test.ts` › “through repeated successful identity probes → restored → still degraded until a real signature → healthy”; `external-authority-signer-review-hardening.test.ts` › “a successful signature does not clear an identity failure”; `external-authority-signer-structure.test.ts` › “CORE-02R: a signing failure is cleared only by a verified signature — never by an identity probe” |
| TM-7.16d-16 | TM | **Sanitized configuration map hiding a dirty process environment** (CORE-02R): `bootEnterpriseHost({ env: clean })` while `process.env` holds `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` | **BLOCKED** (canonical Host) | PROVEN (CONDITIONAL) | `external-authority-signer-process-env.test.ts` › “dirty process.env + sanitized options.env → refused before composition: nothing opened, no signer contacted, no socket”; `external-authority-signer-process-env.test.ts` › “presence is enough: an empty value is refused too”; `external-authority-signer-process-env.test.ts` › “createEnterprise is the embedding surface: it judges the configuration it is handed”; canonical Host only, as the disposition states |
| TM-7.16d-17 | TM | **Persistence-mode downgrade / split-brain** (CORE-02R review round 2): external custody configured, authority-controlled execution composed, and `persistence.provider = memory` — or a non-SQLite Governance Store while governed actions compose obligations or approvals | **BLOCKED** (composition) | PROVEN | `external-authority-signer-review-round2.test.ts` › “A2 — external + memory + ACE, signer healthy: still refused, and the signer is never contacted”; `external-authority-signer-review-round2.test.ts` › “A7b — the canonical Host (development profile) is refused by the composition root before it listens”; `external-authority-signer-review-round2.test.ts` › “C4 — external + sqlite + governed actions with obligations + supplied memory Governance Store: refused before any store opens”; `external-authority-signer-review-round2.test.ts` › “A8b — the governed Host with approvals declared, under external custody and memory persistence, is refused” |
| TM-7.16d-18 | TM | **Wall-clock rollback of the identity-probe cache** (CORE-02R review round 2): the clock moves backwards after a successful identity probe | **BLOCKED** (signer-health freshness) | PROVEN | `external-authority-signer-review-round2.test.ts` › “B4 — negative age (clock moved backwards): probes immediately, for a 1 ms and a 1 h rollback alike”; `external-authority-signer-review-round2.test.ts` › “B5 — rollback + signer unreachable: the stale ready is not served”; `external-authority-signer-review-round2.test.ts` › “signing failure stays sticky: a rollback-triggered, successful identity probe does not clear it” |
| TM-7.16e-1 | TM | **Full signed snapshot rollback across restart** (any of the three stores) | **BLOCKED** | PROVEN | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-grants.test.ts` › “G3/C5: a restored state with a lower sequence than the witnessed one is a rollback”; `authority-state-freshness-obligations-approvals.test.ts` › “O2: a restored older authenticated head after a restart is refused”; `authority-state-freshness-obligations-approvals.test.ts` › “P2/P3: approved → revoked → the approved prefix restored → restart refused”; `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls” |
| TM-7.16e-2 | TM | **Rollback of revocation state** | **BLOCKED** | PROVEN | `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls”; `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `revocation-state-integrity.test.ts` › “a full restore of an earlier authentic state IS detected by a restarted process with a freshness witness” |
| TM-7.16e-3 | TM | **Rollback of obligation state** | **BLOCKED** | PROVEN | `authority-state-freshness-obligations-approvals.test.ts` › “O2: a restored older authenticated head after a restart is refused”; `obligation-discharge-authenticity.test.ts` › “CORE-07 (inverted from the residual): with a freshness witness, an older genuine signed state restored before a restart is refused” |
| TM-7.16e-4 | TM | **Rollback of approval state** (an approved prefix before a revocation or rejection) | **BLOCKED** | PROVEN | `authority-state-freshness-obligations-approvals.test.ts` › “P2/P3: approved → revoked → the approved prefix restored → restart refused”; `approval-authenticity.test.ts` › “CORE-07 (inverted from the residual): with a freshness witness, the restored approved prefix is refused at restart” |
| TM-7.16e-5 | TM | **Same-sequence fork** (a writer that bypassed the witness commits a different genuine successor) | **BLOCKED** | PROVEN | `core06-blocked-claim-evidence.test.ts` › “a different genuine state at the same sequence, transplanted under the running store, is refused and never reads as approved”; `authority-state-freshness-grants.test.ts` › “R3: a real same-sequence fork underneath the running process is still fatal to it, and stays fatal”; `authority-state-freshness-obligations-approvals.test.ts` › “O8: the in-process witness still refuses a local regression — and now also a different state at the same sequence”; `authority-state-freshness-grants.test.ts` › “G4/C6: the same sequence with a different digest”; `authority-state-freshness-obligations-approvals.test.ts` › “O3: the same sequence with a different chain digest is refused as a fork”; `authority-state-freshness-obligations-approvals.test.ts` › “P4: the same sequence with a different chain digest is refused as a fork” |
| TM-7.16e-6 | TM | **Store / kind / organization substitution** (a different genuine store swapped in; a receipt about another slot) | **BLOCKED** | PROVEN | `authority-state-freshness-grants.test.ts` › “G5: a different genuine store substituted under an occupied slot is refused”; `authority-state-freshness-grants.test.ts` › “G6: a witness receipt for another state kind — even one genuinely signed by the witness — is refused”; `authority-state-freshness-obligations-approvals.test.ts` › “O5: a witness answer about another organization — even an authentic one — is refused”; `authority-state-freshness-obligations-approvals.test.ts` › “P5: another genuine approval store substituted under the slot is refused”; `authority-state-freshness-protocol.test.ts` › “A6/A7: an authentic receipt about another binding — another organization or state kind — is refused” |
| TM-7.16e-7 | TM | **Crash after local commit, before finalize** | **BLOCKED (recovered)** | PROVEN | `authority-state-freshness-grants.test.ts` › “C4: a crash after the local commit and before finalize — witness pending, local exactly that — is finalized at the next start”; `authority-state-freshness-grants.test.ts` › “C4 in-process: a finalize that did not arrive is completed before the next transition”; `authority-state-freshness-obligations-approvals.test.ts` › “O7: crash after prepare → restart is pending-recovery”; `authority-state-freshness-obligations-approvals.test.ts` › “P8: a pending transition that exactly matches the local next state is finalized at restart” |
| TM-7.16e-8 | TM | **Concurrent writers** planning the same successor | **BLOCKED** | PROVEN | `authority-state-freshness-grants.test.ts` › “C7/C8: two writers planning the same successor — exactly one prepare wins”; `authority-state-freshness-protocol.test.ts` › “C7 at the witness: concurrent prepares from the same committed state — exactly one wins” |
| TM-7.16e-9 | TM | **Concurrent writer misread as rollback** — another process advances the store between a probe's (or startup's) witness read and local read | **BLOCKED** (as a false positive) | PROVEN | `authority-state-freshness-grants.test.ts` › “R1: another process completes a revocation between the probe”; `authority-state-freshness-grants.test.ts` › “R2: another process is between prepare and its local commit when the probe runs”; `authority-state-freshness-grants.test.ts` › “R5: a process that starts while another completes a revocation between its local read and its witness read opens”; `authority-state-freshness-grants.test.ts` › “R4: an actually older authentic snapshot restored underneath the running process is still fatal to it” |
| TM-7.16e-10 | TM | **Witness spoofing / replayed receipts** | **BLOCKED** | PROVEN | `authority-state-freshness-protocol.test.ts` › “A4 (after the handshake): a well-formed read receipt claiming a stale state”; `authority-state-freshness-protocol.test.ts` › “a recorded, genuinely signed receipt replayed to a later call is refused (the challenge is per call)”; `authority-state-freshness-protocol.test.ts` › “A1: a witness answering under another identity is refused at the handshake”; `authority-state-freshness-protocol.test.ts` › “A2: the same witness id with different public material is refused” |
| TM-7.16e-11 | TM | **Witness rollback alone** (the witness's database restored behind the store) | **BLOCKED** where the local store is ahead | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G11: a witness itself rolled back behind the local store is refused — the local state is ahead of anything witnessed” |
| AGS-A | AGS | Crash **during** issuance | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a commit guard that throws leaves the database untouched — the transaction rolls back”; `bounded-grant-store-durability.test.ts` › “a refused commit guard writes no grant, and the refusal is not a partial issuance”; `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down” |
| AGS-B | AGS | Crash immediately **after** issuance acknowledgement | BLOCKED | PROVEN | `core06-blocked-claim-evidence.test.ts` › “an acknowledged issuance is readable, field for field, after the writer is SIGKILLed”; `core06-blocked-claim-evidence.test.ts` › “the store opens its connection in WAL with synchronous = FULL”; `bounded-grant-store-durability.test.ts` › “a committed issuance is readable from a freshly opened store (GS-INV-001)” |
| AGS-C | AGS | Crash **during** revocation | BLOCKED | PROVEN | `core06-blocked-claim-evidence.test.ts` › “the revocation row, the grant link and the commitment roll back together”; `revocation-state-integrity.test.ts` › “a revocation is never committed over a state that does not verify” |
| AGS-D | AGS | Crash immediately **after** revocation acknowledgement | BLOCKED | PROVEN | `core06-blocked-claim-evidence.test.ts` › “an acknowledged revocation survives the writer being SIGKILLed”; `core06-blocked-claim-evidence.test.ts` › “the store opens its connection in WAL with synchronous = FULL”; `bounded-grant-store-durability.test.ts` › “a committed revocation survives a restart — the half that must never be lost”; `bounded-grant-store-durability.test.ts` › “a restart never increases authority: a revoked grant is still unusable to the execution path”; `revocation-state-integrity.test.ts` › “L. a revoked grant stays revoked across restarts, and tampering after a restart still fails closed” |
| AGS-E | AGS | Database / file corruption | PARTIALLY BLOCKED | PARTIAL AS DOCUMENTED | `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired”; `bounded-grant-store-durability.test.ts` › “a mutated revocation record is refused — the grant does not become usable again”; `bounded-grant-store-durability.test.ts` › “a record written under an unrecognized schema version is refused, never reinterpreted”; `bounded-grant-store-durability.test.ts` › “an exercise against corrupt state withholds rather than raising”; detection proven; prevention not claimed |
| AGS-F | AGS | Manual row modification by an operator | PARTIALLY BLOCKED | PARTIAL AS DOCUMENTED | `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired”; `bounded-grant-store-durability.test.ts` › “a grant record whose bytes are not canonical is refused rather than normalized”; `revocation-state-integrity.test.ts` › “the append-only triggers stop an ordinary connection”; a casual edit is caught; re-sealing is rows H/L |
| AGS-G | AGS | Attacker modifies a grant but **not** its digest | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired”; `bounded-grant-store-durability.test.ts` › “a grant record whose bytes are not canonical is refused rather than normalized”; `bounded-grant-store-durability.test.ts` › “a mutated revocation record is refused — the grant does not become usable again”; `bounded-grant-store-durability.test.ts` › “a revocation carrying a reason outside the closed vocabulary is refused” |
| AGS-H | AGS | Attacker modifies a grant **and recomputes the unkeyed digest** | **NOT ADDRESSED HERE — BLOCKED BY PROMPT 5** | PROVEN | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too” |
| AGS-I | AGS | Attacker **deletes** the revocation row | BLOCKED (as a partial write) | PROVEN | `bounded-grant-store-durability.test.ts` › “DELETING the revocation row does not restore authority — the grant stops being readable”; `revocation-state-integrity.test.ts` › “C. deleting the revocation row fails closed, and execution stays withheld”; `bounded-grant-store-durability.test.ts` › “an exercise against corrupt state withholds rather than raising” |
| AGS-J | AGS | Attacker clears the grant's reference but leaves the revocation row | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “CLEARING the grant’s reference to its revocation does not restore authority either”; `revocation-state-integrity.test.ts` › “D. clearing the grant’s pointer alone fails closed, and execution stays withheld” |
| AGS-K | AGS | Attacker deletes the **grant** row | BLOCKED (fails closed) | PROVEN | `bounded-grant-store-durability.test.ts` › “a revocation record for a grant that does not exist is refused rather than ignored”; `authority-controlled-execution-scenario.test.ts` › “K. no grant at all means no execution” |
| AGS-L | AGS | Attacker rewrites **both** the revocation row and the grant's reference, consistently — including deleting both | **BLOCKED since CORE-01** for a database-only writer (was NOT ADDRESSED; MASTER-00 showed deletion of both made the grant live) | PROVEN (CONDITIONAL) | `revocation-state-integrity.test.ts` › “E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life”; `revocation-state-integrity.test.ts` › “and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it”; `revocation-state-integrity.test.ts` › “and splice in a genuine genesis commitment from a DIFFERENT store signed by the same key — the store binding refuses it”; `revocation-state-integrity.test.ts` › “removing one of several revocations and renumbering the rest fails closed”; `authority-controlled-execution-scenario.test.ts` › “authorize → revoke → delete the revocation and clear its pointer in SQLite → the production service still withholds”; database-only writer |
| AGS-M | AGS | Duplicate issuance of the same identity | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a re-delivered issuance across a restart resolves to the existing grant rather than a second one”; `grant-transaction-boundary.test.ts` › “duplicate issuance of the same identity produces one grant, not two” |
| AGS-N | AGS | Duplicate revocation | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “the revocation is idempotent across a restart — the first one stands”; `revocation-state-integrity.test.ts` › “M. a repeated identical revocation returns the first, signs nothing, and leaves the commitment unchanged”; `revocation-state-integrity.test.ts` › “concurrent revocations of the SAME grant yield exactly one revoked and one already-revoked”; `authority-artifact-authenticity.test.ts` › “a repeated revocation still returns the FIRST one, and does not re-sign or re-date it” |
| AGS-O | AGS | Replay of a stale database copy | **BLOCKED with an external freshness witness** (CORE-07); not addressed across restart without one | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `revocation-state-integrity.test.ts` › “a full restore of an earlier authentic state IS detected by a restarted process with a freshness witness”; `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls”; `revocation-state-integrity.test.ts` › “a RUNNING store detects a restore of an earlier, genuinely signed state (in-process freshness witness)”; `revocation-state-integrity.test.ts` › “SCOPED (CORE-07): without a freshness witness, anti-rollback across a restart is NOT claimed — the restored state is believed”; no-witness restart half pinned as not claimed |
| AGS-P | AGS | Rollback to an older database snapshot | **BLOCKED with an external freshness witness** (CORE-07); **NOT ADDRESSED** without one, or when the witness is restored with the file | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-grants.test.ts` › “G3/C5: a restored state with a lower sequence than the witnessed one is a rollback”; `authority-state-freshness-grants.test.ts` › “C4 + rollback: after a crash before finalize, restoring the pre-revocation snapshot is still refused”; `authority-state-freshness-host.test.ts` › “issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls”; `authority-state-freshness-host.test.ts` › “a secure profile without a witness is refused by configuration”; `authority-state-freshness-host.test.ts` › “the same restored files under a Host with no witness are believed — anti-rollback is not claimed without CORE-07 freshness”; no-witness half pinned as not claimed; secure Host requires a witness |
| AGS-Q | AGS | Concurrent exercise and revocation (same process) | BLOCKED | PROVEN | `core06-blocked-claim-evidence.test.ts` › “while the revocation is still being signed it is not in force”; `revocation-state-integrity.test.ts` › “concurrent in-process revocations of different grants both commit, in sequence” |
| AGS-R | AGS | Concurrent exercise and revocation (different processes) | PARTIALLY BLOCKED | PARTIAL AS DOCUMENTED | `revocation-state-integrity.test.ts` › “two store instances on one file (separate writers) both commit — a stale plan is re-planned, never committed”; `external-authority-signer-stores.test.ts` › “a revocation planned on state S, signed slowly while another writer commits S+1, is never committed over S”; `authority-state-freshness-grants.test.ts` › “C7/C8: two writers planning the same successor — exactly one prepare wins”; writer serialization proven; cross-process linearizability not claimed (§12) |
| AGS-S | AGS | Concurrent issuance of the same identity | BLOCKED | PROVEN | `core06-blocked-claim-evidence.test.ts` › “two racing issuances — each past its preflight and its signing await — commit one row”; `core06-blocked-claim-evidence.test.ts` › “two store instances on one file racing the same identity also commit exactly one row”; `grant-transaction-boundary.test.ts` › “concurrent-equivalent issuance of one identity resolves to one grant and one already-issued” |
| AGS-T | AGS | Concurrent issuance and a binding change | BLOCKED (unchanged from Prompt 3) | PROVEN | `exercise-control-authority-binding.test.ts` › “the commit-boundary binding comparison is still load-bearing at issuance: a binding that changes between issuance and commit issues nothing”; `authority-artifact-authenticity.test.ts` › “the commit guard still runs after signing and still refuses at the boundary”; `external-authority-signer-stores.test.ts` › “eligibility withdrawn while the signer works: the preflight passed, the signature is spent, and the post-sign commit guard still refuses”; `authority-controlled-execution-scenario.test.ts` › “a mandate shortened between measurement and commit refuses the issuance” |
| AGS-U | AGS | Process restart | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a restart never increases authority: a revoked grant is still unusable to the execution path”; `bounded-grant-store-durability.test.ts` › “a grant revoked before re-issuance is precluded, and stays precluded across a restart”; `revocation-state-integrity.test.ts` › “L. a revoked grant stays revoked across restarts, and tampering after a restart still fails closed” |
| AGS-V | AGS | Store unavailable | BLOCKED (fails closed) | PROVEN | `bounded-grant-store-durability.test.ts` › “an exercise against an unavailable store withholds, and the adapter is not called”; `bounded-grant-store-durability.test.ts` › “a closed store refuses every operation rather than answering from anywhere else”; `bounded-grant-store-durability.test.ts` › “reports itself unhealthy once closed”; `core06-blocked-claim-evidence.test.ts` › “a store that cannot answer a read — here, closed — withholds: the adapter is not called” |
| AGS-W | AGS | Database locked / busy | BLOCKED (fails closed) | PROVEN | `core06-blocked-claim-evidence.test.ts` › “while another connection holds the write lock: revocation and issuance are refused and never acknowledged”; `core06-blocked-claim-evidence.test.ts` › “a store that cannot answer a read — here, closed — withholds: the adapter is not called”; `bounded-grant-store-durability.test.ts` › “an exercise against an unavailable store withholds, and the adapter is not called” |
| AGS-X | AGS | Malformed persisted serialization | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a grant record whose bytes are not canonical is refused rather than normalized”; `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired” |
| AGS-Y | AGS | Schema-version mismatch (database level) | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a database recorded under a foreign schema version is not opened at all, and is not mutated by the attempt”; `revocation-state-integrity.test.ts` › “a v2 (pre-CORE-01) database is refused at open and not migrated”; `authority-artifact-authenticity.test.ts` › “a database written under the previous unsigned schema version is refused at open, not migrated” |
| AGS-Z | AGS | Schema-version mismatch (row level) | BLOCKED | PROVEN | `bounded-grant-store-durability.test.ts` › “a record written under an unrecognized schema version is refused, never reinterpreted” |
| AAA-A | AAA | Modify grant JSON only | **BLOCKED** | PROVEN | `bounded-grant-store-durability.test.ts` › “a mutated grant record is refused, never repaired”; `bounded-grant-store-durability.test.ts` › “a grant record whose bytes are not canonical is refused rather than normalized”; `bounded-grant-store-durability.test.ts` › “an exercise against corrupt state withholds rather than raising” |
| AAA-B | AAA | Modify grant + artifact digest | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `authority-artifact-authenticity.test.ts` › “digest failures are still reported as corruption, and are still checked before the signature” |
| AAA-C | AAA | Modify grant + every unkeyed digest | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too”; `bounded-grant-store-durability.test.ts` › “an exercise against corrupt state withholds rather than raising” |
| AAA-D | AAA | Modify grant + keyId, keep signature | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “changing the keyId in the envelope breaks verification”; `authority-artifact-authenticity.test.ts` › “the wrong public key fails closed”; `authority-artifact-authenticity.test.ts` › “an attacker who signs with their own key cannot make it trusted by naming it in the row” |
| AAA-E | AAA | Substitute another grant's signature | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a valid signature lifted from another grant does not make this row authoritative”; `authority-artifact-authenticity.test.ts` › “a signature over grant A does not verify grant B” |
| AAA-F | AAA | Put a revocation's signature on a grant | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a revocation’s signature moved onto its own grant row does not verify”; `authority-artifact-authenticity.test.ts` › “a revocation signature does not verify as a grant signature”; `authority-artifact-authenticity.test.ts` › “the two signing domains differ, and neither is a prefix of the other” |
| AAA-G | AAA | Remove the signature | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a missing signature fails closed, and is distinguishable from a bad one”; `authority-artifact-authenticity.test.ts` › “a row whose signature column is NULL is refused as MISSING, never trusted as legacy”; `revocation-state-integrity.test.ts` › “J. a commitment with its signature removed is refused as MISSING — never trusted as legacy” |
| AAA-H | AAA | Change the algorithm field | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an unsupported algorithm is refused rather than attempted”; `authority-artifact-authenticity.test.ts` › “an unsupported algorithm is refused at composition, not at read time”; `authority-authenticity-boundaries.test.ts` › “the supported-algorithm registry is closed, and nothing tries algorithms until one works” |
| AAA-I | AAA | Change keyId to an unknown one | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an unknown keyId fails closed, and is reported as such”; `authority-artifact-authenticity.test.ts` › “retiring a key fails closed rather than falling back to another trusted key”; `revocation-state-integrity.test.ts` › “I. a commitment re-signed by an untrusted key over the pruned set is refused as an unknown key” |
| AAA-L | AAA | Read the private key from process memory | **BLOCKED for external custody** (CORE-02); **NOT ADDRESSED for software custody** | PROVEN (CONDITIONAL) | `external-authority-signer-host.test.ts` › “boots in external mode with NO private key anywhere it can see — environment, process environment, full internal configuration”; `external-authority-signer-launcher.test.mjs` › “the shipped launcher runs a production Host under external custody”; `external-authority-signer-configuration.test.ts` › “loadEnterpriseConfiguration in external mode does not read the private key into configuration”; `external-authority-signer-structure.test.ts` › “buildAuthorityAuthenticity: the external branch returns before any private-key parsing, and has no fallback”; external custody only; software custody NOT ADDRESSED (AA-001) |
| AAA-L3 | AAA | A substituted or re-keyed external signer | **BLOCKED** (CORE-02) | PROVEN | `external-authority-signer-contract.test.ts` › “startup refuses a signer answering as another key, under another algorithm, or with other public material under the same key id”; `external-authority-signer-contract.test.ts` › “a still-trusted historical key answering mid-process is refused: rotation is configuration, never an answer from the other side”; `external-authority-signer-host.test.ts` › “endpoint substitution (the endpoint serves another key) and verification-registry substitution are refused at startup” |
| AAA-L4 | AAA | A malicious signer returns a wrong-key, cross-domain, other-artifact or malformed signature | **BLOCKED** (CORE-02) | PROVEN | `external-authority-signer-contract.test.ts` › “cross-domain substitution: a genuine signature from any other operation is refused for every operation”; `external-authority-signer-stores.test.ts` › “discharge and approval appends read their new head back inside the write transaction: an untrusted head signature rolls the append back”; `external-authority-signer-structure.test.ts` › “every returned signature is verified locally, under the pinned key, before it is returned to a store” |
| AAA-L5 | AAA | Silent fallback from external to in-process signing | **BLOCKED** (CORE-02) | PROVEN | `external-authority-signer-configuration.test.ts` › “an unreachable external signer refuses the Host before a single store file exists — and never falls back to a software key”; `external-authority-signer-configuration.test.ts` › “a configuration object carrying both custodies is refused, even when built by hand”; `external-authority-signer-host.test.ts` › “a private key alongside external custody is refused, not ignored”; `external-authority-signer-launcher.test.mjs` › “the same launch with an authority private key added is refused before listen — never ignored”; `external-authority-signer-structure.test.ts` › “buildAuthorityAuthenticity: the external branch returns before any private-key parsing, and has no fallback” |
| AAA-M | AAA | DB-only write access | **BLOCKED** (since CORE-01) — including removal of a revocation | PROVEN | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `revocation-state-integrity.test.ts` › “E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life”; `revocation-state-integrity.test.ts` › “and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it”; `revocation-state-integrity.test.ts` › “removing one of several revocations and renumbering the rest fails closed”; `revocation-state-integrity.test.ts` › “G. two revoked grants exchanging revocation rows fail closed”; `revocation-state-integrity.test.ts` › “deleting the commitment row itself fails every read closed” |
| AAA-O | AAA | An old signing key is compromised | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `authority-artifact-authenticity.test.ts` › “an artifact signed by a historical key still verifies while that key is trusted, and new artifacts use the active key”; `revocation-state-integrity.test.ts` › “after a key rotation the unchanged commitment is re-attested under the active key, so the old key can be retired”; `revocation-state-integrity.test.ts` › “re-attestation never signs a state that does not verify”; no per-key revocation list, as documented |
| AAA-Q | AAA | Artifact replay | **BLOCKED** for cross-row replay (E, F); a signature replayed onto *its own* row is a no-op | PROVEN (CONDITIONAL) | `authority-artifact-authenticity.test.ts` › “a valid signature lifted from another grant does not make this row authoritative”; `authority-artifact-authenticity.test.ts` › “a revocation’s signature moved onto its own grant row does not verify”; `revocation-state-integrity.test.ts` › “G. two revoked grants exchanging revocation rows fail closed”; `revocation-state-integrity.test.ts` › “H. moving a revocation from the revoked grant onto a live one does not free the revoked grant”; cross-row replay; own-row replay is a no-op by definition |
| AAA-R | AAA | Snapshot rollback | **BLOCKED with an external freshness witness** (CORE-07); **PARTIALLY BLOCKED** without one (CORE-01) | PROVEN (CONDITIONAL) | `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-grants.test.ts` › “G10: a rollback underneath a running store is still refused on the next read”; `authority-state-freshness-grants.test.ts` › “R4: an actually older authentic snapshot restored underneath the running process is still fatal to it”; `authority-state-freshness-host.test.ts` › “a rollback underneath a running secure Host makes it unhealthy and not ready, and nothing executes”; `revocation-state-integrity.test.ts` › “a RUNNING store detects a restore of an earlier, genuinely signed state (in-process freshness witness)”; `revocation-state-integrity.test.ts` › “SCOPED (CORE-07): without a freshness witness, anti-rollback across a restart is NOT claimed — the restored state is believed”; without a witness: in-process detection only |
| AAA-R2 | AAA | Delete a revocation row and clear the grant's pointer (the MASTER-00 un-revocation) | **BLOCKED** (CORE-01) | PROVEN | `revocation-state-integrity.test.ts` › “E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life” |
| AAA-R3 | AAA | R2 + rewrite the commitment's unkeyed fields | **BLOCKED** (CORE-01) | PROVEN | `revocation-state-integrity.test.ts` › “and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it” |
| AAA-R4 | AAA | R2 + splice in a genuine commitment from another store under the same key (e.g. the genesis of a re-created file) | **BLOCKED** (CORE-01) | PROVEN | `revocation-state-integrity.test.ts` › “and splice in a genuine genesis commitment from a DIFFERENT store signed by the same key — the store binding refuses it” |
| AAA-R5 | AAA | Host injects an unauthenticated grant store into a durable deployment | **BLOCKED** (CORE-01) for composition mistakes | PROVEN (CONDITIONAL) | `revocation-state-integrity.test.ts` › “O. a durable deployment refuses a host-supplied in-memory grant store”; `revocation-state-integrity.test.ts` › “O. a durable deployment refuses a custom store that merely has the right shape”; `revocation-state-integrity.test.ts` › “O. a durable deployment refuses a WRAPPER around a genuine authenticated store”; `revocation-state-integrity.test.ts` › “O. the branded store cannot be patched after the fact — it is frozen”; composition mistakes only; a malicious in-process host is out of scope |
| AAA-S | AAA | Signature truncation / corruption | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a truncated signature is MALFORMED, not merely invalid”; `authority-artifact-authenticity.test.ts` › “malformed signature material fails closed”; `authority-artifact-authenticity.test.ts` › “the same forgery with a fabricated random signature fails too” |
| AAA-T | AAA | Duplicate key ids with conflicting keys | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a duplicate key id is refused rather than resolved by ordering” |
| AAA-U | AAA | Signer coerced to sign attacker-chosen bytes | **BLOCKED** | PROVEN | `external-authority-signer-contract.test.ts` › “the external signer keeps the domain-aware interface: exactly the five operations and the pinned identity, no generic byte signing”; `external-authority-signer-contract.test.ts` › “the reference service offers no generic signing route and no key export”; `authority-authenticity-boundaries.test.ts` › “a constructed verifier has no signing member at runtime, and a constructed signer no key member”; `external-authority-signer-structure.test.ts` › “no operation in the client, the transport or the protocol signs caller-chosen bytes” |
| AAA-V | AAA | Verifier accepts the wrong artifact domain | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “a grant signature does not verify as a revocation signature”; `authority-artifact-authenticity.test.ts` › “a revocation signature does not verify as a grant signature”; `authority-artifact-authenticity.test.ts` › “a revocation’s signature moved onto its own grant row does not verify” |
| AAA-W | AAA | Algorithm confusion | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an unsupported algorithm is refused rather than attempted”; `authority-authenticity-boundaries.test.ts` › “the supported-algorithm registry is closed, and nothing tries algorithms until one works”; `authority-authenticity-boundaries.test.ts` › “no bounded-grant authority path uses an HMAC or any shared-secret construction” |
| AAA-X | AAA | Signing failure during issuance | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “an issuance that cannot be signed is not issued, and writes nothing”; `authority-artifact-authenticity.test.ts` › “a new store cannot be created without a signer — its genesis commitment must be signed”; `external-authority-signer-stores.test.ts` › “bounded grants: issuance and revocation write nothing while the signer is down” |
| AAA-Y | AAA | Signing failure during revocation | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `external-authority-signer-host.test.ts` › “revocation fails honestly: 503 AUTHORITY_SIGNER_UNAVAILABLE, recorded: false, no row, no head change — the grant stays exercisable”; `authority-artifact-authenticity.test.ts` › “a revocation that cannot be signed is NOT acknowledged, and writes nothing (AA-004)”; `external-authority-signer-host.test.ts` › “the one control that does not depend on the signer still works: an emergency stop is recorded during the outage”; `external-authority-signer-host.test.ts` › “the signer returns (same key, same port): the stop still withholds, the revocation commits”; `external-authority-signer-contract.test.ts` › “a hanging signer times out per attempt”; the unrecorded revocation is the stated AA-004 residual |
| AAA-Z | AAA | Signer latency racing commitGuard | **BLOCKED** | PROVEN | `authority-artifact-authenticity.test.ts` › “the commit guard still runs after signing and still refuses at the boundary”; `external-authority-signer-stores.test.ts` › “eligibility withdrawn while the signer works: the preflight passed, the signature is spent, and the post-sign commit guard still refuses” |
| NB-15.1-a | NB | Modify its own bounded grant | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `execution-layer-boundaries.test.ts` › “the store port is used for reads and revocation visibility only — nothing here writes a grant”; `authority-authenticity-boundaries.test.ts` › “the exercise path reads through a port with exactly one method, and it is not a signing one”; structural; no process boundary is the documented residual |
| NB-15.1-b | NB | Modify revocation state | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `grant-lifecycle.test.ts` › “revocation is idempotent, and the first revocation stands”; `bounded-grant-store-durability.test.ts` › “the revocation is idempotent across a restart — the first one stands”; `revocation-state-integrity.test.ts` › “E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life”; `revocation-state-integrity.test.ts` › “and also rewrite the commitment’s unkeyed fields to describe the pruned set — the signature refuses it”; `revocation-state-integrity.test.ts` › “there is no reverse transition: no un-revoke operation exists on the port or the store”; `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; in-memory Map rewrite and key-holder re-signing are the documented residuals |
| NB-15.1-c | NB | Modify trusted authority databases | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `authority-artifact-authenticity.test.ts` › “a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority”; `revocation-state-integrity.test.ts` › “E. THE MASTER-00 ATTACK: delete the row AND clear the pointer — the grant does not come back to life”; `obligation-discharge-authenticity.test.ts` › “forged independent discharge inserted with every unkeyed digest recomputed”; `approval-authenticity.test.ts` › “a forged approval quorum (or a forged proof-completing approval) inserted under the kept head or re-signed with an attacker key”; `authority-state-freshness-grants.test.ts` › “G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised”; `authority-state-freshness-obligations-approvals.test.ts` › “O2: a restored older authenticated head after a restart is refused”; digest-chained-only stores (SEC-TRUST-002) and APW-006 are the documented residuals |
| APW-B | APW | Authenticated user guesses another tenant's object id | **BLOCKED** | PROVEN | `apw-tenant-binding-blocked-claims.test.ts` › “a member of A naming B in the path is refused”; `apw-tenant-binding-blocked-claims.test.ts` › “an export id of A cannot be downloaded through B”; `admin-access-recovery.test.ts` › “session rejects wrong registry”; `registry-export.test.ts` › “rejects export from another registry”; `organization-registry.test.ts` › “verifyRegistryAccess rejects invalid token”; mutations MC1–MC3 |
| APW-C | APW | Tenant user submits another tenant id in body/query/path | **BLOCKED** | PROVEN | `apw-tenant-binding-blocked-claims.test.ts` › “a member of A naming B in the path is refused — membership is keyed by (registryId, accountId)”; `apw-tenant-binding-blocked-claims.test.ts` › “admin token presented for B — in the query, or directly to the verifier — is refused against B”; `apw-tenant-binding-blocked-claims.test.ts` › “query parameters naming A cannot override the path B”; `apw-tenant-binding-blocked-claims.test.ts` › “only the enumerated routes read a tenant id from body or query, and each binds it to that registry”; `apw-tenant-binding-blocked-claims.test.ts` › “every route under /organization-registry/[registryId] authorizes the path id through a registry gate”; mutations MC1–MC5 |
| APW-F | APW | Admin token leaks via history / referrer / logs | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `apw-partial-blocked-claims.test.ts` › “no page, component, layout or stylesheet loads a script, image, style, font or frame from another origin”; `admin-access-recovery.test.ts` › “old admin token stops working after rotation”; blocked half = no external subresources (mutation MF1); history, logs and shared links stay exposed (APW-002) |
| APW-G | APW | Malicious authenticated user repeatedly issues passports | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `registry-export.test.ts` › “capacity_exhausted when remaining passports is zero”; `organization-registry.test.ts` › “addPassportToRegistry throws when capacity exhausted”; `apps/agent-passport-web/__tests__/persistence.test.ts` › “canEnrollWithPurchase returns false after passport issued”; blocked half = entitlement bound and single-use purchase; no rate limiting (APW-011) |
| APW-O | APW | Stripe webhook replayed | **BLOCKED** | PROVEN | `billing.test.ts` › “duplicate event is idempotent”; `apw-001-checkout-disclosure.test.ts` › “is idempotent: a repeated webhook re-issues no credential”; `security-boundaries.test.ts` › “verifies the Stripe signature over the raw body” |
| APW-P | APW | Valid Stripe event applied to wrong tenant | **BLOCKED** | PROVEN | `apw-tenant-binding-blocked-claims.test.ts` › “event metadata naming A cannot redirect B”; `apw-tenant-binding-blocked-claims.test.ts` › “applies to A — the subscription link wins; B is untouched”; `apw-tenant-binding-blocked-claims.test.ts` › “an invoice event resolves by the stored subscription, then the stored customer”; `apw-tenant-binding-blocked-claims.test.ts` › “structural: the webhook”; mutations MP1–MP3. Event metadata `registry_id` is consulted only when Frontera holds no link at all (Stripe-account data Frontera never sets; no customer surface sets it) |
| APW-Q | APW | Attacker forges or modifies a passport | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `passport-issuer.test.ts` › “rejects a tampered payload”; `passport-adapter.test.ts` › “tampered runtime seal returns deny”; blocked half = forgery without the HMAC secret |
| APW-S | APW | Public verify route leaks more than intended | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `passport-adapter.test.ts` › “public verification payload hides sensitive metadata”; blocked half = no seal secret or raw bundle returned; existence disclosure remains |
| APW-T | APW | Admin bearer credential bypasses five-role RBAC | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `apw-partial-blocked-claims.test.ts` › “a viewer presenting the owner-equivalent admin token for an owner-only permission is denied rather than escalated”; `buyer-account.test.ts` › “admin cannot rotate admin access”; blocked half = a lower membership is denied, never escalated (mutation MT1); the token alone stays owner-equivalent (APW-002) |
| APW-V | APW | Session or auth material stolen | **PARTIALLY BLOCKED** | PARTIAL AS DOCUMENTED | `apw-partial-blocked-claims.test.ts` › “the buyer-account session cookie carries HttpOnly and SameSite=Lax always, and Secure in production”; `apw-partial-blocked-claims.test.ts` › “every Set-Cookie any route emits carries HttpOnly and SameSite=Lax”; `admin-access-recovery.test.ts` › “revoked session is rejected”; mutations MV1, MV2; no CSRF token (APW-005) |
| TM-7.24-1 | TM | Raw parameter smuggling into the adapter — caller JSON, raw intent parameters, metadata or `assertedContext` reaching a provider | **BLOCKED** | PROVEN | `execution-parameter-delivery.test.ts` › “extra properties on a caller entry never travel: an entry is { dimension, type, value } and nothing else”; `generic-http-parameter-mapping.test.ts` › “fields beyond the declared sources are never read: extra action properties do not reach the request” |
| TM-7.24-2 | TM | Parameter substitution after authorization — a caller mutating its objects while the exercise awaits | **BLOCKED** | PROVEN | `execution-parameter-delivery.test.ts` › “a caller mutating its request while the exercise awaits the authoritative read cannot swap in another (even in-bound) value”; `execution-parameter-delivery.test.ts` › “mutating the caller objects after the exercise returns changes nothing an adapter saw”; `execution-parameter-delivery.test.ts` › “a getter-bearing entry is read once: the value assessed is the value delivered, and no getter survives” |
| TM-7.24-3 | TM | Parameter type confusion — `"3"` for 3, `0` or `"false"` for a boolean, a float for an integer | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “DO-9 / DO-10 — the string "3" for an integer, and an undeclared parameter, are refused before any decision”; `execution-parameter-delivery.test.ts` › “P-3 an integer spelled as a string”; `execution-parameter-delivery.test.ts` › “P-7 a number standing in for a boolean”; `generic-http-parameter-mapping.test.ts` › “on the validated action is unbuildable, never coerced” |
| TM-7.24-4 | TM | Undeclared or duplicated parameter reaching a provider | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “DO-9 / DO-10 — the string "3" for an integer, and an undeclared parameter, are refused before any decision”; `execution-parameter-delivery.test.ts` › “P-11 a dimension the grant never bounded”; `execution-parameter-delivery.test.ts` › “P-9 a duplicated dimension” |
| TM-7.24-5 | TM | Profile-crossing parameter reuse — a dimension or bound valid under one Governance Profile used under another | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “CROSS-3 / CROSS-7 — a parameter valid in one profile is refused in another”; `core08-action-neutrality-host.test.ts` › “CROSS-4 / CROSS-8 — a data grant used for export, or exercised with a DevOps parameter bound, is withheld” |
| TM-7.24-6 | TM | Parameter-to-destination injection — a parameter value steering scheme, host, port, path hierarchy, adapter or route | **BLOCKED** | PROVEN | `generic-http-parameter-mapping.test.ts` › “scheme, host and port come from the pinned origin whatever the parameter values are”; `generic-http-parameter-mapping.test.ts` › “the only configuration keys are the closed ones: no parameter-selected origin, adapter or route exists”; `generic-http-parameter-mapping.test.ts` › “a dotted id is an opaque name matched exactly — never traversed as a path into the action” |
| TM-7.24-7 | TM | Parameter-to-credential injection — a parameter setting `Authorization` or a credential header | **BLOCKED** | PROVEN | `generic-http-parameter-mapping.test.ts` › “a parameter cannot set Authorization, a credential header, a reserved header or a header name” |
| TM-7.24-8 | TM | Missing execution-context evidence — a parameter-bearing effect whose durable attempt omits the parameters | **BLOCKED** | PROVEN | `execution-outcome-parameters.test.ts` › “the attempt digest commits to every dimension, type and value, and to their absence”; `core08-action-neutrality-host.test.ts` › “DO-1 / DO-8 — a valid deploy executes exactly once; the adapter receives exactly the canonical typed parameters” |
| TM-7.24-9 | TM | P11 legacy reinterpretation — a historical v1 attempt read as though it carried parameters | **BLOCKED** | PROVEN | `execution-outcome-parameters.test.ts` › “M13 — a v1 record carrying parameters is corrupt: v1 never had that meaning”; `execution-outcome-parameters.test.ts` › “legacy attempts and observations read back as v1, verified, with no parameters and their exact money” |
| TM-7.24-10 | TM | Domain-specific CORE branch — generic CORE deciding by what an action, resource, profile or dimension is | **BLOCKED** (structural) | PROVEN | `core08-action-neutrality-structure.test.ts` › “no generic CORE source names a reference-domain word or branches on a domain value”; `core08-action-neutrality-structure.test.ts` › “catches: ” |
| TM-7.24-11 | TM | Cross-domain action, resource or profile substitution — one domain's action over another's resource, profile pinning, a read grant used for export | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “CROSS-1 / CROSS-5 — a domain action over another domain’s resource is refused by the envelope before any decision”; `core08-action-neutrality-host.test.ts` › “CROSS-2 / CROSS-6 — pinning another domain’s profile, or the right profile at another version, is refused”; `core08-action-neutrality-host.test.ts` › “DA-8 — a read grant cannot execute an export; DA-9 — an export grant cannot substitute another data resource” |
| TM-7.24-12 | TM | Revocation between issuance and the provider crossing, in any qualified domain | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “a grant revoked through the administration API after issuance and before the adapter → zero adapter calls”; `core08-action-neutrality-host.test.ts` › “control — the stranded grant executes when nothing changed (so the zero below is load-bearing)” |
| TM-7.24-13 | TM | Replay under the same execution identity with changed parameters producing a second effect | **BLOCKED** | PROVEN | `core08-action-neutrality-host.test.ts` › “W — the same idempotency key with changed parameters is refused; the committed request is never reinterpreted”; `core08-action-neutrality-host.test.ts` › “TR-7 — replaying the same execution identity produces no second provider call”; `execution-outcome-parameters.test.ts` › “preparation is idempotent, and the same execution with any other parameter is a conflict” |

<!-- core06:blocked-matrix:end -->

---

## 7. Independence from INTEL (§11.1 item 10, Master Plan invariant 32)

- **Dependencies.** No manifest in the repository declares a model, provider SDK, vector store, agent framework or inference runtime: the root and all 37 workspace manifests under `packages/` and `apps/`. The lockfile and `node_modules` contain none either.
- **Structure.**
  - The transitive import closure of `enterprise-host.ts` and `composition-root.ts` (Kernel, grant store, orchestrator, exercise gate, registry, approval authority and freshness session included) loads only Node built-ins and the root's declared runtime dependencies (`better-sqlite3` and four workspace packages).
  - No file in the closure lives under an intelligence path.
  - **43 Governance Core directories** name no intelligence import or identifier in code. Thirteen of them had no such scan before CORE-06: authority-state-freshness, external-authority-signer, bounded-grant-store, exercise-control-ledger, emergency-control, execution-adapters, execution-resolution-store, authority-administration, authority-authenticity, execution-outcome-store, execution-reconciliation, authority-event-stream and composition.
  - The existing Kernel scan (`security-invariants.test.ts`) and `governed-action-neutrality-structure`, `trusted-context-structure` and `approval-structure` are retained unchanged.
  - Evidence: `core06-qualification-structure.test.ts` §20.
- **Runtime.** The canonical Host in §8 runs with no model, provider SDK, inference service or network context source. The context provider is a static table and the policy is data. On it:
  - a valid action executes;
  - a policy denial denies;
  - missing, stale, future-dated and unauthorized-source facts fail closed;
  - approval withholds, and releases only on a durable quorum;
  - an obligation withholds, and releases only on a verified independent discharge;
  - revocation and emergency stop hold at exercise;
  - the effect reaches the adapter only after the whole deterministic chain.
- **Restrict-only.** The one intelligence-adjacent semantic surface is an admitted restrictive fact (CORE-04):
  - A `high` signal denies, and an `elevated` one requires approval.
  - A benign `low` signal neither lifts a policy denial nor satisfies an approval requirement (Q9 here, which closes the audit's gap that no test showed a signal cannot satisfy an approval).
  - A pack cannot make a restrictive fact permit, because monotonicity is validated at registration (mutation M16 removes that validation and is killed).
  - Neither the orchestrator nor issuance reads a signal, so no grant scope, parameter ceiling or expiry can be shaped by one (structural; mutation M16b).
  - An AI-derived object has no channel to create an ALLOW, widen a grant, extend an expiry, satisfy an approval or obligation, create authority or call an adapter. The intent is closed; asserted context cannot satisfy a gate (Q2); approval, discharge and authority writers are trusted in-process ports; the adapter is reachable only through the gate.

**Result: CORE is independent of INTEL. Every §11.1 item is demonstrated with no intelligence component present, and the Kernel-source intelligence-vocabulary test still passes.**

---

## 8. Adversarial cases on the composed Host

Levels:

- **HOST:** `bootEnterpriseHost()`, production profile, HTTP route.
- **HOST-ACE:** a booted Host, with a genuine issued grant exercised through its composed exercise gate.
- **ROOT:** `createEnterprise()` with the Host's mechanisms and a test hook.
- **WORLD:** the real Kernel, orchestrator and ACE, hand-wired with in-request hooks.
- **UNIT:** a component.

Adapter-call counts are asserted in every row.

### 8.1 Refusal matrix Q1 … Q20

| # | Case | Expected / observed | Adapter calls | Evidence |
|---|---|---|---|---|
| Q1 | no / wrong credential; legacy org key; **unbound principal** | 401 / 401 / 401-403 / **403, no decision** | 0 | HOST `core06-…-host` Q1; `enterprise-host.test.ts` |
| Q2 | organization, actor, principal, grant, approval proof, obligation result, adapter, destination, credential, execution id, expiry, emergency state, profile or witness named in the body; the same smuggled through `assertedContext` | 400, no decision; asserted facts, obligations and approvals satisfy nothing | 0 | HOST Q2 (21 fields + 5 assertions) |
| Q3 | bound actor the Kernel does not recognize | 422 `denied`, `RECOGNITION_*` | 0 | HOST Q3 |
| Q4 | recognized actor without live authority | 422 `denied` | 0 | HOST Q4; `enterprise-host.test.ts` (delegation revoked) |
| Q5 | policy denies | `denied`, rule code committed | 0 | HOST Q5 |
| Q6 | envelope outside the trusted profile; caller-chosen profile; malformed profile at boot | 400 before any decision; the Host refuses to start | 0 | HOST Q6 ×2; `governed-action-semantics-host.test.ts` |
| Q7 | required material fact missing | `denied` `CONTEXT_REQUIRED_FACT_UNRESOLVED` | 0 | HOST Q7 |
| Q8 | stale / future-dated / unauthorized-source fact | `denied` with its own context code | 0 | HOST Q8; `governed-action-trusted-context-host.test.ts` |
| Q9 | admitted `high` / `elevated` / benign signal | denied / withheld (approval) / changes nothing | 0 | HOST Q9; `governed-action-restrictive-signal-host.test.ts` |
| Q10 | blocking obligation; self-reported discharge; verified discharge | withheld / withheld / executed **once**, replay no effect | 0 → 1 | HOST Q10; `governed-action-obligations-host.test.ts` |
| Q11 | approval pending | withheld `GOVERNED_ACTION_APPROVAL_PENDING` | 0 | HOST Q11 |
| Q12 | completed approval revoked before use | withheld `…_APPROVAL_REVOKED`; control executes once | 0 (control 1) | HOST Q12; WORLD `governed-action-approval-gate.test.ts` (revoked between issuance and exercise) |
| Q13 | grant revoked (admin HTTP) after issuance | `withheld` `GRANT_EXERCISE_REVOKED`; original request never re-executes | 0 | HOST-ACE Q13; `authority-administration-api.test.ts` |
| Q14 | delegation revoked after issuance | withheld by exercise control (lineage); new requests denied | 0 | HOST-ACE Q14; HOST `governed-action-obligations-host.test.ts` |
| Q15 | restored pre-revocation snapshot | Host refuses (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`); running rollback → unhealthy, nothing executes | 0 | HOST `authority-state-freshness-host.test.ts` (separate-process witness) |
| Q16 | global / organization / actor / resource stop before the request; adapter stop | withheld `emergency-control` at checkpoint 1; adapter stop at checkpoint 5; release restores | 0 | HOST Q16 ×2; `authority-administration-api.test.ts` |
| Q17 | aggregate / velocity bound exhausted | withheld `EXERCISE_CONTROL_*` | 0 | ROOT `authority-payment-ceilings.test.ts` (P7 + P10 on the composition root); WORLD `exercise-control-governed-action.test.ts`. The canonical Host composes P7 with no host-imposed limit (`policy: () => []`), so its only limits are P10 spending limits provisioned on the authority. Not re-driven over the Host's HTTP route by CORE-06 |
| Q18 | exercise of a genuine grant with another actor, action, resource, organization, parameter, destination, extra dimension, profile, action class, resource class or correlation | each `withheld` with its own code | 0 | HOST-ACE Q18 (11 substitutions) |
| Q19 | authorized action with no configured route | Kernel `allowed`; no child adapter; not executed | 0 | HOST Q19; boot refusal for a route to an unknown adapter (`enterprise-host.test.ts`) |
| Q20 | valid complete action; replay; 3 concurrent identical requests | executed once with exactly the validated action; replay `replayed: true`; one execution id | **1**, never 2 | HOST Q20 ×2 |

### 8.2 Mid-flight matrix T1 … T10

| # | Transition | Behaviour (current code) | Effect | Evidence |
|---|---|---|---|---|
| T1 | authority revoked after the decision, before issuance | financial: refused at the commit boundary (P10), no grant. Non-financial: **the grant may issue** (no live re-check at issuance) and exercise withholds on lineage | 0 | ROOT `authority-payment-ceilings.test.ts` §82; HOST `governed-action-obligations-host.test.ts` ("the grant may issue, but exercise is withheld"); WORLD `governed-action-orchestrator.test.ts` |
| T2 | revoked after issuance, before exercise | withheld at the exercise gate (grant revocation or lineage) | 0 | HOST-ACE Q13, Q14; ROOT `authority-payment-ceilings.test.ts` (afterGrantIssued) |
| T3 | approval valid at issuance, revoked before the claim | withheld by the pre-claim re-assessment. **Not re-read after the claim** (bounded by the grant's approval-capped expiry) | 0 | WORLD `governed-action-approval-gate.test.ts`; mutation M9 |
| T4 | obligation satisfied at issuance, invalid later | **Not applicable:** a verified discharge is terminal; no withdrawal state exists | — | `obligation-lifecycle-service.ts`; §2 |
| T5 | emergency stop after issuance | withheld at exercise-gate checkpoints 3 / 4 | 0 | HOST-ACE T5; WORLD `emergency-control-governed-action.test.ts` |
| T6 | stop after the reservation, before the adapter | released; withheld by checkpoint 4 or the registry's checkpoint 5 | 0 | HOST T6 (adapter stop, after reservation); UNIT `execution-exercise-control.test.ts` ("a stop activated during the reservation") |
| T7 | trusted context expires before exercise | the grant's expiry is capped at the context's validity → `GRANT_EXERCISE_EXPIRED` | 0 | HOST-ACE T7 (real clock) |
| T8 | freshness state regresses before exercise | refused at open; under a running Host → unhealthy / not ready, nothing executes | 0 | HOST `authority-state-freshness-host.test.ts` |
| T9 | concurrent reservation / identical requests | one decision, one claim, one effect; capacity races admit at most one | ≤ 1 | HOST T9; ROOT `authority-payment-ceilings.test.ts` §81 |
| T10 | decision / request / source lineage substituted | same key, other request → refused; exercise under a substituted correlation → withheld; persisted-record divergence → stopped | 0 | HOST T10, Q18; WORLD `governed-action-orchestrator.test.ts` |

**What the canonical Host does not let a test do:** place an event *inside* one HTTP request, between issuance and the adapter. `bootEnterpriseHost()` exposes no such seam, and CORE-06 adds none, because a test-only seam in the production Host would be a new side door. The windows are qualified two ways:

- on the Host itself, with a genuine grant stranded by the registry's last checkpoint (HOST-ACE, shown exercisable when nothing changes, so each zero is load-bearing);
- at ROOT and WORLD level, where the hooks already exist.

### 8.3 Bindings and integrations

- **Decision → grant.** The grant source is read from the **persisted, re-verified** decision, never the transient one. The signed `sourceDigest` binds request, decision, profile, admitted-context digest and approval, and the grant's validity is capped by context and approval. A caller cannot fill any of these (Q2):
  - `governed-action-orchestrator.test.ts` (persisted-record divergence);
  - `governed-action-approvals-host.test.ts` (sourceDigest recomputed with and without the approval);
  - `governed-action-trusted-context-host.test.ts` (context digest and validity cap);
  - `core04-review-profile-binding-host.test.ts`.
- **Grant → exercise.** Q18 on the Host covers eleven substitutions, plus expiry (T7) and revocation (Q13).
- **Approval** (CORE-05, composed):
  - never over DENY (Q9 high, and the CORE-05 suites);
  - releases only `approval_required` (Q11);
  - never satisfies an obligation (`governed-action-approvals-host.test.ts`, both orders);
  - validity caps the grant (M8);
  - approver authority is live (`governed-action-approvals-host.test.ts`);
  - revocation before use blocks (Q12);
  - no caller proof (Q2, M19).
- **Obligation** (CORE-04): independently re-read (M7); a caller cannot assert satisfaction (Q2, M20); the writer is in-process only (EP-058); durable, signed and witnessed; missing → withheld (Q10).
- **Trusted context:** the profile is server-resolved (Q6, M21); only declared facts enter policy; provenance, source authority and freshness are checked at the boundary (Q7, Q8); context restricts and never mints; the digest is bound and validity capped (T7).
- **Emergency control:** five checkpoints sharing one reader, pinned in order (§2). It is restrictive only and never grants. It is signer-independent (`external-authority-signer-host.test.ts`: a stop is recorded during a signer outage). Each checkpoint is proven: 1 by Q16; 2 by `emergency-control-governed-action.test.ts` (commit boundary); 3 / 4 by T5 and M11c; 5 by T6 and M11a.
- **Freshness (CORE-07):** Q15 / T8 on the Host; M13.
- **External signer (CORE-02 / 02R):** under external custody, the Host process holds no key, has no local fallback, adopts no supplied store, verifies locally, and signer outage writes nothing (`external-authority-signer-host.test.ts`, `external-authority-signer-stores.test.ts`). CORE-06 changed none of this code.
- **Exercise control / claim ordering:** the claim precedes the gate's reservation, and no adapter runs without both. A reservation failure withholds (M12). An execution identity never produces a second effect (Q20, T9, M22). `execution_unconfirmed` is never resent.
- **Reconciliation (P11 / P12):** replay reads, never contacts a provider, and never turns uncertainty permissive. A P12 row is believed only for exactly this attempt and this uncertainty (`execution-reconciliation*`, `exercise-control-governed-action.test.ts` §38 / §13, `emergency-control-governed-action.test.ts` Cases A–D).

### 8.4 One authority world

Within the governed path each authority question has **one** source of truth:

- recognition and authority: the durable Kernel-Authority world. The approval authority's approver checks read the same world through the provider getters; the lineage revalidator reads the same world;
- effective profile: one resolver, `resolveEffectiveProfile`, shared by the Kernel, obligations, approvals and intent;
- emergency: one reader over one store, for all five checkpoints;
- grants: one store, signed and witnessed;
- clock: `kernelProviders.clock`, injected everywhere on the path.

The in-memory `ApprovalRuntime` (EP-025) and the capability-token `Map` (EP-024) are separate legacy domains that the governed path does not consult for approvals.

---

## 9. Mutation / non-vacuity evidence

Each mutation was applied to a single site: compiled `dist` for runtime protections, `src` or the document for protections that a structural test reads. The smallest relevant suite was run, and then the original bytes were restored. A SHA-256 manifest of every file under `src/`, `scripts/` and `dist/` (10,225 files) was taken before the campaign and compared after it: identical, apart from one deliberate comment correction made outside the campaign (§10 item 1). No mutation relied on a compile failure. The harness: apply → run → restore → hash-check, recorded per mutation.

| # | Mutation (protection removed) | Site | Killed by | Result |
|---|---|---|---|---|
| M1 | a direct `ExecutionAdapter.execute` outside the exercise gate | `orchestrator.ts` | `no-bypass-effect-paths` NB-001 (1 of 63 fail) | **killed** |
| M2 | the authoritative re-read's verdict ignored before the adapter (both reads) | `grant-execution-service` | CORE-06 Host §11: control, Q18, Q13 / T7 (3 fail) | **killed** |
| M3 | an unrecognized actor continues (`unrecognized_actor` / `invalid_passport` → allowed) | enforcement decision map | CORE-06 Host Q3 | **killed** |
| M4 | a policy denial proceeds | `domain-policy-pack-policy` | CORE-06 Host Q5 | **killed** |
| M5 | a missing trusted material fact allowed | Kernel context adapter | CORE-06 Host Q7 | **killed** |
| M6 | an admitted restrictive RiskSignal dropped (treated as permissive) | Kernel context adapter | CORE-06 Host Q9 | **killed** |
| M7 | the obligation re-read skipped (`satisfiedNow` → true) | orchestrator | CORE-06 Host Q10 | **killed** |
| M8 | an approval widens the grant beyond its own validity | orchestrator grant terms | CORE-05 `governed-action-approval-gate`, `-approvals-host`, `-approvals-adversarial-host` (4 of 33 fail) | **killed** |
| M9 | approval re-assessment before the claim skipped | orchestrator | `governed-action-approval-gate` (2 of 8 fail) | **killed** |
| M10 | lineage revalidation at exercise skipped | `exercise-controls` | CORE-06 Host Q14; `governed-action-obligations-host` (2 fail) | **killed** |
| M11a | registry (adapter-scoped) emergency checkpoint 5 bypassed | registry | CORE-06 Host T6 / strand; `emergency-control-governed-action` (5 of 35 fail) | **killed** |
| M11b | exercise-gate checkpoint 3 removed | `grant-execution-service.ts` | CORE-06 structure §32 (checkpoint count and order) | **killed** (structurally; at runtime checkpoint 4 still holds — defence in depth, which is why M11c exists) |
| M11c | exercise-gate checkpoints 3 **and** 4 bypassed | `grant-execution-service` | CORE-06 Host T5 | **killed** |
| M12 | the aggregate / velocity reservation gate skipped | `grant-execution-service` | `exercise-control-governed-action`, `authority-payment-ceilings` (30 of 124 fail) | **killed** |
| M13 | a restored older authority snapshot accepted at open | freshness session | `authority-state-freshness-host` (1 of 6) | **killed** |
| M14 | the closed intent opened (a customer may name an adapter, destination, grant …) | `intent` | CORE-06 Host Q2 | **killed** |
| M15 | an INTEL / model dependency added to CORE (`import('openai')`, `modelProvider`) | `approval-authority/service.ts` | CORE-06 structure §20 (2 fail) | **killed** |
| M16 | restrictive-monotonicity validation removed (a pack may make a signal permit) | policy-pack validator | `policy-trusted-context-predicates`, `governed-action-restrictive-signal-host` (2 fail) | **killed** |
| M16b | issuance reads a RiskSignal (a signal could shape a grant) | `issuance-core.ts` | CORE-06 structure §20 | **killed** |
| M17 | a second adapter call site inside the registry | registry `.ts` | `no-bypass-effect-paths` NB-001 | **killed** |
| M18 | an unreadable emergency control treated as permissive | emergency port | `emergency-control-governed-action` (5 of 37 fail) | **killed** |
| M19 | a caller-supplied `approvalProofId` accepted | `intent` | CORE-06 Host Q2 | **killed** |
| M20 | a self-reported discharge satisfies the obligation | obligation lifecycle | CORE-06 Host Q10 | **killed** |
| M21 | a caller-pinned Governance Profile accepted over the server-resolved one | `intent` | CORE-06 Host Q6 | **killed** |
| M22 | the write-ahead claim ignored | execution ledger | — | **survived** — defence in depth: replay-before-gates answers every repeat from the durable record, and P7 refuses a second reservation of the same execution id |
| M22b | the claim ignored **and** the P7 per-execution reservation guard removed | ledger + P7 gate | — | **survived** — replay-before-gates still answers every repeat |
| M22c | the claim ignored **and** replay-before-gates removed (P7 intact) | ledger + orchestrator | CORE-06 Host Q20 ("never twice"), Q10, T6 replay; `governed-action-orchestrator` replay suites (13 of 37 fail) | **killed** |
| M22d | all three removed | — | as M22c (13 fail) | **killed** |
| M23 | a new production outbound network site without an EP id | `governance-profile/index.ts` | `no-bypass-effect-paths` network-site inventory (2 of 40 fail) | **killed** |
| M24 | a BLOCKED claim's only evidence removed from the coverage matrix (AGS-A) | this document | CORE-06 structure §16–§18 | **killed** |
| M24b | a THREAT_MODEL BLOCKED row dropped from the matrix | this document | CORE-06 structure §16–§18 | **killed** |
| M25 | grant revocation's in-transaction read-back removed | grant store | CORE-06 evidence AGS-C | **killed** |
| M26 | the approval store's in-process same-sequence fork check removed | approval store | CORE-06 evidence §7.16e fork | **killed** |
| M27 | the grant store's `synchronous = FULL` removed | grant store `.ts` | CORE-06 evidence pin | **killed** |
| M24c | APW-C's evidence replaced by audit prose | this document | CORE-06 structure §16–§18 | **killed** |
| M24d | APW-P re-exempted as "not applicable" | this document | CORE-06 structure §16–§18 | **killed** |
| M24e | an APW BLOCKED row dropped from the matrix | this document | CORE-06 structure §16–§18 | **killed** |
| MC1 | APW membership lookup ignores the registry id | membership repository | APW row C runtime (2 fail) | **killed** |
| MC2 | APW admin token not checked against that registry's hash | `verifyRegistryAccess` | APW row C runtime | **killed** |
| MC3 | APW export id no longer bound to its registry | export service | APW row C runtime | **killed** |
| MC4 | `claim-registry` trusts a caller-named registry without its credential | route | APW row C structural | **killed** |
| MC5 | a `[registryId]` route loses its registry gate | route | APW row C structural | **killed** |
| MP1 | event metadata overrides the server-held subscription link | Stripe lifecycle handler | APW row P runtime (2 fail) | **killed** |
| MP2 | the customer id overrides the stored subscription link (subscription and invoice) | Stripe lifecycle handler | APW row P runtime (2 fail) | **killed** |
| MP3 | the webhook's checkout branch selects the purchase from event metadata | webhook route | APW row P structural | **killed** |
| MT1 | a member lacking a permission falls through to the owner-equivalent token | registry access gate | APW row T | **killed** |
| MV1 | the buyer session cookie loses `HttpOnly` | session library | APW row V | **killed** |
| MV2 | the admin session cookie loses `HttpOnly` | route | APW row V | **killed** |
| MF1 | an external script (`next/script`) in the root layout | layout | APW row F | **killed** |

**Totals:** 49 mutations. **47 killed.** M22 and M22b survived, and the reason is recorded rather than hidden. No duplicate effect was producible while *any* of the three duplicate-effect layers stood: replay-before-gates, the write-ahead claim, and the P7 per-execution reservation. M22c and M22d show the property is not vacuous. **Coverage note** (not a security gap): no test isolates the write-ahead claim as the *sole* guard against a truly concurrent duplicate, because the other two layers always answer first in every test. A deterministic interleaving test for the claim alone belongs with the next item that touches the ledger.

---

## 10. Residuals retained

CORE-06 qualifies the claims as stated. It closes no residual with wording. Each residual below is outside what §11.1 requires, or is an explicitly accepted boundary:

1. **The trusted Host process is inside the TCB** (SEC-TRUST-001). In-process code can:
   - hold the adapter object, the stores and every in-process port (`obligationDischarges`, `approvals`, `kernelAuthorityProvisioning`, `emergencyControlAdministration`, `authorityControlledExecution`);
   - construct any writer or command context;
   - call `authorityControlledExecution.{authorize, exercise}`, which bypasses customer admission and the Governance Record, and whose exercise does not consult approvals.

   Found by CORE-06 and recorded, not redesigned: `AocEnterprise.kernelProviders` exposes the durable Kernel-Authority world's mutable `authorityRuntime` / `recognitionRuntime` handles. That contradicts the separation `durable-kernel-providers.ts` describes for its handles; the code comment there is corrected. It is reachable from no route, SDK method or intent, and an embedder that holds `AocEnterprise` already holds equivalent power (it could supply its own Kernel to `createEnterprise`). There is no process isolation, and CORE-06 claims none.
2. **Host-supplied provider capability is trusted.** An `executionAdapters` member performs whatever its code does. The gate governs *whether* and *which*, not *what*, which is NO_BYPASS §7.4.
3. **Other authority domains are not bounded-grant governed:** `AocKernel.enforce()` (PARTIALLY BOUND), Sovereign Access, Content Protection, the raw Pinata client, Stripe and issuer signing (Agent Passport Web), operator tooling, and the reference signer and witness processes. There are 54 non-bounded-grant paths in all, each classified in NO_BYPASS §5.
4. **AA-002.** Deployment configuration (the governed-action file, API keys, administrators, verification keys, the witness pin) is unsigned trusted input.
5. **AA-004.** Revocation needs the signer (and, with CORE-07, the witness). An outage fails honestly and leaves the grant exercisable; the signer-independent emergency stop is the mitigation.
6. **AA-010.** A compromised Host can request signatures while it holds the custody credential.
7. **CORE-07 co-rollback.** The witness restored together with the stores, and a rollback before a store's first trusted enrollment, are not detected. PROD-02 owns backup and restore.
8. **Digest-only authority stores.** The Kernel Authority store (PROD-01), emergency control, the P7 ledger, execution outcomes and resolutions are digest-chained, **neither signed nor witnessed**. A re-sealing file writer can alter them, or restore an older one. Examples: restoring revoked Kernel authority, clearing an emergency stop, restoring P7 capacity (SEC-TRUST-002; NO_BYPASS §15.1).
9. **Policy is in-process and unfrozen on the Host.** NB-008's identity half is closed. The Host takes a composed `policyPackProvider` and does not freeze it, and there is no durable policy store.
10. **Mid-request races on the Host** are not driven over HTTP; they are qualified at ROOT and WORLD (§8.2). Non-financial authority is not re-checked at issuance (T1 → caught at exercise). Approvals are not re-read after the claim (T3, bounded by the approval-capped expiry). Context is not re-fetched at exercise (bounded by the expiry cap).
11. **Q17 is not re-driven over the Host's HTTP route.** Aggregate limits on the Host are only P10 authority spending limits.
12. **Linearizable multi-process reads are not claimed** (R-GS-07). Under WAL, a held write lock does not block readers (§6).
13. **Agent Passport Web** keeps its own open findings (APW-002, APW-005, APW-011 and others) as its threat model states them. Its BLOCKED rows now have executable evidence (§6). The route layer is proven structurally, because the app's harness does not compile its Next.js routes. Stripe-side subscription metadata is trusted only when Frontera holds no link.
14. **One organization per Host.** No independent penetration test has been run.

---

## 11. Validation

**Working copy** (2026-09-30, CORE-06 tree built from `main @ c5113cf`), focused regression matrix — one `node --test` run per group:

| Group | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| CORE-06 (new: Host 25, structure 23, evidence 10) | 58 | 58 | 0 | 0 |
| No-bypass + security invariants | 63 | 63 | 0 | 0 |
| CORE-01 | 140 | 140 | 0 | 0 |
| CORE-02 / CORE-02R | 153 | 153 | 0 | 0 |
| CORE-03 (incl. policy-pack runtime) | 308 | 308 | 0 | 0 |
| CORE-04 (incl. context and obligation runtimes) | 330 | 330 | 0 | 0 |
| CORE-05 | 81 | 81 | 0 | 0 |
| CORE-07 | 88 | 88 | 0 | 0 |
| PROD-01 (Host, Kernel Authority, customer identity, launcher, durable-authority contracts) | 331 | 319 | 0 | 8 |
| CTRL-01 | 64 | 63 | **1** | 0 |
| P7 (incl. execution and exercise-control runtimes) | 552 | 552 | 0 | 0 |
| P8 | 169 | 168 | 0 | 1 |
| P9 | 154 | 154 | 0 | 0 |
| P10 | 122 | 122 | 0 | 0 |
| P11 | 105 | 105 | 0 | 0 |
| P12 | 114 | 114 | 0 | 0 |
| Governed-action spine (API, composition, orchestrator, emergency control, grant runtime) | 605 | 605 | 0 | 0 |
| Kernel | 204 | 204 | 0 | 0 |

**The one CTRL-01 failure is a CRLF working-copy artifact, not a defect.** It is `authority-administration-service.test.ts` "the HTTP adapter mounts administration only through the service …", a source-text regex over `src/enterprise/adapters/node-http-adapter.ts`. Four facts establish this:

- The file is checked out `w/crlf` over an `i/lf` index.
- CORE-06 does not touch it.
- With the same file LF-normalized, the test passes 5 / 5. The file was then restored byte-identical.
- CORE-07 recorded the same artifact.

The clean export passes it. The skips are pre-existing: FRONTERA-PROD-01 F1, the live-provider cases, and P8's one skip.

Also in the working copy:

- typecheck, lint (node16 imports, architecture, public surface) and build: green;
- `check-api-freeze`: **36 endpoints, unchanged**. No route was added: 34 frozen, 1 capability-gated, and the 8 CTRL-01 administration routes, which are drift-checked;
- `check-release-docs` and `check-sdk-surface`: green;
- `legal:check`: only the pre-existing advisory findings (busboy / streamsearch licence, two unnamed workspace manifests);
- `git diff --check`: clean. No conflict markers.

**Follow-up: the item 9 scope check.** A pre-PR consistency check found that the first draft exempted two Agent Passport Web BLOCKED rows as "outside the Core", and that §11.1 item 9 does not support that exemption. The follow-up added the APW evidence and tightened the matrix check (§6). Measured after the follow-up, in the working copy:

- the Agent Passport Web workspace passes **311 / 311** (291 existing + 20 new);
- CORE-06 + no-bypass + security invariants pass **122 / 122** (Host 25, structure 24, evidence 10, no-bypass and invariants 63);
- 15 more mutations were run (M24c–e, MC1–MC5, MP1–MP3, MT1, MV1, MV2, MF1). All 15 were killed, and each file was restored and hash-checked. The application's source is unchanged.

**Clean export.** The full validation (fresh `npm ci`; typecheck, lint, build; the root suite; every workspace; the four repository checks) was run on a fresh LF `git archive` export of the **final** CORE-06 commit. It is reported against that exact hash in the milestone report, and not written into the tree it measures.

---

## 12. §11.1 GOVERNANCE CORE STABLE — disposition

| # | Criterion (live §11.1) | Evidence | Status |
|---|---|---|---|
| 1 | Revocation tamper-evident; snapshot rollback at least detected | CORE-01 (`revocation-state-integrity.test.ts`); CORE-07 (`authority-state-freshness-*`); re-run in §11; Q15 / T8 on the Host; M13 | **TRUE** (rollback: with the external witness the secure Host requires) |
| 2 | Authority authenticity on by default; unsigned substitute refused | PRE-00 / CORE-01 / PROD-01; secure posture `authenticated-durable` asserted by the §9 posture test here; AAA matrix rows | **TRUE** |
| 3 | External signer boundary | CORE-02 / 02R (`external-authority-signer-*`); TM §7.16d matrix rows | **TRUE** (under `external` custody; software custody remains permitted) |
| 4 | One generic envelope; no payment or credit vocabulary in CORE, enforced structurally | CORE-03 (`governed-action-neutrality-structure.test.ts`); non-money parameters on the Host (settle, deploy and read profiles here) | **TRUE** |
| 5 | Obligations and trusted context reachable on the governed path | Q7, Q8, Q10 on the Host; CORE-04 suites | **TRUE** |
| 6 | Lineage revalidated at exercise for all action classes | Q14 / T2 on the Host (non-financial); P10 for financial; M10 | **TRUE** |
| 7 | Approvals durable and resumable | Q11 / Q12 on the Host; CORE-05 suites; M8, M9 | **TRUE** |
| 8 | **No-bypass proof re-run against the composed default Host** | §3, §4, §8; `core06-governance-core-qualification-host.test.ts`; M1, M17, M23 | **TRUE** — PROVEN, path-local, 8 of 62 |
| 9 | **Every BLOCKED security claim has a test** (unscoped, read literally) | §6: all 116 BLOCKED-bearing rows across THREAT_MODEL_V1, AUTHORITATIVE_GRANT_STORE, AUTHORITY_ARTIFACT_AUTHENTICITY, NO_BYPASS and AGENT_PASSPORT_WEB_THREAT_MODEL — 0 missing, stale, overclaimed or exempted; machine-checked; M24, M24b–e | **TRUE** — repository-wide |
| 10 | **CORE is independent of INTEL** | §7; M15, M16, M16b | **TRUE** |

**GOVERNANCE CORE STABLE: ACHIEVED**, with the residuals of §10 retained explicitly.
