# No-Bypass Authority-Controlled Execution

- Status: canonical. This is the authoritative statement of **which effects exist in this repository, what authorizes each one, and which security claims that supports**.
- Produced by: Security & Containment Architecture track, Prompt 3.
- Base: `main` @ `ad3322a` (Prompt 0, 1, 2, 2.5 and 2.6 artifacts all present and merged).
- Method: read from current source. Every prior prompt's effect claim was re-verified rather than assumed; four are corrected below.
- Companion documents: `SECURITY_INVARIANTS.md` (canonical: what is guaranteed, at what scope), `TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` (canonical: trust domains, TCB, privileged assets), `AGENT_PASSPORT_WEB_THREAT_MODEL.md` (the SaaS surface), `THREAT_MODEL_V1.md`, `../../SECURITY_CONTAINMENT_BASELINE_AUDIT.md`.
- Production behaviour changed by this document: **none.** Documentation and structural tests only.

---

## 1. Purpose

This document answers one question, for every production-capable effect path in the repository:

> **What security boundary actually authorizes that effect?**

It exists because the previous prompts established a strong guarantee on **one** path and could not yet say what governs the others. Prompt 2 handed Prompt 3 a list of nine effect-capable paths and asked for each to be *proven or excepted*. This document does that, and enumerates the effect paths from source rather than from that list — which turned out to be incomplete in two places (§20, NB-003 and NB-004).

The output is deliberately uncomfortable in one respect: **most effect paths in this repository are not under bounded-grant control, and this document says so by name.** That is not a regression. Frontera has several deliberately separate authority domains. What was missing was a single artifact in which each one is named, scoped, and either proven or excepted, so that no reader — human, questionnaire, or coding agent — can mistake the strength of the bounded-grant path for a system-wide property.

There is no ambiguous middle category. Every effect path below carries exactly one classification.

---

## 2. Definition of No-Bypass

"No bypass" is **not**:

> we have an authorization API somewhere.

It is:

> **A protected effect cannot occur through an alternate path that avoids the security boundary whose guarantee we are claiming.**

Two consequences follow, and both govern every classification in this document.

**Authorization correctness is not a no-bypass proof.** A gate can be perfectly correct and completely irrelevant if the same protected resource is reachable around it. The question is never "is this check right?" but "is this check *unavoidable* for this resource?"

**A no-bypass proof is resource-centric, not module-centric.** The unit of analysis is the protected resource — the Pinata account, the Stripe merchant account, the issuer key, the grant store — and the proof obligation is to enumerate *every* way to reach it. §14 is therefore the heart of this document; §5 is its input.

### 2.1 Distinctions preserved from earlier prompts

Every one of these is load-bearing here and none is collapsed:

```
Intelligence  !=  Authority       determining what to do is not being permitted to do it
Capability    !=  Permission      being able to reach an effect is not being authorized to produce it
Intent        !=  Mandate         a declared purpose is not a grant; a mandate is held by a store
```

```
Authorization security  !=  Containment security
Authentication          !=  Authorization
Authorization           !=  Tenant isolation
Authorization           !=  Effect binding
Effect binding          !=  Containment
```

And, the distinction this prompt turns on:

```
DECLARED ACTION  !=  ACTUAL EXTERNAL EFFECT
```

A component that authorizes a *declaration* and then invokes an opaque executor has authorized the declaration. It has not observed the effect, and it must not be described as though it had. This is exactly the `AocKernel.enforce(request, executor)` boundary (§8).

### 2.2 The two questions a reader must be able to answer

After reading §5 and §17, a reviewer must be able to answer, without guessing:

1. Which effect paths are under Frontera bounded-grant control? (Three: EP-011, EP-012, EP-013.)
2. For every other effect, what authorizes it instead? (§17, one row each.)

---

## 3. Scope

**In scope.** Every production-capable effect path in this repository: `src/**`, `packages/**`, `apps/**`, `scripts/**`, `.github/workflows/**`, and the published `@aoc-enterprise/runtime` artifact surface.

**Method.** Keyword search was used to find candidates and was **not** treated as sufficient. Every candidate was followed through its call graph to the actual effect boundary — the SDK call, the store write, the filesystem call, the socket bind. Interface definitions were not accepted as endpoints.

Searched, among others: `fetch`, `axios`, `got`, `undici`, `node-fetch`, `node:http`, `node:https`, `node:net`, `node:tls`, `Stripe`, `PinataSDK`, `pinata`, `execute(`, `adapter.execute`, `sign`, `signer`, `createHmac`, `issue`, `credential`, `ensure*`/`create*`/`update*`/`delete*`, `writeFileSync`, `mkdirSync`, `rmSync`, `unlinkSync`, `child_process`, `exec`, `spawn`, `eval`, `new Function`, `vm`, `import(`, `setInterval`, `cron`, `queue`, `worker_threads`, `webhook`, `RPC`, `wallet`, `XRPL`, `chain`, `transaction`, `deploy`, `publish`.

**Out of scope.** Remediation. This document redesigns nothing, converges no authority path, and implements no containment. Where a gap is found, it is recorded as a finding (§20) and assigned to a later prompt (§21).

### 3.1 Two reachability surfaces, kept separate

This repository is consumed in two ways, and a path's reachability differs between them. Every row in §5 states which applies.

| Surface | What it is | What it can reach |
|---|---|---|
| **MONOREPO / IN-PROCESS HOST** | Code inside this repository, or a host composing it from a checkout | Everything under `src/**` and `packages/**`, by direct relative or workspace import |
| **PUBLISHED PACKAGE** | A consumer installing the `@aoc-enterprise/runtime` tarball | Only the nine subpaths in the package `exports` map: `.`, `./authorization`, `./audit`, `./crypto`, `./adapters`, `./runtime`, `./runtime-host`, `./kernel`, `./enterprise` |

The distinction is material and is verified in §7.3: **Sovereign Access and Content Protection ship inside the tarball's `dist/` but are reachable from neither surface of a published consumer** — no `exports` subpath resolves to them (Node refuses unlisted deep imports with `ERR_PACKAGE_PATH_NOT_EXPORTED`), and their runtime dependency `@aoc-enterprise/pinata-adapter` is neither a declared dependency nor one of the four `bundleDependencies`. A published consumer therefore cannot reach Pinata through Frontera at all.

---

## 4. Effect Taxonomy

Repository-specific. Every effect path in §5 is labelled with one or more of these.

| Label | Definition in this repository | Examples found |
|---|---|---|
| **EXTERNAL EFFECT** | A call that leaves this process to a system Frontera does not own, where the result is observable by a third party | Pinata SDK upload / unpin / temporary-access mint; Stripe checkout, portal, subscription and session calls |
| **SIGNING EFFECT** | Invocation of key material to produce a signature or MAC over a payload that will be presented as authentic | `createTestSigner(...).sign()` via `createIssuerSignerFromEnv()`; `signAgentPassportPayload` |
| **CREDENTIAL ISSUANCE EFFECT** | Minting a bearer value that grants future access | Pinata temporary access URL; registry admin access token; recovery code; buyer and admin session tokens; team invitation tokens |
| **AUTHORITY MUTATION** | A write that changes what a later authorization decision will conclude | Bounded grant issue/revoke; exercise-control reserve/settle/release (P7, local consumption state); governed-authority transitions; Kernel Authority provisioning; policy-pack save/activate; capability-token revoke/suspend; approval state; registry membership role; entitlement capacity; `setEmergencyDeny` |
| **PRIVILEGED INTERNAL EFFECT** | A state change that is security-relevant but confers no authority by itself | Agent Passport lifecycle transitions; assurance assessments, findings, manual reviews and signals; billing status |
| **PERSISTENCE EFFECT** | A durable local write — filesystem or SQLite — that is not itself a business effect | Governance Record append; evidence bundle rows; SQLite file and directory creation |
| **NON-EFFECTING EVALUATION** | Read-only or decision-only. Produces no external effect, mints nothing, and changes no authority | `AocKernel.evaluate()`; governance and evidence reads; `GET /api/checkout/session/[sessionId]` after the APW-001 remediation |

### 4.1 Audit persistence is not a business effect

Following the rule this prompt was given: a path is **not** classified as effecting merely because a record is written about it. `AocKernel.evaluate()` commits a Governance Record, and that commit is a PERSISTENCE EFFECT with its own entry (EP-002) — but the evaluation itself is NON-EFFECTING, because it invokes no executor, contacts no provider and mutates no authority (SEC-INV-008). Splitting them is what keeps SEC-INV-008 honest rather than convenient.

### 4.2 Deliberately empty categories

Verified absent from **all production TypeScript** in `src/`, `packages/` and `apps/`, and recorded here so the absence is a checked fact rather than an assumption:

| Category | Result |
|---|---|
| Blockchain / ledger transaction | **None.** No chain client, wallet, signer, nonce, sequence number or chain identifier exists. Test-enforced for layer E, the execution runtime and execution-governance (SEC-INV-025). |
| Shell / child process | **None.** `child_process`, `exec`, `spawn` appear only inside test assertions that ban them, and in `scripts/validate-publishability.mjs` (operator tooling, EP-029). |
| Arbitrary dynamic code | **None.** No `eval`, no `new Function`, no `vm`. Six `await import(...)` calls exist in `apps/agent-passport-web`, **every one with a constant string specifier** and none reachable by caller-controlled input (§15). |
| Scheduler / cron / queue / background worker | **None.** No `setInterval`, no cron library, no `worker_threads`, no queue client. Structurally banned in the execution runtime (SEC-INV-023). |
| Email / SMS / push notification | **None.** No mail transport, no notification client, no such dependency in any workspace. |
| Server-side outbound `fetch` | **None in `src/` or `packages/`.** Every `fetch(` in `apps/agent-passport-web` is in a `.tsx` client component calling the application's own API; the rest are in `scripts/` (operator tooling). |
| Deployment / publish effect from production code | **None.** Neither CI workflow publishes, deploys, or references a secret (`secrets.` appears zero times). |

The entire outbound network surface of this repository is **two SDKs**: `pinata` (one import site) and `stripe` (four construction sites). Both are enumerated in §14 and pinned by a structural test (§18).

---

## 5. Effect-Path Inventory

Fifty-three production-capable effect paths, enumerated from current source. Every one carries a stable `EP-` id and exactly one classification from §6.

`Reachable?` uses: **HTTP** (reachable over the network), **IN-PROCESS** (trusted host code only, no route), **PUBLISHED API** (reachable by a consumer of the published tarball), **OPERATOR** (a human running tooling), **NONE** (no production caller found).

### 5.1 Frontera Core — Enterprise HTTP host

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-001** | Kernel evaluation | `POST /api/governance/evaluate` → `evaluateGovernanceRequest` → `AocKernel.evaluate()` | None. Produces a decision | API key **if** `AOC_ENTERPRISE_REQUIRE_AUTH`; recognition-precedes-allow; narrowing-only composition | n/a — nothing is invoked | none | HTTP | **NON-EFFECTING** |
| **EP-002** | Governance Record commit | same route, after the decision | PERSISTENCE — append + hash chain, redacted before digesting | `authenticateAndAuthorize` (off by default); commit runs with `system: true`; `organization.id` comes **from the request body** | n/a | SQLite | HTTP | **DEPLOYMENT-GATED** |
| **EP-003** | Evidence bundle build | `POST /api/evidence/build` → `evidence.build` | PERSISTENCE — evidence rows | `resolveGovernanceAccessContext` → `{system:true}` when auth is off | n/a | SQLite | HTTP | **DEPLOYMENT-GATED** |
| **EP-004** | Evidence read / verify | `POST /api/evidence/verify`, `GET /api/evidence/:id` | None | same | n/a | SQLite | HTTP | **NON-EFFECTING** |
| **EP-005** | Governance reads | `GET /api/governance/{evaluations,decisions,requests}/:id`, `/verify` | None | `GovernanceReadService` + `canSeeRecord` | n/a | SQLite | HTTP | **NON-EFFECTING** |
| **EP-006** | Agent Passport issuance | `POST /api/passports` → `passports.issuePassport` | PRIVILEGED INTERNAL (A-07) | `resolveGovernanceAccessContext`, then `requireAccessToOrganization` **inside the store** | n/a | SQLite | HTTP | **DEPLOYMENT-GATED** |
| **EP-007** | Passport lifecycle transitions | `POST /api/passports/:id/{activate,suspend,reactivate,revoke,retire,verify,link-evidence,link-governance,views}` | AUTHORITY MUTATION + PRIVILEGED INTERNAL (A-07) | same; append-only, chained, attributable event log | n/a | SQLite | HTTP | **DEPLOYMENT-GATED** |
| **EP-008** | Assurance mutation | `POST /api/assurance/{assessments,assessments/:id/evaluate,assessments/:id/verify,findings/:id/events,manual-reviews,signals,subjects/:id/reassess}` | PRIVILEGED INTERNAL (A-08) | same; `requireAccessToAssuranceOrganization` inside the store | n/a | SQLite | HTTP | **DEPLOYMENT-GATED** |
| **EP-009** | HTTP listener bind | `createEnterpriseServer().listen()` | EXTERNAL — binds a socket; default `0.0.0.0:8787` | none — configuration only | n/a | OS network stack | IN-PROCESS / OPERATOR | **DEPLOYMENT-GATED** |
| **EP-010** | Store file + directory creation | 13 `sqlite-*-store.ts` modules, `existsSync`/`mkdirSync` at construction | PERSISTENCE — filesystem | none — paths come from boot configuration, never from a request | n/a | filesystem | IN-PROCESS | **DEPLOYMENT-GATED** |

### 5.2 Frontera Core — bounded-grant authority-controlled execution

No route issues, extends, revokes or exercises a grant *as a caller-held artifact* (SEC-INV-027). Since P5 the path has exactly **one** HTTP entry, EP-049, which enters at the top — customer admission, then the Governed Action Orchestrator — and reaches EP-011 only through a committed decision and a server-held grant.

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-011** | **Bounded-grant exercise** | `AuthorityControlledExecutionService.exercise()` → `GrantExecutionService.exercise()` → `ExecutionAdapter.execute()` — where that adapter may be the composite `createExecutionAdapterRegistry(...)`, which routes server-side to exactly one trusted child (§7.1) | EXTERNAL — whatever the host-supplied adapter translates the validated action into | Authoritative store re-read on **every** attempt + 12 fail-closed checks (§6 proof); plus, when composed, the operational emergency-control interlock at four checkpoints (§6.4 limit 4); plus, when composed (P7), exact-equality authority-binding revalidation before and after an atomic aggregate / velocity reservation, and an emergency re-check after it (§6.4 limit 1, EP-051) | **Yes** — the assessed action *is* the payload; 17-field whitelist; no free-form channel | host-supplied adapter → provider | IN-PROCESS | **PROVEN — PATH LOCAL** |
| **EP-012** | Bounded-grant issuance | `AuthorityControlledExecutionService.authorize()` → `GrantIssuanceService.issueGrant()` | AUTHORITY MUTATION (A-01) | Kernel decision + attenuation + synchronous `commitGuard` inside the store transaction + commit-time authority-binding **equality** | n/a | in-memory store | IN-PROCESS | **PROVEN — PATH LOCAL** |
| **EP-049** | **Customer governed action (HTTP)** — the first customer-facing HTTP route onto the bounded-grant path | `POST /api/governed-actions` → `AocEnterprise.governAction` → `CustomerIdentityAdmission.admit()` → `GovernedActionOrchestrator.govern()` → Kernel decision → **committed** Governance Record → bounded grant (ACE issuance core) → ACE exercise (EP-011) → `ExecutionAdapter` / registry child | EXTERNAL — the provider effect of EP-011; plus the PERSISTENCE of the committed record and execution references | `CustomerIdentityAdmission` (bound customer credential, **always**, independent of `AOC_ENTERPRISE_REQUIRE_AUTH`) + Kernel + persisted, re-verified decision + bounded grant + authoritative exercise + optional emergency control at four checkpoints (SEC-INV-055 … SEC-INV-061) | **Yes** — as EP-011; the request body is a closed intent that names no adapter, provider, destination, credential or payload | host-supplied adapter / registry children | HTTP — **capability-gated**: mounted only when customer identity admission **and** the orchestrator are composed | **PROVEN — PATH LOCAL** |
| **EP-050** | **Generic HTTP adapter outbound request (P6)** — the first concrete provider network effect Frontera itself ships, below the bounded-grant path | `POST /api/governed-actions` → `GovernedActionOrchestrator` → ACE exercise (EP-011) → `GrantExecutionService` → `ExecutionAdapterRegistry` (trusted routing + adapter-scoped emergency check) → Generic HTTP child (`generic-http-execution-adapter.ts`) → `node:https.request` in `src/enterprise/execution-adapters/generic-http/node-https-transport.ts` → one operator-pinned HTTPS origin | EXTERNAL — one HTTPS request to the configured provider | Everything EP-011 / EP-049 require, **plus**: operator-pinned `https:` origin (DNS hostname only), closed declarative mapping from `ValidatedExecutionAction` fields and literals, fresh DNS per execution with every answer public-address-checked and the approved IP bound to the socket, TLS verification on (`rejectUnauthorized: true` hardcoded in the transport, not configurable, immune to `NODE_TLS_REJECT_UNAUTHORIZED=0`), no redirect, no retry, no connection reuse, at most one request per `execute()` (SEC-INV-062 … SEC-INV-069); and, when P7 exercise controls are composed, the same request is reached only after a successful reservation (EP-051) and its outcome settles or releases that reservation — 200/201/204 and every unconfirmed status settle, an ordinary 4xx releases (SEC-INV-070 … SEC-INV-079). Still the same one effect path: no second adapter invocation site, no second network call site | **Yes** — as EP-011; the outbound request is built only from the validated action and operator constants; `boundedGrantId` and `assertedContext` are not mapping sources | the configured HTTPS provider | IN-PROCESS — **composition-gated**: exists only when a deployment configures `executionAdapterRouting.genericHttpAdapters`; reached from HTTP only through EP-049 | **PROVEN — PATH LOCAL** |
| **EP-051** | **Exercise-control reservation (P7)** — admission of aggregate capacity before any provider effect | `GrantExecutionService.exercise()` (EP-011, after containment and the emergency check) → `ExerciseControlGate.admit()` → binding revalidation #1 → trusted policy snapshot → `ExerciseControlLedgerPort.reserve` → `BEGIN IMMEDIATE` in `src/enterprise/exercise-control-ledger/sqlite-exercise-control-ledger.ts` | AUTHORITY MUTATION (A-28) — **restricting.** Consumes capacity; can only cause a later exercise to be withheld; cannot permit, issue or widen anything | Everything EP-011 requires, **plus** exact-equality authority-binding revalidation against the grant's `authorityBindingDigest`, a closed validated limit contract, and one atomic transaction across every applicable limit (SEC-INV-070 … SEC-INV-072, SEC-INV-076 … SEC-INV-079) | n/a — no provider | SQLite (`exerciseLedger.sqlitePath`) or a host-supplied ledger | IN-PROCESS — **composition-gated**: exists only when a deployment composes `exerciseControls`; reached from HTTP only through EP-049 | **PROVEN — PATH LOCAL** |
| **EP-052** | **Exercise-control settlement (P7)** — the terminal event for an effect that happened or may have happened | `GrantExecutionService` single finalization exit → `ExerciseControlGate.finalize({ kind: 'settle' })` → `ExerciseControlLedgerPort.settle` | AUTHORITY MUTATION (A-28) — **neutral.** Keeps the capacity consumed; never returns it | Reachable only after EP-051 admitted a reservation and the adapter reported `executed` or `execution-unconfirmed`; one immutable terminal event per reservation; conflicting transitions refused (SEC-INV-073, SEC-INV-074) | n/a | as EP-051 | as EP-051 | **PROVEN — PATH LOCAL** |
| **EP-053** | **Exercise-control release (P7)** — the terminal event that returns capacity | `GrantExecutionService` single finalization exit, or the gate after a failed binding re-check → `ExerciseControlLedgerPort.release` | AUTHORITY MUTATION (A-28) — **permitting direction.** Returns capacity to a bucket. The one write in P7 that can increase what later runs | Reachable only after EP-051, and only for `execution-failed` or a withholding after the reservation (binding re-check, emergency re-check, adapter-scoped stop) — never for an unconfirmed effect; never a deletion (SEC-INV-073, SEC-INV-074) | n/a | as EP-051 | as EP-051 | **PROVEN — PATH LOCAL** |
| **EP-013** | Bounded-grant revocation | `AuthorityControlledExecutionService.revokeGrant()` | AUTHORITY MUTATION (A-01) | Store idempotency; first revocation stands and is never re-dated | n/a | in-memory store | IN-PROCESS | **PROVEN — PATH LOCAL** |

