# PROMPT 3 — Prove No-Bypass Authority-Controlled Execution — Result

## SUMMARY

Enumerated every production-capable effect path in the repository from current source — **46 of them** — gave each a stable `EP-` id and exactly one classification, and proved or excepted each. The canonical artifact is `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`.

The headline number: **3 of 46 effect paths are under Frontera bounded-grant control.** The bounded-grant path earns a genuine path-local no-bypass proof (all fourteen required checks verified against source, and the single-adapter-call-site property now proven **repository-wide** rather than over one directory). Everything else is excepted by name, with its own authority model stated.

Prompt 2 handed over a list of nine effect-capable paths. Enumerating from source rather than from that list found **two effect paths no prior security artifact modelled**: a second Pinata egress in `src/enterprise/content-protection` (NB-003) and a Next.js Server Action in Agent Passport Web that triggers issuer signing (NB-004). That is the concrete reason this prompt was told not to rely on prior effect counts.

**Production behaviour unchanged.** Documentation, one new structural test file, and surgical corrections to four existing security documents.

## BASE / BRANCH

- **Branch used: `claude/youthful-bohr-4o8pp3`** — the branch this session is mandated to develop and push to. The prompt named `claude/frontera-no-bypass-execution`; the harness's branch assignment takes precedence, and no other branch was touched. Flagging the divergence explicitly rather than silently renaming.
- Base: `origin/main` @ `ad3322a7344819389374ccb15bc630c153ef4c55`.
- At prompt start `git rev-parse HEAD` and `git rev-parse origin/main` were **identical**; working tree clean.
- Prompt 0/1/2/2.5/2.6 artifacts all present and read in full before any change.
- No PR opened. Not merged.

## EFFECT TAXONOMY

Seven repository-specific categories: EXTERNAL EFFECT · SIGNING EFFECT · CREDENTIAL ISSUANCE EFFECT · AUTHORITY MUTATION · PRIVILEGED INTERNAL EFFECT · PERSISTENCE EFFECT · NON-EFFECTING EVALUATION.

Audit/evidence persistence is deliberately separated from business effect: `AocKernel.evaluate()` is NON-EFFECTING (EP-001) and its Governance Record commit is a distinct PERSISTENCE path (EP-002). Splitting them is what keeps SEC-INV-008 honest rather than convenient.

**Verified-empty categories** (checked, not assumed): no blockchain/ledger transaction, no shell or child process, no arbitrary dynamic code, no scheduler/cron/queue/worker, no email or notification, no server-side outbound `fetch` in `src/` or `packages/`, and no deploy/publish effect from production code or CI. The entire outbound network surface of the repository is **two SDKs**: `pinata` (one construction site) and `stripe` (four).

## EFFECT PATH INVENTORY

46 paths, EP-001 … EP-046.

| Classification | Count |
|---|---|
| PROVEN | 0 |
| **PROVEN — PATH LOCAL** | **3** (EP-011 exercise, EP-012 issuance, EP-013 revocation) |
| EXCEPTED — SEPARATE AUTHORITY MODEL | 18 |
| PARTIALLY BOUND | 1 (EP-014 `AocKernel.enforce`) |
| DEPLOYMENT-GATED | 17 |
| NON-EFFECTING | 5 |
| DEAD / UNREACHABLE | 2 |

## BOUNDED-GRANT PROOF

All fourteen required checks verified against current source (§6.2 of the canonical document). The two that needed more than a citation:

- **#10, no alternate invocation.** The existing `security-invariants.test.ts` asserted a single `adapter.execute(` call site but scanned only `src/features/execution-runtime`. `src/enterprise/execution-governance/service.ts` holds the same `ExecutionAdapter` and lies outside that scan, so a call added there would have voided SEC-INV-011 with every test still green. Recorded as **NB-001** and **closed** by a repository-wide scan.
- **#13, repeated exercise.** There is no consumption model — structurally banned at `execution-layer-boundaries.test.ts:311`. A usable grant may be exercised an **unbounded** number of times within its window. True and deliberate; it had never been stated. Recorded as **NB-006**.

