# System Architecture — Current Boundaries and Proposed Bounded Contexts

Part 1 reconstructs what exists (IMPLEMENTED). Part 2 is PROPOSED.

## 1. Current architecture, from code

| # | Question | Answer at the audited commits |
|---|---|---|
| 1 | Where is authority evaluated? | Protocol `AuthorizationRuntime.evaluate` (P: `packages/authorization-runtime`); Frontera Kernel (`src/kernel`, `KernelDecisionStatus`); FV document use in `packages/sovereign-receiver-verification` (`evaluateDocumentUsePolicy`). |
| 2 | Where does policy enforcement occur? | Frontera Kernel + execution-capability gate for governed actions (`src/enterprise/execution-capability-gate`, single-use consumption). **For documents: nowhere** — FV results carry `authorization: 'not_evaluated'`, `execution: 'not_performed'`; enforcement is FV-P5 (not started). |
| 3 | Who owns evidence? | Assurance stores **references**, never copies (`AssuranceEvidenceReference`); the owner is the store-recorded organization (`attributeEvidenceBundle`). Evidence Bundle v2 is owned by the Host evidence service. |
| 4 | Who authenticates an operator? | Host API keys (`src/enterprise/adapters/node-http-adapter.ts` caller context); AUTH-03 passkeys for human decisions (`src/enterprise/human-identity`, `src/authority-web`). |
| 5 | Who authenticates a validator? | **Nobody — validators do not exist.** Nearest: pinned witness key (`authority-state-freshness`), pinned executor keys (`executor-receipt/verifier.ts`). |
| 6 | Where are findings persisted? | `assurance_findings` + `assurance_finding_events` in `createSqliteAssuranceStore` (schema `aoc.assurance-store.schema.v1`). |
| 7 | Who can change credential state? | No credential exists. Analogues: FV sovereign status is changed only by the asset **registrant** signing a new status; Frontera history writes need `compareAndSet`, and (re-)anchoring needs two AUTH-03 human decisions. |
| 8 | Who verifies credentials today? | FV `verifySovereignStatus` (receiver side); X `credential-gateway` dual-half verification (authoritative half is a stub). |
| 9 | What can be anchored on XRPL today? | Only the **existence** of an XRPL Credential `(Issuer, Subject, CredentialType[, Expiration])`. No digests, no memos, no URI (X ADR-002, `signer-port/src/wire.ts`). |
| 10 | Which trust boundaries exist? | Org/tenant boundary (Assurance store); Host ↔ witness (separate restore domain); Host ↔ executor (pinned receipts); Host ↔ out-of-process signer (CORE-02, X signer-service); issuer ↔ receiver (FV); Testnet ↔ Mainnet (X network deployment). |

## 2. Trust boundaries relevant to conformance

```
┌───────────────────────── Subject platform (untrusted for conformance) ─────────────────────────┐
│  SDK / adapter  ──►  enforcement point (may or may not exist)  ──►  protected asset / storage  │
│  self-signed audit events (P: AuditRuntime) — SELF-ASSERTED                                     │
└───────▲────────────────────────────────────────────────────────────────────────────────────────┘
        │ TB-1: authorized test endpoints only (synthetic fixtures until authorized)
┌───────┴──────────────┐   ┌──────────────────────┐
│ Validator A (op. X)  │   │ Validator B (op. Y)  │   TB-2: each validator holds its own key;
│ own Ed25519 key      │   │ own Ed25519 key      │         operators are distinct legal/admin domains
└───────┬──────────────┘   └──────────┬───────────┘
        │ signed observations (TB-3: evidence ingress)
┌───────▼──────────────────────────────▼──────────────── Republika conformance control plane ─────┐
│ Evidence Service → Engine → Credential Lifecycle → Status Registry (status-signing key, TB-4)  │
│ Human decisions (AUTH-03, two people) for issuance/revocation/appeal (TB-5)                      │
└───────┬───────────────────────────────────────────────┬──────────────────────────────────────────┘
        │ TB-6: public read-only                         │ TB-7: anchoring signer (separate process)
   Enterprise verifiers                             XRPL Testnet (historical evidence only)
```

## 3. Incompatible assumptions that must not be collapsed