### 5.3 Frontera Core — decision-time enforcement

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-014** | `AocKernel.enforce(request, executor)` | `AocKernel.enforce` → `AocGuard.enforce` → `GuardedExecutionService.run` | **Anything the process can reach.** The executor is a caller-supplied opaque closure | Full preflight over the **declared** `ActionDescriptor`; the executor is not invoked on any non-allow outcome (SEC-INV-009) | **No.** Nothing structural, cryptographic or runtime-level relates the closure's effect to the declaration (SEC-INV-010) | none of its own | PUBLISHED API (`./kernel`); **no in-repo production caller** | **PARTIALLY BOUND** |

### 5.4 Frontera Core — Sovereign Access (separate authority model, SC-002)

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-015** | Provider credential mint | `AccessGrantService.requestProviderCredential` → `executePinataProviderTranslation` → `PinataProviderClient` | EXTERNAL + CREDENTIAL ISSUANCE — a time-bounded Pinata access URL | `store.getGrant(context, id)` then `assertActive(grant.status)`; provider and CID read from the **stored grant**, never from the caller | Partial — resource id and capability come from the stored grant; `requestedDurationSeconds` comes from the caller | Pinata API | IN-PROCESS (monorepo only) | **EXCEPTED — SEPARATE AUTHORITY MODEL** |
| **EP-016** | Provider revocation enforcement | `AccessGrantService.revokeGrant` → `determineAndExecutePinataEnforcement` → `PinataProviderClient` | EXTERNAL — Pinata unpin / delete | Governance fact of revocation is persisted **first**, so a concurrent `requestProviderCredential` already denies before any provider call | Partial — target derived from the stored grant | Pinata API | IN-PROCESS (monorepo only) | **EXCEPTED — SEPARATE AUTHORITY MODEL** |
| **EP-017** | Access-grant lifecycle writes | `AccessGrantStore` issue / `beginRevocation` / `finalizeRevocationEnforcement` / `recordProviderCredentialIssuance` | AUTHORITY MUTATION (A-11) | `AccessGovernanceContext`, asserted by the in-process caller | n/a | SQLite | IN-PROCESS (monorepo only) | **EXCEPTED — SEPARATE AUTHORITY MODEL** |

### 5.5 Frontera Core — Content Protection (a **second** provider authority model — NB-003)

Not modelled by any prior security artifact. Prompt 2 §8 Path D named Sovereign Access as *the* separate provider path; there are two.

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-018** | Ciphertext upload | `ContentProtectionService.protectResource` → `ContentStoragePort.store` → `createPinataContentStorageAdapter` → `PinataProviderClient.uploadCiphertext` | EXTERNAL — bytes leave the process to Pinata | **Only** `requireContentProtectionAccessToOrganization(context, organizationId)` — a caller-asserted tenant scope check. **No grant of any kind**, no `EnterpriseAccessGrant`, no `assertActive`, no Kernel decision | Weak — the adapter uploads exactly the bytes it is handed and cannot tell ciphertext from plaintext; only `service.ts`'s call ordering guarantees ciphertext | Pinata API | IN-PROCESS (monorepo only) | **EXCEPTED — SEPARATE AUTHORITY MODEL** |
| **EP-019** | Protected-resource store writes | `createPending` / `markActive` / `markOrphaned` / `markFailed` | PRIVILEGED INTERNAL | same tenant-scope check | n/a | SQLite | IN-PROCESS (monorepo only) | **EXCEPTED — SEPARATE AUTHORITY MODEL** |

### 5.6 Frontera Core — the raw provider seam

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|---|
| **EP-020** | Direct Pinata client construction | `createPinataProviderClient({ jwt })` → `new PinataSDK({ pinataJwt })` | EXTERNAL — the unmediated egress primitive that EP-015, EP-016 and EP-018 all sit on top of | **None.** Possession of `PINATA_JWT` is sufficient | none | Pinata API | IN-PROCESS (monorepo only) | **DEPLOYMENT-GATED** |

### 5.7 Frontera Core — authority-write surfaces with no route

Each of these mutates state that a later authorization decision reads. None is HTTP-reachable. Each is classified DEPLOYMENT-GATED because the *principal* is asserted by the composing host rather than established by the module — see §6.1 for why that is not "PROVEN".

| ID | Effect path | Entry point | Effect | Authority gate | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|
| **EP-021** | Durable Kernel Authority provisioning | `KernelAuthorityProvisioningService` | AUTHORITY MUTATION (A-02, durable) | Requires `context.system === true` **and** an operator identity, enforced **in the store**, so a caller bypassing the service still cannot write | SQLite | IN-PROCESS | **DEPLOYMENT-GATED** |
| **EP-022** | Governed-authority transitions | `GovernedAuthorityStore` reservation / encumbrance transitions | AUTHORITY MUTATION (A-02) | `requireAuthorityAccessToOrganization(context, tenantId)` on every method; `context.system` additionally required for `administrative` bases; capacity conservation and digest re-seal inside the transaction | SQLite | IN-PROCESS | **DEPLOYMENT-GATED** |
| **EP-023** | Policy-pack writes | `PolicyPackRegistry.savePack` / `saveVersion` / `activatePolicyPackVersion` | AUTHORITY MUTATION (A-05) — rewrites the rules decisions are made under | **None. No caller-identity parameter exists.** Protected only by not being exposed | in-process store | IN-PROCESS | **DEPLOYMENT-GATED** |
| **EP-024** | Recognition capability tokens | `capability-token-service` issue / revoke / suspend | AUTHORITY MUTATION (A-04) | none — in-process, no identity; state is a non-durable `Map` | in-process | IN-PROCESS | **DEPLOYMENT-GATED** |
| **EP-025** | Approval state | `ApprovalRuntime` state changes | AUTHORITY MUTATION (A-06) | in-process | in-process | IN-PROCESS | **DEPLOYMENT-GATED** |
| **EP-026** | Emergency deny (Action Enforcement) | `ActionEnforcementRuntime.setEmergencyDeny` | AUTHORITY MUTATION (A-10) | none — instance field, no identity, not durable, **not consulted by EP-011** | in-process | IN-PROCESS; only non-test caller is a demo scenario | **DEPLOYMENT-GATED** |
| **EP-047** | Emergency control activate (bounded-grant path) | `AocEnterprise.emergencyControlAdministration.activate()` → `EmergencyControlStorePort.activate` | OPERATIONAL MUTATION (A-10) — **restricting only.** Sets a stop that can withhold execution on EP-011; it cannot permit anything, cannot issue or widen a grant, and cannot alter a decision | Composing-host discipline. The writer is on the operator side of the trust boundary: no route, no SDK method, no intent field, and the execution path is typed against the **reader** port, which declares no mutation (SEC-INV-051) | SQLite when `persistence.provider === 'sqlite'`; process-local otherwise | IN-PROCESS, operator-only | **DEPLOYMENT-GATED** |
| **EP-048** | Emergency control release (bounded-grant path) | `AocEnterprise.emergencyControlAdministration.release()` → `EmergencyControlStorePort.release` | OPERATIONAL MUTATION (A-10) — **permitting direction.** Clears a stop, restoring execution under grants that were never revoked. The one write in this pair that can increase what runs, and therefore the one that a deployment must protect operationally | Same as EP-047. Note the asymmetry: a writer with raw database access can also clear a control by deleting its row, which the record digest cannot detect (`AOC_EMERGENCY_CONTROL.md` §8) | as EP-047 | IN-PROCESS, operator-only | **DEPLOYMENT-GATED** |

### 5.8 Frontera Core — port-shaped signing with no shipped implementation

| ID | Effect path | Entry point | Effect | Authority gate | External dependency | Reachable? | Class |
|---|---|---|---|---|---|---|---|
| **EP-027** | Runtime host signing | `createAocEnterpriseRuntime(ports)` → `signPayload` → `RuntimeSignerPort.sign()` | SIGNING — over grant, delegation and claim payloads | Whatever the host's injected signer does. **Frontera ships no implementation of this port** | host-supplied | PUBLISHED API; **no production caller in this repository** (only `examples/`, `tests/`) | **DEAD / UNREACHABLE** |

### 5.9 Operator and build surfaces

| ID | Effect path | Entry point | Effect | Authority gate | Reachable? | Class |
|---|---|---|---|---|---|---|
| **EP-028** | Backup / restore tooling | `scripts/portability/backup-enterprise-v1.mjs`, `restore-enterprise-v1.mjs` | PERSISTENCE — full read/write over the data directory, including `rmSync` and `renameSync` | Filesystem permissions only | OPERATOR | **DEPLOYMENT-GATED** |
| **EP-029** | Build / release / measurement tooling | `clean.mjs` (`rmSync`), `generate-release-manifest.mjs` (`writeFileSync`), `benchmark-enterprise.mjs` and `load-test-enterprise.mjs` (temp dirs + `fetch` to a locally started host), `validate-publishability.mjs` (`spawnSync`) | PERSISTENCE; loopback HTTP | Filesystem permissions only | OPERATOR | **DEPLOYMENT-GATED** |
| **EP-030** | CI workflows | `.github/workflows/{ci,publishability}.yml` | None outside the runner. Build and test only — **no publish, no deploy, and `secrets.` appears zero times** | GitHub `GITHUB_TOKEN`, default scope (no `permissions:` block — TB-007) | CI | **NON-EFFECTING** |
| **EP-031** | Non-production file writes | `packages/control-plane/store.ts`, `packages/commercial-demo/src/cli.ts` | PERSISTENCE | none | **NONE** — both packages are `private: true`; `control-plane/store.ts` has zero importers anywhere | **DEAD / UNREACHABLE** |

### 5.10 Agent Passport Web — separate application TCB (TZ-2 / D-14)

Every row here is **EXCEPTED — SEPARATE AUTHORITY MODEL** unless stated. None of these paths reaches `AocKernel`, a `BoundedGrant`, or `GrantExecutionService`; see §10 for why that is an exception and not a bypass.

| ID | Effect path | Entry point | Effect | Authority gate | Effect binding | External dependency | Class |
|---|---|---|---|---|---|---|---|
| **EP-032** | Stripe checkout session create | `POST /api/checkout/session` | EXTERNAL — Stripe | **None. Fully unauthenticated** | Price ids server-side from `pricing.ts`; no caller-supplied customer or price | Stripe | EXCEPTED |
| **EP-033** | Stripe billing portal session | `POST /api/organization-registry/:id/billing/portal` → `stripe-billing-service.ts` | EXTERNAL — Stripe | Session cookie + `registry:manage_billing` | Customer id server-derived from the registry billing profile | Stripe | EXCEPTED |
| **EP-034** | Stripe session retrieve + credential rotation | `POST /api/organization-registry/recover` | EXTERNAL — Stripe; **CREDENTIAL ISSUANCE** — new admin token + recovery code | Recovery code + contact email, **or** Stripe session id + contact email with a live `payment_status === 'paid'` check | Registry resolved from the purchase, not from the caller | Stripe | EXCEPTED |
| **EP-035** | Stripe webhook ingestion | `POST /api/stripe/webhook` | EXTERNAL (subscription retrieve) + PRIVILEGED INTERNAL — creates registries, entitlements, billing state; **the sole registry-creation path** | `stripe.webhooks.constructEvent` over the raw body; 503 when unconfigured; replay-blocked by `UNIQUE(stripe_event_id)` | Tenant server-derived from the event's own ids | Stripe | EXCEPTED |
| **EP-036** | Passport enrolment (route) | `POST /api/agent-passports` | **SIGNING** + PRIVILEGED INTERNAL + AUTHORITY MUTATION (capacity decrement) | Registry admin token **or** Stripe `session_id` — both possession-only bearers | n/a | issuer HMAC secret | EXCEPTED |
| **EP-037** | Passport enrolment (**server action**) | `enrollAgentAction` in `app/enroll-agent/actions.ts` (`'use server'`) | Same effects as EP-036 | Same two credentials | n/a | issuer HMAC secret | EXCEPTED — **NB-004: absent from the 35-endpoint inventory** |
| **EP-038** | Public passport verification | `GET /api/agent-passports/:id/verify` | **SIGNING** (verification-side HMAC recomputation) + PRIVILEGED INTERNAL (verification event row) | **None — public by product design** | n/a | issuer HMAC secret | EXCEPTED |
| **EP-039** | Admin credential rotation | `POST /api/organization-registry/:id/admin-access/rotate` | **CREDENTIAL ISSUANCE** — mints a replacement owner-equivalent token | Current admin token **or** recovery code | n/a | — | EXCEPTED |
| **EP-040** | Admin session mint | `POST /api/organization-registry/:id/admin-session` | **CREDENTIAL ISSUANCE** — `aoc_registry_admin_session` cookie | Admin token | n/a | — | EXCEPTED |
| **EP-041** | Account signup / login | `POST /api/account/{signup,login}` | **CREDENTIAL ISSUANCE** — buyer session token | Password (scrypt, `timingSafeEqual`) | n/a | — | EXCEPTED |
| **EP-042** | Team membership and invitations | `POST .../team/invitations`, `.../invitations/:id/revoke`, `.../members/:id/role`, `DELETE .../members/:id`, `POST /api/team-invitations/accept` | AUTHORITY MUTATION — registry roles; **CREDENTIAL ISSUANCE** — invitation tokens | Session + `registry:{invite_team,manage_team}` | n/a | — | EXCEPTED |
| **EP-043** | Export artifacts | `POST,GET /api/organization-registry/:id/exports`, `GET .../exports/:exportId` | PRIVILEGED INTERNAL — artifact rows with `checksum_sha256`; the only `DELETE` in the schema | Admin token | n/a | — | EXCEPTED |
| **EP-044** | Registry profile / enrolment access | `PATCH .../profile`, `POST .../enrollment-access` | PRIVILEGED INTERNAL | Admin token or admin session | n/a | — | EXCEPTED |
| **EP-045** | Checkout status read | `GET /api/checkout/session/:sessionId` | **None.** Read-only after the Prompt 2.6 remediation — creates no registry, mints no credential, names none in its response | Unauthenticated, and therefore read-only by construction | n/a | — | **NON-EFFECTING** |
| **EP-046** | Web store file + directory creation | `lib/db.ts` `mkdirSync` at `AOC_AGENT_PASSPORT_DB_PATH` | PERSISTENCE | none — boot configuration | n/a | filesystem | **DEPLOYMENT-GATED** |

### 5.11 Classification totals

| Classification | Count | Effect paths |
|---|---|---|
| PROVEN | **0** | — |
| PROVEN — PATH LOCAL | **8** | EP-011, EP-012, EP-013, EP-049, EP-050, EP-051, EP-052, EP-053 |
| EXCEPTED — SEPARATE AUTHORITY MODEL | **18** | EP-015…EP-019, EP-032…EP-044 |
| PARTIALLY BOUND | **1** | EP-014 |
| DEPLOYMENT-GATED | **19** | EP-002, EP-003, EP-006…EP-010, EP-020…EP-026, EP-028, EP-029, EP-046, EP-047, EP-048 |
| NON-EFFECTING | **5** | EP-001, EP-004, EP-005, EP-030, EP-045 |
| DEAD / UNREACHABLE | **2** | EP-027, EP-031 |
| **Total** | **53** | |

**Eight of fifty-three effect paths are under bounded-grant control.** That is the single most important number in this document, and every external statement about Frontera's execution control must be consistent with it.

*P7 changed this number from five of fifty to eight of fifty-three.* The three additions, EP-051 … EP-053, are the exercise-control ledger's reserve, settle and release writes: **local authority-state writes, not provider effects.** They are inventoried because they mutate state a later execution reads — the criterion §5.7 applies to EP-021…EP-026 and Prompt 4 applied to EP-047/EP-048 — and they are split by direction for the reason EP-047/EP-048 are: reservation only restricts, settlement is neutral, and release is the one write that can increase what later runs. They are counted in the numerator because, like EP-012 and EP-013, they are reachable **only inside** the bounded-grant gate, after the authoritative grant re-read and containment. P7 added no provider effect path: EP-050 is still the one network call site and EP-011 the one gate, and P7 does **not** retroactively govern Pinata, Stripe, Sovereign Access, Content Protection, `enforce()` or application networking.

*P6 changed this number from four of forty-nine to five of fifty.* The one addition, EP-050, is the Generic HTTP Execution Adapter's outbound HTTPS request — the first concrete network effect site Frontera itself ships. It is counted in the numerator because it is reachable **only** below the bounded-grant path: from the registry, after the authoritative grant re-read, the usable-assessment gate and the adapter-scoped emergency check (§7.6). Constructing or adopting this adapter does **not** retroactively govern Pinata, Stripe, Sovereign Access, Content Protection, `enforce()` or arbitrary host egress: every other path is exactly as classified above, and SEC-INV-U03 (a controlled network egress boundary) remains unimplemented. What P6 adds is application-level destination control for one adapter — "when the governed-action path routes through a Generic HTTP adapter, that adapter can contact only its configured HTTPS origin, subject to its public-address policy" — not a firewall.

