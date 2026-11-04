# RN-CONFORM-06 — Security and Production Gaps

Read-only findings. Each gap names its evidence, the **lowest level it blocks** (L1 external synthetic
presentation, L2 design-partner pilot, L3 public validator network, L4 commercial service) and its roadmap item in
[RN_CONFORM_06_IMPLEMENTATION_ROADMAP.md](RN_CONFORM_06_IMPLEMENTATION_ROADMAP.md). Severity is for the level it
blocks. Nothing here is an accredited audit finding.

## A. Pre-activation blockers already recorded

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-01 | **RN-05 P2-3** — the RN-CONFORM-02 coordinator issues challenges without verifying a testing authorization, fixture scope or one-validator-per-operator assignment; only the federation scheduler enforces them. Unexploitable today only because the coordinator is reachable from nothing but the module and its tests. | RN_CONFORM_05_IMPLEMENTATION.md "P2-3 pre-activation gate"; `coordinator.ts` (identifier check only on `fixtureRef`) | L2 | **Blocker** | P1-01 |
| G-02 | **RN-05 S-1** — a credential registered later on a requalification fixture would count earlier probation evidence; no lifecycle-level reservation of requalification integrations. Moot for a pilot that creates no credential, but closed in P1-01 because it is cheap and the reservation must exist before any credential. | RN-05 remediation table S-1 | L2 | High | P1-01 |
| G-20 | **RN-03X P2-3** — XRPL node identity is self-reported; NetworkID 1 does not prove the public Testnet. Blocks every live anchor operation. | ADR-009 §19 (`docs/adr/ADR-009-governed-testnet-conformance-anchor.md`, xrpl-sovereign-access) | anchoring (L3/L4); **not** L2 if the pilot excludes anchoring | Blocker for anchoring | P2-08 |

## B. Key custody and human authority

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-03 | Coordinator, registry/transition and status-issuer keys are in-process `KeyObject`s; synthetic test keys are derived from public strings. No external signer, KMS or HSM path for conformance. | `coordinator.ts:83–89`; `lifecycle.ts:208–211`; `status-signer.ts:55–57`, synthetic signer only; CC-D-07 OPEN | L2 | **Blocker** | P1-03 |
| G-04 | Validator keys: the `ObservationSigner` port exists, but only ephemeral test signers implement it. | `federation-validator-runtime.ts:29–33` | L2 | High | P1-03 |
| G-05 | Human decisions use a synthetic Ed25519 directory, not AUTH-03 passkeys; decision lifetime 15 min (AUTH-03: 120 s); no UV flag, no identity chain. | `human-authority.ts`; RN_CONFORM_02_IMPLEMENTATION.md:113–114 | L2 | **Blocker** | P1-04 |
| G-06 | Key compromise / rotation runbooks for coordinator, registry and status keys do not exist (validator generations are rotatable; issuer-side keys are not operationally rotatable). | THREAT_MODEL.md T11 (status-key compromise, Critical); RN-05 §26 | L2 (runbook), L4 (HSM) | High | P1-03, P2-02 |

## C. Transport and exposure

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-07 | No network transport between coordinator and validators; the runtime's executor is "never given a URL" and refuses any environment except `synthetic`. | RN-05 L21, L295; `federation-validator-runtime.ts:44–47, 274–279` | L2 | **Blocker** | P1-05 |
| G-08 | No authenticated, replay-protected request envelope for validator ↔ coordinator; reusable patterns exist (CORE-02 external-signer transport, CORE-07 witness transport, executor receipts) but none is wired. mTLS exists nowhere. | `external-authority-signer/http-transport.ts:12–31`; `authority-state-freshness/http-transport.ts` | L2 | High | P1-05, P2-03 |
| G-09 | Status HTTP surface: in-memory test-only rate limiter, unauthenticated reads, GET responses disclose public fields for any id and 404 is an existence oracle (RN-03 P2-D accepted for synthetic MVP). | RN_CONFORM_03_IMPLEMENTATION.md:219–235; CC-D-13 OPEN | L2 if status is exposed (recommendation: not exposed in pilot); L3 | High | P2-05 |

