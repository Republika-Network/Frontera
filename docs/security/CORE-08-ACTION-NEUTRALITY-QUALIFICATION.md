# CORE-08 — Action-Neutrality Qualification

**Milestone:** CORE-08 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9), the gate for **GOVERNED ACTION THESIS PROVEN** (§11.6). The last CORE milestone.
**Branch:** `feat/core-08-action-neutrality-qualification`.
**Baseline:** `main` / `origin/main` @ `8d995676d250a7b7bc43fc32c0cb6f68e49fb021` (merge of CORE-06, PR #156). Branch = baseline at start; 0 / 0 ahead / behind; clean tree.
**Status of this document:** evidence. It replaces no test. Every PASS below names the executable test that fails when it does not hold; the domain matrix in §9 is machine-checked against the suite that proves it.

CORE-08 asks one question:

> Does Frontera's deterministic authority core govern **materially different** machine actions through the **same** generic authority architecture — with domain meaning entering only as data?

For three reference domains — a monetary treasury transfer, a production software deployment, and a customer-data read versus export — on the canonical shipped Host, the answer is **yes**, within the scope and residuals of §15. It is not a claim about every possible machine action, about physical actuation, or about settlement rails.

---

## 1. Baseline

| | |
|---|---|
| Branch | `feat/core-08-action-neutrality-qualification` |
| Starting `main` | `8d995676d250a7b7bc43fc32c0cb6f68e49fb021` |
| Merge-base | `8d995676d250a7b7bc43fc32c0cb6f68e49fb021` |
| Ahead / behind at start | 0 / 0 |
| Working tree at start | clean |

## 2. The live §11.6 criteria (verbatim from the Master Plan at baseline)

1. **At least three materially different action/resource domains** run end to end on the same Host (treasury — transfer × monetary asset exercising P9/P10, any governed monetary adapter acceptable; DevOps — deploy × production environment via an HTTP / Kubernetes-like adapter with change-window and rollback facts; Data — read vs export × customer data via an API adapter with a non-monetary record-count bound distinguishing the two).
2. **Shared, unchanged across all domains:** the GovernedAction spine, the Kernel implementation, authority semantics, the BoundedGrant model, the constraint architecture, the obligation architecture, the evidence model and the lifecycle (decision → grant → claim → outcome → evidence).
3. **Only these vary:** Governance Profile, context sources, organization policy, domain validation and Execution Adapter.
4. **No domain-specific branching in the Kernel or orchestrator**, proven by a structural test; CORE source is identical across the three domain runs.
5. In every domain a denial, an over-bound request, a revocation mid-flight and a missing required fact each behave per the shared semantics (withheld, denied or REVIEW by policy — never allowed by default).
6. No intelligence component is required (invariant 32).

Remaining gaps named by the Master Plan at baseline: typed parameters delivered to domain adapters; three domains end to end on the shipped Host; revoked-mid-flight cases per domain. Each was verified in source before any change (§3).

## 3. Initial gap (audited from source at baseline)

| Gap | Where it was, exactly |
|---|---|
| Parameters stopped at the exercise gate | Typed parameters flowed `intent.parameters → profile validation → Kernel action.governedParameters → policy → committed decision → signed grant scope.parameters → exercise request (built from the verified request, orchestrator.ts exerciseFor) → containment (grant-exercise-assessment.ts parametersAgree)` and **stopped**: `ValidatedExecutionAction` (execution-adapter-port.ts) carried `boundedGrantId, subject, action, resource, counterparty?, organization?, amount?, notAfter, correlation` — no parameter list |
| Adapter limitation | Generic HTTP's closed source vocabulary (`contracts.ts` `EnterpriseGenericHttpActionSource`) named eleven action fields and no parameter; a deployment adapter had no way to put `replicaCount` in a request |
| P11 evidence limitation | `ExecutionAttemptRecord` (P11, schema v1) bound `organizationId, executionId, evaluationId, requestId, decisionId, boundedGrantId, action, amount?, preparedAt` — "the exact execution context" — and would have become incomplete the moment parameters reached an adapter |
| Three domains on the shipped Host | CORE-06 exercised settle × payables, read × customer data and deploy × production on one Host with a recording adapter; no domain reached a real adapter with typed parameters, the settlement domain used integer parameters rather than P9/P10 money, and the matrix was not a per-domain qualification |
| Revoked mid-flight per domain | CORE-06 qualified revocation after issuance for the settlement domain only (Q13); not per domain |

## 4. The execution-boundary extension

**Type.** `ValidatedExecutionAction.parameters?: readonly GovernedParameter[]` — the canonical `{ dimension, type, value }` of `src/features/governed-parameter-runtime`, reused; no second model, no domain-named field.

**Source — exercise-validated only.**

```
intent.parameters → trusted profile declaration → type validation (no coercion)
  → deterministic policy → committed decision (re-read, verified) → signed grant bounds
  → exercise request (from the VERIFIED committed request)
  → GrantExecutionService: snapshot once (fresh frozen copy) → containment → P7 → re-read → containment
  → ValidatedExecutionAction.parameters = the assessed snapshot → adapter
```

| Property | How |
|---|---|
| Canonical ordering, duplicate-free, dimension-bound | The exercise gate refuses a non-ascending or duplicated list as malformed and requires the list to equal the grant's bounded dimensions exactly, both directions |
| Type-preserving | Entries are copied field by field (`dimension`, `type`, `value`); an integer stays a safe integer (never `-0`), a token byte-exact, a boolean a boolean |
| Immutable, plain data | The action, its amount, correlation, parameter list and every entry are fresh frozen objects; no getter, Proxy, caller array, intent, grant or request reference crosses |
| No post-authorization substitution | `snapshotGrantExerciseRequest` reads the attempt **once** when the exercise begins; the assessment, the P7 input and the adapter input all read that copy. A caller mutating its objects during the store read or reservation changes nothing (measured with a mutation *inside* the await) |
| Presence | Exactly when the exercised grant bounds parameters; a legacy grant bounds none and can never deliver one |

The adapter port still carries no decision, status, policy result, approval, obligation state, trusted context, grant scope, source authorization, digest or Kernel handle (SEC-INV-187).

## 5. Generic HTTP parameter mapping

A closed binding kind, `{ kind: 'parameter', dimension, required? }` (path segments: `{ kind: 'parameter', dimension }`, always required). `dimension` must satisfy the canonical governed-dimension grammar and is compared by **exact equality** against each entry — never a property lookup, path, template, expression or callback. Full rules: `docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md` §4a.

| Position | Integer | Token | Boolean |
|---|---|---|---|
| Path segment (encoded, one segment) | `3` | `rolling` | `true` |
| Query value (encoded) | `3` | `rolling` | `true` |
| Header value (visible ASCII) | `3` | `rolling` | `true` |
| JSON body value | `3` (number) | `"rolling"` (string) | `true` (boolean) |

Required and absent → unbuildable, `ADAPTER_ERROR`, nothing sent. Optional and absent → field omitted; adapter optionality never weakens a profile's `required` (the envelope enforces that before any decision). All existing length, syntax, header and body bounds apply unchanged.

**Destination and credential (§12 / §G).** A parameter fills only a path segment, query value, header value or flat body value. Scheme, origin, hostname, port, resolver, selected address, TLS, redirects, proxy, credential, `Authorization`, header names, body keys, adapter id and route are snapshotted operator configuration, and no binding kind addresses any of them: `generic-http-parameter-mapping.test.ts` (“scheme, host and port come from the pinned origin whatever the parameter values are”, “a parameter cannot set Authorization, a credential header, a reserved header or a header name”, “the only configuration keys are the closed ones: no parameter-selected origin, adapter or route exists”).

## 6. P11 compatibility strategy — a versioned record format

Decision and full rationale: `docs/architecture/ADR-DURABLE-MONETARY-OUTCOMES.md` §14.

| | v1 (historical) | v2 (CORE-08) |
|---|---|---|
| Record `schemaVersion` | `aoc.execution-outcome-store.schema.v1` | `aoc.execution-outcome-store.schema.v2` |
| `parameters` | never — a v1 row carrying one is `EXECUTION_OUTCOME_CORRUPT` | the exact list the adapter received, canonical form |
| Attempt digest | `aoc.execution-outcome.attempt.v1`, formula unchanged | `aoc.execution-outcome.attempt.v2`, binds `parameters` or `null` |
| Store file | migrated on open: `ADD COLUMN parameters_json`, `migrated` history row, no row rewritten | fresh files are created at v2 |

Evidence is measured against a **real** pre-CORE-08 store: `src/enterprise/__tests__/fixtures/pre-core-08/p11-v1-execution-outcome-store.json` holds the DDL and rows written by the unmodified P11 runtime built from `8d99567` (`generatedBy`), including a monetary and a plain attempt with their terminal observations. An independent recomputation of the v1 formula reproduces every historical digest; after migration each legacy record reads back as v1, without a `parameters` key, verified; a retry that would re-prepare it with parameters is a conflict before the claim; a v1 row tampered to carry parameters is corrupt; an unknown file version is still refused unopened. P12 binds and resolves a v2 attempt by its digest, its selection context and query carry no parameters, and reconciliation never rebuilds or resends a payload (`execution-outcome-parameters.test.ts`).

## 7. Reference domains on one Host

One `bootEnterpriseHost()` in the `production` secure profile — SQLite everywhere, Ed25519-signed grants, external authority-state witness, P7 exercise controls, P11, emergency control — one listener, one Kernel instance, one policy runtime, one governed-action pipeline. Everything domain-specific is data handed through the Host's canonical inputs (`core08-reference-domains-fixture.ts`):

| | Treasury | DevOps | Data |
|---|---|---|---|
| Action × resource | `transfer-funds` × `treasury-operating-account` (financial, P9) | `deploy-release` × `production-cluster-eu` | `read-customer-records` / `export-customer-records` × `customer-records-eu` |
| Classes / profile | `transfer` × `treasury_account` / `treasury-transfer@1` | `deploy` × `production_environment` / `deploy-production@1` | `read` / `export` × `customer_dataset` / `customer-data-read@1`, `customer-data-export@1` |
| Material bound | `amount` (P9 canonical money) ≤ P10 authority ceiling `1000 USD` | `replicaCount` integer / maximum; `deploymentStrategy` token / exact | `recordCount` integer / maximum; `exportFormat` token / exact (export only) |
| Trusted facts (configured sources) | `invoice.approved` (ERP), `payee.approved` (payee registry) | `changeWindow.open` (change calendar), `rollback.available` (release controller) | read: `supportCase.open`; export: `exportDestination.approved`, `dataResidency.compliant` |
| Policy (one runtime, generic predicates) | deny unapproved invoice / payee | deny closed window, no rollback, `replicaCount > 10`, strategy ∉ {rolling, blue-green} | read: deny no case, `> 1000`; export: deny unapproved destination / residency, `> 100`, format ≠ csv |
| Authority | own lineage with `max_amount` + spending limit | own lineage | own lineage over both data resources |
| Adapter (Generic HTTP config) | `treasury-http`: `POST /v1/transfers`, amount as exact JSON number | `devops-http`: `PATCH /deployments/{resource}?strategy=`, `X-Replica-Count`, body `{strategy, replicas, requestId}` | `data-http`: `POST /v1/datasets/{resource}/jobs?limit=`, body `{operation, limit, format?, requestId}` |

**The network boundary, stated honestly (§53).** The three adapters are the production Generic HTTP adapter core — real snapshot, mapper, address policy, status classification — composed through `bootEnterpriseHost({ executionAdapters })`. Only the network runtime is replaced, through the adapter's internal test seam, by a deterministic fake provider that records the exact wire request and answers `200` from a pinned public address. The production Node HTTPS transport (fresh DNS, public-address policy, TLS, no redirects, no retries, bounded timeout) is unchanged and is exercised by the existing P6 suites, not here. This is **not** a real-provider end-to-end run.

## 8. Shared vs variable architecture (§11.6 items 2 and 3)

| SHARED — one implementation, one instance where stateful | Evidence it is shared |
|---|---|
| `GovernedActionIntent` envelope + customer admission | every case goes through `POST /api/governed-actions` as one principal |
| Kernel implementation **and instance** | `AocKernel.prototype.evaluate` observed: every domain's evaluation ran on one and the same instance (“one Kernel instance evaluated requests from all three domains; one policy runtime saw them all”) |
| Policy-engine implementation and runtime | one `PolicyPackRuntime`; its evaluations for all four actions observed through one provider |
| Decision model, Governance Store, BoundedGrant, grant authenticity, revocation model | one signed SQLite grant store; one revocation path (admin API) for every domain |
| Parameter containment architecture | one exercise gate; the same `maximum` bound governs replicas and records; money keeps P10 |
| Trusted Context Boundary, obligation and approval architecture | one boundary; per-profile material facts; obligations/approvals unused by these profiles (valid variation, §49) |
| Exercise runtime, emergency control, P7, write-ahead claim | one `GrantExecutionService`, one registry; adapter-scoped stops per adapter id |
| Outcome vocabulary, P11, P12, evidence lifecycle | `executed / execution-failed / execution-unconfirmed / withheld`; one P11 store at v2 |
| Generic CORE source | SHA-256 over the compiled generic CORE is byte-identical before and after all three domains ran (“the generic CORE source is byte-identical before and after all three domains ran”) |

| VARIABLE — data only | In this qualification |
|---|---|
| Governance Profile | four profiles in the governed-action file |
| Context-source configuration | six configured sources in `trustedContext` |
| Organization policy | twelve rules of one policy pack |
| Domain validation | Generic HTTP composition-time validation of each adapter's plan (dimension grammar, positions, bounds) — "can this already-authorized value be translated for this provider", never "is it authorized" |
| Execution Adapter configuration | three Generic HTTP configurations and four routes |

**One additional varying input, identified and justified:** the **durable authority world** (Kernel-Authority lineages, the treasury lineage's P10 `max_amount` and spending limit). It is organizational authority *data* — who may do what over which resource, and within which monetary ceiling — provisioned through the one provisioning service, evaluated by the one Kernel. It is part of "organization policy" in the Master Plan's sense (§4.2 "under whose authority"); no code varies. §11.6 remains satisfied.

## 9. Domain behaviour matrix (machine-checked)

Every cell is recorded by the test that proves it and checked by `core08-action-neutrality-host.test.ts` › “every cell is PASS, and read vs export was distinguished”; this table is compared with the suite's matrix by “the qualification document claims exactly the matrix this suite proves”.

<!-- core08-domain-matrix:start -->

| Row | Treasury | DevOps | Data |
|---|---|---|---|
| valid | PASS | PASS | PASS |
| policy-deny | PASS | PASS | PASS |
| over-bound | PASS | PASS | PASS |
| missing-fact | PASS | PASS | PASS |
| revoked-mid-flight | PASS | PASS | PASS |
| adapter-exactness | PASS | PASS | PASS |

<!-- core08-domain-matrix:end -->

| Row | Treasury | DevOps | Data |
|---|---|---|---|
| valid | TR-1: exactly one call to `treasury-http`, `amount {250.75, USD}` | DO-1: exactly one call to `devops-http` | DA-1 read, DA-2 export: one call each to `data-http` |
| policy-deny | TR-2 `TREASURY_PAYEE_NOT_APPROVED` → 0 calls | DO-2 `DEPLOY_STRATEGY_NOT_PERMITTED` → 0 | DA-3 `EXPORT_RESIDENCY_UNCONFIRMED` → 0 |
| over-bound | TR-3 `1000.01 USD` > P10 ceiling → withheld `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`; at exercise `GRANT_EXERCISE_AMOUNT_EXCEEDED` → 0 | DO-3 `replicaCount 11` → policy deny; `5` over a grant bounded at `4` → `GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE` → 0 | DA-4 read `1001`, export `101` → policy deny; `11` over a grant bounded at `10` → out of scope → 0 |
| missing-fact | TR-4 each of `invoice.approved`, `payee.approved` absent → `CONTEXT_REQUIRED_FACT_UNRESOLVED` | DO-5/6 each of `changeWindow.open`, `rollback.available` absent → same; attested `false` → policy deny | DA-5 `supportCase.open`; DA-6 each export fact → same |
| revoked-mid-flight | stranded grant revoked via admin API → `GRANT_EXERCISE_REVOKED`, 0 calls; control executes once | same | same (export grant) |
| adapter-exactness | `ValidatedExecutionAction.amount` exact, **no** `parameters` key; wire body `"amount":250.75`; P11 attempt amount exact | `parameters` = `[{deploymentStrategy, token, rolling}, {replicaCount, integer, 4}]`, frozen; wire `PATCH /deployments/production-cluster-eu?strategy=rolling`, `x-replica-count: 4`, body `{"strategy":"rolling","replicas":4,…}`; P11 v2 attempt binds the same list | read `[{recordCount, integer, 25}]` → `?limit=25`, body without `format`; export `[{exportFormat, token, csv}, {recordCount, integer, 40}]` → body `"format":"csv"` |

**Read vs export (DA-11).** Over the same resource: the read world (support case only) executes a read and leaves an export unresolved (`CONTEXT_REQUIRED_FACT_UNRESOLVED`); 150 records is allowed for a read and denied for an export; an export must state a format and a read may not; the two signed grants share the resource and differ in profile and action class. **DA-8** a read grant exercised as an export → `ACTION_OUT_OF_SCOPE` + `SEMANTIC_CLASS_MISMATCH`; **DA-9** an export grant over another data resource → `RESOURCE_OUT_OF_SCOPE`. No CORE branch distinguishes them — profile, facts and policy data do.

Additional treasury cases: TR-6 unknown asset `XRP` → 400; recognized `EUR` with no EUR ceiling on the lineage → withheld; other unit / counterparty / resource at exercise → withheld. TR-7 replay → answered from the record, no second call. Money stays money: the treasury profile declares no generic parameter, the grant ceiling is the authority's (P10) and the exact requested amount is what P11 prepared.

## 10. Revoked mid-flight, per domain

Technique (CORE-06 stranded grant, per domain adapter): an adapter-scoped emergency stop on **that domain's** adapter id withholds the request at the registry — after issuance, the P7 reservation and every exercise-gate check — so the request ends `withheld` with a genuine, issued, unexercised grant; the stop is released.

| Domain | Stranded intent | Before revocation | After `POST /api/admin/authority/grants/{id}/revoke` | Adapter calls | Control (not revoked) |
|---|---|---|---|---|---|
| Treasury | transfer `120 USD` | `assessExercise` usable | assessment and exercise: `withheld` / `grant-exercise` / `GRANT_EXERCISE_REVOKED`; caller retry answered from the record | 0 | executes exactly once |
| DevOps | deploy `2`, `blue-green` | usable | same | 0 | executes exactly once |
| Data | export `7` records | usable | same | 0 | executes exactly once |

The "before" assessment and the control prove the authoritative store is re-read at exercise and that each zero is load-bearing.

## 11. Cross-domain attacks

| Case | Attack | Observed | Adapter calls |
|---|---|---|---|
| CROSS-1 | deploy × customer records (with and without parameters) | 400 `rejected`, no decision — both classes declared, no profile governs the combination | 0 |
| CROSS-2 | read pinning `deploy-production@1`; deploy pinning `customer-data-export@1` | 400 | 0 |
| CROSS-3 | transfer carrying `replicaCount`; treasury grant exercised with `replicaCount` | 400; `GRANT_EXERCISE_PARAMETER_OUT_OF_SCOPE` | 0 |
| CROSS-4 | read grant exercised as export | `GRANT_EXERCISE_ACTION_OUT_OF_SCOPE` | 0 |
| CROSS-5 | read × cluster; export × treasury account; transfer × customer records | 400 `rejected` | 0 |
| CROSS-6 | `customer-data-read` at version 2; the right id and version with another digest at exercise | 400; `GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH` | 0 |
| CROSS-7 | read with `exportFormat`; deploy with `recordCount` | 400 | 0 |
| CROSS-8 | read grant exercised with the DevOps grant's parameter bounds; deploy grant over customer records | out of scope; `RESOURCE_OUT_OF_SCOPE` | 0 |

Also refused (400, 0 calls): any request field naming `adapterId`, `origin`, `url`, a mapping, headers, a provider credential, `payload` or `executionPayload`. The same idempotency key with changed parameters → 409/400, and the original replays (W).

## 12. Structural neutrality proof

`core08-action-neutrality-structure.test.ts` scans, comments stripped, every production source under `src/kernel`, `src/enterprise/governed-action`, `src/features/{grant,execution,governed-parameter}-runtime`, `src/enterprise/governance-profile`, `src/enterprise/{execution-outcome-store,execution-reconciliation,execution-resolution-store}` and the generic policy engine (`domain-policy-pack-runtime/{services,domain,runtime,integrations}`) for:

- **vocabulary:** treasur·, invoice, payable, xrp(l), lightning, `deploy` (the word — `deployment` is CORE's generic word for a Host installation and stays legal), deploymentStrategy, kubernetes/k8s, replica, cluster, rollback, change window, dataset, customer data/records, the `'export'` literal, exportFormat, recordCount, supplier;
- **branch shapes:** an action / class / profile / dimension / resource / adapter id compared with a literal (either side), a `switch` on any of them, a `case 'deploy'`-style label, `['deploy', …].includes(…)`;
- **primitives anywhere in production code:** no `Treasury|Deploy|CustomerData|Export…ExecutionAdapter|ExecutionRecord|PolicyEngine|Approval|…`, no `paymentSettled`-style outcome, no `executionPayload`-style field;
- **profile as data:** a profile carrying `authorize`, `parameterMapper`, `validate`, an expression or `execute` is refused at composition.

The detectors are tested against eleven real branch shapes (non-vacuity), and against prose and the two carve-outs (P9's `financial` classification; the pre-existing evidence-document kind `invoice`, §15). CORE-03's `governed-action-neutrality-structure.test.ts` still passes unchanged. The mutation campaign inserts real branches into real sources (§13, M23, M24).

**Same source (§33).** One build; no conditional or domain-specific CORE module; the compiled generic CORE hashes identically before and after the three domains ran (§8).

## 13. Mutation campaign

**Method.** Run on a clean `git archive` of the committed tree (`ec5b207`, plus the then-uncommitted ledger documents and the hardened mapping test) on a native filesystem, never on the working copy. For every mutation the runner recorded the SHA-256 of each file it would touch, applied an **exact single-occurrence** edit (an anchor found zero or several times is `NOT-APPLIED`, never guessed), rebuilt with `tsc -b` (a compile failure is `INVALID`, never counted as a kill), ran the named killing suites, restored the original bytes and re-verified each hash; the last step rebuilt from restored sources so no mutated output remained in `dist`. Afterwards the workspace was diffed against `git archive HEAD`: the only differences were the four intentionally uncommitted files. A suite whose `before()` hook aborted is `SUITE-ABORTED`, not a kill.

**Result: 36 mutations — 35 KILLED, 1 SURVIVED (M30a, explained and deepened into M30, KILLED).** Restoration hash = the first 16 hex digits of the original file's SHA-256, verified after every mutation.

| ID | Mutation (security property removed) | Result | Killing test(s) | Restored |
|---|---|---|---|---|
{table}

**Corrections made during the campaign (none counted as kills).**

- **M4, M6 — definitions corrected.** M4's first anchor matched twice (`NOT-APPLIED`); M6's first form did not type-check (`INVALID`). Both were rewritten as exact, compiling edits and re-run: KILLED.
- **M24, M24b, M29 — anchor corrected.** The first Kernel anchor matched two methods (`NOT-APPLIED`); anchored on `evaluate`'s signature and re-run: KILLED.
- **M17 – M19 — deepened past an independent layer.** Removing a material fact from a profile alone aborted the Host at startup: the governed-action file parser refuses a trusted-source attestation that no Governance Profile reads (`GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID`). That consistency check is a real, independent defence, but it proves nothing about the missing-fact tests. Each mutation was deepened to also remove that fact's attestation, so the Host boots with the requirement genuinely gone: KILLED by the domain's missing-fact test (and, for treasury and data, the policy-deny test whose rule reads the same fact).
- **M30a — survivor, defence in depth.** Removing the orchestrator's idempotency-conflict stop does not produce a second effect: the request identity is derived from the idempotency key (`deriveGovernedActionRequestId`), and the Governance Store's own idempotency record refuses a different request under it (`GOVERNANCE_IDEMPOTENCY_CONFLICT` → `rejected`). **M30** deepens it — rekeying both the request identity and the idempotency record by the parameter values — and is KILLED by “W — the same idempotency key with changed parameters is refused; the committed request is never reinterpreted”.
- **M10 — test hardened before the campaign.** The Authorization-mapping refusal was first asserted only with a bearer credential configured, where the credential-collision check also refuses; a credential-less case was added so the reserved-name rule is tested on its own.

**Mapping to the §67 list.** M1 … M13 as listed; M14 / M15 are the domains' own policy data and M14b the generic `maximum` bound; M16 the P10 ceiling; M17 … M19 the domains' material facts; M20 … M22 a per-domain skipped revocation check (each a literal domain branch in the generic exercise gate, so also caught structurally); M23 / M24 / M24b real branches inserted into the orchestrator and the Kernel; M25 … M32 as listed.

## 14. Validation

### 14.1 Focused regression matrix

Run on an LF export of the tree under test (the working-copy sources, no CRLF), one `node --test` invocation per group:

| Group | Suites | Tests | Pass | Fail |
|---|---|---|---|---|
| CORE-03 semantic parameters | envelope, semantics Host, neutrality structure, read/export thesis, profile registry, parameter runtime, Kernel semantics / legacy parameters / effective profile, policy parameter predicates | 126 | 126 | 0 |
| CORE-04 context & obligations | trusted-context / obligations / restrictive-signal / review-profile Hosts, trusted-context structure, discharge store / authenticity / scenario / record, Kernel context, policy context predicates | 162 | 162 | 0 |
| CORE-05 approvals | approvals Host + adversarial Host, approval gate, approval authenticity / lifecycle / structure | 81 | 81 | 0 |
| CORE-06 qualification | Governance Core Host, qualification structure (incl. the BLOCKED-claim ledger with the CORE-08 rows), BLOCKED-claim evidence | 59 | 59 | 0 |
| CORE-07 freshness | freshness Host, grants, enrollment, obligations/approvals, protocol, structure | 88 | 88 | 0 |
| Grant issuance / exercise / revocation | every grant-runtime and execution-runtime suite (incl. layer boundaries and the CORE-08 delivery suite) | 446 | 446 | 0 |
| Host governed actions & HTTP API | orchestrator, composition, API endpoint, enterprise Host, event stream | 349 | 349 | 0 |
| Generic HTTP | adapter, composition, CORE-08 parameter mapping | 211 | 211 | 0 |
| Emergency control | governed action, commit boundary, composition, durability | 113 | 113 | 0 |
| P7 exercise controls | governed action, SQLite, authority binding, composition, concurrency, resolution | 187 | 187 | 0 |
| P9 / P10 monetary | canonical semantics, exact JSON, payment ceilings + structure, monetary constraints | 160 | 160 | 0 |
| P11 outcomes | store, boundaries, concurrency, CORE-08 parameters, durable outcomes + e2e | 121 | 121 | 0 |
| P12 reconciliation | e2e, boundaries, resolution store | 95 | 95 | 0 |
| CORE-08 qualification | Host, structure | 58 | 58 | 0 |
| Security ledgers | security invariants, no-bypass effect paths | 63 | 63 | 0 |
| **Total** | | **2 319** | **2 319** | **0** |

### 14.2 Working copy

`npm ci` (clean install), typecheck and build (`tsc -b`) green; lint (Node16 imports, architecture, public surface) passed; `check-api-freeze` passed — **36 endpoints**, no route added; `check-release-docs` passed (24 documents); `check-sdk-surface` passed (5 frozen exports, zero dependencies) — no public SDK type changed; `legal:check` reports the two pre-existing advisory findings only (unnamed workspace manifests; busboy/streamsearch license metadata), no dependency added; `git diff --check` clean; no conflict markers.

Root suite on the working copy: **8 514 tests — 8 498 pass, 3 fail, 9 skipped, 4 todo.** The three failures, each explained: (1) CTRL-01 structure — "the HTTP adapter mounts administration only through the service" and (2) R004.B — "loadEnterpriseConfiguration never falls back to a hardcoded … API key" are source-regex tests over two files CORE-08 did not touch whose *working copies* carry CRLF line endings (`git ls-files --eol`: `i/lf w/crlf`) — the known Windows working-copy artifact recorded by CORE-06/07; (3) the CORE-08 matrix/document cross-check ran before this document existed, and passes (38/38) with it. Workspaces: **1 089 tests, 1 089 pass**, 0 fail.

### 14.3 Clean export

PENDING — filled after the clean-export run.

## 15. Residuals (retained; nothing erased)

- **Trusted Host / configuration boundary.** Governance Profiles, context sources, policy, authority provisioning and adapter configuration are trusted operator inputs; a compromised configuration governs wrongly by construction (**AA-002** — key and trust configuration control — unchanged). In-process Host code, including a host-written adapter, is TCB (SEC-TRUST-001).
- **CORE-06 residuals** stand as recorded in `CORE-06-GOVERNANCE-CORE-QUALIFICATION.md` §10; races inside one request remain qualified below the Host.
- **Target-system IAM** (the cluster, data platform, bank) is not CORE's (Master Plan §13).
- **Physical-system qualification** is not proven (OQ-15). **Rail neutrality** is not proven: treasury executes through Generic HTTP; XRPL and Lightning are not implemented by CORE-08 (PAY-04, PAY-06, PAY-07 → CORE PROVEN).
- **Three reference domains**, not every machine action.
- **Provider network runtime in the Host suite is a test seam** behind the real adapter core; no live provider was contacted.
- **P10 grant ceiling semantics are unchanged:** a treasury grant's ceiling is the authority's per-execution ceiling (`1000 USD`), not the requested amount; the exact amount is bound by the committed request and the P11 attempt, and a direct in-process exercise may state any amount up to the authority ceiling (P10 design, not a CORE-08 change).
- **P11 / P12 limitations unchanged:** integrity, not authenticity (a consistent re-seal of a row and its digest is undetected); no exactly-once; an unresolvable execution stays unresolved. New: an execution prepared under v1 and never claimed whose retry would now carry parameters is a conflict before the claim (fails closed; no effect).
- **Pre-existing evidence-document vocabulary.** The policy-pack evidence-requirement type union lists `invoice` (with `contract`, `purchase_order`, …) as a kind of source document, mapped uniformly to `source_document`; no authorization, routing or execution branch reads it. Exempted exactly, in two spellings, by the structural test; not changed ("fix only real gaps").
- **Classified-but-unprofiled combinations** are refused at the envelope (either side classified is enough); only a pair where **neither** the action nor the resource is classified is still governed without a profile (CORE-03 design) — safety there rests on authority lineages, which this qualification provisions per domain.

## 16. Verdict

PENDING — stated after validation.