*P5 changed this number from three of forty-eight to four of forty-nine.* The one addition, EP-049, is `POST /api/governed-actions` — the first customer-facing HTTP route onto the bounded-grant path. It is counted in the numerator because it **is** that path, entered from the top: it reaches a provider only through EP-011, after customer admission, a committed Kernel decision and a server-held bounded grant. It does **not** mean any other effect path became governed: `enforce()`, Sovereign Access, Content Protection, the raw provider seam, the authority-write surfaces and Agent Passport Web are exactly as classified above, with every path-local caveat intact.

*Prompt 4 changed this number from forty-six to forty-eight, and did not change the numerator.* The two additions are EP-047 and EP-048, the operator write surface of the emergency-control interlock. They are inventoried because they mutate state a later execution reads, which is exactly the criterion §5.7 applies to EP-021…EP-026 — not because any new way to reach a provider appeared. The server-side execution adapter registry added **no** effect path: it introduces no entry point, no egress site and no provider, and the children a deployment registers are the same trusted host code a single `executionAdapter` always was (§7.1).

---

## 6. Bounded-Grant Execution Proof

The claim being proven, stated at exactly its real scope:

> **On the bounded-grant authority-controlled execution path, an `ExecutionAdapter` is not invoked unless the authoritative current grant, re-read from the store at that instant, covers the exact assessed action — and every value crossing the adapter boundary is either a value the assessment proved inside a bound or a value read from the trusted grant.**

It is **PATH-LOCAL**. It says nothing about EP-014, EP-015, EP-018, or any path in §5.10.

### 6.1 Why this path can be PROVEN when §5.7 cannot

The distinction is where the principal comes from.

- On EP-021 and EP-022 the caller **asserts** its own authority (`context.system`, `context.organizationId`). The check is real code, but the thing it checks is a claim the caller made about itself. The boundary is therefore only as strong as the host's composition discipline, which is not enforced by application code. That is DEPLOYMENT-GATED.
- On EP-011 the caller asserts **nothing about its authority**. It supplies a grant *identifier* and a description of the *attempt*. The authority is read from the store, and the attempt is what gets checked against it. There is no field on `GrantExerciseRequest` through which a caller can describe itself as more privileged. That is what makes the proof structural rather than conventional.

### 6.2 The fourteen required checks, each verified against current source

| # | Required property | Verified | Evidence |
|---|---|---|---|
| 1 | Caller supplies a grant **id**, not grant contents | ✅ | `GrantExerciseRequest` (`grant-exercise-request.ts`) declares exactly `boundedGrantId`, `subject`, `action`, `resource`, `counterparty?`, `organization?`, `amount?`, `correlation`, `executionId`. No `scope`, `expiresAt`, `issuedAt`, `digest`, `sourceDigest`, `notAfter` or `revocation` field exists |
| 2 | Authoritative grant re-read from the store on **every** attempt | ✅ | `grant-execution-service.ts:154` — `read = await store.read(request.boundedGrantId)` inside `exercise()`, not at construction. No memoisation anywhere in the module |
| 3 | Grant identity and integrity checked | ✅ | `grant-exercise-assessment.ts:119` `boundedGrantDigestMatches(grant)` — checked **first**, because every bound below is read off the same fields. `:134` subject equality. `:137` four-field correlation equality against the trusted grant |
| 4 | Expiry checked | ✅ | `:128-130`. A malformed instant on **either** side makes the grant unusable, not usable-forever |
| 5 | Revocation checked | ✅ | `:123` — presence of the revocation record beside the grant is the whole of the check |
| 6 | Action assessed against **current** grant bounds | ✅ | `:142-156` — five axes (`action`, `resources`, `counterparty`, `organization`, `amount`), each fail-closed: absence on either side refuses, and `incomparable` is treated exactly as `broader` |
| 7 | Every field crossing the boundary is represented in the assessed action model | ✅ (with NB-007) | Of the nine fields on `ValidatedExecutionAction`: `subject` and `notAfter` are **read from the store**; `action`, `resource`, `counterparty`, `organization`, `amount` were each bound-checked; `boundedGrantId` is the id that was read; `correlation.requestId`/`decisionId` were equality-checked against the grant. `correlation.executionId` is caller-supplied and checked only for non-emptiness — it is a correlation label with no authority meaning (NB-007) |
| 8 | No free-form payload bypass | ✅ | `execution-adapter-port.ts` declares no `payload`, `blob`, `rawBody`, `opaqueRef` or `commandRef`; `execution-layer-boundaries.test.ts:352-396` bans that vocabulary and whitelists exactly 17 field names |
| 9 | Adapter invoked only after a successful assessment | ✅ | `grant-execution-service.ts:176` returns `{status:'withheld'}` on `!assessment.usable`; the single `adapter.execute(action)` is at `:198`, after it, in the same function |
| 10 | No alternate method invokes the same adapter before or without the assessment | ✅ **within this repository** | Repository-wide scan: exactly **two** production sources call an `ExecutionAdapter` — `grant-execution-service.ts` (the gate) and `execution-adapter-registry.ts` (the composite it may route through, reachable only from the gate, after routing and after the adapter-scoped interlock). See §7.1 for the enumeration and §7.4 for the one bypass primitive that lies outside the repository |
| 11 | No cache permits use after revocation | ✅ | No cache, no fast path, no `already-checked` short-circuit exists in the module. The read is unconditional |
| 12 | Correctness does not depend on a background revocation sweeper | ✅ | `execution-layer-boundaries.test.ts:291-299` bans timers, schedulers, jobs and sweepers structurally. Expiry and revocation are both *derived at read time* from the record the store holds now |
| 13 | Repeated-exercise behaviour accurately documented | ✅ **as of this document** (NB-006) | There is **no consumption model** — no counter, no remaining-uses, no replay ledger — and `execution-layer-boundaries.test.ts:311-319` bans one structurally. A usable grant may therefore be exercised an **unbounded** number of times within its validity window. §6.4 states this as a first-class limit |
| 14 | The effect payload is the assessed payload, not reconstructed afterwards | ✅ | `grant-execution-service.ts:184-194` builds `action` only from fields the assessment compared plus `grantSubject`/`grantExpiresAt` read from the store. Nothing is re-read from an untrusted source between the assessment and the call |

### 6.3 The clock ordering, which is part of the proof

`exercise()` samples the clock **after** the awaited store read (`:154` then `:158`), and the one instant it yields is what both the assessment and the outcome carry. Sampling before the read would judge the grant at a moment that had already passed by the time the record arrived — on a slow durable store, long enough to let an expired grant reach the adapter. `execution-exercise.test.ts:313` exercises exactly that case with a deliberately slow store.

### 6.4 What this proof does **not** say

Four limits travel with the claim and must be repeated wherever it is repeated.

1. **It is per-attempt, not aggregate — unless P7 exercise controls are composed.** Without them, a grant for `transfer` / `7500 USD` authorises an unlimited number of 7500-USD transfers until it expires or is revoked: SEC-INV-011's "covers the exact attempted action at that instant" is true of each attempt and silent about the sequence (NB-006). *Updated by P7:* when a deployment composes `exerciseControls`, the sequence is bounded too — host-declared aggregate count, amount and rolling-velocity limits admitted through an atomic, durable reservation before the adapter, with exact-equality revalidation of the grant's authority binding before and after it (EP-051 … EP-053, SEC-INV-070 … SEC-INV-079, `docs/enterprise/AOC_EXERCISE_CONTROLS.md`). That is path-local and opt-in; aggregate bounding anywhere else remains SEC-INV-U06.
2. **The adapter is trusted code.** The boundary constrains what data may cross it; it does not verify what the adapter then does with it (SEC-TRUST-006). Frontera ships **no** `ExecutionAdapter` implementation at all — every one is host code.
3. **The authoritative store is the root of the whole proof, and its integrity is unkeyed.** *Updated by Prompt 4:* a durable implementation now exists (`createSqliteBoundedGrantStore`) and is selected when `persistence.provider === 'sqlite'`; the in-memory store remains the default for every other provider. Under **either**, integrity rests on an unkeyed SHA-256 digest, so a writer who can re-digest can re-seal (SEC-TRUST-002). That half is now **GS-001**, owned by Prompt 5. See `docs/security/AUTHORITATIVE_GRANT_STORE.md` (NB-009, §21).
4. **There are now two separate stops, and only one of them reaches this path.** *Updated by Prompt 4.* A durable operational interlock (`EmergencyControlReaderPort`, `docs/enterprise/AOC_EMERGENCY_CONTROL.md`) **is** consulted by this path when a deployment composes it — at admission, inside the bounded-grant commit guard, after the authoritative grant re-read and before the provider, and again at the selected child adapter — and an emergency state that cannot be read withholds rather than permits (SEC-INV-043 … SEC-INV-052). It is **opt-in**: a deployment that does not compose it gets no checks. The older process-local `emergencyDeny` (EP-026) remains consulted by the enforcement preflight and **not** by this path, and the two are not wired together, so "Frontera has one kill switch" is still false (SEC-INV-U05).

5. **Routing chooses where, never whether.** When the composite registry is composed, which provider receives the effect is decided by trusted host configuration from fields the grant already contained. No caller input selects an adapter, and a routing failure is an infrastructure failure rather than an authorization outcome (SEC-INV-039 … SEC-INV-042, `docs/enterprise/AOC_EXECUTION_ADAPTER_REGISTRY.md`).

### 6.5 Verdict

**BOUNDED-GRANT NO-BYPASS PROOF: YES** — path-local, repository-scoped, with the five limits in §6.4 and the host-held adapter reference in §7.4 named as its boundary. Prompt 4 added a hop below the gate (the composite registry) and an interlock that can only withhold; neither widens the claim, and §7.1 and §7.4 are the places that say so.

---

## 7. Adapter Reachability

This section carries more of the no-bypass weight than §6 does. A perfect gate is worthless if the gated resource is reachable around it.

### 7.1 Every `ExecutionAdapter` reference in the repository

Repository-wide scan of `src/`, `packages/` and `apps/` for the type name and for any invocation of it:

| File | Role |
|---|---|
| `src/features/execution-runtime/domain/execution-adapter-port.ts` | The port declaration itself |
| `src/features/execution-runtime/domain/index.ts` | Re-export |
| `src/features/execution-runtime/services/grant-execution-service.ts` | Holds the adapter, and **invokes it** — the gate, after the authoritative store read and the usable-assessment gate |
| `src/features/execution-runtime/services/execution-adapter-registry.ts` | **The composite.** Satisfies the port itself, resolves one registered child by trusted server-side routing, and **invokes that child** — after routing and after the adapter-scoped emergency-control gate |
| `src/features/execution-runtime/services/index.ts` | Re-export of the registry factory and its option types |
| `src/enterprise/execution-governance/service.ts` | Holds an `ExecutionAdapter` as `options.executionAdapter` and passes it straight into `createGrantExecutionService`. **Never invokes it** |
| `src/enterprise/composition/composition-root.ts` | Type position. Builds the registry from the host's trusted routing table when one is configured — including one child per `genericHttpAdapters` entry (P6) — and hands the result to ACE. **Never invokes it** |
| `src/enterprise/execution-adapters/generic-http/generic-http-execution-adapter.ts` | **Implements** the port (P6). A registry child built by the composition root; invokes no adapter. Its one outbound network call is EP-050, enumerated in §7.6 |
| *(not `src/enterprise/index.ts`)* | The Enterprise barrel deliberately re-exports **no** `src/features` type — not `BoundedGrantStorePort`, not `KernelGrantCapability`, not `ExecutionAdapter` — even where an exported option type already names one. A host that needs to write an adapter imports the feature module, which is not a frozen artifact |
| `src/features/execution-runtime/tests/execution-fixture.ts` | Test fixture (`RecordingExecutionAdapter`) |

**Production invocation sites: exactly two, and the second is reachable only through the first.** Every other reference is a type position, a re-export, or a pass-through.

`no-bypass-effect-paths.test.ts` pins this list, pins both call sites, and additionally pins the ordering *inside* the registry: selection, then the unresolved-route refusal, then the emergency-control read, then the gate on it, and only then the single child invocation. `security-invariants.test.ts` independently pins that the registry reads no store, resolves no grant and holds no clock.

**This is not a second way in.** `GrantExecutionService → registry → child adapter` is **one composite provider boundary**: the registry has no other caller, no HTTP route, no export path a customer package reaches, and no input but the `ValidatedExecutionAction` the gate built. What the second call site adds is a hop *below* the gate, not a route *around* it.

**No new effect path was created.** The registry introduces no entry point, no egress site and no provider of its own; the children a deployment registers are the same trusted host code a single `executionAdapter` always was. EP-011's row is unchanged apart from the extra hop, and the inventory's totals in §5.11 are unchanged.

### 7.2 The gap the existing test did not cover, and what this prompt did about it

`src/enterprise/__tests__/security-invariants.test.ts` already asserted a single call site — but it walked **only** `src/features/execution-runtime`. `src/enterprise/execution-governance/service.ts` holds the same adapter reference and lies outside that directory, so a call added there would have voided SEC-INV-011 while every existing test still passed (NB-001).

This prompt widens the scan to the whole repository in `src/enterprise/__tests__/no-bypass-effect-paths.test.ts`, and §25 records the non-vacuity validation that proves the widened test detects exactly that.

### 7.3 Is the bounded-grant service the only production caller?

**Yes, within this repository — and the composition makes it structurally so.**

`createAuthorityControlledExecution` takes `executionAdapter` and does one thing with it: `createGrantExecutionService({ store: grantStore, adapter: executionAdapter, now, emergencyControl? })`. The `GrantExecutionService` closes over it. No Frontera module retains a second reference, and no route exposes one: the composition root registers `authorityControlledExecution` on the `AocEnterprise` object, and `node-http-adapter.ts` routes nothing to it (SEC-INV-027).

When a deployment configures `executionAdapterRouting`, the object handed to ACE is the composite registry the composition root built. The registry closes over its children; the children are not retained anywhere else in Frontera, are not exported, and are not reachable from any route. Membership is frozen at composition — there is no `register`/`unregister` surface to mutate while traffic flows (SEC-INV-042).

### 7.4 The one caller that is **not** accounted for, stated plainly

The adapter is **constructed by the host** and handed in at composition. The host therefore holds its own reference to the same object and can invoke it directly, at any time, with any `ValidatedExecutionAction` it cares to fabricate — including one no grant covers.

This is not a defect the repository can close, and it is not hidden here. It is the exact shape of SEC-TRUST-004 (voluntary-chokepoint limit): **Frontera's gate constrains the effects actually routed through it.** So the defensible claim is:

> Every *Frontera* code path that reaches `ExecutionAdapter.execute()` passes the bounded-grant gate first.

and **not**:

> No invocation of that adapter can occur without a bounded grant.

The second sentence is false and must never be written.

Server-side routing does **not** change this. A host that hands the registry a child adapter still holds its own reference to that child and can call it directly, bypassing the gate, the registry, the routing decision and every emergency control. Routing constrains which provider *Frontera* reaches for a given authorized action; it constrains nothing about what the process can do (SEC-TRUST-001, SEC-TRUST-004, SEC-TRUST-006).

### 7.5 The other provider seams, for completeness

| Provider resource | Production call sites | Gated by |
|---|---|---|
| Pinata SDK | `packages/pinata-adapter/src/pinata-provider-client.ts:169` — **one** `new PinataSDK({ pinataJwt })` in the entire repository | Nothing. Possession of `PINATA_JWT` (EP-020) |
| Stripe SDK | Four: `api/stripe/webhook/route.ts:64`, `api/checkout/session/route.ts:88`, `api/organization-registry/recover/route.ts:71`, `lib/stripe-billing-service.ts:20` | Nothing. Possession of `STRIPE_SECRET_KEY` |
| Issuer HMAC signer | `lib/passport-adapter.ts:52,116,151,334` via `createIssuerSignerFromEnv()` | Nothing. Possession of `AOC_ISSUER_PRIVATE_KEY_PEM` |

All three are pinned by the structural test in §18 so a new site cannot appear without this inventory being updated.

### 7.6 Outbound network client sites (P6)

`no-bypass-effect-paths.test.ts` scans `src/` and `packages/` for Node network **client** modules (`node:https`, `node:dns`, `node:net`, `node:tls`, `node:http2`, `node:dgram`, value imports only) and client calls (`http(s).request/get`, `net.connect`, `tls.connect`, `new Socket`, `fetch(` under `src/`, and common HTTP client libraries):

| File | Role |
|---|---|
| `src/enterprise/execution-adapters/generic-http/node-https-transport.ts` | **The one outbound call site (EP-050).** `dns.promises.lookup` once per execution, `node:https.request` once per execution with a pinned `lookup`, `agent: false`, SNI = pinned hostname, TLS verification on (`rejectUnauthorized: true` hardcoded in the transport, not configurable, immune to `NODE_TLS_REJECT_UNAUTHORIZED=0`) |
| `src/enterprise/execution-adapters/generic-http/configuration.ts` | `isIP` from `node:net` — a syntax check. No socket |
| `src/enterprise/execution-adapters/generic-http/public-address-policy.ts` | `isIPv4` / `isIPv6` from `node:net` — syntax checks. No socket |

The transport is imported only by the adapter core, and the production factory is called only by the composition root; both are pinned. The inbound listener (`node:http` in `node-http-adapter.ts` and `enterprise-server.ts`, EP-009) is pinned to make no outbound call. **A second outbound site fails the build** until it is inventoried with its own `EP-` id.

This is a statement about *Frontera's* code. It is not egress control: any code in the process can still open a socket (SEC-TRUST-004, SEC-INV-U03), and the Pinata and Stripe SDK sites (§7.5) remain exactly as before.

---

## 8. `AocKernel.enforce` Boundary

### 8.1 What is actually authorized

`AocKernel.enforce(request, executor, options?)` runs the full decision pipeline over the **declared** `ActionDescriptor` inside `request`: recognition, governed authority, context resolution, policy, and blocking obligations. It then delegates to `AocGuard.enforce` → `GuardedExecutionService.run`, which preflights and — only on `execute_allowed` — performs a single `await execute()`.

### 8.2 What the executor receives, and what the Kernel can observe

The executor's type is `() => Promise<T> | T`. It receives **nothing**: no action, no decision, no grant, no context. It is a zero-argument closure the caller constructed before the call.