Why this path can be PROVEN when the §5.7 authority-write paths cannot: on EP-011 the caller asserts **nothing about its own authority**. It supplies a grant identifier and a description of the attempt; the authority is read from the store and the attempt is checked against it. On EP-021/EP-022 the caller asserts `context.system` / `context.organizationId` about itself, so the boundary is only as strong as the host's composition discipline — DEPLOYMENT-GATED, not PROVEN.

Four limits travel with the claim: per-attempt not aggregate · the adapter is trusted host code (Frontera ships none) · the authoritative store is in-memory by default · the kill switch does not reach this path.

## ADAPTER REACHABILITY

Every `ExecutionAdapter` reference in `src/`, `packages/` and `apps/` is accounted for: the port declaration, one re-export, `execution-governance/service.ts` (holds it, passes it through, **never invokes it**), the gated service (**the one production invocation**), and one test fixture.

The one caller **not** accounted for, stated plainly rather than hidden: the adapter is constructed by the host and handed in, so the host retains its own reference and can invoke it directly. That is SEC-TRUST-004 exactly. The defensible sentence is *"every Frontera code path that reaches `ExecutionAdapter.execute()` passes the bounded-grant gate first"* — **not** *"no invocation of that adapter can occur without a bounded grant."*

## AOCKERNEL.ENFORCE

**PARTIALLY BOUND.** The executor is a zero-argument closure receiving nothing; the Kernel observes only its return value. A caller may declare A and execute B, and the Governance Record will faithfully attest A.

Legitimate: *"Frontera authorizes the declared action before invoking the executor, and never invokes it on a non-allow outcome."*
Illegitimate: *"Frontera proves that the executor performed only the declared action."*

One reachability refinement not previously recorded: **`AocKernel.enforce()` has no production caller anywhere in this repository** — every call site is a test or a demo scenario with a no-op executor. It stays production-capable because `AocKernel` is exported on the published `./kernel` subpath. So it is a published-API property, not a live effect path here today. Not redesigned, per scope.

## SOVEREIGN ACCESS

**EXCEPTED — SEPARATE AUTHORITY MODEL**, not converged. Full path traced end to end (EP-015/016/017). Rationale: the two models answer different questions; convergence is a production behaviour change this prompt forbids; and its reachability is **narrower than previously recorded** — neither `access-governance` nor `content-protection` is on the published `exports` map, and `@aoc-enterprise/pinata-adapter` is neither a declared nor a bundled dependency, so **a published-package consumer cannot reach Pinata through Frontera at all** (NB-010).

Bypasses within its own model, enumerated honestly: EP-020's raw SDK seam; a caller-asserted `AccessGovernanceContext`; a caller-supplied, grant-unbounded `requestedDurationSeconds`; no aggregate bound.

## AGENT PASSPORT WEB

All seven Prompt-3 requirements verified. Zero occurrences of `AocKernel`, `BoundedGrant`, `GrantExecutionService` or `AuthorityControlledExecution` anywhere in the application — now test-enforced.

**EXCEPTED**, and the wording matters: it is wrong to say this application "bypasses Frontera Core", because no claim was ever made that it sat behind Core. It is an application architected as its own trust zone.

**NB-004** — the 35-endpoint inventory enumerated `app/api/**/route.ts` files. It is complete for route files and **not** for HTTP-reachable effects: `app/enroll-agent/actions.ts` (`'use server'`) exports `enrollAgentAction`, which triggers issuer signing, writes a passport and decrements entitlement capacity under the same two possession-only credentials — and, unlike the route it mirrors, does not wrap `addPassportToRegistry` in a `try/catch`, so a capacity race throws *after* the key has signed.

## STRIPE EFFECT

Four outbound sites, one inbound webhook, all **EXCEPTED — SEPARATE AUTHORITY MODEL**. `POST /api/checkout/session` is fully unauthenticated (unbounded session creation: cost and noise, **not** cross-tenant compromise). No route anywhere accepts a caller-supplied Stripe customer or price id, so cross-customer effect is unreachable — that is the meaningful property, and it is claimable. Inbound webhook verification is the strongest cryptographic boundary in the repository.

## ISSUER SIGNING EFFECT

