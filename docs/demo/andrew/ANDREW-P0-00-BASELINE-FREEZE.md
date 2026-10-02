# ANDREW-P0-00 — Baseline / Freeze

> Audit-only artifact. No application, test, configuration, schema, migration or
> lockfile was modified to produce it. Every capability claim below is backed by a
> `path:line` citation at the audited HEAD; documentation was used only to locate
> code, and documentation claims are labelled as such.

Classification vocabulary used throughout:

| Label | Meaning |
|---|---|
| **IMPLEMENTED AND VERIFIED** | Implementation exists and a test in the repository exercises it (and the suite passed in this run, §15). |
| **IMPLEMENTED BUT NOT VERIFIED** | Code exists; no test exercises the specific behaviour. |
| **PARTIAL** | Types, stubs, fixtures, or behaviour that only covers part of the need. |
| **ABSENT** | No implementation evidence. |
| **UNKNOWN** | Cannot be determined safely from the repository. |

---

## 1. Executive Summary

Frontera at `fe277ea` already contains a mature, heavily tested **rail-neutral governed-action spine**:
`POST /api/governed-actions` → closed intent validation → Kernel → durable decision commit → bounded grant (Ed25519-signed in the SQLite store) → grant-exercise gate → `ExecutionAdapter` → durable write-ahead outcome (P11) → hash-chained governance record and authority event stream. Denials and withholds provably stop before any grant or adapter call. Agent identity, delegation, exact-decimal monetary semantics, per-asset monetary ceilings (`max_amount`) and aggregate spending limits are implemented and tested.

The Andrew scenario's **distinctive** pieces are, however, absent:

1. **No destination / beneficiary model.** No registry, no network or address type, no approved/unapproved state keyed to a wallet, no approval provenance, no revocation. The only first-class axis is an opaque `counterparty` string that is bound exactly into the grant.
2. **No governed "approve a destination" mechanism.** CORE-05 approvals approve *one committed decision*, not a wallet, and are in-process only (no HTTP route; CTRL-04 is unbuilt).
3. **The trusted-context resolver cannot be asked about a specific wallet.** `ContextResolutionQuery` carries no counterparty, amount or parameters, so a `destination.approved` fact cannot be bound to *this* destination.
4. **No reevaluation of the same action.** A committed decision is final for its idempotency key; the code says "Re-evaluation itself is NOT implemented". A denied action can only be retried as a new request with no causal link.
5. **No XRPL code at all.** No dependency, client, signer, Testnet config, or tests. Multiple structural tests actively forbid XRPL/wallet/ledger vocabulary inside CORE directories.
6. **No rail transaction signer.** The only signer signs authority artifacts (grants, revocations, approval/obligation state).
7. **No first-class governance receipt.** Evidence is distributed across stores linked by ids and digests; outcome records can carry only an opaque `providerRef` (no ledger index / engine result / validated flag).
8. **Over-ceiling is "WITHHELD", not "DENY".** `$125k > $100k` yields `status: withheld, withheldBy: authority-binding, FINANCIAL_AUTHORITY_CEILING_EXCEEDED` with the Kernel decision still `allowed` — no grant, no execution, by design and by test.

**NO GRANT → NO EXECUTION** is enforced at runtime on the only production path and pinned by structural (source-scan) tests, but it is **not** structurally enforced by the type system or by the adapter itself (adapters never see or verify the grant).

The baseline is reliable and the repository is in a clean, reproducible state. ANDREW-P0-01 (Destination Semantics) can start; the planned sequence needs adjustment (§19) chiefly because **reevaluation** and **destination-aware trusted context** are hidden prerequisites, and because the Andrew track overlaps the master plan's CTRL-04 / PAY-01 / PAY-03 / PAY-04 items.

---

## 2. Baseline Identity

| Item | Value |
|---|---|
| Branch | `feat/andrew-p0-00-baseline-freeze` |
| HEAD | `fe277ea5c607ef38f5700b3b698b3299e516fdff` |
| origin/main (local tracking ref, not re-fetched) | `fe277ea5c607ef38f5700b3b698b3299e516fdff` |
| HEAD commit | `Merge pull request #160 from Republika-Network/feat/ctrl-03-web-control-plane-mvp` (2026-10-01 21:55:12 -0600) |
| Worktree | `C:/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-00` (WSL: `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-00`) |
| Working tree at audit start | Clean (`git status --short` empty) |
| Remote | `origin https://github.com/Republika-Network/Frontera.git` |
| Audit date | 2026-10-01 |
| Toolchain | Node v22.23.1, npm 10.9.8 (WSL2 Linux) |

Environment verification notes:

- The worktree's `.git` file points at a Windows path (`gitdir: C:/Users/Usuario/source/Republika-Network/Frontera/.git/worktrees/Frontera-andrew-p0-00`), which the WSL `git` binary cannot resolve. All git commands were therefore run with Windows Git (`/mnt/c/Program Files/Git/cmd/git.exe`), read-only. The `.git` pointer was **not** modified.
- `git log -10 --oneline --decorate` at start:

```
fe277ea (HEAD -> feat/andrew-p0-00-baseline-freeze, origin/main, origin/HEAD, main, feat/ctrl-04-approval-escalation-workflow) Merge pull request #160 from Republika-Network/feat/ctrl-03-web-control-plane-mvp
d995432 docs(ctrl-03): record the session-clock finding and the mutation addendum
c5bc444 test(ctrl-03): make the monotonic-session test reach a wall-clock store
6aa81c3 fix(ctrl-03): time console sessions on a monotonic clock
d7ea302 docs(ctrl-03): record qualification, mutation evidence and roadmap
f2906b0 test(ctrl-03): keep the canonical test clear of the architecture lint's any pattern
d4598a2 fix(ctrl-03): close adversarial pre-push review findings
74174eb fix(ctrl-03): refuse dot path segments in the Host client
f09cc51 docs(ctrl-03): web control plane decision record, threat model and invariants
d8bc389 test(ctrl-03): qualify the web control plane against the real Host
```

- `git worktree list` at start (other worktrees exist and were **not** touched or used as baseline):

```
C:/Users/Usuario/source/Republika-Network/Frontera              fe277ea [main]
/mnt/c/Users/Usuario/source/Republika-Network/Frontera-ctrl03   d995432 [feat/ctrl-03-web-control-plane-mvp] prunable
/mnt/c/Users/Usuario/source/Republika-Network/Frontera-ctrl04   fe277ea [feat/ctrl-04-approval-escalation-workflow] prunable
C:/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-00 fe277ea [feat/andrew-p0-00-baseline-freeze]
C:/Users/Usuario/source/Republika-Network/Frontera-core06       5ef11c0 [feat/core-06-governance-core-qualification]
C:/Users/Usuario/source/Republika-Network/Frontera-core07       3fac009 [feat/core-07-authority-state-freshness]
C:/Users/Usuario/source/Republika-Network/Frontera-core08       fcac58e [feat/core-08-action-neutrality-qualification]
C:/Users/Usuario/source/Republika-Network/Frontera-ctrl02       846af3c [feat/ctrl-02-organizations-operators-agents]
```

Assumption checks: Andrew isolated worktree ✅ · expected branch ✅ · clean at start ✅ · HEAD == origin/main ✅ (merge-base is HEAD itself).

---

## 3. Repository Component Map

npm workspace monorepo (`package.json` workspaces `packages/*`, `apps/*`), TypeScript compiled with `tsc -b` to `dist/`. Root `src/` holds the Kernel, the Enterprise Host and feature runtimes. Persistence is **SQLite (`better-sqlite3`) or in-memory**; no Postgres/Supabase code path exists in `src/enterprise`.

