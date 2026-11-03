# MVP Implementation Plan

RN-CONFORM-01 implements nothing. This plan defines bounded follow-on missions. Complexity figures are
**estimates** (engineer-weeks, one experienced engineer, excluding review latency).

## 1. Dependency structure (revised from the mission brief)

The audit shows that Fileverse has no enforcement point and XRPL refuses digest anchoring. The brief's
order is therefore adjusted: a synthetic PEP is needed **before** Fileverse coverage, and XRPL anchoring
needs an ADR in another repository, so it is split out.

```
RN-CONFORM-02 Synthetic Conformance Circuit (Frontera)
   ├──► RN-CONFORM-03 Status Verification (Frontera)
   │        └──► RN-CONFORM-03X XRPL Testnet Anchor Class (xrpl-sovereign-access; after CC-D-06)
   ├──► RN-CONFORM-04 Fileverse Reference PEP & Coverage (Frontera; synthetic)
   └──► RN-CONFORM-05 Federated Validator Operations (Frontera + validator package)
              └──► RN-CONFORM-06 Production readiness gate (decisions + external review; no code)
```

## 2. The MVP demonstration (RN-CONFORM-02 + 03)

Scenario steps (mission §16) with acceptance criteria. Everything synthetic, in-process or local
processes, no routes, no network beyond localhost, no real keys.

| Step | Action | Acceptance criterion |
|---|---|---|
| 1 | Register synthetic platform + integration v1 | `integrationDigest` deterministic; golden test |
| 2 | Assign `rn.conformance.integration@0.1.0` (pinned by digest) | Profile digest golden test; registry rejects unknown profile |
| 3 | Coordinator issues challenges G01, G02, G05, G06, G07, G08 | Each has unique id + 32-byte nonce; idempotent re-issue |
| 4 | Validators A and B (separate key material, separate operator ids `op-synthetic-a`, `op-synthetic-b`) sign observations | Signatures verify under pinned keys; labelled `corroboration: 'single-operator'` because both are Republika-run |
| 5 | Evidence service accepts; engine corroborates | All 10 rejection codes covered by negative tests |
| 6 | Issue synthetic credential (two synthetic human decisions) | Transition T2 recorded, signed, chained |
| 7 | Local verifier returns ACTIVE | Verifier algorithm §2 implemented; never throws |
| 8 | Switch fixture to a bypassing enforcement path (G01 fails) | Fixture flag only; no production code path |
| 9 | Both validators observe violation | `VERIFIED_FAILURE` |
| 10 | Automatic `ACTIVE → SUSPENDED` | **Atomic** with evaluation; trigger refuses violation-without-transition |
| 11 | Next authoritative verification returns SUSPENDED | Online mode immediately; offline ACTIVE assertion rejected after `validUntil` |
| 12 | Transition + evidence digest recorded | Chain verifies; recompute-everything verifier passes |
| 13 | Prepare **simulated** XRPL anchor | Anchor record `prepared`; payload ≤ 64 bytes; no network call (structure test) |
| 14 | Correct the fixture | — |
| 15 | Revalidate all critical requirements; two synthetic approvals; `SUSPENDED → ACTIVE` | Reinstatement needs **all** critical passes, not only the failed one |
| 16 | Final status + history | Verifier sees ACTIVE with `stateVersion = 3`; history shows T2, T4, T5 |

### Required adversarial tests

| Test | Expectation |
|---|---|
| Race: violation and pass evaluated concurrently | Exactly one head; violation wins if confirmed; CAS conflict surfaces |
| Replay of an accepted observation | `REPLAYED`, no state change |
| Duplicate challenge dispatch | Same challenge returned; one observation per validator |
| Missing evidence past window | SR-2 suspension with `EVIDENCE_STALE` |
| Stale verification (old ACTIVE assertion) | Rejected after `validUntil`; rollback detected by high-water mark |
| Single malicious validator reports violation | Remains ACTIVE `UNDER_INVESTIGATION`; second operator clears or confirms |
| Investigation timeout | SR-4 suspension, never revocation |
| Revoked validator key | Observation rejected |
| Profile downgrade in observation | `PROFILE_DOWNGRADE` |
| Anchor adapter throws | Suspension still committed and served |
| Structure tests | No HTTP route, no network, no `xrpl` import, no `$SOBE`/token symbols, no assurance store writes |