**EXCEPTED — SEPARATE AUTHORITY MODEL** (EP-036, EP-037, EP-038). Re-verified from source: HMAC-SHA256, two independent schemes, both process-resident. Signing authorization **is** issuance authorization — there is no separate signing gate to prove. The verification material is the signing material, so there is no non-repudiation and no independent third-party verifiability; the public verify route is an oracle. **SC-004 not remediated here** (NB-011).

## AUTHORITY-WRITE PATHS

Fourteen inventoried, each with its identity model. The generalisation that is **not** available: it is accurate that *grant* write surfaces are not caller-exposed; it is not accurate to extend that to authoritative state generally — passport lifecycle, assurance, registry credentials, registry roles and entitlement capacity are all deliberately HTTP-reachable.

## RESOURCE-CENTRIC REACHABILITY

| Protected resource | No-bypass proven? |
|---|---|
| Bounded-grant adapter / its provider | **YES — within Frontera code only** |
| Pinata account | **NO** — 5 routes, 2 ungoverned, 2 *different* authority models, bounded grants govern none |
| Stripe merchant account | **NO** (none claimed) |
| Issuer signing key | **NO** |
| Bounded-grant store | **PARTIALLY** |
| Governed-authority / Kernel Authority store | **PARTIALLY** |
| Policy store | **NO** |
| Agent Passport database | **NO**, and tamper is undetectable |

The most consequential row is the policy store: the authority a bounded grant is minted under depends on a Kernel decision made under policy packs that any in-process code holding the registry can rewrite **with no caller-identity parameter at all**. §14.2's "YES" is conditional on §14.7's "NO" (NB-008).

## BYPASS PRIMITIVES

24 assessed, and — per the brief — **alternate authority models are kept separate from bypasses of the same claimed boundary.** Sovereign Access, Content Protection and the Agent Passport Web surface are labelled ALTERNATE AUTHORITY MODEL, not bypass. Four things are verified **absent**: shell/child-process/dynamic-eval, scheduler/queue/worker, caller-controlled dynamic `import()`, and customer transaction key theft (no such key exists).

Self-modification (Step 13): every row is NOT ADDRESSED or PARTIALLY BLOCKED, because no process boundary exists. No process-level isolation is claimed, because none exists.

## PROVE-OR-EXCEPT MATRIX

Every EP group carries CLAIM / EVIDENCE / CLASSIFICATION / SCOPE / EXCEPTIONS / BYPASS CONDITIONS / DEPLOYMENT ASSUMPTIONS — §17 of the canonical document.

## NEW FINDINGS

| Id | Severity | Title |
|---|---|---|
| NB-001 | LOW | The single-adapter-call-site proof was scoped to one directory, not the repository — **closed by this prompt** |
| NB-002 | MEDIUM | `AocKernel.enforce()` binds no effect, and is reachable as a published API with no in-repo caller |
| **NB-003** | **MEDIUM** | **A second, previously unmodelled provider authority model reaches Pinata** (Content Protection) |
| **NB-004** | **MEDIUM** | **An HTTP-reachable signing and mutation path exists outside the route inventory** (Next.js Server Action) |
| **NB-005** | **HIGH** | **With authentication off (the default), every HTTP caller is a cross-tenant `system` principal** |
| NB-006 | LOW | A bounded grant is unbounded in the number of times it may be exercised |
| NB-007 | INFORMATIONAL | One field crossing the adapter boundary (`executionId`) is caller-supplied and unassessed |
| NB-008 | MEDIUM | Policy-pack writes carry no caller identity, and they determine the authority a grant is minted under |
| NB-009 | MEDIUM | The authoritative grant store the whole proof rests on is in-memory, unkeyed and singly-implemented |
| NB-010 | INFORMATIONAL | The two separate provider authority models are unreachable from a published-package consumer |
| NB-011 | MEDIUM | Issuer signing authorization is issuance authorization, and verification material is signing material |

Eight items were **assessed and explicitly not recorded as findings** — among them "Sovereign Access is a separate model" (documented and deliberate; only its over-broad scope is a finding) and "evaluate() commits a Governance Record" (audit persistence, not business effect).

