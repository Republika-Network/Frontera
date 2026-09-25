# Frontera Security Invariants

- Status: canonical. This is the single authoritative statement of what Frontera guarantees, where each guarantee stops, and what is not yet implemented.
- Established by: Security & Containment Architecture track, Prompt 1.
- Baseline evidence: `SECURITY_CONTAINMENT_BASELINE_AUDIT.md` (Prompt 0).
- Companion documents: `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` (canonical: the complete effect-path inventory, what authorizes each effect, and the resource-centric no-bypass analysis), `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` (canonical: trust domains, TCB, privileged assets, authority-write and effect maps, chokepoints, bypass primitives), `docs/security/AUTHORITATIVE_GRANT_STORE.md` (canonical: how bounded grants and revocations are persisted, what that guarantees, and where it stops), `docs/security/THREAT_MODEL_V1.md`, `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md` (the SaaS surface), `docs/security/SECURITY_HARDENING_V1.md`, `docs/kernel/AOC_KERNEL_INVARIANTS_V1.md` (Kernel-scoped), `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.

---

## 1. Purpose

This document defines, for every security property Frontera claims:

1. **the guarantee** — what is actually true;
2. **the scope** — the exact path, layer, component or boundary it holds within;
3. **the enforcement mechanism** — how it is prevented from regressing;
4. **the evidence** — the file, line, or test that proves it;
5. **the boundary** — where the guarantee stops being true;
6. **the implementation status** — enforced, partially enforced, or not implemented.

It exists because the repository's guarantees are unusually strong **within specific paths** and absent outside them. Stating a path-local guarantee without its scope is the most likely way this project would accidentally overclaim. Every entry below therefore carries a scope, and the scope is part of the invariant — not a footnote to it.

`docs/kernel/AOC_KERNEL_INVARIANTS_V1.md` remains authoritative for the Kernel's own ten decision-engine invariants and is not superseded by this document; it is Kernel-scoped, and this document is the cross-cutting artifact that places it alongside every other guarantee.

---

## 2. Security Model

Three distinctions govern how this repository reasons about authority.

```
Intelligence  !=  Authority     an actor that can determine what to do has not thereby been permitted to do it
Capability    !=  Permission    an actor that can technically reach an effect has not thereby been authorized to produce it
Intent        !=  Mandate       an actor's declared purpose is not a grant; a mandate is held by a trusted store, not asserted by the actor
```

The security objective is **not** "prevent an agent from ever becoming malicious." It is:

> prevent malicious intent from automatically obtaining legitimate authority or technical capability to produce privileged effects.

That objective has two halves, and this repository is strong in one and absent in the other. They must never be collapsed:

| | Question it answers | Frontera today |
|---|---|---|
| **Authorization security** | Is this actor legitimately allowed to perform this *declared* action? | Mature. Single decision producer, narrowing-only composition, fail-closed bounded-grant exercise, structural boundary tests that fail CI. |
| **Containment security** | What can this actor technically reach, execute, mutate, read, exfiltrate or destroy if it behaves maliciously? | Essentially absent. No process isolation, no egress control, no capability dropping, no aggregate bounding, no durable kill switch. |

Every invariant in §4 is an authorization-security or structural-hygiene invariant. Every entry in §7 is a containment-security invariant, and every one of them is unimplemented or partial.

---

## 3. Scope Vocabulary

Every invariant carries exactly one scope.

| Scope | Meaning |
|---|---|
| **SYSTEM-WIDE** | Proven to hold across every relevant production path in this repository. Where a named exception exists, the invariant is not system-wide and must be scoped down instead. |
| **LAYER-LOCAL** | Holds only within named architectural layers (`ADR-AUTHORITY-CONTROL-LAYERING.md` A–G). Says nothing about other layers. |
| **PATH-LOCAL** | Holds only for one end-to-end execution/effect path. Says nothing about the other effect paths in §5. |
| **COMPONENT-LOCAL** | Holds only for a specific named service, store, module or application. |
| **DEPLOYMENT-CONTRACT** | Depends on infrastructure or operator configuration outside this repository's control. The repository can state the requirement; it cannot enforce it. |
| **ASPIRATIONAL-UNIMPLEMENTED** | A desired property that is not currently enforced by anything. Recorded so it cannot be mistaken for a guarantee. |

Enforcement strength is stated separately, and more than one value may apply:

| Enforcement | Meaning |
|---|---|
| **STRUCTURAL** | A build- or test-time check fails if the property is violated, independent of runtime input. |
| **RUNTIME** | Production code checks the condition at runtime and fails closed. |
| **TYPE-LEVEL** | The TypeScript type system makes the violation unexpressible. |
| **TEST-ENFORCED** | A test asserts the behaviour; `npm test` runs on every PR and push to `main` (`.github/workflows/ci.yml`). |
| **DOCUMENTED** | Stated in an ADR, doc comment or design document, with no structural or runtime mechanism proving it. |
| **DEPLOYMENT-DEPENDENT** | Holds only if the operator configures the deployment as documented. |
| **NOT IMPLEMENTED** | No mechanism exists. |

`DOCUMENTED` alone is never a guarantee. It records intent.

---

## 4. Enforced Invariants

### 4.1 Decision production and authority composition

| ID | Invariant | Scope | Enforcement | Evidence | Boundary |
|---|---|---|---|---|---|
| SEC-INV-001 | The Kernel is the only producer of a Frontera **authorization decision**: contributing layers annotate or narrow, and no other component forms an allow. | LAYER-LOCAL to the `src/kernel` + `src/features` + `src/enterprise` authorization pipeline | STRUCTURAL + TEST-ENFORCED + DOCUMENTED | `ADR-AUTHORITY-CONTROL-LAYERING.md` §4; `src/enterprise/__tests__/structural-boundaries.test.ts:300-505`; `src/features/execution-runtime/tests/execution-layer-boundaries.test.ts:160-223` | **Not repository-wide.** `packages/agent-governance`'s `evaluateAgentRuntimeGuard` produces its own independent `allow`/`deny`/`require_human_approval` outcome and is never consulted by the Kernel. The Sovereign Access path makes its own lifecycle determination (`assertActive`, `src/enterprise/access-governance/lifecycle.ts:20`). Both are separate decision producers outside this invariant. |
| SEC-INV-002 | Narrowing-only composition: the governed-authority, context, obligation and grant steps may deny, annotate or withhold, but may not widen an outcome or create an allow. | LAYER-LOCAL to the Kernel pipeline | STRUCTURAL + TEST-ENFORCED | `AocKernel.ts:357,366,376,386`; `structural-boundaries.test.ts:428,499-505` asserts `applyGrantStep` reads none of `result.status`/`reasonCodes`/`summary`/`policies` | Says nothing about what an already-allowed decision's executor then does — see SEC-INV-009. |
| SEC-INV-003 | No action is allowed for an unrecognized actor. | PATH-LOCAL to `AocKernel.evaluate()` / `enforce()` | RUNTIME + TEST-ENFORCED | `assertRecognitionPrecedesAllow`, `src/kernel/orchestration/kernel-invariants.ts:14-20`; asserted on every call; `AOC_KERNEL_INVARIANTS_V1.md` §1 | Recognition state is held in process memory by default (see SEC-TRUST-003). |
| SEC-INV-004 | Every terminal Kernel result carries machine-readable reason codes. | PATH-LOCAL to `AocKernel.evaluate()` / `enforce()` | RUNTIME + TEST-ENFORCED | `assertReasonCodesPresent`, `kernel-invariants.ts:23-27` | — |
| SEC-INV-005 | Evaluation never mutates the caller's request. | PATH-LOCAL to `AocKernel.evaluate()` / `enforce()` | RUNTIME + TEST-ENFORCED | `cloneKernelEvaluationRequest` + `deepEqual` (`Object.is`, Date-by-epoch), `kernel-invariants.ts:29-59` | — |
| SEC-INV-006 | An optional capability port that is not configured leaves behaviour byte-identical to that layer not existing. | LAYER-LOCAL to Kernel optional ports | TEST-ENFORCED + DOCUMENTED | `ADR-AUTHORITY-CONTROL-LAYERING.md` §6; `src/kernel/__tests__/characterization/*-capability-absent.test.ts` | — |
| SEC-INV-007 | Grant eligibility reported by `evaluate()` is a projection only: no grant is issued, no store is written, and the Governance Record is unchanged. | PATH-LOCAL to `AocKernel.evaluate()` | STRUCTURAL + TEST-ENFORCED | `structural-boundaries.test.ts:486-497` — no production Kernel source may import the issuance path or the grant store, and `KernelEvaluationResult` may not carry a `BoundedGrant` | — |

### 4.2 Effect-path invariants

These are the highest overclaim risk in the repository. Each is scoped to exactly one path in §5.

| ID | Invariant | Scope | Enforcement | Evidence | Boundary |
|---|---|---|---|---|---|
| SEC-INV-008 | The evaluation path produces no external effect: it invokes no executor, no adapter, and performs no outbound I/O. | PATH-LOCAL to `AocKernel.evaluate()` and `POST /api/governance/evaluate` | STRUCTURAL + RUNTIME | `AocKernel.ts:311-390` contains no invocation site; `src/kernel` production sources import only `crypto`; `src/enterprise/__tests__/security-invariants.test.ts` | Persisting the Governance Record is a local durable write, not an external effect. |
| SEC-INV-009 | `AocKernel.enforce()` invokes the caller-supplied executor **only** when preflight resolves to `execute_allowed`; every other outcome returns without calling it. | PATH-LOCAL to `AocKernel.enforce()` | RUNTIME + TEST-ENFORCED | `GuardedExecutionService.run`, `src/features/action-enforcement/services/guarded-execution-service.ts:35-105` — the single `await execute()` at `:105` is preceded by the unconditional return at `:39-91` | This is **decision-time** authorization. See SEC-INV-010. |
| **SEC-INV-010** | **LIMIT.** `AocKernel.enforce()` does **not** bind the executor's actual external effect to the declared `ActionDescriptor`. The executor is an opaque closure; nothing structural, cryptographic or runtime-level verifies that what it does matches what was authorized. | PATH-LOCAL to `AocKernel.enforce()` | NOT IMPLEMENTED — stated as a first-class boundary, not a defect | `guarded-execution-service.ts:105` accepts `() => Promise<T> \| T` and inspects nothing; `src/enterprise/execution-governance/service.ts:56-64` records the accepted architectural reading | A Governance Record produced through `enforce()` attests the **declaration**, not the effect. Effect-time binding is what the bounded-grant path provides instead (SEC-INV-011). Closing SC-003 is a claiming decision, not a Kernel redesign: grants deliberately do not gate `enforce()`. |
| SEC-INV-011 | No `ExecutionAdapter` call occurs unless the authoritative bounded grant has been re-read from the store and a usable exercise assessment covers the exact attempted action at that instant. | **PATH-LOCAL** to bounded-grant exercise (`GrantExecutionService` / `AuthorityControlledExecutionService`) | STRUCTURAL + RUNTIME + TEST-ENFORCED | `grant-execution-service.ts:154-198`; `src/features/execution-runtime/tests/execution-exercise.test.ts` counts adapter invocations (`callCount === 0` on every refusal row, `=== 1` on the valid row); single-call-site check in `security-invariants.test.ts` | **This is not a system-wide guarantee.** It does not apply to `AocKernel.enforce()` (SEC-INV-010), to the Sovereign Access provider path (SEC-INV-019), to the Content Protection provider path (a **second** separate provider authority model, `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` NB-003), or to any application code that calls a provider directly (SEC-TRUST-004). Three of the repository's forty-six enumerated effect paths are bounded-grant controlled — see that document's §5. |
| SEC-INV-012 | The grant is read, never received: a caller supplies a grant **id** and nothing else about the grant, and `subject` and `notAfter` crossing to the adapter are read from the trusted store, never from the request. | PATH-LOCAL to bounded-grant exercise | TYPE-LEVEL + RUNTIME + TEST-ENFORCED | `GrantExerciseRequest` shape; `grant-execution-service.ts:37-44, 184-194` | — |
| SEC-INV-013 | Revocation and expiry are visible to the very next exercise: the store is re-read on every attempt, with no cache, no fast path and no sweeper, and the instant is sampled after the awaited read. | PATH-LOCAL to bounded-grant exercise | RUNTIME + TEST-ENFORCED | `grant-execution-service.ts:154,158`; `grant-exercise-assessment.ts:123,128-130`; `execution-exercise.test.ts:185` | Revocation of the *underlying recognition capability token* is in-process memory and not durable (SEC-TRUST-003). |
| SEC-INV-014 | No free-form payload, blob or opaque reference crosses the execution adapter boundary: the validated action **is** the payload. | PATH-LOCAL to bounded-grant exercise | STRUCTURAL + TYPE-LEVEL + TEST-ENFORCED | `execution-adapter-port.ts:40-49`; `execution-layer-boundaries.test.ts:352-396` bans `payload\|blob\|rawBody\|opaqueRef\|commandRef` and whitelists exactly 17 field names | Constrains the **channel**. The adapter implementation itself is trusted code and is not verified. |
| SEC-INV-015 | Bound comparison is fail-closed: absence on either side is a refusal, `incomparable` is treated exactly as `broader`, a malformed request is refused before any comparison, and every failing axis is reported. | PATH-LOCAL to bounded-grant exercise | RUNTIME + TEST-ENFORCED | `grant-exercise-assessment.ts:84-87, 110-112, 142-179` | — |
| SEC-INV-016 | Grant issuance checks run inside the store's own commit boundary: the guard is **synchronous by type**, so no `await` can interleave between the read that decides and the write that records. | PATH-LOCAL to grant issuance | TYPE-LEVEL + TEST-ENFORCED | `grant-store-port.ts` `commitGuard: () => GrantCommitPrecondition`; `grant-runtime/tests/grant-transaction-boundary.test.ts` | — |
| SEC-INV-017 | Any change to the authority binding between measurement and commit refuses issuance — equality, not containment. | PATH-LOCAL to authority-controlled issuance | RUNTIME + TEST-ENFORCED | `src/enterprise/execution-governance/service.ts:197-234` | — |
| SEC-INV-018 | Attenuation only: an issued grant is equal to or narrower than the authority it derives from on every axis, proven against the artifact rather than the process that made it. | LAYER-LOCAL to layer E | RUNTIME + TEST-ENFORCED | `grantScopeIsWithin`; `grant-runtime/tests/grant-attenuation.test.ts`; `ADR-AUTHORITY-CONTROL-LAYERING.md` §5 | — |
| **SEC-INV-019** | **BOUNDARY.** Sovereign Access provider execution is a **separate authority-bearing path** with its own grant semantics (`EnterpriseAccessGrant`, authoritative store read plus `assertActive`). It does not pass through the Kernel and does not perform a bounded-grant exercise. | PATH-LOCAL to Sovereign Access | RUNTIME (its own model) + DOCUMENTED | `src/enterprise/access-governance/service.ts:252-296` (`requestProviderCredential`), `:281`; `pinata-revocation-enforcement.ts:110`; `lifecycle.ts:20` | SEC-INV-011 **does not apply to this path.** **Prompt 3 decided: EXCEPTED, not converged** (`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §9.4, §20.2 — SC-002 REFINED, STILL OPEN). Not HTTP-reachable — in-process trusted host code only, and not reachable at all from a published-package consumer (NB-010). |

### 4.3 Capability and layer hygiene

| ID | Invariant | Scope | Enforcement | Evidence | Boundary |
|---|---|---|---|---|---|
| SEC-INV-020 | These layers perform no I/O of their own: no `node:fs`, `node:http`, `node:net`, `node:child_process`, `fetch(`, or database client. | LAYER-LOCAL to context-resolution runtime (C), obligation runtime (D), grant runtime (E), execution runtime | STRUCTURAL + TEST-ENFORCED | `context-layer-boundaries.test.ts:62`; `obligation-layer-boundaries.test.ts:80`; `grant-layer-boundaries.test.ts:133-149`; `execution-layer-boundaries.test.ts:149-157` | **Four modules only.** `src/features/action-enforcement`, the rest of `src/enterprise`, all of `packages/` and all of `apps/` have no such test. See SEC-INV-U08. |
| SEC-INV-021 | No dynamic code evaluation: no `eval(`, `new Function(`, dynamic `import(`, or `vm`. | LAYER-LOCAL to layers C, D, E, the execution runtime, **and the Kernel** | STRUCTURAL + TEST-ENFORCED | `context-layer-boundaries.test.ts:118`; `obligation-layer-boundaries.test.ts:160`; `grant-layer-boundaries.test.ts:228`; `execution-layer-boundaries.test.ts:270-279`; Kernel coverage added in `security-invariants.test.ts` | Not proven for `packages/` or `apps/`. `apps/agent-passport-web` contains one constant-specifier `require('stripe')` **and six constant-specifier `await import(...)` calls** (three of `'stripe'`, three of its own modules). None takes a caller-influenced specifier, so none is a dynamic-code-execution primitive — see `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §4.2. |
| SEC-INV-022 | No ambient clock and no ambient randomness: every instant and identifier is injected. | LAYER-LOCAL to layers C, D, E and the execution runtime | STRUCTURAL + TEST-ENFORCED | `execution-layer-boundaries.test.ts:281-309`; sibling assertions in the grant/context/obligation suites | The Kernel deliberately defaults to a real clock and `crypto.randomUUID()` (`AocKernel.ts:181-187`), overridable by injection. |
| SEC-INV-023 | Correctness never depends on a background job having run: no timer, scheduler, cron, queue, worker or sweeper. | LAYER-LOCAL to the execution runtime (and, for expiry semantics, layer E) | STRUCTURAL + TEST-ENFORCED | `execution-layer-boundaries.test.ts:291-299` | — |
| SEC-INV-024 | No AI, model or inference dependency in the authorization path. | **DOCUMENTED SYSTEM-WIDE; TEST-ENFORCED only in layer E, the execution runtime, execution-governance, and the Kernel** | DOCUMENTED (system-wide) + STRUCTURAL + TEST-ENFORCED (four modules) | `ADR-AUTHORITY-CONTROL-LAYERING.md` "layer G may not appear anywhere in the authorization path, under any configuration"; `grant-layer-boundaries.test.ts:208`; `execution-layer-boundaries.test.ts:214-222`; `authority-controlled-execution-boundaries.test.ts`; Kernel coverage added in `security-invariants.test.ts` | **The ADR's claim is broader than the tests.** Layers B (policy / action-enforcement), C and D carry no AI-ban test. Stated as documented intent there, not as a structural guarantee. |
| SEC-INV-025 | No customer transaction signing key is held, requested, named or expressible: no wallet, mnemonic, `signTransaction`, nonce, sequence number, chain identifier or ledger client. | LAYER-LOCAL to layer E and the execution runtime, plus execution-governance — and an architectural non-goal repository-wide | STRUCTURAL + TEST-ENFORCED + DOCUMENTED | `execution-layer-boundaries.test.ts:226-248`; `structural-boundaries.test.ts:480-484`; `authority-controlled-execution-boundaries.test.ts`; `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §10 "no password or key custody for target systems"; `packages/tokenization-mandate/src/enterprise-tokenization-execution.ts:29` | The vocabulary ban is test-enforced in the grant/execution/execution-governance modules. Repository-wide absence of chain clients is a verified present-state fact and an architectural commitment, not a build-time check over every directory. |
| SEC-INV-026 | No external token format is adopted: a bounded grant is an internal typed record held by a trusted store; a caller never holds one and therefore never presents one. | LAYER-LOCAL to layer E and the execution runtime | STRUCTURAL + TEST-ENFORCED | `execution-layer-boundaries.test.ts:250-258` bans `jwt\|macaroon\|UCAN\|oauth\|bearer\|signed_url`; `bounded-grant.ts:34-40` | — |

### 4.4 Surface, secrets and authoritative state

| ID | Invariant | Scope | Enforcement | Evidence | Boundary |
|---|---|---|---|---|---|
| SEC-INV-027 | No caller-facing surface exists for grants: no route issues, extends, revokes or exercises a grant, and the execution runtime exports no handler, route, controller or endpoint. | PATH-LOCAL to bounded-grant execution; COMPONENT-LOCAL to the Enterprise HTTP adapter | STRUCTURAL + TEST-ENFORCED | `execution-layer-boundaries.test.ts:399-408`; `composition-root.ts:112-127`; the adapter's 8 route families, `node-http-adapter.ts:137,155,163,227,231,298,306,339` | Composing grant-aware execution is reachable from trusted in-process host code, by design. |
| SEC-INV-028 | Provider credentials and API keys never appear on the public composition surface, and no hardcoded credential fallback exists. | COMPONENT-LOCAL to the Enterprise Host | STRUCTURAL + TYPE-LEVEL + TEST-ENFORCED | `structural-boundaries.test.ts:256-299` (5 assertions); `PublicEnterpriseConfiguration` typing | Does **not** cover `apps/agent-passport-web`, which reads `process.env` ad hoc across `lib/` and route handlers. |
| SEC-INV-029 | The `GovernanceStore` and `AgentPassportStore` interfaces expose no public update or delete method. | COMPONENT-LOCAL to those two interfaces | STRUCTURAL + TEST-ENFORCED | `structural-boundaries.test.ts:169-173, 238-242` | **Two interfaces only.** Other stores (authority, assurance, mandates, access grants) perform `UPDATE` on status/counters, re-sealing the row digest. Deletion is a filesystem/DBA capability outside the software boundary. |
| SEC-INV-030 | Sensitive-keyed values are redacted before persistence, before digesting and before logging, so the digest attests to the sanitized record actually stored. | COMPONENT-LOCAL to the Governance Store | RUNTIME + TEST-ENFORCED | `redaction.ts:1-5, 78-86`; applied at `projection.ts:76,91,200,300` and `store-common.ts:169,189,212` | **Key-name matching only.** A secret under a non-matching key is persisted verbatim and, being inside the digest, cannot be removed without breaking the chain. See SEC-INV-U07. |
| SEC-INV-031 | Stored authority artifacts are integrity-checked fail-closed at read time: a row whose fields no longer match its digest fails the read rather than being skipped or repaired. | COMPONENT-LOCAL to the governed-authority store and bounded-grant exercise | RUNTIME + TEST-ENFORCED | `sqlite-authority-store.ts:646,671` (`assertReservationIntegrity` / `assertEncumbranceIntegrity`); `grant-exercise-assessment.ts:119` | **Integrity, not authenticity.** Unkeyed SHA-256 — see SEC-TRUST-002. The Governance Store re-verifies only on explicit `verify`, not on `get` (`THREAT_MODEL_V1.md` §7.1). |
| SEC-INV-032 | Durable Kernel Authority writes require both a system context and an operator context. | COMPONENT-LOCAL to `KernelAuthorityProvisioningService` | RUNTIME + DOCUMENTED | `src/enterprise/kernel-authority/provisioning-service.ts:51-60`; event-sourced append-only rules in `append-rules.ts` | **Not the pattern everywhere.** `PolicyPackRegistry.savePack` / `saveVersion` / `activatePolicyPackVersion` (`policy-pack-registry.ts:81,121,129`) carry no caller identity at all and are protected only by not being exposed. |
| SEC-INV-033 | The four reason-code vocabularies (authorization, obligation, issuance, exercise) are disjoint, and every exercise code carries the `GRANT_EXERCISE_` prefix. | SYSTEM-WIDE across the four vocabularies | STRUCTURAL + TEST-ENFORCED | `execution-layer-boundaries.test.ts:322-350` | — |
| SEC-INV-034 | Assurance frameworks are registered at composition only, validated structurally, immutable per version, and the registry is frozen before traffic; no HTTP path writes a framework. | COMPONENT-LOCAL to the Assurance Runtime | RUNTIME + DOCUMENTED | `THREAT_MODEL_V1.md` §7.11 | — |
| SEC-INV-035 | The durable bounded-grant store persists grants and revocations to **one** database file, in **one** transaction, under `synchronous = FULL`, so an acknowledged revocation cannot be the half a crash or restart loses. Restart may remove authority; it can never add any. | COMPONENT-LOCAL to `createSqliteBoundedGrantStore` | RUNTIME + TEST-ENFORCED | `src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts`; `bounded-grant-store-durability.test.ts` (`revoke-survives`, `restart-monotonic`, `revoke-commit`) | **Conditional on configuration.** The durable store is selected when `persistence.provider === 'sqlite'`; the default provider is `memory`, where grants and revocations are lost together on restart — which fails closed. `AUTHORITATIVE_GRANT_STORE.md` §15, GS-003, D-GS5 |
| SEC-INV-036 | Persisted grant **and** revocation records are integrity-verified on every authorization-sensitive read — record digest, artifact digest, canonical round-trip, identity and schema version — and state that fails validation yields no usable grant. It is never repaired, skipped or normalized. | COMPONENT-LOCAL to `createSqliteBoundedGrantStore` | RUNTIME + TEST-ENFORCED | `verifiedGrant`, `verifiedRevocation`, `currentRevocation`; nine fail-closed cases in `bounded-grant-store-durability.test.ts` | **Unkeyed digests.** This detects mutation; it does not stop a writer who can re-seal. Since Prompt 5 that writer is stopped by SEC-INV-039 instead — the digests keep their original, narrower job |
| SEC-INV-039 | A persisted bounded grant or grant revocation is not returned as authoritative unless a detached signature over its canonical, domain-separated bytes verifies against a public key held in the composition-supplied trusted registry. Missing, malformed, invalid, unknown-key, unsupported-algorithm and unsupported-version all yield no usable authority, and there is no unsigned mode. | COMPONENT-LOCAL to `createSqliteBoundedGrantStore` | RUNTIME + TEST-ENFORCED | `verifiedGrant`, `verifiedRevocation`; 43 behavioural and 25 structural cases in `authority-artifact-authenticity.test.ts` / `authority-authenticity-boundaries.test.ts`; six deliberate-violation experiments | **The signing key is process-resident** (AA-001), so this blocks a database-only writer and not a process-level one. Covers the durable store only; the in-memory store's integrity is the process's integrity. Says nothing about policy legitimacy (NB-008) or snapshot rollback (GS-002/AA-003) |
| SEC-INV-037 | A grant and its revocation record vouch for each other: removing or altering either half is inconsistent authority state and the read **refuses**, rather than resolving the disagreement — the only direction it could ever be resolved in is "usable". | COMPONENT-LOCAL to `createSqliteBoundedGrantStore` | RUNTIME + TEST-ENFORCED | `AUTHORITATIVE_GRANT_STORE.md` §9.1; `revocation-deleted`, `pointer-cleared`, `orphan-revocation` | Closes **partial** deletion. Does **not** close a writer who rewrites both halves consistently — same limit as SEC-INV-036 |
| SEC-INV-038 | The bounded-grant exercise path depends on a **read-only** store port: `issue` and `revoke` are not declared on the interface it is handed, so writing a grant from the exercise path is not expressible. | PATH-LOCAL to bounded-grant exercise | TYPE-LEVEL + STRUCTURAL + TEST-ENFORCED | `BoundedGrantReaderPort` in `grant-store-port.ts`; `grant-execution-service.ts`; `bounded-grant-store-boundaries.test.ts` | Narrows what the exercise path can reach. It does not constrain a host that retains its own store reference (SEC-TRUST-001, D-GS3) |

---

## 5. Execution Path Guarantees

Frontera has **four** distinct effect models. Conflating them is the single largest overclaim risk in this repository.

> **Complete inventory.** These four models are the *shapes*. The exhaustive, per-path enumeration — forty-six production-capable effect paths, each with a stable `EP-` id and exactly one classification — is `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §5. Rule 4 of §9 below is satisfied by adding a path there as well as here.

### 5.1 Evaluation — `AocKernel.evaluate()` / `POST /api/governance/evaluate`

- **Guarantees:** a decision, with reason codes, a trace, and a durably committed Governance Record. Recognition precedes any allow. Narrowing-only composition. No mutation of the request.
- **Does not guarantee, and does not attempt:** anything about execution. It invokes nothing.
- **Invariants:** SEC-INV-001 … SEC-INV-008.

### 5.2 Decision-time enforcement — `AocKernel.enforce()`

- **Guarantees:** the declared action passed authorization — recognition, authority, policy, context and blocking obligations — *before* the supplied executor was invoked, and the executor is not invoked at all on any non-allow outcome.
- **Does not guarantee:** that the executor's actual external effect corresponds to the declared `ActionDescriptor`. The executor is an opaque closure and is never inspected.
- **The correct formulation:**

  > `AocKernel.enforce()` = **decision-time** authorization of a **declared action**.
  > Bounded-grant exercise = **effect-time** authorization of a **validated execution action**.

- This is an accepted architectural boundary, not a defect. No accepted ADR gives grants a role in the executor gate, and grants deliberately do not gate `enforce()`.
- **Invariants:** SEC-INV-009 (guarantee), SEC-INV-010 (limit).

### 5.3 Bounded-grant exercise — `GrantExecutionService` / `AuthorityControlledExecutionService`

- **Guarantees:** the strongest execution-time property in the repository. The authoritative store is re-read on every attempt; twelve checks run fail-closed; every failing axis is reported; the adapter receives only values an assessment proved, across a boundary with no free-form payload channel and a build-enforced 17-field whitelist.
- **Does not guarantee:** anything about the other three paths. It is **opt-in** and exposes **no HTTP route**.
- **Invariants:** SEC-INV-011 … SEC-INV-018, SEC-INV-027.

### 5.4 Sovereign Access provider execution

- **Guarantees:** its own authority model — an authoritative `EnterpriseAccessGrant` store read plus an active-status check — before minting a provider credential or enforcing a provider-side revocation.
- **Does not guarantee:** bounded-grant exercise semantics. It does not call the Kernel and does not read a `BoundedGrant`.
- **Explicit statement required by this document:**

  > The invariant "no adapter call without a usable bounded-grant exercise" (SEC-INV-011) **does not currently apply to Sovereign Access provider execution.**

- **Prompt 3 decided: record it as an explicit exception rather than converge it** (`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §9.4). A **second** provider authority model reaching the same resource was also found there and is excepted on the same terms: Content Protection (`src/enterprise/content-protection`), gated only by a caller-asserted tenant scope (NB-003).
- **Invariants:** SEC-INV-019.

---

## 6. Root of Trust and Explicit Assumptions

These are boundary statements, not defects. They are recorded here so that no future security claim can omit them by accident.

| ID | Assumption | Consequence if violated | Evidence |
|---|---|---|---|
| SEC-TRUST-001 | **Host trust.** The Frontera host process, its environment variables, its process user and its data directory are inside the trusted computing base. | Total compromise: every HMAC signing secret, every API key, every provider credential, all in-memory recognition and authority state, the emergency-deny flag, and the ability to re-seal every digest and hash chain. | `THREAT_MODEL_V1.md` §2.6, §8.3 |
| SEC-TRUST-002 | **Privileged writer limit.** Authority artifacts carry unkeyed SHA-256 digests. These detect unauthorized mutation only where the attacker cannot rewrite artifact **and** digest together. | A writer able to re-digest can silently re-seal a store. Detection then depends entirely on out-of-band copies — backups, previously exported bundles. | `bounded-grant.ts:144-152` ("integrity, not a signature"); `THREAT_MODEL_V1.md` §7.3 |
| SEC-TRUST-003 | **Authoritative state durability.** Bounded grants are durable **when `persistence.provider === 'sqlite'`** and in-memory otherwise (the default); recognition, authority-graph, approval and handshake state are in-process `Map`s under every configuration. | On the in-memory store, authorization state is lost on restart and grant loss fails closed (`GRANT_EXERCISE_NOT_FOUND`). On the durable store, grants **and** revocations survive together (SEC-INV-035). Capability-token revocation is **not durable** under either. | `sqlite-bounded-grant-store.ts` and `in-memory-bounded-grant-store.ts` (the two `BoundedGrantStorePort` implementations); `composition-root.ts` (`buildBoundedGrantStore`); `capability-token-service.ts:47`; `kernel-provider-composition.ts:60-87`; `AUTHORITATIVE_GRANT_STORE.md` §15, GS-003 |
| SEC-TRUST-004 | **Voluntary chokepoint limit.** An authority gate constrains only the effects actually routed through it. Frontera's gate is not mandatory: nothing prevents in-process code from calling a provider directly. | An actor with code execution and network access reaches any provider without passing any gate. | No egress control exists; `packages/pinata-adapter`, `apps/agent-passport-web` call providers directly |
| SEC-TRUST-005 | **Process-isolation absence.** Frontera provides no process-level containment for governed agent code. It governs declared actions; it does not execute agent code, sandboxed or otherwise. | An agent sharing the Frontera process inherits every capability of that process, including ambient `process.env`. | `infrastructure/{terraform,docker,kubernetes}/` contain only `.gitkeep`; no sandbox primitive exists; `enforceAgentRuntimeGuard` (`runtime-guard.ts:246-270`) returns booleans and withholds nothing |
| SEC-TRUST-006 | **Provider adapter trust.** An `ExecutionAdapter` implementation is trusted code. The boundary constrains what data may cross it; it does not verify what the adapter then does. | A malicious or defective adapter can act outside the validated action it was handed. | `execution-adapter-port.ts:119-124` |
| SEC-TRUST-007 | **Deployment trust.** TLS, ingress restriction, rate limiting, WAF, secret storage and rotation, key custody and OS hardening are the operator's. Authentication is **off by default** (`AOC_ENTERPRISE_REQUIRE_AUTH`, default `false`). | An unauthenticated, cross-tenant API on all interfaces if deployed without the documented configuration. | `enterprise-configuration.ts:174`; `DEPLOYMENT_GUIDE_V1.md:101-102`; `THREAT_MODEL_V1.md` §8.1 |

---

## 7. Unimplemented Security Invariants

These are the containment properties identified by the Prompt 0 baseline. **None is implemented.** They are recorded so they cannot be mistaken for guarantees, and so that each has an owner.

| ID | Desired invariant | Current state | Owner prompt |
|---|---|---|---|
| SEC-INV-U01 | No authority artifact is trusted without a verified signature from a key the application process cannot read. | **PARTIALLY IMPLEMENTED after Prompt 5.** The invariant has two halves and exactly one is satisfied. *Verified signature*: **implemented** for the durable bounded-grant store — a detached Ed25519 signature over the canonical record bytes, under artifact-specific signing domains, verified on every authoritative read against a composition-supplied trusted public-key registry, fail-closed on missing/malformed/invalid/unknown-key/unsupported-algorithm, with no unsigned mode (`AUTHORITY_ARTIFACT_AUTHENTICITY.md`). *A key the application process cannot read*: **NOT implemented** — the signing key is loaded from configuration into process memory (AA-001). Scope is also narrower than the invariant's wording: it covers bounded grants and grant revocations on the durable path, **not** every authority artifact — Agent Passport still signs with HMAC, where verification and minting are the same capability (§10.4 of that document). | Prompt 6 (key boundary); later prompts (remaining artifacts) |
| SEC-INV-U02 | No production signing key is ever resident in application process memory. | **NOT IMPLEMENTED — unchanged by Prompt 5, and Prompt 5 added one more such key.** The authority signing key is a PKCS#8 private key loaded from `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` into process memory (AA-001). This is a deliberate, recorded handoff rather than an oversight: the signer is already an injected boundary with an `async`, domain-aware interface that returns no key material, so a KMS/HSM adapter replaces the implementation without touching a call site (`AUTHORITY_ARTIFACT_AUTHENTICITY.md` §25). The pre-existing symmetric HMAC secrets are untouched. | Prompt 6 |
| SEC-INV-U03 | No egress to a provider except from an allowlisted adapter at a controlled network boundary. | ASPIRATIONAL-UNIMPLEMENTED. No allowlist, no egress control, no network namespace. Only two egress points exist today (Pinata, Stripe), so the allowlist would be small. | Prompt 11 |
| SEC-INV-U04 | No governed agent executes in a process that holds any secret or any authority-write capability. | ASPIRATIONAL-UNIMPLEMENTED. No process boundary exists between governed and governing code. This is the dominating gap: U03, U04 and the sandbox contract are all consequences of establishing it. | Prompt 7 |
| SEC-INV-U05 | Every authority-bearing path honours a single durable kill switch. | PARTIALLY IMPLEMENTED. `EmergencyDenyPolicy` wins over every other policy, but `setEmergencyDeny` is a process-local instance field (`action-enforcement-runtime.ts:108`), not durable, not exposed on `AocKernel` or any route, and **not consulted by the bounded-grant exercise path** — the one that reaches real providers. | Prompt 12 |
| SEC-INV-U06 | Aggregate behaviour is bounded, not only per-action behaviour. | ASPIRATIONAL-UNIMPLEMENTED. No rate limiting, velocity or aggregate analysis. Deliberately constrained: `execution-layer-boundaries.test.ts:311-319` bans a consumption model, and `:214-222` bans `riskScore`/`anomal`/`recommend` from the execution runtime — so this must be built **outside** layers B–E. | Prompt 13 |
| SEC-INV-U07 | No value matching a secret pattern is persisted into a Governance Record, whatever its key. | PARTIALLY IMPLEMENTED. Key-name redaction exists and runs before digesting (SEC-INV-030); value-pattern matching does not. | Prompt 15 |
| SEC-INV-U08 | Every layer that may not perform I/O has a capability-ban test. | PARTIALLY IMPLEMENTED. Five modules covered: context, obligation, grant, execution runtimes, and now the Kernel. Not covered: `src/features/action-enforcement`, the rest of `src/enterprise`, all of `packages/`, all of `apps/`. | Prompt 10 |

---

## 8. Claims Boundary

### 8.1 We Can Claim

Each of these is backed by an invariant above and, through it, by code or a test that fails CI.

1. Frontera never holds, requests, or can express a customer transaction signing key (SEC-INV-025).
2. On the bounded-grant exercise path, no external provider is contacted unless an authoritative grant re-read and a usable exercise assessment cover the exact action at that instant — with adapter invocation counts asserted for every refusal case (SEC-INV-011).
3. A caller never holds, presents, or can tamper with a grant: only an identifier crosses the boundary (SEC-INV-012, SEC-INV-026).
3a. When the durable bounded-grant store is configured, issued grants and revocations survive process restart with transactional persistence, authoritative re-read and fail-closed integrity validation — and restart can never increase authority (SEC-INV-035, SEC-INV-036, SEC-INV-037). This claim is void without the configuration clause.
4. On that path, revocation and expiry are effective immediately, with no cache and no background job (SEC-INV-013, SEC-INV-023).
5. Within the Frontera Enterprise authorization pipeline, the Kernel is the only decision producer, and contributing layers can only narrow or annotate (SEC-INV-001, SEC-INV-002).
6. `AocKernel.enforce()` never invokes the executor on a non-allow outcome (SEC-INV-009).
7. Layers C, D, E and the execution runtime perform no I/O of their own, evaluate no dynamic code, read no ambient clock or randomness, and depend on no background job (SEC-INV-020 … SEC-INV-023).
8. Provider credentials cannot appear on the Enterprise Host's public composition surface, and no hardcoded credential fallback exists (SEC-INV-028).
9. Governance records are append-only by interface, digest-chained, and redacted before digesting (SEC-INV-029, SEC-INV-030).
10. Every optional governance capability is byte-identically absent when unconfigured (SEC-INV-006).

Every claim above must carry its scope when repeated. "No adapter call without a usable exercise assessment" is only true of the bounded-grant path, and must be stated that way.

### 8.2 We Cannot Claim Yet

1. **Rogue-agent containment.** Frontera governs declared actions; it contains nothing (SEC-TRUST-004, SEC-TRUST-005).
2. **Sandboxing or agent isolation.** No sandbox, no isolation primitive, no agent execution runtime (SEC-TRUST-005).
3. **System-wide adapter gating.** SEC-INV-011 is PATH-LOCAL. It does not hold for `enforce()`, for Sovereign Access, or for Content Protection (SEC-INV-010, SEC-INV-019, NB-003). Three of forty-six effect paths are bounded-grant controlled.
4. **Cryptographically authenticated authority artifacts — *partially*, as of Prompt 5.** Bounded grants and grant revocations in the **durable** store are signed and verified (Ed25519, public-key verification, no unsigned mode). Everything else still relies on unkeyed digests, and Agent Passport on HMAC. So the general form of this gap remains open (SEC-TRUST-002, SEC-INV-U01), narrowed to one path.
5. **KMS/HSM-protected signing.** Still absent. Every production signing key — the pre-existing symmetric HMAC secrets, and now the authority Ed25519 private key — is process-resident and loaded from an environment variable (SEC-INV-U02, AA-001).
6. **Durable global kill switch.** Process-local, non-durable, and invisible to the exercise path (SEC-INV-U05).
7. **Behavioral abuse detection.** No rate limiting, velocity or aggregate analysis — and the authorization layers are structurally banned from containing any (SEC-INV-U06).
8. **A hardened SaaS surface.** One blocker (APW-001, unauthenticated credential disclosure at checkout) is remediated and regression-tested, but APW-002, APW-003, APW-006 and APW-007 remain open in `AGENT_PASSPORT_WEB_THREAT_MODEL.md`.
9. **Complete repository threat-model coverage.** `src/enterprise` and `apps/agent-passport-web` are now modelled, but `packages/*` libraries remain outside every threat model (`THREAT_MODEL_V1.md` §9), and no independent penetration test has been performed against any surface.
10. **Durable authorization state by default.** A durable bounded-grant store now exists and is production-capable, but it is selected only when `persistence.provider === 'sqlite'`; recognition, approval, capability-token and policy-pack state remain in-process under **every** configuration (SEC-TRUST-003, GS-003). "All Frontera authority is now durable" is false.
11. **Anti-rollback on the authority store.** Restoring a database snapshot taken before a revocation restores the revoked grant, with every integrity check passing. Not implemented, not claimed (`AUTHORITATIVE_GRANT_STORE.md` §17, GS-002).
12. **Tamper-proof authority storage.** The store's digests are unkeyed; a writer who can re-seal defeats every check (SEC-TRUST-002, GS-001).
11. **Third-party-verifiable Agent Passports.** They are HMAC-signed; the registered "public key" is symmetric-scheme metadata and cannot verify them.
12. **Repository-wide capability restriction.** Proven for five modules; absent for `packages/`, `apps/` and most of `src/enterprise` (SEC-INV-U08).

---

## 9. Change Control

1. **Promotion requires proof.** An invariant's scope may only be widened — PATH-LOCAL to LAYER-LOCAL, LAYER-LOCAL to SYSTEM-WIDE — when code or a test actually proves the wider scope. Changing the prose is not promotion. A scope change with no corresponding test change should be rejected in review.
2. **Local invariants must never be represented as system-wide claims.** Any external artifact — architecture document, README, datasheet, sales material, model-facing summary — that repeats an invariant from §4 must carry its scope. SEC-INV-011 in particular must always name the bounded-grant path.
3. **Weakening requires review.** Removing an enforced invariant, or reducing its enforcement strength, requires an explicit architecture decision and a corresponding update to the tests named in its Evidence column. A test deleted without an entry here being updated is a regression, not a cleanup.
4. **New effect paths must declare themselves.** Any new path capable of producing an external effect must be added to §5 with its own guarantees and non-guarantees, **and to `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §5 with its own `EP-` id and classification**, before it ships. A path absent from either is covered by no invariant here and by no claim there. `src/enterprise/__tests__/no-bypass-effect-paths.test.ts` fails the build when a new provider SDK site, execution-adapter invocation, route file or Server Action appears without that update.
5. **Boundary statements are not optional.** §6 travels with §4. A security claim quoting §8.1 without the relevant §6 assumption is incomplete.
6. **Unimplemented stays unimplemented until owned.** An entry in §7 moves into §4 only when its owner prompt lands the mechanism and the evidence.
