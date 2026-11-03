# Reuse Matrix

Decisions: `REUSE DIRECTLY` · `REUSE WITH ADAPTER` · `EXTEND` · `BUILD NEW` · `DEFER` · `UNKNOWN`.
Cross-repository code is reused as a **pattern** (re-implemented in Frontera) unless a published package
boundary already exists; no new cross-repo package imports are proposed.

| Capability | Existing implementation | Source / test evidence | Decision | Adaptation | New code required | Dependency |
|---|---|---|---|---|---|---|
| Canonical JSON | Frontera `canonicalSerialize`; Protocol `canonicalizeJSON` | F: `governance-store/canonical-json.ts`; P: `crypto/__tests__/canonicalize*.test.ts` | REUSE DIRECTLY | Restrict inputs to plain JSON | Profile assertion helper | CC-D-01 |
| Digests | `computeDigest` (`sha256:`) | F: `governance-store/digest.ts` | REUSE DIRECTLY | — | — | — |
| Domain-separated Ed25519 + key registry | `authority-authenticity/*` | F: `signer.ts`, `verifier.ts`, `signature-verification.ts` | EXTEND | Add 5 conformance signing domains | Domain constants, signing-bytes builders | — |
| Out-of-process signer | CORE-02 external authority signer | F: `src/enterprise/external-authority-signer/` (+ reference service) | REUSE WITH ADAPTER | Status/transition keys | Key config | CC-D-07 |
| Validator identity, challenge-bound receipts | Authority-state witness protocol | F: `authority-state-freshness/witness-client.ts`, `protocol.ts`; `authority-state-freshness-*.test.ts` | REUSE WITH ADAPTER (pattern) | Challenge semantics differ (subject = platform, not store) | Validator client + coordinator | — |
| Multi-key pinned identities | `TrustedExecutor` | F: `executor-receipt/verifier.ts` | REUSE DIRECTLY (pattern) | — | Validator registry | — |
| Dual-human decisions | `createHumanDecisionBootstrapAuthorizer` | F: `sovereign-status-history/human-decision-authorizer.ts`; `fv-p4c2b2-human-decision-authorizer.test.ts` | REUSE WITH ADAPTER | New decision format `frontera.conformance-authority.v1` and permissions | Permission set, binding digests | AUTH-03 |
| Hash-chained append-only log | `event-chain.ts` | F: `authority-event-stream/` | REUSE DIRECTLY (pattern) | Transition log | Store schema | — |
| Forward-only DB triggers | `sovereign_status_history_forward_only` | F: `sqlite-status-high-water-mark-store.ts` | REUSE (pattern) | Credential states | Triggers | — |
| Signed status format | `SignedSovereignStatusV1` | F: `packages/sovereign-receiver-verification/src/sovereign-status*.ts` | REUSE WITH ADAPTER (pattern) | 5 states, subject = integration, issuer = Republika | `rn.conformance.status/1` | CC-D-01 |
| Verifier-side high-water mark | `establishStatusHistory`, `StatusHighWaterMark` | F: `document-freshness.ts`; `document-freshness.test.ts` | REUSE WITH ADAPTER | Keyed by `credentialId` | Verifier library | — |
| Assurance evidence references | `AssuranceEvidenceReference` | F: A/`contracts.ts`, A/`evidence-resolver.ts` | **DEFER** | Different trust model (supplied vs validator-signed) | — | — |
| Assurance evidence hashes | `computeDigest` | as above | REUSE DIRECTLY | — | — | — |
| Assurance findings | `findings.ts`, `finding-history.ts` | `assurance-findings.test.ts` | REUSE WITH ADAPTER (later) | Optional projection of confirmed violations into Assurance findings for the org's next assessment | Projector | CC-D-08 |
| Assurance store | `createSqliteAssuranceStore` | `assurance-store-contract.test.ts` | **BUILD NEW** (separate store) | Reusing it would require non-terminal mutation and couple lifecycles | Conformance store | — |
| Assurance report generation | `commercial-report*.ts` | `assurance-rep-01-*` | **DEFER** | Hard-bound to rn.sv@0.1.0 | — | — |
| Historical custody | `commercial-release-custody.ts` append-only triggers | `assure-rel-01a-*` | REUSE (pattern) | Evidence package custody | Store | — |
| Verification infrastructure | `verifyAssuranceAssessment` | `assurance-verification.test.ts` | REUSE (pattern) | Recompute-everything verifier for transitions | Verifier | — |
| Tenant isolation | `requireAccessToAssuranceOrganization` | A/`assurance-store.ts`; `assurance-sec-01d-*` | REUSE (pattern) | — | — | — |
| Continuous signals | `processSignal`, `deriveContinuousAssuranceState` | `assurance-signals.test.ts` | **DO NOT REUSE** as input | Unauthenticated, trusted-as-supplied | Optional downstream emitter only | — |
| Control evaluation semantics | `createAssuranceControlEvaluator` | `assurance-control-evaluation.test.ts` | REUSE (semantics) | "unknown ≠ fail", pure, injected clock | Engine | — |
| Fail-closed revocation gate | `resolveMaterialActionDecision` | P: `revocationPolicy.test.ts` | REUSE DIRECTLY (in the platform SDK) | — | — | CC-D-10 |
| Kernel external authorization port | `ExternalAuthorizationProvider` | F: `kernel-external-authorization.test.ts` | EXTEND | Implementation needed (FRONTERA-SOBE-PILOT-01C1) | Adapter | — |
| Document-use decision pipeline | `evaluateDocumentUsePolicy`, `checkDocumentUseFreshness` | F: `document-policy.test.ts`, `document-freshness.test.ts` | REUSE DIRECTLY | Wrap in a synthetic PEP | Reference PEP + bypassable variant | RN-CONFORM-04 |
| Corroboration / quorum | `assessQuorum` | X: `tests/xrpl-adapter/quorum.test.ts` | REUSE (pattern) | Inputs are observations by operator | Corroboration function | CC-D-03 |
| Source quarantine | `SourceTrustRegistry` | X: `packages/xrpl-adapter/src/trust.ts` | REUSE (pattern) | Validators | — | — |
| Scheduling / delivery | `OutboxWorker`, `RetryPolicy` | L: `tests/integration/outbox-*-postgres.test.ts` | REUSE (pattern) | SQLite/Frontera store; generalize from `outbound_events` | Job table | — |
| XRPL confirmation / idempotency | `resolveValidation`, `OperationWorker` | X: `tests/writer/*`, `tests/gateway/idempotency*` | REUSE DIRECTLY (in X) | — | Anchor tx class | CC-D-06 |
| XRPL digest anchoring | — (refused by design) | X: `signer-port/src/wire.ts` | BUILD NEW (in X) after ADR amendment | — | Anchor class + approval policy | CC-D-06 |
| XRPL credential existence marker | CredentialCreate / Delete | X: `tests/xrpl11/*` | REUSE DIRECTLY (optional) | Conformance CredentialType registry entry | Registry data | CC-D-06 |
| Authoritative status port | `AuthoritativeRecordSource` | X: `credential-gateway/src/ports.ts` | REUSE WITH ADAPTER | Status Registry implements it over HTTP | HTTP adapter | RN-CONFORM-03 |
| Integration registry | — | — | BUILD NEW | — | D1 | — |
| Validator coordinator | — | — | BUILD NEW | — | D2 | — |
| Evidence service | — | — | BUILD NEW | — | D3 | — |
| Conformance engine | — | — | BUILD NEW | — | D4 | — |
| Credential lifecycle | — | — | BUILD NEW | — | D5 | — |
| Status registry | — | — | BUILD NEW | — | D6 | — |
| Provider conformance suite | `runEnterpriseProviderConformanceSuite` | F: `packages/provider-conformance-suite` | REUSE (pattern: harness + never-throwing report + negative fakes) | Subject is storage adapters, not authorization | New harness | — |
| EVM anchoring | — | — | DEFER | — | — | CC-D-16 |
| "Sovereign Access SDK" | — | — | UNKNOWN | — | — | CC-D-10 |

## Reuse that would violate invariants (explicitly rejected)

1. Adding `active/suspended` states to `AssuranceAssessmentStatus` — breaks terminal immutability.
2. Feeding validator results through `processSignal` — signals are unauthenticated and act on the latest
   *completed* assessment.
3. Registering the conformance profile in the Assurance framework registry — conflates frameworks with
   profiles and would sit next to the frozen rn.sv definition.
4. Reading `metadata.commercialUse` to gate credentials — commercial authorization is a separate axis.
5. Treating an XRPL Credential's presence as ACTIVE — violates X INV-13.