| Concern | Path | Responsibility | Primary types / functions | State | Key tests |
|---|---|---|---|---|---|
| GovernedAction envelope | `src/enterprise/governed-action/` | Wire intent, closed validation, request ids, orchestrator | `GovernedActionIntent` (`contracts.ts:65-99`), `validateGovernedActionIntent` (`intent.ts:298-372`), `deriveGovernedActionRequestId` (`identifiers.ts:397-399`), orchestrator `govern` (`orchestrator.ts:679`) | IMPLEMENTED AND VERIFIED | `src/enterprise/__tests__/governed-action-orchestrator.test.ts`, `governed-action-api-endpoint.test.ts` |
| HTTP entry | `src/enterprise/adapters/node-http-adapter.ts` | Inbound API (`POST /api/governed-actions` :200), operator `/api/admin/*` | — | IMPLEMENTED AND VERIFIED | `governed-action-api-endpoint.test.ts`, `ctrl02-*-host.test.ts` |
| Kernel / policy | `src/kernel/` | Evaluate request → `allowed \| denied \| approval_required \| indeterminate` | `AocKernel.evaluate` (`AocKernel.ts:311-397`), `kernel-result.ts:22`, reason codes `reason-codes/reason-codes.ts` | IMPLEMENTED AND VERIFIED | `src/kernel/__tests__/*` incl. `characterization/*`, `kernel-invariants.test.ts` |
| Policy packs | `src/features/domain-policy-pack-runtime`, `src/features/policy-pack-foundation` | Declarative rules, effects (`allow`, `deny`, `require_approval`, …) | `policy-pack-effect.ts:1-11`, `policy-condition-evaluator.ts` | IMPLEMENTED AND VERIFIED (in-process only; no durable policy store) | `policy-condition-evaluator.test.ts` |
| Trusted context | `src/enterprise/trusted-context/`, `src/features/context-resolution-runtime/` | Authoritative fact sources, freshness, org scope | `ContextResolutionQuery` (`context-resolver-port.ts:13-24`), `trusted-context.ts:26-68` | IMPLEMENTED AND VERIFIED (no counterparty in query) | `governed-action-trusted-context-host.test.ts`, `context-provenance-scenario.test.ts` |
| Decision durability | `src/enterprise/governed-action/decision-commit.ts`, `src/enterprise/governance-store/` | Commit-before-act, verify, idempotency, hash chain | `committer.commit` (`decision-commit.ts:266`), `GovernanceReplayMetadata` (`governance-store/contracts.ts:408`) | IMPLEMENTED AND VERIFIED | `governed-action-orchestrator.test.ts:169-210, 619-714`, `governance-store-sqlite.test.ts` |
| Authority / identity | `src/enterprise/kernel-authority/`, `src/features/authority-graph/`, `src/features/recognition-runtime/`, `src/enterprise/operator-control/`, `src/enterprise/customer-identity/` | Actors (incl. `agent`), delegation, monetary constraints, credentials | `ActorType` (`recognition-runtime/domain/actor.ts:1`), `max_amount`/`spending_limit` (`authority-graph/domain/authority-grant.ts:10-40`), `createKernelFinancialAuthorityResolver` (`financial-authority-resolver.ts:135-237`), agent credentials (`agent-credentials.ts:30-107`) | IMPLEMENTED AND VERIFIED | `authority-payment-ceilings.test.ts`, `kernel-authority-monetary-constraints.test.ts`, `delegation-service.test.ts` |
| Monetary semantics | `src/features/monetary-runtime/domain/` | Canonical decimal, trusted asset registry, financial classification | `MonetaryAmount`, `parseMonetaryAmount`, `compareMonetaryAmounts` (`monetary-amount.ts`), `createMonetaryAssetRegistry` (`monetary-asset.ts`), `createFinancialActionClassifier` (`financial-action.ts`) | IMPLEMENTED AND VERIFIED | `monetary-amount.test.ts`, `canonical-decimal.test.ts`, `monetary-boundaries.test.ts`, `canonical-monetary-semantics.test.ts` |
| Grants | `src/features/grant-runtime/`, `src/enterprise/bounded-grant-store/`, `src/enterprise/execution-governance/` | Bounded grant model, issuance, signed SQLite store | `BoundedGrant` (`bounded-grant.ts:53-106`), `GrantScope` (`grant-scope.ts:149-158`), `issueGrant` (`grant-issuance-service.ts:170-284`), `issueFromDecision` (`issuance-core.ts:433-598`) | IMPLEMENTED AND VERIFIED | `grant-issuance.test.ts`, `grant-layer-boundaries.test.ts`, `authority-artifact-authenticity.test.ts` |
| Obligations | `src/enterprise/obligation-discharge/`, `src/features/obligation-runtime/` | Blocking obligations withhold grant; signed discharge store | `recorder.ts`, `orchestrator.ts:797-808` | IMPLEMENTED AND VERIFIED (in-process only) | `governed-action-obligations-host.test.ts`, `obligation-discharge-scenario.test.ts` |
| Approvals | `src/enterprise/approval-authority/`, `src/features/approval-runtime/` | Per-decision durable approvals, signed state | approval subject (`subject.ts:36-64`), commands (`contracts.ts:74-104`) | IMPLEMENTED AND VERIFIED (in-process only; no HTTP route) | `governed-action-approvals-host.test.ts`, `governed-action-approvals-adversarial-host.test.ts` |
| Execution runtime | `src/features/execution-runtime/` | Grant exercise gate, adapter port, registry | `ExecutionAdapter` (`execution-adapter-port.ts:280-285`), `ValidatedExecutionAction` (`:59-106`), `createGrantExecutionService` (`grant-execution-service.ts:170`), `createExecutionAdapterRegistry` (`execution-adapter-registry.ts:223`) | IMPLEMENTED AND VERIFIED | `execution-exercise.test.ts`, `execution-exercise-control.test.ts`, `execution-adapter-registry.test.ts`, `execution-layer-boundaries.test.ts` |
| Execution adapters | `src/enterprise/execution-adapters/` | Concrete adapters — **only `generic-http/`** | `generic-http-execution-adapter.ts` | IMPLEMENTED AND VERIFIED (HTTP only) | `generic-http-execution-adapter.test.ts`, `generic-http-composition.test.ts` |
| Exercise controls | `src/enterprise/exercise-control-ledger/`, `src/features/exercise-control-runtime/` | Optional at-most-once / count / aggregate limits | `sqlite-exercise-control-ledger.ts` | IMPLEMENTED AND VERIFIED | `execution-exercise-control.test.ts` |
| Signer boundary | `src/enterprise/authority-authenticity/`, `src/enterprise/external-authority-signer/` | Ed25519 signing of authority artifacts only | `AuthorityArtifactSigner` (`signer.ts:67-95`), `frontera.external-authority-signer.v1` (`protocol.ts:33-46`) | IMPLEMENTED AND VERIFIED (no transaction signer) | `external-authority-signer-contract.test.ts`, `authority-authenticity-boundaries.test.ts` |
| Outcomes | `src/enterprise/execution-outcome-store/`, `execution-reconciliation/`, `execution-resolution-store/` | P11 write-ahead attempts + terminal observations; P12 resolution port | `contracts.ts:120-198`, `provider-reference.ts:44-53`, `ExecutionResolutionAuthority` (`execution-reconciliation/authority.ts:48-90`) | IMPLEMENTED AND VERIFIED (no concrete resolution authority) | `execution-outcome-store.test.ts`, `durable-monetary-outcomes.e2e.test.ts`, `execution-reconciliation-e2e.test.ts` |
| Evidence / audit | `src/enterprise/evidence/`, `src/enterprise/authority-event-stream/`, `src/features/verifiable-export-package/` | Evidence bundles (in-memory), hash-chained event stream | `AUTHORITY_EVENT_TYPES` (`authority-event-stream/contracts.ts:67-79`), `evidence/contracts.ts:194` | PARTIAL (no governance receipt; evidence bundle store in-memory) | `authority-event-stream-governed-action.test.ts`, `evidence-integrity.test.ts` |
| Transfer (rights, not money) | `packages/transfer-mandate`, `src/enterprise/transfer-governance/` | Transfer of rights in an asset; transferee, mandate status/expiry | `EnterpriseTransferTerms.transfereeRef` (`enterprise-transfer-terms.ts:367-378`) | IMPLEMENTED (not composed into Host, no route) | `transfer-governance.test.ts`, `transfer-durability.test.ts` |
| Operator plane | `src/enterprise/operator-control/`, `src/control-plane-web/` | Closed roles, provisioning, revocation over HTTP; web console | `roles.ts:22-70`, `service.ts:359-402` | IMPLEMENTED AND VERIFIED | `ctrl02-operator-plane-host.test.ts`, `ctrl03-structure.test.ts` |
| XRPL | — | — | — | **ABSENT** | — (negative-vocabulary tests only) |
| Wallet handling | — | — | — | **ABSENT** | — |
| Demo utilities | `packages/commercial-demo`, `src/features/aoc-enterprise-demo`, `examples/` | Pinata data-room demo; legacy `AocGuard` scenarios; Host example config | — | Not payment-related | `packages/commercial-demo/__tests__` |

Legacy / non-spine packages (`packages/capability-tokens` is empty; `src/runtime/crypto/capability-verifier.ts` performs no cryptographic verification and has no production caller; `packages/control-plane` is a legacy JSON-file access-request store) are **not** reusable for Andrew.

---

## 4. Current Governed Action Spine

### 4.1 ACTUAL (as implemented at `fe277ea`)

```
Client (agent credential / API key)
  │  POST /api/governed-actions                          adapters/node-http-adapter.ts:200
  ▼
governGovernedActionRequest()                            orchestration/govern-governed-action-request.ts:37-50
  │  customer admission → BoundCustomerIdentity          (401/403/503 on failure)
  ▼
orchestrator.govern(identity, raw)                       governed-action/orchestrator.ts:679
  │  boundScopeOf()                       kernel-request.ts:463-474   → rejected/IDENTITY_INVALID
  │  validateGovernedActionIntent()       intent.ts:298-372 (closed)   → rejected/INTENT_INVALID (400)
  │  deriveGovernedActionRequestId()      identifiers.ts:397-399
  ▼
committer.commit()                                       decision-commit.ts:266
  │  idempotency resolve BEFORE Kernel                   :104-119
  │     conflict → rejected/IDEMPOTENCY_CONFLICT (409)
  │     replay   → stored decision, Kernel NOT re-run    :136-138
  │  AocKernel.evaluate()                                kernel/AocKernel.ts:311-397
  │  store.appendEvaluation()        ══ PERSIST: Governance Store (SQLite) ══   :170
  │  re-read + verify + bind → VerifiedDecision          :224-262
  ▼
status gate                                              orchestrator.ts:715-720
  │  denied        → result 'denied' (422)          ■ STOP (no grant, no adapter)
  │  indeterminate → 503                             ■ STOP
  │  approval_required (no approvals composed) → withheld:'approval' ■ STOP
  ▼
replay-of-prior-execution check (ledger.prior)           :728-729
approval gate (CORE-05, in-process)                      :757-760   → withheld:'approval'
emergency-control admission                              :782-788   → withheld:'emergency-control'
grant terms (capped by context validUntil / approval notAfter) :537-567, 790-791
obligations satisfiedNow                                 :797-808   → withheld:'obligations'
  ▼
issuance.issueFromDecision()                             :813-821 ; execution-governance/issuance-core.ts:433-598
  │  authority binding → financial authority (P10 ceiling) → parameter authority
  │     ceiling exceeded → withheld:'authority-binding' FINANCIAL_AUTHORITY_CEILING_EXCEEDED ■ STOP
  │  issueGrant()                                        grant-runtime/.../grant-issuance-service.ts:170-284
  │                                  ══ PERSIST: bounded-grant store (SQLite: Ed25519-signed; in-memory: digest only) ══
  ▼
ledger.recordAuthorization (evidence ref)                orchestrator.ts:863
execution.assessExercise (pure)                          :871-875
approval re-check                                        :883-889
executionOutcomes.prepareAttempt  ══ PERSIST: P11 outcome store (SQLite WAL) ══   :906-919
P12 resolution binder (optional)                         :928-935
ledger.claim (write-ahead)        ══ PERSIST: Governance Store ══   :940-943
  ▼
execution.exercise → GrantExecutionService.exercise      grant-execution-service.ts
  │  store.read (signature verified, SQLite)             :290
  │  assessBoundedGrantExercise                          :295  (actor/action/resource/counterparty/amount/unit/expiry)
  │  usable gate                                         :353  → withheld:'exercise'/'grant' ■ STOP
  │  emergency + optional exercise-control reserve + re-read  :358-475
  │  frozen ValidatedExecutionAction                     :470-494
  ▼
adapter.execute(ValidatedExecutionAction)                :514     (only generic-http exists)
  │  → completed | failed(reason) | unconfirmed  (+ opaque providerRef)
  ▼
recordTerminal (P11 observation)  ══ PERSIST ══          orchestrator.ts:966-969
ledger.recordOutcome / execution.outcome.observed event  :980-983
  ▼
GovernedActionResult (frozen; no grant object returned)  contracts.ts:306-335 ; api/governed-action-contract.ts:53-74
```

Transition evidence:

| Transition | Source | Input → Output | Persistence | Failure path | Tests |
|---|---|---|---|---|---|
| Intent → Kernel request | `kernel-request.ts:477-504` | `GovernedActionIntent` + `BoundCustomerIdentity` → `KernelEvaluationRequest` | none | `rejected/INTENT_INVALID`, `IDENTITY_INVALID` | `governed-action-orchestrator.test.ts:521-617`, `governed-action-api-endpoint.test.ts:533-765` |
| Kernel → decision | `AocKernel.ts:311-397` | `KernelEvaluationRequest` → `KernelEvaluationResult` | none | throw → `system_error`, nothing persisted (`decision-commit.ts:158-161`) | `src/kernel/__tests__/*` |
| Decision → durable decision | `decision-commit.ts:170, 224-262` | result → `VerifiedDecision` | Governance Store | `DECISION_PERSISTENCE_FAILED`, `UNVERIFIABLE`/`MISMATCH` | `governed-action-orchestrator.test.ts:345-411, 472-519` |
| Decision → Grant | `issuance-core.ts:433-598`; `grant-issuance-service.ts:170-284` | `VerifiedDecision` → `BoundedGrant` | bounded-grant store | `withheld:{authority-binding,grant,grant-terms,…}` | `governed-action-orchestrator.test.ts:107, 212-325`; `authority-payment-ceilings.test.ts` |
| Grant → adapter | `grant-execution-service.ts:290-514` | `ExerciseRequest` → `ValidatedExecutionAction` → `ExecutionAdapterResult` | P11 attempt, Governance claim | `withheld:exercise`, `execution_failed`, `execution_unconfirmed` | `execution-exercise.test.ts` (each refusal asserts adapter not called, :150) |
| Adapter → outcome | `orchestrator.ts:966-983` | result → P11 terminal observation + event | P11 store, event stream | write-once; replay reads P11 (`:640-670`) | `governed-action-orchestrator.test.ts:442-470, 838-976`; `durable-monetary-outcomes.e2e.test.ts` |
| Outcome → receipt | — | — | — | — | **ABSENT** (no receipt type) |

### 4.2 TARGET (Andrew flow — does NOT exist yet)