The Kernel observes exactly one thing about it: **its return value**, recorded as `value` on the execution result. It does not observe, and has no mechanism to observe, what the closure did — which network it reached, which provider it called, which amount it moved, or whether it did anything at all.

### 8.3 Could a caller declare action A and execute B?

**Yes.** Nothing prevents it. `GuardedExecutionService.run` accepts the closure and inspects nothing; it does not read its source, does not wrap it, does not restrict its capabilities, and does not compare its behaviour to the `ActionDescriptor`. A caller may declare `read:invoice` and, inside the closure, transfer funds — and the Governance Record produced will faithfully attest that `read:invoice` was authorized.

### 8.4 The two formulations

| Legitimate | Illegitimate |
|---|---|
| "Frontera authorizes the declared action before invoking the executor, and does not invoke it on any non-allow outcome." | ~~"Frontera proves that the executor performed only the declared action."~~ |

**The second cannot be proven and must never be claimed.** A Governance Record produced through `enforce()` attests a **declaration**, not an effect.

### 8.5 Classification and reachability

**PARTIALLY BOUND.** Authorization is performed on a declared action; the actual effect cannot be shown equivalent to that declaration.

One reachability fact refines this materially and was not previously recorded: **`AocKernel.enforce()` has no production caller anywhere in this repository.** Every call site is a test (`src/kernel/__tests__/**`, `src/enterprise/__tests__/obligation-discharge-scenario.test.ts`) or a demo scenario calling `AocGuard.enforce` with a no-op executor (`src/features/aoc-enterprise-demo/scenarios/**`). The Enterprise orchestrator never calls it — `kernel-integration.test.ts:46` asserts that as a structural rule. No HTTP route reaches it.

It nevertheless remains **production-capable**, because `AocKernel` is exported on the published `./kernel` subpath and an embedding host can call it. So the correct statement is: *a published-API property, not a live effect path in this repository today.*

### 8.6 Not redesigned here

Per this prompt's scope, `enforce()` is not changed. No accepted ADR gives grants a role in the executor gate, and grants deliberately do not gate `enforce()`. Effect-time binding is what the bounded-grant path provides **instead** (SEC-INV-011), not a missing feature of this one. Closing SC-003 is a claiming decision plus, eventually, an architectural one — see §20.2.

---

## 9. Sovereign Access Exception

### 9.1 The complete path, traced

```
in-process host
  → AccessGrantService.requestProviderCredential(context, { grantId, requestedDurationSeconds })
  → store.getGrant(context, grantId)                     authoritative read (SQLite or in-memory)
  → assertActive(grant.status)                           'active' | 'revoked'; anything else throws
  → guard: grant.providerSystem === PINATA_PROVIDER_SYSTEM, else ACCESS_GRANT_PROVIDER_UNSUPPORTED
  → guard: deps.pinataClient !== undefined,              else ACCESS_GRANT_PROVIDER_UNSUPPORTED
  → guard: grant.providerCid !== undefined,              else ACCESS_GRANT_VALIDATION_ERROR
  → translation built from the STORED grant              resource id = grant.providerCid
  → executePinataProviderTranslation(translation, client)
  → PinataProviderClient → PinataSDK → Pinata API        ← EXTERNAL EFFECT
  → store.recordProviderCredentialIssuance(...)
```

Revocation (EP-016) runs the same shape with one ordering guarantee worth naming: the governance fact of revocation is persisted **first** (`store.beginRevocation`), so a concurrent `requestProviderCredential` already denies on `assertActive` before any provider call is attempted. Idempotent re-revocation never re-attempts provider enforcement.

### 9.2 The questions this prompt was told to answer

| Question | Answer |
|---|---|
| Grant source | `EnterpriseAccessGrant` / `AccessGrantRecord`, from `AccessGrantStore` (SQLite or in-memory). **Not** a `BoundedGrant` |
| Credential issuance | A time-bounded Pinata access URL, minted by the provider and recorded via `recordProviderCredentialIssuance` |
| `assertActive` or equivalent | `lifecycle.ts:20` — a two-state machine, `active → revoked`. Any non-`active` status refuses |
| Provider call | `executePinataProviderTranslation` → `PinataProviderClient` |
| Scope / bounds | Provider system, provider CID and resource kind, all read from the **stored grant**. `requestedDurationSeconds` comes from the caller and is passed through as provider metadata |
| Expiration / revocation | Revocation is durable and checked on every use. Grant expiry is not a status value by design — `EnterpriseAccessGrant` states its own rationale for that |
| Trusted state | SQLite `AccessGrantStore`; digest-bearing like the other `src/enterprise` stores |
| Provider credential boundary | `PINATA_JWT` is process-resident and passed to `new PinataSDK`. The minted access URL is what leaves; the JWT does not |
| Is it intentionally separate? | **Yes.** `ADR-PROVIDER-ADAPTER-CONTRACT.md`'s crossing reads `EnterpriseAccessGrant`; the execution-runtime crossing reads a *validated action*. Two crossings, deliberately |
| Can it reach external providers? | **Yes** — EP-015 and EP-016 |
| Can it be called independently of the bounded-grant service? | **Yes.** It never calls the Kernel, never reads a `BoundedGrant`, and shares no code with `GrantExecutionService` |
| Should it remain a separate authority model? | **Yes — see §9.4** |

### 9.3 Genuine bypasses *within* its own authority model

Assessed on its own terms, not against bounded-grant semantics:

| Issue | Assessment |
|---|---|
| `AccessGovernanceContext` is caller-asserted | The tenant scope the store enforces is a claim the in-process caller makes about itself. Same shape as EP-021/EP-022; DEPLOYMENT-GATED in substance |
| `EP-020` reaches the same resource without any grant | **This is the real bypass.** `createPinataProviderClient({ jwt })` constructs an unmediated SDK client. Any in-process code holding `PINATA_JWT` reaches the Pinata account without touching `AccessGrantStore` at all |
| `requestedDurationSeconds` is caller-supplied and unbounded by the grant | The grant bounds *what* resource, not *how long* the minted credential lives. A caller may request an arbitrarily long duration; only Pinata's own limits apply |
| No aggregate bound | An active grant may mint an unlimited number of credentials. Same shape as NB-006 on the bounded-grant path |

The first three are recorded; none is a contradiction of a claimed boundary, because no boundary wider than "an active stored grant is required *on this path*" has been claimed for it.

### 9.4 Disposition: EXCEPTED, and why not converged

**EXCEPTED — SEPARATE AUTHORITY MODEL.** Convergence onto bounded-grant semantics is explicitly **not** done here, for three reasons that are evidence-based rather than deferential:

1. **The two models answer different questions.** A bounded grant authorises an *action* against bounds. `EnterpriseAccessGrant` authorises *continued access to a named resource* with truthful effective revocation. Collapsing them would require inventing a resource-lifetime semantic the bound algebra does not have.
2. **Convergence is a production behaviour change**, which this prompt forbids (§23 of its own brief). A gap that requires changing behaviour is reported, not silently fixed.
3. **Its reachability is narrower than previously recorded** (§3.1): it is not on the published `exports` map and its `@aoc-enterprise/pinata-adapter` dependency is neither declared nor bundled, so **no published-package consumer can reach it**. It is a monorepo-internal, in-process, trusted-host-only path.

SC-002 disposition: **REFINED — STILL OPEN.** See §20.2.

---

## 10. Agent Passport Web Exception

### 10.1 What Prompt 3 needed to verify, verified

| # | Requirement | Result |
|---|---|---|
| 1 | The app is a separate TCB | ✅ Separate process, separate SQLite file, separate secrets, separate authorization. `src/enterprise` never imports it and it never imports `src/enterprise` |
| 2 | It does not use the Core bounded-grant execution path for its effects | ✅ Zero occurrences of `AocKernel`, `BoundedGrant`, `GrantExecutionService` or `AuthorityControlledExecution` anywhere under `apps/agent-passport-web/src`. Its only Frontera import is `@aoc-enterprise/agent-governance` (passport issuance, verification and the HMAC test signer) |
| 3 | Stripe outbound exists | ✅ Four SDK construction sites; EP-032, EP-033, EP-034, EP-035 |
| 4 | Issuer signing exists | ✅ `createIssuerSignerFromEnv()` at four call sites in `passport-adapter.ts`; EP-036, EP-037, EP-038 |
| 5 | Privileged DB state mutation exists | ✅ Twelve tables take `UPDATE`; registry creation, entitlement capacity, membership roles, credential hashes and billing state are all mutable |
| 6 | The APW-001 remediation remains present | ✅ **Re-verified from source**, §10.2 |
| 7 | It does not share Core process, state or secrets in a way that widens the Core proof | ✅ §10.3 |

### 10.2 APW-001 re-verification

`GET /api/checkout/session/[sessionId]` was read in full at current `main`:

- It imports exactly three things: `getPurchaseByStripeSessionId`, `getRegistryByPurchaseId`, `getEntitlementByRegistryId`. **All three are reads.**
- `ensureOrganizationRegistry` is neither imported nor called. It **cannot create a registry**.
- No token, credential or code is generated: the words `adminAccessToken` and `recoveryCode` do not appear in the file.
- When a registry exists it returns a non-secret summary with `adminAccessAvailable: false`.
- When none exists it returns `registryPending: true` and stops — failing **closed**, and pointing the buyer at `POST /api/organization-registry/recover` (session id **plus** contact email, plus a live `payment_status === 'paid'` check with Stripe).
- Eight invariants APW-FIX-001…008 are covered by `apps/agent-passport-web/__tests__/apw-001-checkout-disclosure.test.ts`, which passes in this run.

**EP-045 is therefore classified NON-EFFECTING, and this endpoint is no longer a privileged state-creation bypass.**

### 10.3 What APW-001's remediation does **not** mean

This is the misreading this document exists to prevent, so it is stated twice.

> Remediating APW-001 removed **one unauthenticated credential-disclosure path**. It did **not** place Agent Passport Web behind Frontera Core authority, and nothing in this application is bounded-grant controlled.

APW-002 (permanent, URL-borne, owner-equivalent admin credential), APW-003, APW-006 and APW-007 all remain open. Registry-admin-token possession still yields passport issuance, exports, team administration and billing-portal creation with **no Frontera decision anywhere in the path**.

### 10.4 The wording that matters

It would be **wrong** to write "Agent Passport Web bypasses Frontera Core." It bypasses nothing, because no claim was ever made that it sat behind Core. It is an application that was architected as its own trust zone.

The correct statement is:

> **Agent Passport Web is EXCEPTED from the bounded-grant no-bypass proof. Its effects are authorized by its own application-level authentication and RBAC, which are modelled in `AGENT_PASSPORT_WEB_THREAT_MODEL.md` and are not Frontera authority governance.**

### 10.5 It does not widen the Core proof

Verified rather than assumed: the application declares four external dependencies (`better-sqlite3`, `next`, `react`, `react-dom`, `stripe`), imports no `src/enterprise` module, opens its own database at its own path, reads its own four environment secrets, and runs as its own process. **It introduces no new path into Frontera Core**, which is the load-bearing conclusion for this document.

### 10.6 One surface the prior inventory missed — NB-004

`AGENT_PASSPORT_WEB_THREAT_MODEL.md` §5 inventoried 31 route files / 35 method+path endpoints by enumerating `app/api/**/route.ts`. That enumeration is complete **for route files** and is confirmed here (31 files).

It is not complete for **HTTP-reachable effects**. `apps/agent-passport-web/src/app/enroll-agent/actions.ts` carries `'use server'` and exports `enrollAgentAction`, a Next.js Server Action. Server Actions are invoked over HTTP by the framework; they are simply not route files. That action (EP-037):

- triggers **issuer signing** via `enrollAgent`;
- writes a passport record;
- decrements registry entitlement capacity;
- accepts the same two possession-only credentials as EP-036 (registry admin token, or Stripe `session_id`).

It is additionally **weaker** than the route it mirrors: EP-036 wraps `addPassportToRegistry` in a `try/catch` and returns `REGISTRY_PASSPORT_ISSUANCE_FAILED`; EP-037 does not, so a capacity-exhaustion race throws *after* the issuer key has already signed and the passport record has been written.

Recorded as **NB-004**. It is an inventory-completeness finding, not a new authority model — the credentials and effects are the same ones already modelled.

---

## 11. Stripe Effect Boundary

### 11.1 Outbound — the four sites

| Site | Route / caller | Stripe call | Principal | Tenant binding |
|---|---|---|---|---|
| `api/checkout/session/route.ts:88-91` | `POST /api/checkout/session` (EP-032) | `checkout.sessions.create` | **None — unauthenticated** | n/a; a new purchase |
| `lib/stripe-billing-service.ts:20-42` | `POST .../billing/portal` (EP-033) | `billingPortal.sessions.create` | Session cookie + `registry:manage_billing` | Customer id **server-derived** from the registry billing profile |
| `api/organization-registry/recover/route.ts:71-73` | `POST /api/organization-registry/recover` (EP-034) | `checkout.sessions.retrieve` | Recovery code + email, or session id + email | Registry resolved from the purchase |
| `api/stripe/webhook/route.ts:64-65` | `POST /api/stripe/webhook` (EP-035) | `subscriptions.retrieve` | Stripe signature over the raw body | Server-derived from the event's own ids |

### 11.2 The questions this prompt was told to answer

| Question | Answer |
|---|---|
| What route causes the effect? | The four above |
| What principal authorizes it? | One unauthenticated, one role-scoped session, one credential-gated, one Stripe-signature-verified |
| Tenant / customer binding? | **Server-derived in every case.** No route accepts a caller-supplied Stripe customer id |
| Can user-supplied identifiers redirect effects? | **No.** Price and product ids come from server-side `pricing.ts`; success/cancel URLs are built from `NEXT_PUBLIC_*` configuration; a malicious tenant cannot cause an effect on another tenant's Stripe customer |
| Are provider credentials process-resident? | **Yes.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are read from `process.env`, long-lived, rotatable only by restart |
| Does a bounded grant exist? | **No.** Nothing in this path reads a `BoundedGrant` or reaches `AocKernel` |

### 11.3 Inbound

`stripe.webhooks.constructEvent` over the **raw** body; 503 when `STRIPE_WEBHOOK_SECRET` is unset; 400 on a missing signature header; replay-blocked by `UNIQUE(stripe_event_id)`; event types allow-listed by a `switch`. **This is the strongest cryptographic boundary anywhere in the repository**, and it is correctly built.

One coupling remains, and is now a *deliberate* property rather than a hazard: since the Prompt 2.6 remediation, the webhook is the **sole** registry-creation path (EP-035). A failing or unconfigured webhook therefore blocks organization onboarding entirely rather than degrading to unauthenticated issuance. That is the correct trade, and it makes webhook configuration an operational prerequisite.

### 11.4 Classification

**EXCEPTED — SEPARATE AUTHORITY MODEL** for all four outbound sites and the inbound webhook.

The unauthenticated checkout-session route (EP-032) is worth naming precisely: it can create unlimited Stripe checkout sessions. That is cost and noise, bounded only by deployment rate limiting, which does not exist in-application (APW-011). It is **not** a cross-tenant compromise.

**No statement implying bounded-grant coverage of any Stripe effect is permissible.** §18 lists the exact sentence.

---

## 12. Issuer Signing Boundary

### 12.1 The complete path

```
POST /api/agent-passports   (EP-036)     registry admin token  OR  Stripe session_id
enrollAgentAction           (EP-037)     registry admin token  OR  Stripe session_id
  → enrollAgent()                        lib/passport-adapter.ts:51
  → createIssuerSignerFromEnv()          :52
  → createTestSigner({ keyId, issuer, secret: AOC_ISSUER_PRIVATE_KEY_PEM })
  → issueAgentPassport(...)              packages/agent-governance/.../passport-issuance.ts:100
  → signer.sign(passportHash)            createHmac('sha256', secret)      ← SIGNING EFFECT
```

`GET /api/agent-passports/:id/verify` (EP-038) invokes the **same secret** in the verification direction, unauthenticated and publicly.

### 12.2 The questions this prompt was told to answer

| Question | Answer (re-verified at current `main`) |
|---|---|
| What operation triggers signing? | Passport enrolment (EP-036, EP-037) and public verification (EP-038) |
| What principal authorizes signing? | A registry admin token, or a Stripe `session_id`. Both are **possession-only bearer values**; verification requires nothing at all |
| Where does key material live? | `process.env.AOC_ISSUER_PRIVATE_KEY_PEM`, process-resident and long-lived. A second, independent scheme uses `PASSPORT_SIGNING_SECRET`, additionally cached in a module-level variable |
| Are signing and issuance authorization separate? | **No. They are the same authorization.** There is no separate signing gate to prove |
| Is any Core grant consulted? | **No.** Nothing in this path reads a `BoundedGrant`, an `EnterpriseAccessGrant`, or a Kernel decision |
| Is third-party independent verification possible? | **No.** The algorithm is `hmac-sha256`; verification is HMAC recomputation with the same secret. The only outside-facing check is EP-038, which is a **verification oracle**, not independent verifiability |

### 12.3 Vocabulary, stated exactly

| Term | Present? |
|---|---|
| **SIGNATURE** (asymmetric, non-repudiable) | **No.** Does not exist anywhere in this repository |
| **MAC** | Yes — what is actually produced, under two independent schemes |
| **DIGEST** | Yes — SHA-256 over credentials at rest, `checksum_sha256` on export artifacts, unkeyed digests on `src/enterprise` authority artifacts |
| **ATTESTATION** | **No.** `createRuntimeVaultAttestation` is `parts.join(':')` — a delimiter-joined label (TB-004) |

`AOC_ISSUER_PUBLIC_KEY_PEM` is registered as an issuer *public key* with `algorithm: 'hmac-sha256'`. Under a symmetric scheme it verifies nothing, and the value that *would* verify also forges. It is a trust-anchor-shaped field with no trust-anchor function.

A development fallback remains: when `NODE_ENV !== 'production'`, `getIssuerSignerConfigFromEnv()` falls back to `AOC_DEV_SIGNING_SECRET` or the checked-in literal `'aoc-dev-signing-secret-not-for-production'` (APW-012). Production requires all four variables and throws otherwise.

### 12.4 Classification

**EXCEPTED — SEPARATE AUTHORITY MODEL** (EP-036, EP-037, EP-038).

**This prompt does not remediate SC-004.** The finding is restated as an effect-path fact (NB-011) so that a future claim cannot be built on a signer that does not do what its vocabulary suggests.

---

## 13. Authority-Write Paths

A no-bypass proof over an authority gate is meaningless if an actor can simply rewrite the authority the gate reads. This section inventories every production path that creates, changes, narrows, revokes or extends authority-bearing state.

