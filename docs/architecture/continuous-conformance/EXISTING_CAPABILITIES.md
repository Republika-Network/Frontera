# Existing Capabilities — Code-Backed Inventory

Classification per RN-CONFORM-01 §4. "Tested" means a targeted test file exists at the audited commit;
suites were read, not executed. Prefixes: **F:** Frontera `64b3ec7c`; **P:** Soberania_Protocol `590e4cb`;
**X:** xrpl-sovereign-access `3f7652f`; **L:** live-data-rail `79a42be`. Markdown designs and PR titles
were not counted as implementation.

Legend: **IAT** implemented and tested · **IBIM** implemented but integration missing · **PART** partial ·
**DOC** documented only · **ABS** absent · **UNK** unknown.

## B1. Protocol and SDK

| Capability | Class | Source / symbol | Test | Note |
|---|---|---|---|---|
| Authorization evaluation (policy → governance → capability → consent) | IAT | P: `packages/authorization-runtime/src/index.ts` `AuthorizationRuntime.evaluate` | P: `tests/contracts/consent-capability-enforcement.test.ts`, `federated-authority-trust.test.ts` | Decision `allow \| deny`; `AUTHORIZATION_FAILED_STAGES` |
| Kernel decision | IAT | F: `src/kernel/contracts/kernel-result.ts:22` `KernelDecisionStatus` | F: `src/kernel/__tests__/*` | `allowed \| denied \| approval_required \| indeterminate` |
| Deny-only external authorization port (#217) | **IBIM** | F: `src/kernel/contracts/ports.ts` `ExternalAuthorizationProvider`; `src/kernel/orchestration/external-authorization-adapter.ts` `resolveExternalAuthorization`, `EXTERNAL_AUTHORIZATION_MAX_TIMEOUT_MS` | F: `src/kernel/__tests__/kernel-external-authorization.test.ts` | Fail-closed (throw/timeout/malformed → deny). **No implementation of the port exists**; `@aoc-runtime/*` consumed only by test fixtures |
| Fail-closed revocation gate | IAT | P: `protocol/revocation/revocation-policy.ts` `resolveMaterialActionDecision`, `isRevocationBlocking` | P: `protocol/revocation/__tests__/revocationPolicy.test.ts`, `revocationCheck.test.ts` | `unknown` always blocks |
| Consent (signed grants, owner binding) | IAT | P: `packages/consent-runtime/src/index.ts` `ConsentRuntime` | P: `tests/contracts/consent-revocation.test.ts`, `resource-ownership-binding.test.ts` | Subject = resource owner |
| Delegation | PART | P: `ConsentRuntime.signDelegation`; `aoc/capabilities/core/evaluateCapabilityAccess.ts` (attenuation) | P: `enforcement/__tests__/evaluateCapabilityAccess.test.ts` | `protocol/capability-delegation/` is mock data; models are DOC |
| Revocation propagation timing | **ABS** | — | — | No SLA/TTL anywhere; only caller-supplied lookup timeouts |
| Trust registry (issuer keys, scopes) | IAT | P: `enterprise/src/assurance/trust/federated-trust-registry.ts` `TrustRegistryRuntime` | P: `tests/contracts/federated-authority-trust.test.ts` | `TrustBoundaryScopeType` namespace/workspace/organization/machine |
| Credential binding to trusted key | IAT | P: `crypto/engine.ts` `verifyPayloadSignature`; F: `packages/sovereign-receiver-verification` issuer binding | F: `__tests__/issuer-binding-regression.test.ts` | P `verifySignedClaim` alone trusts the embedded key — integrity only |
| Protocol credential status vocabulary | DOC (type only) | P: `packages/protocol/src/claims/credentials/credential-enums.ts` `CredentialStatus` (Draft, Issued, Active, Suspended, Revoked, Expired, Superseded, Archived, Unknown); `credential-status-reference.ts` `CanonicalCredentialStatusRef` | P: `tests/contracts/credential-contract.test.ts` | "Describes a declared or observed status without checking revocation" — no lifecycle engine |
| Portable document policy metadata | IAT | P: `packages/protocol/src/portability/bundle.ts` (`aoc-sovereignty-portability-bundle/1`), `SovereignManifestV1` | P: `tests/contracts/sovereignty-portability-*`, `sovereign-manifest.test.ts` | Profile id not carried in bundle |
| Document-use policy outcomes | IAT | F: `packages/sovereign-receiver-verification/src/document-policy.ts` `evaluateDocumentUsePolicy` | F: `__tests__/document-policy.test.ts` | `ALLOWED \| DENIED \| WITHHELD`; unsigned, in-memory |
| SDK adapters | PART | P: `packages/aoc-sdk` `HostedRuntimeSdk`; F: `packages/enterprise-host-sdk` `createEnterpriseHostClient` | P: `tests/sdk/*`; F: `packages/enterprise-host-sdk/__tests__/client.test.ts` | No "Sovereign Access SDK" ([CC-D-10](DECISION_REGISTER.md#cc-d-10)) |
| Version / compatibility declarations | PART | P: `runtime/versioning.ts` (`SDK_COMPATIBILITY_VERSION='1.0.0'`), `@aoc/protocol/interoperability`; F: `protocol-consumer.lock.json` + `scripts/protocol/check-compatibility-lock.mjs` | P: `tests/contracts/sovereignty-interoperability-*` | F `packages/runtime-negotiation` only has a skipped test; its "attestation" is unsigned |
| Canonical JSON | IAT (two profiles) | P: `@aoc/protocol/canonical` `canonicalizeJSON`, `aoc-canonical-json/1`; F: `src/enterprise/governance-store/canonical-json.ts` `canonicalSerialize`, `aoc.canonical-json.v1` | P: `crypto/__tests__/canonicalize*.test.ts` | **Not byte-identical** for `undefined`, `Date`, `-0` → [CC-D-01](DECISION_REGISTER.md#cc-d-01) |
| Signed events a platform emits about itself | IAT, **self-asserted** | P: `enterprise/src/assurance/audit/signed-audit-runtime.ts` `AuditRuntime`; `GovernanceRuntime.signDecision` | P: audit tests | Signed only by the platform's own runtime key |

## B2. Assurance (Frontera `src/enterprise/assurance`, abbreviated A/)

| Capability | Class | Source / symbol | Test |
|---|---|---|---|
| Framework registry, freeze at composition | IAT | A/`framework-registry.ts` `createAssuranceFrameworkRegistry`; `src/enterprise/modules/assurance-module.ts` | `assurance-framework.test.ts`, `module-lifecycle-integration.test.ts` |
| Frozen rn.sv definition + golden digest | IAT | A/`frameworks/rn-sv-framework.ts` `RN_SV_FRAMEWORK_V0_1`; A/`commercial-report.ts` `RN_SV_FRAMEWORK_DIGEST` | `assurance-rn-sv-framework.test.ts` |
| Automated control evaluation | IAT (unused by rn.sv) | A/`control-evaluator.ts` `createAssuranceControlEvaluator` | `assurance-control-evaluation.test.ts` |
| Manual evidence-bound review | IAT | A/`manual-review-evidence.ts`, `manual-evidence-trust.ts` | `assurance-sec-01a-*`, `assurance-sec-01c-*` |
| Evidence references and digests | IAT | A/`evidence-resolver.ts`; `src/enterprise/governance-store/digest.ts` `computeDigest` | `assurance-evidence-resolution.test.ts` |
| Evidence attribution / tenant isolation | IAT | A/`evidence-bundle-trust.ts` `attributeEvidenceBundle`; A/`assurance-store.ts` `requireAccessToAssuranceOrganization` | `assurance-sec-01d-*` |
| Evidence Bundle v2 | IAT, **hash-only** | `src/enterprise/evidence/verifier.ts` `verifyEvidenceBundle` | `evidence-service.test.ts` |
| Findings and finding events | IAT | A/`findings.ts`, A/`finding-history.ts` | `assurance-findings.test.ts`, `assurance-sec-01e-*` (events self-digested, **not chained**) |
| Assessment lifecycle and terminal immutability | IAT | A/`assessment.ts` `ASSESSMENT_TRANSITIONS`; `contracts.ts` `ASSURANCE_TERMINAL_STATUSES` | `assurance-lifecycle.test.ts` |
| Reviewer authentication | IAT, static bearer secret | A/`reviewer-identity.ts` `createAssuranceReviewerAuthenticator` | `assurance-sec-01b-*` |
| Report generation, release custody | IAT, Host-custody only | A/`commercial-report.ts`, A/`commercial-release-custody.ts`; `externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE'` | `assure-rel-01a-*`, `assure-pilot-01-*` |
| Historical verification | IAT | A/`verification.ts` `verifyAssuranceAssessment` | `assurance-verification.test.ts` |
| Continuous signals | **PART** | A/`signals.ts` `deriveContinuousAssuranceState`; `service.processSignal`; HTTP `POST /api/assurance/signals` | `assurance-signals.test.ts` — signals are unauthenticated input, `sourceDigest` unverified, no in-process emitter |
| Framework commercial authorization (GOV-01) | DOC | `docs/commercial/founding-assessment/governance/COMMERCIAL_AUTHORIZATION_PROCEDURE.md` | — |
| Independent review (GOV-02) | DOC | `docs/commercial/founding-assessment/governance/external-review/` | — |

Defects noticed (recorded, not fixed — out of scope): A/`framework-registry.ts:94` `deprecate()` has no
frozen check; `aoc.saf@1.0.0` is not deep-frozen at runtime (golden digest only). See
[DECISION_REGISTER.md CC-D-14](DECISION_REGISTER.md#cc-d-14).

## B3. Validator infrastructure

**No repository contains a validator network.** Closest pieces:

| Capability | Class | Best existing source | Test |
|---|---|---|---|
| Independent pinned-key identity | IAT | F: `src/enterprise/authority-state-freshness/witness-client.ts` `establishAuthorityStateWitness`; F: `src/enterprise/executor-receipt/verifier.ts` `TrustedExecutor` (multi-key rotation) | F: `authority-state-freshness-*.test.ts` |
| Registration / enrollment | PART | F: witness `enroll` (`authority-state-freshness/protocol.ts`); X: static `defineNetworkDeployment` | as above |
| Challenge generation + challenge-bound signed receipt | IAT | F: `witness-client.ts` (32-byte challenge echoed in signed receipt) | as above |
| Challenge execution against a subject platform | **ABS** | — | — |
| Evidence submission with conflict preservation | IAT (other domain) | F: `src/enterprise/execution-receipt-evidence/recorder.ts` | F: execution-receipt tests |
| Corroboration / N-of-M quorum | IAT (XRPL-specific inputs) | X: `packages/xrpl-adapter/src/quorum.ts` `assessQuorum`; `packages/reconciler/src/quorum-provenance.ts` | X: `tests/xrpl-adapter/quorum.test.ts` |
| Source quarantine on self-contradiction | IAT | X: `packages/xrpl-adapter/src/trust.ts` `SourceTrustRegistry` | X: adapter tests |
| Health / heartbeat | PART | F: `src/enterprise/health/health-check.ts`; witness monitor (probe ≤60 s) | — |
| Scheduling | PART | L: Postgres durable schedule (`migrations/003_durable_outbox.sql`); X: `setInterval(drain)` | L: `tests/integration/durable-outbox-postgres.test.ts` |
| Retries | IAT | L: `src/domain/delivery/attempt.ts` `RetryPolicy`; X: lease + `max_attempts` | L/X tests |
| Replay protection | IAT | P: `FederatedAuthorityReplayGuard` (nonce ≥16); F: execution-capability consumption ledger; X: idempotency keys | P/F/X tests |
| Validator revocation | PART | F: remove pinned key from config (no revocation list); X: quarantine | — |
| Hash-chained audit log | IAT | F: `src/enterprise/authority-event-stream/event-chain.ts` | F: event-stream tests |
| Dual-human decision for privileged operations | IAT | F: `src/enterprise/sovereign-status-history/human-decision-authorizer.ts` `createHumanDecisionBootstrapAuthorizer` | F: `fv-p4c2b2-human-decision-authorizer.test.ts` |

## B4. Credentials

| Capability | Class | Source | Note |
|---|---|---|---|
| Conformance credential issuance | **ABS** | — | |
| Signed status object with sequence + previous-digest link | IAT (receiver side) | F: `packages/sovereign-receiver-verification/src/sovereign-status.ts` `verifySovereignStatus`; types `SignedSovereignStatusV1` | States only `active \| withdrawn`; Frontera never issues |
| Key ids, issuer binding | IAT | same; P: `crypto/engine.ts` `deriveRuntimeAuthorityKeyId` | keyId must derive from key (SOBE-SEC-01) |
| Expiry window | IAT | `issuedAt ≤ t < validUntil`, max 604 800 s | |
| Suspension / reinstatement | **ABS** | — | P enum has `Suspended` (type only); FV status has none; XRPL Credentials cannot express it (X ADR-002) |
| Anti-rollback current-state tracking | IAT | F: `document-freshness.ts` `establishStatusHistory`, `StatusHighWaterMark`; F: `src/enterprise/sovereign-status-history/sqlite-status-high-water-mark-store.ts` | Forward-only triggers; whole-file rollback undetected (FV-P4D) |
| Public verification endpoint | **ABS** | — | X `credential-gateway` dual-half verification exists but its authoritative half is a stub |
| Status caching rules | PART | F: per-action freshness ceilings `DOCUMENT_USE_FRESHNESS_CEILINGS` | |
| Agent passport lifecycle with suspended | IAT (agents, not platforms) | F: `packages/agent-governance/src/passport/passport-status.ts` | issued → active ↔ suspended → revoked/expired — a useful precedent |

## B5. Blockchain anchoring

| Capability | Class | Source | Note |
|---|---|---|---|
| XRPL Testnet CredentialCreate | IAT | X: `packages/xrpl-adapter/src/prepare.ts` `prepareCredentialCreate`; `packages/projection-writer/src/writer.ts` | Live Testnet qualification (`docs/evidence/FRONTERA-PREVIEW-TESTNET-QUALIFICATION.md`) |
| XRPL CredentialDelete | IAT / IBIM in preview | X: `packages/projection-writer/src/deletion.ts` `DeletionWriter` | Preview composition stubs deletion |
| CredentialAccept | PART | X: observation only | Subject's transaction |
| Digest / memo anchoring | **ABS by design** | X: `packages/signer-port/src/wire.ts` refuses `Memos`, `URI` | Enforced by tests → [CC-D-06](DECISION_REGISTER.md#cc-d-06) |
| Confirmation tracking | IAT | X: `packages/xrpl-adapter/src/submit.ts` `resolveValidation` | Validated ledger only; `LastLedgerSequence` always set |
| Idempotency / network-failure recovery | IAT | X: `packages/credential-gateway/src/worker.ts` `OperationWorker`; journal | Identical-blob resubmit, never re-sign |
| Key custody | IAT | X: `packages/signer-port`, `apps/signer-service`; ADR-008 + amendment 1 | One Testnet-only ed25519 seed; separate process; single-use operator approvals |
| Network allowlist | IAT | X: `packages/network-deployment/src/deployment.ts` `defineNetworkDeployment`; `PREVIEW_FORBIDDEN_NETWORKS` | Mainnet/devnet write refused |
| Historical reconstruction | IAT / IBIM in preview | X: `packages/reconciler` `CredentialReconciler`, `episodes.ts` | |
| Authoritative status lookup port | DOC (port only) | X: `packages/credential-gateway/src/ports.ts` `AuthoritativeRecordSource.lookupProjectionStatus` | Only test stubs |
| Chain-independent evidence schema | **ABS** | — | |
| EVM / Bitcoin anchoring | **ABS** | — | No ethers/viem/bitcoinjs/opentimestamps anywhere; Frontera guards forbid chain SDKs in some modules |
