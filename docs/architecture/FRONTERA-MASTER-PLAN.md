# Frontera Master Architecture

- **Status:** AUTHORITATIVE. This is the single source of truth for Frontera's
  architecture baseline, roadmap and milestones.
- **Established by:** MASTER-00 (architecture reconciliation), 2026-09-25.
- **Audited against:** `main` @ `26a84be` (PR #142, the PRE-00 forward-port, merged).
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

**HYPOTHESIS (target thesis):** Frontera is a protocol-neutral and rail-neutral
**organizational authority control plane**. It answers one question:

> Does this software actor have valid authority to cause this action on behalf
> of this organization, under these policies, limits, obligations and conditions?

Frontera governs authority **before** execution. Protocols coordinate actions.
Rails execute or settle them. Evidence proves what happened. Frontera does not
own the blockchain, payment rail, wallet, payment protocol, lending protocol,
vault or settlement network.

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
- **The shipped host does not compose the spine.** `scripts/run-enterprise-host.mjs`
  calls `createEnterpriseServer()` with no options, so `npm run start:enterprise`
  runs no governed actions, no bounded-grant store and no authority
  authenticity. The spine is reachable only by an embedding host that composes it in-process.
- **The README positioning is stale.** It still describes "Soberanía Enterprise … built on
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
23. Frontera should eventually answer: **WHO** attempted **WHAT**, on behalf of
    **WHICH ORGANIZATION**, under **WHOSE AUTHORITY**, subject to **WHICH POLICY**,
    within **WHICH LIMITS**, producing **WHICH OBLIGATIONS**, causing **WHICH
    ECONOMIC ACTION**, through **WHICH EXECUTION MECHANISM**, producing **WHICH
    RESULT**, proven by **WHICH EVIDENCE**.

**FACT: current coverage of invariant 23.**

| Question | Status | Where it is answered |
|---|---|---|
| WHO / ORGANIZATION | Answered | Customer principal binding (P2) |
| WHOSE AUTHORITY | Partly answered | Kernel-Authority world + Authority Graph. Lineage is re-checked at exercise only for financial actions |
| POLICY | Answered only if the host injects a policy pack | — |
| LIMITS | Answered only if P7 is composed | P7 / P10 |
| OBLIGATIONS | **Not answered** on the governed path | — |
| ECONOMIC ACTION | Partly answered | Intent + monetary amount |
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

"Opt-in" matters. The default configuration is `persistence.provider = 'memory'`
(`src/enterprise/configuration/enterprise-configuration.ts:343`), and the shipped
host composes none of the governed-action spine.

### 3.1 CORE — authority and governance

| Capability | Status | Evidence |
|---|---|---|
| Customer principal binding (API key → principal → subject → Kernel-Authority actor) | VERIFIED (opt-in) | `src/enterprise/customer-identity/admission-service.ts:124-147`; `customer-identity-admission*.test.ts` |
| Kernel decision + Governance Store commit/re-read | VERIFIED | `src/kernel/AocKernel.ts`; `governed-action/decision-commit.ts` |
| Durable Kernel-Authority world (actors, capabilities, delegations, constraints) | VERIFIED | `src/enterprise/kernel-authority/*`; `kernel-authority-*.test.ts` |
| Bounded grants (attenuation-only) | VERIFIED | `src/features/grant-runtime/domain/grant-attenuation.ts:162`; `grant-attenuation.test.ts`, `bounded-grant-scenario.test.ts` |
| Durable grant store with digests (Prompt 4) | VERIFIED (sqlite only) | `src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts`; `bounded-grant-store-durability.test.ts` |
| Grant expiry (checked at exercise, never scheduled) | VERIFIED | `governed-action/orchestrator.ts:547` |
| Revocation (durable, signed) | **PARTIAL** | `execution-governance/service.ts:202`. In-process only, with no API. Un-revocation hole: §3.7 |
| **Authority artifact authenticity (PRE-00)** | **PARTIAL** | §3.7 |
| No-bypass execution (single adapter call site) | VERIFIED, path-local | `no-bypass-effect-paths.test.ts`, `security-invariants.test.ts`. 3 of 46 effect paths are grant-controlled; the rest are excepted or separate models (`docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`) |
| Emergency control / kill switch (P4) | VERIFIED (opt-in) | `composition-root.ts:1326-1336`; `emergency-control-*.test.ts`. Operator surface is in-process only |
| Aggregate / velocity / reservation controls (P7) | VERIFIED (opt-in) | `composition-root.ts:1266-1278`; `exercise-control-*.test.ts`. Without P7, grants are exercisable without count limit, and financial actions are always withheld |
| Authority-sourced payment ceilings (P10) | VERIFIED (requires P7) | `kernel-authority/monetary-constraints.ts:75-91`; `authority-payment-ceilings*.test.ts` |
| Policy packs / domain packs / jurisdiction | **PARTIAL** | Only through a host-injected `policyPackProvider` (`composition-root.ts:1245`). No durable policy store, no default pack, unauthenticated registry writes (NB-008) |
| Delegation lineage | **PARTIAL** | Enforced at decision when the actor is an agent. Re-resolved at issue, commit and exercise **only for financial actions** (`kernel-authority/financial-authority-resolver.ts`). Non-financial revalidation is a host callback |
| Obligation lifecycle (discharge/verify/waive) | **LIBRARY-ONLY** | `src/features/obligation-runtime` is tested. The governed-action Kernel is built with `grants` only (`composition-root.ts:1370-1376`), and a host Kernel is refused (`:1113`), so obligations **cannot reach** governed actions |
| Trusted context provenance (layer C) | **LIBRARY-ONLY** | `src/features/context-resolution-runtime` is tested. It is not composed; `assertedContext` reaches the Kernel as caller claims |
| Risk signals | ABSENT | Boundary tests ban `riskScore`/`anomal` from the authorization path by design |
| Approvals | **PARTIAL** | `approval_required` always ends `withheld:'approval'` (`orchestrator.ts:593`). The approval store is in-memory. There is no way to present an approval proof on the governed path |
| Escalation | LIBRARY-ONLY | `approval-runtime.ts:203` (domain code only) |
| Holder-bound representative / right-scoped Governed Authority | LIBRARY-ONLY | Kernel providers exist (`AocKernel.ts:70-101`); no enterprise wiring |
| Deterministic AI boundary | PARTIAL | Lexical negative test only; the ADR is architecture-only |
| Legacy `src/runtime/authorization` (protocol capability tokens) | SUPERSEDED | Serves the SDK host only |
| Kernel `emergencyDeny` | SUPERSEDED | Replaced by P4 durable emergency control |

### 3.2 Governed action and execution

| Capability | Status | Evidence |
|---|---|---|
| `POST /api/governed-actions` + SDK 1.1 (P5) | VERIFIED (opt-in) | `adapters/node-http-adapter.ts:168`; `governed-action-api-endpoint.test.ts` |
| Orchestrator gate order (P3) | VERIFIED | `orchestrator.ts:555-741`; `governed-action-orchestrator.test.ts` (75 tests) |
| Adapter registry + routing (P4) | VERIFIED | `execution-adapter-registry.ts` |
| Generic HTTP adapter (P6, Stage A) | VERIFIED | `execution-adapters/generic-http/`; 109 tests. One attempt, SSRF-hardened, static in-process credential |
| Server-derived identities (`requestId = H(org, principal, idempotencyKey)`, `executionId = H(requestId, decisionId)`) | VERIFIED | `governed-action/identifiers.ts:25,42` |
| Write-ahead claim, at most once | VERIFIED | `execution-ledger.ts:295-313` |
| Durable outcomes with provider certainty (P11) | VERIFIED (opt-in) | `execution-outcome-store/*`; `durable-monetary-outcomes*.test.ts` |
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
| Enterprise API | Health, evaluate, governed-actions, governance reads, evidence, assurance, passports. **No** routes for grants, revocation, approvals, emergency control, authority provisioning, organizations, users or the event stream |
| Authentication | Static bearer API keys, optionally org-scoped. Auth is **off by default** (SC-001). No humans, RBAC or SSO in the enterprise runtime |
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

**FACT: what is not delivered**

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
2. **Not wired by default.**
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

## 4. Architecture Layers

**FACT (as built):**

```
                  apps/agent-passport-web  (separate product: own DB, HMAC passports, Stripe billing)

  Embedding host (in-process composition)  ── HTTP: node:http, static API keys, auth off by default
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
                    │ bounded grants · revocation    │  exists; revocation hole
                    │ policy · ceilings · controls   │  exists (opt-in)
                    │ obligations · trusted context  │  library-only → CORE-03/04
                    │ approvals (engine side)        │  partial → CORE-05
                    │ authenticity · signer boundary │  partial → CORE-01/02
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

---

## 5. Track Model

**DECISION.** Future work uses only these six prefixes. Global `P`, `Prompt`,
`Phase`, `R`, `SK`, `FR-REC`, `Slice`, `Sprint` and `MPP-xx` numbering is retired
as a roadmap mechanism (§15).

| Track | Owns | May depend on | Must not |
|---|---|---|---|
| **CORE** | Principals, authority world, provenance/delegation, grants, revocation, policy evaluation, ceilings/exercise controls, obligations, trusted inputs/risk inputs, approvals (engine side), authenticity, signer/key-trust boundaries, the governed-action envelope | — | Import or name any payment protocol, rail, credit mechanism, wallet, custodian or KMS vendor |
| **PAY** | Payment intent, protocol adapters (MPP, x402), rail adapters (XRPL, Lightning, …), payment credentials, receipts, settlement, payment outcomes | CORE | Add payment vocabulary to CORE types |
| **CREDIT** | Credit intent, borrower context, exposure/concentration/collateral, loan authorization, repayment obligations, credit adapters (XLS-65/66), Reverse Carry | CORE; PAY only for shared rail clients | Add credit vocabulary to CORE types |
| **ASSURE** | End-to-end trace, evidence authenticity, settlement evidence, portable assurance, qualification suites | CORE, PAY, CREDIT (read-only) | Become an authority source (invariant 13) |
| **CTRL** | Organizations, humans, agents inventory, authority administration, approvals UX, API, web, mobile, alerts | CORE, ASSURE | Become a decision path (a UI never decides) |
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
| Prompt 5 / PRE-00: Authority artifact authenticity | CORE | PARTIAL | Un-revocation hole; not default-wired → CORE-01 |
| Prompt 6: KMS/HSM for signing secrets | CORE | PLANNED | → CORE-02 |
| Prompt 7 / 9 / 16: Sandbox, secretless, escape model | PROD | DEFERRED | No agent-execution process exists |
| Prompt 8: Workload identity | PROD | DEFERRED | Deployment guidance only |
| Prompt 10: FS/process/network constraints | CORE | PARTIAL | Boundary tests exist; extend as layers are added |
| Prompt 11: Egress allowlisting | PROD | PLANNED | → PROD-04 |
| Prompt 12: Kill switch | CORE | VERIFIED (opt-in) | Delivered by P4 emergency control; operator API → CTRL-01 |
| Prompt 13 / P21: Behavioural abuse detection / intelligence | ASSURE | DEFERRED | → ASSURE-04; must stay outside the authorization path |
| Prompt 14: Self-modification protection | CORE | PARTIAL | Policy-pack writes carry no caller identity (NB-008) → CORE-03 |
| Prompt 15: Tamper-evident evidence | ASSURE | PARTIAL | Integrity yes, authenticity no → ASSURE-02 |
| Prompt 17 / P17: Deployment topology / store-set durability | PROD | PLANNED | → PROD-01, PROD-02 |
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
| TD-1 | Rename incomplete. README body and CHANGELOG header say "Soberanía Enterprise". `@aoc-enterprise/*`, `AocKernel`, `AOC_ENTERPRISE_*` and `docs/enterprise/AOC_*.md` remain (compatibility namespaces are intentional, per README) | PROD |
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

### CORE

**CORE-01: Revocation State Integrity & Durable Authenticity Enforcement**

| Field | Content |
|---|---|
| Status | **NEXT** |
| Depends on | PRE-00 (merged) |
| Purpose | Make invariant 4 true for the signed store, and stop the authenticity guarantee from being silently absent |
| Existing reused | `authority-authenticity/*` (signer, verifier, domain tags, closed registry); `sqlite-bounded-grant-store.ts` read path; the three existing authenticity suites |
| Remaining work | (a) **Close the un-revocation path.** Make the grant↔revocation linkage authenticated, e.g. a signed revocation-state commitment or signed append-only revocation log, so deleting the revocation row *and* clearing the pointer is detected. (b) **Refuse a host-injected unsigned `grantStore`** when the persistence provider is durable, or require an explicit, audited acknowledgement. (c) Add tests for key-mismatch, active-key-not-trusted and malformed verification-key JSON. (d) Correct `AUTHORITY_ARTIFACT_AUTHENTICITY.md` threat M and GS-001, and the corresponding invariants text |
| Exit criteria | A test that deletes the revocation row **and** nulls the pointer fails closed. A test proves a durable deployment cannot run with an unsigned grant store without explicit opt-out. All composition fail-closed branches are tested. Docs make no BLOCKED claim that a test does not prove. Full suite green |
| Non-goals | KMS/HSM (CORE-02); rollback/freshness against whole-snapshot restore (CORE-07); signing other stores (ASSURE-02); changing the shipped host defaults (PROD-01) |

**CORE-02: External Signer & Key Custody Boundary**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-01 (hard: the revocation-state commitment format must be settled before its signer moves out of process) |
| Purpose | Remove AA-001 (a process-resident key can mint authority) and design around AA-004 (signer availability on revocation) |
| Existing reused | `AuthorityArtifactSigner` is already async and narrow (`signGrant`/`signRevocation`, no generic byte signing). Configuration redaction exists |
| Remaining work | A vendor-neutral external signer port (the adapter lives outside CORE). Key-id / algorithm negotiation (AA-006). Signer-outage semantics for revocation (AA-004). Cost/rate semantics (AA-005). A reference adapter against a local HSM emulator or a generic KMS API. Trusted-key configuration integrity (AA-002, narrowed). A decision on the Agent Passport HMAC signer (TD-5) |
| Exit criteria | No production composition holds an authority private key in process memory when an external signer is configured. Refusal paths are tested. CORE imports no KMS vendor SDK |
| Non-goals | Customer transaction-signing keys for rails (PAY-03); signing evidence (ASSURE-02); a PKI |

**CORE-03: Governed Action Parameter Model (envelope generalization)**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-01 (soft) |
| Purpose | Keep **one** generic governed-action envelope, and make it express non-payment parameters without coercing everything into `amount`/`counterparty` |
| Existing reused | `GovernedActionIntent`, the orchestrator, P9 `MonetaryAmount`, the host-trusted classifier, grant attenuation |
| Remaining work | Typed, host-declared action parameter dimensions (quantity, party, reference, duration), with attenuation rules per dimension, so a `GrantBoundKey` is no longer a closed money list (L-2 to L-6). Unify `currency`/`unit` naming. Move reserved context keys to a registry that verticals extend (prerequisite for L-7). Give policy-pack writes a caller identity (NB-008) |
| Exit criteria | A non-financial action with a structured parameter, and a quantity bound that is not money, are governed and attenuated end to end. Existing P9/P10 suites pass unchanged. No payment or credit term is added to CORE |
| Non-goals | `PaymentIntent` or `CreditIntent` (PAY-01, CREDIT-01); a universal "EconomicIntent" god-object |

**CORE-04: Trusted Context & Obligations on the Governed Path**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-03 (hard: context facts and obligations bind to envelope parameters) |
| Purpose | Make layers C and D reachable from governed actions (both are LIBRARY-ONLY today). Answer the OBLIGATIONS question of invariant 23. Provide the risk-input boundary |
| Existing reused | `context-resolution-runtime`, `obligation-runtime`, `GRANT_OBLIGATIONS_UNSATISFIED` mapping (`orchestrator.ts:671`), FR-REC-02 trusted context provider as a pattern |
| Remaining work | Compose `contextResolution` and `obligations` into the grant-aware Kernel (`composition-root.ts:1370`). Trusted-input registry: which sources may assert which facts. A risk-signal input as a trusted *fact* (never an authorization-path score, per the existing ban). Durable obligation state. Non-financial exercise-time lineage revalidation (closing the host-callback gap). Decision on the two authority worlds (§7) |
| Exit criteria | A governed action is withheld for an unsatisfied obligation and admitted after verified discharge, durably, across restart. Caller-asserted context cannot occupy a trusted-fact key. Lineage is revalidated at exercise for non-financial actions |
| Non-goals | Behavioural intelligence (ASSURE-04); payment receipts as obligation discharge (PAY-05); credit repayment (CREDIT-05) |

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

**ASSURE-04: Behavioural Risk Intelligence**

| Field | Content |
|---|---|
| Status | DEFERRED |
| Note | Former P21 / Prompt 13. Advisory only; never on the authorization path |

### CTRL

**CTRL-01: Authority Administration API**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-01 (hard), PROD-01 (soft) |
| Purpose | HTTP surfaces for what is in-process only today: Kernel-Authority provisioning, grant revocation, emergency control, grant/decision reads |
| Exit criteria | No pilot operation requires source code or direct DB edits |
| Parallel | Yes, with CORE-03/04 |

**CTRL-02: Organizations, Human Operators & Agent Inventory**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CTRL-01 |
| Existing reused | passport-web account/role model as reference; `BoundCustomerIdentity` |
| Remaining work | Human operator identity + roles in the enterprise runtime. An agent inventory backed by Kernel-Authority actors. A passport reconciliation decision (§7) |

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

### PROD

**PROD-01: Production Host Composition & Secure Defaults**

| Field | Content |
|---|---|
| Status | PLANNED |
| Depends on | CORE-01 (hard) |
| Purpose | The shipped host composes the governed-action spine with durable stores, authenticity, P7, and auth on (SC-001, GS-003) |
| Exit criteria | `npm run start:enterprise`, with documented config, runs governed actions with signed grants. Insecure config refuses to boot |
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

**PLAN.** `──►` is a hard dependency. `┄┄►` is a soft dependency.

```
CORE-01 ──► CORE-02 ──► CORE-07
   │           └┄┄► ASSURE-02 ──► ASSURE-03
   ├──► PROD-01 ──┄┄► PROD-02
   ├──► CTRL-01 ──► CTRL-02 ──► CTRL-03 ──► CTRL-04 ◄── CORE-05
   ├┄┄► ASSURE-01
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

CORE-01..05 + PROD-01 ──► CORE-06
PROD-01 + PROD-02 + CTRL-01..04 + CORE-06 ──► PROD-03
```

---

## 11. Milestones

### 11.1 GOVERNANCE CORE STABLE

**Definition.** A mature, generic authority engine, provable on the shipped host.

All of the following must be true:

1. **Revocation is tamper-evident.**
   - The un-revocation path (§3.7) is closed (CORE-01).
   - Snapshot rollback is at least *detected* (CORE-07), or formally accepted as a deployment control with a documented operational mitigation.
2. **Authority authenticity is on by default.**
   - Durable grants are signed.
   - An unsigned substitute is refused (CORE-01, PROD-01).
3. **External signer boundary.** Authority keys are not required to be process-resident (CORE-02).
4. **One generic envelope.**
   - It expresses non-money parameters and non-money bounds (CORE-03).
   - No payment or credit vocabulary exists in CORE; this is enforced by structural tests.
5. **Obligations and trusted context are reachable** on the governed path (CORE-04).
6. **Lineage is revalidated at exercise** for all action classes (CORE-04).
7. **Approvals are durable and resumable** (CORE-05).
8. **The no-bypass proof is re-run** against the composed default host (CORE-06).
9. **Every "BLOCKED" security claim has a test.**

### 11.2 CORE PROVEN

**Definition.** Frontera governs economic actions independently of payment
protocol and settlement rail.

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
- **Host:** PROD-01 (bootable, secure-default host) and PROD-02 (complete backup/restore).
- **Control plane:** CTRL-01 … CTRL-04, which cover organization setup, agent registration, authority assignment, limits/policies, approvals, activity and evidence via API + web.
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
| CORE-01, 03, 04, 05, 06; PROD-01, 02, 03; CTRL-01 … 04; ASSURE-01 | CORE-02 (unless the pilot threat model requires it), CORE-07, ASSURE-02/03/04 |
| | SSO, advanced RBAC, billing, IaC, pentest, certification (PROD-04) |
| | Mobile (CTRL-06/07), alerts (CTRL-05) |
| | Broad multi-chain, Stripe (PAY-09), x402 (PAY-08) |

---

## 12. Parallelization Opportunities

**PLAN.**

- **After CORE-01:** three streams can run in parallel: CORE-02, CORE-03 and (PROD-01 → CTRL-01).
- **ASSURE-01** can run alongside CORE-03/04. It reads existing P8 data.
- **CTRL-01 → CTRL-03** need stable authority/control APIs only. They do **not** need any PAY work.
- **After CORE-03:**
  - PAY-01 and CREDIT-01 (design) can proceed in parallel.
  - PAY rail work (PAY-03/04/06) and CREDIT-02/03 are independent until CREDIT-04, which shares the XRPL client with PAY-04.
- **PAY-08 (x402)** is parallel to PAY-04/06.
- **PROD-02** can run any time after PROD-01.

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
- No behavioural or AI scoring in the authorization path.
- No IAM or authentication for target systems (TARGET architecture §10 stands).
- Mobile, SSO and billing are not pilot prerequisites.

---

## 14. Current NEXT Item

**NEXT: CORE-01 — Revocation State Integrity & Durable Authenticity Enforcement**

**Why it is next:**

- It is a **correctness defect in a merged security guarantee**. A
  database-only writer can un-revoke a grant, and the canonical security
  document says this is BLOCKED.
- It violates invariant 4 directly.
- It is also small and fully contained in CORE.
- CORE-02 (external signer) should not come first. Moving the signer out of
  process before the revocation-state commitment format is settled would bake
  the hole into the external boundary, and CORE-02 is larger with more design
  surface.

**Prerequisites already satisfied:**

- PRE-00 signer and verifier.
- Domain-separated signing input.
- Closed algorithm registry.
- Durable store with transactional authoritative reads.
- The three authenticity suites, as a harness to extend.

**What it unlocks:**

- CORE-02 (settled artifact set to sign externally).
- PROD-01 (a secure default can be switched on).
- CTRL-01 (a revocation API on a trustworthy revocation store).
- ASSURE-01 (trace over authentic revocation state).

**Out of scope:**

- KMS/HSM.
- Whole-snapshot rollback detection.
- Signing other stores.
- Changing shipped host defaults.
- Any PAY, CREDIT or CTRL work.
- Merging the P13 branch.

---

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

**Rules:**

1. New work is identified by `CORE|PAY|CREDIT|ASSURE|CTRL|PROD-nn` only.
2. Completing an item updates its status here in the same PR.
3. Only one item is NEXT at a time.
4. A capability is VERIFIED only when it is wired into a production composition path and tested. Docs alone never qualify.
5. When code and this document disagree about what exists, fix this document.
