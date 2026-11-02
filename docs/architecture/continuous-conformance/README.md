# Republika Continuous Sovereign Conformance Network — Architecture Dossier (RN-CONFORM-01)

> **Status: PROPOSED architecture. Documentation only.**
> Nothing in this directory is implemented, deployed, registered, frozen or published.
> No validator network exists. No conformance credential has been issued. No XRPL transaction was
> made. `$SOBE` is out of scope and absent from every dependency in this dossier.
> `rn.sv@0.1.0` is unchanged and remains restricted. The Founding Assessment commercial decision
> remains **NO-GO** ([ASSURE_COMMERCIAL_GO_NO_GO.md](../../commercial/founding-assessment/ASSURE_COMMERCIAL_GO_NO_GO.md)).
> No external certification is claimed or implied.

**Mission:** RN-CONFORM-01 — cross-repository audit and integration blueprint.
**Audit baseline:** Frontera `64b3ec7c` (origin/main, contains ASSURE-GOV-02 #257), Soberania_Protocol
`590e4cb` (origin/main), xrpl-sovereign-access `3f7652f`, live-data-rail `79a42be`. See
[REPOSITORY_BASELINES.md](REPOSITORY_BASELINES.md).

## Status vocabulary

| Label | Meaning in this dossier |
|---|---|
| **IMPLEMENTED** | Code exists at the audited commit with a targeted test file. (The audit read tests; it did not run the suites.) |
| **PROPOSED** | Designed here; no code exists. |
| **BLOCKED** | Cannot proceed without a decision in [DECISION_REGISTER.md](DECISION_REGISTER.md). |
| **UNKNOWN** | Could not be verified from the available repositories. |

## Executive conclusion

Roughly **40–50 % of the mechanisms** a continuous conformance network needs already exist as tested
code, but **0 % of the network itself exists**. The reusable parts are primitives and patterns, not
services:

| Already exists and is reusable | Does not exist anywhere |
|---|---|
| Canonical JSON + SHA-256 digests (Frontera `governance-store`, Protocol `@aoc/protocol/canonical`) | Validator registry, scheduling, challenge dispatch |
| Ed25519 domain-separated signatures + trusted-key registry (Frontera `authority-authenticity`) | Multi-validator corroboration over enforcement observations |
| Challenge-bound signed receipts from a pinned independent key (Frontera authority-state witness) | A mutable credential lifecycle with SUSPENDED |
| Signed, sequenced, hash-linked status + anti-rollback high-water mark (FV `sovereign-receiver-verification`) | A credential issuer or status registry (FV only *receives* statuses) |
| Dual-human passkey decisions (AUTH-03 bootstrap authorizer) | Enforcement points for Fileverse (PKG computes decisions; nothing enforces them) |
| Tenant-scoped append-only evidence and findings (Assurance store) | Digest anchoring on any chain (XRPL vertical refuses Memos/URI by design) |
| XRPL Testnet CredentialCreate/Delete with validated-ledger confirmation and idempotent retry (xrpl-sovereign-access) | Any EVM or Bitcoin anchoring |
| Durable leased outbox + retry policy (live-data-rail) | A "Sovereign Access SDK" package (the name matches no code) |

The single most important finding: **no artifact a platform emits about its own enforcement is signed
by anyone but the platform.** Continuous conformance therefore cannot be built from SDK telemetry; it
must be built from **independent validator observations of controlled challenges**. See
[SYSTEM_ARCHITECTURE.md §3](SYSTEM_ARCHITECTURE.md#3-incompatible-assumptions-that-must-not-be-collapsed).

## Architecture in one picture

```
 Integration Registry ──► Validator Coordinator ──► Validators (≥2 independent operators)
   (platform, integration,     (challenges, deadlines,        │ signed observations
    digest, profile, scope)     idempotency)                  ▼
                                                      Conformance Evidence Service
                                                      (verify sig, binding, freshness, replay)
                                                               │ accepted evidence (append-only)
                                                               ▼
                                                      Continuous Conformance Engine
                                                      (deterministic; profile-versioned)
                                                               │ transition decisions
                                                               ▼
 Public verifiers ◄── Status Registry ◄── Credential Lifecycle (CANDIDATE/ACTIVE/SUSPENDED/REVOKED/EXPIRED)
   (signed, short-lived,          │
    nonce-bound assertions)       └──► Anchoring Adapter (XRPL Testnet first; async, never blocks suspension)
```

Assurance (`src/enterprise/assurance`) is **adjacent, not underneath**: the conformance engine may cite a
completed assessment by `{assessmentId, assessmentDigest}` but never adds states to the terminal
assessment lifecycle. See [REUSE_MATRIX.md](REUSE_MATRIX.md).

## Dossier contents

| # | Document | Purpose |
|---|---|---|
| 1 | [README.md](README.md) | This overview |
| 2 | [REPOSITORY_BASELINES.md](REPOSITORY_BASELINES.md) | Repositories, commits, worktree state |
| 3 | [EXISTING_CAPABILITIES.md](EXISTING_CAPABILITIES.md) | Code-backed inventory (B1–B5) |
| 4 | [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | Current boundaries, bounded contexts, data flows |
| 5 | [INTEGRATION_CONTRACTS.md](INTEGRATION_CONTRACTS.md) | Proposed identities, envelopes, APIs |
| 6 | [CONFORMANCE_PROFILE_DRAFT.md](CONFORMANCE_PROFILE_DRAFT.md) | `rn.conformance.integration@0.1.0` (provisional) |
| 7 | [VALIDATOR_PROTOCOL.md](VALIDATOR_PROTOCOL.md) | Challenges G01–G10, evidence, corroboration |
| 8 | [CREDENTIAL_LIFECYCLE.md](CREDENTIAL_LIFECYCLE.md) | State machine and transition rules |
| 9 | [STATUS_VERIFICATION.md](STATUS_VERIFICATION.md) | Public status contract and freshness |
| 10 | [XRPL_ANCHORING.md](XRPL_ANCHORING.md) | XRPL-first anchoring strategy |
| 11 | [FILEVERSE_COVERAGE.md](FILEVERSE_COVERAGE.md) | Evidence-based Fileverse coverage matrix |
| 12 | [THREAT_MODEL.md](THREAT_MODEL.md) | Threats, mitigations, residual risk |
| 13 | [REUSE_MATRIX.md](REUSE_MATRIX.md) | Reuse / adapt / build decisions |
| 14 | [MVP_IMPLEMENTATION_PLAN.md](MVP_IMPLEMENTATION_PLAN.md) | RN-CONFORM-02…06 missions |
| 15 | [DECISION_REGISTER.md](DECISION_REGISTER.md) | Open founder / architecture decisions |

## Recommended next mission

**RN-CONFORM-02 — Synthetic Conformance Circuit**, entirely inside Frontera, synthetic-only, behind no
route. It is the only mission with no external dependency and it exercises the security invariant
(*no ACTIVE after an accepted confirmed critical violation*) end to end. Two decisions should be taken
first: [CC-D-01](DECISION_REGISTER.md#cc-d-01) (canonicalization profile) and
[CC-D-03](DECISION_REGISTER.md#cc-d-03) (corroboration threshold). See
[MVP_IMPLEMENTATION_PLAN.md](MVP_IMPLEMENTATION_PLAN.md).
