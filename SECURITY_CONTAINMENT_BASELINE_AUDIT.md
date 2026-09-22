# PROMPT 0 — SECURITY & CONTAINMENT ARCHITECTURE: BASELINE AUDIT

**Repository:** `Republika-Network/Frontera`
**Branch audited:** `main` @ `6efff5c` (identical to `claude/frontera-security-audit-eajd3o`; `git diff main..HEAD` is empty)
**Scope:** 1,871 TypeScript files across `src/`, `packages/` (36), `apps/` (5)
**Method:** code, tests, CI config, ADRs. No guarantee is asserted from naming or prose alone.

---

## SECTION 1 — AUTHORITY / EXECUTION SEPARATION

### 1.1 There are **three** distinct effect pipelines, not one

Frontera does not have a single request→effect path. It has three, with different authority models and different guarantees.

**Path 1 — Evaluation only (the frozen v1 HTTP surface).**

```
POST /api/governance/evaluate            src/enterprise/adapters/node-http-adapter.ts:137
  → auth (when enabled)                  src/enterprise/orchestration/evaluate-governance-request.ts:64
  → AocKernel.evaluate()                 src/kernel/AocKernel.ts:311
      → resolveGovernedConstraintContext (facts)        AocKernel.ts:320
      → resolveKernelContext             (facts)        AocKernel.ts:329
      → resolveKernelObligations         (facts)        AocKernel.ts:338
      → guard.preflight()                (the decision) AocKernel.ts:342
      → applyGovernedAuthorityStep       (narrows only) AocKernel.ts:357
      → applyContextStep                 (narrows only) AocKernel.ts:366
      → applyObligationStep              (adds a field) AocKernel.ts:376
      → applyGrantStep                   (adds a field) AocKernel.ts:386
      → assertKernelInvariants                          AocKernel.ts:388
  → single-transaction Governance Record append
```

`evaluate()` **invokes nothing.** No executor, no adapter, no network. This is the only network-reachable governance path in `src/enterprise`.

**Path 2 — `AocKernel.enforce()` (executor-gated, grant-free).**

```
AocKernel.enforce(request, executor)     src/kernel/AocKernel.ts:406
  → governed authority resolved BEFORE the executor      AocKernel.ts:419-426
  → context resolved BEFORE the executor                 AocKernel.ts:456
  → obligations resolved BEFORE the executor             AocKernel.ts:488
      ↳ blocking obligation unsatisfied → executor never reached, withheldBy:'obligation'  AocKernel.ts:491-546
  → guard.enforce(input, executor)                       AocKernel.ts:556
      → GuardedExecutionService.run()                    services/guarded-execution-service.ts:35
          → preflight()                                  :36
          → if (!decision.allowedToExecute) → return, executor never called   :39-91
          → await execute()                              :105   ← the only invocation site
  → applyGrantStep (reporting only, post-hoc)            AocKernel.ts:~600
```

**Path 3 — Bounded-grant exercise (the authority-controlled execution model).**

```
AuthorityControlledExecutionService.authorize()   src/enterprise/execution-governance/service.ts:239
  → kernel.evaluate()                                     :240
  → decision.grants must exist, else throw                :242-248
  → deriveGrantSourceAuthorization (projection)           :253
  → declaration-mismatch guard                            :267-275
  → resolveAuthorityBinding (REQUIRED)                    :277-283
  → issuanceFor(...).issueGrant() with a synchronous commitGuard   :286
      ↳ re-resolves the authority binding inside the store's critical section :197-234

… later, separately …

AuthorityControlledExecutionService.exercise()            :322
  → GrantExecutionService.exercise()   src/features/execution-runtime/services/grant-execution-service.ts:132
      → store.read(boundedGrantId)                        :154   ← authoritative re-read, every attempt
      → exercisedAt = now()  (sampled AFTER the read)     :158
      → assessBoundedGrantExercise(...)                   :168
      → if (!assessment.usable) → withheld, adapter NOT called   :176-178
      → adapter.execute(ValidatedExecutionAction)         :198   ← only reachable line
```

### 1.2 Answers

| Question | Answer | Evidence |
|---|---|---|
| Is authorization separated from execution? | **Yes, structurally**, on Path 3. `GrantExecutionService` contains no allow/deny and imports no policy layer; `ExecutionAdapter` receives no decision, status, scope, digest or source authorization. | `execution-adapter-port.ts:51-78`; `execution-layer-boundaries.test.ts:161-223` |
| Can an adapter be called without a successful grant check (Path 3)? | **No.** `adapter.execute` at `grant-execution-service.ts:198` is preceded by the unconditional early return at `:176-178`. `tests/execution-exercise.test.ts` asserts `callCount === 0` on every refusal row and `=== 1` on the valid row (25 cases). | `grant-execution-service.ts:176-198` |
| Are there alternate execution paths that bypass grant-aware execution? | **Yes — two, both by design.** `AocKernel.enforce()` (Path 2) and the Sovereign Access provider path (`src/enterprise/access-governance/service.ts:281`). Neither consults a bounded grant. | see §2 |
| Which production paths use the authority-controlled execution model? | Only deployments that explicitly compose `authorityControlledExecution` at the composition root. | `composition-root.ts:127`, `:244` |
| Is the grant-aware path opt-in or universal? | **Opt-in, and deliberately not network-reachable.** Composing it adds no HTTP route; it is in-process-trusted-host only. | `composition-root.ts:112-127` — "a caller must never be able to issue, extend, revoke or exercise its own grant" |
| Does `AocKernel.enforce()` still permit execution outside bounded-grant exercise? | **Yes.** `applyGrantStep` is applied *after* the executor has run and reads no decision field; the grant capability cannot withhold the executor. | `AocKernel.ts:556` then `:~600`; `structural-boundaries.test.ts:499-505` proves `applyGrantStep` reads no `result.status` |
| Intentional boundary or bypass risk? | **Intentional, and documented with a cited reason**: "No accepted ADR gives grants a role in the executor gate… making a configured grant capability withhold `enforce()`'s executor would invent a lifecycle semantic the architecture does not state." | `execution-governance/service.ts:56-64` |
| Can callers supply or mutate trusted grant contents? | **No.** `GrantExerciseRequest` carries a grant **id** and nothing else about the grant. `subject` and `notAfter` handed to the adapter are read from the store, never from the request. | `grant-execution-service.ts:37-44`, `:184-194` |
| Is authoritative state re-read at exercise time? | **Yes, on every attempt.** No cache, no fast path. | `grant-execution-service.ts:154` |
| Revocation/expiry checked immediately before execution? | **Yes.** Revocation = presence of the revocation record (`:123`); expiry derived from the instant sampled *after* the awaited read (`:130`, `:158`). | `grant-exercise-assessment.ts:119-130` |
| Bounds enforced fail-closed? | **Yes, and every failing axis is reported, not just the first.** Action, resources, counterparty, organization, amount. | `grant-exercise-assessment.ts:142-156` |
| Malformed / incomparable scope rejected? | **Yes.** `compareGrantBound` is total and returns `incomparable` for shape/unit/parse mismatch; `grantBoundComparisonPermits` treats `incomparable` exactly as `broader`. Absence on either side is a refusal (`axisAgrees`, `:176-179`). Malformed request refused before any comparison (`:110-112`). | `grant-exercise-assessment.ts:84-87`, `:176-179` |

**Classification — Path 3 exercise gate: A. STRUCTURALLY ENFORCED.**
**Classification — Path 2 executor gate: B. RUNTIME ENFORCED** (fail-closed on the *declared* action; see SC-003 for what it does not cover).

---

## SECTION 2 — NO-BYPASS ANALYSIS

### 2.1 Inventory of effect-capable primitives in the repository

I searched `src/`, `packages/`, `apps/`, `scripts/`, `infrastructure/` for `child_process`, `exec`, `spawn`, `fetch`, `node:http`, `node:net`, `axios`, `node-fetch`, WebSocket, `node:fs` writes, SQL mutation, `eval`, `new Function`, dynamic `import()`, and provider SDKs.

**The most important negative result:**

> **There is no `child_process`, `exec`, `spawn`, or shell invocation anywhere in Frontera's production TypeScript.** The only occurrences of the string are inside four boundary tests, as *forbidden patterns*, plus one `spawnSync` in `tests/protocol-canonicalization-regression.test.mjs` (test tooling).

Likewise: **no `eval`, no `new Function`, no dynamic `import()`** in production code. One `require('stripe')` at `apps/agent-passport-web/src/lib/stripe-billing-service.ts:20` — a constant specifier, not attacker-influenced.

### 2.2 Bypass Surface Matrix

| # | Effect path | Production? | Protected by authority gate? | Why / why not | Risk |
|---|---|---|---|---|---|
| 1 | `ExecutionAdapter.execute()` — `grant-execution-service.ts:198` | Yes (opt-in) | **Yes — bounded-grant exercise** | 12 fail-closed checks; grant read from store; no free-form payload field exists on the boundary type | **Low** |
| 2 | `execute()` closure — `guarded-execution-service.ts:105` | Yes | **Partial — decision gate only** | The closure is opaque to the runtime. Authorization is over a *declared* `ActionDescriptor`; nothing binds the closure's actual effect to it | **Medium** (SC-003) |
| 3 | `executePinataProviderTranslation` — `access-governance/service.ts:281` (temp-credential mint) and `pinata-revocation-enforcement.ts:110` | Yes | **Yes — but a different model** (`EnterpriseAccessGrant`, store-read + `assertActive`), **not** the Kernel, **not** a bounded grant | Parallel Sovereign Access authority model. Not HTTP-reachable; in-process trusted host only | **Medium** (SC-002) |
| 4 | Pinata SDK network egress — `pinata-provider-client.ts:169` (`new PinataSDK({ pinataJwt })`) | Yes | Inherits #3 | Only egress in `packages/` | Medium |
| 5 | Stripe API calls — `apps/agent-passport-web/src/lib/stripe-billing-service.ts` + 6 routes | Yes (SaaS app) | **No Frontera authority gate.** Guarded by the app's own session/registry-role checks | Product application code, outside the Kernel model entirely. Explicitly out of scope of `THREAT_MODEL_V1.md` §9 | **Medium** (SC-006) |
| 6 | Stripe webhook ingress — `api/stripe/webhook/route.ts` (`STRIPE_WEBHOOK_SECRET`) | Yes | Signature-verified, not authority-gated | Inbound; correct pattern | Low |
| 7 | `node:http` listener — `enterprise-server.ts:25`, `node-http-adapter.ts` | Yes | 8 route families; auth **off by default** | Only inbound network surface in `src/` | **High if misdeployed** (SC-001) |
| 8 | SQLite writes — 13 `sqlite-*-store.ts` modules under `src/enterprise/**` | Yes | Behind store ports; append-only or digest-re-sealed; tenant-scoped in-store | `existsSync`/`mkdirSync` only; paths from boot config, never from a request (`THREAT_MODEL_V1` §7.7) | Low |
| 9 | `apps/agent-passport-web` SQLite (`lib/db.ts`, 12 repositories) | Yes | App-level session/role checks | Separate persistence world from `src/enterprise` | Medium |
| 10 | Filesystem writes — `packages/control-plane/store.ts:37,47`; `packages/commercial-demo/src/cli.ts:24-25` | **No** | n/a | Demo CLI + local control-plane state file | Informational |
| 11 | `scripts/portability/backup-enterprise-v1.mjs` / `restore-enterprise-v1.mjs` | Operator tooling | Operator trust | Fully threat-modelled at `THREAT_MODEL_V1` §7.17 (12 threats, path-traversal + symlink refusal) | Low |
| 12 | Blockchain / XRPL / wallet / signing of chain transactions | **Absent** | n/a | Zero chain clients. `xrpl` appears only as a *forbidden pattern* in 5 boundary tests. `enterprise-tokenization-execution.ts:29`: "does not mint tokens, does not call a blockchain, does not hold keys" | **None — no surface** |
| 13 | Queue workers / cron / schedulers | **Absent in the authority path** | n/a | `execution-layer-boundaries.test.ts:291-299` fails the build if `setTimeout`, `setInterval`, `cron`, `queue`, `worker` or `sweep` appears in the execution runtime | None |
| 14 | Shell / child process | **Absent** | n/a | See §2.1 | **None — no surface** |