## D. Persistence, DR, monitoring

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-10 | No conformance store is in the backup store registry; no restore drill exists for them. | `scripts/portability/store-registry.mjs` (no conformance entry); BACKUP_RECOVERY_V1.md covers other stores | L2 | High | P1-06 |
| G-11 | Status-signer journal: restoring it would not be detected; it "must never be restored", but no DR design states how. | RN_CONFORM_03_IMPLEMENTATION.md:201–207, 237–240 (N-7) | L2 | High | P1-06 |
| G-12 | Federation `state_seq` rollback pin exists but is optional and never persisted outside the store; the conformance store has no equivalent pin (whole-database rollback between anchors — THREAT_MODEL T10 Critical). | `federation-store.ts:532–533`; RN-05 P3-6 | L2 (pin), L3 (anchoring) | High | P1-06 |
| G-13 | No alerting; federation events (HEARTBEAT_MISSED, QUEUE_FULL, QUORUM_INSUFFICIENT, REGISTRY_DIVERGENCE) are not wired to telemetry; `syncFromConformance` must be scheduled. | RN-05 §25–26 | L2 | Medium | P1-06 |
| G-14 | SLOs are proposed, not measured; timing values are engineering defaults. | CREDENTIAL_LIFECYCLE.md:82–91; CC-D-05 OPEN | L4 (commercial promise) | Medium | P2-06 |