```
Agent (credential)                                         [EXISTS]
  │  GovernedAction: transfer USD 75,000 → destination D   [EXISTS as intent; D only as opaque counterparty]
  ▼
Trusted context: destination D approved for (org, network, asset, action)?   [MISSING: registry + D-aware query]
  ▼
Policy evaluation                                          [EXISTS]
  │  destination check                                     [MISSING rule input bound to D; fixture-only today]
  │  monetary authority (ceiling)                          [EXISTS — yields WITHHELD, not DENY]
  ▼
HOLD (or DENY)  — no grant, no adapter, no signer          [EXISTS mechanically: approval_required / denied]
  ▼
Destination approval via governed mechanism                [MISSING: destination approval record, route, provenance]
  ▼
Reevaluation of the SAME business action                   [MISSING: Kernel never re-runs for a committed key]
  ▼
Grant (binds actor, amount, asset, destination, rail)      [PARTIAL: no rail/adapter axis; destination=counterparty]
  ▼
XRPL adapter (ExecutionAdapter impl)                       [MISSING]
  ▼
Rail signer boundary (signs only the granted Payment)      [MISSING]
  ▼
XRPL Testnet submit → wait for validated ledger            [MISSING]
  ▼
Validated outcome: tx hash, ledger index, tesSUCCESS, validated  [PARTIAL: only opaque providerRef storable]
  ▼
Evidence persisted                                         [PARTIAL: distributed, evidence bundle store in-memory]
  ▼
Governance receipt (one durable, verifiable document)      [MISSING]
```

---

## 5. Authority Model

| Question | Answer | Status | Evidence |
|---|---|---|---|
| How is an actor identified? | `ActorType = human\|organization\|agent\|system\|external\|unknown`; durable `ProvisionActorInput{actorId,type,displayName,issuerId?,trustDomainId?,externalSubject?}`; external subject `{system,subjectId}` unique per org | IMPLEMENTED AND VERIFIED | `recognition-runtime/domain/actor.ts:1`; `kernel-authority/contracts.ts:108-144`; `authority-payment-ceilings.test.ts:113-121` |
| First-class agent identity? | Yes. `type:'agent'` always requires a proven delegation chain; agent credentials `fra1.agc-…` with SHA-256 verifier + `timingSafeEqual`; principal `agent:<actorId>` | IMPLEMENTED AND VERIFIED | `recognition-runtime/services/authority-graph-integration.ts:39-44`; `operator-control/agent-credentials.ts:30-107` |
| Actor ↔ organization/principal | Credential → `CustomerPrincipal` with org/subject from server config only; actor via `findActorByExternalSubject`; Kernel actor/org built from bound scope, never from intent | IMPLEMENTED AND VERIFIED | `customer-identity/customer-authenticator.ts:30-71`; `kernel-authority-store.ts:73-77`; `kernel-request.ts:463-474`; tests `authority-payment-ceilings.test.ts:725`, `kernel-authority-monetary-constraints.test.ts:152` |
| Delegated authority | `ProvisionDelegationGrantInput{delegator, delegate, sourceAuthorityGrantId, actions, resourceScopes, canRedelegate?, expiresAt?, constraints?}`; subset-only, depth-limited | IMPLEMENTED AND VERIFIED | `kernel-authority/contracts.ts:254-272`; `authority-graph/services/delegation-service.ts:61-98`; `delegation-service.test.ts`, `delegation-lineage.test.ts` |
| Authority ceilings | Constraint kinds: `resource_scope`, `prohibited_action`, `max_amount`, `spending_limit`, `time_window`, `data_boundary`, `human_approval_required` | IMPLEMENTED AND VERIFIED | `authority-graph/domain/authority-grant.ts:1-54` |
| Monetary ceilings | `max_amount{currency,value}` per execution; `spending_limit{limitId,currency,maximum,window}` aggregate; narrowest ceiling across the lineage wins | IMPLEMENTED AND VERIFIED | `authority-grant.ts:10-40`; `financial-authority-resolver.ts:135-237`; `issuance-core.ts:286-305`; `authority-payment-ceilings.test.ts:315, 385, 467, 474` |
| Limits per currency/asset | Yes; per-asset resolution; cross-asset → `ASSET_MISMATCH`; spending buckets keyed by currency | IMPLEMENTED AND VERIFIED | `financial-authority-resolver.ts:207-222`; tests `authority-payment-ceilings.test.ts:417, 546`; `kernel-authority-monetary-constraints.test.ts:407` |
| Evaluated before grant issuance? | Yes — `measureFinancialAuthority` before `issueGrant`, re-resolved inside the store commit guard (`FINANCIAL_AUTHORITY_CHANGED`) | IMPLEMENTED AND VERIFIED | `issuance-core.ts:399-411, 494-562`; `authority-payment-ceilings.test.ts:315-321` |
| Expiry | `expiresAt` on grants/delegations; `isLive()` | IMPLEMENTED AND VERIFIED | `financial-authority-resolver.ts:128-133`; `kernel-authority-monetary-constraints.test.ts:370` |
| Revocation | Terminal revocation events; mid-flight revocation tested | IMPLEMENTED AND VERIFIED | `kernel-authority/contracts.ts:67-70`; `kernel-authority-monetary-constraints.test.ts:160, 364`; `authority-payment-ceilings.test.ts:612-650` |
| Persisted? | SQLite when `persistence.provider==='sqlite'`, else in-memory; `AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED` defaults **false** | IMPLEMENTED AND VERIFIED | `composition-root.ts:922-931`; `enterprise-configuration.ts:826-834`; restart test `authority-payment-ceilings.test.ts:329` |
| Cryptographically bound? | Kernel Authority (where ceilings live): **SHA-256 hash chain only, unsigned**; a DB writer who re-seals digests could widen a ceiling (acknowledged in code). Bounded grants, revocations, approval & obligation state: Ed25519 | PARTIAL | `kernel-authority-store.ts:174-216`; `monetary-constraints.ts:21-22`; `authority-signature.ts:76-84` |
| What stops a request claiming more authority? | Closed intent key set; ~100 reserved keys refused top-level and in `assertedContext` (incl. `max_amount`, `ceiling`, `spendingLimit`, `financialAuthority`); store writes require operator context; issuance compares the decision's own authority proof id-for-id | IMPLEMENTED AND VERIFIED | `intent.ts:52, 63-167`; `kernel-authority-store.ts:120-135`; `financial-authority-resolver.ts:162-174`; `authority-payment-ceilings.test.ts:689-722` |

Caveat (IMPLEMENTED BUT NOT VERIFIED): financial authority is consulted only if an `actionClassifier` is composed via `exerciseControls` (`issuance-core.ts:249, 287`; `composition-root.ts:2108-2118`). Without it a financial action's grant is issued with no amount bound — exercise still fails closed (`grant-exercise-assessment.ts:88-90, 159-161`), but no test covers this misconfiguration. The Andrew host **must** compose exercise controls.

---

## 6. Monetary Semantics

| Aspect | Implementation | Status | Evidence |
|---|---|---|---|
| Amount | `MonetaryAmount{value: string, unit: string}`; canonical decimal text in major units, parsed internally to bigint coefficient + scale | IMPLEMENTED AND VERIFIED | `monetary-amount.ts:17-20`; `canonical-decimal.ts:44-97` |
| Precision | ≤128 digits, ≤256 chars; per-asset scale 0–36 from the trusted registry; excess fractional digits refused (`MONETARY_SCALE_EXCEEDED`), never rounded | IMPLEMENTED AND VERIFIED | `canonical-decimal.ts:39-42`; `monetary-asset.ts` (`MONETARY_ASSET_MAXIMUM_SCALE = 36`); `canonical-decimal.test.ts:102-115` |
| JS numbers | Refused (`MONETARY_VALUE_NOT_TEXT`); JSON number lexemes only through `canonicalDecimalFromJsonNumberLexeme` | IMPLEMENTED AND VERIFIED | `monetary-amount.ts` (`parseMonetaryAmount`); `api/exact-monetary-json.ts:54`; `monetary-boundaries.test.ts:54` |
| Asset representation | `MonetaryAssetDefinition{assetId, scale}`; opaque, case-sensitive ids, no aliases; grammar `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$` admits `xrpl:XRP`, `xrpl:USD/rIssuer`. **No assets ship**; host configures `monetary.assets` | IMPLEMENTED AND VERIFIED (mechanism); assets ABSENT | `monetary-asset.ts:1-134`; `host/host-configuration.ts:86, 319-326`; `composition-root.ts:1556-1559` |
| Comparison | `compareMonetaryAmounts` → `-1\|0\|1\|'incomparable'`; different units ⇒ incomparable; no FX anywhere | IMPLEMENTED AND VERIFIED | `monetary-amount.ts` (`compareMonetaryAmounts`); `monetary-amount.test.ts:125-136`; `monetary-boundaries.test.ts:82` |
| Normalization | `canonicalizeDecimalText` (drop trailing fractional zeros) at single ingress `parseMonetaryAmount`; wire `currency` → `unit` | IMPLEMENTED AND VERIFIED | `canonical-decimal.ts:73-84`; `governed-action/intent.ts:222`; `monetary-naming.ts:19-21` |
| Financial classification | Host-trusted `createFinancialActionClassifier`; unlisted ⇒ non-financial and may carry no amount | IMPLEMENTED AND VERIFIED | `financial-action.ts` |
| Policy consumption | Policy-pack ordered comparisons use exact decimals but **ignore currency** — a threshold rule is asset-blind unless combined with a currency condition | PARTIAL | `policy-condition-evaluator.ts:228-236` |

**Can it express USD 75,000 and a USD 100,000 ceiling and compare them?** Yes. With a `{assetId:'USD', scale:2}` registry entry, `parseMonetaryAmount({value:'75000', unit:'USD'})` is valid and `max_amount{currency:'USD', value:'100000'}` is a valid constraint; `compareMonetaryAmounts` is exact BigInt comparison (`issuance-core.ts:302-305`). The specific numbers 75,000 / 100,000 / 125,000 are **not** tested; the same logic is tested at 100.01 vs 100, 50.01 vs 50, 101 vs 100 (`authority-payment-ceilings.test.ts:315, 385, 467-476`; `core08-action-neutrality-host.test.ts:314-325` at 1000.01).

**USD vs USDC vs XRP vs RLUSD without ambiguity?** Structurally yes: distinct asset ids never compare (`'incomparable'` ⇒ `FINANCIAL_AUTHORITY_ASSET_MISMATCH`), verified for USD vs EUR end-to-end and USD vs `xrpl:USD/rIssuerA` at unit level. However: none of USDC / XRP / RLUSD is defined in production configuration; nothing validates that an `xrpl:` issuer is a valid XRPL address; nothing maps a canonical amount to XRP drops or an XRPL issued-currency amount; XRPL issued tokens use 15 significant digits rather than a fixed scale, which a fixed-scale registry can only approximate. **A USD-denominated authority ceiling cannot bound an XRP or RLUSD payment** (no FX by design) — the demo must denominate the ceiling and the payment in the same asset id.

---

## 7. Destination / Beneficiary Semantics

Search terms covered: destination, beneficiary, recipient, wallet, address, allowlist, whitelist, approved destination, counterparty, payee, account, rail destination, transferee.

