# Frontera Master Architecture

- **Status:** AUTHORITATIVE. This is the single source of truth for Frontera's
  architecture baseline, roadmap and milestones.
- **Established by:** MASTER-00 (architecture reconciliation), 2026-09-25.
- **Audited against:** `main` @ `26a84be` (PR #142, the PRE-00 forward-port, merged).
- **Reconciled by:** MASTER-01 (governed action intelligence & roadmap reconciliation), 2026-09-27, against `main` @ `c66e0c7` (CTRL-01 merged). Architecture and roadmap only; no runtime change.
- **Last status change:** MASTER-01, 2026-09-27. Product thesis generalized to governed machine actions (§1); Governed Action semantic model, action/resource awareness and Governance Profiles (§4.2–4.3); INTEL track and the Frontera Agent boundary (§4.4, §5, §9); AI authorization invariant corrected (§2, §13); ASSURE-04 re-scoped, INTEL-05 added (§9); GOVERNED ACTION THESIS PROVEN (§11.6); open questions (§16). NEXT → CORE-03 (§14). Stale MASTER-00-era current-state FACTs corrected against `main` @ `c66e0c7` (shipped Host composition, §1; as-built layering, §4). Previous: CTRL-01 → VERIFIED 2026-09-26.
- **Supersedes as active roadmap:** every earlier sequencing scheme (§15).

Every statement in this document is labelled with one of four kinds:

| Label | Meaning |
|---|---|
| **FACT** | Verified current repository behaviour, with a code or test citation |
| **DECISION** | A chosen architectural direction, binding on future work until this document changes |
| **PLAN** | Future work. It does not exist yet |
| **HYPOTHESIS** | A concept that still needs validation |

A roadmap item is never phrased as if it exists. Where this document and any
other document disagree about *what is next*, this document wins. Where this
document and the *code* disagree about *what exists*, the code wins, and this
document is wrong and must be corrected.

---

## 1. Product Thesis

**HYPOTHESIS (target thesis, revised by MASTER-01):** Frontera is an
**authority layer for governed machine and autonomous-system actions**:
protocol-neutral, rail-neutral and **action-neutral**. It answers one question:

> Does this principal have valid authority to perform this action over this
> resource on behalf of this organization, under these conditions?

"Conditions" means policies, limits, obligations and admitted trusted context
(§4.2). Payments are a major use case, not the definition of the product: a
payment is one class of Governed Action (PAY), credit is one class of governed
economic workflow (CREDIT), and deploying software, reading customer data,
rotating a credential or changing infrastructure are others. MASTER-00's
phrasing ("organizational authority control plane … cause this action") is
preserved in substance; MASTER-01 makes the resource and the non-monetary
action explicit.

Frontera governs authority **before** execution. Protocols coordinate actions.
Rails and adapters execute or settle them. Evidence proves what happened.
Frontera does not own the blockchain, payment rail, wallet, payment protocol,
lending protocol, vault, settlement network or the target system an action
affects.

**HYPOTHESIS (intelligence thesis, MASTER-01):** around the deterministic
authority core, Frontera should eventually *understand* the action being
requested, the resource being affected, which facts are material, which of them
are missing, what behaviour is unusual and which evidence is relevant — and
resolve as much of that as possible from authorized machine sources before a
human is asked ("machine-speed due diligence"). Not all due diligence is
automatable and human review does not disappear. This intelligence surrounds
and feeds the core; it never replaces it (§4.4, invariants 24–32):

> **The Frontera Agent understands. The Kernel decides. The Grant authorizes.
> The Adapter executes. Evidence proves.**

**FACT (how far the code supports the thesis today):**

- The **governed-action spine** (P2–P12) is a real, tested, action-agnostic
  authority pipeline. It covers customer principal admission, Kernel decision,
  a bounded grant, exercise controls, write-ahead claim, a single adapter call
  site, durable outcomes and reconciliation (`src/enterprise/governed-action/orchestrator.ts:555`).
- **No payment protocol, settlement rail or credit mechanism is implemented on
  `main`.** The only concrete execution adapter is Generic HTTP
  (`src/enterprise/execution-adapters/generic-http/`).
- **Protocol and rail neutrality is structurally enforced but not yet
  demonstrated.** Boundary tests forbid `stripe`, `xrpl`, `mpp`, `wallet`,
  `PaymentIntent`, `settlement` and `receipt` in core layers
  (`src/enterprise/__tests__/authority-payment-ceilings-structure.test.ts`).
  However, no second rail exists to prove neutrality against.
- **Action neutrality is structural in control flow but not in parameters, and
  is not demonstrated.** The orchestrator is action-agnostic, but its only
  parameter axes are `amount` and `counterparty`, `GrantBoundKey` is a closed
  money-shaped list, and "financial" is a first-class branch (§4.1, L-2 … L-6).
  The envelope already carries required `action` and `resource` strings
  (`governed-action/contracts.ts:52-54` → Kernel `action.type` / `resourceScope`
  and the grant's `action` / `resources` bounds), but as opaque identifiers:
  the only action classification is `financial` / `non-financial`, and there is
  no resource class at all. The only execution adapter is Generic HTTP.
- **No intelligence component exists.** No model call, agent, RiskSignal or
  behavioural detector exists anywhere; a structural test forbids intelligence
  vocabulary in Kernel sources (`src/enterprise/__tests__/security-invariants.test.ts`,
  "names no AI, model or inference dependency").
- **The shipped host composes the spine (since PROD-01; corrected by MASTER-01 —
  the MASTER-00 statement that it did not is no longer true).**
  `npm run start:enterprise` → `scripts/run-enterprise-host.mjs` (a thin launcher)
  → `bootEnterpriseHost()` (`src/enterprise/host/enterprise-host.ts`) → strict
  configuration + secure profile → `createEnterpriseServer()` with the
  governed-action composition (customer admission, grant-aware Kernel over the
  durable Kernel Authority world, authenticated durable grant store, P7 + P10,
  durable P4, P8, P11, Generic HTTP via the trusted registry) → posture + health
  gate → `listen()`. The secure profile refuses to start without durable
  persistence, required authentication, composed governed actions and an
  `authenticated-durable` authority store (§3.8, PROD-01). CTRL-01's
  administration API is mounted on this same Host and was qualified through
  `bootEnterpriseHost()` (`authority-administration-api.test.ts`). What the
  shipped Host does **not** compose: policy packs, trusted context, obligations,
  approvals and P12 (§3.8). `createEnterprise()` remains a lenient embedding
  surface that defaults to `memory` and composes nothing unless asked.
- **The README positioning is stale.** It still describes "Frontera Systems … built on
  Soberanía Protocol" for "programmable consent, scoped machine access".

**DECISION:** The thesis above is Frontera's product thesis. The roadmap in §9
exists to turn it from HYPOTHESIS into FACT, via the milestones in §11.

---

## 2. Architectural Invariants

**DECISION.** These resolve ambiguity in all future work.

1. Frontera governs authority.
2. Authority must have provenance.
3. Authority must be bounded.
4. Authority must be revocable, and a revocation must not be silently undoable.
5. Authority must be verifiable.
6. Authority must not be inferred from execution success.
7. Payment protocols are not settlement rails.
8. Settlement rails are not governance systems.
9. Credit protocols are not governance systems.
10. Vertical technologies may depend on CORE.
11. CORE must not depend on vertical technologies.
12. Integrity and authenticity are separate security properties.
13. Evidence is not authority.
14. Provider claims are not automatically trusted facts.
15. An execution result must not retroactively create authority.
16. Payment-specific semantics stay in PAY.
17. Credit-specific semantics stay in CREDIT.
18. Human control surfaces belong in CTRL.
19. Operational and product concerns belong in PROD.
20. Avoid premature generalization.
21. Reuse existing generic primitives where they are actually sufficient.
22. Do not create one god-object merely to make payments and credit look symmetrical.
23. Frontera should eventually answer: **WHO** attempted **WHAT ACTION** over
    **WHICH RESOURCE**, on behalf of **WHICH ORGANIZATION**, under **WHOSE
    AUTHORITY**, subject to **WHICH POLICY**, within **WHICH LIMITS**, given
    **WHICH ADMITTED CONTEXT**, producing **WHICH OBLIGATIONS**, through **WHICH
    EXECUTION MECHANISM**, producing **WHICH RESULT**, proven by **WHICH
    EVIDENCE**. (MASTER-01: "which economic action" generalized to action +
    resource; an economic action is one case. See §4.2.)

**DECISION (MASTER-01): governed action intelligence invariants.** These
replace MASTER-00's blanket "no behavioural or AI scoring in the authorization
path" (§13) with a precise rule.

24. **The Frontera Agent understands. The Kernel decides. The Grant authorizes.
    The Adapter executes. Evidence proves.** Concretely: the Agent owns
    understanding, context and signals; the Kernel owns the deterministic
    authority decision; the BoundedGrant is the bounded authority artifact; the
    Execution Adapter owns the side effect; Evidence owns proof and historical trace.
25. **AI may produce observations and RiskSignals. AI may never create, expand
    or exercise authority.** It never mints a grant, never overrides
    deterministic policy, never directly authorizes execution, and never
    exercises authority because it recommends execution.
26. **Any AI-derived information capable of affecting authority crosses the
    Trusted Context Boundary (CORE-04) and deterministic organization policy
    first.** The only path is: Agent → observation / candidate RiskSignal →
    Trusted Context Boundary → deterministic policy → Kernel → ALLOW / REVIEW /
    DENY. Never AI → ALLOW, never AI → DENY directly, never AI → more authority.
27. **Security monotonicity.** AI-derived intelligence may, through
    deterministic policy, preserve or reduce currently exercisable authority. It
    never independently increases it. Expansion requires legitimate issuance,
    policy change, delegation or human/organizational authority through existing
    deterministic mechanisms.
28. **AI model output is not a root of trust.** A model cannot establish by
    assertion identity, ownership, organizational authority, policy, approval,
    provenance, settlement or artifact authenticity. It may propose claims;
    trusted deterministic systems decide whether they are admissible.
29. **Model confidence is not authority confidence.** `confidence = 0.95` does
    not mean "95 % authorized". Confidence may be one input an organization
    policy reads about an *admitted* signal; it never replaces provenance,
    organizational authority, admissibility or deterministic evaluation.
30. **Authority to attest ≠ authority to authorize; retrieval authority ≠
    execution authority.** A source may be authoritative for one fact class and
    not another (ERP: invoice existence; registry: supplier destination; chain:
    transaction state; HR: employment status), and none of them authorizes the
    action. Permission to *read* (ERP invoice, Kubernetes status, customer
    record) never implies permission to *act* (pay, deploy, modify). The
    Agent's context-retrieval permissions are separate from, and never convert
    into, governed-action execution authority.
31. **The organization owns binding policy.** AI may identify relevant policy,
    missing facts, anomalies and relationships. It may not silently rewrite
    policy, create authority rules, raise limits or authorize itself. Evidence
    informs later evaluation; it never rewrites policy autonomously.
32. **CORE is independent of INTEL.** CORE correctness is testable with no LLM,
    model provider, behavioural model, vector store or agent framework present.
    INTEL is a consumer and provider around CORE; CORE never imports INTEL.

**FACT: current coverage of invariant 23.**

| Question | Status | Where it is answered |
|---|---|---|
| WHO / ORGANIZATION | Answered | Customer principal binding (P2) |
| WHOSE AUTHORITY | Partly answered | Kernel-Authority world + Authority Graph. Lineage is re-checked at exercise only for financial actions |
| POLICY | Answered only if the host injects a policy pack | — |
| LIMITS | Answered only if P7 is composed | P7 / P10 |
| OBLIGATIONS | **Not answered** on the governed path | — |
| ACTION | Partly answered | Required `action` identifier + host-trusted `financial`/`non-financial` classifier; parameters limited to `amount`/`counterparty` (CORE-03) |
| RESOURCE | Partly answered | Required `resource` identifier on the envelope → Kernel `resourceScope` and grant `resources` bound; no resource class, so governance cannot depend on *what kind* of resource it is (CORE-03) |
| ADMITTED CONTEXT | **Not answered** | `assertedContext` reaches the Kernel as caller claims (CORE-04) |
| MECHANISM | Answered | Adapter id |
| RESULT | Answered | P11 / P12 |
| EVIDENCE | Answered, integrity-only | Event stream |

---

## 3. Current Verified Baseline

Status vocabulary:

| Status | Meaning |
|---|---|
| **VERIFIED** | Wired into a production composition path and tested |
| **VERIFIED (opt-in)** | Same, but only when the host composes it |
| **PARTIAL** | Meaningful implementation exists, but the guarantee is incomplete |
| **LIBRARY-ONLY** | Implemented and tested, but no production composition reaches it |
| **DOCUMENTED ONLY** | Docs or type contracts only |
| **ABSENT** | Nothing |
| **SUPERSEDED** | Replaced by a newer mechanism |

"Opt-in" matters for **embedders**: `createEnterprise()` still defaults to
`persistence.provider = 'memory'` and composes none of the governed-action
spine unless asked. Since PROD-01 the **shipped host** (`npm run start:enterprise`
→ `bootEnterpriseHost()`) composes it under the secure profile or refuses to
start; "VERIFIED (opt-in)" rows below that are composed there say so. The
wiring inventory is §3.8.

### 3.1 CORE — authority and governance

| Capability | Status | Evidence |
|---|---|---|
| Customer principal binding (API key → principal → subject → Kernel-Authority actor) | VERIFIED (opt-in); **wired on the shipped secure Host** (PROD-01) | `src/enterprise/customer-identity/admission-service.ts:124-147`; `customer-identity-admission*.test.ts`; `enterprise-host.test.ts` |
| Kernel decision + Governance Store commit/re-read | VERIFIED | `src/kernel/AocKernel.ts`; `governed-action/decision-commit.ts` |
| Durable Kernel-Authority world (actors, capabilities, delegations, constraints) | VERIFIED | `src/enterprise/kernel-authority/*`; `kernel-authority-*.test.ts` |
| Bounded grants (attenuation-only) | VERIFIED | `src/features/grant-runtime/domain/grant-attenuation.ts:162`; `grant-attenuation.test.ts`, `bounded-grant-scenario.test.ts` |
| Durable grant store with digests (Prompt 4) | VERIFIED (sqlite only) | `src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts`; `bounded-grant-store-durability.test.ts` |
| Grant expiry (checked at exercise, never scheduled) | VERIFIED | `governed-action/orchestrator.ts:547` |
| Revocation (durable, signed) | **VERIFIED (sqlite only)** — revocation-state integrity closed by CORE-01 | `sqlite-bounded-grant-store.ts` (`verifiedRevocationState`); `revocation-state-integrity.test.ts`. Operable over HTTP by configured administrators since CTRL-01 (`/api/admin/authority/...`; `authority-administration-api.test.ts`). Cross-restart rollback open (CORE-07) |
| **Authority artifact authenticity (PRE-00 + CORE-01)** | **VERIFIED; required on the shipped secure Host** (PROD-01) | §3.7. The secure Host refuses to bind unless its grant store is `authenticated-durable` and its revocation state verifies. Embedding default still `memory`; key process-resident (CORE-02) |
| No-bypass execution (single adapter call site) | VERIFIED, path-local | `no-bypass-effect-paths.test.ts`, `security-invariants.test.ts`. 3 of 46 effect paths are grant-controlled; the rest are excepted or separate models (`docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`) |
| Emergency control / kill switch (P4) | VERIFIED (opt-in); durable and composed on the shipped secure Host | `composition-root.ts`; `emergency-control-*.test.ts`. Operable over `/api/admin/emergency-controls` by configured administrators (CTRL-01) |
| Aggregate / velocity / reservation controls (P7) | VERIFIED (opt-in); composed (required) on the shipped secure Host, with no host-imposed limits — the authority's own (P10) apply | `composition-root.ts`; `exercise-control-*.test.ts`. Without P7, grants are exercisable without count limit, and financial actions are always withheld |
| Authority-sourced payment ceilings (P10) | VERIFIED (requires P7) | `kernel-authority/monetary-constraints.ts:75-91`; `authority-payment-ceilings*.test.ts` |
| Policy packs / domain packs / jurisdiction | **PARTIAL** | Only through a host-injected `policyPackProvider` (`composition-root.ts:1245`). No durable policy store, no default pack, unauthenticated registry writes (NB-008) |
| Delegation lineage | **PARTIAL** | Enforced at decision when the actor is an agent. Re-resolved at issue, commit and exercise **only for financial actions** (`kernel-authority/financial-authority-resolver.ts`). Non-financial revalidation is a host callback |
| Obligation lifecycle (discharge/verify/waive) | **LIBRARY-ONLY** | `src/features/obligation-runtime` is tested. The governed-action Kernel is built with `grants` only (`composition-root.ts:1370-1376`), and a host Kernel is refused (`:1113`), so obligations **cannot reach** governed actions |
| Trusted context provenance (layer C) | **LIBRARY-ONLY** | `src/features/context-resolution-runtime` is tested. It is not composed; `assertedContext` reaches the Kernel as caller claims |
| Risk signals | ABSENT | Boundary tests ban `riskScore`/`anomal` from Kernel sources by design. That ban stays: a future admitted RiskSignal reaches the Kernel only as a generic trusted-context fact (CORE-04), never by name (§4.4) |
| Approvals | **PARTIAL** | `approval_required` always ends `withheld:'approval'` (`orchestrator.ts:593`). The approval store is in-memory. There is no way to present an approval proof on the governed path |
| Escalation | LIBRARY-ONLY | `approval-runtime.ts:203` (domain code only) |
| Holder-bound representative / right-scoped Governed Authority | LIBRARY-ONLY | Kernel providers exist (`AocKernel.ts:70-101`); no enterprise wiring |
| Deterministic AI boundary | PARTIAL | Lexical negative test only; the ADR is architecture-only. Amended in direction by MASTER-01 for restrict-only admitted RiskSignals (§4.4.6); the ADR's prohibitions remain in force until CORE-04 + INTEL-06 deliver |
| Legacy `src/runtime/authorization` (protocol capability tokens) | SUPERSEDED | Serves the SDK host only |
| Kernel `emergencyDeny` | SUPERSEDED | Replaced by P4 durable emergency control |

### 3.2 Governed action and execution

| Capability | Status | Evidence |
|---|---|---|
| `POST /api/governed-actions` + SDK 1.1 (P5) | VERIFIED (opt-in); **mounted on the shipped secure Host** | `adapters/node-http-adapter.ts`; `governed-action-api-endpoint.test.ts`; `enterprise-host.test.ts` (end to end through the bootstrap) |
| Orchestrator gate order (P3) | VERIFIED | `orchestrator.ts:555-741`; `governed-action-orchestrator.test.ts` (75 tests) |
| Adapter registry + routing (P4) | VERIFIED | `execution-adapter-registry.ts` |
| Generic HTTP adapter (P6, Stage A) | VERIFIED | `execution-adapters/generic-http/`; 109 tests. One attempt, SSRF-hardened, static in-process credential |
| Server-derived identities (`requestId = H(org, principal, idempotencyKey)`, `executionId = H(requestId, decisionId)`) | VERIFIED | `governed-action/identifiers.ts:25,42` |
| Write-ahead claim, at most once | VERIFIED | `execution-ledger.ts:295-313` |
| Durable outcomes with provider certainty (P11) | VERIFIED (opt-in); required on the shipped secure Host | `execution-outcome-store/*`; `durable-monetary-outcomes*.test.ts` |
| Reconciliation + resolution authority (P12) | VERIFIED (port); no resolver implementation ships | `execution-reconciliation/*`, `execution-resolution-store/*`; `execution-reconciliation-e2e.test.ts` |
| Retries | ABSENT by design | An unconfirmed execution replays as `…_ALREADY_ATTEMPTED`; it is never re-sent |
| `providerRef` as identity | Not used (correct) | `provider-reference.ts` treats it as a handle, never as proof |

### 3.3 Monetary semantics (P9)

**FACT:**

- `MonetaryAmount {value: canonical decimal text, unit: assetId}`, with exact
  BigInt arithmetic and no floats (`src/features/monetary-runtime/domain/*`).
- Asset identity is an opaque string resolved against a host-configured
  `{assetId, scale}` registry. There is no FX, and different assets are
  `incomparable`.
- Financial classification is host-trusted (`financial-action.ts:266`, wired at
  `composition-root.ts:1095`).
- These semantics are generic. They are **not** payment-specific, and are equally usable
  for credit amounts.

### 3.4 PAY

**FACT:**

| Item | Status |
|---|---|
| x402 | ABSENT |
| MPP | ABSENT on `main`. It exists only on the **unmerged** branch `origin/feat/p13-mpp-business-idempotency` (`24dd264`). That branch has a client-side parser for draft-httpauth-payment-01 challenges, business-operation idempotency and 7 test files, and conflicts with `main` |
| XRPL, Lightning, EVM, Solana, Stellar, Hedera, Cardano, RLUSD | ABSENT. No SDK dependency, no client. XRPL appears only in asset-id doc comments and negative boundary tests |
| Receipts, settlement state, finality, refunds | ABSENT. `execution-outcome-store/contracts.ts:40` explicitly says "Not settlement". P7's "settled" means reservation capacity was consumed |
| Stripe | Exists **only** in `apps/agent-passport-web` as Agent Passport SaaS billing. It is unrelated to governed payments |

### 3.5 CREDIT

**FACT:**

| Item | Status |
|---|---|
| Credit intent, borrower, loan, underwriting, exposure, concentration, repayment, XLS-65, XLS-66, reverse carry, Evernorth | **ABSENT, conceptual only.** Zero code hits, including `git log --all -S` |
| Collateralize / tokenize / transfer / license / encumbrance-release governed mandates | LIBRARY-ONLY. `packages/*-mandate` plus SQLite services in `src/enterprise/*-governance` are tested but not composed and not HTTP-exposed |
| `packages/governed-authority` (positions, reservations, encumbrances, transitions) | LIBRARY-ONLY. Reusable as credit primitives |
| Capital Discovery authorization boundary + trusted context (FR-REC-01/02) | LIBRARY-ONLY. `src/features/aoc-integrations/capital-discovery-*`; FR-REC-03 not implemented |
| "Vault" in `src/runtime/vault` | Unrelated. It is a logical tenant-isolation boundary, not a lending vault and not a key vault |

### 3.6 ASSURE and CTRL

**FACT: ASSURE**

| Item | Status |
|---|---|
| Canonical authority event stream (P8) | VERIFIED for **integrity** (unkeyed SHA-256 chain), unsigned. Best-effort projection, not authoritative. No HTTP read or verify route |
| Evidence bundle | VERIFIED integrity-only. In-memory store. Built from one governance record only; excludes grant, outcome and resolution |
| Assurance runtime | VERIFIED. SQLite, `/api/assurance/*`, hash-sealed |
| Verifiable export package, evidence-source runtime | LIBRARY-ONLY |
| `packages/evidence-correlation`, `usage-event` | DOCUMENTED ONLY. The R004 contract is superseded in practice by the event stream |
| `enterprise-audit`, `audit-sdk` | ABSENT (placeholders) |

**FACT: CTRL**

| Item | Status |
|---|---|
| Enterprise API | Health, evaluate, governed-actions, governance reads, evidence, assurance, passports, and — since CTRL-01, when administrators are configured — **authority administration** (`/api/admin/...`: inspect/revoke bounded grants and Kernel-Authority entities, execution → grant lookup, emergency stop/release). **No** routes for authority provisioning, approvals, organizations, users or the event stream |
| Authority administration (CTRL-01) | **VERIFIED; optional on the shipped Host** (mounted only when the governed-action file declares `administrators`). A separate administrator credential class (never an ordinary API key; ordinary keys get 403), operator identity from configuration, closed request schemas, single-organization scope. Calls only existing authoritative operations; no issuance, provisioning or un-revoke. `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`; `authority-administration-api.test.ts`, `authority-administration-service.test.ts` |
| Authentication | Static bearer API keys, optionally org-scoped; customer principals and (CTRL-01) administrators configured in the governed-action file. **Required by the shipped secure Host** (SEC-INV-126); off only in the explicit development profile, and then loopback-only (SEC-INV-127). Embedding default still off (SC-001). Administrators are named operators behind shared bearer secrets: no humans, MFA, RBAC or SSO in the enterprise runtime (CTRL-02, PROD-04) |
| `src/features/aoc-control-plane` (React panels) | LIBRARY-ONLY; rendered by no app |
| `packages/control-plane` | SUPERSEDED / orphan |
| `control-plane-sdk`, `tenant-governance`, `org-boundary` | DOCUMENTED ONLY |
| `apps/{agent-gateway,audit-console,dashboard,policy-engine}` | ABSENT (`.gitkeep` only) |
| `apps/agent-passport-web` | VERIFIED as a **separate product**: Next 14, own SQLite, Stripe, human accounts, per-registry roles, team invitations, agent passport inventory. It has **no connection** to `src/enterprise` or governed actions. Its production passport signer is HMAC (`createTestSigner`) |
| Mobile | ABSENT |

**FACT: PROD**

| Item | Status |
|---|---|
| `backup:v1` / `restore:v1` | Cover **4** stores (governance, agent-passport, assurance, kernel-authority; `scripts/portability/lib-portability.mjs`) |
| Shipped host | **VERIFIED (PROD-01).** `npm run start:enterprise` → `bootEnterpriseHost()`: strict configuration, secure profile, governed spine composed, posture + health gate before listen, atomic startup, graceful shutdown (`AOC_ENTERPRISE_HOST.md` §"Secure production host") |
| Stores not backed up | 6 durable stores: bounded-grants, emergency-controls, exercise-ledger, authority-event-stream, execution-outcomes, execution-resolutions (`enterprise-configuration.ts:389-404`). Also the mandate stores and the agent-passport-web database. A restore **loses active grants, revocations, spend ledgers and the audit trail** |
| Deployment guide, runbooks | Exist as prose only. No IaC |

### 3.7 PRE-00 verification: cryptographic authority authenticity

**Classification: PARTIAL.** The cryptography is sound and well tested. The
guarantee is not delivered by default, and one documented claim is false.

**FACT: what is verified**

- **Ed25519, detached.** `crypto.sign(null, …)` / `crypto.verify(null, …)`
  (`authority-authenticity/signer.ts:287`, `verifier.ts:207`). Closed algorithm
  registry, one entry, no fallback.
- **Canonical, domain-separated signing input.** The domain tags are:
  - `frontera:authority-artifact:bounded-grant:v1\n`
  - `frontera:authority-artifact:grant-revocation:v1\n`

  Each tag is followed by the canonical stored-record serialization, which binds the grant id and
  schema version (`authority-signature.ts:65-66,128-135`).
- **Verification on every authoritative read.** Digests are checked first, then the
  signature, inside one transaction.
  - Signing happens before the write transaction, and `commitGuard` runs inside it
    (`sqlite-bounded-grant-store.ts:480-631`).
  - Signature columns are `NOT NULL`.
  - An unsigned v1 database is refused at open.
- **Trusted verifier registry.** `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`
  (JSON), with multiple keys and rotation. Composition refuses duplicate ids, an empty
  set, and a private key in the trusted set (`verifier.ts:92-152`).
- **Signer/verifier separation.**
  - `AuthorityArtifactSigner` is async, with only `signGrant`/`signRevocation` and no
    generic byte signing.
  - The verifier is sync and uses public keys only.
  - The private key is redacted from public configuration.
- **Fail-closed composition.** A missing key, an active key not in the trusted set, or a key
  mismatch all throw (`composition-root.ts:920-946`). A verification failure withholds the action.
- **Tests.** Three suites: `authority-artifact-authenticity.test.ts`,
  `authority-authenticity-boundaries.test.ts` and
  `bounded-grant-store-durability.test.ts`. **98/98 passed** in the MASTER-00 run.
  All three are in the `npm test` glob.

**FACT: CORE-01 update (2026-09-25).** Items 1, 3 and 5 below are **resolved** by
CORE-01; items 2, 4 and 6 are unchanged. The text of each is kept as the
MASTER-00 record.

- Item 1: closed by a signed revocation-state commitment verified on every
  authoritative read (`AUTHORITY_ARTIFACT_AUTHENTICITY.md` §26, SEC-INV-124).
  Reproduced before the fix (the revoked grant *executed*), blocked after it.
  The corrected BLOCKED claim for threat M is scoped to a database-only writer
  without a captured earlier signed state.
- Item 3: a `sqlite`-persistence Host refuses a non-authenticated host-supplied
  `grantStore` (`EXECUTION_GRANT_STORE_NOT_AUTHENTICATED`, SEC-INV-125).
- Item 5: key-mismatch, active-key-not-trusted and malformed verification-key
  JSON are tested at composition.

**FACT: what is not delivered (MASTER-00 record)**

1. **Un-revocation by a database-only writer (verified from source).**
   - The grant row's `revocation_digest` pointer is not covered by any signature.
     The revocation row is simply deleted.
   - If an attacker deletes the `bounded_grant_revocations` row **and** sets
     `bounded_grants.revocation_digest = NULL`, then `currentRevocation` returns
     `undefined` (`sqlite-bounded-grant-store.ts:534-538`), and the grant reads as live.
   - `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §20 rates threat M
     ("DB-only write access") as BLOCKED, and §22 calls GS-001 "CLOSED for a
     database-only writer". Both overclaim.
   - The durability tests exercise each half of this tamper separately, never both together.
   - This violates invariant 4.
2. **Not wired by default.** *(Resolved for the shipped host by PROD-01: the
   secure profile requires `sqlite` and composes authority-controlled
   execution; embedders keep the `memory` default.)*
   - Signing exists only when `persistence.provider === 'sqlite'` and the host
     composes `authorityControlledExecution`. The default provider is `memory`.
   - The shipped host (`scripts/run-enterprise-host.mjs`) composes neither.
3. **Silent bypass by host injection.** A host-supplied `grantStore` (for example the
   in-memory store) replaces the signed store even under sqlite
   (`composition-root.ts:475,1260`), with no refusal or warning.
4. **Signing covers grants and revocations only.** Kernel-Authority records (where
   authority originates), governance decisions, exercise ledgers, emergency
   controls, outcome and resolution records, and the event stream are digest-only.
5. **Composition checks without tests.** The key-mismatch and active-key-not-trusted checks,
   and malformed verification-key JSON.
6. **Open by design, documented:**
   - AA-001: the private key is process-resident.
   - AA-002: whoever controls configuration controls trust.
   - AA-003 / GS-002: no freshness or rollback protection, no external anchoring or timestamping.
   - AA-004: revocation requires signer availability.
   - AA-005: every issuance and revocation attempt, including refused ones, invokes the signer.
   - AA-006: only one algorithm is registered.

---

### 3.8 PROD-01: implemented-but-not-wired inventory

**FACT** (2026-09-25). What the shipped secure Host (`bootEnterpriseHost()`,
`AOC_ENTERPRISE_ENV=production|staging`) actually composes.

| Capability | Classification | Note |
|---|---|---|
| Principal binding (customer admission) | WIRED INTO PRODUCTION HOST | Principals from the governed-action file; keys by env-var name |
| Bounded grants | WIRED INTO PRODUCTION HOST | Lifetime from the file, 1 … 3600 s |
| Authenticated durable authority store (CORE-01) | WIRED INTO PRODUCTION HOST | Required; verified before bind and on every `/ready` |
| Revocation (bounded grant) | WIRED INTO PRODUCTION HOST (CTRL-01) | `POST /api/admin/authority/grants/{id}/revoke` → `authorityControlledExecution.revokeGrant`; administrators only |
| Revocation (Kernel Authority) | WIRED INTO PRODUCTION HOST (CTRL-01) | `POST /api/admin/authority/entities/{kind}/{id}/revoke` → `kernelAuthorityProvisioning.revoke`; administrators only |
| Kill switch (P4) | WIRED INTO PRODUCTION HOST | Durable store; activate/release over `/api/admin/emergency-controls` (CTRL-01) |
| Kernel-Authority provisioning | WIRED; operation EMBEDDING-ONLY | `kernelAuthorityProvisioning.provision*`, in-process (CTRL-02) |
| Monetary / exercise controls (P7, P9, P10) | WIRED INTO PRODUCTION HOST | No host-imposed aggregate policy; authority-sourced limits apply |
| Authority event stream (P8) | WIRED INTO PRODUCTION HOST | Optional by design; no read route |
| Execution outcomes (P11) | WIRED INTO PRODUCTION HOST | Required |
| Reconciliation (P12) | NOT WIRED (intentional) | No resolution-authority implementation ships (PAY-03/04) |
| Governed-action API | WIRED INTO PRODUCTION HOST | `POST /api/governed-actions` |
| Generic HTTP adapter (P6) | WIRED INTO PRODUCTION HOST | Only as configured in the file; routed by action |
| Policy packs | NOT WIRED | No durable policy store; unauthenticated registry writes (CORE-03, NB-008) |
| Obligations | NOT WIRED | CORE-04 |
| Trusted context | NOT WIRED | CORE-04 |
| Approvals | NOT WIRED | `approval_required` stays withheld (CORE-05) |
| Mandates (`packages/*-mandate`, `*-governance`) | EMBEDDING-ONLY / LIBRARY-ONLY | Not composed, not HTTP-exposed (CREDIT) |
| Evidence bundle store | WIRED, in-memory | Not durable on any Host (ASSURE) |

## 4. Architecture Layers

**FACT (as built):**

```
                  apps/agent-passport-web  (separate product: own DB, HMAC passports, Stripe billing)

  Shipped Host: npm run start:enterprise → bootEnterpriseHost()  ── HTTP: node:http, static API keys +
    (CTRL-01) administrator credentials; secure profile requires auth (PROD-01)
  Embedding host (in-process createEnterprise(); memory, auth off by default)
        │
        ▼
  ENTERPRISE COMPOSITION ROOT  (src/enterprise/composition/composition-root.ts)
        │
        ├── Customer identity admission (P2) ─────────── principal → subject → authority actor
        ├── Kernel (src/kernel) ── Recognition · Authority Graph · Approval(mem) · Policy packs(host)
        │     └── Kernel-Authority durable world (SQLite, digest-only)
        ├── Governance Store (decision commit / re-read)
        ├── Governed-Action Orchestrator (P3) ── intent + P9 monetary classification
        │     ├── Emergency control (P4)
        │     ├── Authority-Controlled Execution: bounded grant issue (P10 ceilings) ──► Grant store (SQLite, Ed25519)
        │     ├── Exercise controls / ledger (P7)
        │     ├── Outcome store (P11) · Resolution authority port + store (P12)
        │     ├── Write-ahead claim ─► ExecutionAdapter registry ─► Generic HTTP adapter (only one)
        │     └── Authority event stream (P8, hash-chained, best-effort)
        └── Evidence bundle (mem) · Assurance (SQLite) · Passport store

  LIBRARY-ONLY (tested, not composed): obligations · context resolution · governed authority /
  mandates (collateralize, tokenize, transfer, license, encumbrance) · Capital Discovery ·
  control-plane React panels · verifiable export · Sovereign Access (Pinata)
```

**DECISION (target layering).** The target is the brief's layered model,
restated against what exists:

```
                               ORGANIZATION
                                    │
                    ┌───────────── CORE ─────────────┐
                    │ principals · authority world   │  exists (P2, Kernel-Authority)
                    │ provenance/lineage             │  partial
                    │ bounded grants · revocation    │  exists; tamper-evident (CORE-01)
                    │ policy · ceilings · controls   │  exists (opt-in)
                    │ obligations · trusted context  │  library-only → CORE-03/04
                    │ approvals (engine side)        │  partial → CORE-05
                    │ authenticity · signer boundary │  durable store: done; key custody → CORE-02
                    │ governed-action envelope       │  exists (P3/P5)
                    └───────────────┬────────────────┘
                              GovernedActionIntent
                   ┌────────────────┴────────────────┐
                 PAY                               CREDIT
      PaymentIntent (compiles to envelope)   CreditIntent (compiles to envelope)
      protocol adapters (MPP, x402)          credit semantics (exposure, collateral)
      rail adapters (XRPL, Lightning)        credit adapters (XLS-65, XLS-66)
                   └────────────────┬────────────────┘  Reverse Carry = CREDIT use case
                                  ASSURE (trace, authenticity, portable evidence)
                                    │
                                  CTRL (API, web; mobile later)
                                    │
                                  PROD (host, durability, onboarding, hardening)
```

**DECISION (MASTER-01).** INTEL (§4.4) sits *beside* CORE, not above or inside
it: it reads intents, ASSURE evidence and authorized context sources, and it
feeds CORE only through the CORE-04 Trusted Context Boundary. CORE never
depends on INTEL (invariant 32). INTEL is a new track, not a runtime layer
above the envelope.

### 4.1 The governed-action primitive question

**FACT:**

- An adequate generic primitive already exists. `GovernedActionIntent`
  (`src/enterprise/governed-action/contracts.ts:52`) plus the orchestrator is
  action-agnostic: classification is host-trusted, and the adapter receives only a
  validated action.
- Its **parameter axes** are payment-shaped: `amount` and `counterparty` are the only
  parameters, and `GrantBoundKey` is a closed list (L-2 … L-5).

**DECISION:**

- Do **not** introduce a new `GovernedAction` / `EconomicIntent` /
  `AuthorityRequest` layer above it. A second envelope would duplicate the P3
  orchestrator and create a god-object.
- Instead, CORE-03 generalizes the existing envelope's parameter and bound model.
- `PaymentIntent` (PAY-01) and `CreditIntent` (CREDIT-01) are specialized models
  owned by their tracks that **compile down** to the envelope.
- PAY and CREDIT can then build on it safely: authority, grant, ceilings, claim,
  outcome and evidence are shared, and intent semantics are not.

**DECISION (MASTER-01, reaffirmed).** The canonical governed-action spine does
not change:

```
GovernedAction (GovernedActionIntent envelope)
  → Kernel (deterministic decision, Governance Store commit)
  → BoundedGrant (attenuation-only, signed)
  → constraints / exercise controls (P4 emergency, P7, P10, obligations)
  → write-ahead claim / governed execution
  → Execution Adapter (single call site)
  → Outcome (P11, P12)
  → Evidence (P8 stream, bundles, assurance)
```

No universal action object is added above `GovernedActionIntent`, and no
parallel AI authorization pipeline exists or may be built. "GovernedAction" in
this document names the semantic concept; `GovernedActionIntent` remains its
runtime envelope.

### 4.2 Governed Action semantic model

**DECISION (MASTER-01).** A Governed Action answers:

| Question | Element | Where it lives (FACT today → owner) |
|---|---|---|
| WHO | Actor / Principal | Customer principal → subject → Kernel-Authority actor (P2) |
| WANTS TO DO WHAT | Action | `GovernedActionIntent.action` (required identifier) + host-trusted `financial`/`non-financial` class → domain-declared action class (CORE-03) |
| TO WHAT | Resource | `GovernedActionIntent.resource` (required identifier → `resourceScope`, grant `resources`) → domain-declared resource class over that reference (CORE-03) |
| UNDER WHOSE AUTHORITY | Authority / Grant / Provenance | Kernel-Authority world, Authority Graph, BoundedGrant (VERIFIED); lineage (CORE-04) |
| UNDER WHAT CONDITIONS | Constraints, Policy, Obligations, Trusted Context | P7/P10 (VERIFIED); policy packs (CORE-03, PARTIAL); obligations + trusted context (CORE-04) |
| THROUGH WHAT | Execution mechanism / Adapter | Adapter registry + Generic HTTP (VERIFIED); rails (PAY) |
| WITH WHAT RESULT | Outcome | P11 / P12 (VERIFIED) |
| PROVEN BY WHAT | Evidence | P8 stream, bundles (integrity-only) → ASSURE |

This is a **semantic model, not a god-object.** The envelope stays small and
extensible: typed, host/domain-declared parameter dimensions (CORE-03) carry
what a domain needs. **A GovernedAction is not inherently monetary**; money is
one parameter dimension (P9) among others.

**Action + Resource awareness (DECISION).** Governance requirements depend on
the combination Actor × Action × Resource, not on any one of them:

| Action × Resource | Material governance differs because… |
|---|---|
| transfer × XRP asset | value moves irreversibly to a destination |
| deploy × production environment | a change reaches live systems |
| read × customer database (one record) | bounded data disclosure |
| export × customer database (all records) | bulk disclosure — same resource, radically different governance |
| modify × infrastructure | state change with blast radius |
| revoke × credential | security-relevant, often urgent |
| activate × physical or digital control | real-world effect (see note) |

CORE owns the generic slots (actor, action class, resource class, resource
reference, typed parameters) and their authority semantics. **CORE does not own
a resource or action taxonomy**: no universal enums, no XRP, database,
Kubernetes or robot semantics. Action and resource classes are opaque,
domain-declared identifiers, as asset ids already are (P9). Domain / vertical
packs teach Frontera which facts matter for a given combination, via
Governance Profiles (§4.3).

Future profile families may cover financial assets, data, infrastructure,
credentials, software environments and physical systems. **Frontera is not
claimed ready for physical-system control**: physical actuation will need
stronger safety qualification (fail-safe semantics, real-time bounds,
human-in-the-loop guarantees) than any current milestone defines.

**Rail neutrality vs action neutrality (DECISION).** Two distinct properties,
never to be collapsed:

| Property | Meaning | Proven by |
|---|---|---|
| **Rail neutrality** | The same authority core governs *economically equivalent* actions across different settlement rails (XRPL, Lightning) | CORE PROVEN (§11.2) |
| **Action neutrality** | The same authority core governs *materially different* classes of action and resource (transfer XRP, deploy to production, read customer data) | GOVERNED ACTION THESIS PROVEN (§11.6) |

### 4.3 Governance Profiles

**DECISION (MASTER-01).** A **Governance Profile** is a declarative
description of the governance requirements relevant to one Action × Resource
combination. No existing repository term covers it: a policy pack holds binding
rules, a `ContextRequirement` (ADR-CONTEXT-PROVENANCE-AND-TRUST §4) holds the
facts one rule needs; a profile is the domain's statement of *what matters* for
a combination, and points at those. Conceptually:

```
profileId, version, owner (organization or domain pack), provenance
resourceClass                 e.g. xrpl_asset            | production_environment
actionClass                   e.g. transfer              | deploy
materialFacts[]               ownership, destination,    | release_version, tests_passed,
                              amount, purpose,           | approved_change_window,
                              recipient_relationship     | rollback_available, incident_status
requiredEvidence[]
relevantPolicies[]            references to policy packs, never inline rules
potentialApprovalRequirements[]
applicableConstraints[]       references to CORE constraint kinds
```

Properties (binding on future work):

- **Declarative and schema-bound.** Data validated against a versioned schema.
  **Never arbitrary executable code**, and never code supplied by AI.
- **Versionable, with a lifecycle** (draft → active → retired) and compatibility
  rules across versions.
- **Organization/domain-owned, provenance-aware.** Every version records who
  authored and who activated it, like a promoted policy pack
  (ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY §5). An AI-drafted profile is a
  draft until an authorized human promotes it.
- **Not load-bearing for authority on its own.** Binding requirements come from
  organization policy (and its `ContextRequirement`s) keyed on the
  deterministic action/resource classification. A wrong or missing profile
  selection can make the Agent gather the wrong facts; it cannot make the
  Kernel require fewer facts. Unresolved required facts stay `unresolved`, and
  policy decides what that means.

Ownership: the profile **schema**, validation, versioning and provenance are
CORE-03 (generic, no domain vocabulary). Binding a profile's material facts to
trusted sources is CORE-04. Profile **resolution** is INTEL-02. Profile
**content** belongs to domain packs (PAY, CREDIT, verticals) and organizations.
Nothing is implemented by MASTER-01.

### 4.4 The Frontera Agent and the intelligence boundary

**DECISION (MASTER-01).**

#### 4.4.1 What the Frontera Agent is

The **Frontera Agent** is a *logical* set of intelligence capabilities, not one
process, model, service or LLM: Action Interpreter, Resource Intelligence,
Governance Profile Resolver, Context Planner, Context Resolver, Behavioural
Intelligence. No deployment topology is chosen, and multiple physical models
are not required. Three conceptual roles, which may share implementation and
do not each get a roadmap system:

- **Action Intelligence** — understands what is being requested (INTEL-01).
- **Resource Intelligence** — understands what is affected and which profile is
  relevant (INTEL-01, INTEL-02).
- **Risk Intelligence** — observes history, evidence and behaviour (INTEL-05).

It corresponds to layer G of `ADR-AUTHORITY-CONTROL-LAYERING.md`. Layer G
still never appears in the authorization path: its outputs reach policy only
as layer-C facts admitted by CORE-04.

The Agent **may** interpret, classify, investigate, ask, retrieve, correlate,
detect, summarize, produce observations and produce candidate RiskSignals. It
**may not** create, expand or exercise authority, mint a grant, override
deterministic policy, discharge an obligation, approve on behalf of a human, or
directly authorize execution.

#### 4.4.2 Canonical flow

```
Intent (natural language or machine)
  ↓
Frontera Agent (INTEL)                             ── untrusted by construction
  ├── interpret action                  INTEL-01
  ├── understand / classify resource    INTEL-01
  ├── resolve Governance Profile        INTEL-02
  ├── identify material facts, plan questions   INTEL-03
  ├── retrieve context (bounded tools)  INTEL-04 ── via configured sources (ERP, CRM,
  │                                                  registry, chain, LDR, evidence…)
  ├── correlate evidence                INTEL-05 ◄── ASSURE-04 substrate
  └── emit observations / candidate RiskSignals
  ↓
Trusted Context Boundary (CORE-04)                 ── deterministic admission
  ↓
GovernedAction (envelope, CORE-03) + admitted context
  ↓
deterministic organization Policy + Kernel         ── ALLOW / REVIEW / DENY
  ↓
BoundedGrant → constraints → claim → Execution Adapter → Outcome → Evidence (ASSURE)
  ↓
Behavioural Intelligence (INTEL-05) ── feeds future observations / RiskSignals only
```

The Agent is optional: a governed action can enter the envelope directly from
a machine caller with no interpretation, as every governed action does today.

#### 4.4.3 Observations, Trusted Context and authority to attest

An **Observation** is a value the Agent found or inferred, carrying where
applicable: value, source, timestamp, provenance, fact type, confidence and
correlation. An observation is untrusted. CORE-04 owns the deterministic
**Trusted Context Boundary** through which an observation may become an
*admissible fact*; admission requires source identity, source authority for
that fact class (configured by the organization, never named by the requester
or the Agent — ADR-CONTEXT-PROVENANCE-AND-TRUST §3), provenance, freshness,
fact type and an organization-defined trust rule. INTEL-04 retrieves; it never
decides that a source is trustworthy.

A source can have **authority to attest** a fact class (ERP → invoice
existence; wallet registry → destination registration; blockchain → chain
state; HR → employment status) without any **authority to authorize** the
action (invariant 30). The existing `ContextSource` + trust-class model (FACT:
LIBRARY-ONLY, `context-resolution-runtime`) is the intended vehicle.

**Live Data Rail (LDR)** is one possible context source / transport for ERP,
organizational, operational and external facts: Agent / Context Resolver → LDR
or source adapter → observation → provenance → Trusted Context Boundary. LDR
transports and provides data. It is not part of the authority core and it does
not authorize anything.

#### 4.4.4 RiskSignal

A **RiskSignal** is an observation or assessment about risk, never an
authorization decision. Conceptual fields: type, severity, confidence, actor,
action, resource, timeWindow, supportingEvidenceRefs, provenance (producer,
detector/model identity and version, inputs). Example: `type:
threshold_circumvention, severity: high, supportingEvidenceRefs: [...]`.

Lifecycle:

| State | Produced by | May affect authority? |
|---|---|---|
| **candidate** | INTEL-05 (model, rule or statistical detector) | **No.** Displayable, reviewable, recordable |
| **admitted / trusted** | CORE-04 admission: acceptable producer (a configured signal source), evidence references that resolve, provenance, freshness, signal type the organization's policy declares, and the producer's trust as configured by the organization | Only as an input to deterministic organization policy, and only restrictively (invariant 27, §4.4.5) |

Admission evaluates the *producer and its evidence*, not the model's
self-assessment: **model confidence ≠ trust** (invariant 29). A RiskSignal
never directly ALLOWs, DENYs, creates a grant, increases authority or executes.

#### 4.4.5 Adaptive Authority Containment

Admitted RiskSignals may cause **deterministic organization policy** to apply
more restrictive authority controls through **existing** mechanisms: an
additional obligation (CORE-04), a shorter grant lifetime or lower ceiling
(grant attenuation, P10), an approval requirement (CORE-05 / CTRL-04),
suspension (P4 emergency control), revocation (CORE-01) or an emergency stop.
The AI performs none of these transitions; policy does. Intelligence may
contribute to **restricting** authority; it may never independently
**expand** it (invariant 27).

Non-normative example:

| Admitted signal | Organization policy (deterministic) applies |
|---|---|
| none | ceiling 10,000 |
| elevated risk | ceiling capped at 5,000 |
| high risk | human approval required (durable approval, CORE-05) |
| critical risk | authority suspended or revoked |

The human-approval boundary is preserved: the Agent identifies risk or missing
context; deterministic policy decides whether approval is required; a human
with authority approves or rejects through the durable approval mechanism
(CORE-05, CTRL-04). The Agent never impersonates human authority. Approvals are
not merged into INTEL.

#### 4.4.6 Relationship to `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY`

FACT: that ADR (accepted, architecture-only) forbids any model output from
becoming a `ContextFact` at any trust class (§2.2, hard invariant 4), says a
detected anomaly may inform a human but never add an approval requirement
(§7), and requires that removing every advisory producer changes no decision
(hard invariant 7). MASTER-01 departs from it **only** for restrict-only
admitted RiskSignals. DECISION:

- Prohibitions 1, 3, 4, 5 and the `Advisory` shape stand. A candidate RiskSignal
  and an Observation are advisories in that ADR's sense.
- Hard invariant 4 and §7 are narrowed: an *admitted* RiskSignal — produced by
  a configured signal source and admitted by CORE-04 under an organization rule
  — may be read by policy, **only by rules whose effect is restrictive**. A
  policy-pack validation rule enforces this (a signal key in a rule that
  widens, allows or lengthens is refused).
- Hard invariant 7 is restated as a testable monotonicity property: *with every
  intelligence producer removed, every decision equals the no-signal baseline;
  with them present, every decision is equal to or more restrictive than it.*
- The ADR's reproducibility objection is answered by recording: an admitted
  signal is persisted and digested as a decision input, so the decision is
  reproducible from its recorded inputs, exactly as an authoritative ERP fact is.
- **Until CORE-04 and INTEL-06 deliver this with tests, the ADR's prohibitions
  remain fully in force.** INTEL-06 owns a superseding ADR for the narrowed
  clauses. The Kernel-source intelligence-vocabulary ban stays unchanged.

#### 4.4.7 Evidence feedback loop

Intent → Frontera Agent → GovernedAction + admitted context → Kernel →
BoundedGrant → Execution → Outcome → Evidence → Behavioural Intelligence →
future observations / RiskSignals. This is a monitoring loop, **not autonomous
policy rewriting**: evidence informs later evaluation; policy stays
organization-owned (invariant 31). A learned baseline is an INTEL input, never
a policy.

#### 4.4.8 Model and AI security obligations (PLAN)

Future INTEL work must be threat-modelled for: prompt injection, malicious
retrieved content, hallucination, model compromise, poisoned context,
malicious tool output, provenance confusion, signal fabrication, a compromised
external context source, and model/provider drift. The architectural
requirement is that each of these can at worst produce an **untrusted**
candidate interpretation, observation, question or candidate RiskSignal until a
deterministic boundary admits it — and, after admission, can at worst
**restrict** authority (an availability cost), never expand it. The
Agent's retrieval tools are least-privilege, read-only by default, and
separate from execution authority (invariant 30). Mitigations are not
implemented by MASTER-01; see `docs/security/THREAT_MODEL_V1.md` §7.23.

---

## 5. Track Model

**DECISION.** Future work uses only these seven prefixes (INTEL added by MASTER-01). Global `P`, `Prompt`,
`Phase`, `R`, `SK`, `FR-REC`, `Slice`, `Sprint` and `MPP-xx` numbering is retired
as a roadmap mechanism (§15).

| Track | Owns | May depend on | Must not |
|---|---|---|---|
| **CORE** | Principals, authority world, provenance/delegation, grants, revocation, policy evaluation, ceilings/exercise controls, obligations, trusted inputs/risk inputs, approvals (engine side), authenticity, signer/key-trust boundaries, the governed-action envelope | — | Import or name any payment protocol, rail, credit mechanism, wallet, custodian or KMS vendor |
| **PAY** | Payment intent, protocol adapters (MPP, x402), rail adapters (XRPL, Lightning, …), payment credentials, receipts, settlement, payment outcomes | CORE | Add payment vocabulary to CORE types |
| **CREDIT** | Credit intent, borrower context, exposure/concentration/collateral, loan authorization, repayment obligations, credit adapters (XLS-65/66), Reverse Carry | CORE; PAY only for shared rail clients | Add credit vocabulary to CORE types |
| **ASSURE** | End-to-end trace, evidence authenticity, settlement evidence, portable assurance, qualification suites, the behavioural evidence substrate (ASSURE-04) | CORE, PAY, CREDIT (read-only) | Become an authority source (invariant 13); analyse behaviour or emit RiskSignals (INTEL) |
| **INTEL** | The Frontera Agent (§4.4): action/resource interpretation, Governance Profile resolution, context question planning, bounded context retrieval with provenance, behavioural analysis and candidate RiskSignals, adaptive-containment integration | CORE (public contracts only), ASSURE (read-only), CTRL (surfaces) | Be imported by CORE (invariant 32); decide, mint, expand or exercise authority; write trusted context except through CORE-04 admission; approve on a human's behalf; rewrite policy; become the canonical evidence store |
| **CTRL** | Organizations, humans, agents inventory, authority administration, approvals UX, API, web, mobile, alerts; surfaces for context, questions, RiskSignals and containment state (§9 CTRL note) | CORE, ASSURE, INTEL (display) | Become a decision path (a UI never decides) |
| **PROD** | Bootable host, secure defaults, backup/recovery, observability, onboarding, SSO/RBAC, billing, deployment, release qualification | all | Change authority semantics |

---

## 6. Historical Roadmap Mapping

**FACT:** Historical names are preserved for provenance only. Dates are merge dates on `main`.

### 6.1 Eras

| Era (historical id) | PRs | Dates | Built | New owner | Status now |
|---|---|---|---|---|---|
| Codex runtime, Track 2 (2.4–2.6) | #1–#15 | 05-13 → 05-18 | Runtime/protocol boundary, SDK host, lifecycle integrity | CORE (legacy) | SUPERSEDED by Kernel/Enterprise host for governance; retained for SDK |
| Runtime substrate | #16–#21 | 05-21 | Contracts, operational state, persistence abstraction, "sovereign vault" boundary, federation | PROD | VERIFIED as substrate; not on the governed path |
| Agent Passport product | #22–#34 | 06-25 → 06-29 | Next.js app, Stripe checkout, orgs/teams/roles, issuer keys | CTRL (separate product) | VERIFIED as a separate product; unintegrated |
| AOC runtime features | #35–#48 | 07-06 → 07-07 | Recognition, authority graph/delegation, approval, handshake, enforcement gateway, control-plane UI, domain policy packs, evidence source, verifiable export | CORE / CTRL / ASSURE | Recognition + authority graph VERIFIED; approval, control-plane UI, export LIBRARY-ONLY |
| Foundation v1 / policy packs / Sprint 39R–40R (pmfreak) | #49–#62 | 07-07 → 07-09 | Pilot template, policy-pack foundation, jurisdiction and Costa Rica packs, pmfreak vertical demo | CORE (packs), PROD (template) | PARTIAL (host-injected packs); pmfreak = demo |
| Kernel / Enterprise Host v1 (PR-003…006) | #63–#75 | 07-10 → 07-15 | Kernel extraction, enterprise host, module lifecycle, Governance Store, evidence bundle, passport runtime, assurance, v1.0.0 API freeze, portability | CORE / ASSURE / PROD | VERIFIED |
| Security fixes | #76–#77 | 08-03 | Capability-token verification bypass; provider-credential exposure | CORE | VERIFIED |
| R004 / R005 / R006 access-governance contracts, Pinata | #78–#92 | 08-03 → 08-04 | Resource envelope, access decision, obligation, access grant, grant revocation, usage event, evidence correlation contracts; provider adapter/translation; Pinata; conformance suite; commercial demo | CORE (contracts) / PAY-adjacent adapter pattern | Mostly DOCUMENTED ONLY; Sovereign Access = separate excepted model |
| SK005, Slice 1/2 | #93–#95 | 08-04 → 08-06 | Pitch deck; durable grants + truthful revocation (Sovereign Access); content protection | CORE / PROD | VERIFIED within Sovereign Access |
| Governed actions "Phase 5.x" | #97–#110 | 08-16 → 08-19 | Tokenize, collateralize, license, transfer, encumbrance, reservation, derived-authority lineage, constraint applicability | CREDIT (candidate primitives) / CORE | LIBRARY-ONLY |
| P0-PKG / P0-CANON | #111–#114 | 08-24 → 08-26 | Self-contained packaging, durable Kernel-Authority, protocol repin rc.1 | CORE / PROD | VERIFIED |
| Target authority-control architecture (layers A–G) | #115–#119 | 09-11 → 09-12 | Architecture + 4 ADRs; context provenance; obligation discharge; bounded grants; grant-aware execution | CORE | Grants VERIFIED; context + obligations LIBRARY-ONLY |
| Security & Containment, Prompts 0–4 | #120–#123 | 09-13 → 09-16 | Baseline audit, invariants, trust boundaries, no-bypass proof, SQLite grant store | CORE | VERIFIED |
| FR-REC-01/02 (Capital Discovery) | #124–#125 | 09-17 → 09-18 | Authorization boundary + trusted context provider | CREDIT (integration) | LIBRARY-ONLY; FR-REC-03 absent |
| P2–P6 governed-action spine | #127–#132 | 09-19 → 09-21 | Principal binding, orchestrator, adapter routing, emergency control, API/SDK, Generic HTTP adapter | CORE (P2–P5), PAY-neutral execution (P6) | VERIFIED (opt-in) |
| P7–P12 financial track | #133–#140 | 09-21 → 09-24 | Aggregate controls, event stream, monetary semantics, authority ceilings, durable outcomes, reconciliation | CORE (P7, P9, P10), ASSURE (P8), CORE execution (P11, P12) | VERIFIED (opt-in) |
| Security Prompt 5 → PRE-00 | #142 | 09-25 | Ed25519 authority artifact authenticity | CORE | PARTIAL (§3.7) |
| P13 MPP business idempotency | unmerged `24dd264` | — | MPP challenge parser, business-operation store | PAY | Not merged. Input to PAY-02 |

### 6.2 Per-item mapping of named historical work

| Historical | New owner | Status | Notes |
|---|---|---|---|
| Prompt 0: Security baseline audit | CORE | VERIFIED (document) | `SECURITY_CONTAINMENT_BASELINE_AUDIT.md` |
| Prompt 1: Security invariants | CORE | VERIFIED | `docs/security/SECURITY_INVARIANTS.md` |
| Prompt 2 / 2.5 / 2.6: Trust boundaries; passport-web threat model; checkout credential fix | CORE / CTRL | VERIFIED | |
| Prompt 3: No-bypass execution | CORE | VERIFIED, path-local | 3/46 effect paths under grant control |
| Prompt 4: Authoritative grant store | CORE | VERIFIED (sqlite) | Not the default provider |
| Prompt 5 / PRE-00: Authority artifact authenticity | CORE | VERIFIED after CORE-01; required on the shipped Host (PROD-01) | Un-revocation hole closed by CORE-01 |
| Prompt 6: KMS/HSM for signing secrets | CORE | PLANNED | → CORE-02 |
| Prompt 7 / 9 / 16: Sandbox, secretless, escape model | PROD | DEFERRED | No agent-execution process exists |
| Prompt 8: Workload identity | PROD | DEFERRED | Deployment guidance only |
| Prompt 10: FS/process/network constraints | CORE | PARTIAL | Boundary tests exist; extend as layers are added |
| Prompt 11: Egress allowlisting | PROD | PLANNED | → PROD-04 |
| Prompt 12: Kill switch | CORE | VERIFIED (opt-in) | Delivered by P4 emergency control; operator API delivered by CTRL-01 |
| Prompt 13 / P21: Behavioural abuse detection / intelligence | ASSURE / INTEL | PLANNED | → ASSURE-04 (evidence substrate) + INTEL-05 (analysis, candidate RiskSignals); affects authority only restrictively via CORE-04 + INTEL-06 (MASTER-01, §4.4) |
| Prompt 14: Self-modification protection | CORE | PARTIAL | Policy-pack writes carry no caller identity (NB-008) → CORE-03 |
| Prompt 15: Tamper-evident evidence | ASSURE | PARTIAL | Integrity yes, authenticity no → ASSURE-02 |
| Prompt 17 / P17: Deployment topology / store-set durability | PROD | PARTIAL | Host topology VERIFIED by PROD-01 (NB-005, GS-003 closed for the shipped Host); store-set backup → PROD-02 |
| Prompt 18 / 19: Adversarial suite; rogue-agent scenarios | ASSURE | PARTIAL | → CORE-06 qualification, ASSURE-03 |
| Prompt 20: Customer-controlled signer contract | PAY / CORE | PLANNED | → CORE-02 (authority keys), PAY-03 (transaction signing) |
| Prompt 21 / 22 / 23 / 24: Posture, readiness gate, pentest prep, certification | PROD | PLANNED / DEFERRED | → PROD-03, PROD-04 |
| P1 | — | Never assigned | No artifact found |
| P2–P6 | CORE | VERIFIED (opt-in) | See §6.1 |
| P7: Aggregate exercise controls | CORE | VERIFIED (opt-in) | |
| P8: Authority event stream | ASSURE | VERIFIED (integrity) | |
| P9: Canonical monetary semantics | CORE | VERIFIED | Generic, not payment-specific |
| P10: Authority-sourced payment ceilings | CORE | VERIFIED | Money-typed constraint in CORE; see §8 |
| P11: Durable monetary outcomes | CORE (execution) | VERIFIED (opt-in) | |
| P12: Reconciliation / resolution authority | CORE (execution) | VERIFIED (port) | Rail-specific resolvers → PAY-03/04 |
| P13: MPP + business idempotency | PAY | Unmerged | → PAY-02 |
| P14: Stripe + credential custody | PAY | DEFERRED (Stripe); PLANNED (credential boundary) | → PAY-03 |
| P15: Receipts, settlement, payment obligations | PAY | PLANNED | → PAY-05 |
| P16: Payment observability | PROD | PLANNED | → PROD-04 |
| P18: XRPL | PAY | PLANNED | → PAY-04 |
| P19: Containment | PROD | DEFERRED | |
| P20: KMS/HSM | CORE | PLANNED | → CORE-02 |
| TARGET architecture Phases 0–12 | CORE | Phase 0, 7, 8 done; 2–6, 9–12 partial or absent | Superseded as a sequence by this document |

---

## 7. Known Architectural Duplication

**FACT.** No refactoring is done in MASTER-00. Classification key:
**Intentional** = separate concern; **Reconcile** = duplication to resolve.

| Concept | Representations | Class | Owner |
|---|---|---|---|
| Authority world | (a) Kernel-Authority records → Authority Graph (canonical for governed actions). (b) `packages/governed-authority` + `authority-governance` mandates (right-scoped holdings, encumbrances), never consulted by governed actions | **Reconcile.** This is the largest gap: two authority worlds | CORE-04 decision; CREDIT-01 consumer |
| Grants | `grant-runtime` BoundedGrant (canonical) · `packages/access-grant` + `grant-revocation` (Sovereign Access, excepted model) · `packages/capability-tokens` (0 consumers) · recognition capability tokens (standing capability) | BoundedGrant vs recognition capability: Intentional. Access-grant: Reconcile or formally scope as a separate product. Capability-tokens package: Reconcile (deprecate) | CORE |
| Principal | `BoundCustomerIdentity`, Kernel `actor`, Recognition `Actor`, Authority-Graph node (intentional layering) · `packages/identity` (legacy runtime) · Enterprise `AgentPassport` (composed, never consulted) · `pmfreak-agent-passport-foundation` · `agent-governance` passport (passport-web) | Layering: Intentional. Passport shapes: Reconcile | CORE / CTRL-02 |
| Obligations | `obligation-runtime` (Kernel) · `packages/access-obligation` (0 consumers) · credit/payment obligations (future) | Access-obligation: Reconcile (deprecate). Future payment and credit obligations must **reuse** `obligation-runtime` | CORE-04 |
| Money | `MonetaryAmount {value, unit}` (canonical) · ingress `amount {value, currency}` · Kernel request `amount/currency` strings · authority-graph `spending_limit.currency` · `collateralization-mandate {minorUnits: safe integer, currency}` | **Reconcile.** The `currency`/`unit` naming split, and collateralization's off-spine money | CORE-03 (naming), CREDIT-01 (collateral) |
| Canonical serialization / hashing | `governance-store/canonical-json.ts` canonicalSerialize (enterprise stores) · 9 `stableStringify` copies in feature proofs · `agent-governance canonicalizeJson` · 22 `createHash('sha256')` sites | **Reconcile.** Identifiers are not interchangeable across proof types | ASSURE-02 |
| Signatures | Ed25519 authority-authenticity (grants/revocations) · HMAC passport issuer (`apps/agent-passport-web`) · unkeyed digests everywhere else | **Reconcile.** Converge on the CORE-02 signer boundary | CORE-02, ASSURE-02 |
| Evidence | Event stream (P8, runtime trace) · evidence bundle (one decision) · assurance runtime · verifiable export · `evidence-correlation` contract · `usage-event` | Bundle vs stream: Reconcile (ASSURE-01). Correlation / usage-event: SUPERSEDED by the stream | ASSURE-01 |
| Execution outcomes | P11 outcome store · P12 resolution store · governance-store attempt row | Intentional: claim, observation and resolution are distinct facts | — |
| Idempotency | `requestId` from `idempotencyKey` (spine) · P13 business-operation identity (unmerged) · Stripe webhook idempotency (passport-web) | Spine vs P13: Intentional (request vs business operation), must be reconciled when P13 lands. Stripe: separate product | PAY-02 |
| Policy context | Kernel `request.context`, Recognition `PolicyContext`, domain-pack `aoc.context`, `ExerciseControlPolicy`, `GovernedActionGrantPolicy` | Mostly intentional (one per gate). There is no single trusted-context object | CORE-03 |
| Advisory vs RiskSignal (future) | `Advisory` (ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY §3, unimplemented) · RiskSignal (§4.4.4, unimplemented) · assurance-runtime typed signals (§7.14 of the threat model; assessment-scoped) | Not yet duplicated. A candidate RiskSignal must be an `Advisory` kind, not a second advisory shape; assurance signals stay assessment-scoped | CORE-04 (admitted schema), INTEL-05 |
| Challenge normalization / payment intents | Only P13 (unmerged) | Not yet duplicated. Keep it that way | PAY-01/02 |
| Control plane | `src/features/aoc-control-plane` · `packages/control-plane` (orphan) · `control-plane-sdk` (types) · passport-web admin | Reconcile. Pick one base | CTRL-03 |

---

## 8. Technology Leakage / Technical Debt

**FACT.**

- `rlusd`, `lightning`, `bolt11`, `bitcoin`, `x402`, `ethereum`, `solana`, `hedera`, `cardano`, `xls-65/66` and
  `evernorth` have zero hits in `src/`, `packages/` and `apps/`.
- `mpp` has zero hits on `main`.
- Structural tests forbid rail and protocol vocabulary in core layers.

Real leakage:

| # | Where | Why it is leakage | Severity | Owner |
|---|---|---|---|---|
| L-1 | `src/enterprise/access-governance/service.ts` (imports `@aoc-enterprise/pinata-adapter`, branches on `PINATA_PROVIDER_SYSTEM`); `contracts.ts` (`providerCid`, `providerFileId`) | A generic access-governance service is hard-wired to one storage provider. A second provider means editing the core service | Medium-High | CORE (or scope Sovereign Access out as a vertical) |
| L-2 | `src/kernel/contracts/kernel-request.ts:49-50` (`amount?`, `currency?` on every action) | Money is a first-class axis of the generic Kernel request, rather than a typed parameter | Medium | CORE-03 |
| L-3 | `src/features/grant-runtime/domain/grant-scope.ts` (`GrantBoundKey = 'action'\|'amount'\|'counterparty'\|'organization'\|'resources'`) | The grant is quantity-generic in form but money-specific in semantics. There is no pluggable bound kind. Credit bounds (exposure, tenor, LTV) cannot be expressed | Medium | CORE-03 |
| L-4 | `src/enterprise/governed-action/contracts.ts` (`amount {value, currency}`, `actionClass: 'financial'\|'non-financial'`) | Financial is a first-class branch of the generic spine. Well bounded (host-trusted classifier), but payment-first | Medium | CORE-03 |
| L-5 | `src/features/authority-graph/domain/authority-grant.ts` (`spending_limit {currency, maximum, window}`) | A money-typed constraint in the authority definition layer. Defensible as a quantity limit, but named and typed for payments | Low-Medium | CORE-03 |
| L-6 | `governed-action/intent.ts:94-139` reserved keys (`paymentCeiling`, `spendingLimit`, `providerRef`, `finalOutcome`) | Denylist names, not logic | Low | CORE-03 |
| L-7 | P13 branch adds `mppChallenge`, `mppRealm`, `paymentCredential`, `merchantRealm`, … to the generic `intent.ts` reserved list | Protocol vocabulary in the generic intent validator | Medium, **if merged as-is** | PAY-02 must supply reserved keys through a registry |
| L-8 | `monetary-asset.ts:24-29` examples `xrpl:USD/rIssuer` | Comment only. The `/issuer` segment is XRPL-shaped by convention, not by grammar | Low | PAY-01 |
| L-9 | `content-protection/pinata-storage-adapter.ts` exported from a core barrel | An adapter living inside a core folder | Low | CORE |
| L-10 | `providerRef` | **Not leakage.** It is a handle, never identity or proof | — | — |

Other technical debt:

| # | Item | Owner |
|---|---|---|
| TD-1 | Rename incomplete. The product docs, README body and CHANGELOG header say "Frontera Systems" (PR #146); the v1.0.0 release, operations and performance reports keep their historical "AOC Enterprise" titles. `@aoc-enterprise/*`, `AocKernel`, `AOC_ENTERPRISE_*` and `docs/enterprise/AOC_*.md` remain (compatibility namespaces are intentional, per README) | PROD |
| TD-2 | Stale "current state" docs contradict code. `CURRENT_STATE_AUTHORITY_CONTROL.md` says obligations are "never discharged". `ADR-CONTEXT-PROVENANCE-AND-TRUST` says "no implementation". The TARGET doc says "no implementation has been performed" | CORE (historical banners added by MASTER-00 where they act as roadmaps) |
| TD-3 | Production providers import `bridgeRecognitionRuntime` from a fixtures file (`providers/kernel-provider-composition.ts:11`) | CORE |
| TD-4 | Zero-consumer packages: `capability-tokens`, `access-decision`, `access-obligation`, `policy-runtime`, `consent-engine`, `org-boundary`, `tenant-governance`, `control-plane-sdk`, `enterprise-audit`, `audit-sdk`, `control-plane` | PROD (deprecation decision) |
| TD-5 | Agent Passport production issuer signer is HMAC `createTestSigner`, so passports are not publicly verifiable | CTRL-02 / CORE-02 |

---

## 9. Authoritative Future Roadmap

**PLAN.** Items are listed in dependency order within each track. There is
exactly one **NEXT**.

Candidate items from the MASTER-00 brief were changed as follows:

- **Deleted as already complete:**
  - The governed-execution half of "PAY-05 Governed Execution / Credential Boundary". P3–P12 already deliver it.
  - "CORE-03 Governed Action Boundary" as a new primitive. The envelope exists (§4.1); CORE-03 generalizes it instead.
- **Merged:** "CORE-04 Risk Signals / Trusted Policy Inputs" into CORE-04, which lands context and obligations together because both are blocked by the same composition gap.
- **Inserted:**
  - CORE-01 (revocation integrity, a correctness defect in a merged guarantee).
  - CORE-05 (durable approvals).
  - PROD-01 and PROD-02 (a bootable, recoverable host is a pilot prerequisite that did not appear in the candidate plan).
- **Split:** "PAY-03 Settlement Rail Boundary + XRPL" into PAY-03 (boundary + credentials) and PAY-04 (XRPL).
- **Deferred:** mobile (CTRL-06/07), and Stripe and other rails beyond the second.

MASTER-01 (2026-09-27) changed the roadmap as follows:

- **Added:** the INTEL track (INTEL-01 … INTEL-06) and CORE-08 (action-neutrality
  qualification, the gate for GOVERNED ACTION THESIS PROVEN, §11.6).
- **Expanded:** CORE-03 (actor/action/resource semantics, Governance Profile
  schema) and CORE-04 (Trusted Context Boundary, authority to attest, admitted
  RiskSignal contract).
- **Re-scoped:** ASSURE-04 to the behavioural evidence substrate; analysis moved
  to INTEL-05. ASSURE-04 moved from DEFERRED to PLANNED.
- **Re-prioritized:** NEXT moved from CTRL-02 to CORE-03 (§14). CTRL-02's
  purpose and scope are unchanged. CTRL-01 is not reopened.

### CORE

**CORE-01: Revocation State Integrity & Durable Authenticity Enforcement**

| Field | Content |
|---|---|
| Status | **VERIFIED** (2026-09-25, branch `fix/core-01-revocation-integrity`) |
| Depends on | PRE-00 (merged) |
| Purpose | Make invariant 4 true for the signed store, and stop the authenticity guarantee from being silently absent |
| Existing reused | `authority-authenticity/*` (signer, verifier, domain tags, closed registry); `sqlite-bounded-grant-store.ts` read path; the three existing authenticity suites |
| Remaining work | (a) **Close the un-revocation path.** Make the grant↔revocation linkage authenticated, e.g. a signed revocation-state commitment or signed append-only revocation log, so deleting the revocation row *and* clearing the pointer is detected. (b) **Refuse a host-injected unsigned `grantStore`** when the persistence provider is durable, or require an explicit, audited acknowledgement. (c) Add tests for key-mismatch, active-key-not-trusted and malformed verification-key JSON. (d) Correct `AUTHORITY_ARTIFACT_AUTHENTICITY.md` threat M and GS-001, and the corresponding invariants text |
| Exit criteria | A test that deletes the revocation row **and** nulls the pointer fails closed. A test proves a durable deployment cannot run with an unsigned grant store without explicit opt-out. All composition fail-closed branches are tested. Docs make no BLOCKED claim that a test does not prove. Full suite green |
| Non-goals | KMS/HSM (CORE-02); rollback/freshness against whole-snapshot restore (CORE-07); signing other stores (ASSURE-02); changing the shipped host defaults (PROD-01) |
| Delivered | (a) Signed revocation-state commitment `{storeId, sequence, revocationSetDigest}` under domain `frontera:authority-artifact:revocation-state:v1`, verified before every authoritative answer; grant/revocation/commitment bound to a per-store id; genesis commitment on store creation; schema v3, v1/v2 refused and not migrated; in-process freshness witness; re-attestation on key rotation; append-only triggers as defense in depth. (b) Durable Host refuses an unauthenticated injected `grantStore` (runtime brand, no override flag). (c) Key-mismatch, active-key-not-trusted, malformed verification-key JSON tested. (d) `AUTHORITY_ARTIFACT_AUTHENTICITY.md` threat M / GS-001 corrected and §26 added; SEC-INV-124/125; threat model §7.16c |
| Evidence | `revocation-state-integrity.test.ts` (45), production-service case in `authority-controlled-execution-scenario.test.ts`, structural rules in `authority-authenticity-boundaries.test.ts`; five deliberate-violation experiments each failed the expected tests; typecheck, lint, build, workspace tests green; root suite green except one pre-existing CRLF working-copy artifact (`structural-boundaries.test.ts`, passes 64/64 against the committed LF tree) |
| Residual (owned elsewhere) | Cross-restart restore of a captured earlier signed state (CORE-07); process-resident key and signer availability, now two signatures per revocation plus genesis (CORE-02, AA-004/AA-009); not default-wired and `memory` persistence still accepts any store (PROD-01) |

**CORE-02: External Signer & Key Custody Boundary**

| Field | Content |
|---|---|
| Status | PLANNED (unblocked: CORE-01 VERIFIED; the commitment format is settled — `signRevocationState(state)`) |
| Depends on | CORE-01 (hard: the revocation-state commitment format must be settled before its signer moves out of process) |
| Purpose | Remove AA-001 (a process-resident key can mint authority) and design around AA-004 (signer availability on revocation) |
| Existing reused | `AuthorityArtifactSigner` is already async and narrow (`signGrant`/`signRevocation`, no generic byte signing). Configuration redaction exists |
| Remaining work | A vendor-neutral external signer port (the adapter lives outside CORE). Key-id / algorithm negotiation (AA-006). Signer-outage semantics for revocation (AA-004). Cost/rate semantics (AA-005). A reference adapter against a local HSM emulator or a generic KMS API. Trusted-key configuration integrity (AA-002, narrowed). A decision on the Agent Passport HMAC signer (TD-5) |
| Exit criteria | No production composition holds an authority private key in process memory when an external signer is configured. Refusal paths are tested. CORE imports no KMS vendor SDK |
| Non-goals | Customer transaction-signing keys for rails (PAY-03); signing evidence (ASSURE-02); a PKI |

**CORE-03: Governed Action Semantic & Parameter Model (Actor · Action · Resource; envelope generalization)**

| Field | Content |
|---|---|
| Status | **NEXT** (MASTER-01) |
| Depends on | CORE-01 (soft) |
| Purpose | Keep **one** generic governed-action envelope, and make it express the Governed Action semantic model (§4.2) — actor, action, resource, structured and arbitrary bounded parameters, non-financial semantics — without coercing everything into `amount`/`counterparty`. Establish that a GovernedAction is **not inherently monetary**. Provide the generic, domain-extensible Governance Profile format (§4.3) |
| Existing reused | `GovernedActionIntent`, the orchestrator, P9 `MonetaryAmount`, the host-trusted classifier, grant attenuation |
| Remaining work | Action class and resource class, as opaque domain-declared identifiers (no CORE taxonomy, no universal enums), declared over the envelope's **existing** `action` and `resource` fields (which stay; no replacement envelope) and generalizing today's `financial`/`non-financial` classifier. Typed, host-declared action parameter dimensions (quantity, party, reference, duration), with attenuation rules per dimension, so a `GrantBoundKey` is no longer a closed money list (L-2 to L-6); money becomes one dimension. Unify `currency`/`unit` naming. Move reserved context keys to a registry that verticals extend (prerequisite for L-7). Give policy-pack writes a caller identity (NB-008). **Governance Profile schema** (MASTER-01): declarative, versioned, owner + provenance recorded, validated, keyed by action class × resource class, referencing policies and constraint kinds by id — data only, no resolver, no executable content |
| Exit criteria | A non-financial action with a structured parameter, and a quantity bound that is not money, are governed and attenuated end to end, with its action class and resource class recorded in the decision and the evidence. The same resource under two action classes (e.g. read one record vs export all) is governed differently by policy alone. Existing P9/P10 suites pass unchanged. A Governance Profile validates, versions and records provenance; an executable or unknown-field profile is refused. No payment, credit, database, Kubernetes or other domain term is added to CORE |
| Non-goals | `PaymentIntent` or `CreditIntent` (PAY-01, CREDIT-01); a universal "EconomicIntent" or replacement envelope; a resource/action taxonomy in CORE; profile resolution (INTEL-02); any AI component |

**CORE-04: Trusted Context & Obligations on the Governed Path**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-03 (hard: context facts and obligations bind to envelope parameters) |
| Purpose | Make layers C and D reachable from governed actions (both are LIBRARY-ONLY today). Answer the OBLIGATIONS and ADMITTED CONTEXT questions of invariant 23. Own the deterministic **Trusted Context Boundary** (§4.4.3) through which observations — including Agent observations and RiskSignals — become admissible facts, and the risk-input boundary |
| Existing reused | `context-resolution-runtime`, `obligation-runtime`, `GRANT_OBLIGATIONS_UNSATISFIED` mapping (`orchestrator.ts:671`), FR-REC-02 trusted context provider as a pattern |
| Remaining work | Compose `contextResolution` and `obligations` into the grant-aware Kernel (`composition-root.ts:1370`). Trusted-input registry: which sources may **attest** which fact classes (authority to attest ≠ authority to authorize, invariant 30), with source identity, provenance, freshness and organization trust rules. Binding a Governance Profile's material facts to `ContextRequirement`s and trusted sources. The canonical **admitted RiskSignal** input contract (candidate → admitted lifecycle, §4.4.4), named generically (no intelligence vocabulary in CORE), with a policy-pack rule that signal keys may drive only restrictive effects. Durable obligation state. Non-financial exercise-time lineage revalidation (closing the host-callback gap). Decision on the two authority worlds (§7) |
| Exit criteria | A governed action is withheld for an unsatisfied obligation and admitted after verified discharge, durably, across restart. Caller-asserted context cannot occupy a trusted-fact key. A source configured to attest one fact class cannot attest another. An observation without source identity or provenance, or stale beyond its freshness, is not admitted. Lineage is revalidated at exercise for non-financial actions. All of it passes with no intelligence component present |
| Non-goals | Retrieving context (INTEL-04); generating RiskSignals (INTEL-05); containment policies (INTEL-06); payment receipts as obligation discharge (PAY-05); credit repayment (CREDIT-05) |

**CORE-05: Durable Approvals (engine side)**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-04 (soft), CORE-03 (soft) |
| Purpose | `approval_required` must become resumable, not terminal |
| Existing reused | `approval-runtime` (quorum, escalate), Kernel `approvalProofId` handling, orchestrator withheld path |
| Remaining work | Approvals as a durable authority record kind. An approval proof bound to `requestId` + decision. Resume semantics on the governed path. Expiry. Tests |
| Exit criteria | A withheld action proceeds after a durable, attributable approval, and only for the exact request approved. Replay-safe |
| Non-goals | UI and notification (CTRL-04) |

**CORE-06: Governance Core Qualification**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-01 … CORE-05, PROD-01 |
| Purpose | The gate for the **GOVERNANCE CORE STABLE** milestone (§11) |
| Existing reused | `no-bypass-effect-paths`, `security-invariants`, adversarial suites (Prompts 18/19 material), demo scenarios |
| Remaining work | Adversarial suite over the composed default host. Invariant re-audit. Documentation truth pass |
| Exit criteria | §11.1 all true |
| Non-goals | Multi-rail proof (PAY-07) |

**CORE-07: Authority State Freshness & Rollback Detection**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-02 |
| Purpose | Close AA-003 / GS-002: a snapshot rollback restores revoked authority |
| Remaining work | Monotonic, externally anchored or timestamped authority-state checkpoints. Refusal on detected regression |
| Exit criteria | Restoring an older signed snapshot is detected before any grant is exercised |
| Non-goals | A blockchain-specific anchor inside CORE (an anchor adapter is fine) |

**CORE-08: Action-Neutrality Qualification (Governed Action Thesis)** (added by MASTER-01)

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-03 (hard), CORE-04 (hard), CORE-05 (hard), CORE-06 (soft: reuse its adversarial and no-bypass harness); one monetary execution path (PAY-04 preferred, Generic HTTP acceptable — §11.6) |
| Purpose | The gate for **GOVERNED ACTION THESIS PROVEN** (§11.6): prove action neutrality — the same deterministic core governs materially different action/resource domains |
| Existing reused | Generic HTTP adapter (P6) for non-monetary domains; P9/P10 for the monetary domain; structural boundary tests; the orchestrator scenario suites |
| Remaining work | Three reference domains expressed only through Governance Profiles, organization policy, context sources, domain validation and adapters. A structural test that the Kernel and orchestrator contain no domain branching. Cross-domain denial, over-bound, revoked-mid-flight and missing-context cases |
| Exit criteria | §11.6 all true |
| Non-goals | Rail neutrality (PAY-07, §11.2); any INTEL component (the thesis is about the deterministic core); physical actuation |

### PAY

**PAY-01: Canonical Payment Intent**

| Field | Content |
|---|---|
| Status | PLANNED (PARTIAL foundations) |
| Depends on | CORE-03 (hard) |
| Purpose | A payment-specific intent that **compiles down** to the generic governed-action envelope |
| Existing reused | `GovernedActionIntent`, `MonetaryAmount`, asset registry, classifier, `idempotencyKey`, P10 ceilings |
| Remaining work | Payee/instrument reference, rail preference, expiry, purpose/memo. Structured asset namespace/issuer parsing kept in PAY (L-8). The mapping to envelope parameters |
| Exit criteria | A payment intent governs through the unchanged spine. No new CORE field. Structural tests forbid PAY imports in CORE |
| Non-goals | Protocol parsing (PAY-02), rails (PAY-03/04) |

**PAY-02: Payment Protocol Adapter Boundary + MPP**

| Field | Content |
|---|---|
| Status | PLANNED (PARTIAL: unmerged P13 branch) |
| Depends on | PAY-01 (hard) |
| Purpose | Normalize protocol challenges (MPP first) into `PaymentIntent` |
| Existing reused | P13 branch `24dd264`: MPP parser, business-operation idempotency store, 7 test files. It must be **rebased, not merged as-is** |
| Remaining work | A protocol-neutral challenge → intent port. Reserved keys supplied through the CORE-03 registry (L-7). Business-operation vs request idempotency reconciliation. Conflict resolution against current `main` |
| Exit criteria | An MPP challenge produces a governed payment intent. No `mpp*` symbol exists in CORE |
| Non-goals | x402 (PAY-08), credentials, rails |

**PAY-03: Settlement Rail Boundary & Execution Credential Boundary**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-01 (hard), CORE-02 (soft: reuse the external-signer pattern) |
| Purpose | Define the rail adapter port (destination, fees, finality, provider-certainty mapping, resolution authority) and how transaction credentials are held **without** Frontera holding customer keys (Security Prompt 20) |
| Existing reused | `ExecutionAdapter` port, registry routing, `executionId` as provider idempotency handle, P11 certainty, P12 `ExecutionResolutionAuthority` port |
| Remaining work | The rail port. A customer-controlled transaction-signer port. A per-rail resolution authority contract. A rail conformance suite (modelled on `provider-conformance-suite`) |
| Exit criteria | A fake rail passes the conformance suite. No rail symbol exists in CORE |
| Non-goals | Any real rail |

**PAY-04: XRPL Rail Adapter**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-03 |
| Remaining work | XRPL client in an adapter package. Payment submission via the external transaction signer. Tx-hash resolution authority (P12). Finality mapping to P11 certainty. Issued-asset registry entries (e.g. RLUSD) as configuration |
| Exit criteria | Testnet payment governed end to end, including an unconfirmed → resolved path |
| Non-goals | AMM, DEX, escrow, XLS-65/66 (CREDIT) |

**PAY-05: Settlement, Receipt & Payment Obligation Semantics**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-04, CORE-04 |
| Purpose | Former P15: receipts, a settlement state machine, finality, refunds, payment obligations discharged through CORE-04 obligations |
| Exit criteria | "settled" means funds finality with evidence, distinct from P7 capacity settlement |

**PAY-06: Lightning Rail Adapter**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-03 (hard), PAY-05 (soft) |
| Purpose | The second, structurally different rail (§ below) |
| Remaining work | bolt11 decode, node integration via an adapter, preimage as settlement evidence, routing-fee bounds, HTLC-timeout → P11 certainty |
| Exit criteria | The same CORE, unchanged, governs Lightning |

**PAY-07: Multi-Rail Qualification**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-04, PAY-06, ASSURE-01 |
| Exit criteria | §11.2 |

**PAY-08: x402 Protocol Adapter**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PAY-02 |
| Note | Parallelizable with PAY-04/06 |

**PAY-09: Stripe / fiat rail**

| Field | Content |
|---|---|
| Status | DEFERRED |
| Note | Former P14 Stripe half. Not needed for CORE PROVEN |

**Lightning as second-rail qualification (HYPOTHESIS, evaluated).** It is a
sound qualification target. XRPL and Lightning differ on precisely the axes
that would expose rail-specific authority logic:

| Axis | XRPL | Lightning |
|---|---|---|
| Payment model | Account-based | Invoice-based |
| Proof of payment | Ledger transaction hash | Preimage |
| Finality | Deterministic ledger close | HTLC settlement with routing |
| Fees | Fixed fees | Routing fees |
| Counterparty identity | Destination address | Invoice payee |
| Asset | Issued assets | BTC only |

If P10 ceilings, P11 certainty and P12 resolution govern both unchanged, neutrality is
demonstrated. Prerequisites: PAY-01 and PAY-03 (so neither adapter shapes the
port), and P11 certainty mapping for in-flight HTLCs. A second
*account-based* rail (EVM, Stellar) would prove less.

### CREDIT

**CREDIT-01: Credit Domain Model & Canonical Credit Intent**

| Field | Content |
|---|---|
| Status | PLANNED (design may start after CORE-03) |
| Depends on | CORE-03 (hard), CORE-04 (soft) |
| Purpose | A credit-specific intent that compiles to the same envelope. Decide reuse of collateralization mandates and `governed-authority` encumbrances (§7, two authority worlds) |
| Existing reused | Envelope; `MonetaryAmount`; P7 ledger; `EnterpriseCollateralizationTerms`; `governed-authority` positions/encumbrances; Capital Discovery boundary (FR-REC-01/02) as an integration pattern |
| Exit criteria | A credit intent governs through the unchanged spine. No credit term exists in CORE. Collateral money is reconciled to `MonetaryAmount` |
| Non-goals | Evernorth-named primitives (forbidden, §13) |

**CREDIT-02: Exposure, Concentration & Collateral Controls**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-01, CORE-04 (trusted valuation inputs) |
| Purpose | Credit-side aggregate controls, built on generalized P7 bound kinds from CORE-03 |

**CREDIT-03: Credit Execution Adapter Boundary**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-01, PAY-03 (soft: shares the rail / transaction-signer pattern) |

**CREDIT-04: XLS-65 Vault Adapter**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-03, PAY-04 (soft: shared XRPL client) |

**CREDIT-05: XLS-66 Loan Adapter + Repayment Obligations**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-04, CORE-04 (obligations), PAY-05 (soft: receipts) |

**CREDIT-06: Governed Reverse Carry Reference Workflow**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-05, CREDIT-02 |
| Note | A **use case**, not a primitive |

**CREDIT-07: Credit Assurance & Qualification**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CREDIT-06, ASSURE-01 |
| Exit criteria | §11.4 |

**Payment vs credit (DECISION).** They share enough to use the **one existing
envelope**: principal, authority, grant, ceilings, exercise controls, claim,
outcome, evidence. They do **not** share an intent model. Payment is a
single-shot transfer with settlement finality. Credit is a long-lived position
with exposure, collateral, a repayment schedule and default states. Credit needs
CORE obligations and generalized bound kinds, not payment fields.

### ASSURE

**ASSURE-01: Unified Authority-to-Outcome Trace**

| Field | Content |
|---|---|
| Status | PLANNED (PARTIAL: P8 stream) |
| Depends on | CORE-01 (soft) |
| Purpose | Expose and verify the per-request trace. Include grant, outcome and resolution in evidence bundles. Make the bundle store durable |
| Exit criteria | A third party can fetch and verify one request's full trace via API |
| Parallel | Yes, alongside CORE-03/04 |

**ASSURE-02: Evidence Authenticity & Canonicalization Convergence**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-02 |
| Purpose | Sign the stream, bundles, Kernel-Authority records and ledgers. Converge the 9+ canonicalizers |

**ASSURE-03: Portable Assurance Package**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | ASSURE-02 |

**ASSURE-04: Behavioural Evidence Substrate** (re-scoped by MASTER-01; formerly "Behavioural Risk Intelligence")

| Field | Content |
|---|---|
| Status | PLANNED (was DEFERRED) |
| Depends on | ASSURE-01 (hard) |
| Purpose | Former P21 / Prompt 13, evidence half. A trustworthy, verifiable, queryable behavioural history for INTEL-05 to analyse: governed actions, decisions and denials, outcomes, actors, actions, resources, destinations, amounts, timing, failed attempts and sequences, derived from the P8 stream and P11/P12 records with integrity (and, after ASSURE-02, authenticity) preserved |
| Exit criteria | For any actor, action class or resource class, the history over a time window can be read and verified back to canonical records; a RiskSignal's `supportingEvidenceRefs` can be resolved and verified against it |
| Non-goals | Detection, baselines, anomaly analysis or RiskSignal generation (INTEL-05); any effect on authority |
| Ownership boundary | **ASSURE owns** trustworthy evidence, historical trace and verifiable source material. **INTEL owns** analysis of it and emits candidate observations/RiskSignals. INTEL never becomes the evidence store; ASSURE never analyses or signals |

### INTEL

**DECISION (MASTER-01).** The INTEL track implements the Frontera Agent (§4.4).
Every INTEL item shares these non-goals: no authorization decision, no grant
minting, no authority expansion, no execution, no approval on a human's behalf,
no policy rewriting, no model or AI SDK anywhere in CORE, and no INTEL
dependency for CORE correctness. The items are **not** a strict chain; see §10.
No INTEL item is required for PILOT READY (§11.3).

**INTEL-01: Action & Resource Interpretation**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-03 (hard: the target it interprets into — actor, action class, resource class, typed parameters) |
| Purpose | Translate natural-language or machine intent into **candidate** structured GovernedAction information: actor, action, resource, target, purpose, parameters, references. "Pay invoice 8819" → candidate `{action: transfer, resource: <asset>, target: <payee>, purpose: invoice 8819, …}` |
| Verification | Interpretation represents at least three materially different action/resource domains (e.g. transfer, deploy, read/export data). Output is typed as candidate/untrusted and can enter the envelope only through the same validation any caller's intent passes (no privileged path). A test proves interpretation alone never authorizes, mints authority or executes: removing it changes no decision for an identical validated envelope |
| Non-goals | Authority; filling trusted-context keys; profile resolution (INTEL-02); a model-provider abstraction beyond what this item needs (§16) |

**INTEL-02: Governance Profile Resolution**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-03 (hard: profile schema); INTEL-01 (soft: an already-structured machine intent needs no interpretation) |
| Purpose | Given actor × action × resource, determine which Governance Profile applies and return its required facts, evidence, relevant policies, potential approvals and applicable constraints. Deterministic lookup where the classification is exact; AI may *propose* a profile where it is ambiguous |
| Verification | Declarative profiles determine required material facts with no executable code and no AI-created binding policy. Every resolution records profile id, version, owner and provenance. A test proves a wrong or absent profile selection cannot reduce the facts the Kernel's policy requires (§4.3) |
| Non-goals | Authoring or activating profiles (organizations/domain packs, human promotion); inventing policy |

**INTEL-03: Context Question Planner**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | INTEL-02 (hard); CORE-04 (soft: reads `unresolved` / `stale` / `conflicted` resolutions to know what is still open) |
| Purpose | Given action, resource, profile and known context, identify which material facts remain unresolved and turn each into a bounded question or retrieval task: "Does invoice 8819 exist?", "Does the amount match?", "Has this destination been used before?", "Is the deployment inside the approved change window?", "Is rollback available?", "Is this actor normally permitted this class of action?" |
| Verification | Every unresolved material fact becomes a bounded, explainable, traceable question or retrieval task linked to the profile fact it serves. The planner has no decision output; a structural test proves it cannot reach the Kernel or the grant path |
| Non-goals | Answering the questions (INTEL-04, humans); deciding authority; asking humans what a machine source can answer |

**INTEL-04: Context Resolution & Provenance**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-04 (hard: the admission boundary and source registry); INTEL-02 (hard: what to fetch); INTEL-03 (soft) |
| Purpose | **Machine-speed due diligence.** Before asking a human, resolve material facts from authorized machine sources (ERP, CRM, LDR, internal APIs, registries, blockchains, the evidence stream, operational systems): required fact → machine source available? → retrieve, else unresolved / human path. Every observation carries value, source, timestamp, provenance, fact type, confidence and correlation |
| Verification | Context is retrieved only through bounded, least-privilege, read-only tools whose permissions are separate from any execution authority (invariant 30). Source identity and provenance are retained on every observation. Facts affect authority only after CORE-04 admission; a test proves an un-admitted observation never reaches policy |
| Non-goals | Deciding a source is trustworthy (CORE-04); write access to any source; claiming all due diligence is automatable |

**INTEL-05: Behavioural Intelligence & RiskSignal Generation**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | ASSURE-04 (hard: behavioural evidence substrate); CORE-04 (hard: the RiskSignal contract a candidate must conform to) |
| Purpose | Former P21 / Prompt 13, analysis half. Analyse governed actions, outcomes, denials, actors, resources, destinations, amounts, timing, frequency, sequences, failed attempts, prior relationships and baselines, and emit **candidate** RiskSignals: novel destination, velocity anomaly, near-ceiling repetition, threshold circumvention, unusual time/resource/action, repeated-denial probing, behavioural deviation, unexpected sequence, correlated actions. Detectors may be rules, statistics or models |
| Verification | Every observation is derived from ASSURE-04 evidence/history, and every candidate RiskSignal carries resolvable `supportingEvidenceRefs` and producer provenance. No direct authority decision occurs: a test proves candidate signals cannot reach policy |
| Non-goals | Admission (CORE-04); containment (INTEL-06); storing canonical evidence (ASSURE); autonomous policy change |

**INTEL-06: Adaptive Authority Containment**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | INTEL-05 (hard); CORE-04 (hard: admission, restrict-only signal rule); CORE-05 (hard: durable approvals as an effect); CORE-03 (hard: attributable policy-pack writes, NB-008 — containment rules are organization policy); CORE-01 revocation and P4 emergency control (VERIFIED); CTRL-04 (soft: the human side of an approval requirement); CTRL-02 (soft: an organizational identity for policy-driven revocation, §16) |
| Purpose | Let admitted RiskSignals cause deterministic organization policy to apply more restrictive controls: added obligation, shorter grant lifetime, lower ceiling, approval requirement, suspension, revocation, emergency stop (§4.4.5). Any generic restrict-only policy effect not yet in CORE is added in CORE under CORE's rules (generic name, non-intelligence test), not in INTEL |
| Verification | Admitted signals trigger deterministic restrictive responses through existing authority mechanisms only. The monotonicity property (§4.4.6) is a test across the reference domains: removing all producers yields the baseline; any signal set yields equal or more restrictive decisions. A policy rule using a signal key to widen, allow or lengthen is refused at validation. AI cannot independently expand authority under any tested configuration. The superseding ADR for ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY hard invariants 4/7 and §7 is accepted |
| Non-goals | Expanding authority; AI-performed transitions; learned thresholds becoming policy; alerts delivery (CTRL-05) |

### CTRL

**CTRL-01: Authority Administration API**

| Field | Content |
|---|---|
| Status | **VERIFIED** (2026-09-26, branch `feat/ctrl-01-authority-admin-api`) |
| Depends on | CORE-01 (hard) — VERIFIED, PROD-01 (soft) — VERIFIED |
| Purpose | HTTP surfaces for what was in-process only: authority revocation, emergency control, grant/authority reads |
| Exit criteria (as delivered) | No pilot **incident-response** operation — inspecting authority, revoking it, stopping and resuming execution — requires source code, a REPL or direct DB access. The original criterion ("no pilot operation") also covered provisioning, which is re-scoped to CTRL-02 (below) |
| Delivered | `/api/admin/...` on the canonical Host (`bootEnterpriseHost()`; no second server): `GET /authority/grants/{id}`, `POST /authority/grants/{id}/revoke` (CORE-01 signed path via `revokeGrant`), `GET /authority/executions/{id}` (execution → grant, from P11), `GET /authority/entities/{kind}/{id}`, `POST /authority/entities/{kind}/{id}/revoke` (`kernelAuthorityProvisioning.revoke`), `GET /emergency-controls`, `POST /emergency-controls/{activate,release}` (P4 port). **Administrative authorization boundary:** a separate administrator credential class declared in the governed-action file (`administrators[] {operatorId, apiKeyEnv}`, secret ≥ 32 chars, unique across every credential, `HOST_ADMINISTRATOR_INVALID`), never merged into ordinary API keys; ordinary keys → 403, unknown → 401, the body read only after authorization. Operator identity (`operator:<operatorId>`) from configuration is what every store records (signed `issuerRef`, `provisionedBy`, emergency `issuer_ref`). Closed request schemas; single-organization scope fixed server-side. Status is the grant runtime's own `assessGrantExercise`; unverifiable state → `500 AUTHORITY_STATE_INTEGRITY_FAILED`, never 404/active. Optional: absent `administrators`, nothing is mounted; `/health` `posture.authorityAdministration` = `enabled`/`not-configured`. **Issuance intentionally not exposed** (grants are minted only from a committed Kernel decision). **Emergency control included** (mature durable port with a legitimate release). No un-revoke path exists. Docs: `AOC_AUTHORITY_ADMINISTRATION_API.md` (reference, threat review, runbook) |
| Evidence | `authority-administration-api.test.ts` (27, real Host through `bootEnterpriseHost()`): reproduction (no administrator → no route, posture `not-configured`), 10 configuration refusals, authorization matrix (none/unknown/default-looking/truncated/non-Bearer → 401; customer and legacy keys → 403 on all eight routes; forged `X-Admin`/`?admin=true`/body flags ignored or refused; an administrator secret is 401 on customer and legacy routes), forged actor refused and the signed `issuerRef` = configured operator, single-organization scope, CORE-01 signed revocation + commitment advance + P8 `grant.revoked` + the real ACE exercise withheld with 0 adapter calls, idempotent repeat, 24-way concurrent revocation of two grants (exactly one commit each, verifies across restart), no un-revoke (17 method/path shapes → 404), input validation, fail-closed integrity (deleted revocation, tampered grant, tampered Kernel-Authority event → 500, never 404), emergency stop/release across restart with the operator in the store history, and the operator flow: inspect → revoke → inspect → governed action `denied`, adapter calls 0 → restart → still revoked and denied. `authority-administration-service.test.ts` (37): status from `assessGrantExercise` under a fixed clock (expiry without sleeps), integrity/unavailable mapping, body read only after authorization, closed schemas (15 smuggled fields), structural no-bypass (no driver/SQL/signer/issuance/provisioning/body spread; exact service surface; adapter verbs). Eleven deliberate-violation experiments (ordinary key as admin, customer principals as admins, closed schema removed, client `issuerRef` honoured, revocation faked without the store, integrity collapsed to 404, HTTP status ignoring revocation, `DELETE` routed, body read before auth, secret-strength check removed, unscoped Kernel-Authority reads) each failed focused tests (1–24 each); sources restored byte-for-byte. Three pre-existing structural pins that forbade any emergency/P11-reading HTTP surface were narrowed deliberately to their intent (no customer route reaches emergency control; admin routes only via the administration service), and the eight routes are registered in `release/api-surface.v1.json` (28 → 36; `check-api-freeze` green). Final run: typecheck, lint, build green; root 7592/7594 pass, 1 skipped (live Pinata, unconfigured), 1 failing — the known CRLF working-copy artifact in `structural-boundaries.test.ts` (64/64 against a `git archive` export of the LF tree); workspaces 1069/1069 |
| Re-scoped | **Kernel-Authority provisioning over an API → CTRL-02.** Provisioning creates standing organizational authority (actors, trust domains, root issuers, grants, delegations). Exposing it behind a single shared administrator secret with no human operator identity would let one stolen bearer secret mint authority; CTRL-02 introduces human operator identity and the agent inventory that provisioning belongs to |
| Residual (owned elsewhere) | Administrator credential theft = administrator (no MFA/SSO/quorum: CTRL-02, CTRL-04, PROD-04); no rate limiting (PROD-04); P8 `grant.revoked` carries no actor and Kernel-Authority/emergency mutations are not on the P8 stream (ASSURE-01); signer on the revocation critical path (AA-004, CORE-02); whole-store rollback (CORE-07); provisioning in-process (CTRL-02) |
| Parallel | Yes, with CORE-03/04 |

**CTRL-02: Organizations, Human Operators & Agent Inventory**

| Field | Content |
|---|---|
| Status | PLANNED (unblocked; the recommended parallel stream, §14) |
| Depends on | CTRL-01 — VERIFIED; CORE-03 (soft, MASTER-01: authority-grant provisioning schemas enter the frozen v1 API surface, and should expose CORE-03's generalized bounds rather than today's money-typed `spending_limit` (L-5)) |
| Existing reused | passport-web account/role model as reference; `BoundCustomerIdentity`; the CTRL-01 administration boundary (`authority-administration/`) and `kernelAuthorityProvisioning` |
| Remaining work | Human operator identity + roles in the enterprise runtime, replacing CTRL-01's shared administrator secrets as the operator identity. An agent inventory backed by Kernel-Authority actors. **Kernel-Authority provisioning over the API** (actors, passports, capability tokens, authority grants, delegations — moved here from CTRL-01), authorized by operator role, under the Kernel's existing append rules (terminal revocation, no in-place rewrite) and monetary checks. A passport reconciliation decision (§7) |
| Exit criteria | A pilot organization onboards an agent and assigns it bounded authority without source code, a REPL or direct DB access, as an identified human operator |

**CTRL-03: Web Control Plane MVP**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CTRL-02, ASSURE-01 (soft) |
| Scope | Agents, authorities, limits, activity, evidence. Reuse `src/features/aoc-control-plane` panels if they fit |
| Note | **Does not require any PAY work** |

**CTRL-04: Approval & Escalation Workflow (human side)**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-05, CTRL-03 |

**CTRL-05: Alerts & Notifications**

| Field | Content |
|---|---|
| Status | DEFERRED |

**CTRL-06: Mobile MVP**

| Field | Content |
|---|---|
| Status | DEFERRED |

**CTRL-07: Mobile Trust Boundary / Biometric Approval**

| Field | Content |
|---|---|
| Status | DEFERRED |

**CTRL and INTEL (MASTER-01, PLAN).** Future control-plane surfaces may need to
show unresolved context, required facts, open questions, source provenance,
RiskSignals with their supporting evidence, review requirements, alerts,
containment state and human approvals. These attach to CTRL-03 (display),
CTRL-04 (approval and review) and CTRL-05 (alerts) when the corresponding INTEL
items exist; no CTRL item gains an INTEL dependency for the pilot. A surface
displays; it never decides. **CTRL-01 is unchanged and remains VERIFIED as
delivered**, including its decision not to expose provisioning behind a shared
administrator secret. CTRL-02's scope (human operators, organizations, agent
inventory, provisioning) is unchanged.

### PROD

**PROD-01: Production Host Composition & Secure Defaults**

| Field | Content |
|---|---|
| Status | **VERIFIED** (2026-09-25, branch `feat/prod-01-secure-production-host`) |
| Depends on | CORE-01 (hard) — VERIFIED |
| Purpose | The shipped host composes the governed-action spine with durable stores, authenticity, P7, and auth on (SC-001, GS-003) |
| Exit criteria | `npm run start:enterprise`, with documented config, runs governed actions with signed grants. Insecure config refuses to boot |
| Delivered | One canonical bootstrap, `bootEnterpriseHost()` (`src/enterprise/host/`); the launcher only delegates and prints posture. Strict environment parsing (`validateEnterpriseEnvironment`) and a closed-schema governed-action file (`AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE`) whose secrets are env-var references. Secure profile (`production`/`staging`) refuses: non-`sqlite`, auth off or credential-less, no governed-action file, disabled/optional Kernel Authority, no signing key. Any profile refuses an unauthenticated non-loopback bind; default bind `127.0.0.1`. Composes existing capabilities only (customer admission, grant-aware Kernel over durable Kernel Authority, authenticated grant store, P7 + P10, durable P4, P8, P11, Generic HTTP via the trusted registry). Composition root: signing keys resolved before any store opens; atomic startup; governed spine registrable `required`; `/health` `posture`. Post-composition posture + health gate before `listen()` (a tampered revocation state refuses the start); `/ready` requires health not `unhealthy`; idempotent close. SEC-INV-126 … 128; NB-005, GS-003 closed for the shipped Host |
| Evidence | `enterprise-host.test.ts` (53) and `tests/enterprise-host-launcher.test.mjs` (4): reproduction of the pre-PROD-01 gap, end-to-end governed action over SQLite with a signed grant, denial/no-bypass, Generic HTTP reached only after authorization (no request sent), revocation (Kernel Authority and bounded grant, including a CORE-01 tamper refusing restart and failing `/ready` at runtime), restart durability, 34 configuration refusals (including invalid ports, a malformed log level and the literal pre-PROD-01 production/SQLite/auth-off/`0.0.0.0` combination), default-looking credentials (`admin`, `changeme`, …) refused with 401, atomic startup and shutdown without leaked handles. Twelve deliberate-violation experiments each failed the expected tests; one of them exposed that a launcher spawn could hang the suite, fixed by a per-spawn kill deadline. The launcher test also caught a real signal race (handlers installed after the listen banner), fixed. Final run: typecheck, lint, build green; root 7516/7518 pass, 1 skipped (live Pinata, unconfigured), 1 failing — the pre-existing CRLF working-copy artifact in `structural-boundaries.test.ts` (64/64 against a `git archive` export of the committed LF tree); workspaces 1069/1069. Re-verification (11 added host cases, each failing under a deliberate port/loopback-check breakage): root 7528/7529 pass, 1 skipped, 0 failing; workspaces 1069/1069 |
| Residual (owned elsewhere) | Provisioning, revocation and emergency stop are in-process only (CTRL-01). *(Update: revocation and emergency stop/release are exposed over the admin API by CTRL-01, VERIFIED 2026-09-26; provisioning remains in-process → CTRL-02.)* Six governed-action stores outside backup (PROD-02). Key process-resident (CORE-02). Obligations, trusted context and non-financial exercise-time lineage (CORE-04); the grant lifetime (≤ 1 h) is the bound meanwhile. Approvals withheld (CORE-05). Policy packs not wired (CORE-03 / NB-008). P12 not wired (no resolver ships). Evidence bundles in-memory (ASSURE). `createEnterprise()` stays a lenient embedding surface by design |
| Parallel | Yes, with CORE-02/03 |

**PROD-02: Complete Backup / Restore Coverage**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PROD-01 (soft) |
| Purpose | Former P17. Cover the 6 unbacked stores, plus key-material procedures |
| Exit criteria | A clean-room drill restores exercisable grants, revocations, ledgers and trace |

**PROD-03: Pilot Onboarding & Operational Qualification**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | PROD-01, PROD-02, CTRL-01 … CTRL-04, CORE-06 |
| Scope | Runbooks, provisioning path, observability minimum (former P16), security posture/shared responsibility (Prompt 21), readiness gate (Prompt 22) |

**PROD-04: Enterprise Production Hardening**

| Field | Content |
|---|---|
| Status | DEFERRED (post-pilot) |
| Scope | SSO, advanced RBAC, billing, IaC, egress allowlist (Prompt 11), rate limiting, pentest (Prompt 23), certification (Prompt 24), rename completion (TD-1), dead-package removal (TD-4), sandboxing (Prompts 7/9/16) |

---

## 10. Dependency Graph

**PLAN.** `──►` is a hard dependency. `┄┄►` is a soft dependency. `✓` = VERIFIED.
Rebuilt by MASTER-01 to include INTEL and CORE-08.

```
CORE-01✓ ──► CORE-02 ──► CORE-07
   │            └┄┄► ASSURE-02 ──► ASSURE-03
   ├──► PROD-01✓ ┄┄► PROD-02
   ├──► CTRL-01✓ ──► CTRL-02 ──► CTRL-03 ──► CTRL-04 ◄── CORE-05
   │                   ▲ ┄┄ CORE-03 (provisioning schemas)
   ├┄┄► ASSURE-01 ──► ASSURE-04
   └┄┄► CORE-03 ──► CORE-04 ┄┄► CORE-05
           │           │
           │           └───────────────────────────┐
           ├──► PAY-01 ──► PAY-02 ──► PAY-08       │
           │       └────► PAY-03 ──► PAY-04 ──► PAY-05 ◄── CORE-04
           │                 └────► PAY-06 ◄┄┄ PAY-05
           │                        PAY-04 + PAY-06 + ASSURE-01 ──► PAY-07
           └──► CREDIT-01 ──► CREDIT-02 ◄── CORE-04
                    └──► CREDIT-03 ◄┄┄ PAY-03
                             └──► CREDIT-04 ◄┄┄ PAY-04
                                     └──► CREDIT-05 ◄── CORE-04, ◄┄┄ PAY-05
                                             └──► CREDIT-06 ──► CREDIT-07 ◄── ASSURE-01

INTEL (beside CORE; CORE never depends on it):
   CORE-03 ──► INTEL-01
   CORE-03 ──► INTEL-02 ◄┄┄ INTEL-01
               INTEL-02 ──► INTEL-03 ◄┄┄ CORE-04
   CORE-04 + INTEL-02 ──► INTEL-04 ◄┄┄ INTEL-03
   ASSURE-04 + CORE-04 ──► INTEL-05
   INTEL-05 + CORE-03 + CORE-04 + CORE-05 ──► INTEL-06 ◄┄┄ CTRL-04, CTRL-02

CORE-01..05 + PROD-01 ──► CORE-06
CORE-03 + CORE-04 + CORE-05 (+┄┄ CORE-06) + one monetary execution path ──► CORE-08
PROD-01 + PROD-02 + CTRL-01..04 + CORE-06 ──► PROD-03
```

**Foundation dependencies.** CORE-03 and CORE-04 are the roots of every
remaining thesis: they gate CORE-05, PAY-01, CREDIT-01, all of INTEL, CORE-08
and (via CORE-05 → CTRL-04 and CORE-06) PILOT READY.

**Paths.**

| Path | Sequence | Ends in |
|---|---|---|
| **Critical pilot path** | CORE-03 → CORE-04 → CORE-05 → CORE-06, joined by CTRL-02 → CTRL-03 → CTRL-04 (needs CORE-05), PROD-02, ASSURE-01 → PROD-03 | PILOT READY (§11.3) |
| **Governed Action Thesis path** | CORE-03 → CORE-04 → CORE-05 → CORE-08 | GOVERNED ACTION THESIS PROVEN (§11.6) |
| **Rail-neutrality path** | CORE-03 → PAY-01 → PAY-03 → PAY-04 / PAY-06 (+ PAY-02, PAY-05, ASSURE-01) → PAY-07, on GOVERNANCE CORE STABLE | CORE PROVEN (§11.2) |
| **Intelligence path** | CORE-03 → INTEL-01 / INTEL-02 → INTEL-03; CORE-04 → INTEL-04; ASSURE-01 → ASSURE-04 → INTEL-05 → INTEL-06 | adaptive containment; not a pilot blocker |
| **Credit path** | CORE-03 → CREDIT-01 … CREDIT-07 | CREDIT THESIS PROVEN (§11.4) |

**Parallel streams** (see §12): CTRL-02 ∥ CORE-03; PROD-02 anytime; ASSURE-01 →
ASSURE-04 ∥ CORE-03/04; CORE-02 ∥ everything; after CORE-03, INTEL-01 ∥ INTEL-02
∥ PAY-01 ∥ CREDIT-01 ∥ CORE-04; after CORE-04, INTEL-04 ∥ INTEL-05 (given
ASSURE-04) ∥ CORE-05.

---

## 11. Milestones

### 11.1 GOVERNANCE CORE STABLE

**Definition.** A mature, generic authority engine, provable on the shipped host.

All of the following must be true:

1. **Revocation is tamper-evident.**
   - The un-revocation path (§3.7) is closed (CORE-01). **Done** (2026-09-25).
   - Snapshot rollback is at least *detected* (CORE-07), or formally accepted as a deployment control with a documented operational mitigation.
2. **Authority authenticity is on by default.**
   - Durable grants are signed.
   - An unsigned substitute is refused (CORE-01, PROD-01). **Done** (2026-09-25): durable grants are signed and required on the shipped secure Host.
3. **External signer boundary.** Authority keys are not required to be process-resident (CORE-02).
4. **One generic envelope.**
   - It expresses non-money parameters and non-money bounds (CORE-03).
   - No payment or credit vocabulary exists in CORE; this is enforced by structural tests.
5. **Obligations and trusted context are reachable** on the governed path (CORE-04).
6. **Lineage is revalidated at exercise** for all action classes (CORE-04).
7. **Approvals are durable and resumable** (CORE-05).
8. **The no-bypass proof is re-run** against the composed default host (CORE-06).
9. **Every "BLOCKED" security claim has a test.**
10. **CORE is independent of INTEL** (MASTER-01, invariant 32): every item above is
    demonstrated with no intelligence component present, and the Kernel-source
    intelligence-vocabulary structural test still passes.

### 11.2 CORE PROVEN

**Definition.** Frontera governs economic actions independently of payment
protocol and settlement rail. **This is rail neutrality** (§4.2): economically
equivalent actions on different rails. It does not prove action neutrality;
that is GOVERNED ACTION THESIS PROVEN (§11.6), and the two share no criteria.

Requires GOVERNANCE CORE STABLE, plus:

1. One representative flow runs end to end on **XRPL (PAY-04)** and on **Lightning (PAY-06)**:
   agent → protocol requirement (MPP) → `PaymentIntent` → governed-action envelope →
   authority/policy/ceiling → grant → rail → settlement result → evidence.
2. **CORE source is byte-identical between the two runs.** Rail-specific
   logic lives only in PAY adapters, and structural tests prove this.
3. Unconfirmed → resolved reconciliation works on both rails through P12 ports.
4. The ASSURE-01 trace verifies for both.
5. A denied, an over-ceiling and a revoked-mid-flight case each behave identically on both rails.

### 11.3 PILOT READY

**Definition.** A real organization uses Frontera without the founder operating
source code or database state.

Requires:

- **Core:** GOVERNANCE CORE STABLE items 1, 2, 4, 5, 7 and 8. Item 3 is recommended but not required when the pilot's threat model accepts it in writing.
- **Host:** PROD-01 (bootable, secure-default host) — **done** 2026-09-25 — and PROD-02 (complete backup/restore).
- **Control plane:** CTRL-01 … CTRL-04, which cover organization setup, agent registration, authority assignment, limits/policies, approvals, activity and evidence via API + web. CTRL-01 — **done** 2026-09-26 (inspect, revoke and emergency control over the API).
- **Assurance:** ASSURE-01 (trace).
- **Operations:** PROD-03 (runbooks, observability minimum, readiness gate).

**Explicitly not required:**

- mobile;
- SSO;
- billing;
- a second rail;
- credit;
- signed evidence (ASSURE-02);
- polished onboarding automation.

A pilot may govern **Generic HTTP actions only**. It does not require PAY
unless the pilot's use case is payments, in which case PAY-01 … PAY-04 are added.

**MASTER-01 re-evaluation: INTEL is not required for PILOT READY.** A valid
pilot uses deterministic policy, manually configured or source-resolved trusted
context (CORE-04) and human approvals (CORE-05, CTRL-04), with no AI. Pilot
operational readiness is distinct from the full intelligent-governance thesis;
no INTEL item blocks shipping. A pilot may *opt in* to INTEL items as they
become VERIFIED, and must then also accept their threat-model obligations
(§4.4.8). GOVERNED ACTION THESIS PROVEN is likewise not a pilot requirement.

### 11.4 CREDIT THESIS PROVEN

**Definition.** Frontera governs institutional credit without credit semantics in CORE.

Requires GOVERNANCE CORE STABLE, plus:

1. Capital source → XLS-65 vault → credit request → `CreditIntent` → governed
   envelope → bounded authority (exposure/concentration/collateral ceilings) →
   XLS-66 loan execution → repayment obligations (CORE-04 obligations) → evidence.
2. Reverse Carry (CREDIT-06) runs as a reference workflow built only from CREDIT
   and CORE, with no Reverse-Carry- or Evernorth-named primitive.
3. The CORE diff attributable to CREDIT is limited to generic mechanisms (bound
   kinds, obligation kinds, trusted-input sources) that have at least one non-credit test.
4. CREDIT-07 qualification passes.

### 11.5 Pilot vs productization

| Required before first serious pilot | Desirable for scaled enterprise product |
|---|---|
| CORE-01, 03, 04, 05, 06; PROD-01, 02, 03; CTRL-01 … 04; ASSURE-01 | CORE-02 (unless the pilot threat model requires it), CORE-07, CORE-08, ASSURE-02/03/04 |
| | INTEL-01 … INTEL-06 (governed action intelligence) |
| | SSO, advanced RBAC, billing, IaC, pentest, certification (PROD-04) |
| | Mobile (CTRL-06/07), alerts (CTRL-05) |
| | Broad multi-chain, Stripe (PAY-09), x402 (PAY-08) |

### 11.6 GOVERNED ACTION THESIS PROVEN

**Definition (MASTER-01).** Frontera's deterministic core is **action-neutral**:
Governed Actions are infrastructure, not a payment feature. Distinct from CORE
PROVEN (rail neutrality, §11.2) and non-duplicative with it. Gate: CORE-08.

Requires CORE-03, CORE-04 and CORE-05 VERIFIED, plus:

1. **At least three materially different action/resource domains** run end to
   end on the same Host. Representative (substitutable, provided semantic
   diversity is kept):
   - **Treasury:** transfer × monetary asset (e.g. XRP), exercising P9/P10
     ceilings; execution via XRPL (PAY-04) when available, otherwise any
     governed monetary adapter — rail neutrality is not what is being proven.
   - **DevOps:** deploy × production environment, via an HTTP /
     Kubernetes-like adapter, with material facts such as change window and
     rollback availability.
   - **Data:** read vs export × customer data, via an API adapter, with a
     non-monetary quantity bound (records) distinguishing the two actions.
2. **Shared, unchanged across all domains:** the GovernedAction spine, the
   Kernel implementation, authority semantics, the BoundedGrant model, the
   constraint architecture, the obligation architecture, the evidence model
   and the lifecycle (decision → grant → claim → outcome → evidence).
3. **Only these vary:** Governance Profile, context sources, organization
   policy, domain validation and Execution Adapter.
4. **No domain-specific branching in the Kernel or orchestrator**, proven by a
   structural test; CORE source is identical across the three domain runs.
5. In every domain a denial, an over-bound request, a revocation mid-flight and
   a missing required fact each behave per the shared semantics (withheld,
   denied or REVIEW by policy — never allowed by default).
6. No intelligence component is required (invariant 32). INTEL is proven
   separately by INTEL-06 verification.

---

## 12. Parallelization Opportunities

**PLAN.**

- **After CORE-01:** three streams can run in parallel: CORE-02, CORE-03 and (PROD-01 → CTRL-01 → CTRL-02). PROD-01 and CTRL-01 are done.
- **ASSURE-01** can run alongside CORE-03/04. It reads existing P8 data.
- **CTRL-01 → CTRL-03** need stable authority/control APIs only. They do **not** need any PAY work.
- **After CORE-03:**
  - PAY-01 and CREDIT-01 (design) can proceed in parallel.
  - PAY rail work (PAY-03/04/06) and CREDIT-02/03 are independent until CREDIT-04, which shares the XRPL client with PAY-04.
- **PAY-08 (x402)** is parallel to PAY-04/06.
- **PROD-02** can run any time after PROD-01.
- **MASTER-01:** CTRL-02 runs in parallel with CORE-03 (soft dependency only on
  CORE-03's bound schemas). ASSURE-01 → ASSURE-04 can run alongside CORE-03/04.
  After CORE-03, INTEL-01 and INTEL-02 can proceed in parallel with CORE-04,
  PAY-01 and CREDIT-01. INTEL-04 and INTEL-05 are independent of each other.
  No INTEL item is on the pilot critical path.

---

## 13. Explicit Non-Goals

**DECISION.**

- No `EvernorthGrant`, `EvernorthPolicy`, `EvernorthAuthority` or `EvernorthMode`, or any
  partner-named primitive. Evernorth is market context only.
- No Reverse-Carry primitive in CORE. Reverse Carry is a CREDIT use case.
- No universal `EconomicIntent` / `GovernedAction` god-object above the
  existing envelope (§4.1).
- Frontera does not become a wallet, custodian, lender, settlement network or
  payment protocol, and does not hold customer transaction keys.
- No rail or protocol SDK in CORE.
- No retry loop in the authorization path. An unconfirmed execution is never re-sent automatically.
- ~~No behavioural or AI scoring in the authorization path.~~ Replaced by
  MASTER-01 with the precise rule (invariants 24–32): AI may produce
  observations and RiskSignals; it never creates, expands or exercises
  authority, and anything AI-derived that can affect authority crosses the
  CORE-04 Trusted Context Boundary and deterministic policy, restrictively only.
- AI is not the authority decision maker; it cannot mint, expand or exercise
  authority, including by recommending execution.
- No LLM, model provider or agent framework inside the deterministic
  authorization boundary, and no AI SDK in CORE.
- CORE does not own a universal resource or action taxonomy, and does not
  become payment-specific.
- INTEL does not replace deterministic policy; evidence does not autonomously
  rewrite policy.
- Governance Profiles are not arbitrary executable code.
- LDR is not authority. Model confidence is not authority confidence.
- No IAM or authentication for target systems (TARGET architecture §10 stands).
- Mobile, SSO and billing are not pilot prerequisites.

---

## 14. Current NEXT Item

**NEXT: CORE-03 — Governed Action Semantic & Parameter Model (Actor · Action · Resource; envelope generalization)**

**Previous NEXT:** CTRL-02 (set 2026-09-26 after CTRL-01 → VERIFIED; before it
PROD-01 and CORE-01 — VERIFIED 2026-09-25). MASTER-01 recalculated NEXT on
2026-09-27 once INTEL, CORE-08 and the revised CORE-03/04 dependencies were
included. CTRL-02's purpose is unchanged; it is not NEXT.

**Candidates (unblocked):** CORE-03, CTRL-02, PROD-02, CORE-02, ASSURE-01. Every
INTEL item, CORE-04, CORE-05 and CORE-08 are blocked (directly or transitively)
by CORE-03.

**Why CORE-03:**

- **Dependency criticality.** CORE-03 is the single root of the CORE-04 → CORE-05
  chain (pilot critical path: CORE-05 gates CTRL-04 and CORE-06), of PAY-01 and
  CREDIT-01, of all six INTEL items, and of CORE-08. The CORE chain
  (CORE-03 → 04 → 05 → 06) is now the longest pole to PILOT READY; the CTRL chain
  (CTRL-02 → 03 → 04) cannot finish before CORE-05 anyway.
- **Security correctness.** CORE-03 closes NB-008 (policy-pack writes carry no
  caller identity — an open self-modification finding, Prompt 14) and the
  L-2 … L-6 leakage, and it defines the Governance Profile format as
  declarative data before any intelligence component could be tempted to
  supply executable governance.
- **Avoiding API churn.** CTRL-02 exposes Kernel-Authority provisioning,
  including authority grants, over the frozen v1 API (`release/api-surface.v1.json`).
  Today an authority grant's limit is money-typed (`spending_limit`, L-5).
  Freezing that shape into public provisioning schemas before CORE-03
  generalizes bounds would make the thesis correction a breaking API change.
- **Governed Action thesis leverage.** MASTER-01's product thesis ("not
  inherently monetary", action × resource) is false in the envelope until CORE-03
  lands. It is the first step of the thesis path and of the intelligence path.
- **Avoiding premature AI.** CORE-03 is deterministic, needs no model and makes
  INTEL-01/02 possible without letting them shape CORE.
- **Pilot leverage is preserved.** CTRL-02 remains unblocked and is the
  recommended parallel stream; PROD-02 remains independent and pilot-critical.

**Prerequisites already satisfied:** CORE-01 (soft) — VERIFIED. The envelope,
orchestrator, P9 monetary semantics, grant attenuation and host-trusted
classifier exist (§4.1).

**Out of scope for CORE-03:** `PaymentIntent` / `CreditIntent` (PAY-01,
CREDIT-01); trusted context, obligations and RiskSignal admission (CORE-04);
profile resolution and any AI component (INTEL); provisioning APIs (CTRL-02);
any change to CTRL-01.

## 15. Superseded Roadmaps / Source-of-Truth Rule

**DECISION.** This file is the only active roadmap. Specifically:

| Source | Status |
|---|---|
| `docs/architecture/TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §8 "Phase 0–12" | Historical; superseded as sequence. Its layer model (A–G) remains the architectural reference for CORE |
| `SECURITY_CONTAINMENT_BASELINE_AUDIT.md` Prompts 1–24 | Historical; findings remain valid evidence, sequencing superseded (mapping §6.2) |
| Root `PROMPT_1..5_*_RESULT.md` | Historical records; preserved for provenance |
| "Not in Pn" lists in P9–P12 ADRs (P13–P21) | Historical; mapping §6.2. ADR bodies remain authoritative for their mechanisms |
| `CURRENT_STATE_*` docs, `ADR-ACCESS-LIFECYCLE.md` phases, `docs/release/*` next-step sections, SK005 deck | Historical |
| Unmerged branch `feat/p13-mpp-business-idempotency` | Input to PAY-02; not to be merged as-is |
| `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md` hard invariants 4 and 7, §7; `ADR-AUTHORITY-CONTROL-LAYERING.md` layer G | In force. Narrowed in *direction* by MASTER-01 for restrict-only admitted RiskSignals only (§4.4.6); superseded for those clauses only when INTEL-06 lands its ADR |

**Rules:**

1. New work is identified by `CORE|PAY|CREDIT|ASSURE|INTEL|CTRL|PROD-nn` only.
2. Completing an item updates its status here in the same PR.
3. Only one item is NEXT at a time.
4. A capability is VERIFIED only when it is wired into a production composition path and tested. Docs alone never qualify.
5. When code and this document disagree about what exists, fix this document.

## 16. Open Architectural Questions

**HYPOTHESIS / PLAN (MASTER-01).** Recorded instead of guessed. Each has a
roadmap owner who must decide it before or during that item.

| # | Question | Owner |
|---|---|---|
| OQ-1 | Governance Profile schema: an extension of the policy-pack format or a separate artifact? Its field set, lifecycle states and cross-version compatibility rules | CORE-03 |
| OQ-2 | Profile versioning and activation: who may promote a profile, and how a decision records the profile version in force | CORE-03 (format), CTRL-02 (who) |
| OQ-3 | Canonical RiskSignal schema: exact fields, closed vs open type set, and whether a candidate is an `Advisory` kind (§7 duplication table says it should be) | CORE-04 (admitted contract), INTEL-05 (candidate) |
| OQ-4 | Candidate → admitted lifecycle: admission rules, the trust class an admitted signal carries (`derived` inheritance?), expiry and withdrawal of an admitted signal | CORE-04 |
| OQ-5 | Context freshness: default `maxAgeSeconds` per fact class, and behaviour when a fact goes stale between decision and exercise | CORE-04 |
| OQ-6 | Tool permission model for the Agent: how retrieval credentials are provisioned, scoped and audited separately from execution authority | INTEL-04 (with CORE-04 source registry) |
| OQ-7 | Model/provider abstraction: whether one is needed at all, and where it lives (never in CORE) | INTEL-01 |
| OQ-8 | Model provenance and multi-model provenance: how producer, model id/version, prompt/template version and inputs are recorded on an observation or signal | INTEL-05 (format), ASSURE-02 (authenticity) |
| OQ-9 | Behavioural baseline storage: derived baselines stored by INTEL or recorded as evidence by ASSURE? (Tentative: source events ASSURE-04, derived baselines INTEL-05, never authoritative) | ASSURE-04 / INTEL-05 |
| OQ-10 | Signal retention: how long candidate and admitted signals are kept, and their privacy constraints | ASSURE-04 |
| OQ-11 | False-positive handling: how an organization dismisses or suppresses a signal, and the audit trail for doing so | INTEL-06, CTRL-04 |
| OQ-12 | Human appeal / override of containment: which human authority may lift a restriction, through which durable mechanism (approval, emergency release, re-issuance) | INTEL-06, CORE-05, CTRL-04 |
| OQ-13 | The identity under which policy-driven revocation or suspension is recorded (today every revocation carries a configured operator, CTRL-01) | INTEL-06, CTRL-02 |
| OQ-14 | Whether the restrict-only rule for signal keys can be enforced purely by policy-pack validation or also needs a Kernel-side monotonicity check | CORE-04, INTEL-06 |
| OQ-15 | Physical-system actuation: what additional safety qualification a physical-systems profile family requires | Unassigned (future milestone; not claimed) |