| Effect path | Mutates | Execution effect? | Authority mutation? | Who may invoke | Externally reachable? | Requires system/operator authority? | Tenant-scoped? |
|---|---|---|---|---|---|---|---|
| EP-012 grant issuance | A-01 bounded grants | No | **Yes** | In-process host | **No route** | No — but a Kernel `allow`, attenuation and a synchronous commit guard are all required | Via the grant's own `organization` bound |
| EP-013 grant revocation | A-01 | No | **Yes** | In-process host | **No route** | No | n/a |
| EP-021 Kernel Authority provisioning | A-02 durable | No | **Yes** | Operator/admin code | **No route** | **Yes** — `context.system === true` **and** an operator identity, enforced in the store | Yes, `organizationId` |
| EP-022 governed-authority transitions | A-02 | No | **Yes** | In-process host | **No route** | Partially — `context.system` required for `administrative` bases only | **Yes**, `requireAuthorityAccessToOrganization` on every method |
| EP-023 policy-pack writes | A-05 | No | **Yes** — rewrites the decision rules | Any in-process code holding the registry | **No route** | **No. No caller-identity parameter exists** | **No** |
| EP-024 capability-token revoke/suspend/issue | A-04 recognition | No | **Yes** | In-process host | **No route** | No | No |
| EP-025 approval state | A-06 | No | **Yes** | In-process host | **No route** | No | Via approval records |
| EP-026 `setEmergencyDeny` | A-10 kill switch (Action Enforcement path) | No | **Yes** | Any in-process code holding the runtime | **No route** | **No identity of any kind** | No |
| EP-047 emergency control `activate` | A-10 interlock (bounded-grant path) | No — **restricting only**; it can withhold an execution, never cause one | **Yes** | Operator/admin code holding `emergencyControlAdministration` | **No route** | No — composing-host discipline; an `issuerRef` is *recorded*, not *checked* | Via the control's own `organization` scope |
| EP-048 emergency control `release` | A-10 interlock (bounded-grant path) | No — but this is the **permitting** direction of the pair | **Yes** | as EP-047 | **No route** | as EP-047 | as EP-047 |
| EP-006 / EP-007 passport lifecycle | A-07 | No | **Yes** — agent standing | HTTP caller | **YES** | No | **Yes**, in the store — but see §13.2 |
| EP-008 assurance writes | A-08 | No | **Yes** — compliance posture | HTTP caller | **YES** | No | **Yes**, in the store — but see §13.2 |
| EP-017 Sovereign Access grant lifecycle | A-11 | No | **Yes** | In-process host | **No route** | No | Via `AccessGovernanceContext` |
| EP-034 / EP-039 registry admin credential rotation | A-18 | No | **Yes** — owner-equivalent credential | Recovery-code or admin-token holder | **YES** | No | Yes, registry-bound |
| EP-042 registry membership roles | registry RBAC | No | **Yes** | Session + `registry:manage_team` | **YES** | No | Yes, registry-bound |
| EP-035 webhook entitlement writes | entitlement capacity | No | **Yes** — how many passports may be issued | Stripe signature | **YES** | No | Server-derived |

### 13.1 The generalisation that is **not** available

It is accurate to say **grant** authority-write surfaces are not caller-exposed (SEC-INV-027). It is **not** accurate to extend that to authoritative state generally: passport lifecycle, assurance, registry credentials, registry roles and entitlement capacity are all deliberately reachable over HTTP. Their mitigation is that they are append-only and attributable, not that they are unreachable.

### 13.2 The default-deployment correction — NB-005

Prompt 2 §11 classified store-layer tenant scoping as a **HARD CHOKEPOINT**: "enforced inside the stores; a bypassed adapter still cannot cross tenants."

That is true of a caller whose access context is *organization-scoped*. It is **not** true of the default deployment, and the difference is not a nuance:

```
resolveGovernanceAccessContext(authorizationHeader, configuration):
    if (!configuration.features.requireAuthentication) return { system: true };
```

`AOC_ENTERPRISE_REQUIRE_AUTH` defaults to **`false`** (`enterprise-configuration.ts:174`). So with the shipped defaults **every HTTP caller — including an unauthenticated one — is handed `{ system: true }`**, and every scoping predicate short-circuits on it:

- `canSeeRecord`: `if (context.system) return true;`
- `canAccessPassportOrganization`: `if (context.system) return true;`
- `canAccessAssuranceOrganization`: `if (context.system) return true;`

Combined with `http.host` defaulting to `0.0.0.0` (`:178`), the out-of-the-box posture is: **any network peer is a cross-tenant system principal over EP-002…EP-008.**

This does not contradict SEC-TRUST-007, which already says authentication is off by default. What it corrects is the *chokepoint classification*: store-layer tenant scoping is a **DEPLOYMENT CHOKEPOINT**, not a hard one, because the principal it scopes against is produced by a configuration flag. Recorded as **NB-005**.

---

## 14. Resource-Centric Reachability

This is the heart of the proof. For each protected resource: **what are all known ways to reach it?**

### 14.1 Pinata account (via `PINATA_JWT`)

| Path | Governed by | Notes |
|---|---|---|
| EP-015 `requestProviderCredential` | `AccessGrantStore` read + `assertActive` | Sovereign Access model |
| EP-016 `revokeGrant` provider enforcement | Revocation persisted before the provider call | Sovereign Access model |
| EP-018 Content Protection ciphertext upload | **Tenant-scope check only.** No grant of any kind | **Previously unmodelled — NB-003** |
| EP-020 `createPinataProviderClient({ jwt })` | **Nothing** | The raw seam all three sit on |
| Direct `process.env.PINATA_JWT` + any HTTP client | **Nothing** | No egress control exists (SEC-INV-U03) |

**No-bypass proven? NO.** Five routes to one resource, two of them ungoverned. Two *different* authority models govern three of them. Bounded grants govern **none**.

### 14.2 Bounded-grant `ExecutionAdapter` / its provider

| Path | Governed by | Notes |
|---|---|---|
| EP-011 `GrantExecutionService.exercise()` | The full 12-check gate | The only Frontera path |
| EP-049 `POST /api/governed-actions` | Customer admission, then EP-011 via a committed decision and a server-held grant | Not a second path to the adapter: an HTTP entry to the first |
| EP-050 Generic HTTP child → pinned HTTPS provider | EP-011, then the registry's adapter-scoped emergency check, then the adapter's own pinned-origin, public-address, no-redirect, no-retry rules | The one provider effect Frontera ships. The provider it reaches is still reachable by anything else in the process that holds its credential |
| Host's own reference to the adapter it constructed | **Nothing** | §7.4; outside the repository's control |
| Whatever provider the adapter wraps, reached directly | **Nothing** | The adapter is host code; Frontera ships none |

**No-bypass proven? YES, within Frontera's own code** — and only there. Every Frontera code path that reaches an `ExecutionAdapter` passes the gate. The host's reference and the underlying provider are not Frontera's to constrain.

### 14.3 Stripe merchant account (via `STRIPE_SECRET_KEY`)

| Path | Governed by |
|---|---|
| EP-032 `POST /api/checkout/session` | **Nothing — unauthenticated** |
| EP-033 `POST .../billing/portal` | Session cookie + `registry:manage_billing` |
| EP-034 `POST /api/organization-registry/recover` | Recovery code or session id, + contact email |
| EP-035 `POST /api/stripe/webhook` | Stripe signature over the raw body |
| Direct `process.env.STRIPE_SECRET_KEY` in the web process | **Nothing** |

**No-bypass proven? NO**, and none was claimed. Four application-authorized routes plus process-resident key access. Bounded grants govern none. The meaningful property that *is* proven: **no caller-supplied Stripe customer or price id is accepted anywhere**, so cross-customer effect is unreachable.

### 14.4 Issuer signing key (`AOC_ISSUER_PRIVATE_KEY_PEM`, and `PASSPORT_SIGNING_SECRET`)

| Path | Governed by |
|---|---|
| EP-036 `POST /api/agent-passports` | Registry admin token **or** Stripe `session_id` |
| EP-037 `enrollAgentAction` server action | Same two credentials — **NB-004** |
| EP-038 `GET /api/agent-passports/:id/verify` | **Nothing — public** (verification direction) |
| Direct `process.env` access in the web process | **Nothing** |

**No-bypass proven? NO.** Possession of either bearer credential signs. Possession of the secret both signs and verifies, because it is a MAC.

### 14.5 Bounded-grant store (A-01)

| Path | Governed by |
|---|---|
| EP-012 `GrantIssuanceService.issueGrant` | Kernel allow + attenuation + synchronous commit guard + authority-binding equality at commit |
| EP-013 `revokeGrant` | Store idempotency |
| EP-011 `store.read` | Read-only |
| Direct reference to the store object in-process | **Nothing** — it is a plain object handed in at composition |
| Its backing storage | In-memory `Map` today; a host-supplied durable store otherwise |

**No-bypass proven? PARTIALLY.** Within Frontera, the three service methods are the only writers. In-process code holding the store reference writes freely. **This is the Prompt 4 handoff.**

### 14.5a Exercise-control ledger (A-28, P7)

| Path | Governed by |
|---|---|
| EP-051 `reserve` | The bounded-grant gate (EP-011) + binding revalidation + validated policy + one `BEGIN IMMEDIATE` transaction |
| EP-052 `settle` | Only after EP-051, only for `executed` / `execution-unconfirmed`; one immutable terminal event |
| EP-053 `release` | Only after EP-051, only for `execution-failed` or a post-reservation withholding; append-only |
| Direct reference to a host-supplied ledger object in-process | **Nothing** — it is host code, exactly like the bounded-grant store |
| Its backing storage (SQLite file) | Append-only triggers, per-row and per-bucket digests, schema refusal — unkeyed integrity only |

**No-bypass proven? PARTIALLY.** Within Frontera, the gate is the only writer and adapters, policies, resolvers and the Governed Action layer never reach it. In-process code holding a host-supplied ledger, or a filesystem writer able to rewrite the file and re-seal its digests, is trusted.

### 14.6 Governed-authority store (A-02) and Kernel Authority (durable)

| Path | Governed by |
|---|---|
| EP-022 store transitions | `requireAuthorityAccessToOrganization`; `context.system` for administrative bases; capacity conservation and digest re-seal inside the transaction |
| EP-021 provisioning service | `context.system === true` **and** an operator identity, enforced in the store |
| Direct SQLite file write | **Nothing in software.** Digests detect; a re-sealing writer defeats detection (SEC-TRUST-002) |

**No-bypass proven? PARTIALLY.** Strong against a caller that presents a tenant context; nothing against a caller that asserts `system: true`, and nothing against file-level access.

### 14.7 Policy store (A-05)

| Path | Governed by |
|---|---|
| EP-023 `savePack` / `saveVersion` / `activatePolicyPackVersion` | **Nothing. No caller-identity parameter exists** |
| Composition-root wiring | The host's choice of provider |

**No-bypass proven? NO.** This is the most consequential row in the section: the authority a bounded grant is minted under (EP-012) depends on a Kernel decision made under policy packs that any in-process code holding the registry can rewrite, with no identity check and no audit of who did it. **NB-008.**

### 14.8 Agent Passport Web database (A-22)

| Path | Governed by |
|---|---|
| 31 route files + 1 server action | Per-route authentication; two disjoint models (session RBAC and admin token) |
| Stripe webhook | Signature |
| Direct SQLite file write | **Nothing.** No digest, no chain, no `verify` surface (APW-006) |

**No-bypass proven? NO**, and tamper is additionally **undetectable** here, unlike in `src/enterprise`.

### 14.9 Summary

| Protected resource | Governed path(s) | Alternate paths | No-bypass proven? |
|---|---|---|---|
| Bounded-grant adapter / its provider | EP-011 | Host's own adapter reference; the provider itself | **YES — within Frontera code only** |
| Pinata account | EP-015, EP-016, EP-018 | EP-020; direct `PINATA_JWT` | **NO** |
| Stripe merchant account | EP-033, EP-034, EP-035 | EP-032 (unauthenticated); direct key access | **NO** (none claimed) |
| Issuer signing key | EP-036, EP-037 | EP-038 (public, verification side); direct key access | **NO** |
| Bounded-grant store | EP-012, EP-013 | Direct in-process store reference | **PARTIALLY** |
| Exercise-control ledger (P7) | EP-051, EP-052, EP-053 | Direct in-process ledger reference; direct file write + re-seal | **PARTIALLY** |
| Governed-authority / Kernel Authority store | EP-021, EP-022 | `system: true` assertion; direct file write | **PARTIALLY** |
| Policy store | EP-023 | — (EP-023 *is* the ungoverned path) | **NO** |
| Agent Passport database | 31 routes + EP-037 | Direct file write, undetectable | **NO** |

---

## 15. Bypass Primitive Inventory

A **BYPASS OF THE SAME CLAIMED BOUNDARY** reaches a protected resource around a gate whose guarantee is being claimed for that resource. An **ALTERNATE AUTHORITY MODEL** reaches a resource under a *different*, deliberately separate and documented boundary, where no wider claim was made. The two are kept apart below, because conflating them is how a threat model becomes either alarmist or dishonest.

| Primitive | Exists? | Holder | What boundary it bypasses | Layer | Kind |
|---|---|---|---|---|---|
| Opaque executor closure (EP-014) | **Yes** | Any caller of `AocKernel.enforce()` | Declaration → effect binding | Application | **BYPASS** (of effect binding, never claimed as bound — hence PARTIALLY BOUND, not a breach) |
| Host's own `ExecutionAdapter` reference | **Yes** | The composing host | The bounded-grant gate, for that adapter | Deployment | **BYPASS** of the same claimed boundary — §7.4 |
| `createPinataProviderClient` / raw `PINATA_JWT` (EP-020) | **Yes** | Any in-process code in the Enterprise process | Sovereign Access **and** Content Protection gates | Application + Deployment | **BYPASS** of the same claimed boundary |
| Direct `process.env` secret access | **Yes** | Any code in the holding process | Every provider gate in that process | Application + Deployment | **BYPASS**; type-level exclusion covers only the *public composition surface* |
| In-process bounded-grant store reference | **Yes** | Composition-root-wired code | EP-012 / EP-013 | Application | **BYPASS** |
| `PolicyPackRegistry` write access (EP-023) | **Yes** | Any code holding the registry | The rules every decision is made under | Application | **BYPASS** — NB-008 |
| `context.system = true` assertion | **Yes** | Any in-process caller, and **any HTTP caller when auth is off** | Store-layer tenant scoping | Application + Deployment | **BYPASS** — NB-005 |
| Filesystem write to a store file | **Yes** | Process user / operator | Software authority boundary | Deployment | **BYPASS**; digests detect, re-sealing defeats |
| Registry admin token in a URL | **Yes** | Anyone reading history, logs or a shared link | Untrusted → registry owner | Application | **BYPASS** — APW-002 |
| Stripe `session_id` as bearer | **Yes** | Anyone holding the success URL | Passport issuance authorization | Application | **BYPASS** — APW-009 |
| Invitation token | **Yes** | Anyone holding the invitation URL | Invitee identity disclosure | Application | **BYPASS** — APW-010 |
| Next.js Server Action (EP-037) | **Yes** | Any HTTP caller with either credential | Nothing — but it was **outside the route inventory** | Application | Inventory gap — NB-004 |
| Sovereign Access (EP-015/016/017) | **Yes** | In-process host | — | Application | **ALTERNATE AUTHORITY MODEL** (§9) |
| Content Protection (EP-018/019) | **Yes** | In-process host | — | Application | **ALTERNATE AUTHORITY MODEL**, previously undocumented — NB-003 |
| Agent Passport Web routes and Stripe (§5.10) | **Yes** | Internet | — | Application | **ALTERNATE AUTHORITY MODEL** (§10, §11) |
| Backup / restore tooling (EP-028) | **Yes** | Operator | Every store at once | Deployment | **BYPASS**, by design; operator surface |
| Build / CI compromise | **Yes** | Repo writer, or any invoked Action | Supply chain | External | **BYPASS**; mitigated by checksum-pinned release artifacts and by CI using **no secrets** |
| Unrestricted network egress | **Yes** | Any code in either process | Every provider gate | Deployment | **BYPASS**; SEC-INV-U03 unimplemented |
| Privileged host access | **Yes** | Attacker with host access | Everything | Deployment | **BYPASS**; SEC-TRUST-001 |
| External customer signer outside Frontera | n/a | The customer | — | External | Out of scope by architecture — Frontera holds no customer transaction key (SEC-INV-025) |
| Shell / child process / dynamic code eval | **No** | — | — | — | Absent from all production TypeScript (§4.2) |
| Scheduler / queue / background worker | **No** | — | — | — | Absent (§4.2) |
| Caller-controlled dynamic `import()` | **No** | — | — | — | Six dynamic imports exist in `apps/agent-passport-web`, **all constant-specifier**, none caller-influenced |
| Customer transaction key theft | **No** | — | — | — | No such key exists anywhere (SEC-INV-025) |

### 15.1 Self-modification and authority modification (Step 13)

Whether a governed execution path can change the authority that governs it.

| Capability | Status | Evidence |
|---|---|---|
| Modify its own bounded grant | **PARTIALLY BLOCKED** | Nothing on the exercise path writes a grant — `execution-layer-boundaries.test.ts:206` asserts the store port is used for reads and revocation visibility only. But there is **no process boundary**: code that also holds the store reference can write |
| Modify its own role / recognition | **NOT ADDRESSED** | `capability-token-service` (EP-024) is an in-process `Map` with no caller identity |
| Modify the policies governing it | **NOT ADDRESSED** | EP-023 has no caller identity at all — NB-008 |
| Modify enforcement code | **DEPLOYMENT-DEPENDENT** | No runtime code loading exists; the vector is filesystem or supply chain, i.e. EP-028 / EP-030 |
| Modify adapter routing | **NOT ADDRESSED** | The adapter is chosen at composition (A-24). A swapped adapter is undetectable at runtime |
| Modify revocation state | **PARTIALLY BLOCKED** | `revoke` is idempotent and the first revocation stands and is never re-dated. But in-process code holding the store can rewrite the underlying `Map` directly |
| Modify trusted authority databases | **PARTIALLY BLOCKED** | Digests detect naive tampering; a re-sealing writer defeats detection (SEC-TRUST-002); the web app's store has **no** digest at all (APW-006) |
| Obtain an authority-writer handle | **NOT ADDRESSED** | No capability-dropping mechanism exists. Any in-process code can be handed any reference |