| Hit | What it actually is | Evidence |
|---|---|---|
| `counterparty` | Closest first-class concept: optional opaque canonical string on the intent → `action.counterpartyId` → policy field (`in`/`not_in`/`exists`) → grant scope `{kind:'identity'}` exact bound → exercise equality check → `ValidatedExecutionAction.counterparty` → approval subject | `governed-action/contracts.ts:68`; `intent.ts:310`; `kernel-request.ts:492`; `policy-pack-condition.ts:34`; `kernel/orchestration/grant-adapter.ts:127`; `grant-exercise-assessment.ts:153-154`; `execution-adapter-port.ts:68-69`; `approval-authority/subject.ts:50` |
| `destination` / `wallet-registry` | **Test fixture only**: a `destination` token parameter and a `destination.registered` fact from a source named "Destination registry"; policy denies `DESTINATION_NOT_REGISTERED` | `src/enterprise/__tests__/core04-host-fixture.ts:80, 107, 153, 192, 277`; `governed-action-trusted-context-host.test.ts:185` |
| `payee` | **Test fixture only**: `payee.approved` fact from `payee-registry`; policy denies `TREASURY_PAYEE_NOT_APPROVED` | `core08-reference-domains-fixture.ts:73, 122, 171, 190`; `core08-action-neutrality-host.test.ts:309-312` (TR-2) |
| `beneficiary` | Approval rule "approver must not be beneficiary"; baseline policy requires a counterparty to exist on financial actions | `approver-rule.ts:19`; `global-legal-baseline.policy-pack.ts:170-180` |
| `transferee` / `recipient` | TRANSFER of *rights*, not money; opaque `transfereeRef`, `permittedRegistries`, mandate status/expiry; not composed into the Host, no route | `packages/transfer-mandate/.../enterprise-transfer-terms.ts:297-378`; `src/enterprise/transfer-governance/service.ts:273, 880` |
| `address` | Generic-HTTP SSRF public-IP policy, not payees | `execution-adapters/generic-http/public-address-policy.ts:1-12` |
| `wallet`, `xrpl` | No production code; appear in **negative** structural tests and doc comments | `execution-layer-boundaries.test.ts:240-246`; `ctrl03-structure.test.ts:171`; `monetary-asset.ts:26-27` |
| allowlist / whitelist / account | No destination meaning | — |

| Capability | Status | Evidence / note |
|---|---|---|
| Destination identity (first-class entity) | **ABSENT** | only opaque `counterparty` / fixture parameter |
| Blockchain network | **ABSENT** | only asset-id namespace convention |
| Blockchain address type / validation | **ABSENT** | — |
| Approved / unapproved state | **PARTIAL** | externally attested boolean fact (fixture), not keyed to the destination in the request |
| Approval authority | **ABSENT** | — |
| Approval evidence | **PARTIAL** | context observation provenance (`sourceId`, `observedAt`, `provenanceDigest`) — who *attested*, not who *approved* |
| Approval timestamp / expiration | **PARTIAL** | fact freshness `maxAgeSeconds` only |
| Revocation | **ABSENT** | indirect only |
| Organization scope | IMPLEMENTED AND VERIFIED | context sources bound to `organizationId` (`governed-action-trusted-context-host.test.ts:96-98`) |
| Asset scope | IMPLEMENTED AND VERIFIED (for authority, not destinations) | per-asset `max_amount` |
| Action scope | IMPLEMENTED AND VERIFIED (profiles), not for destinations | `core04-host-fixture.ts:95-108` |
| Counterparty bound into grant (no substitution) | IMPLEMENTED AND VERIFIED | `kernel-grant-self-assertion.test.ts:181-223`; `GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE` at `core08-action-neutrality-host.test.ts:345`; `execution-exercise.test.ts:118-147` |
| Static allowlist via policy `counterpartyId not_in [...]` | IMPLEMENTED BUT NOT VERIFIED for this use | operator exists; policies are in-process code, no durable store |
| Operator-provisioned exact `destination` parameter bound | IMPLEMENTED AND VERIFIED (generically, on `deploymentStrategy`) | durable, signed, revocable, HTTP via CTRL-02; one value per lineage; out-of-bound ⇒ `PARAMETER_AUTHORITY_EXCEEDED` (deny-like, not hold) — `ctrl02-parameter-authority-host.test.ts:158`; `parameter-authority-resolver.ts:17-21` |

**Critical structural gap:** `ContextResolutionQuery` (`src/features/context-resolution-runtime/domain/context-resolver-port.ts:13-24`) carries `keys, actorId, trustDomainId, action, resourceScope, organizationId?, targetId?, at` — **no counterparty, amount or parameters** — and the governed path never sets `targetId` (`kernel-request.ts:485-503`). A `destination.approved` fact therefore cannot be resolved *for the destination in this request*; existing fixtures return one global boolean.

**Answer to "Is this exact wallet an approved destination for this exact governed action?": NO — the system cannot answer it today.** Syntactically valid addresses are not checked at all, and possession of an address string confers nothing (it is merely bound into the grant).

---

## 8. Policy / Kernel

| Topic | Finding | Status | Evidence |
|---|---|---|---|
| Trusted facts | Host-composed `ContextProvider`; Trusted Context Boundary admits only authoritative, org-scoped, fresh sources; policy reads admitted facts only | IMPLEMENTED AND VERIFIED | `trusted-context/trusted-context.ts:26-68`; `policy-pack-condition.ts:48-95`; `governed-action-trusted-context-host.test.ts:59-264` |
| Request-supplied facts | Closed intent; reserved keys refused; `assertedContext` cannot carry identity/authority/declared fact classes; caller-forged `aoc.context` ignored | IMPLEMENTED AND VERIFIED | `intent.ts:52, 63-167, 351`; `context-provenance-scenario.test.ts:192-217` |
| Evaluation API | `AocKernel.evaluate(request)` (13-policy chain + optional `PolicyPackProvider` → authority narrowing → context → obligations → grant eligibility) | IMPLEMENTED AND VERIFIED | `AocKernel.ts:311-397` |
| Deny | `denied` stops at `orchestrator.ts:715` (422) | IMPLEMENTED AND VERIFIED | `governed-action-orchestrator.test.ts:170-178` |
| Hold / pending | No HOLD status. Closest: `approval_required` (resumable via CORE-05), `withheld:{approval,obligations,authority-binding,grant,exercise,emergency-control,grant-terms}` | PARTIAL | `kernel-result.ts:22`; `contracts.ts:306-335` |
| Obligations | Annotate decision; blocking unsatisfied ⇒ `withheld:'obligations'`; durable signed discharge store | IMPLEMENTED AND VERIFIED | `orchestrator.ts:797-808`; `governed-action-obligations-host.test.ts:102-395` |
| Grant semantics | Only `allowed` is eligible | IMPLEMENTED AND VERIFIED | `grant-adapter.ts:90-92` |
| Reason codes | Kernel `reason-codes/reason-codes.ts`; orchestrator `GOVERNED_ACTION_*` (`contracts.ts:199-263`); `FINANCIAL_AUTHORITY_*` (`financial-authority.ts:48-67`); policy-rule codes nested under `DOMAIN_POLICY_DENIED` | IMPLEMENTED AND VERIFIED | `core04-host-fixture.ts:457-468` |
| Decision durability | Every decision, incl. denied/indeterminate/approval_required, persisted before any effect | IMPLEMENTED AND VERIFIED | `governed-action-orchestrator.test.ts:169-210` |
| Reevaluation | **Not implemented**: "Re-evaluation itself is NOT implemented" | ABSENT | `governance-store/contracts.ts:408` |
| Replay / idempotency | Same key + same payload ⇒ stored decision, Kernel not re-run; same key + different payload ⇒ `IDEMPOTENCY_CONFLICT`; concurrent calls ⇒ ≤1 adapter call | IMPLEMENTED AND VERIFIED | `decision-commit.ts:104-138`; `governed-action-orchestrator.test.ts:619-714` |
| Policy distribution | Policy packs and context providers are in-process only; stock launcher `scripts/run-enterprise-host.mjs:41` composes neither | PARTIAL (operational) | `host/enterprise-host.ts:72-91` |

**Can a request be denied or held before any execution capability becomes reachable? YES — IMPLEMENTED AND VERIFIED.** `denied`/`indeterminate` return at `orchestrator.ts:715-716` before ledger, approvals, grant terms, issuance, claim or adapter; a grant can only be minted from a `VerifiedDecision` (`decision-commit.ts:30-35`); the adapter is only reachable via exercise of a stored grant. Tests: `governed-action-orchestrator.test.ts:170-178` (no `grantStore.issue`, `adapter.callCount==0`); `governed-action-trusted-context-host.test.ts:179-200` (ten deny variants, zero calls); `core08-action-neutrality-host.test.ts:308-325` (TR-2 payee-not-approved deny, TR-3 over-ceiling withheld, both zero adapter effects); `authority-payment-ceilings.test.ts:315-326` (zero grants, zero reservations, zero adapter calls).

---

## 9. Grant Security

| Property | Finding | Status | Evidence |
|---|---|---|---|
| What a grant is | `BoundedGrant{id, correlation{requestId,decisionId,action,resourceScope}, subject, scope, issuedAt, expiresAt, sourceDigest, authorityBindingDigest?, semanticsFormat?, digest}`; no status/usage counter | IMPLEMENTED AND VERIFIED | `bounded-grant.ts:53-106`; `grant-correlation.ts:34-39` |
| Who creates it | `issueGrant` (single production call site from `issuance-core.ts:541`), eligibility requires Kernel `allowed`, attenuation + validity checks, commit guard inside store txn | IMPLEMENTED AND VERIFIED; exclusivity of `store.issue` is **convention** | `grant-issuance-service.ts:170-284`; `sqlite-bounded-grant-store.ts:1369-1379` |
| Binds actor | `subject` | IMPLEMENTED AND VERIFIED | — |
| Binds action / resource / org | `scope.action`, `scope.resources`, `scope.organization` | IMPLEMENTED AND VERIFIED | `grant-scope.ts:149-158` |
| Binds amount | `scope.amount` ceiling, sourced from authority (never the request) | IMPLEMENTED AND VERIFIED | `grant-adapter.ts:104-118`; `kernel-grant-no-request-ceiling.test.ts` |
| Binds asset | only as `amount.unit` string | PARTIAL | `execution-exercise.test.ts` ("amount in a different unit") |
| Binds destination | only as `counterparty` exact identity | PARTIAL | `grant-adapter.ts:127`; `grant-exercise-assessment.ts:154` |
| Binds adapter / rail | **no axis**; registry routes by host config | ABSENT | `execution-adapter-registry.ts` |
| Immutability | deterministic id + SHA-256 digest; TS `readonly`; not `Object.freeze`d at issue; execution copies into frozen `ValidatedExecutionAction` | IMPLEMENTED AND VERIFIED (digest) / PARTIAL (runtime freeze) | `bounded-grant.ts:126-205`; `grant-execution-service.ts:478-494` |
| TTL | required `expiresAt`, contained by upstream ceilings, closed boundary | IMPLEMENTED AND VERIFIED | `grant-validity.test.ts`; `execution-exercise.test.ts:161-175, 341-373` |
| Replay | **multi-use by design** ("repeated exercise … is permitted"); single-use only with exercise controls + `count` limit; same `executionId` blocked by unique index | PARTIAL (opt-in) | `execution-exercise.test.ts:96-114`; `sqlite-exercise-control-ledger.ts:210-211`; `execution-exercise-control.test.ts:302-305` |
| Tamper | Ed25519 (`ed25519-v1`) over domain-separated envelope, verified on every read — **SQLite store only**; default in-memory store has unkeyed digest only | IMPLEMENTED AND VERIFIED (SQLite) / PARTIAL (in-memory) | `authority-signature.ts:76-147`; `sqlite-bounded-grant-store.ts:847-873`; `composition-root.ts:959-975`; `authority-artifact-authenticity.test.ts:161-525` |
| Adapters verify grant independently | **No** — adapter receives only `boundedGrantId` and "has no way to read the grant it names" | ABSENT (by design) | `execution-adapter-port.ts:57-58, 280-285` |