## SC-002 DISPOSITION

**REFINED — STILL OPEN.** Not closed. What changed: it names **two** separate provider authority models reaching Pinata rather than one (NB-003); an ungoverned raw SDK seam beneath both is now named (EP-020); and the reachability is narrowed to monorepo/in-process hosts only (NB-010). Prompt 3's required decision — converge or except — is **EXCEPT**, with the rationale recorded.

## SC-003 DISPOSITION

**REFINED — ACCEPTED ARCHITECTURAL LIMITATION, STILL OPEN.** Not closed, not superseded. The limit is unchanged and re-verified; the addition is reachability (no in-repo production caller; published-API surface) and a claim pair that puts the legitimate formulation in the allowed list and the illegitimate one in the forbidden list.

## DEFENSIBLE SECURITY CLAIMS

16 claims, each backed by source and a CI-failing test, each carrying its scope. The rule that travels with them: claims 1–5 are **PATH-LOCAL to bounded-grant exercise**, and any restatement omitting that is an overclaim.

## CLAIMS WE MUST NOT MAKE

18 rows, each with its counter-evidence so nobody re-derives it. Including: *"All Frontera external effects require a bounded grant"* (false — 3 of 46), *"Store-layer tenant scoping is a hard chokepoint"* (conditional — NB-005), *"A bounded grant authorizes a single use"* (false — NB-006), and *"APW-001's remediation places checkout behind Frontera authorization"* (false — it made one endpoint read-only).

## FILES CHANGED

| File | Change |
|---|---|
| `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` | **New.** 1,215 lines, 22 sections |
| `src/enterprise/__tests__/no-bypass-effect-paths.test.ts` | **New.** 29 assertions across 7 suites |
| `docs/security/SECURITY_INVARIANTS.md` | 8 surgical edits: companion link; SEC-INV-011 boundary gains Content Protection; SEC-INV-019 records Prompt 3's decision; SEC-INV-021 boundary corrected (six constant-specifier dynamic imports, not one `require`); §5 and §5.4 pointers; §8.2 item 3; §9 rule 4 |
| `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` | Header supersession note; §8 gains Path D2 and the raw seam; §8 dynamic-import claim corrected; §11 chokepoint corrected to DEPLOYMENT (NB-005); §12 Prompt-3 owner rows resolved; new §17.7 resolution table |
| `docs/security/THREAT_MODEL_V1.md` | Companion-document link only |
| `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md` | §5 route-inventory correction (NB-004); §22 marked consumed |
| `README.md` | One documentation-index row |

No Prompt 0/1/2 history was rewritten and no historical result record was altered.

## TESTS

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `npm run lint` | **PASS** (Node16 imports, architecture, public surface) |
| `npm run test:root` | **PASS — 5474 tests, 982 suites, 0 fail** (was 5445 / 975 before; +29 from the new file) |
| `npm run test:workspaces` | **PASS — 1030 tests, 234 suites, 0 fail** |
| **Total** | **6504 tests, 0 failures** |

Targeted suites, all green: `no-bypass-effect-paths` 29 · `security-invariants` 17 · `structural-boundaries` 56 · `execution-exercise` 46 · `execution-layer-boundaries` 30 · `grant-transaction-boundary` 11 · `grant-attenuation` 67 · `authority-controlled-execution-boundaries` 22 · `access-grant-revocation` 16 · Kernel suites 210 · Agent Passport Web 291 (includes the APW-001 regression suite).

**One failure was introduced and fixed during the run, reported rather than buried.** The first `test:workspaces` run after adding the test file failed 2 provider-conformance assertions: this repository runs its own Pinata SDK import-boundary scanners textually over every `.ts` file, and my test's self-check contained a literal sample import specifier, which those scanners could not distinguish from a real one. Fixed by assembling the sample specifiers at runtime, with a comment explaining why. No production file was involved.

**Environment note:** at session start `node_modules` was absent, so `npm run typecheck` resolved an ambient TypeScript 6.0.2 and reported 34 `TS5101` `baseUrl`-deprecation errors, and 362 tests failed on missing workspace builds. `npm ci` resolved both — TypeScript 5.9.3 is installed transitively and the repo compiles with zero errors. Neither symptom was repository state.