**Process-level isolation is not claimed, because it does not exist.** `infrastructure/{terraform,docker,kubernetes}` contain only `.gitkeep`. There is no sandbox, no capability dropping, and no agent execution runtime to isolate (D-22 is conceptual). This is SEC-TRUST-005, owned by Prompt 7.

---

## 16. Deployment Assumptions

Every claim in §18 is conditional on these. They are not enforced by this repository.

| # | Assumption | If violated |
|---|---|---|
| D-A1 | `AOC_ENTERPRISE_REQUIRE_AUTH=true` and `AOC_ENTERPRISE_API_KEYS` are set, with **organization-scoped** keys | Every HTTP caller is an unauthenticated cross-tenant `system` principal over EP-002…EP-008 (NB-005) |
| D-A2 | The Enterprise host binds loopback and sits behind a TLS-terminating reverse proxy | The default `0.0.0.0:8787` is reachable from the network (EP-009) |
| D-A3 | The host process, its environment, its process user and its data directory are trusted | Total compromise: every secret, every store, every digest re-sealable (SEC-TRUST-001) |
| D-A4 | The composing host hands the `ExecutionAdapter`, the grant store, the `PolicyPackRegistry` and the Kernel Authority provisioning service only to code entitled to them | Every §14 "PARTIALLY" and the §7.4 bypass become live |
| D-A5 | Rate limiting, WAF and ingress restriction are provided by the deployment | None exists in either application (APW-011) |
| D-A6 | `STRIPE_WEBHOOK_SECRET` is configured and the webhook is healthy | Organization onboarding is blocked entirely — deliberate, post-APW-001 |
| D-A7 | `NODE_ENV=production` is set correctly in the web application | The issuer falls back to a checked-in literal dev secret (APW-012) |
| D-A8 | A durable `BoundedGrantStorePort` is composed if grants must survive restart | Grants are lost on restart; every exercise reads `GRANT_EXERCISE_NOT_FOUND` — fails **closed** |
| D-A9 | Store files and backups are protected at the filesystem level | Tamper is detectable in `src/enterprise` and **undetectable** in `apps/agent-passport-web` |
| D-A10 | The build and release pipeline is trusted; released artifacts are verified against `release/RELEASE_MANIFEST.json` | A changed artifact reaches every future deployment (D-21) |

---

## 17. Prove-or-Except Matrix

One row per effect path group. Every EP in §5 is covered.

### EP-001, EP-004, EP-005 — Kernel evaluation and governance/evidence reads
- **CLAIM:** produce no external effect — invoke no executor, no adapter, and perform no outbound I/O.
- **EVIDENCE:** `AocKernel.ts:311-390` contains no invocation site; every production source under `src/kernel` imports only `crypto`; `security-invariants.test.ts` asserts the absence of `node:fs`, `node:http`, `node:net`, `child_process`, `fetch(` and `better-sqlite3` across all Kernel sources.
- **CLASSIFICATION:** NON-EFFECTING. **SCOPE:** PATH-LOCAL to `AocKernel.evaluate()` and `POST /api/governance/evaluate`.
- **EXCEPTIONS:** the Governance Record commit is a separate path (EP-002).
- **BYPASS CONDITIONS:** none for this claim.
- **DEPLOYMENT ASSUMPTIONS:** none.

### EP-002, EP-003, EP-006, EP-007, EP-008 — Enterprise HTTP writes
- **CLAIM:** tenant scoping is enforced **inside the stores**, so a compromised HTTP adapter cannot cross tenants; the passport and assurance logs are append-only, chained and attributable.
- **EVIDENCE:** `requireAccessToOrganization` (`passport-store.ts:66`), `requireAccessToAssuranceOrganization` (`assurance-store.ts:78`), `canSeeRecord` (`store-common.ts:29`), `resolveQueryOrganization` rejecting cross-tenant filters.
- **CLASSIFICATION:** DEPLOYMENT-GATED.
- **SCOPE:** COMPONENT-LOCAL to those stores.
- **EXCEPTIONS / BYPASS CONDITIONS:** **the claim holds only for an organization-scoped context.** With `AOC_ENTERPRISE_REQUIRE_AUTH=false` (the default) every caller is `{system:true}` and every predicate short-circuits — NB-005.
- **DEPLOYMENT ASSUMPTIONS:** D-A1, D-A2.

### EP-009, EP-010, EP-046 — Network bind and store file creation
- **CLAIM:** filesystem paths and the listener address come from boot configuration, never from a request.
- **EVIDENCE:** `existsSync`/`mkdirSync` in 13 store modules take a configured directory; `enterprise-server.ts:32` binds `configuration.http.{port,host}`.
- **CLASSIFICATION:** DEPLOYMENT-GATED. **DEPLOYMENT ASSUMPTIONS:** D-A2, D-A9.

### EP-011 — Bounded-grant exercise ⭐
- **CLAIM:** no `ExecutionAdapter` is invoked unless the authoritative grant, re-read at that instant, covers the exact assessed action; every value crossing the boundary was either proven inside a bound or read from the trusted grant.
- **EVIDENCE:** §6.2, fourteen rows. `grant-execution-service.ts:154,158,176,184-194,198`; `grant-exercise-assessment.ts:110-158`; `execution-exercise.test.ts` counts adapter invocations (`callCount === 0` on every refusal row, `=== 1` on the valid row); single-call-site checks in `security-invariants.test.ts` and, repository-wide, in `no-bypass-effect-paths.test.ts`.
- **CLASSIFICATION:** **PROVEN — PATH LOCAL.**
- **SCOPE:** the bounded-grant exercise path only. Not `enforce()`, not Sovereign Access, not Content Protection, not any application code calling a provider directly.
- **EXCEPTIONS:** §6.4 — per-attempt not aggregate; adapter is trusted code; store is in-memory by default; the kill switch does not reach it.
- **BYPASS CONDITIONS:** the host's own reference to the adapter it constructed (§7.4).
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A8.

### EP-049 — Customer governed action over HTTP (P5)
- **CLAIM:** a caller reaches a provider through this route only as a bound customer principal, only for the actor its credential is bound to, only after a Kernel decision is durably committed and a bounded grant is issued from it server-side, and only through EP-011's exercise gate; the caller can name no identity, grant, adapter, provider, destination, credential or payload, and receives no grant, digest or adapter identity.
- **EVIDENCE:** `src/enterprise/__tests__/governed-action-api-endpoint.test.ts` (real composed Host over real HTTP: authentication, identity, intent, routing, every governance outcome, idempotency, five emergency-control scopes plus unreadable state, historical replay, response key walk), `governed-action-composition.test.ts` GOV-ACT-11 (adapter and sequence structure), `scripts/check-api-freeze.mjs` (gated route unmounted on the default Host).
- **CLASSIFICATION:** **PROVEN — PATH LOCAL.**
- **SCOPE:** this route, when both capabilities are composed. Nothing here extends to any other EP.
- **EXCEPTIONS:** as EP-011 (§6.4). Credentials are static bearer API keys; identity is as strong as their configuration and the operator-provisioned subject binding.
- **BYPASS CONDITIONS:** as EP-011 — the host's own adapter reference (§7.4). A host that writes its own listener around `AocEnterprise.governAction` is trusted code.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A8; TLS in front of the listener.

### EP-050 — Generic HTTP adapter outbound request (P6)
- **CLAIM:** when the governed-action path routes to a Generic HTTP child, that child sends **at most one** HTTPS request per `execute()`, to the one operator-pinned origin, over a fresh connection to an address that was resolved for that execution and proven publicly routable, with TLS verification on (`rejectUnauthorized: true` hardcoded in the transport, not configurable, immune to `NODE_TLS_REJECT_UNAUTHORIZED=0`), no redirect followed and no retry; completion is claimed only for 200, 201 and 204, and every other 2xx and every 3xx is `execution_unconfirmed`; every outbound value is an operator literal or one approved field of the `ValidatedExecutionAction`; the credential is operator configuration and appears in no result, record, log or event; and a post-send loss of certainty is reported as `execution_unconfirmed`, never as a definite failure.
- **EVIDENCE:** `src/enterprise/__tests__/generic-http-execution-adapter.test.ts` (origin, mapping, address-policy, DNS-per-execution and rebinding, status, redirect, retry, credential and transport-phase matrices; real local TCP/TLS sockets for refusal, SNI, certificate verification, reset, timeout and single-request delivery), `generic-http-composition.test.ts` (one registry, fail-at-startup configuration, adapter-scoped emergency stop before DNS, zero-network rejection of every caller routing field measured through Node diagnostics channels, full governed path to the mapping), §7.6 structural scans.
- **CLASSIFICATION:** **PROVEN — PATH LOCAL.**
- **SCOPE:** the Generic HTTP adapter, reached through EP-011 via the registry. It does **not** retroactively govern any other EP, and it is **not** a network egress boundary (SEC-INV-U03 stays unimplemented).
- **EXCEPTIONS:** as EP-011; plus: the configuration and credential are trusted, process-resident operator data (no KMS); a malicious public provider may itself forward the request; provider-side exactly-once is not guaranteed; `execution_unconfirmed` is not reconciled.
- **BYPASS CONDITIONS:** as EP-011 (§7.4); any in-process code that holds the provider credential can call the provider directly (SEC-TRUST-004).
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A8; a trustworthy system resolver is *not* assumed — a resolver answer naming a forbidden address is refused.

### EP-051, EP-052, EP-053 — Exercise-control reservation, settlement and release (P7)
- **CLAIM:** with exercise controls composed, no adapter is invoked without a successful EP-051 reservation; every applicable limit is admitted atomically or none is; a pending or unconfirmed reservation keeps consuming; only a definite no-effect result or a post-reservation withholding releases (EP-053), and release never deletes; one execution identity cannot invoke an adapter twice; the grant's authority binding is revalidated for exact equality before and after the reservation; a caller can name no limit, bucket, reservation or binding.
- **EVIDENCE:** `src/features/execution-runtime/tests/execution-exercise-control.test.ts` (ordering, §45 finalization matrix, §47 binding rows, §48 emergency interaction, adapter invocation counts), `src/features/exercise-control-runtime/tests/*` (domain, contract, boundaries), `src/enterprise/__tests__/exercise-control-sqlite.test.ts` (persistence, crash conservatism, corruption, schema), `exercise-control-concurrency.test.ts` (independent connections and worker-thread races), `exercise-control-governed-action.test.ts` (public mapping, replay, Generic HTTP outcomes, caller fields at zero Kernel/ledger/DNS/socket), `exercise-control-composition.test.ts`.
- **CLASSIFICATION:** **PROVEN — PATH LOCAL.**
- **SCOPE:** the bounded-grant exercise path when `exerciseControls` is composed. Nothing here extends to any other EP.
- **EXCEPTIONS:** the policy and the binding resolver are trusted host code; the binding can change after the last check (not atomic with any external system); one SQLite file serializes one host's processes — no distributed quota; no reconciliation, no automatic abandoned-reservation recovery, no exactly-once.
- **BYPASS CONDITIONS:** in-process code holding a host-supplied ledger; a filesystem writer who rewrites the ledger and re-seals every digest, or deletes whole reservations consistently (unkeyed digests, SEC-TRUST-002).
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A8; a local filesystem that honours SQLite locking.

### EP-012, EP-013 — Bounded-grant issuance and revocation
- **CLAIM:** issuance checks run inside the store's commit boundary — the guard is synchronous *by type*, so no `await` can interleave between the read that decides and the write that records; any change to the authority binding between measurement and commit refuses, by **equality** rather than containment; an issued grant is equal to or narrower than the authority it derives from on every axis.
- **EVIDENCE:** `grant-store-port.ts` `commitGuard: () => GrantCommitPrecondition`; `in-memory-bounded-grant-store.ts` critical section with no `await`; `execution-governance/service.ts:197-234`; `grantScopeIsWithin`; `grant-transaction-boundary.test.ts`, `grant-attenuation.test.ts`.
- **CLASSIFICATION:** **PROVEN — PATH LOCAL.**
- **EXCEPTIONS:** `resolveAuthorityBinding` is host-supplied; it fails closed when it returns `undefined` or a malformed binding.
- **BYPASS CONDITIONS:** in-process code holding the store reference.
- **DEPLOYMENT ASSUMPTIONS:** D-A4, D-A8.

### EP-014 — `AocKernel.enforce()`
- **CLAIM:** the declared action passed full authorization before the executor was invoked, and the executor is not invoked on any non-allow outcome.
- **EVIDENCE:** `guarded-execution-service.ts:35-105` — the single `await execute()` is preceded by an unconditional return on every non-allow branch.
- **CLASSIFICATION:** **PARTIALLY BOUND.**
- **EXCEPTIONS:** the executor's actual effect is **not** bound to the declaration (SEC-INV-010). No in-repo production caller exists; it is reachable as a published API.
- **BYPASS CONDITIONS:** a caller may declare A and execute B inside the closure (§8.3).
- **DEPLOYMENT ASSUMPTIONS:** D-A3.

### EP-015, EP-016, EP-017 — Sovereign Access
- **CLAIM:** a provider credential is minted only under an authoritative `EnterpriseAccessGrant` read that is `active` at that instant; revocation is persisted before any provider enforcement is attempted.
- **EVIDENCE:** `access-governance/service.ts:253-256, 199-215, 281`; `lifecycle.ts:20`.
- **CLASSIFICATION:** **EXCEPTED — SEPARATE AUTHORITY MODEL.**
- **SCOPE:** PATH-LOCAL to Sovereign Access. **SEC-INV-011 does not apply here and is not claimed here.**
- **BYPASS CONDITIONS:** EP-020; caller-asserted `AccessGovernanceContext`; unbounded `requestedDurationSeconds`; no aggregate bound.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4. Not reachable from a published-package consumer (§3.1).

### EP-018, EP-019 — Content Protection
- **CLAIM:** only a caller within the resource's organization may protect a resource, and only ciphertext is uploaded.
- **EVIDENCE:** `content-protection/service.ts:100` `requireContentProtectionAccessToOrganization`; `:197` calls `storage.store({ ciphertext })` — never `request.plaintext`.
- **CLASSIFICATION:** **EXCEPTED — SEPARATE AUTHORITY MODEL.**
- **EXCEPTIONS:** the ciphertext property is a **call-ordering discipline in `service.ts`**, not an adapter guarantee — `pinata-storage-adapter.ts` uploads exactly the bytes it is handed and cannot tell ciphertext from plaintext.
- **BYPASS CONDITIONS:** EP-020; caller-asserted context. **No grant of any kind is consulted** — NB-003.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4.

### EP-020 — Raw Pinata client
- **CLAIM:** none is made, and none may be.
- **CLASSIFICATION:** DEPLOYMENT-GATED. **BYPASS CONDITIONS:** possession of `PINATA_JWT` is sufficient. **DEPLOYMENT ASSUMPTIONS:** D-A3.

### EP-021, EP-022 — Kernel Authority and governed-authority writes
- **CLAIM:** durable Kernel Authority writes require both a system context and an operator identity, enforced **in the store** so a caller bypassing the service still cannot write; governed-authority transitions conserve capacity and re-seal the digest inside the transaction.
- **EVIDENCE:** `provisioning-service.ts:51-60`; `sqlite-authority-store.ts:1839-1840, 1936-1937, 2021`.
- **CLASSIFICATION:** DEPLOYMENT-GATED — the *principal* is asserted by the composing host (§6.1). **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A9.

### EP-023 — Policy-pack writes
- **CLAIM:** none. **There is no caller-identity parameter on `savePack`, `saveVersion` or `activatePolicyPackVersion`.**
- **CLASSIFICATION:** DEPLOYMENT-GATED. **BYPASS CONDITIONS:** any in-process code holding the registry rewrites the rules every decision is made under — NB-008. **DEPLOYMENT ASSUMPTIONS:** D-A4.

### EP-024, EP-025, EP-026 — Recognition, approval and kill-switch state
- **CLAIM:** none beyond "no route reaches them".
- **CLASSIFICATION:** DEPLOYMENT-GATED.
- **EXCEPTIONS:** recognition-token revocation is **not durable**; `emergencyDeny` is a process-local instance field with no identity check and is **not consulted by EP-011**. Prompt 4 did **not** change any of that: the new interlock (EP-047/EP-048) is a separate control plane on a separate path.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4.

### EP-047, EP-048 — Emergency control operator writes
- **CLAIM:** these are the **only** way to set or clear an emergency control, they are reachable from trusted in-process operator code alone, and the execution path that reads them is typed against a reader port that declares no mutation — so no governed action, no route and no SDK method can disable the interlock that governs it (SEC-INV-051).
- **EVIDENCE:** `EmergencyControlReaderPort` / `EmergencyControlStorePort` in `src/features/emergency-control-runtime`; `emergency-control-composition.test.ts` asserts no execution source names the store port or calls `activate`/`release`, that the HTTP adapter and the frozen route list mention neither, that the SDK has no method, and that the Enterprise barrel re-exports types only.
- **CLASSIFICATION:** DEPLOYMENT-GATED — the *principal* is asserted by the composing host (§6.1), exactly as for EP-021…EP-026. The `issuerRef` a declaration carries is recorded for operator audit; it is not an authorization check, and this document does not describe it as one.
- **BYPASS CONDITIONS:** a writer with raw database access can clear a control by deleting its row. The record digest covers the `active` flag — so flipping it is detected and reads `unavailable`, which withholds — but an unkeyed digest cannot detect deletion, and cannot stop a writer who re-seals (SEC-TRUST-002, GS-001). `AOC_EMERGENCY_CONTROL.md` §8 states this rather than papering over it.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A4, D-A9.

### EP-027 — Runtime host signing
- **CLAIM:** none. **CLASSIFICATION:** DEAD / UNREACHABLE. **EVIDENCE:** `createAocEnterpriseRuntime` has no production caller in this repository — only `examples/`, `tests/` and `src/runtime/__tests__/`. Frontera ships no `RuntimeSignerPort` implementation.

### EP-028, EP-029 — Operator and build tooling
- **CLAIM:** these are operator surfaces, gated by filesystem permissions and by who may run them.
- **CLASSIFICATION:** DEPLOYMENT-GATED. **DEPLOYMENT ASSUMPTIONS:** D-A9, D-A10.

### EP-030 — CI
- **CLAIM:** the workflows build and test only; they publish nothing, deploy nothing, and reference **no secrets**.
- **EVIDENCE:** `.github/workflows/{ci,publishability}.yml` — `secrets.` appears zero times; no publish or deploy step exists.
- **CLASSIFICATION:** NON-EFFECTING. **EXCEPTIONS:** neither workflow declares a `permissions:` block, so the default `GITHUB_TOKEN` scope applies (TB-007). **DEPLOYMENT ASSUMPTIONS:** D-A10.