### 2.3 Separation requested

- **Production runtime effect paths:** #1, #2, #3, #4, #5, #6, #7, #8, #9
- **Operator/admin paths:** #11, `KernelAuthorityProvisioningService` (requires `context.system === true` *and* an operator context — `provisioning-service.ts:51-60`), `PolicyPackRegistry` (in-process, no route)
- **Build/test tooling:** #10, `scripts/*.mjs`, all `__tests__`/`tests` directories
- **Product-specific application code:** #5, #6, #9 (`apps/agent-passport-web`)

None of #10–#11 are classified as vulnerabilities.

**The decisive structural fact:** the Enterprise HTTP surface exposes **8 route families** (`node-http-adapter.ts:137,155,163,227,231,298,306,339`) — governance evaluate, evidence build/verify, assurance, passports, health. **There is no route that issues, extends, revokes or exercises a grant, and no route that invokes an adapter.** An external caller cannot reach any effect path in `src/enterprise` except by being trusted in-process code.

---

## SECTION 3 — TRUSTED / AUTHORITATIVE STATE

### 3.1 The stores

| Artifact | Authoritative store | Durability | Integrity | Mutability |
|---|---|---|---|---|
| Governance records | `GovernanceStore` (SQLite / in-memory) | Durable | SHA-256 per-section + aggregate + **hash chain** (`chain_position UNIQUE`, `previous_aggregate_digest`) | Append-only; **no public update/delete on the interface** (`structural-boundaries.test.ts:169`) |
| Bounded grants | `BoundedGrantStorePort` | **In-memory only — no durable implementation exists in the repo** | `sha256` digest over canonical form, verified at every exercise | Issue / read / revoke. No update, no delete on the port |
| Grant revocations | same | in-memory | immutable event held beside the grant | Idempotent; a second revoke returns the first |
| Obligations | Derived, never held ("obligation state is derived, never held" — `AocKernel.ts:~590`) | n/a | n/a | Cannot be double-discharged |
| Governed authority / reservations / encumbrances | `sqlite-authority-store.ts` | Durable | Per-row digest **verified on read, fail-closed** (`:646`, `:671`, `assertReservationIntegrity`) + chained `transition_digest` | Mutable rows, **re-sealed** on transition (`:1101`) |
| Kernel authority (durable) | `sqlite-kernel-authority-store.ts` | Durable, opt-in | Event-sourced, chained `previousEventDigest`, `payloadDigest` | Append-only; revocation terminal (`append-rules.ts`) |
| Issuer key metadata | `SqliteIssuerKeyRepository` (`apps/agent-passport-web`) | Durable | none | `registerKey` |
| Evidence bundles | `EvidenceStore` | Durable | `bundleDigest` / `recordDigest` / `verificationDigest` | Immutable |
| Passports | `sqlite-passport-store.ts` | Durable | Per-event chained digests, contiguous `sequence`, `UNIQUE(passport_id, sequence)` | Append-only + a projection cache |
| Recognition capability tokens, authority graph, approvals, handshake | **In-process `Map`** (`capability-token-service.ts:47`) | **Process memory. Lost on restart.** | none | Full in-process mutation |

### 3.2 Answers

**What prevents an untrusted caller from rewriting trusted authority?**
Topology, not a check. There is no HTTP route to any authority write. `KernelAuthorityProvisioningService` requires `system: true` plus an operator context. `PolicyPackRegistry.savePack/saveVersion/activatePolicyPackVersion` (`policy-pack-registry.ts:81,121,129`) are in-process APIs with no caller identity at all — they are protected *only* by not being exposed.

**What happens if the store itself is compromised?**
The repository answers this explicitly and correctly. `bounded-grant.ts:144-152`:

> "**This is integrity, not a signature.** … it is no defence against a privileged writer able to rewrite both a grant and its digest — the same limit the Governance Store states for its own digests, and the honest one to state here."

`THREAT_MODEL_V1.md` §7.3 and §8.3 say the same for governance state. This is an **explicitly acknowledged, deliberately deferred** trust assumption, not an oversight.

**Cryptographically authenticated, or digest-only?**
Digest-only, everywhere. SHA-256 over `aoc.canonical-json.v1`. **No signatures anywhere in `src/`.** The only signing in the repository is HMAC in `packages/agent-governance` and `apps/agent-passport-web` (§4).

**Can a privileged writer rewrite both object and digest?** Yes — for every store. Blast radius:
- *Governance store:* must also recompute the full hash chain forward. Detectable against out-of-band backups/exported bundles, not in-band.
- *Authority store:* digests verified on read, so a naive row edit **fails closed**; a writer who re-digests succeeds silently.
- *Bounded grants:* in-memory, so "compromise the store" collapses to "compromise the process."

**Deletion possible?** Not through any store interface. `grep 'DELETE FROM'` across `src/enterprise` returns zero production hits. Deletion is a filesystem/DBA capability, outside the software boundary.

**Which artifacts depend on mutable rows?** Governed authority positions, reservations, encumbrances, mandate status/execution counts, assurance status, passport projections. All are digest-re-sealed on write; the *chain* (transitions, passport events) is the append-only record behind them.

**Classification:** integrity — **B. RUNTIME ENFORCED** (authority store, grant exercise) / **D. PARTIALLY IMPLEMENTED** (governance store: verified on explicit `verify`, not on `get` — `THREAT_MODEL_V1` §7.1 residual). Authenticity — **E. DEFERRED**, explicitly.

---

## SECTION 4 — SIGNING / KEY BOUNDARIES

### 4.1 Signer inventory