**NO VALID GRANT → NO EXECUTION: PARTIAL — runtime-enforced on the sole production path and pinned by source-scan tests; not type- or lint-enforced.**

- Runtime: `GrantExecutionService.exercise` does store read (+signature verify) → assessment → usable gate → emergency/exercise controls → `adapter.execute` (`grant-execution-service.ts:290-514`).
- Structural tests: `no-bypass-effect-paths.test.ts:172-190` (exactly two production files call `*adapter.execute(`), `:192-222` (enumerated port holders), `:258-269` (ordering). These are regex scans (`/\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/`) and could be evaded by an alias not named `*adapter`.
- `ValidatedExecutionAction` is an unbranded interface — any code holding an adapter could construct one.
- `scripts/lint-architecture.mjs` enforces nothing about grants/adapters.

---

## 10. Adapter Boundary

Port: `ExecutionAdapter { adapterId; execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> }` (`execution-adapter-port.ts:280-285`). Result: `completed | failed(PROVIDER_REJECTED|PROVIDER_UNAVAILABLE|PROVIDER_RESPONSE_INVALID|ADAPTER_ERROR) | unconfirmed`, each with optional `providerRef`, `detail` (`:115-172`). `readExecutionAdapterResult` strips any other fields (`:213-252`). The port explicitly is "not a ledger client, not a signer, not a wallet … no sequence number, no nonce, no fee, no address, no key handle and no chain identifier" (`:35-40`).

| Adapter | Interface | Authorization artifact | Signer | Side effects | Outcome | Failure | Maturity | Tests |
|---|---|---|---|---|---|---|---|---|
| **Generic HTTP** (`src/enterprise/execution-adapters/generic-http/`) | `ExecutionAdapter` | upstream grant exercise; adapter itself holds a static provider credential not bound to any grant (`configuration.ts:56-64`) | none | HTTPS POST/PUT/PATCH/DELETE to one pinned public origin; exact JSON-number amount mapping | 2xx→completed; 4xx (≠408)→failed; else/transport-after-send→unconfirmed; `providerRef` from a configured header | single timeout, **no retry** | Production-shaped; verified with fake runtime + local TLS | `generic-http-execution-adapter.test.ts`, `generic-http-composition.test.ts`, `generic-http-parameter-mapping.test.ts` |
| Pinata (`packages/pinata-adapter`) | own provider result type (not `ExecutionAdapter`) | access-governance grant | none | IPFS storage / access | own | — | Unit-tested with fake JWT; live tests skip without creds; **not a payment rail** | `pinata-provider-client.test.ts`, `access-grant-pinata-live.test.ts` (skipped) |
| `packages/provider-adapter`, `packages/transfer-mandate` | contracts only | — | — | none | — | — | Contract only | package tests |
| `src/features/action-enforcement/adapters` | guard descriptors (fixture `paymentsAdapter` only denies) | — | — | none | — | — | Not an effect rail | — |
| XRPL | — | — | — | — | — | — | **ABSENT** | — |
| Lightning | — | — | — | — | — | — | **ABSENT** | — |
| EVM | — | — | — | — | — | — | **ABSENT** | — |
| Stripe | `stripe` dep only in `apps/agent-passport-web` (billing); asserted unreachable from `src/`/`packages/` | — | — | — | — | — | Not a rail | `no-bypass-effect-paths.test.ts:352-361` |

Routing: `createExecutionAdapterRegistry` (`execution-adapter-registry.ts:223`), wired at `composition-root.ts:2033-2052`; host accepts code-supplied `executionAdapters` (`host/enterprise-host.ts:72, 113-130`). Verified (`execution-adapter-registry.test.ts`).

---

## 11. XRPL State

**Every XRPL capability is ABSENT.** No `xrpl`/`ripple` dependency in any `package.json` or `package-lock.json` (grep exit 1); no client, network or Testnet config, wallet/seed handling, signer, Payment builder, autofill, submit, wait-for-validation, tx-hash/ledger-index/engine-result/validated capture, `delivered_amount` parsing, `LastLedgerSequence` handling, address validation, or tests.

Every occurrence of "xrpl" in the repository is one of:

1. Doc-comment examples of asset ids (`monetary-asset.ts:26-27`; `monetary-amount.ts:83`).
2. Opaque unit strings in tests (`monetary-amount.test.ts`, `kernel-authority-monetary-constraints.test.ts:35`, `execution-outcome-store.test.ts:227-230`).
3. **Negative structural tests forbidding the vocabulary**, which a naively placed XRPL adapter would trip:
   - `execution-outcome-boundaries.test.ts:242` (`stripe|paymentintent|xrpl|ledger_index|txhash|wallet|seed`, plus `receipt|settlement|retry|poll`)
   - `execution-reconciliation-boundaries.test.ts:254`
   - `core08-action-neutrality-structure.test.ts:29-41, 90` (CORE dirs incl. `src/features/execution-runtime`, `src/enterprise/{governed-action,execution-outcome-store,execution-reconciliation,execution-resolution-store}`)
   - `authority-controlled-execution-boundaries.test.ts:200-206` (`src/enterprise/execution-governance`)
   - `structural-boundaries.test.ts:485-488` (grant runtime), `execution-layer-boundaries.test.ts:240-246`, `ctrl03-structure.test.ts:169-191`, `trusted-context-structure.test.ts:68`, `authority-payment-ceilings-structure.test.ts:99`
   - `no-bypass-effect-paths.test.ts:425-434` pins the outbound-network production sources; a new XRPL client must be added to that inventory.

| Maturity level | Status |
|---|---|
| MOCKED | ABSENT |
| LOCAL UNIT TEST | ABSENT |
| TESTNET-CAPABLE | ABSENT |
| TESTNET-VERIFIED | ABSENT |
| PRODUCTION-CAPABLE | ABSENT |

Doc claims (not code): `docs/architecture/FRONTERA-MASTER-PLAN.md:321` "XRPL … ABSENT"; PAY-04 "XRPL Rail Adapter — PLANNED, depends on PAY-03" (`:1259-1267`); `docs/enterprise/AOC_EXECUTION_ADAPTER_REGISTRY.md:348` lists XRPL as a non-goal.

Usable hooks for a future adapter: a 64-hex tx hash (or `xrpl:testnet:<hash>`) passes `isRecordableProviderRef` (`provider-reference.ts:44-53`); `executionId` can serve as a provider idempotency handle; P12 `ExecutionResolutionAuthority` (`execution-reconciliation/authority.ts:48-90`) is the intended seam for tx-hash-based resolution of `unconfirmed` outcomes.

No network checks were performed in this audit.

---

## 12. Signer Boundary

| Question | Finding | Evidence |
|---|---|---|
| Where signing occurs | `AuthorityArtifactSigner` (five domain-specific methods, no `sign(bytes)`), software mode (`crypto.sign` Ed25519) or external mode (`frontera.external-authority-signer.v1`, one path per operation, client verifies signatures under a pinned key) | `authority-authenticity/signer.ts:25-174`; `external-authority-signer/protocol.ts:33-46`; `external-signer.ts:408-424` |
| What is signed | Grants, revocations, revocation-state, obligation-discharge state, approval state. **No transactions** | `authority-signature.ts:76-84, 170-190` |
| Key access | Software: PEM in `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`, held in a closure (acknowledged risk AA-001: in-process, not HSM/KMS). External: PEM refused in host env; reference signer is a separate loopback process with 0600 key file | `signer.ts:49-151`; `enterprise-configuration.ts:589-606`; `reference-signer-service.ts:206-243` |
| Policy code / adapters access keys? | Not by source (scan tests), but in software mode the PEM is in `process.env`, readable by any in-process code | `authority-authenticity-boundaries.test.ts:92-135`; `execution-adapter-port.ts:26-31` |
| Signing requires a valid grant? | No — the signer signs any well-formed artifact handed to it; reference service: "does not enforce policy" | `reference-signer-service.ts:43-48`; `sqlite-bounded-grant-store.ts:1371` |
| Arbitrary payloads reach signer? | Arbitrary bytes: no. Arbitrary well-formed grants: yes (from any holder of the store port / signer credential) | `external-authority-signer-contract.test.ts:109-122` |
| Rail transaction signer | **ABSENT** | no `signTransaction`/secp256k1/xrpl in production `src`/`packages` |

**Invariant "Policy decides. Grant authorizes. Signer signs only what was granted.":**

- (a) authority/grant signing: **PARTIAL** — policy decides (only `allowed` eligible), grant layer cannot decide (`grant-layer-boundaries.test.ts:159-210`), signatures verified on read; but the signer does not itself require a decision, issuance exclusivity is convention, and the default in-memory store has no signatures.
- (b) rail transaction signing: **NOT ENFORCED** (no rail signer exists). The master plan's PAY-03 ("customer-controlled transaction-signer port") is the planned home (doc claim, `FRONTERA-MASTER-PLAN.md:1247-1257`).

---

## 13. Outcome / Evidence / Receipts

| Capability | Status | Evidence |
|---|---|---|
| Execution attempts (write-ahead) | IMPLEMENTED AND VERIFIED | `execution-outcome-store/contracts.ts:120-146` (`attemptDigest`); `execution-outcome-store.test.ts`, `execution-outcome-concurrency.test.ts`, `durable-monetary-outcomes.e2e.test.ts` |
| Execution outcome | IMPLEMENTED AND VERIFIED | statuses `executed / withheld / execution-failed / execution-unconfirmed`; certainty `confirmed-completed / confirmed-not-completed / unconfirmed` (`execution-outcome.ts:337-489`; `provider-certainty.ts:519-562`) |
| Settlement status | ABSENT (and vocabulary banned in P11/P12) | `execution-outcome-boundaries.test.ts:242` |
| Transaction hash | PARTIAL — one opaque `providerRef` ≤512 chars, "never proof", never dereferenced | `provider-reference.ts:1-53` |
| External receipt / chain validation (ledger index, engine result, validated) | ABSENT — `readExecutionAdapterResult` drops extra fields | `execution-adapter-port.ts:213-252` |
| Unconfirmed → resolved | IMPLEMENTED (port) and VERIFIED with test authorities; **no concrete authority**; no poller/retry (banned) | `execution-reconciliation/authority.ts:48-90`; `execution-reconciliation-e2e.test.ts` |
| Evidence attachment | PARTIAL — evidence bundles projected from governance records; store **in-memory only** | `evidence/evidence-store.ts:58-62`; `composition-root.ts:1807` |
| Durable evidence | PARTIAL — Governance Store, P11 outcome store, authority event stream are durable SQLite; evidence bundles and export packages are in-memory | `sqlite-execution-outcome-store.ts:87-353`; `evidence-store.ts:24-32` |
| Cryptographic authenticity | Hash chains: IMPLEMENTED AND VERIFIED (governance aggregate chain, event stream `previousEventDigest`). Signatures over outcomes/evidence: ABSENT | `governance-store/contracts.ts:226-331`; `authority-event-stream/event-chain.ts:45-206`; `evidence/verifier.ts:46-53` |
| Governance receipt | **ABSENT** — "receipt" exists only for authority-state-freshness witness receipts (unrelated) and is banned in outcome sources | `authority-state-freshness/witness-client.ts:33-38` |
| Event history / audit trail | IMPLEMENTED AND VERIFIED — `governance.decision.committed`, `grant.issued`, `execution.attempt.claimed`, `exercise.reservation.*`, `execution.outcome.observed` (with adapterId, providerRef), `execution.outcome.resolved` | `authority-event-stream/contracts.ts:67-176`; `authority-event-stream-governed-action.test.ts:151` |

Could Frontera produce the target evidence statement today?

