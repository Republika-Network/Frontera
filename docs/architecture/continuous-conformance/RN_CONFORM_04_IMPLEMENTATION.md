# RN-CONFORM-04 — Synthetic Reference PEP and Executable Coverage

**Status:** IMPLEMENTED — synthetic, in-process, test-only. This is a **technical demonstration**. It is not a Fileverse integration and **not a Fileverse certification** (CC-D-15: never "certified").

The implementation:

- contacts no Fileverse system, staging environment, network, ledger or customer data;
- deploys nothing;
- leaves every production authorization path unchanged.

## 1. Objective and result

**The question:** can an integrated platform bypass its authorization enforcement while still presenting a valid Republika conformance credential?

**What this mission demonstrates:** with the RN-CONFORM-02 engine and RN-CONFORM-03 status unchanged, it cannot do so for longer than the corroboration window. A synthetic Fileverse-inspired reference PEP was built, every coverage-matrix challenge (G01–G08) was made executable for every covered operation, and eight deliberately defective variants were implemented. Each variant produces a **corroborated** VERIFIED_FAILURE on its control, for the defective operation only. On an ACTIVE credential the violation triggers an automatic, atomic ACTIVE → SUSPENDED transition, and a newly signed online status then reports SUSPENDED. Reinstatement requires all three of:

- a remediation statement;
- full critical revalidation;
- two distinct humans.

| Demonstrably functional (measured by tests) | Synthetic (mocked fixture behaviour) |
| --- | --- |
| Engine classification, corroboration, suspension, reinstatement, signed status, history verification, evidence acceptance and its refusals | The document workflow, its decision authority and storage, the defects, the validators and operators, and the human approvers |

## 2. Baseline