| Concept A | Concept B | Why they differ | Consequence |
|---|---|---|---|
| Assurance assessment (`completed` is terminal, immutable) | Conformance credential state (mutable, recurring) | A/`assessment.ts` forbids content writes after completion; signals act only on the latest completed assessment | Build a **separate** append-only conformance store; reference assessments by digest only |
| Reviewer authentication (static bearer secret, one org) | Validator authentication (distributed agents, per-message signatures) | A/`reviewer-identity.ts` has no keys or signatures | New validator identity using pinned Ed25519 keys (witness/executor pattern) |
| SDK event | Independent proof of enforcement | Every platform-emitted event is signed by the platform's own key | SDK events are *supporting* evidence only; never sufficient for a pass |
| Report release (`assure.report-release`) | Platform conformance credential | Release is a point-in-time document about an organization | Different entities, different keys, different status enums |
| Framework commercial authorization (GOV-01, DOC) | Platform conformance status | One is about whether *Republika may sell a framework*; the other about *a platform's integration* | Separate axes; conformance must not read `metadata.commercialUse` |
| Chain anchor | Current credential state | XRPL Credential = existence marker (X ADR-002, INV-13) | Status Registry is authoritative; anchors are history |
| FV sovereign status `active/withdrawn` (registrant-issued, about a document) | Conformance status (Republika-issued, about an integration) | Different issuer, subject and state space | Reuse the *format pattern and verifier logic*, not the type |
| Assurance `ContinuousAssuranceStateKind` (`current/stale/degraded/critical/unknown`, derived, unauthenticated input) | Credential state | Signals are trusted as supplied | Do not drive credentials from `processSignal` |

## 4. Proposed bounded contexts (PROPOSED)

All seven contexts are new code. Recommended home: a new Frontera module `src/enterprise/conformance/`
(sibling of `assurance/`, no imports from `assurance/` except digest/canonical utilities), with
validator-side code in a separate package so it can run outside the Host. See [CC-D-09](DECISION_REGISTER.md#cc-d-09).

| Context | Responsibility | Owns (writes) | Reads | Reuses |
|---|---|---|---|---|
| **D1 Integration Registry** | Platform + independently versioned integration identity | `integration` records (append-only versions) | — | Assurance tenant scoping pattern |
| **D2 Validator Coordinator** | Assignment, challenge issuance, deadlines, idempotency, health | `challenge`, `assignment`, `validator` records | D1 | Witness challenge pattern; L outbox pattern |
| **D3 Conformance Evidence Service** | Verify and accept validator observations | `accepted_evidence` (append-only), `rejected_submission` | D1, D2 | `authority-authenticity` signatures; `governance-store` digest |
| **D4 Continuous Conformance Engine** | Deterministic evaluation of evidence against profile | `evaluation` records | D3, profile | Assurance `control-evaluator` *semantics* (unknown ≠ fail) |
| **D5 Credential Lifecycle** | State machine; only writer of credential state | `credential`, `transition` (append-only, hash-chained) | D4, human decisions | AUTH-03 dual-human authorizer; `event-chain.ts` |
| **D6 Status Registry** | Serve signed current status | signed status assertions | D5 | FV `SignedSovereignStatusV1` pattern + high-water mark |
| **D7 Anchoring Adapters** | Publish digests of transitions to a chain | `anchor` records | D5 | X write path, confirmation, idempotency |

## 5. Data flows

**F1 — Recurring check.** D2 issues `challenge{challengeId, nonce, integrationDigest, controlId, deadline}`
to ≥2 validators → validators execute against authorized fixture endpoint → each returns a signed
`observation` echoing `challengeId` + `nonce` → D3 verifies → D4 evaluates when the corroboration window
closes or quorum is reached → D5 transitions if rules fire → D6 issues a new signed status → D7 enqueues
the transition digest for anchoring.

**F2 — Suspension (critical path).** D4 emits `CONFIRMED_CRITICAL_VIOLATION` → D5 commits
`ACTIVE → SUSPENDED` **in the same transaction** that records the confirming evaluation → D6 stops
issuing ACTIVE assertions immediately (online mode) → cached ACTIVE assertions die at `validUntil`
(≤ 15 min proposed). D7 runs afterwards; failure there never reverts or delays the suspension.

**F3 — Public verification.** Verifier sends `{credentialId, expected subject, profile, nonce}` → D6
returns a signed assertion echoing the nonce, or a stapled assertion → verifier checks signature against
the pinned Republika status key, bindings, `validUntil`, and its own high-water mark.

**F4 — Human intervention.** Revocation, reinstatement after a critical violation, appeals and validator
revocation require two distinct AUTH-03 human decisions bound to a digest of the exact transition
(pattern: `createHumanDecisionBootstrapAuthorizer`).

## 6. Deliberate non-goals

No token, staking, slashing, rewards or token-based validator selection. No new blockchain. No
consensus among validators — corroboration is evaluated by Republika's engine; validators are
witnesses, not deciders. No production endpoints.