| Clause | Status |
|---|---|
| "Agent X requested action Y" | EXISTS (`GovernanceRequestRecord.actorId`, `actionType`) |
| "Policy version Z evaluated it" | PARTIAL (`kernelVersion`, `enterpriseVersion`; Governance Profile id/version/digest bound into grant; policy pack itself not versioned durably) |
| "Destination D was approved by authority A" | ABSENT (no destination approval record) |
| "Grant G authorized the operation" | EXISTS (signed grant in SQLite store, `grant.issued` event, `boundedGrantId` on attempt) |
| "XRPL transaction T executed it" | ABSENT (no adapter; only opaque `providerRef` slot) |
| "Ledger L validated it" | ABSENT (no field; vocabulary banned in P11/P12) |
| "Outcome O was recorded" | EXISTS (P11 terminal observation, event, governance reference) |

The parts that exist are linked by `evaluationId`, `decisionId`, `executionId` and digests across separate stores; no single receipt artifact joins them.

---

## 14. Reevaluation Capability

| Need | Status | Evidence |
|---|---|---|
| Persistent pending action | IMPLEMENTED AND VERIFIED for `approval_required` (durable CORE-05 approval request per committed decision); in-process command port only | `approval-authority/*`; `composition-root.ts:2651-2661`; `governed-action-approvals-host.test.ts:449-461` (no HTTP route) |
| Obligations as hold | IMPLEMENTED AND VERIFIED (per-request discharge) | `governed-action-obligations-host.test.ts` |
| Changed trusted context feeding a new decision | **ABSENT** for the same key — replay returns the stored decision without re-running the Kernel | `decision-commit.ts:136-138` |
| Reevaluation | **ABSENT** — "Re-evaluation itself is NOT implemented" | `governance-store/contracts.ts:408` |
| Preserving action identity | PARTIAL — same idempotency key ⇒ same `requestId` and same decision (approval resume); a new decision requires a new key ⇒ new `requestId` | `identifiers.ts:397-399`; `governed-action-approvals-host.test.ts:65-134` |
| Causality between first and second decision | **ABSENT** — no supersedes/previous-decision field on governed decisions | `governance-store/contracts.ts:147` (`causationId` is for events only) |
| Preventing mutation of material terms | IMPLEMENTED AND VERIFIED for the same key (`IDEMPOTENCY_CONFLICT`; approval subject binds counterparty, amount, parameters, context digest) | `governed-action-orchestrator.test.ts:661-671`; `approval-authority/subject.ts:36-64`; `governed-action-approvals-host.test.ts:337-356` |
| Validity trap | Context-dependent decisions are issuable only until the earliest material fact goes stale (fixtures `maxAgeSeconds: 900`); late approval releases nothing | `orchestrator.ts:554-561`; `governed-action-approvals-adversarial-host.test.ts:189-207` |
| Allowed-but-withheld retry | Same-key retry re-attempts issuance on the same decision (e.g., after a ceiling is raised) | `governed-action-orchestrator.test.ts:638-659` — raised-ceiling case IMPLEMENTED BUT NOT VERIFIED |

**What is available today for "HOLD → approve → same action → GRANT":** only the CORE-05 pattern — policy `require_approval` ⇒ `approval_required` ⇒ approver approves *that decision* in-process ⇒ same-key retry resumes the *same* decision into a grant. This preserves identity and blocks term mutation, but it approves the request, not the wallet, and does not re-run policy against changed context. A true "destination approved → reevaluate" requires new reevaluation semantics (or an explicit design decision to model destination approval as a CORE-05 approval).

---

## 15. Test Evidence

Commands were derived from `package.json` and `.github/workflows/ci.yml` (`npm ci` → `typecheck` → `build` → `lint` → `npm test` → `legal:check`). `npm test` = `build` + `test:root` (`node --test "dist/src/**/*.test.js" "tests/**/*.test.mjs"`) + `test:workspaces`. These steps were run individually. All generated output is gitignored (`node_modules/`, `dist/`, `dist-test/`, `*.tsbuildinfo`); workspace evidence scripts (`compute-*-pinata-boundary-evidence.mjs`) write only to `dist-test/`.