- **Frontera:** `origin/main` `ccbeff0d` (#268). Worktree `CONFORM-04`, branch `feat/rn-conform-04-fileverse-reference-pep`.
- **Dependencies verified merged:**

  | Mission | PR | Merge commit |
  | --- | --- | --- |
  | RN-CONFORM-01 | #261 | `f36d9dd5` |
  | RN-CONFORM-02 | #263 | `681d9a06` |
  | RN-CONFORM-03 | #266 | `fc5604ef` |

- **xrpl-sovereign-access #16** (RN-CONFORM-03X) is merged as `a2c09b77`. It is context only: nothing here imports it, and the structure tests forbid ledger code in conformance modules.

## 3. Decisions (all remain OPEN in the decision register)

| Decision | Disposition for this mission |
| --- | --- |
| **CC-D-10 — SDK identity** | **OPEN.** No "Sovereign Access SDK" exists. Frontera's SDK-named packages are transport-only (`enterprise-host-sdk`), and `@aoc/aoc-sdk` has no Frontera consumer. The reference profile pins an explicitly named **synthetic reference adapter contract**, `@republika-synthetic/document-use-reference-adapter` 1.x, which the fixture implements. This designates neither the XRPL vertical nor any real package. |
| **CC-D-11 — Protocol lock** | **OPEN.** `protocol-consumer.lock.json` (rc.3, commit `fd705f68…`, sha256 `3d17beff…58f4`, off Protocol main, squash-merged as `3cb635db…`, identical package tree) is what scripts and CI read. `enterprise-integration.lock.json` (rc.1, `eec79cdd…`, sha256 `b0d6ee6f…3f60`) is the frozen P0-PKG-08 handoff record and is read by nothing. RN-CONFORM-04 uses only the currently approved dependency identity (`file:./vendor/aoc-protocol-0.2.0-rc.3.tgz`) and changes neither lock. |
| **CC-D-12 — Fileverse authorization** | **SYNTHETIC ONLY**, per the founder's direction. In-process fixtures only. There are no Fileverse requests, staging, endpoints, credentials or documents, and no use of the brand as an endorsement (the profile id is `rn.conformance.document-use-reference`). Any real integration test needs a written, scoped, time-boxed authorization naming the FV-P5 owner, the environment, its data and the stop conditions. |

## 4. What is reused, wrapped and synthetic

| Component | Treatment |
| --- | --- |
| Challenge contracts, coordinator signatures, nonces (32 B), validator enrollment, observation signatures, evidence acceptance, corroboration (CC-D-03), engine, lifecycle, human authority, RN-CONFORM-03 status signer, registry and verifier | **Reused unchanged.** |
| `CHALLENGE_TYPES` / `CHALLENGE_CATALOGUE` | **Extended** with G03 (CR-03, `denied`) and G04 (CR-04, `denied`). A challenge is still admitted only when the pinned profile has its requirement, so the RN-CONFORM-02 circuit profile still refuses them (`CHALLENGE_NOT_IN_PROFILE`). |
| `rn.conformance.document-use-reference@0.1.0` | **New pinned profile** (`sha256:ce109637…c3d3`). Requirements: CR-01..08 (validator-corroborated; CR-03/04 via G03/G04), CR-09, CR-12. CR-10 and CR-11 are declared not covered. The two earlier pins are byte-for-byte unchanged. |
| FV-P2 `verifyDocumentUseEligibility`, FV-P3 `evaluateDocumentUsePolicy`, FV-P4C `checkDocumentUseFreshness` / `establishStatusHistory` | **Wrapped.** `tests/conformance-reference-real-pipeline.e2e.test.mjs` runs the same PEP over them, on the pre-signed `fv-p4c2a` fixture, for every decision and every revocation check. |
| The decision authority, document storage, defects, validators and approvers used by the conformance scenarios | **Synthetic.** In `src/enterprise/__tests__/conformance-reference-*.ts`, imported by nothing outside tests. |

The conformance scenarios use the deterministic synthetic authority rather than the FV pipeline for two reasons. FV decisions are provenance-locked to the process that issued them, and the fixture's statuses expire at a fixed instant. The e2e test proves the PEP enforces correctly over the real pipeline.

## 5. PEP design

`executeProtectedDocumentOperation(request, ports)` lives in `src/enterprise/__tests__/conformance-reference-pep.ts`. The ports are:

- `AuthorizationPort.decide` — the policy layer;
- `RevocationPort.revocationOf` — the signed-status layer;
- `ProtectedDocumentStore` — the resource;
- an injected fixture clock.

Execution order, recorded as a trace per request:

1. request schema (closed keys)
2. principal and organization context
3. exact resource binding in the caller's organization
4. policy and signed terms digest
5. a decision: the one the caller carries (verified, never silently refreshed), or a fresh one from the dependency
6. signature and full binding (actor, organization, document, operation, terms claim and digest)
7. freshness ceiling, clock-rollback refusal, and revocation status on **every** operation (`UNKNOWN` blocks)
8. an explicit ALLOW for this operation
9. the protected action
10. minimal evidence, as a digest only

The PEP denies on: missing, invalid or forged decision; expiry; revocation; unknown revocation; organization, resource, operation or terms mismatch; dependency unavailable, timeout (25 ms) or malformed answer.

The store serves content only to a **single-use capability** minted by the PEP after step 8. The capabilities live in a module-private `WeakSet`, so nothing else can create one. Export is assembled whole after the capability is consumed, so there is no partial stream to escape.

## 6. Protected operations, fixtures and defects

| Operation | FV action | Ceiling | Authorized principal |
| --- | --- | --- | --- |
| `document.open` | `aoc.licensing:access` | 86 400 s | alpha-reader |
| `document.export` | `soberania.document:export` | 900 s | alpha-editor |
| `document.modify-protected-terms` | `soberania.document:modify-protected-terms` | 900 s | alpha-editor (owner) |

**Fixture world.** Two organizations. Authorized and unauthorized principals. A beta principal holding every role: the role-based authority, like FV, which carries no organization, would allow it anywhere. Protected and unprotected documents carrying sentinel bytes. Revocable terms, unknown revocation, and an unavailable, slow or malformed dependency.

**Defective variants.** Each is a switch on the test-only `ReferenceDeployment` object, optionally scoped to operations. No runtime configuration can create one.

| Variant | Defect | Detected by (corroborated VERIFIED_FAILURE) |
| --- | --- | --- |
| BYPASS-01 | executes without obtaining or verifying a decision | CR-01, and also CR-03, CR-05, CR-07, because an operation that never asks is bypassable on every path |
| BYPASS-02 | ignores revocation | CR-02 |
| BYPASS-03 | batch interface skips the PEP | CR-03 |
| BYPASS-04 | storage locator serves bytes | CR-04 |
| BYPASS-05 | honours stale decisions | CR-05 |
| BYPASS-06 | no tenant binding | CR-06 |
| BYPASS-07 | dependency failure fails open | CR-07 |
| BYPASS-08 | different adapter than credentialed | CR-08 |

## 7. Executable coverage matrix

| Challenge | Control | Procedure against the fixture | Expected |
| --- | --- | --- | --- |
| G01 | CR-01 | unauthorized principal with no decision, with a forged decision, and with another principal's decision | `denied` |
| G02 | CR-02 | authorized; revoke; retry with the same decision at `P_rev`(300 s)+1 | `revoked_within_interval` (denied) |
| G03 | CR-03 | unauthorized principal via the batch interface | `denied` |
| G04 | CR-04 | storage locator fetch | `denied` (403, no bytes) |
| G05 | CR-05 | carried decision reused at ceiling + 1 s | `denied` |
| G06 | CR-06 | organization-beta principal on organization-alpha document | `denied` |
| G07 | CR-07 | dependency unavailable, timeout, malformed | `fail_closed` (denied) |
| G08 | CR-08 / CR-12 | attested manifest digest vs credentialed digest (CR-12 checked deterministically from the SDK record) | `deployment_digest_match` |

G01–G07 run for **each** covered operation and G08 runs once, for 22 challenges per full matrix.

`referenceCoverage()` emits one record per (requirement, operation). Each record carries the challenge, the fixture variant, the expected outcome, each validator's observed outcome, the evidence ids, and the engine's category for **that operation alone** (the real engine run over only that operation's evidence). The coverage status is one of COVERED (ACCEPTED or FAILED), UNCOVERED, INCONCLUSIVE, STALE, ENGINE_DERIVED (CR-09, CR-12) or NOT_COVERED (CR-10, CR-11, and the exclusions `document.share`, `document.delete`, `document.edit-content`).

**Rules the tests enforce:**

- A challenge that never ran is UNCOVERED, never a pass.
- CR-11 never has an automated pass.
- Evidence for one operation never covers another (Scenario F).

## 8. Validation, evidence and privacy

- Validators deposit a closed evidence package holding request and response digests and a status code, never content. They sign `rn.conformance.observation/1` with enrolled keys and submit it through `submitObservation`. The engine recomputes `outcomeClass` (a lying "conformant" claim is stored as a violation with `validatorClaimMatches: false`).
- Corroboration is CC-D-03: two distinct operators within 30 minutes, and three to resolve disputes. **A + A2 (one operator) never corroborate.**
- The operators are synthetic labels under Republika control. This demonstrates the mechanism, **not organizational independence**.
- Denials and probe reports contain no sentinel bytes (asserted). Status assertions carry the RN-CONFORM-03 fields only.

## 9. Lifecycle and status (Scenarios A–F)

| Scenario | What happens |
| --- | --- |
| A | Full matrix → two humans → ACTIVE v2. Online status is CONFORMANT for every covered operation, and never CONFORMANT for an excluded one. |
| B | BYPASS-01 on export. Validator A's observation alone gives UNCONFIRMED_VIOLATION / UNDER_INVESTIGATION with no transition. Validator B (distinct operator) within 5 minutes gives VERIFIED_FAILURE and an **automatic** T4 → SUSPENDED v3 `CRITICAL_VIOLATION_CONFIRMED`, with no human. |
| C | A new online assertion is NOT_CONFORMANT / SUSPENDED / 3. The old nonce gives NONCE_MISMATCH. A pre-bypass stapled ACTIVE assertion is ROLLBACK_DETECTED for a stateful verifier but **still CONFORMANT for a stateless offline verifier until its ≤ 15 min validUntil**, then EXPIRED_ASSERTION. This is the documented bound; offline revocation is not instantaneous. |
| D | Defect removed. The reinstatement path is checked step by step: <br>• Without revalidation: NOT_ELIGIBLE. <br>• Full matrix re-run, but no remediation statement: REMEDIATION_REQUIRED. <br>• Remediation present, but the same person approving twice: APPROVAL_REFUSED. <br>• Carol + Bob: T5 → ACTIVE v4, online CONFORMANT / 4. <br>The verified history is T1, T2, T4, T5. |
| E | Re-running only the failed challenge gives NOT_ELIGIBLE. Fixing export while BYPASS-04 remains gives NOT_ELIGIBLE. |
| F | Open-only evidence leaves export and modify UNCOVERED, and the credential is not eligible. |

Also covered:

- BYPASS-08 drift observed by two operators suspends the credential.
- Stale evidence past 1 d + 6 h grace gives `EVIDENCE_STALE` suspension, followed by automatic reinstatement after fresh evidence.
- Single-operator evidence never issues a credential.
- One human cannot issue alone.

## 10. Security invariants

1. No protected byte is read or written before steps 1–8 succeed. Capabilities are module-private and single-use, and denials carry no result.
2. Unknown is never ALLOW: unknown revocation, a missing decision or any dependency failure all deny.
3. A decision is bound to actor, organization, document, operation and terms, and is never refreshed silently.
4. Every interface (primary, batch, storage) is challenged separately.
5. Classification comes only from the engine over signed, accepted validator evidence. No fixture flag such as `isCompliant` exists or counts.
6. Suspension needs ≥ 2 distinct operators and is atomic with the evaluation. Reinstatement after a confirmed violation needs remediation, full revalidation and two distinct humans.
7. A different deployment digest is a G08 violation. A new deployment is a new integration version and a new credential (RN-CONFORM-02).
8. The defects exist only in test fixtures.
9. The fixture is unreachable from Host, routes, package exports or configuration. No API is added and the API freeze is unchanged.

## 11. Frozen surfaces

Unchanged:

- `rn.sv@0.1.0` and its golden digest;
- the Founding Assessment NO-GO;
- Assurance behaviour;
- signer custody;
- XRPL code;
- Fileverse paths (`sovereign-status-history/`, the SRV package);
- Host routes and `release/api-surface.v1.json`;
- Supabase;
- both Protocol locks.

There is no $SOBE, token or reward code.

## 12. Tests and CI

| File | Covers |
| --- | --- |
| `conformance-reference-pep.test.ts` | WP-02/07/08/11 PEP behaviour; per-variant probe detection |
| `conformance-reference-coverage.test.ts` | profile pin, executable matrix, UNCOVERED rules, the per-variant detection matrix, evidence adversarial cases, single-operator corroboration |
| `conformance-reference-lifecycle.test.ts` | Scenarios A–E with signed status; lifecycle adversarial cases |
| `conformance-reference-demo.test.ts` | WP-13 report |
| `tests/conformance-reference-real-pipeline.e2e.test.mjs` | the PEP over the real FV pipeline |

The CI job `rn-conform-04-demo` uploads the report.

Changed protective test: `conformance-evidence.test.ts` asserted that `G03` is MALFORMED_REQUEST. G03 is now a real type, so the test asserts that an unknown type (`G09`) is MALFORMED_REQUEST **and** that G03 and G04 are refused for the RN-CONFORM-02 circuit profile with CHALLENGE_NOT_IN_PROFILE. The refusal is kept, with a more specific code.

Test counts and CI results are recorded in §15 from the actual runs.

## 13. Reproducing the demonstration

```
npm ci && npm run build
FRONTERA_RN_CONFORM_04_REPORT_OUT="$PWD/out/rn-conformance-reference-demo-report.json" \
  node --test dist/src/enterprise/__tests__/conformance-reference-demo.test.js
```

This writes `rn.conformance.reference-demo-report/1` plus `.summary.md`. Every section is marked `measured` (engine, lifecycle or status output) or not (fixture behaviour). In CI, the `rn-conform-04-demo` job uploads both files and a sha256.

## 14. Commercial limitations and open production decisions

**What can honestly be shown to Fileverse:**

- the mechanism (executable challenges, corroboration, automatic suspension, signed status, controlled reinstatement);
- that the PEP enforces the shipped FV-P2/P3/P4C decisions.

**What cannot be claimed:**

- that any Fileverse deployment was tested;
- that Fileverse is conformant or certified;
- that validators are independent;
- that the revocation-propagation and freshness parameters are production guarantees (they are provisional profile values).

**Still open:**

- CC-D-10, CC-D-11 and CC-D-12;
- CC-D-02, an independent operator, which is required before any non-synthetic ACTIVE;
- CR-11 human review;
- CR-10 as a separate result;
- FV-P5, real enforcement;
- an authorized test environment and its endpoints.

**Future integration prerequisites:**

- written CC-D-12 authorization;
- a named FV-P5 owner;
- a real SDK identity (CC-D-10);
- an authoritative lock (CC-D-11);
- validators of a contracted independent operator;
- an endpoint authorization;
- a profile version adopted under CC-D-09.

## 15. CI evidence and independent review

Filled from the actual CI runs and the review of the PR head.