### EP-031 — Non-production file writes
- **CLASSIFICATION:** DEAD / UNREACHABLE. **EVIDENCE:** both packages are `private: true`; `packages/control-plane/store.ts` has **zero importers** anywhere in the repository.

### EP-032 … EP-035 — Stripe
- **CLAIM:** inbound events are cryptographically authenticated over the raw body and fail closed when unconfigured; outbound calls accept **no caller-supplied customer or price identifier**, so cross-customer effect is unreachable.
- **EVIDENCE:** §11.
- **CLASSIFICATION:** **EXCEPTED — SEPARATE AUTHORITY MODEL.**
- **BYPASS CONDITIONS:** EP-032 is unauthenticated (unbounded session creation — cost, not compromise); `STRIPE_SECRET_KEY` is process-resident.
- **DEPLOYMENT ASSUMPTIONS:** D-A5, D-A6.

### EP-036, EP-037, EP-038 — Issuer signing
- **CLAIM:** signing occurs only under a registry admin token or a completed Stripe purchase; passport issuance is single-use per purchase.
- **EVIDENCE:** §12; `markPurchasePassportIssued`.
- **CLASSIFICATION:** **EXCEPTED — SEPARATE AUTHORITY MODEL.**
- **EXCEPTIONS:** signing authorization **is** issuance authorization — there is no separate signing gate. The output is a **MAC, not a signature**; no third party can verify independently. EP-037 was outside the prior route inventory (NB-004).
- **BYPASS CONDITIONS:** possession of either bearer credential; possession of the secret both signs and verifies.
- **DEPLOYMENT ASSUMPTIONS:** D-A3, D-A7.

### EP-039 … EP-044 — Registry credentials, membership, exports, profile
- **CLAIM:** every one is registry-bound and cannot be replayed against another registry; credential comparison is `timingSafeEqual`; there is **no global administrator principal**.
- **CLASSIFICATION:** **EXCEPTED — SEPARATE AUTHORITY MODEL.**
- **BYPASS CONDITIONS:** APW-002 (permanent URL-borne owner credential), APW-007 (two disjoint authorization paths), APW-008, APW-010.
- **DEPLOYMENT ASSUMPTIONS:** D-A5, D-A9.

### EP-045 — Checkout status read
- **CLAIM:** read-only; cannot create a registry, mint a credential, or return one.
- **EVIDENCE:** §10.2; `apps/agent-passport-web/__tests__/apw-001-checkout-disclosure.test.ts` (APW-FIX-001…008).
- **CLASSIFICATION:** **NON-EFFECTING.**
- **EXCEPTIONS:** this closes APW-001 only. It places nothing behind Frontera authority (§10.3).

---

## 18. Defensible Security Claims

Each sentence below is repeatable verbatim. Each is backed by source and by a test that fails CI. **Every one carries its scope, and the scope is part of the claim.**

### 18.1 Claims we may make

1. **"On the bounded-grant authority-controlled execution path, an execution adapter is not invoked unless the authoritative current grant, re-read from the store at that instant, covers the exact assessed action."** (EP-011, §6)
2. **"On that path, every value crossing the adapter boundary is either a value an assessment proved inside a grant bound, or a value read from the trusted grant — there is no free-form payload channel."** (SEC-INV-014, 17-field whitelist)
3. **"On that path, a caller never holds, presents or can tamper with a grant: only an identifier crosses the boundary."** (SEC-INV-012, SEC-INV-026)
4. **"On that path, revocation and expiry are visible to the very next exercise, with no cache, no fast path and no background job."** (SEC-INV-013, SEC-INV-023)
5. **"Exactly one production source in this repository invokes an execution adapter, and the usable-assessment gate precedes it in the same function."** (§7.1, repository-wide structural test)
6. **"`AocKernel.enforce()` authorizes the declared action before invoking the executor and never invokes it on a non-allow outcome."** (SEC-INV-009)
7. **"Frontera contains multiple authority domains. The bounded-grant path has a strong path-local no-bypass property; the other application and provider paths are explicitly modelled and explicitly excepted in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`."**
8. **"Frontera never holds, requests, or can express a customer transaction signing key — no wallet, mnemonic, `signTransaction`, nonce, sequence number, chain identifier or ledger client exists anywhere in the repository."** (SEC-INV-025)
9. **"No production TypeScript in this repository executes a shell, spawns a child process, or evaluates dynamic code. The six dynamic imports that exist all carry constant string specifiers and none is caller-influenced."** (§4.2)
10. **"The entire outbound network surface of this repository is two provider SDKs — Pinata (one construction site) and Stripe (four) — plus, since P6, one Node HTTPS transport in the Generic HTTP adapter, and every site is enumerated in the effect-path inventory and pinned by a structural test."** (§7.5, §7.6, §18 test)
11. **"Correctness never depends on a background job having run: no timer, scheduler, cron, queue, worker or sweeper exists in the execution runtime."** (SEC-INV-023)
12. **"Inbound Stripe webhooks are signature-verified over the raw body, fail closed when unconfigured, and are replay-blocked by a unique constraint."** (§11.3)
13. **"No Agent Passport Web route accepts a caller-supplied Stripe customer or price identifier, so a tenant cannot cause an effect on another tenant's Stripe customer."** (§11.2)
14. **"`GET /api/checkout/session/[sessionId]` is read-only: it cannot create a registry, cannot mint an administrative credential or recovery code, and returns neither."** (EP-045, §10.2)
15. **"Grant issuance checks run inside the store's own commit boundary — the guard is synchronous by type, so no `await` can interleave between the read that decides and the write that records."** (SEC-INV-016)
16. **"Every published Frontera security invariant carries an explicit scope, and a scope may be widened only when code or a test proves the wider scope."** (SEC-INV change-control rule 1)

### 18.2 The rule that travels with every one of them

> SEC-INV-011 and claims 1–5 above are **PATH-LOCAL to the bounded-grant exercise path.** Any restatement that omits that scope is an overclaim, and any external artifact — architecture document, datasheet, questionnaire answer, sales material or model-facing summary — repeating them must carry it.

---

## 19. Claims We Must Not Make

Each of these is **false or unproven** at current `main`. The counter-evidence is given so no one re-derives it.

| ✗ Claim | Why it is not available |
|---|---|
| "All Frontera external effects require a bounded grant." | **False.** 3 of 46 effect paths are bounded-grant controlled. Pinata is reached by EP-015, EP-016, EP-018 and EP-020 without one; Stripe and issuer signing by none |
| "No external action can occur without Frontera authorization." | **False.** EP-020 needs only `PINATA_JWT`; EP-032 is unauthenticated; any code in either process reaches `process.env` |
| "Frontera proves that an executor performed only the declared action." | **False.** The executor is an opaque zero-argument closure and is never inspected (§8) |
| "The bounded-grant gate cannot be bypassed." | **Unscoped and therefore misleading.** True of Frontera's own code; false of the host that constructed the adapter (§7.4) |
| "Sovereign Access is covered by SEC-INV-011." | **False.** It reads an `EnterpriseAccessGrant`, not a `BoundedGrant`, and never calls the Kernel (SEC-INV-019) |
| "Content Protection uploads are authority-gated." | **False.** The only check is a caller-asserted tenant scope (NB-003) |
| "Agent Passport Web is governed by Frontera authority." | **False.** Zero occurrences of `AocKernel`, `BoundedGrant` or `GrantExecutionService` in the application |
| "APW-001's remediation places checkout behind Frontera authorization." | **False.** It made one unauthenticated endpoint read-only. Nothing in that application is bounded-grant controlled (§10.3) |
| "Store-layer tenant scoping is a hard chokepoint." | **Conditional.** With authentication off — the default — every caller is `{system:true}` and every scoping predicate returns `true` (NB-005) |
| "Agent Passports are cryptographically verifiable by third parties." | **False.** HMAC-SHA256; the public verify route is an oracle; the registered "public key" verifies nothing (§12) |
| "Frontera artifacts are cryptographically authenticated." | **False.** Unkeyed SHA-256 digests only. No signature exists anywhere in `src/` (SEC-TRUST-002, SEC-INV-U01) |
| "A bounded grant authorizes a single use." | **False.** There is no consumption model — the exercise path structurally forbids one. A usable grant may be exercised an unbounded number of times within its window (NB-006) |
| "Frontera contains a rogue agent." | **False.** Frontera governs declared actions. No process isolation, no egress control, no capability dropping, no sandbox, and no agent execution runtime exists (SEC-TRUST-005) |
| "A durable kill switch stops every authority-bearing path." | **False.** `emergencyDeny` is a process-local instance field, not durable, on no route, and **not consulted by the bounded-grant exercise path** (SEC-INV-U05) |
| "Grants survive a restart." | **False by default.** The only `BoundedGrantStorePort` implementation is in-memory (SEC-TRUST-003). Loss fails closed |
| "Frontera performs no dynamic imports." | **False as stated.** Six exist in `apps/agent-passport-web`; the defensible claim is the one in §18.1 claim 9 |
| "`apps/agent-passport-web` exposes 35 endpoints." | **Incomplete.** 35 method+path endpoints across 31 route files, **plus** one Next.js Server Action that triggers issuer signing (NB-004) |
| "There is one separate provider authority model (Sovereign Access)." | **Incomplete.** There are two. Content Protection is the second (NB-003) |

---

## 20. Findings

Eleven findings. A separate authority model is **not** a finding by itself; each entry below qualifies because it contradicts a claimed boundary, creates a real bypass of the same protected resource, is materially unsafe within its own boundary, or was undocumented and caused architectural ambiguity.

### NB-001 — The single-adapter-call-site proof was scoped to one directory, not to the repository
- **Severity:** LOW · **Effect path:** EP-011 · **Protected resource:** the bounded-grant execution adapter and its provider
- **Evidence:** `src/enterprise/__tests__/security-invariants.test.ts` asserts a single `adapter.execute(` call site, but `const EXECUTION_SOURCES = walkTsFiles('src/features/execution-runtime')` scans that directory only. `src/enterprise/execution-governance/service.ts:97` holds the same `ExecutionAdapter` as `options.executionAdapter` and lies outside the scan.
- **Threat:** a second invocation added in `execution-governance` — or anywhere else in `src/` — would void SEC-INV-011 while `execution-exercise.test.ts` and `security-invariants.test.ts` both still passed.
- **Existing mitigation:** the directory-scoped test, and the fact that `execution-governance` only passes the adapter through.
- **Why the proof was limited:** the guarantee's whole force is that there is exactly *one* place an adapter can be invoked, and that was asserted over a subset of the places one could be.
- **Residual risk:** **none — closed by this prompt.** `src/enterprise/__tests__/no-bypass-effect-paths.test.ts` scans `src/`, `packages/` and `apps/` and asserts the call-site set is exactly `['src/features/execution-runtime/services/grant-execution-service.ts']`. Non-vacuity validated in §25.
- **Future prompt owner:** none. Closed.

### NB-002 — `AocKernel.enforce()` binds no effect, and is reachable as a published API with no in-repo caller
- **Severity:** MEDIUM · **Effect path:** EP-014 · **Protected resource:** anything the host process can reach
- **Evidence:** `guarded-execution-service.ts:105` accepts `() => Promise<T> | T` and inspects nothing; the return value is recorded as `value` and is the only thing observed. `AocKernel` is exported on the published `./kernel` subpath. Every in-repo call site is a test or a demo scenario with a no-op executor; `kernel-integration.test.ts:46` asserts the Enterprise orchestrator never calls it.
- **Threat:** an embedding host declares `read:invoice`, obtains an allow, and moves funds inside the closure. The Governance Record faithfully attests the declaration.
- **Existing mitigation:** SEC-INV-009 — the executor is not invoked on any non-allow outcome; SEC-INV-010 already records the limit as a first-class invariant.
- **Why the proof is limited:** there is no structural, cryptographic or runtime relationship between the `ActionDescriptor` and the closure. Effect-time binding is what the bounded-grant path provides *instead*.
- **Residual risk:** unchanged from SC-003. Narrowed in one respect: no live effect path in this repository uses it today.
- **Future prompt owner:** a claiming decision now (this document); an architectural one later. Not Prompt 3's to redesign.

### NB-003 — A second, previously unmodelled provider authority model reaches Pinata
- **Severity:** MEDIUM · **Effect path:** EP-018, EP-019 · **Protected resource:** the Pinata account
- **Evidence:** `src/enterprise/content-protection/service.ts:197` calls `storage.store(...)`; the only production `ContentStoragePort` is `createPinataContentStorageAdapter` (`pinata-storage-adapter.ts:54-63`), which calls `client.uploadCiphertext`. The **only** authorization on the path is `requireContentProtectionAccessToOrganization(context, request.organizationId)` at `:100` — a caller-asserted tenant scope. No `BoundedGrant`, no `EnterpriseAccessGrant`, no `assertActive`, no Kernel decision.
- **Threat:** the architectural ambiguity, primarily. Prompt 2 §8 named Sovereign Access as *the* separate provider path (Path D) and Prompt 1 SEC-INV-019 scoped the exception to it. A reader concluding "Pinata is reached only through Sovereign Access" is wrong.
- **Existing mitigation:** tenant scoping is enforced; `service.ts` always passes ciphertext, never `request.plaintext`; the module is not wired into the composition root and is not on the published `exports` map.
- **Why the proof is limited:** a tenant-scope check answers "may this caller act for this organization", not "is this effect authorized". The adapter cannot distinguish ciphertext from plaintext; the ciphertext property is `service.ts`'s call ordering, proven only by that module's own tests.
- **Residual risk:** two independent authority models now govern one external resource, with a third ungoverned route (EP-020) underneath both.
- **Future prompt owner:** Prompt 11 (egress allowlisting) for the resource; Prompt 14 for the authority model.