Safety review before running: no `.env` file present (only `.env.example`); no Pinata/Supabase/Stripe/AOC credentials in the environment; `access-grant-pinata-live.test.ts` self-skips without `PINATA_JWT`/`PINATA_TEST_CID`; no Postgres/Supabase code path; no migrations run; no XRPL network access. `lint`, `legal:check`, and the `check:*`/`validate:*` release scripts were not run (not test suites; outside the audit's need).

| # | Command | Result | Counts | Duration |
|---|---|---|---|---|
| 1 | `npm ci --no-audit --no-fund` | exit 0 | — (only deprecation warnings, e.g. `prebuild-install@7.1.3`) | 285 s |
| 2 | `npm run typecheck` (`tsc -b`) | exit 0 | 0 errors | 164 s |
| 3 | `npm run build` (`tsc -b`) | exit 0 | — | 14 s |
| 4 | `npm run test:root` (`node --test "dist/src/**/*.test.js" "tests/**/*.test.mjs"`) | **exit 1** | tests **8931** · suites 1606 · pass **8916** · fail **2** · cancelled 0 · skipped **9** · todo **4** | 653 s |
| 5 | `npm run test:workspaces` (35 workspaces) | exit 0 | tests **1089** · pass **1089** · fail 0 · skipped 0 · todo 0 | 159 s |
| | **Total** | | **10020 tests · 10005 pass · 2 fail · 9 skipped · 4 todo** | |

**The 2 failures are environment-dependent (CRLF checkout), not code defects:**

| Failing test | Cause | Proof |
|---|---|---|
| `src/enterprise/__tests__/authority-administration-service.test.ts:334` — "the HTTP adapter mounts administration only through the service…" (`'the administration route matcher exists'`) | Source-scan regex `/function matchAdministrationRoute[\s\S]*?\n}\n/` cannot match `\n}\r\n` | Applying the test's own `codeOf` + regex: working-tree file (740 `\r`) ⇒ `false`; `git show HEAD:` LF blob ⇒ `true` |
| `src/enterprise/__tests__/structural-boundaries.test.ts:282` — "loadEnterpriseConfiguration never falls back to a hardcoded, non-empty API key…" | Regex `.*\n` — in JavaScript `.` does not match `\r` | Working-tree file ⇒ `false`; HEAD LF blob ⇒ `true` |

Root cause: this worktree is checked out by Windows Git with `core.autocrlf=true` and the repository has no `.gitattributes`; `git ls-files --eol` reports `i/lf w/crlf` for 2892 tracked text files. CI (`ubuntu-latest`, LF checkout) would not hit this. No file was modified to work around it.

**Skipped (9):** `access-grant-pinata-live.test.ts` (no `PINATA_JWT`/`PINATA_TEST_CID` — "live Pinata verification is UNVERIFIED for this run"); one "survives a restart … # SKIP not durable" and seven "provider keeps no persisted representation" / "provider is not durable" conformance cases for in-memory providers (by design).

**Todo (4, reported as `not ok … # TODO`, not counted as failures):** FRONTERA-PROD-01 F1 — "under genuinely independent connections a losing SQLite writer receives a raw SQLITE_BUSY instead of the replay/conflict the serial order implies … Safety holds; classification does not." Relevant to concurrent demo runs against one SQLite file.

**Andrew-relevant suites that passed in this run** (non-exhaustive): `governed-action-orchestrator`, `governed-action-api-endpoint`, `governed-action-trusted-context-host`, `governed-action-approvals-host`, `governed-action-approvals-adversarial-host`, `governed-action-obligations-host`, `authority-payment-ceilings`, `authority-payment-ceilings-structure`, `kernel-authority-monetary-constraints`, `core08-action-neutrality-host`, `core08-action-neutrality-structure`, `no-bypass-effect-paths`, `authority-artifact-authenticity`, `external-authority-signer-contract`, `execution-outcome-store`, `durable-monetary-outcomes(.e2e)`, `execution-reconciliation-e2e`, `authority-event-stream-governed-action`, `src/features/execution-runtime/tests/*`, `src/features/grant-runtime/tests/*`, `src/features/monetary-runtime/tests/*`, `src/kernel/__tests__/*`; workspace `transfer-mandate`, `access-grant`, `grant-revocation`, `governed-authority`, `pinata-adapter`.

**Not run:** `npm run lint`, `legal:check`, `check:*`, `validate:*`, `protocol:*`, `backup/restore`, `start:*`, `demo:commercial` — not test suites and/or start servers or write release artifacts. No XRPL tests exist to run. No real-network or production-connected test was executed.

---

## 16. Andrew Gap Matrix

| # | Capability | Status | Evidence | Relevant paths | Existing tests | Gap | Required future task |
|---|---|---|---|---|---|---|---|
| 1 | GovernedAction can represent the $75k request | PARTIAL | intent has `action`, `resource`, `amount{value,currency}`, `counterparty`, `parameters`, `idempotencyKey`; USD needs host asset config | `governed-action/contracts.ts:65-99`; `intent.ts` | `governed-action-api-endpoint.test.ts` | no destination/network semantics beyond opaque counterparty | P0-01 |
| 2 | Agent identity exists | READY | `ActorType 'agent'`, agent credentials | `recognition-runtime/domain/actor.ts:1`; `operator-control/agent-credentials.ts` | `authority-payment-ceilings.test.ts`, `ctrl02-*-host.test.ts` | — | VERIFY in P0-09 |
| 3 | Agent authority can be evaluated | READY | delegation lineage + financial authority resolver | `financial-authority-resolver.ts`; `delegation-service.ts` | `authority-payment-ceilings.test.ts`, `delegation-service.test.ts` | — | VERIFY in P0-05 |
| 4 | $100k monetary ceiling can be represented | READY | `max_amount{currency:'USD', value:'100000'}` | `authority-grant.ts:10-23`; `monetary-constraints.ts` | `kernel-authority-monetary-constraints.test.ts` | needs USD in host asset registry (config) | P0-05 (config) |
| 5 | $75k vs $100k evaluated safely | READY (logic) | exact BigInt decimal compare | `issuance-core.ts:302-305`; `canonical-decimal.ts` | `authority-payment-ceilings.test.ts:315, 385` (other magnitudes) | specific magnitudes untested | P0-05 (test) |
| 6 | Destination wallet can be represented | PARTIAL | opaque `counterparty` string only; no network/address type | `contracts.ts:68`; `grant-adapter.ts:127` | `kernel-grant-self-assertion.test.ts:181-223` | first-class destination (network, address, asset scope) | P0-01 |
| 7 | Destination approval state exists | MISSING | fixture-only boolean fact | `core04-host-fixture.ts:153, 192` | `governed-action-trusted-context-host.test.ts:185` (fixture) | registry with state | P0-02 |
| 8 | Unknown destination causes HOLD/DENY | PARTIAL | deny via policy rule on a fact (fixture), but fact not bound to the requested destination | `context-resolver-port.ts:13-24`; `core08-reference-domains-fixture.ts:190` | `core08-action-neutrality-host.test.ts:309-312` (TR-2) | destination-aware trusted context + policy | P0-04, P0-05 |
| 9 | No grant emitted after HOLD/DENY | READY | status gate before issuance | `orchestrator.ts:715-720` | `governed-action-orchestrator.test.ts:170-178` | — | VERIFY in P0-09 |
| 10 | Adapter cannot execute without grant | PARTIAL (runtime + source-scan; not type-enforced; adapter doesn't verify) | `grant-execution-service.ts:290-514` | same | `no-bypass-effect-paths.test.ts:172-269`; `execution-exercise.test.ts:150` | XRPL adapter must be registered in no-bypass inventory | P0-06 |
| 11 | Destination approved through governed mechanism | MISSING | CORE-05 approves decisions not wallets; no route (CTRL-04 unbuilt) | `approval-authority/*` | `governed-action-approvals-host.test.ts:449-461` | governed destination-approval command + route | P0-03 |
| 12 | Approval is durable | MISSING (for destinations) | CORE-05 approvals are durable SQLite+signed (decision-scoped) | `approval-authority/contracts.ts` | `approval-authenticity.test.ts` | destination approval store | P0-02/P0-03 |
| 13 | Approval has evidence/provenance | MISSING (for destinations) | CORE-05 commands require evidence sha256 (decision-scoped) | `approval-authority/contracts.ts:74-104` | `approval-lifecycle.test.ts` | destination approval provenance | P0-03 |
| 14 | Same action can be reevaluated | MISSING | "Re-evaluation itself is NOT implemented" | `governance-store/contracts.ts:408`; `decision-commit.ts:136-138` | — | reevaluation semantics | **Hidden prerequisite** (see §19) |
| 15 | Reevaluation preserves action identity | MISSING | new decision ⇒ new key ⇒ new `requestId`; no causality link | `identifiers.ts:397-399` | — | causal link + term immutability across decisions | Hidden prerequisite |
| 16 | Grant binds actor | READY | `subject` | `bounded-grant.ts:53-106` | `grant-issuance.test.ts` | — | — |
| 17 | Grant binds amount | READY | `scope.amount` ceiling from authority | `grant-adapter.ts:104-118` | `kernel-grant-no-request-ceiling.test.ts`; `execution-exercise.test.ts` | ceiling not exact amount (grant permits ≤ ceiling) | P0-05/P0-08 review |
| 18 | Grant binds asset | PARTIAL | `amount.unit` string only | `grant-bound.ts:57-59` | `execution-exercise.test.ts` (unit mismatch) | network/issuer semantics | P0-01 |
| 19 | Grant binds destination | PARTIAL | `counterparty` exact identity | `grant-adapter.ts:127`; `grant-exercise-assessment.ts:154` | `core08-action-neutrality-host.test.ts:345` | destination = network+address, not opaque string | P0-01 |
| 20 | Grant binds rail/adapter | MISSING | no axis; host routing only | `execution-adapter-registry.ts` | — | rail binding | P0-06 (or PAY-03) |
| 21 | XRPL adapter exists | MISSING | — | — | — | entire adapter | P0-06 |
| 22 | XRPL Testnet configuration exists | MISSING | — | — | — | config + funded test wallet | P0-07 |
| 23 | XRPL signer boundary exists | MISSING | no rail signer | — | — | transaction signer bound to validated action | P0-06 (hidden prereq: signer boundary) |
| 24 | Real XRPL transaction can be submitted | MISSING | — | — | — | client + submit | P0-06/P0-08 |
| 25 | Validation can be awaited | MISSING | — | — | — | wait-for-validated / LastLedgerSequence | P0-06/P0-08 |
| 26 | Tx hash can be captured | PARTIAL | `providerRef` accepts 64-hex | `provider-reference.ts:44-53` | `execution-outcome-store.test.ts` | adapter to produce it | P0-06 |
| 27 | Ledger/result metadata can be captured | MISSING | result fields stripped; vocabulary banned in P11/P12 | `execution-adapter-port.ts:213-252` | `execution-outcome-boundaries.test.ts:242` (forbids) | outcome evidence extension outside CORE | P0-08 |
| 28 | Outcome can be persisted | READY | P11 SQLite write-ahead + terminal observation | `execution-outcome-store/*` | `durable-monetary-outcomes.e2e.test.ts` | — | VERIFY in P0-08 |
| 29 | Evidence can be persisted | PARTIAL | governance store/event stream durable; evidence bundles in-memory | `evidence/evidence-store.ts:58-62` | `evidence-integrity.test.ts` | durable evidence for rail result | P0-08 |
| 30 | Governance receipt can be produced | MISSING | no receipt type | — | — | receipt joining decision, approval, grant, tx, ledger, outcome | P0-08/P0-09 (unassigned — see §19) |
| 31 | $125k over-ceiling can be denied | PARTIAL | yields **WITHHELD** (`authority-binding`, `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`), decision `allowed`; literal DENY needs a policy rule | `issuance-core.ts:304` | `authority-payment-ceilings.test.ts:315-321`; `core08-action-neutrality-host.test.ts:314-325` | terminology decision (WITHHELD vs DENY) + test at 125k/100k | P0-10 |
| 32 | Over-ceiling denial guarantees no execution | READY | zero grants, reservations, adapter calls | `issuance-core.ts:513-514` | `authority-payment-ceilings.test.ts:315-326` | — | VERIFY in P0-10 |
| 33 | Demo can be executed deterministically | UNKNOWN | spine is deterministic (injected clocks, idempotency); XRPL Testnet introduces external non-determinism (fees, ledger timing, faucet) | — | — | determinism plan for Testnet | P0-09/P0-11 |
| 34 | Demo can be run from one command | MISSING | stock launcher composes no policy/context provider; no demo script | `scripts/run-enterprise-host.mjs:41`; `host/enterprise-host.ts:72-91` | — | embedder harness | P0-11 |

Summary: READY 9 · PARTIAL 9 · MISSING 15 · UNKNOWN 1 (34 rows).

---

## 17. DO NOT REBUILD — Freeze List

Each item has passing executed tests in this run (§15) and source evidence cited above.

| Item | Why it is frozen | Evidence |
|---|---|---|
| GovernedAction envelope & closed intent validation | Closed key set, reserved keys, identity from bound credential only | `governed-action/intent.ts`, `contracts.ts`; `governed-action-orchestrator.test.ts`, `governed-action-api-endpoint.test.ts` |
| Kernel (`AocKernel.evaluate`) and status model | Single decision producer; four statuses; reason codes | `src/kernel/`; `src/kernel/__tests__/*` |
| Decision commit-before-act, idempotency, replay | Durable, verified decisions; ≤1 adapter call under concurrency | `decision-commit.ts`; `governed-action-orchestrator.test.ts:619-714` |
| Trusted Context Boundary | Authoritative, org-scoped, fresh facts; smuggling refused (extend the query, do not replace the boundary) | `trusted-context/`; `governed-action-trusted-context-host.test.ts` |
| Monetary semantics (canonical decimal, asset registry, no-FX comparison, classifier) | Exact, fail-closed, cross-asset incomparable | `src/features/monetary-runtime/domain/*`; `monetary-amount.test.ts`, `canonical-decimal.test.ts` |
| Agent identity, credentials, delegation | First-class agent, narrow-only delegation | `kernel-authority/`, `authority-graph/`, `operator-control/agent-credentials.ts` |
| P10 financial authority (`max_amount`, `spending_limit`) | Ceiling from authority, never request; pre-grant; re-checked at commit; per-asset | `financial-authority-resolver.ts`; `issuance-core.ts`; `authority-payment-ceilings.test.ts` |
| Bounded grant model, issuance service, signed SQLite grant store | Single issuance path; Ed25519 verification on read | `grant-runtime/`, `bounded-grant-store/`; `authority-artifact-authenticity.test.ts` |
| Grant exercise gate (`GrantExecutionService`) | The only path to `adapter.execute`; refusal ⇒ no adapter | `grant-execution-service.ts`; `execution-exercise.test.ts`, `no-bypass-effect-paths.test.ts` |
| `ExecutionAdapter` port + registry routing | Rail-neutral seam an XRPL adapter should implement | `execution-adapter-port.ts`; `execution-adapter-registry.ts`; `execution-adapter-registry.test.ts` |
| Exercise-control ledger | At-most-once per `executionId`, count/aggregate limits | `exercise-control-ledger/`; `execution-exercise-control.test.ts` |
| P11 durable execution outcomes | Write-ahead attempt + write-once terminal observation | `execution-outcome-store/`; `durable-monetary-outcomes.e2e.test.ts` |
| P12 resolution port | Seam for tx-hash-based resolution of `unconfirmed` | `execution-reconciliation/authority.ts`; `execution-reconciliation-e2e.test.ts` |
| Authority-artifact signer (software/external) | Domain-separated Ed25519; pattern to mirror for a rail signer, not to repurpose | `authority-authenticity/`, `external-authority-signer/`; `external-authority-signer-contract.test.ts` |
| CORE-05 durable approvals | Exact-subject approval, signed log, resume-same-decision | `approval-authority/`; `governed-action-approvals-host.test.ts` |
| Governance Store hash chain & authority event stream | Durable, chained audit trail | `governance-store/`, `authority-event-stream/`; `governance-store-sqlite.test.ts`, `authority-event-stream-governed-action.test.ts` |
| CTRL-02 operator plane (provisioning over HTTP) | Durable, attributed operator writes with closed roles | `operator-control/`; `ctrl02-operator-plane-host.test.ts` |

---

## 18. Expected Change Surface

**LIKELY REUSE UNCHANGED**

- `src/kernel/**`
- `src/features/monetary-runtime/domain/**`
- `src/features/grant-runtime/**`, `src/enterprise/bounded-grant-store/**`
- `src/features/execution-runtime/**` (port, registry, exercise service)
- `src/enterprise/execution-outcome-store/**`, `src/enterprise/execution-resolution-store/**`
- `src/enterprise/authority-authenticity/**`, `src/enterprise/external-authority-signer/**`
- `src/enterprise/exercise-control-ledger/**`
- `src/enterprise/governance-store/**` (except a reevaluation/causality addition, if chosen)
- `src/enterprise/authority-event-stream/**`
- `src/enterprise/kernel-authority/**`, `src/features/authority-graph/**`

**LIKELY EXTEND**

- `src/features/context-resolution-runtime/domain/context-resolver-port.ts` and `src/kernel/orchestration/context-adapter.ts:171-180`, `src/enterprise/governed-action/kernel-request.ts:485-503` — carry the destination (counterparty) to trusted-context resolution (or set `targetId`).
- `src/enterprise/governed-action/orchestrator.ts`, `decision-commit.ts`, `identifiers.ts` — reevaluation of the same business action with a causal link (if that design is chosen over CORE-05 approval-as-hold).
- `src/enterprise/approval-authority/**` / operator-control routes in `src/enterprise/adapters/node-http-adapter.ts` — governed approval route (overlaps CTRL-04).
- `src/enterprise/host/host-configuration.ts` / `src/enterprise/composition/composition-root.ts` — compose destination registry, XRPL adapter, assets.
- `src/enterprise/evidence/**` — durable evidence/receipt.
- Structural test inventories that must be **amended deliberately** (not weakened): `src/enterprise/__tests__/no-bypass-effect-paths.test.ts:192-222, 425-434`.

**LIKELY NEW**

- Destination domain + registry (suggested home outside CORE dirs, e.g. a new `src/enterprise/destination-registry/` and/or `packages/…`).
- Destination-aware `ContextProvider` implementation backed by the registry.
- Andrew policy pack (`require_approval`/`deny` on unapproved destination; optional amount rule for literal DENY).
- `src/enterprise/execution-adapters/xrpl/` (ExecutionAdapter impl) + XRPL dependency + rail signer boundary.
- XRPL `ExecutionResolutionAuthority` (tx-hash lookup) for `unconfirmed`.
- Governance receipt builder.
- `scripts/` demo harness (embedder composing policy, context provider, adapter) + `docs/demo/andrew/**`.

**MUST NOT TOUCH WITHOUT STRONG REASON**

- `src/features/execution-runtime/domain/execution-adapter-port.ts` (rail-neutral port; neutrality tests)
- `src/features/execution-runtime/services/grant-execution-service.ts` (the no-bypass gate)
- `src/enterprise/execution-governance/issuance-core.ts`, `src/features/grant-runtime/services/grant-issuance-service.ts`
- `src/enterprise/execution-outcome-store/**`, `src/enterprise/execution-reconciliation/**` (P11/P12 vocabulary bans)
- `src/features/monetary-runtime/domain/canonical-decimal.ts`, `monetary-amount.ts`
- `src/enterprise/authority-authenticity/authority-signature.ts`
- All `*-structure.test.ts` / `*-boundaries.test.ts` negative-vocabulary tests (`core08-action-neutrality-structure.test.ts`, `execution-outcome-boundaries.test.ts`, `execution-reconciliation-boundaries.test.ts`, `authority-controlled-execution-boundaries.test.ts`, `structural-boundaries.test.ts`, `execution-layer-boundaries.test.ts`) — XRPL code must live outside their scanned roots rather than loosen them.
- Database schemas/migrations of existing SQLite stores.

---

## 19. Dependency Graph / Task Sequence

| Task | Evaluation | Notes |
|---|---|---|
| ANDREW-P0-01 Destination Semantics | **VALID** | Nothing exists beyond opaque `counterparty`. Must decide: destination ≙ `counterparty` (reuses grant binding and exercise check) vs a typed parameter; network + address + asset scope; address validation outside CORE. Overlaps master-plan PAY-01 "Payee/instrument reference" (doc claim). |
| ANDREW-P0-02 Destination Registry | **VALID** | Absent. Durable store with approval state, approver, evidence, timestamps, expiry, revocation, org/asset/action scope. |
| ANDREW-P0-03 Admin Approval Flow | **VALID — coordinate with CTRL-04** | CORE-05 approvals exist (decision-scoped, in-process); no HTTP approval route; CTRL-04 ("approval escalation workflow") is the master plan's NEXT item and has an active sibling worktree. Destination approval could reuse CTRL-02 operator roles/routes. |
| ANDREW-P0-04 Trusted Context | **VERIFY/EXTEND** | Trusted Context Boundary exists and is verified; the gap is that `ContextResolutionQuery` lacks the counterparty/destination. Hidden sub-task: extend the query (CORE-touching; needs care with neutrality tests). |
| ANDREW-P0-05 $75K Policy | **VERIFY/EXTEND** | Policy packs, `require_approval`/`deny`, P10 ceilings exist. New: Andrew pack + asset config + tests at 75k/100k. Note policy amount thresholds are currency-blind. |
| ANDREW-P0-06 XRPL Adapter | **VALID — hidden prerequisites** | Absent. Requires (a) a rail **transaction signer boundary** (master plan PAY-03 territory), (b) placement outside CORE scan roots, (c) no-bypass inventory update, (d) mapping canonical amount → drops/IOU amount. |
| ANDREW-P0-07 XRPL Testnet Bootstrap | **VALID** | Absent (wallet generation/funding, network config, secret handling). |
| ANDREW-P0-08 Real-Rail Integration | **VALID** | Absent. Must decide where ledger index/engine result/validated live (P11 bans the vocabulary) and build the governance receipt (unassigned otherwise). |
| ANDREW-P0-09 Andrew E2E Scenario | **VALID — depends on reevaluation decision** | |
| ANDREW-P0-10 Ceiling Variant | **VERIFY/EXTEND** | Mechanism exists and is tested (WITHHELD, no grant, no adapter). Remaining: 125k/100k test with approved destination; decide whether demo language says "WITHHELD" or adds a policy rule to produce a literal Kernel DENY. |
| ANDREW-P0-11 One-Command Demo Harness | **VALID** | Absent; stock launcher composes no policy/context provider. |

**Hidden prerequisites (not represented in the sequence):**

1. **Reevaluation semantics** (gap rows 14–15). The sequence assumes "reevaluate the SAME business action", which the code explicitly does not implement. A design decision is required before P0-03/P0-09: either (A) model the hold as CORE-05 `approval_required` and resume the same decision (exists, but approves the request, not the wallet, and does not re-run policy), or (B) add governed reevaluation with a causal link and term immutability (new CORE-adjacent work). Recommend inserting this as a sub-task of P0-04 or a decision record before P0-03, **without renumbering**.
2. **Destination-aware trusted-context query** (inside P0-04).
3. **Rail transaction signer boundary** (inside P0-06; master plan PAY-03).
4. **Governance receipt** has no owning task; assign to P0-08 or P0-09.
5. **Roadmap coordination**: the master plan sequences PAY-01 → PAY-03 → PAY-04 (XRPL) and names CTRL-04 as NEXT (doc claims). The Andrew track should either be explicitly declared a demo track that does not satisfy PAY-0x exit criteria, or align P0-01/P0-06 with PAY-01/PAY-03 to avoid divergent rail ports.

```
P0-01 Destination Semantics
   └─► P0-02 Destination Registry
          ├─► P0-03 Admin Approval Flow ◄── (coordinate CTRL-04)
          └─► P0-04 Trusted Context (+ destination-aware query, + reevaluation decision*)
                 └─► P0-05 $75K Policy
P0-06 XRPL Adapter (+ rail signer boundary*) ──► P0-07 Testnet Bootstrap ──► P0-08 Real-Rail Integration (+ receipt*)
P0-03, P0-05, P0-08 ──► P0-09 Andrew E2E ──► P0-10 Ceiling Variant ──► P0-11 One-Command Harness
(* = hidden prerequisite; P0-06/07 can proceed in parallel with P0-01…05)
```

---

## 20. Demo Definition of Done

The Andrew demo is DONE when all of the following are demonstrated by an automated, repeatable run and backed by tests:

- **A. Unknown destination blocks.** Agent submits `{amount: 75000 USD-or-configured-asset, destination: D}` where D is not approved ⇒ HOLD (`approval_required`/withheld) or DENY; asserted: zero `grant.issued` events, zero bounded-grant store writes, zero adapter calls, zero signer calls, zero XRPL submissions.
- **B. Governed approval.** D is approved through a governed, authenticated, role-checked mechanism (not a DB edit, not a config change), producing a durable approval record with approver identity, evidence digest, timestamp, scope (org, network, asset, action) and optional expiry; revocable.
- **C. Same business action.** The same business action (same agent, amount, asset, destination, purpose) is reevaluated or resumed; any change to material terms is refused; the second decision is causally linked to the first.
- **D. Grant.** With D approved and amount ≤ ceiling, a signed bounded grant is issued binding actor, action, amount ceiling, asset, destination and (if implemented) rail.
- **E. Order of effects.** Adapter, signer and XRPL Testnet are reached only after a valid grant passes the exercise gate; the signer signs only a Payment whose destination, amount and asset equal the validated action.
- **F. Real ledger result.** XRPL Testnet returns a real transaction hash, `validated: true`, `TransactionResult: tesSUCCESS`, a ledger index, and delivered amount — independently checkable on a public Testnet explorer.
- **G. Persistence.** Frontera durably records: decision(s), approval provenance, grant, execution attempt and outcome, rail evidence (hash, ledger, result) and a governance receipt that joins them and verifies offline.
- **H. Ceiling variant.** Approved D + `125000` against a `100000` ceiling ⇒ refused before any grant (reported as DENY or, per the chosen terminology, WITHHELD `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`) ⇒ no grant, no adapter, no signer, no XRPL submission.
- **I. Repeatable.** The scenario can be re-run from a clean state with identical governance outcomes (only Testnet-assigned values — hash, ledger index, fee — differ).
- **J. No manual DB edits** at any point during the presentation.
- **K. No fabricated rail data.** No mocked transaction hash, ledger index, or result appears on the success path; mocks are confined to tests.

---

## 21. Risks / Unknowns

1. **Reevaluation is a design decision, not a configuration.** Choosing CORE-05 resume vs new reevaluation semantics shapes P0-03/P0-04/P0-09. Risk of CORE changes against heavily guarded code.
2. **WITHHELD vs DENY terminology** for the ceiling variant: the codebase deliberately refuses to rewrite an over-ceiling result as a policy denial (`authority-payment-ceilings-structure.test.ts:146`). Demo narrative must align or a policy rule must be added.
3. **Structural negative-vocabulary tests** will fail any XRPL/wallet/ledger/receipt/settlement term placed in CORE roots — XRPL and receipt code must live elsewhere; ledger metadata cannot go into P11 records as-is.
4. **Context freshness window**: decisions relying on trusted context are issuable only until the earliest fact goes stale (fixtures: 900 s). An approval step during a live demo must complete within that window, or the design must avoid the trap.
5. **Default composition is weaker than required**: in-memory grant store (no signatures), Kernel Authority disabled by default, exercise controls optional, no policy/context provider in the stock launcher. The demo host must explicitly compose SQLite persistence, Kernel Authority, exercise controls (`count:1` for single-use), assets, policy and context.
6. **Kernel Authority ceilings are hash-chained, not signed** (DB writer could re-seal a widened ceiling).
7. **Software signer key in process env** (AA-001) unless external signer mode is used.
8. **XRPL amount semantics**: XRP drops (6 decimals) vs IOU 15-significant-digit amounts; RLUSD issuer identity; a USD ceiling cannot bound an XRP/RLUSD payment (no FX).
9. **Testnet non-determinism**: faucet availability, resets, fees, ledger close timing.
10. **Roadmap collision** with CTRL-04 (active sibling worktree) and PAY-01/03/04.
11. **origin/main freshness**: the local `origin/main` ref was not re-fetched for this audit; HEAD equals the local tracking ref.
12. **Tooling**: WSL git cannot read this worktree's Windows-path `.git` pointer; Windows Git must be used (or the pointer adjusted by the owner).

---

## 22. Final Verdict

**A. BASELINE ESTABLISHED — READY FOR ANDREW-P0-01**

Rationale: the worktree is the intended isolated Andrew worktree on the intended branch, clean at start, with HEAD equal to `origin/main`. Typecheck and build are clean. 10005 of 10020 tests pass; the only 2 failures are proven CRLF-checkout artifacts of source-scan regexes, not product defects. Every Andrew-relevant capability has been classified with evidence. ANDREW-P0-01 (Destination Semantics) depends on nothing that is missing. The hidden prerequisites (reevaluation semantics, a destination-aware context query, a rail signer boundary, receipt ownership, CTRL-04/PAY coordination) block later tasks, not P0-01, and are recorded in §19.

- **Baseline HEAD:** `fe277ea5c607ef38f5700b3b698b3299e516fdff`
- **Tests executed:** 10020 (root 8931 + workspaces 1089), after a clean `npm ci`, `typecheck` and `build`
- **Tests passing:** 10005 (plus 9 skipped, 4 todo)
- **Tests failing:** 2, both environment-dependent CRLF artifacts (`authority-administration-service.test.ts:334`, `structural-boundaries.test.ts:282`); each passes against the committed LF source
- **Files modified:** `docs/demo/andrew/ANDREW-P0-00-BASELINE-FREEZE.md` (new)
- **Implementation files modified:** NO
- **Recommended next task:** ANDREW-P0-01 Destination Semantics. Before ANDREW-P0-03, record a decision on reevaluation: CORE-05 approval-resume or new governed reevaluation.
- **Blocking issues:** none for ANDREW-P0-01. Non-blocking for P0-01:
  - (1) The reevaluation design decision must precede P0-03/P0-09.
  - (2) The Windows CRLF checkout makes 2 structure tests fail locally. Run the suites from an LF checkout, or have the repository owner add a `.gitattributes` in a separate task.
  - (3) Coordinate with CTRL-04 and PAY-01/03/04.