## 3. Missions

### RN-CONFORM-02 — Synthetic Conformance Circuit
* **Objective:** D1–D5 + minimal D6 in-process; steps 1–12, 14–16.
* **Repository:** Frontera only. New `src/enterprise/conformance/` (no route, not composed into Host).
* **Boundary:** Imports allowed: `governance-store/{canonical-json,digest}`, `authority-authenticity/*`. Forbidden: `assurance/*` writes, HTTP adapters, `xrpl`.
* **Changes:** contracts, profile constant + golden digest, SQLite store with forward-only triggers, engine, lifecycle, synthetic validators and fixture platform, verifier library.
* **Dependencies:** CC-D-01, CC-D-03 (defaults usable: plain-JSON constraint, k = 2).
* **Tests:** all of §2; targeted suites only, ≤ 600 s each.
* **Invariants:** §5 of [CREDENTIAL_LIFECYCLE.md](CREDENTIAL_LIFECYCLE.md).
* **Done when:** demonstration test passes in CI; rn.sv golden digest unchanged; GO/NO-GO doc unchanged.
* **Risks:** scope creep into Host composition; signing-domain registry changes touching CORE-02 tests.
* **Merge conditions:** CI + CodeQL green; independent review; no public API change (`check-api-freeze`).
* **Estimate:** 4–6 engineer-weeks.

### RN-CONFORM-03 — Status Verification
* **Objective:** Signed status assertions, online nonce mode, stapled mode, verifier library, freshness model; step 13 simulated anchor record.
* **Repository:** Frontera. HTTP route behind a disabled-by-default flag, local only.
* **Dependencies:** RN-CONFORM-02; CC-D-07 (status key custody), CC-D-13.
* **Done when:** STATUS_VERIFICATION §2 conformance tests; no endpoint deployed.
* **Estimate:** 2–3 engineer-weeks.

### RN-CONFORM-03X — XRPL Testnet Anchor Class
* **Objective:** ADR amendment + anchor transaction class + approval policy; Testnet only.
* **Repository:** xrpl-sovereign-access.
* **Dependencies:** CC-D-06 decided; RN-CONFORM-03 anchor record schema.
* **Done when:** claim-gate style evidence on Testnet with operator approval; Mainnet refused by tests.
* **Estimate:** 2–3 engineer-weeks.

### RN-CONFORM-04 — Fileverse Reference PEP & Coverage
* **Objective:** Synthetic PEP wrapping the document-use pipeline for open/export/modify; bypassable fixture variants for G01, G02, G04, G05, G07; coverage matrix becomes executable.
* **Repository:** Frontera (+ Protocol fixtures if needed, separate PR).
* **Dependencies:** RN-CONFORM-02; CC-D-12 for anything beyond synthetic.
* **Done when:** all challenges pass on the conformant PEP and fail on the bypass variants.
* **Estimate:** 3–4 engineer-weeks.

### RN-CONFORM-05 — Federated Validator Operations
* **Objective:** Standalone validator package, enrollment, heartbeats, scheduling (outbox pattern), quarantine, key rotation, ≥ 2 independent operators.
* **Dependencies:** RN-CONFORM-02/03; CC-D-02 (operator agreements).
* **Estimate:** 5–8 engineer-weeks.

### RN-CONFORM-06 — Production Readiness Gate
* **Objective:** Decisions, contracts, external security review, DR drill. No production activation without explicit founder approval.

## 4. PR policy for follow-on missions

One PR per mission per repository. No PR spans repositories. No automatic merges.