### NB-004 — An HTTP-reachable signing and mutation path exists outside the route inventory
- **Severity:** MEDIUM · **Effect path:** EP-037 · **Protected resource:** the issuer signing key; registry entitlement capacity
- **Evidence:** `apps/agent-passport-web/src/app/enroll-agent/actions.ts` carries `'use server'` and exports `enrollAgentAction`, which calls `enrollAgent` (issuer signing), `createPassportRecord` and `addPassportToRegistry`. `AGENT_PASSPORT_WEB_THREAT_MODEL.md` §5 inventories 31 route files / 35 method+path endpoints by enumerating `app/api/**/route.ts`; Server Actions are HTTP-invocable and are not route files. Repository-wide, exactly one file carries `'use server'`.
- **Threat:** a surface that triggers signing and privileged mutation was not reviewed against the route table, so any statement of the form "all 35 endpoints were assessed" did not cover it.
- **Existing mitigation:** it enforces the same two credentials as EP-036 (registry admin token with an active-registry and capacity check, or a `completed` single-use purchase).
- **Why the proof is limited:** the enumeration method was route-file-based. It is additionally **weaker** than the route it mirrors — EP-036 wraps `addPassportToRegistry` in a `try/catch`; EP-037 does not, so a capacity-exhaustion race throws *after* the key has signed and the passport row has been written.
- **Residual risk:** no new authority model and no new credential — an inventory-completeness gap, now closed by EP-037 and by the structural test in §18 that requires every `'use server'` file to appear in this inventory.
- **Future prompt owner:** APPLICATION (align the action with the route's error handling, or have it delegate to the same helper).

### NB-005 — With authentication off, every HTTP caller is a cross-tenant `system` principal
- **Severity:** HIGH · **Effect path:** EP-002 … EP-008 · **Protected resource:** every `src/enterprise` store
- **Evidence:** `governance-read-service.ts:32` — `if (!configuration.features.requireAuthentication) return { system: true };`. `enterprise-configuration.ts:174` — `parseBoolean(env.AOC_ENTERPRISE_REQUIRE_AUTH, false)`. `store-common.ts:30`, `passport-store.ts:55`, `assurance-store.ts:68` all begin `if (context.system) return true;`. `enterprise-configuration.ts:178` defaults `http.host` to `0.0.0.0`.
- **Threat:** a default-configured deployment exposes passport lifecycle mutation (A-07), assurance mutation (A-08), evidence build and all governance reads to any network peer, **as a system principal across every tenant**.
- **Existing mitigation:** `DEPLOYMENT_GUIDE_V1.md` documents enabling authentication and binding loopback; tenant scoping is genuinely enforced once a caller is organization-scoped; the write paths are append-only and attributable.
- **Why the proof is limited:** this is the reason Prompt 2 §11's "store-layer tenant scoping = **HARD CHOKEPOINT**" is not correct as written. The scoping is real, but the *principal* it scopes against is produced by a configuration flag, so the chokepoint is a **DEPLOYMENT CHOKEPOINT**. SEC-TRUST-007 records the auth default; it does not record the `system: true` escalation or its effect on the chokepoint classification.
- **Residual risk:** unchanged in code; the classification is corrected here and in `TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` §11.
- **Future prompt owner:** Prompt 17 (deployment topology). Changing the default is a production behaviour change and is out of scope here.

### NB-006 — A bounded grant is unbounded in the number of times it may be exercised
- **Severity:** LOW · **Effect path:** EP-011 · **Protected resource:** the adapter's provider
- **Evidence:** `assessBoundedGrantExercise` has no use counter and reads none; `in-memory-bounded-grant-store.ts` records no exercise; `execution-layer-boundaries.test.ts:311-319` **structurally bans** a consumption model ("no counter, no remaining uses, no replay ledger").
- **Threat:** a grant for `transfer` / ceiling `7500 USD` authorizes an unlimited number of 7500-USD transfers until expiry or revocation. A reader taking SEC-INV-011 to mean "this exact action was authorized" may infer a single use.
- **Existing mitigation:** grant lifetimes are bounded and ceilings are attenuation-checked; revocation is immediate.
- **Why the proof is limited:** SEC-INV-011 is a **per-attempt** property and is silent about the sequence. That is deliberate — aggregate behaviour must be built outside layers B–E — but it was never stated.
- **Residual risk:** aggregate exposure is `lifetime × rate × ceiling`, not `ceiling`. *Updated by Prompt 4:* when the durable store is configured, this existing property now **persists across restart** — a widening of exposure in time rather than in amount. Prompt 4 added no consumption model and the durable schema is structurally pinned against one (`AUTHORITATIVE_GRANT_STORE.md` R-GS-06).
- **Future prompt owner:** Prompt 13 (SEC-INV-U06, aggregate bounding).

### NB-007 — One field crossing the adapter boundary is caller-supplied and unassessed
- **Severity:** INFORMATIONAL · **Effect path:** EP-011
- **Evidence:** `grant-execution-service.ts:133-137` builds `correlation` as `{ requestId, decisionId, executionId }`. `requestId` and `decisionId` are equality-checked against the trusted grant's correlation (`grant-exercise-assessment.ts:137`); `executionId` is checked only for non-emptiness (`grant-exercise-request.ts`).
- **Threat:** none directly — `executionId` carries no authority and names this attempt.
- **Existing mitigation:** the field is an identity, not a capability, and the adapter has nothing to do with it but correlate.
- **Why the proof is limited:** SEC-INV-014's "the validated action *is* the payload" is about the **channel** (no free-form field exists). It must not be read as "every field was compared to a bound" — 8 of 9 were.
- **Residual risk:** claim precision only.
- **Future prompt owner:** none; recorded so the claim stays exact.

### NB-008 — Policy-pack writes carry no caller identity, and they determine the authority a bounded grant is minted under
- **Severity:** MEDIUM · **Effect path:** EP-023 · **Protected resource:** the policy store (A-05), and transitively every decision
- **Evidence:** `policy-pack-registry.ts:81,121,129` — `savePack`, `saveVersion` and `activatePolicyPackVersion` take no caller parameter of any kind. Contrast `KernelAuthorityProvisioningService`, which requires `context.system === true` **and** an operator identity, enforced in the store.
- **Threat:** any in-process code holding the registry rewrites the rules every decision is made under. Because EP-012 issues a grant only after a Kernel `allow`, and that allow is produced under the active policy pack, rewriting the pack is an **indirect route to minting grants** — which makes the EP-011 gate correct and irrelevant for the actor who did it.
- **Existing mitigation:** no route exposes the registry; activation is recorded as an event; the registry is frozen before traffic in the assurance analogue (SEC-INV-034), but **not** for policy packs.
- **Why the proof is limited:** no identity check exists, so there is nothing to prove.
- **Residual risk:** the resource-centric consequence is that §14.2's "YES" is conditional on §14.7's "NO". *Preserved explicitly by Prompt 4:* **grant-store integrity does not imply authority-policy integrity.** The hardened store will faithfully — and now durably — persist a grant minted under a maliciously modified policy pack, and durability means such a grant outlives the process in which the policy was tampered with (`AUTHORITATIVE_GRANT_STORE.md` R-GS-05, D-GS6).
- **Future prompt owner:** Prompt 14 (authority-write hardening).

### NB-009 — The authoritative grant store the whole path-local proof rests on is in-memory, unkeyed and singly-implemented
- **Status as of Prompt 4: PARTIALLY CLOSED — REFINED.** The three defects this finding named are separable and have separate dispositions. *In-memory only*: **CLOSED** — `createSqliteBoundedGrantStore` (`src/enterprise/bounded-grant-store/`) is a production-capable durable implementation with transactional issuance and revocation, integrity verification on every authoritative read, and fail-closed corruption handling; the composition root selects it when `persistence.provider === 'sqlite'`. *Singly implemented*: **CLOSED** — two implementations now exist and their contract parity is asserted from one script (`bounded-grant-store-durability.test.ts`). *Unkeyed*: **OPEN**, carried forward as **GS-001** to Prompt 5. The specific fail-open shape this finding warned about — "a durable store that persists grants while losing or lagging revocations" — is **closed**: one file, one transaction, `synchronous = FULL`, and a two-record cross-check that refuses every partial state (`AUTHORITATIVE_GRANT_STORE.md` §9.1, GS-INV-005/006, tested by `revocation-deleted` and `pointer-cleared`). Snapshot rollback remains **NOT ADDRESSED** (GS-002). Canonical detail: `docs/security/AUTHORITATIVE_GRANT_STORE.md`.
- **Severity:** MEDIUM · **Effect path:** EP-011, EP-012, EP-013 · **Protected resource:** bounded grants and revocations (A-01)
- **Evidence:** `createInMemoryBoundedGrantStore` is the **only** implementation of `BoundedGrantStorePort` in the repository, and the composition root defaults to it (`composition-root.ts:474`). Grants and revocations live in two `Map`s. Integrity is `boundedGrantDigestMatches` — an **unkeyed** SHA-256 over `serializeBoundedGrant`, self-described in `bounded-grant.ts:144-152` as "integrity, not a signature".
- **Threat:** restart loses grants **and** revocations together, so the next exercise reads `GRANT_EXERCISE_NOT_FOUND` — **closed**. But a host-supplied *durable* store that persists grants while losing or lagging revocations would fail **open**, and the port's contract states revocation visibility as an obligation on the implementer rather than enforcing it. A writer able to re-digest can re-seal a grant with wider bounds and every check passes.
- **Existing mitigation:** grant loss fails closed; digest mismatch is refused, never repaired; the exercise path re-reads on every attempt with no cache.
- **Why the proof is limited:** every check in §6.2 is a check *against the store*. The store is the root of trust for the strongest guarantee in the repository, and it is the least hardened component in the path.
- **Residual risk (post-Prompt 4):** a writer who can rewrite a record **and** recompute its unkeyed digest still defeats every integrity check (GS-001, R-GS-01); restoring an older database snapshot still restores revoked authority (GS-002, R-GS-02); a deployment that never configured `persistence.provider = 'sqlite'` still runs the in-memory store, which loses grants and revocations together and therefore fails **closed** (GS-003, D-GS5).
- **Future prompt owner:** **Prompt 5** (cryptographic authenticity, SEC-INV-U01) for the keying gap; Prompt 17 for restore governance and default deployment posture.

### NB-010 — The two separate provider authority models are unreachable from a published-package consumer, and that was not recorded
- **Severity:** INFORMATIONAL · **Effect path:** EP-015 … EP-020
- **Evidence:** `package.json` `exports` declares nine subpaths; none resolves to `access-governance` or `content-protection`, so Node refuses a deep import with `ERR_PACKAGE_PATH_NOT_EXPORTED`. `src/enterprise/index.ts:590-600` states explicitly that Access Governance "deliberately has NO barrel export here yet". `@aoc-enterprise/pinata-adapter` is neither a declared dependency nor one of the four `bundleDependencies`.
- **Threat:** none. The finding is that the exception's **scope** was over-broad in every prior artifact.
- **Existing mitigation:** the `exports` map and the dependency set, both already in place.
- **Why this matters:** it materially narrows SC-002. The Sovereign Access and Content Protection exceptions apply to **monorepo and in-process hosts only**; a published-package consumer cannot reach Pinata through Frontera at all.
- **Residual risk:** the property is incidental rather than intentional — it would be lost the moment a barrel export or a declared dependency is added. Pinned by the structural test in §18.
- **Future prompt owner:** Prompt 11, as a starting position for egress allowlisting.

### NB-011 — Issuer signing authorization is issuance authorization, and the verification material is the signing material
- **Severity:** MEDIUM · **Effect path:** EP-036, EP-037, EP-038 · **Protected resource:** the issuer key
- **Evidence:** `issuer-signer.ts:52` — `createTestSigner({ secret: config.privateKeyPem })`, `algorithm: 'hmac-sha256'`. `passport-issuer.ts:50` — a second, independent `createHmac('sha256', PASSPORT_SIGNING_SECRET)` scheme. `passport-adapter.ts:116` builds its verifier from `createIssuerSignerFromEnv()` and never consults `SqliteIssuerKeyRepository`, so rotation invalidates every previously issued passport (APW-003).
- **Threat:** a relying party assumes a passport carries a verifiable signature. It carries a MAC. There is no non-repudiation and no independent verifiability; anyone holding the verification material can forge.
- **Existing mitigation:** the secret is server-side only; production requires all four variables and throws otherwise; `passport-issuer.ts` uses `timingSafeEqual` (though `createTestSigner.verify` uses `===`, a timing side channel on the live issuer path).
- **Why the proof is limited:** there is no separate signing gate to prove — issuance authorization *is* signing authorization. `AOC_ISSUER_PUBLIC_KEY_PEM` is registered as an issuer public key under a symmetric algorithm and verifies nothing.
- **Residual risk:** any external claim of "verifiable" or "non-repudiable" passports is unfounded. **This prompt does not remediate SC-004.**
- **Future prompt owner:** Prompt 5 (cryptographic authenticity), Prompt 6 (KMS/HSM).

### 20.1 Assessed and explicitly **not** findings

Recorded so they are not re-opened. **Sovereign Access being a separate authority model** (it is documented, deliberate, and no wider claim was made — only its previously over-broad scope is a finding, NB-010) · **Agent Passport Web being outside Frontera authority** (architectural by construction, §10.4) · **Stripe outbound being ungoverned by bounded grants** (no such claim exists; the meaningful property — no caller-supplied customer or price id — holds) · **`AocKernel.evaluate()` committing a Governance Record** (audit persistence, not a business effect, §4.1) · **SQLite `mkdirSync` at store construction** (boot-configured paths, never request-derived) · **Operator backup/restore tooling having full data-directory access** (that is what an operator surface is) · **CI's default `GITHUB_TOKEN` scope** (already TB-007; the workflows reference no secrets at all) · **The six constant-specifier dynamic imports** (no caller influence; not a dynamic-code-execution primitive).

### 20.2 SC-002 and SC-003 disposition

The two open architectural items this prompt was required to resolve. Neither is marked closed, because **documenting something does not close it.**

#### SC-002 — Sovereign Access external effect path outside bounded-grant control

**Disposition: REFINED — STILL OPEN.**

| Aspect | Before Prompt 3 | After Prompt 3 |
|---|---|---|
| What it names | One separate provider authority model (Sovereign Access → Pinata) | **Two** separate provider authority models reaching the same resource: Sovereign Access (EP-015/016/017) and Content Protection (EP-018/019) — NB-003 |
| Underneath both | Not stated | EP-020, an ungoverned raw SDK seam requiring only `PINATA_JWT` |
| Reachability | Implied to be part of the product surface | **Reachable only from a monorepo or in-process host.** Neither module is on the published `exports` map, and `@aoc-enterprise/pinata-adapter` is neither declared nor bundled — a published consumer cannot reach Pinata through Frontera at all (NB-010) |
| Decision required by Prompt 3 | "converge, or except with a documented rationale" | **EXCEPT**, with the rationale in §9.4: the two models answer different questions, convergence is a production behaviour change this prompt forbids, and the reachability is narrower than recorded |
| Status | OPEN | **OPEN**, correctly scoped for the first time |

It is **not** closed. Three routes to one external resource remain, one of them ungoverned. What changed is that the scope is now accurate and the resource-centric picture (§14.1) exists.

#### SC-003 — `AocKernel.enforce()` declaration vs opaque executor effect

**Disposition: REFINED — ACCEPTED ARCHITECTURAL LIMITATION, STILL OPEN.**

| Aspect | Before Prompt 3 | After Prompt 3 |
|---|---|---|
| The limit | Recorded as SEC-INV-010, a first-class invariant | Unchanged and re-verified from source (§8.2, §8.3) |
| Reachability | Not established | **No production caller exists in this repository.** Every call site is a test or a demo scenario with a no-op executor. It remains reachable as a published API on the `./kernel` subpath (NB-002) |
| The claim boundary | Stated in prose | Stated as a claim pair: §8.4's legitimate formulation is in §18.1 claim 6; the illegitimate one is in §19 |
| Status | OPEN | **OPEN as an accepted architectural limitation** |

It is **not** closed and **not** superseded. Effect-time binding is provided by the bounded-grant path *instead of*, not *in addition to*, `enforce()` — no accepted ADR gives grants a role in the executor gate. Closing SC-003 would mean either binding the effect (a Kernel redesign, out of scope) or deciding that the declaration-only guarantee is the permanent answer (a claiming decision this document makes explicit but does not finalise).

#### Both, stated together

Neither SC-002 nor SC-003 is a defect this prompt could close without changing production behaviour, which it was told not to do. Both are now **precisely scoped, resource-mapped and claim-bounded** — which is what Prompt 3 was for.


---

## 21. Inputs to Future Security Prompts

### 21.1 Prompt 4 — Harden the Authoritative Grant Store (immediate next)

**Status: COMPLETE.** Delivered as `docs/security/AUTHORITATIVE_GRANT_STORE.md` and `src/enterprise/bounded-grant-store/`. The table below is preserved as the record of what was handed over, with each row's post-Prompt-4 answer beside it.

| Question | Answer from this document |
|---|---|
| Which stores are authority-bearing? | A-01 bounded grants (`BoundedGrantStorePort`), A-02 governed authority + Kernel Authority (SQLite), A-04 recognition tokens (in-process `Map`), A-05 policy packs (in-process), A-06 approvals (in-process), A-10 `emergencyDeny` (instance field), A-11 Sovereign Access grants (SQLite), A-18/A-19 registry credentials (web SQLite) |
| Which grant store is in-memory only? | **At handoff:** `createInMemoryBoundedGrantStore` was the only `BoundedGrantStorePort` implementation, and `composition-root.ts:474` defaulted to it. **After Prompt 4:** two implementations; `buildBoundedGrantStore` selects the durable one when `persistence.provider === 'sqlite'`, the in-memory one otherwise |
| Which protected effect paths rely on it? | **EP-011, EP-012, EP-013** — and EP-011 is the only path carrying a PROVEN classification. Every check in §6.2 is a check against this store |
| Restart / durability implications | **At handoff:** grants and revocations shared the lifetime of one process; losing both together fails **closed**. The dangerous shape is a **durable store that persists grants but loses or lags revocations** — that fails **open**. **After Prompt 4:** on the durable store both survive, in one file, in one transaction, under `synchronous = FULL`, and the fail-open shape is unreachable (GS-INV-005/006). On the in-memory store the handoff answer still stands exactly |
| Integrity assumptions | **At handoff:** `boundedGrantDigestMatches` — **unkeyed** SHA-256 over `serializeBoundedGrant`, verified at assessment time only; revocation records carried **no digest at all**. **After Prompt 4:** grant *and* revocation records carry record-envelope digests verified on every authoritative read, plus a canonical round-trip and a two-record cross-check (GS-004 closed for the durable store). Still **unkeyed** — GS-001, Prompt 5 |
| Direct DB / write bypass primitives | In-process reference to the store object; for a durable implementation, filesystem write to the backing file; a re-sealing writer; `PolicyPackRegistry` writes as an indirect route to minting grants (NB-008) |
| Grant-store-specific findings from here | **NB-009** (primary; now PARTIALLY CLOSED — REFINED, see §20), NB-006 (no consumption model — a durable store must not invent one without an ADR, since `execution-layer-boundaries.test.ts:311` bans it; **Prompt 4 added none**, and the durable schema is pinned against one), NB-008 (indirect minting; **untouched** — grant-store integrity does not imply authority-policy integrity) |
| Properties Prompt 4 must not break | The synchronous `commitGuard` (`() => GrantCommitPrecondition` — no `await` may become possible); the re-read on every exercise with no cache; the store-port's read/revocation-only use on the exercise path (`execution-layer-boundaries.test.ts:206`); the no-sweeper ban (`:291`). **All four verified intact after Prompt 4**, and the third is now additionally enforced at the type level by `BoundedGrantReaderPort` (SEC-INV-038) |

### 21.2 All other prompts

| Prompt | Inherits from this document |
|---|---|
| **Prompt 5** (cryptographic authenticity) | **GS-001** — both persisted record digests are unkeyed; the attachment point is a detached signature over `serializeStoredGrantRecord` / `serializeStoredRevocationRecord`, verified in `verifiedGrant` / `verifiedRevocation` / `currentRevocation`, all three already fail-closed (`AUTHORITATIVE_GRANT_STORE.md` §23). **GS-002** — snapshot rollback needs an anchor outside the database. NB-011 — MAC vs signature. Revocation records now *do* carry a digest; what they lack is a key |
| **Prompt 6** (KMS/HSM) | NB-011 — both HMAC secrets are process-resident; rotation is destructive (APW-003); EP-027's `RuntimeSignerPort` is already KMS-shaped and has no implementation |
| **Prompt 7** (process isolation) | §15.1 — every self-modification row is NOT ADDRESSED or PARTIALLY BLOCKED because no process boundary exists. This is the dominating gap |
| **Prompt 9** (secret handling) | §15 — direct `process.env` access is a bypass primitive for **every** provider gate; the type-level exclusion covers only the public composition surface |
| **Prompt 10** (capability constraint) | §4.2 is the current, verified capability baseline; `apps/agent-passport-web` and most of `packages/` still have no capability-ban test (SEC-INV-U08) |
| **Prompt 11** (egress allowlisting) | §14.1 and §7.5 — the **complete** egress inventory is one Pinata construction site and four Stripe ones. NB-010 records that a published consumer already cannot reach Pinata; that is the starting position |
| **Prompt 12** (kill switch) | EP-026 — `emergencyDeny` is process-local, identity-free, on no route, and **not consulted by EP-011**. *Updated by Prompt 4:* EP-011 now has its **own** durable, fail-closed interlock (EP-047/EP-048, `AOC_EMERGENCY_CONTROL.md`), so the remaining gap is **convergence** rather than absence — one durable control plane honoured by the Action Enforcement path, Sovereign Access and Content Protection as well, plus an identity model on the operator writes |
| **Prompt 13** (aggregate bounding) | **NB-006** — the per-attempt/aggregate gap, with the structural ban at `execution-layer-boundaries.test.ts:311` that forces it to be built outside layers B–E |
| **Prompt 14** (authority-write hardening) | **NB-008** — `PolicyPackRegistry` has no caller identity; §13 is the complete authority-write inventory with each entry's identity model |
| **Prompt 15** (tamper-evident evidence) | §14.8 — the web store has no digest, no chain and no `verify` surface (APW-006); seven mutable `*_events` tables are the natural starting point |
| **Prompt 17** (deployment topology) | **NB-005** — the default posture is unauthenticated cross-tenant `system` on `0.0.0.0`; §16's ten deployment assumptions are the checklist; D-A6 makes webhook health a security prerequisite |

---

## 22. Change Control

1. **A new effect path must be added to §5 before it ships.** A path absent from §5 is covered by no claim in §18, and the structural tests in `no-bypass-effect-paths.test.ts` fail the build if a new provider SDK site, a new `ExecutionAdapter` invocation, a new route file, or a new `'use server'` file appears without a matching entry.
2. **A classification may only be strengthened by evidence.** Moving a path from EXCEPTED or PARTIALLY BOUND to PROVEN requires code or a test proving the wider property. Changing the prose is not promotion.
3. **§18 claims travel with their scope.** Claims 1–5 are PATH-LOCAL to bounded-grant exercise. Any restatement omitting that is an overclaim.
4. **§19 is not advisory.** Each row is a claim that is currently false or unproven. Adding a §18 claim that contradicts a §19 row requires deleting the §19 row, and deleting a §19 row requires the evidence that makes it false.
5. **Findings close on evidence, not on documentation.** NB-001 is closed because a test now fails when the property is violated. No other NB finding is closed.