## NON-VACUOUS TEST VALIDATION

Seven deliberate violations, each applied, measured, and reverted exactly. **No deliberate violation was committed**; `git status` confirmed a clean tree afterwards.

| # | Violation injected | Result | Assertion that caught it |
|---|---|---|---|
| 1 | Second `executionAdapter.execute(...)` call site in `execution-governance/service.ts` | **1 fail** | "is invoked from exactly one production source in the whole repository" |
| 2 | `import Stripe from 'stripe'` into a provider-neutral `src/` module | **2 fail** | "the Stripe SDK is constructed only in the four enumerated sources" + "no module under src/ or packages/ reaches Stripe" |
| 3 | `subject: request.subject` instead of the store-read `grantSubject` | **1 fail** | "the values crossing the adapter boundary come from the store, not from the request" |
| 4 | Barrel-export `createAccessGrantService` onto the published surface | **1 fail** | "src/enterprise/index.ts barrels neither Sovereign Access nor Content Protection" |
| 5 | Adapter invoked **before** the usable-assessment gate | **1 fail** | "the single invocation is still preceded by the store read and the usable-assessment gate" |
| 6 | A new Agent Passport Web `route.ts` with no EP id | **1 fail** | "the route-file count still matches the inventoried surface" |
| 7 | A new `'use server'` Server Action with no EP id | **1 fail** | "every Next.js Server Action file is named in the effect-path inventory" |

After each revert: **29 pass, 0 fail.**

## PRODUCTION BEHAVIOR CHANGED?

**NO.** Documentation, tests and comments only. No routing change, no authorization-semantics change, no Stripe change, no Sovereign Access change, no signer change, no grant-behaviour change, no sandboxing, no KMS/HSM, no provider-integration change, no public-API change. Where establishing a property would have required changing behaviour — converging Sovereign Access, binding `enforce()`'s executor, changing the authentication default — it was reported as a finding instead.

## PROMPT 4 INPUTS

**READY: YES.** §21.1 of the canonical document answers all eight required questions. The essentials:

- **The only `BoundedGrantStorePort` implementation in the repository is in-memory**, and the composition root defaults to it.
- **EP-011, EP-012 and EP-013 depend on it** — and EP-011 is the only path carrying a PROVEN classification. Every check in the proof is a check *against this store*.
- **Durability:** grants and revocations share one process lifetime. Losing both together fails **closed**. The dangerous shape is a durable store that persists grants while losing or lagging revocations — that fails **open**, and the port's contract states revocation visibility as an implementer obligation rather than enforcing it.
- **Integrity:** unkeyed SHA-256 over `serializeBoundedGrant`. A writer able to re-digest can re-seal. **Revocation records carry no digest at all.**
- **Write bypasses:** in-process store reference; filesystem write for a durable implementation; `PolicyPackRegistry` writes as an *indirect* route to minting grants (NB-008).
- **Findings inherited:** NB-009 (primary), NB-006, NB-008.
- **Properties Prompt 4 must not break:** the synchronous `commitGuard`; the re-read on every exercise with no cache; the store port's read/revocation-only use on the exercise path; the no-sweeper ban.

## READINESS

All twenty success criteria met. Every effect path inventoried and classified exactly once; the bounded-grant proof holds at its real scope; every adapter call site accounted for; `enforce()` described without overstatement; both separate provider authority models modelled; Agent Passport Web excepted with the correct wording; Stripe and issuer signing visible as effects; APW-001 re-verified and not mistaken for system-wide gating; authority-write paths inventoried; bypass primitives separated from alternate authority models; resources analysed resource-centrically; claims narrowed to exactly what source proves; tests pin real properties and are demonstrated non-vacuous; production behaviour unchanged; SC-002 and SC-003 dispositioned; Prompt 4 has what it needs.

```
PROMPT 3 COMPLETE
EFFECT PATHS FULLY INVENTORIED: YES
BOUNDED-GRANT NO-BYPASS PROOF: YES
PRODUCTION BEHAVIOR CHANGED: NO
READY FOR PROMPT 4: YES
```