| # | Signer / key concept | Production? | Where private material lives | In process memory? | From env? |
|---|---|---|---|---|---|
| 1 | `createTestSigner` — HMAC-SHA256 — `packages/agent-governance/src/signing/test-signer.ts` | **Yes, used as the production issuer signer** (see #2) | `options.secret`, closure-captured | Yes | Transitively |
| 2 | `createIssuerSignerFromEnv` — `apps/agent-passport-web/src/lib/issuer/issuer-signer.ts:47` | **Yes** — the live Agent Passport issuance path (`passport-adapter.ts:52,116,151,334`) | `AOC_ISSUER_PRIVATE_KEY_PEM` | Yes | **Yes** |
| 3 | `signAgentPassportPayload` — `apps/agent-passport-web/src/lib/passport-issuer.ts:53` | Yes | `PASSPORT_SIGNING_SECRET` | Yes | **Yes** |
| 4 | `createDevSigner` — `lib/dev-signer.ts` | **No — dead code**, zero call sites | `AOC_DEV_SIGNING_SECRET` or a literal default | — | — |
| 5 | `issuePMFreakAgentPassport` default signer — `pmfreak-agent-passport-issuance-service.ts:57` | Declared non-production | **Hardcoded literal** `'aoc-test-signing-secret-do-not-use-in-production'` | Yes | No |
| 6 | Governance / evidence / grant digests | Yes | **No key** — plain SHA-256 | n/a | n/a |
| 7 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Yes | env | Yes | Yes |
| 8 | `PINATA_JWT` | Yes | env → `new PinataSDK({ pinataJwt })` | Yes | Yes |
| 9 | KMS / HSM abstraction | **Does not exist.** Zero occurrences in `src/`, `packages/`, `apps/`, `docs/operations` | — | — | — |
| 10 | Customer blockchain / wallet keys | **Do not exist anywhere in the repository** | — | — | — |

### 4.2 Findings

**Every production signing key is a symmetric HMAC secret, process-resident, loaded from an environment variable.** No asymmetric signing, no KMS, no HSM.

**The `_PEM` naming is misleading.** `issuer-signer.ts` reads `AOC_ISSUER_PRIVATE_KEY_PEM` / `AOC_ISSUER_PUBLIC_KEY_PEM`, declares `algorithm: 'hmac-sha256'` (`:27`), and then passes the "private key PEM" as the HMAC `secret` (`:52`). The "public key" is registered into `SqliteIssuerKeyRepository` with `metadata: { signerBoundary: 'server-side-env' }` (`:66`) but **cannot verify anything** — HMAC is symmetric. Any party given that "public key" to verify a passport must instead be given the secret, which would let them forge. The file says so honestly at `:49-51`, but the field names do not.

**Two parallel HMAC schemes in the same app, with different safety.** `passport-issuer.ts:75-84` uses `timingSafeEqual`. `test-signer.ts:35` uses `computeHmac(payload) === signature.signature` — a plain string comparison, i.e. a timing side channel on the live issuer verification path.

**Is the signer API KMS-ready?** **Yes.** `AgentPassportSignerPort` (`signing/signer-port.ts:9-12`) is `sign(payload: string): Promise<AgentPassportSignature>` / `verify(...): Promise<boolean>` — async, opaque payload, no key material in the type. A KMS/HSM implementation drops in without any domain-semantics change. This is the one genuinely good structural property in this section.

### 4.3 The desired invariant, tested

> **"Frontera must not require unilateral custody of customer transaction keys."**

**HOLDS — and is architecturally chosen, not accidental.**

- No wallet, no mnemonic, no `signTransaction`, no nonce, no sequence number, no chain identifier in any production source.
- `execution-layer-boundaries.test.ts:226-248` **fails the build** if any of `xrpl|xrp|ripple|ledger|wallet|mnemonic|private[_-]?key|signTransaction|sequenceNumber|nonce|gasLimit|blockchain|on-?chain` appears in the execution runtime.
- `structural-boundaries.test.ts:480-484` applies the same ban to the grant layer.
- `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §10: *"No IAM, no authentication, no session management, no password or key custody for target systems."*
- `enterprise-tokenization-execution.ts:29`: *"does not mint tokens, does not call a blockchain, does not hold keys."*
- `execution-adapter-port.ts:32-38`: *"Not a ledger client, not a signer, not a wallet, not a transaction builder."*

**Classification: A. STRUCTURALLY ENFORCED.** This is the strongest single security property in the repository.

### 4.4 The distinction, stated

- **Frontera issuer signing authority** — real, in use, HMAC, process-resident, env-loaded, **not** a signature in the non-repudiation sense. Scope: Agent Passports and runtime seals.
- **Customer-controlled transaction signing authority** — **does not exist in Frontera and is structurally prevented from existing.** No production code signs a customer transaction.

They are not the same thing, and the repository does not conflate them.

---

## SECTION 5 — SECRETS

### 5.1 Inventory (no values printed)

Complete set of `process.env.*` reads in `src/`, `packages/`, `apps/`, `scripts/`:

`NODE_ENV`(15) · `STRIPE_SECRET_KEY`(6) · `NEXT_PUBLIC_AGENT_PASSPORT_BASE_URL`(6) · `PASSPORT_SIGNING_SECRET`(5) · `PASSPORT_ISSUER_KEY_ID`(4) · `PASSPORT_ISSUER_ID`(4) · `AOC_ISSUER_PUBLIC_KEY_PEM`(4) · `AOC_ISSUER_PRIVATE_KEY_PEM`(4) · `AOC_ISSUER_KEY_ID`(4) · `AOC_ISSUER_ID`(4) · `PASSPORT_ISSUER_NAME`(3) · `NEXT_PUBLIC_BASE_URL`(2) · `AOC_DEV_SIGNING_SECRET`(2) · `AOC_ALLOW_DEV_SIGNER`(2) · `AOC_AGENT_PASSPORT_DB_PATH`(2) · `STRIPE_WEBHOOK_SECRET` · `PINATA_JWT` · `PINATA_GATEWAY` · `AGENT_PASSPORT_DB_PATH` · 4 Pinata test vars.

Plus 29 `AOC_ENTERPRISE_*` keys read through a **single injectable reader**: `loadEnterpriseConfiguration(env = process.env)` (`enterprise-configuration.ts:147`). Only one is a secret: `AOC_ENTERPRISE_API_KEYS`.

### 5.2 Findings

**Long-lived secrets required in production:** `AOC_ENTERPRISE_API_KEYS`, `AOC_ISSUER_PRIVATE_KEY_PEM`, `PASSPORT_SIGNING_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PINATA_JWT`. **All process-resident. All rotated only by restart.**

**Is secret access scoped?** In `src/enterprise`, **yes, and it is structurally proven.** Four tests at `structural-boundaries.test.ts:256-299` enforce:
- `AocEnterprise.configuration` is typed as the redacted `PublicEnterpriseConfiguration`, never the secret-bearing type;
- `getInternalEnterpriseConfiguration` is **never re-exported** from the public entrypoint;
- no module defines a hardcoded `DEFAULT_API_KEYS`;
- `loadEnterpriseConfiguration` never falls back to a non-empty API key;
- the HTTP adapter authenticates via the internal accessor, never via the public field.

In `apps/agent-passport-web`, **no.** `process.env` is read ad hoc across `lib/` and route handlers.

**Is there a Secrets Manager / KMS abstraction?** **No.** Zero hits for `kms`, `hsm`, `secrets manager`, `vault` (as key custody) in production code or operations docs. `src/runtime/vault/` is a *logical isolation/continuity* boundary with deterministic fingerprints and **no cryptography at all** — its own doc says "Attestation is deterministic but not cryptographically signed yet." It must not be read as a key vault.

**Redaction:** real, deterministic, and applied **before digest computation** (`redaction.ts:1-5`) at `projection.ts:76,91,200,300` and `store-common.ts:169,189,212`. Terms: `authorization, token, api key, secret, password, passphrase, private key, cookie, session, credential, bearer` with a documented `*Id`/`*Ids` exemption (`:59`).

**Its limit:** redaction is **key-name based only**. There is no value-pattern matching. A secret carried under an innocuous key (`note`, `description`, `parameters.value`) is canonicalized, digested and persisted verbatim into a Governance Record — and, because the digest covers it, cannot be removed without breaking the chain. `THREAT_MODEL_V1` §5 describes an evidence-side "secret-pattern" redaction pass; the governance-store implementation I read is key-name only.

**Applications combining agent-controlled input + process env + arbitrary execution capability:** **none.** `apps/agent-passport-web` has env + network, but no `eval`, no dynamic import, no `child_process`, no user-supplied code execution. The combination the question warns about does not exist in this repository.

**Classification:** enterprise secret scoping — **A. STRUCTURALLY ENFORCED**. Redaction — **D. PARTIALLY IMPLEMENTED**. Secret management / rotation — **F. OUTSIDE REPOSITORY RESPONSIBILITY**, but see SC-008: the boundary is not documented.

---

## SECTION 6 — RUNTIME CAPABILITIES

### 6.1 Capability Matrix

Production TypeScript only; tooling excluded.

| Layer / module | FS | Network | DB | Spawn | Sign | Provider effect | Env | Dynamic code | Structurally restricted? |
|---|---|---|---|---|---|---|---|---|---|
| `src/kernel/**` (Kernel) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **Yes** — `structural-boundaries.test.ts:56,141,97` |
| `src/features/grant-runtime/**` (E) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **Yes** — `grant-layer-boundaries.test.ts:139` |
| `src/features/execution-runtime/**` | ✗ | ✗ | ✗ | ✗ | ✗ | via port only | ✗ | ✗ | **Yes** — `execution-layer-boundaries.test.ts:149-157, 270-279` |
| `src/features/obligation-runtime/**` (D) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **Yes** — `obligation-layer-boundaries.test.ts:80` |
| `src/features/context-resolution-runtime/**` (C) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **Yes** — `context-layer-boundaries.test.ts:62` |
| `src/features/action-enforcement/**` | ✗ | ✗ | ✗ | ✗ | ✗ | **opaque `execute()` closure** | ✗ | ✗ | Partial — no dedicated capability-ban test |
| `src/features/domain-policy-pack-runtime/**` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Partial — closed algebra by construction, no ban test |
| `src/enterprise/governance-store/**` + 12 sibling stores | **mkdir only** | ✗ | **Yes** | ✗ | ✗ | ✗ | ✗ | ✗ | Partial — `:156,225` ban SQL outside stores |
| `src/enterprise/adapters/node-http-adapter.ts` | ✗ | **inbound** | ✗ | ✗ | ✗ | ✗ | via internal accessor | ✗ | Partial |
| `src/enterprise/access-governance/**` | ✗ | via Pinata adapter | Yes | ✗ | ✗ | **Yes** | ✗ | ✗ | No |
| `src/runtime/**` (legacy: vault/federation/audit) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **Yes** — `:47,71`; `check-aoc-boundaries.mjs` |
| `packages/pinata-adapter/**` | ✗ | **Yes (SDK)** | ✗ | ✗ | ✗ | **Yes** | ✗ | ✗ | No |
| `packages/agent-governance/**` | ✗ | ✗ | ✗ | ✗ | **HMAC** | ✗ | ✗ | ✗ | No |
| `apps/agent-passport-web/**` | ✗ | **Yes (Stripe/fetch)** | **Yes** | ✗ | **HMAC** | **Yes** | **Yes, ambient** | `require('stripe')` | No |

### 6.2 The structural bans that actually exist

Four modules — grant, execution, obligation, context runtimes — each carry a boundary test that **fails `npm test`**, which CI runs on every PR and push to `main` (`.github/workflows/ci.yml`). The banned set, verbatim from `execution-layer-boundaries.test.ts:150,272,282,292,302`:

```
node:fs · node:http · node:net · node:child_process · fetch( · better-sqlite3
eval( · new Function( · import( · vm · Function('
Date.now( · new Date() · performance.now
setTimeout · setInterval · cron · sweep · scheduler · queue · worker
randomUUID · Math.random · randomBytes · uuid
```

plus provider-name bans (`Pinata|IPFS|S3|Azure|SharePoint|Stripe`), chain/wallet/key bans, token-format bans (`jwt|macaroon|UCAN|oauth|bearer|signed_url`), AI/inference bans (`anthropic|openai|llm|inference|embedding|prompt|riskScore|anomal|recommend`), and a whitelist of the **exact 17 field names** permitted to cross the execution boundary (`:371-396`).

This is the strongest capability-restriction evidence in the repository, and it is genuine: the test proves its own comment-stripper is non-vacuous before applying the rules (`:95-100`).

**What is NOT covered:** `src/enterprise/**` as a whole, `src/features/action-enforcement/**`, all of `packages/**`, and all of `apps/**` have no capability-ban test.

**Classification: A. STRUCTURALLY ENFORCED for layers C, D, E and the execution runtime. E. NOT IMPLEMENTED elsewhere.**

---

## SECTION 7 — AGENT RUNTIME / SANDBOX

I searched the entire repository for: sandbox, seccomp, AppArmor, namespace isolation, Firecracker, microVM, gVisor, cgroup, rootless, capability drop, egress, container isolation, ephemeral runtime, per-agent workload identity.

**Results:**

- `infrastructure/terraform/`, `infrastructure/docker/`, `infrastructure/kubernetes/` contain **`.gitkeep` and nothing else.**
- The word "sandbox" appears in exactly two meanings, neither of them security isolation: a **pilot-scope enum value** (`pilot-scope.ts:1` — `'demo_only' | 'sandbox' | 'customer_non_production' | 'production_shadow_mode'`), and a **policy-pack simulation store** (`policy-pack-simulation-service.ts:28` — an in-memory copy for what-if evaluation).
- No Dockerfile, no seccomp profile, no cgroup limit, no timeout/kill control on any agent, no ephemeral credential issuance, no per-agent workload identity.

### The two claims, separated

> **Does Frontera currently govern agents?**
> **Yes.** It issues Agent Passports with a constitution hash, a policy manifest hash and a runtime seal; it evaluates an agent's declared action against a declared policy manifest; it records an attributable, chained, digest-sealed event trail. `packages/agent-governance/src/runtime-guard/` implements this.

> **Does Frontera currently execute arbitrary agent code inside a security sandbox?**
> **No. Frontera does not execute agent code at all**, sandboxed or otherwise. There is no agent execution runtime in this repository.

And a sharper point, because the naming invites a wrong reading: `enforceAgentRuntimeGuard` (`runtime-guard.ts:246-270`) **enforces nothing.** It calls `evaluateAgentRuntimeGuard`, emits an event, and returns `{ decision, allowed, requiresHumanApproval, blocked }`. It receives no executor and withholds nothing. It is an **advisory decision function**; honoring it is entirely the caller's responsibility. Its only production call sites (`passport-adapter.ts:171,351`) are demo/proof pages.

**Classification: E. DEFERRED / NOT IMPLEMENTED.** Per the prompt's instruction, this is recorded as a missing capability, **not** as a defect in the authority logic — which is sound within its own scope.

---

## SECTION 8 — SELF-MODIFICATION / ROOT OF TRUST

Could an actor governed by Frontera, through any normal runtime interface, modify:

| Target | Reachable from the network surface? | What protects it | Protection type |
|---|---|---|---|
| Constitution-equivalent rules (`agent-governance/constitution`) | No | Hash-bound into the passport; created at enrollment | Code boundary |
| Policy packs | **No route exists.** `savePack`/`saveVersion`/`activatePolicyPackVersion` (`policy-pack-registry.ts:81,121,129`) are in-process only, with **no caller identity and no authorization check** | Topology only | **Deployment / code boundary** |
| Assurance frameworks | No — composition-time only, registry **frozen before traffic**, immutable per version (`THREAT_MODEL_V1` §7.11) | Registration validation + freeze | **Structural** |
| Its own grants | No — no issuance/extension/revocation/exercise route exists; `execution-layer-boundaries.test.ts:399-408` fails the build if the execution runtime exports any `handler|route|controller|endpoint` | Structural test | **Structural** |
| Authority bindings | No — `resolveAuthorityBinding` is a required host-supplied function; re-resolved at commit; **any** change refuses issuance (`execution-governance/service.ts:230-232`) | Commit-boundary equality check | **Runtime, fail-closed** |
| Revocation logic | No | Pure functions in layer E; no route | Code boundary |
| Enforcement code | No | Code, not data. No dynamic loading anywhere | **Structural** |
| Signer configuration | No — `getIssuerSignerConfigFromEnv` reads env once at call time | Process environment | Deployment |
| Trusted store contents | No route. Kernel authority writes require `system: true` + operator context | Authorization + topology | Runtime + deployment |
| Root-of-trust configuration | No | `THREAT_MODEL_V1` §2.6: "Whoever controls env vars, the process user, and the data directory is fully trusted (root-of-trust)" | Deployment |

### Verdict on the principle

> **"The authority boundary must not be solely implemented inside a component that the governed actor can modify."**

**The current architecture respects this principle — but the *reason* is topology, not a mechanism.**

The governed actor's only interface is `POST /api/governance/evaluate`, which is read-only with respect to every authority artifact. The actor cannot reach the policy registry, the grant store, the signer config or the enforcement code because **none of them is exposed**, not because a check would refuse it.

That is a real and defensible protection. But it is **F/deployment-shaped, not A/structural**: the day a deployment exposes `PolicyPackRegistry.activatePolicyPackVersion` behind an admin route, there is no in-code authorization to stop a caller who reaches it — the registry has no notion of who is calling. `KernelAuthorityProvisioningService` is the counter-example done right (`provisioning-service.ts:51-60`: every method requires `context.system === true` *and* an operator context), and it shows the gap in the policy-pack registry by contrast.

**Classification: D. PARTIALLY IMPLEMENTED** — code-boundary + deployment-based, with one authorization-based island (kernel authority provisioning) and one unguarded write surface (policy pack registry).

---

## SECTION 9 — NETWORK / DEPLOYMENT BOUNDARY

`docs/operations/DEPLOYMENT_GUIDE_V1.md` (290 lines) is unusually concrete for a repository of this maturity.

| Control | Required / recommended? | Where | Owner |
|---|---|---|---|
| Private interface binding | **Required and loud** — "Any deployment reachable beyond localhost MUST set…" (`:101-102`); systemd unit sets `AOC_ENTERPRISE_HTTP_HOST=127.0.0.1` (`:207`) | Deployment guide | Deployment |
| TLS termination | **Required** — "Terminate TLS at the proxy; the Host itself is plain HTTP" (`:252`) | Deployment guide | Deployment |
| Reverse proxy | Required, with body-limit, timeout and header-forwarding specifics (`:250-266`) | Deployment guide | Deployment |
| Restricted ingress / segmentation | Implied by 127.0.0.1 binding | Partial | Deployment |
| Non-public databases | **Yes** — named volume, never the container writable layer, read-only root FS supported (`:238-244`) | Deployment guide | Deployment |
| Non-root execution | **Yes** — `User=aoc`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `UMask=0077`, `ReadWritePaths` scoped (`:216-224`) | Deployment guide | Deployment |
| **Rate limiting** | **Not stated.** `THREAT_MODEL_V1` §7.6 says "Deploy behind a reverse proxy with rate limits; **see deployment guide**" — **the deployment guide does not mention rate limiting.** | **Missing** | — |
| WAF | Not mentioned | Missing | — |
| DDoS protection | Not mentioned | Missing | — |
| IAM isolation / workload identity | Not mentioned | Missing | — |
| Secret manager | Not mentioned. Guide says `EnvironmentFile=/etc/aoc-enterprise/secrets.env` (`:212`) | Missing | — |
| KMS / HSM | Not mentioned anywhere | Missing | — |
| Centralized logs | **Yes** — structured JSON to stdout, never secrets/tokens/paths; `governance.audit.decision` line per decision (`:270-282`) | Deployment guide | Shared |
| Backup / restore | **Yes** — two dedicated documents + automated `backup:v1`/`restore:v1` tooling with checksum, integrity, path-traversal and symlink validation | Operations docs | Shared |
| Monitoring | Partial — `/live`, `/ready`, `/health` probes | Deployment guide | Deployment |
| Incident response | **Yes** — `RUNBOOKS_V1.md` §6 | Operations docs | Shared |

### The shared-responsibility boundary

**Repository-enforceable:** fail-closed evaluation, store integrity/chaining, tenant scoping in the store layer, constant-time API-key matching, 1 MiB body cap, prepared statements everywhere, schema-version fail-closed, redaction before persistence, append-only interfaces, and the layer/capability boundary tests.

**Correctly delegated to deployment:** TLS, ingress ACLs, rate limiting, WAF, DDoS, secret storage/rotation, key custody, filesystem/DBA control, OS hardening, backup storage encryption.

**The gap is not the delegation — it is that the boundary is nowhere written down as a single artifact.** There is no `SHARED_RESPONSIBILITY.md` and no enterprise security-posture document. A customer security review today must reconstruct the boundary from `THREAT_MODEL_V1` §8/§9 plus the deployment guide plus three ADRs.

**Classification: F. OUTSIDE REPOSITORY RESPONSIBILITY** for the controls themselves; **C. DOCUMENTED CONTRACT** with a gap for the boundary statement (SC-008).

---

## SECTION 10 — ROGUE AGENT / PAC-MAN SCENARIOS

| | Scenario | Verdict | Why, exactly |
|---|---|---|---|
| **A** | Action outside grant scope | **BLOCKED** | `grant-exercise-assessment.ts:142-156`: action/resource/counterparty/organization/amount each compared via `compareGrantBound`; absence on either side refuses (`:176-179`); `incomparable` treated as `broader` (`:84-87`). Adapter not reached (`grant-execution-service.ts:176`). 25 tests count adapter invocations. |
| **B** | Valid action at abusive frequency | **NOT ADDRESSED** | Deliberately. `execution-layer-boundaries.test.ts:311-319` **fails the build** if `remainingUses|usageCount|singleUse|consume|decrement|replayLedger` appears — "every accepted ADR is silent on it, and repeated exercise is currently permitted." No rate limiting in `src/` (zero hits). The only bound is a grant's `expiresAt`. |
| **B** *(P7 update)* | Valid action at abusive frequency — **P7-enabled bounded-grant path** | **ADDRESSED — PATH-LOCAL** | When a deployment composes `exerciseControls`, repeated exercise is bounded by host-declared lifetime and rolling limits on count and exact-decimal amount, through a reservation that consumes before the adapter runs (SEC-INV-070 … SEC-INV-079). The row above still describes every other path, and the execution runtime itself still holds no consumption model — P7 put it in `src/features/exercise-control-runtime`. |
| **C** | Agent modifies the presented grant payload to increase amount | **BLOCKED — structurally** | The agent cannot present a grant. `GrantExerciseRequest` carries only `boundedGrantId`; the grant is read from the store on every attempt (`:154`), and `subject`/`notAfter` reaching the adapter come from the stored grant, never the request (`:184-194`). There is no field to tamper with. |
| **D** | Attacker modifies a stored grant but not its digest | **BLOCKED** | `boundedGrantDigestMatches` (`bounded-grant.ts:158`) checked **first**, before any bound is read (`grant-exercise-assessment.ts:119`) — "refused, never repaired." Same posture in the authority store: `assertReservationIntegrity`/`assertEncumbranceIntegrity` fail the read (`sqlite-authority-store.ts:646,671`). |
| **E** | Privileged attacker modifies **both** grant and digest | **NOT ADDRESSED — explicitly and honestly** | `bounded-grant.ts:144-152`: "no defence against a privileged writer able to rewrite both a grant and its digest." Same for governance (`THREAT_MODEL_V1` §7.3, §8.2/§8.3). Digests are unkeyed SHA-256; there are no signatures. Detection depends on out-of-band copies. This is the top deferred item. |
| **F** | Agent alters its own authority/grant | **BLOCKED** | No route exists. `composition-root.ts:112-127`: grant-aware execution "adds no route: a caller must never be able to issue, extend, revoke or exercise its own grant." `execution-layer-boundaries.test.ts:399-408` fails the build if a handler/route/controller is ever exported. `structural-boundaries.test.ts:486-492`: the Kernel may not even import the issuance path. |
| **G** | Arbitrary code execution inside the agent's own process | **NOT ADDRESSED** | No process isolation exists (§7). If the agent shares a process with Frontera, it inherits the process's capabilities entirely. If it does not, Frontera has no visibility into it. |
| **H** | Agent reads `process.env` for production secrets | **DEPLOYMENT-DEPENDENT** | Same-process: **not blocked** — `AOC_ENTERPRISE_API_KEYS`, `AOC_ISSUER_PRIVATE_KEY_PEM`, `STRIPE_SECRET_KEY`, `PINATA_JWT` are all ambient. Separate process: blocked by the OS, nothing to do with Frontera. Frontera provides no secretless execution model. |
| **I** | `node:child_process` / shell | **DEPLOYMENT-DEPENDENT** | *Frontera itself* never spawns: zero occurrences in production code, and four boundary tests ban the import. But an agent in the same process faces **no in-process restriction** — Node has no capability model and Frontera installs none. |
| **J** | Agent reaches the provider/API directly | **NOT ADDRESSED** | There is no egress control, no allowlist, no network namespace. An agent with network access reaches Pinata/Stripe/any API directly. Frontera's gate is a **voluntary chokepoint**, not a mandatory one. |
| **K** | Agent compromises the authoritative database | **PARTIALLY BLOCKED** | Bounded grants are **in-memory**, so this collapses into L. Durable stores: naive row edits fail closed (D); a full re-seal succeeds (E). Deletion/reordering of governance records breaks the chain and is detectable on `verify`. |
| **L** | Agent compromises the Frontera host | **NOT ADDRESSED — and correctly so** | `THREAT_MODEL_V1` §2.6 names the operator boundary as the **root of trust**. Host compromise is total: env secrets, HMAC keys, store files, in-memory recognition/authority state, emergency-deny flag, and the ability to re-seal every digest. |
| **M** | Agent uses or steals a customer blockchain private key | **BLOCKED — no such key exists** | The strongest result in this table. No wallet, no mnemonic, no `signTransaction`, no chain client anywhere; `execution-layer-boundaries.test.ts:226-248` and `structural-boundaries.test.ts:480-484` fail the build on the vocabulary; `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §10 states "no key custody for target systems" as an architectural non-goal. There is nothing to steal. |
| **N** | Many individually-authorized actions, maliciously aggregated | **NOT ADDRESSED** | No behavioral analysis, no velocity, no anomaly detection (zero hits for `anomal|velocity|abuse|throttl` in production). Deliberate: `execution-layer-boundaries.test.ts:214-222` **bans** `riskScore|anomal|recommend` from the execution runtime — "AI is outside the authorization path under every configuration." The nearest partial control is capacity conservation in the authority store (reservations/encumbrances). |
| **N** *(P7 update)* | Many individually-authorized actions, maliciously aggregated — **P7-enabled bounded-grant path** | **PARTIALLY ADDRESSED — PATH-LOCAL** | Host-declared buckets (per grant, actor, organization, counterparty, …) can cap aggregate count, amount and velocity on the P7-enabled path. There is still no behavioural or anomaly analysis anywhere, and the policy is trusted host configuration, not detection. |
| **O** | Adapter receives valid metadata but substitutes a different payload | **PARTIALLY BLOCKED** | *Path 3:* strongly mitigated — `ValidatedExecutionAction` has **no free-form payload, blob or opaque reference**, and `execution-layer-boundaries.test.ts:352-396` fails the build if `payload|blob|rawBody|opaqueRef|commandRef` appears, with a 17-name field whitelist. The comment names this exact attack: "a grant for 7500 to V123 submitting a payload for 100000 to V999." *Path 2:* **not blocked** — `execute()` at `guarded-execution-service.ts:105` is an opaque closure. *In both:* the adapter/closure is trusted code; the *channel* is constrained, the *implementation* is not verified. |
| **P** | Previously authorized agent continues after revocation | **BLOCKED on Path 3, NOT ADDRESSED on Path 2** | Path 3: the store is re-read on every exercise, revocation presence is the whole check, no cache, no sweeper — "a revocation committed a millisecond ago is visible to the very next exercise" (`grant-execution-service.ts:37-48`, `:123`), and `execution-exercise.test.ts:185` proves only the pre-revocation exercise reached the provider. Path 2: `AocKernel.enforce()` consults no grant and no revocation of one; revocation there means revoking the underlying recognition/capability token, which is **in-process memory** (`capability-token-service.ts:47`) and therefore not durable. |

**Score: 5 BLOCKED · 3 PARTIALLY BLOCKED · 6 NOT ADDRESSED · 2 DEPLOYMENT-DEPENDENT.**

Every BLOCKED result is an **authorization-security** result. Every NOT ADDRESSED result is a **containment-security** result. That distribution is the single most important output of this audit.

---

## SECTION 11 — EXISTING SECURITY INVARIANTS

Extracted from implementation, with the test that proves each.

| # | Invariant (repository wording where it exists) | Mechanism | Proving test | Scope |
|---|---|---|---|---|
| I-1 | "Nothing external runs through this service unless a bounded grant held by the authoritative store covers the exact action being attempted, at the instant it is attempted." | `grant-execution-service.ts:176-198` | `execution-exercise.test.ts` — adapter `callCount` asserted 0/1 on all 12 refusal rows + valid row | Layer E→execution |
| I-2 | "The grant is read, never received." | `GrantExerciseRequest` carries only an id; `store.read` on every attempt | `execution-exercise.test.ts`; type shape | Layer E→execution |
| I-3 | "Every field crossing this boundary was assessed" — no free-form payload/blob/opaque ref | `execution-adapter-port.ts:40-49` | `execution-layer-boundaries.test.ts:352-396` (pattern ban + 17-name whitelist) | Execution boundary |
| I-4 | "The Kernel remains the only decision producer." (`ADR-AUTHORITY-CONTROL-LAYERING` §4) | Layer dependency rule | `structural-boundaries.test.ts:300-505`; `execution-layer-boundaries.test.ts:160-223` | System-wide |
| I-5 | "Narrowing-only, attenuation-only, fail-closed." (§5) | `applyGovernedAuthorityStep`, `applyContextStep` narrow; `applyObligationStep`/`applyGrantStep` add and read nothing | `structural-boundaries.test.ts:428,499` — `applyGrantStep` may not read `result.status/reasonCodes/summary/policies` | Kernel |
| I-6 | "Facts-only layers are structurally incapable of deciding." (§3) | Context/obligation return types carry no verdict | `context-layer-boundaries.test.ts`, `obligation-layer-boundaries.test.ts` | Layers C, D |
| I-7 | "Every new capability arrives as an optional port; omitted → byte-identical behaviour." (§6) | Every Kernel option is `?` and short-circuits | `kernel-*-capability-absent.test.ts` (4 characterization tests) | Kernel |
| I-8 | Invariant 1 — no action allowed for an unrecognized actor | `assertRecognitionPrecedesAllow` throws `KernelInvariantError` | `kernel-invariants.test.ts` | Kernel, every call |
| I-9 | Invariant 8 — every terminal result carries machine-readable reasons | `assertReasonCodesPresent` | `kernel-invariants.test.ts` | Kernel, every call |
| I-10 | The request is never mutated by evaluation | `cloneKernelEvaluationRequest` + `deepEqual` (`Object.is`, Date-by-epoch) | `kernel-invariants.test.ts` | Kernel, every call |
| I-11 | Issuance checks run inside the store's own transaction | `commitGuard` is **synchronous by type** — "a guard that were `async` would reintroduce exactly the interleaving the discipline exists to prevent, so the type forbids it" | `grant-transaction-boundary.test.ts` | Layer E |
| I-12 | Any change to the authority binding between measurement and commit refuses issuance | `grantAuthorityBindingsMatch` equality, not containment (`service.ts:230`) | `authority-controlled-execution-scenario.test.ts` | Execution governance |
| I-13 | The four reason-code vocabularies are disjoint | `GRANT_EXERCISE_` prefix + cross-checks | `execution-layer-boundaries.test.ts:322-350` | System-wide |
| I-14 | No AI, model, or inference dependency can enter the authorization path under any configuration | Import + vocabulary ban | `execution-layer-boundaries.test.ts:214-222` | Layers B–E |
| I-15 | Provider credentials never appear on the public composition surface | `PublicEnterpriseConfiguration` typing; internal accessor not re-exported | `structural-boundaries.test.ts:256-299` (5 tests) | Enterprise Host |
| I-16 | No caller-facing surface for grants | Export-name ban | `execution-layer-boundaries.test.ts:399-408` | Layer E/execution |
| I-17 | Store interfaces expose no public update or delete | Interface shape | `structural-boundaries.test.ts:169,238` | Governance + Passport stores |
| I-18 | Redaction happens before persistence, before digesting, before logging | `redaction.ts:78-83`, applied in `projection.ts` | governance-store tests | Governance Store |
| I-19 | Determinism: no ambient clock, no ambient randomness in layers C/D/E/execution | Pattern ban | `execution-layer-boundaries.test.ts:281-309` | Layers C–E |
| I-20 | Correctness never depends on a background job having run | Timer/scheduler/queue/worker ban | `execution-layer-boundaries.test.ts:291-299` | Layer E/execution |

### Invariants that SHOULD exist and currently do not

*(Identified only. Not implemented, per the prompt.)*

| # | Missing invariant | Would close |
|---|---|---|
| M-1 | **NO AUTHORITY ARTIFACT IS TRUSTED WITHOUT A VERIFIED SIGNATURE FROM A KEY THE APPLICATION PROCESS CANNOT READ.** | Scenario E |
| M-2 | **NO PRODUCTION SIGNING KEY IS EVER RESIDENT IN APPLICATION PROCESS MEMORY.** | H, L |
| M-3 | **NO EGRESS TO A PROVIDER EXCEPT FROM AN ALLOWLISTED ADAPTER AT A CONTROLLED NETWORK BOUNDARY.** | J |
| M-4 | **NO GOVERNED AGENT EXECUTES IN A PROCESS THAT HOLDS ANY SECRET OR ANY AUTHORITY-WRITE CAPABILITY.** | G, H, I |
| M-5 | **EVERY AUTHORITY-BEARING PATH HONOURS A SINGLE DURABLE KILL SWITCH.** | Emergency stop; today `emergencyDeny` is an in-process boolean (`action-enforcement-runtime.ts:108`) that the grant-exercise path never consults and that does not survive a restart. |
| M-6 | **AGGREGATE BEHAVIOUR IS BOUNDED, NOT ONLY PER-ACTION BEHAVIOUR.** | B, N. *Updated by P7:* **PROVEN — PATH-LOCAL** for the P7-enabled bounded-grant exercise path only — host-declared aggregate count, aggregate amount and rolling-velocity limits admitted through an atomic, durable reservation before the adapter, with exact-equality authority-binding revalidation (SEC-INV-070 … SEC-INV-079, `docs/enterprise/AOC_EXERCISE_CONTROLS.md`). **Not system-wide:** `AocKernel.enforce`, Sovereign Access, Content Protection, Pinata and Stripe outside ACE, and application networking remain gaps, and SEC-INV-U06 stays unimplemented system-wide. |
| M-7 | **NO VALUE MATCHING A SECRET PATTERN IS PERSISTED INTO A GOVERNANCE RECORD, WHATEVER ITS KEY.** | Redaction gap |
| M-8 | **EVERY LAYER THAT MAY NOT PERFORM I/O HAS A CAPABILITY-BAN TEST** (extend the four existing ones to `action-enforcement`, `enterprise`, and effect-capable `packages/`). | Capability-matrix gaps |

---

## SECTION 12 — FINDINGS

Severity reflects **current production composition**, not aspiration. "Future KMS integration" is not CRITICAL because the affected surfaces are either non-production or explicitly deferred with a stated trust assumption.

### CRITICAL

**None.**

I want to be explicit about why, because the temptation is to promote SC-001 or SC-002. No finding in this repository currently gives an unauthenticated remote party the ability to produce a privileged external effect through a path the architecture intends to be gated. The three candidates all fail that test: SC-001 requires a misdeployment the guide loudly forbids; SC-002 is a parallel-but-real authority model reachable only from trusted in-process code; SC-004 affects an issuance path whose failure mode is forged *credentials*, not forged *execution*, and requires either host compromise or secret exfiltration first.

### HIGH

---

**SC-001 — Enterprise Host authentication is disabled by default**
- **Severity:** HIGH · **Classification:** C. DOCUMENTED CONTRACT
- **Paths:** `src/enterprise/configuration/enterprise-configuration.ts:174`; `src/enterprise/orchestration/evaluate-governance-request.ts:64`; `src/enterprise/orchestration/governance-read-service.ts:32`
- **Evidence:** `requireAuthentication: parseBoolean(env.AOC_ENTERPRISE_REQUIRE_AUTH, false)`. With it false, `evaluate-governance-request.ts:64` returns before any auth check and `governance-read-service.ts:32` grants `{ system: true }` — i.e. **cross-tenant access**. Default listen host is `0.0.0.0` (`DEPLOYMENT_GUIDE_V1.md:90`).
- **Risk:** An operator who deploys without reading §Security gets an unauthenticated, cross-tenant governance API on all interfaces.
- **Exploitable in current composition?** Only in a misconfigured deployment. Not a code defect.
- **Blocks production?** No — the guide states the requirement at `:101-102` in mandatory language, the threat model lists it as accepted risk §8.1, and four structural tests prove no hardcoded key fallback exists.
- **Remediation:** invert the default keyed on `AOC_ENTERPRISE_ENV=production`, or refuse to bind a non-loopback interface with auth off. **Owner: Prompt 17 (Harden Production Deployment Topology) + Prompt 22 (Production Readiness Gate).**

---

**SC-002 — A second production effect path exists outside the authority-control pipeline**
- **Severity:** HIGH · **Classification:** D. PARTIALLY IMPLEMENTED
- **Paths:** `src/enterprise/access-governance/service.ts:252-296` (`requestProviderCredential`), `:281`; `src/enterprise/access-governance/pinata-revocation-enforcement.ts:110`; `packages/pinata-adapter/src/pinata-provider-client.ts:169`
- **Evidence:** `requestProviderCredential` mints a live Pinata temporary-access URL after only `store.getGrant(context, id)` + `assertActive(grant.status)`. It never calls `AocKernel`, never reads a `BoundedGrant`, and never passes through `GrantExecutionService`. It is a parallel `EnterpriseAccessGrant` authority model with its own lifecycle.
- **Risk:** The "no adapter call without a usable exercise assessment" invariant is **local to layer E**, not system-wide. A reader who takes it as system-wide will misjudge the blast radius of a compromised in-process caller.
- **Exploitable?** Not remotely — no HTTP route reaches it. Reachable by any trusted in-process host code.
- **Blocks production?** No. It is a real authority model with a store read and a status check; it is simply a *different* one.
- **Remediation:** state the two-model reality as an explicit invariant boundary, or converge the Sovereign Access path onto bounded-grant exercise. **Owner: Prompt 3 (Prove No-Bypass Authority-Controlled Execution) — this finding should reshape that prompt's scope from "prove one path" to "enumerate all paths, then prove or explicitly except each."**

---

**SC-003 — `AocKernel.enforce()` authorizes a declaration and invokes an opaque closure**
- **Severity:** HIGH · **Classification:** C. DOCUMENTED CONTRACT
- **Paths:** `src/kernel/AocKernel.ts:406,556`; `src/features/action-enforcement/services/guarded-execution-service.ts:35,105`
- **Evidence:** `await execute()` at `:105` invokes a caller-supplied `() => Promise<T> | T`. The runtime has authorized an `ActionDescriptor` (`actorId`, `action`, `resourceScope`, `sideEffectType`…) and has **no binding of any kind** between that descriptor and what the closure does. `applyGrantStep` runs *after* the closure and reads no decision field (`structural-boundaries.test.ts:499-505`), so a configured grant capability cannot withhold it.
- **Risk:** Scenario O on Path 2. A closure authorized as "read invoice INV-1" may transfer $1M; the Governance Record will faithfully attest the *declaration*.
- **Exploitable?** Requires the ability to supply the closure, i.e. trusted in-process host code.
- **Blocks production?** No — this is the documented, ADR-justified boundary (`execution-governance/service.ts:56-64`), and the grant-aware path exists precisely as the stronger alternative.
- **Remediation:** do not weaken `enforce()`; instead state, as a first-class invariant, that `enforce()` offers **decision-time** assurance only and `exercise()` offers **effect-time** assurance, and require the latter for any effect an ADR classifies as privileged. **Owner: Prompt 1 (Define Non-Negotiable Security Invariants) + Prompt 3.**

---

**SC-004 — Production Agent Passport issuance is signed by `createTestSigner`, and its "public key" cannot verify anything**
- **Severity:** HIGH · **Classification:** D. PARTIALLY IMPLEMENTED
- **Paths:** `apps/agent-passport-web/src/lib/issuer/issuer-signer.ts:20-53`; `packages/agent-governance/src/signing/test-signer.ts:12-37`; `apps/agent-passport-web/src/lib/passport-adapter.ts:52,116,151,334`
- **Evidence:** four issues in one path.
  1. `createIssuerSignerFromEnv()` returns `createTestSigner({ secret: config.privateKeyPem })` (`:52`) — the function upstream comments mark "for use in tests; not for production use."
  2. `AOC_ISSUER_PRIVATE_KEY_PEM` is consumed as an **HMAC secret**, not a PEM key; `algorithm: 'hmac-sha256'` (`:27`).
  3. `AOC_ISSUER_PUBLIC_KEY_PEM` is registered as an issuer public key (`:66`) but is **symmetric-scheme metadata only** — no third party can verify a passport with it, and giving them what *would* verify (the secret) lets them forge.
  4. `test-signer.ts:35` verifies with `computeHmac(payload) === signature.signature` — a **non-constant-time comparison**, while the sibling implementation `passport-issuer.ts:75-84` correctly uses `timingSafeEqual`.
- **Risk:** No non-repudiation for Agent Passports; any holder of the verification material can forge; a timing side channel on the live verify path; misleading key semantics that could propagate into a customer trust model.
- **Exploitable?** #4 is directly exploitable given network access to a verify endpoint. #1–#3 require secret access or host compromise.
- **Blocks production?** **It should block any claim of third-party-verifiable passports.** It does not block operation.
- **Remediation:** asymmetric (Ed25519/ECDSA) signing behind the existing `AgentPassportSignerPort`; `timingSafeEqual` in `test-signer.ts`; rename or remove the `_PEM` variables. **Owner: Prompt 6 (Replace Process-Resident Signing Secrets with KMS/HSM Boundaries) — pull the algorithm and constant-time fixes forward; they do not need KMS.**

---

### MEDIUM

**SC-005 — No durable bounded-grant store exists; recognition/authority state is in-process memory**
- **Severity:** MEDIUM · **Classification:** D (grants) / **E** (recognition)
- **Paths:** `src/features/grant-runtime/services/in-memory-bounded-grant-store.ts` (the only implementation of `BoundedGrantStorePort`); `src/enterprise/composition/composition-root.ts:154-164`; `src/features/recognition-runtime/services/capability-token-service.ts:47`; `src/enterprise/providers/kernel-provider-composition.ts:60-87`
- **Evidence:** `createDefaultKernelProviders()` builds authority graph, approvals, handshake and recognition entirely in memory. `capability-token-service.ts:47` is `private readonly tokens = new Map<...>()`. The grant store default is in-memory; `AOC_AUTHORITY_CONTROLLED_EXECUTION.md` §15 states it plainly.
- **Risk:** All authorization state is lost on restart. Revocation of a capability token is **not durable** — a restart that re-seeds tokens from a provisioning source could resurrect a revoked one. Grants vanish, which fails closed (`GRANT_EXERCISE_NOT_FOUND`).
- **Exploitable?** Not directly; it is an availability + revocation-durability property.
- **Blocks production?** For a deployment relying on durable revocation, **yes**. The opt-in `kernelAuthorityStore` (event-sourced, terminal revocation) is the intended answer and exists.
- **Remediation:** ship a durable `BoundedGrantStorePort` following `createSqliteAccessGrantStore`; make the durable kernel authority store the production default. **Owner: Prompt 4 (Harden the Authoritative Grant Store).**

---

**SC-006 — `apps/agent-passport-web` is production-shaped and outside every security artifact**
- **Severity:** MEDIUM · **Classification:** E. NOT IMPLEMENTED (as a governed surface)
- **Paths:** 31 API routes under `apps/agent-passport-web/src/app/api/**`; `lib/stripe-billing-service.ts`; `lib/registry-admin-access.ts`; 12 repositories over its own SQLite
- **Evidence:** `THREAT_MODEL_V1.md` §9 explicitly places it **out of scope**. Yet it holds `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, two independent HMAC issuer secrets, an admin-access rotation endpoint, team invitations, and billing — and it has none of the structural protections `src/enterprise` has (no capability-ban test, no `PublicConfiguration` typing, ad-hoc `process.env` reads across `lib/` and routes).
- **Risk:** The repository's strongest security documentation describes the component with the *least* attack surface, and is silent on the one with the most.
- **Exploitable?** Unknown — unaudited. That is the finding.
- **Blocks production?** It blocks any claim that Frontera's SaaS surface is threat-modelled.
- **Remediation:** extend the threat model, or state a hard boundary that the web app is not part of the governed product. **Owner: Prompt 2 (Map Trust Boundaries and Privileged Assets) + Prompt 21 (Enterprise Security Posture).**

---

**SC-007 — Governance redaction is key-name based only**
- **Severity:** MEDIUM · **Classification:** D. PARTIALLY IMPLEMENTED
- **Paths:** `src/enterprise/governance-store/redaction.ts:20-32,55-61`; applied at `projection.ts:76,91,200,300`
- **Evidence:** `isSensitiveKey` splits the key into words and matches 11 terms. There is **no value-pattern matching**. A bearer token in `metadata.note` or `action.parameters.value` is persisted verbatim — and because redaction runs *before* digesting (`redaction.ts:1-5`), the secret is inside the hash chain and cannot be removed without breaking it.
- **Risk:** Irreversible secret persistence into a tamper-evident, append-only store.
- **Exploitable?** Requires a caller to place a secret under a non-matching key — an accident, not an attack.
- **Blocks production?** No.
- **Remediation:** add high-confidence value patterns (`sk_live_`, `Bearer `, PEM headers, JWT shape) alongside key matching. **Owner: Prompt 15 (Tamper-Evident Security Evidence).**

---

**SC-008 — No shared-responsibility model, and the rate-limit control points at a document that does not carry it**
- **Severity:** MEDIUM · **Classification:** C. DOCUMENTED CONTRACT (incomplete)
- **Paths:** `docs/security/THREAT_MODEL_V1.md:100`; `docs/operations/DEPLOYMENT_GUIDE_V1.md:250-266`; absence of any `SHARED_RESPONSIBILITY.md`
- **Evidence:** the threat model defers rate limiting with "see deployment guide"; the deployment guide's reverse-proxy section covers body limits, timeouts and header forwarding, and **never mentions rate limiting.** No document states the customer/vendor boundary as a single artifact; no operations doc mentions KMS, secret managers, WAF, IAM or workload identity.
- **Risk:** A deferred control with no owner is an unimplemented control. A customer security review cannot reconstruct the boundary.
- **Blocks production?** Blocks enterprise sales review, not operation.
- **Remediation:** add the rate-limit section to the deployment guide; author a shared-responsibility matrix. **Owner: Prompt 21 (Enterprise Security Posture and Shared-Responsibility Model).**

---

**SC-009 — Emergency deny is a process-local boolean that the grant-exercise path never consults**
- **Severity:** MEDIUM · **Classification:** D. PARTIALLY IMPLEMENTED
- **Paths:** `src/features/action-enforcement/runtime/action-enforcement-runtime.ts:64,71,108,112`; `src/features/action-enforcement/policies/emergency-deny-policy.ts`; `src/kernel/AocKernel.ts:194,248`
- **Evidence:** `EmergencyDenyPolicy` wins over every other policy — but only inside `EnforcementPreflightService`. `setEmergencyDeny` is an **instance field** on one runtime object: not durable, not multi-process, not exposed on `AocKernel`, not exposed on any HTTP route (its only non-demo reader is a control-plane metric at `control-plane-read-model-service.ts:823`). `GrantExecutionService` imports only a store and an adapter and **cannot see it**.
- **Risk:** "Stop everything now" stops one code path in one process and does not survive a restart. The bounded-grant execution path — the one that reaches real providers — is unaffected.
- **Blocks production?** Blocks any incident-response claim of a global kill switch.
- **Remediation:** a durable, store-backed stop flag consulted by **every** authority-bearing path, including grant exercise. **Owner: Prompt 12 (Runtime Kill Switch and Emergency Revocation).**

---

**SC-010 — `issuePMFreakAgentPassport` defaults to a signer with a hardcoded, publicly-known secret**
- **Severity:** MEDIUM · **Classification:** D. PARTIALLY IMPLEMENTED
- **Paths:** `packages/pmfreak-agent-passport-foundation/src/services/pmfreak-agent-passport-issuance-service.ts:57`; `packages/agent-governance/src/signing/test-signer.ts:15`
- **Evidence:** `const signer = deps.signer ?? createTestSigner();` — the fallback uses the literal `'aoc-test-signing-secret-do-not-use-in-production'`, checked into the repository. The package documents itself as a non-production foundation (`:12-17`) and the risk is disclosed at the call site.
- **Risk:** An unsafe **default**. A consumer who omits one optional field silently issues forgeable passports with no error.
- **Blocks production?** No — the package is declared non-production.
- **Remediation:** make `signer` required, or throw unless an explicit opt-in flag is set. **Owner: Prompt 20 (Customer-Controlled Signer and Key-Custody Contract).**

---

### LOW

**SC-011 — Capability-ban tests cover four modules; the rest of production has none.** Classification D. `action-enforcement`, all of `src/enterprise`, all `packages/`, all `apps/` have no structural restriction on `fetch`/`fs`/`child_process`/`eval`. The four existing tests (`execution-layer-boundaries.test.ts:149`, `grant-layer-boundaries.test.ts:139`, `obligation-layer-boundaries.test.ts:80`, `context-layer-boundaries.test.ts:62`) are an excellent template to extend. **Owner: Prompt 10.**

**SC-012 — Governance reads do not re-verify digests.** Classification D, already documented as `THREAT_MODEL_V1` §7.1 residual. `get` trusts stored digests; only explicit `verify` recomputes. Contrast with `sqlite-authority-store.ts:646,671`, which verifies on read and fails closed — the correct pattern already exists in the repository. **Owner: Prompt 4.**

**SC-013 — `verifyCapabilityToken` is exported under `crypto` but verifies no signature.** Classification C. `src/runtime/crypto/verification/capability-verifier.ts` validates shape, expiry and revocation list only, and honestly says so at `:3-13` ("NOT CURRENTLY ENFORCED"). But it is exported from `src/index.ts:56` and `src/runtime/crypto/index.ts:7` as public API, where an integrator may reasonably read "crypto/verify" as cryptographic verification. **Owner: Prompt 2.**

**SC-014 — `src/runtime/vault/` is not a key vault and performs no cryptography.** Classification C/INFORMATIONAL. Its own state doc records "Attestation is deterministic but not cryptographically signed yet." The name is a documented overclaim risk in customer conversations. **Owner: Prompt 2.**

### INFORMATIONAL

**SC-015 — `createDevSigner` (`apps/agent-passport-web/src/lib/dev-signer.ts`) is dead code** with a hardcoded fallback secret and zero call sites. Remove it.

**SC-016 — `infrastructure/{terraform,docker,kubernetes}/` contain only `.gitkeep`.** There is no deployment topology as code. Every deployment control in §9 is prose. Prompt 17 starts from zero here, which is worth knowing before planning it.

**SC-017 — Two independent HMAC signing schemes coexist in `apps/agent-passport-web`** (`issuer-signer.ts` over `AOC_ISSUER_PRIVATE_KEY_PEM`; `passport-issuer.ts` over `PASSPORT_SIGNING_SECRET`) with different key material and different comparison safety. Consolidate.

---

## SECTION 13 — GAP MAP AGAINST THIS TRACK

| # | Future prompt | Classification | Reason |
|---|---|---|---|
| 1 | Define Non-Negotiable Security Invariants | **PARTIALLY ALREADY IMPLEMENTED** | 20 real invariants exist with proving tests (§11); the work is to *promote and scope* them (local vs. system-wide) and add M-1…M-8, not to invent a set. |
| 2 | Map Trust Boundaries and Privileged Assets | **PARTIALLY ALREADY IMPLEMENTED** | `THREAT_MODEL_V1` §1–§4 already does this well for `src/enterprise`; the gap is `apps/` (SC-006), the two-model reality (SC-002), and naming overclaims (SC-013/014). |
| 3 | Prove No-Bypass Authority-Controlled Execution | **REQUIRED — but rescope** | Path 3 is already proven by `execution-exercise.test.ts`. The real work is enumerating *all* effect paths and proving-or-excepting each, given SC-002 and SC-003. |
| 4 | Harden the Authoritative Grant Store | **REQUIRED** | Only an in-memory implementation exists (SC-005); reads don't re-verify in the governance store (SC-012). |
| 5 | Introduce Cryptographic Authenticity for Authority Artifacts | **REQUIRED** | Scenario E is the largest open gap; `bounded-grant.ts:376-379` already names the exact attachment point ("over `serializeBoundedGrant`'s output, as a detached signature recorded beside the grant"). |
| 6 | Replace Process-Resident Signing Secrets with KMS/HSM | **REQUIRED** | No KMS abstraction exists; every key is env-loaded HMAC (SC-004). `AgentPassportSignerPort` is already the right shape, so this is an implementation, not a redesign. |
| 7 | Define Agent Runtime Isolation and Sandbox Contract | **REQUIRED** | Nothing exists (§7). Define the **contract** now; defer the implementation. |
| 8 | Implement Least-Privilege Workload Identity | **DEPLOYMENT-ONLY** | No IAM primitive belongs in this repository (`TARGET…` §10 forbids it); deliverable is deployment guidance + a documented boundary. |
| 9 | Design Secretless Agent Execution | **DEFER UNTIL REAL AGENT EXECUTION EXISTS** | There is no agent execution process to make secretless; doing it now would design against a hypothetical. |
| 10 | Constrain Filesystem, Process, and Network Capabilities | **MOSTLY ALREADY IMPLEMENTED** | Four boundary tests already ban exactly this set for layers C/D/E/execution; the work is **extending the existing template** (SC-011), not building a mechanism. |
| 11 | Add Egress Control and External Resource Allowlisting | **REQUIRED** | Scenario J is wide open; only Pinata and Stripe egress exist, so an allowlist is small and cheap now. |
| 12 | Build Runtime Kill Switch and Emergency Revocation | **PARTIALLY ALREADY IMPLEMENTED** | `EmergencyDenyPolicy` + grant revocation exist; neither is durable, global, or consulted by the exercise path (SC-009). |
| 13 | Add Behavioral Abuse Detection for Legitimately Authorized Actions | **REQUIRED — with a constraint** | Scenarios B and N are unaddressed, but `execution-layer-boundaries.test.ts:214-222` **bans** `riskScore`/`anomal`/`recommend` from the authorization path. This must be built *outside* layers B–E, and the prompt must say so or it will fail CI. |
| 14 | Protect Constitution, Policy, Grants, Enforcement from Self-Modification | **MOSTLY ALREADY IMPLEMENTED** | §8: no route reaches any of them, and structural tests forbid adding one. Narrow to the single real gap — `PolicyPackRegistry` write methods have no caller identity (§8). |
| 15 | Add Tamper-Evident Security Evidence and Incident Correlation | **PARTIALLY ALREADY IMPLEMENTED** | Chained digests, `packages/evidence-correlation`, and per-decision audit lines exist. Add value-pattern redaction (SC-007) and the missing authenticity (→ #5). |
| 16 | Threat-Model Privilege Escalation and Sandbox Escape | **DEFER UNTIL REAL AGENT EXECUTION EXISTS** | There is no sandbox to escape. Threat-model `apps/agent-passport-web` instead (SC-006) — that is the escalation surface that exists today. |
| 17 | Harden Production Deployment Topology | **REQUIRED** | Good prose guidance, zero infrastructure-as-code (SC-016), auth-off default (SC-001), missing rate limiting (SC-008). |
| 18 | Add Security Regression and Adversarial Test Suite | **PARTIALLY ALREADY IMPLEMENTED** | `execution-exercise.test.ts` (25 adapter-invocation cases), `kernel-authority-integrity.test.ts` (10 defects), `capability-verifier.test.ts` (a named bypass regression) are already adversarial. Extend rather than start over. |
| 19 | Run Rogue-Agent / Pac-Man Simulation Scenarios | **PARTIALLY ALREADY IMPLEMENTED** | §10 is the paper version; `src/features/aoc-enterprise-demo/scenarios/` (emergency-deny, approval-required-block, evidence-required-block, external-agent-limited-visa) is the executable version. Add scenarios for B, J, N, O, P. |
| 20 | Define Customer-Controlled Signer and Key-Custody Contract | **MOSTLY ALREADY IMPLEMENTED** | The invariant already holds structurally (§4.3): Frontera holds **no** customer transaction keys and build-time tests keep it that way. This prompt should *document and certify* the existing property, plus fix SC-010 — not build a custody model. |
| 21 | Create Enterprise Security Posture and Shared-Responsibility Model | **REQUIRED** | No such document exists (SC-008). High leverage, low cost — the raw material is already in `THREAT_MODEL_V1` §8/§9 and the deployment guide. |
| 22 | Production Readiness Security Gate | **REQUIRED** | Needs to encode SC-001, SC-004, SC-005 as blocking gates. |
| 23 | Independent Penetration-Test Preparation | **REQUIRED** | Cannot be meaningful until SC-006 is resolved — the untested surface is precisely the one a pentester would hit first. |
| 24 | Security & Containment Architecture Certification | **REQUIRED** | Terminal gate. |

---

## SECTION 14 — FINAL ARCHITECTURAL VERDICT

### CURRENT SECURITY POSTURE

Frontera is a **mature authorization-security system with essentially no containment security.**

What it genuinely guarantees today: a single decision producer (the Kernel); a seven-layer dependency rule enforced by build-failing structural tests rather than review convention; narrowing-only, fail-closed composition where every optional capability is byte-identically absent when unconfigured; and — on the bounded-grant path — a real execution gate where the grant is re-read from the authoritative store on every attempt, twelve checks run fail-closed against it, every failing axis is reported, and the adapter receives only values an assessment proved, with no free-form payload channel and a build-enforced 17-field whitelist. Its persistence is digest-chained and append-only by interface. It performs no shell execution, no dynamic code evaluation, and no outbound network I/O anywhere in the authority path.

What it does not do: contain anything. It does not isolate agent execution, restrict process capabilities, control egress, bound aggregate behavior, hold keys outside process memory, or provide a durable global stop. Its authorization gate is a **voluntary chokepoint** that a caller with code execution and network access simply walks around.

The repository is unusually honest about this. `bounded-grant.ts:144-152` and `THREAT_MODEL_V1` §8 state the privileged-writer limit in plain language rather than obscuring it. That honesty is itself a security property, and it is why this audit found no CRITICAL.

### STRONGEST EXISTING PROPERTY

**Frontera structurally cannot hold, sign with, or even name a customer transaction key — and the build fails if anyone tries to add one.**

`execution-layer-boundaries.test.ts:226-248` and `structural-boundaries.test.ts:480-484` fail CI on `xrpl|wallet|mnemonic|private[_-]?key|signTransaction|sequenceNumber|nonce|blockchain|on-?chain` appearing in the grant or execution layers. `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §10 declares "no key custody for target systems" an architectural non-goal. Scenario M is not mitigated; **there is nothing to steal.** This is classification A, and it is the property most worth building the product story on.

### MOST IMPORTANT CURRENT TRUST ASSUMPTION

**The Frontera host process and everything it can write are fully trusted, and authority artifacts are protected by unkeyed SHA-256 digests that anyone with write access can recompute.**

`THREAT_MODEL_V1` §2.6 names the operator boundary as the root of trust. Compromise of that boundary yields, simultaneously: every HMAC signing secret, every API key, every provider credential, all in-memory recognition and authority state, the emergency-deny flag, and the ability to re-seal every digest and every hash chain so the tampering is invisible in-band. Detection then depends entirely on out-of-band copies. This single assumption is the ceiling on every other guarantee in the system, and Scenario E is its direct expression.

### MOST IMPORTANT MISSING CONTAINMENT PROPERTY

**Process-level isolation between a governed actor and the authority boundary that governs it.**

One property, because it dominates the rest. Today, Scenarios G, H, I and J are all unaddressed for the same underlying reason: there is no boundary between "the code being governed" and "the code doing the governing." An actor with execution inside the Frontera process reads every secret from `process.env`, calls any provider directly, mutates the in-memory capability-token map, and never touches the gate. Sandbox contracts, secretless execution, egress allowlisting and capability dropping are all *consequences* of establishing this boundary; none of them is meaningful before it exists.

### PRODUCTION CLAIMS WE CAN DEFEND TODAY

1. Frontera never holds, requests, or can express a customer transaction signing key — enforced by build-time structural tests, not policy.
2. On the authority-controlled execution path, no external provider is contacted unless a bounded grant held by the authoritative store covers the exact action, at the instant attempted — with adapter invocation counts asserted for every refusal case.
3. A caller never holds, presents, or can tamper with a grant: only an identifier crosses the boundary; the grant is re-read from the trusted store on every attempt.
4. Revocation and expiry are effective immediately, with no cache, no sweeper and no background job — correctness never depends on a job having run.
5. Authorization is a single-producer system: the Kernel is the only component that produces a decision, and the layer dependency rule is enforced by tests that fail CI.
6. No AI, model, or inference dependency can enter the authorization path under any configuration — enforced by import and vocabulary bans in layers B through E.
7. No production code path in `src/` performs shell execution, child-process spawning, dynamic code evaluation, or outbound network I/O.
8. Provider credentials cannot appear on the public composition surface — proven by five structural tests including "no hardcoded API-key fallback exists."
9. Governance records are append-only by interface, digest-chained, and redacted before digesting, so the digest attests to what was actually persisted.
10. Every optional governance capability is byte-identically absent when unconfigured — proven by capability-absent characterization tests.

### CLAIMS WE MUST NOT MAKE YET

1. "Frontera contains rogue agents." It governs declared actions; it contains nothing.
2. "Frontera sandboxes agent execution." There is no sandbox, no isolation primitive, and no agent execution runtime. `infrastructure/` is empty.
3. "Authority artifacts are cryptographically authenticated / non-repudiable." They carry unkeyed SHA-256 digests. There are no signatures anywhere in `src/`.
4. "Agent Passports are independently verifiable by third parties." They are HMAC-signed; the registered "public key" cannot verify them (SC-004).
5. "No adapter call without a usable exercise assessment" *as a system-wide guarantee.* It is true of layer E and false of `AocKernel.enforce()` and the Sovereign Access provider path (SC-002, SC-003).
6. "Signing keys are protected by a KMS/HSM." Every key is a symmetric secret in process memory from an environment variable. No KMS abstraction exists.
7. "Frontera has a kill switch." It has a process-local, non-durable boolean that the grant-exercise path cannot see (SC-009).
8. "Grants and authority survive a restart." Bounded grants and recognition state are in-memory by default (SC-005).
9. "Frontera detects agent abuse or anomalous behavior." No behavioural or anomaly analysis — and the authorization layers are *banned* from containing any. *Updated by P7:* host-declared aggregate count / amount / velocity **limits** exist on the P7-enabled bounded-grant path only; that is bounding, not detection, and it is not system-wide.
10. "The platform is threat-modelled." `src/enterprise` is, thoroughly. `apps/agent-passport-web` — which holds the Stripe keys, the issuer secrets and 31 routes — is explicitly out of scope (SC-006).
11. "`src/runtime/vault` provides key custody." It performs no cryptography at all (SC-014).

### NEXT PROMPT RECOMMENDATION

**Do not proceed to Prompt 1 unchanged. The sequence needs three adjustments, and one of them is a reordering.**

**1. Rescope Prompt 1 from authoring to promotion.** Twenty real invariants already exist with proving tests (§11). Prompt 1's value is not writing new prose — it is classifying each existing invariant as **local or system-wide**, which is exactly the distinction SC-002 and SC-003 show is currently ambiguous and the most likely source of an accidental overclaim. Then add M-1…M-8 as *declared but unimplemented*.

**2. Insert a new prompt between 2 and 3: threat-model `apps/agent-passport-web`.** This is the reordering, and it is the one I would insist on. The repository's security documentation is excellent for the component with the smallest attack surface and silent on the component with the largest. Prompts 3, 22 and 23 all produce misleading results while a production SaaS surface holding live Stripe and issuer secrets sits outside every security artifact. Prompt 23 in particular cannot be meaningfully prepared before this.

**3. Rescope Prompt 3 from "prove one path" to "enumerate all, prove or except each."** As written it assumes a single authority-controlled execution path. There are three (§1.1). Proving the bounded-grant path is nearly done already; the actual deliverable is the enumeration plus an explicit, ADR-backed exception for `enforce()` and for the Sovereign Access provider path.

Two smaller adjustments worth making at the same time: **pull the SC-004 algorithm and constant-time fixes forward out of Prompt 6** (they need no KMS and one of them is a live timing oracle), and **narrow Prompt 20** from building a custody model to certifying the one that already structurally holds — that prompt is largely redundant as scoped, and rebuilding it would risk weakening a property that is currently the strongest thing in the repository.

Prompts 9 and 16 should be explicitly parked until Prompt 7 establishes an agent execution boundary; designing secretless execution and sandbox-escape threat models against a runtime that does not exist would produce artifacts that cannot be tested.

---

```
AUDIT COMPLETE
FILES MODIFIED: 0
COMMITS CREATED: 0
```