## E. Integration fidelity

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-15 | No real enforcement point: FV-P5 not started; the reference PEP is test code; no real SDK identity (CC-D-10), no authoritative lock (CC-D-11). | FILEVERSE_COVERAGE.md:16, :38; RN_CONFORM_04_IMPLEMENTATION.md:50–51 | L2 (needs the partner's PEP) | **Blocker** | P1-07 (partner side) |
| G-16 | No executor that can reach an authorized endpoint; no `AuthorizedEndpoint{url, environment, authorizationRef}` implementation; synthetic CHECK constraints forbid non-synthetic data. | INTEGRATION_CONTRACTS.md:44–48; store CHECKs | L2 | **Blocker** | P1-02, P1-07 |
| G-17 | **Recognisable probes** — fixed principals, the nonce never reaches the PEP, so a probe-aware bypass is undetectable; detection only when challenges run. | RN_CONFORM_04_IMPLEMENTATION.md:25–31 | L2 (must be disclosed), L4 (must be mitigated) | High | P1-07, P2-07 |
| G-18 | G08 trusts the integration's self-reported deployment digest; an independent attestation source is required for any real claim. | RN-04 L29 | L4 | High | P2-07 |
| G-19 | CR-10 and CR-11 (human data-minimization review) are not covered. | RN-04 L60, L130 | L4 | Medium | P2-07 |

## F. XRPL anchoring

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-21 | No live `AnchorLedgerPort` (F-3), no signer-service anchor approvals (F-4, invalidates XRPL-11 qualification), no gateway wiring (F-5). | RN-CONFORM-03X implementation record, follow-ups | anchoring | High | P2-08 |
| G-22 | Frontera has no anchor-intent envelope issuer or key (F-2), cannot represent a confirmed anchor (`cc_anchor_intents` CHECK `prepared`, `anchors: never[]`), and has no salt custody. | `anchor-intent.ts:5–18`; `sqlite-conformance-store.ts:411–422`; `status-contracts.ts:64–65` | anchoring | High | P2-08 |
| G-23 | Stale `XRPL_ANCHORING.md` (unsalted payload, pinned `3f7652f`) contradicts ADR-009 §5; CC-D-06 adoption not recorded in the register. | XRPL_ANCHORING.md:1–3, :59; DECISION_REGISTER.md:14 | L1 (accuracy) | Low | P0-01 |

## G. Governance, legal and claims

| Id | Gap | Evidence | Blocks | Severity | Roadmap |
|---|---|---|---|---|---|
| G-24 | **CC-D-15 commercial terms** (pricing, onboarding/KYC, appeal SLA, liability, naming) never dispositioned; platform impersonation residual depends on KYC (THREAT_MODEL T06). | DECISION_REGISTER.md:23 | L2 (pilot terms), L4 | **Blocker** | P1-08 |
| G-25 | **CC-D-12** — no written authorization from any platform; no FV-P5 owner named. | DECISION_REGISTER.md:20, 47–48 | L2 | **Blocker** | P1-08 |
| G-26 | Naming collision: the Provider Conformance Suite calls itself "the official certification mechanism" / "certified against"; a publicly disclosable `'certified'` governance level is unearned. Risk of confusing either with platform conformance. | ADR-PROVIDER-CONFORMANCE-SUITE.md:217, 403; packages/provider-conformance-suite/README.md:12, 33; `packages/agent-governance/src/passport/governance-level.ts:7`; AOC_ASSURANCE_CURRENT_MODEL.md:28 | L1 | Medium | P0-02 |
| G-27 | Continuous-conformance README is stale ("Nothing in this directory is implemented", diagram "≥ 2 independent operators" without a synthetic qualifier; index omits RN-04/05); `corroboration: 'single-operator'` label is not carried in status assertions. | README.md:4–6, :55, :77–95; VALIDATOR_PROTOCOL.md:15–17; RN-05 L297–298 | L1 (README), L2 (label) | Medium | P0-01, P1-02 |
| G-28 | Insider collusion (two insiders + validators) and operator collusion (k genuinely separate operators) are not prevented by any threshold. | THREAT_MODEL.md T03, T21 (Critical) | L3/L4 (governance controls) | Critical residual | P2-01 |
| G-29 | No independent external (human) security review of the conformance module; all reviews so far are AI reviews. | THREAT_MODEL.md:3; RN-02..05 records | L2 (scoped review), L4 (accredited audit) | High | P1-09, P2-09 |

## G2. Pilot-specific gaps (surfaced by the independent review)

| Id | Gap | Blocks | Severity | Roadmap |
|---|---|---|---|---|
| G-30 | **Egress / SSRF**: validators would call partner-controlled staging (untrusted, TB-1) from the private network; no defence against redirects, DNS rebinding to internal addresses, oversize/slow responses, or lateral reach to the coordinator/signer | L2 | **Blocker** | P1-05, P1-07 |
| G-31 | **Pilot hosting baseline**: raw-writer residuals mean whoever can reach the host can tamper with or wedge evidence; no host hardening, privileged-access control/logging, encryption at rest or log retention defined | L2 | **Blocker** | P1-12 |
| G-32 | **Findings and data handling**: the pilot output is effectively a vulnerability report; no notification/embargo/encryption/retention/destruction path; append-only stores conflict with erasure duties; personal data in staging responses; partner-issued probe principals are secrets | L2 | **Blocker** | P1-06, P1-07, P1-08 |
| G-33 | **No technical stop or rate controls**: no immediate authorization revocation, no per-authorization probe rate/volume caps (timeout/unavailability probes could overload staging) | L2 | High | P1-01 |
| G-34 | **Staging ≠ production** (THREAT_MODEL T07, Critical): a staging result says nothing about production builds; must be disclosed in every pilot artefact | L2 | High (disclosure) | P1-10 |
| G-35 | **No pilot conformance profile**: only synthetic profiles are pinned | L2 | **Blocker** | P1-11 |
| G-36 | **Report misuse**: a signed, offline-verifiable report could be presented publicly as "verified/conformant by Republika" | L2 | High | P1-08, P1-10 |
| G-37 | **Supply chain and key ceremony**: dependency pinning (incl. native `better-sqlite3`), build provenance, generation and authentic distribution of pilot keys | L2 | High | P1-03, P1-12 |

## H. Residuals accepted for the synthetic MVP (carry forward, re-decide before L2)

RN-02: unsigned acceptance time (P3-F), raw-writer rows detected not prevented, CC-D-14 registry defects, sparse-array
canonicalizer defect F-1. RN-03: SEQUENCE_DIVERGED needs manual recovery; transitions endpoint returns digests, not
signed records. RN-04: P3-3/4/5/6/7/9/10. RN-05: P3-3, P3-4, P3-7, C-5, C-8, C-9, S-2..S-4. Each is documented in its
implementation record; none is a pilot blocker on its own, but the pilot's external review (P1-09) must re-assess
them with the pilot's threat model.
