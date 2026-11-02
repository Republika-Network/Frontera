# Fileverse Reference Scenario — Evidence-Based Coverage

> Synthetic only. No code in any audited repository contacts Fileverse, and this dossier authorizes no
> Fileverse testing. Structure tests assert the absence of network / Fileverse imports
> (`src/enterprise/__tests__/fv-p4c2b3c1-dedicated-executor-structure.test.ts`,
> `tests/fv-p4c2b3b-protected-host-composition.e2e.test.mjs`).

## 1. Actual scope (Frontera `64b3ec7c`, Protocol `590e4cb`)

| Question | Answer from code |
|---|---|
| Where documents originate | Fileverse, represented only by an opaque `externalReference = {namespace:'fileverse', id:'gnosis:<portalAddress>/<fileId>'}`; never dereferenced. Format enforced only by the Protocol fixture builder (`examples/fileverse-portable-asset/generate.ts`). |
| Content binding | `contentIdentity` = SHA-256 of exact exported bytes (not the IPFS CID). |
| Where sovereignty metadata attaches | `SovereigntyPortabilityBundleV1` → one `SovereignManifestV1` + one signed `LicenseTermsClaim` (rules, audience, `effectiveAt`/`expiresAt`); separate signed `soberania.sovereign-status/1`. Profile `soberania.document-use/1` (PROPOSED). |
| Operations mediated | Decision functions only, in `packages/sovereign-receiver-verification`: `aoc.licensing:access`, `soberania.document:export`, `soberania.document:modify-protected-terms` (`DOCUMENT_USE_ACTIONS`). |
| Enforcement | **NOT IMPLEMENTED.** No PEP, route or caller in `src/` consumes the decision functions; results report `authorization:'not_evaluated'`, `execution:'not_performed'`. Fileverse enforcement is FV-P5 (not started). |
| Evidence produced | In-memory, unsigned decision objects: `DocumentUseEligibilityResult`, `DocumentUsePolicyDecision`, `DocumentUseFreshnessResult`. Signed evidence is only a handoff design (`docs/integration/FV_DOCUMENT_POLICY_DECISION_HANDOFF.md`). |
| What revocation means | The registrant signs a newer status with `currentTerms: null` (→ `REVOKED` verdict) or `assetStatus: 'withdrawn'` (→ `WITHDRAWN`, terminal). No code issues statuses; no grant-level revoke operation. |
| Deployment / version identifiers | Profiles `soberania.document-use/1`, `soberania.sovereign-status/1`; receiver ids `aoc-enterprise.document-use-*/1`; Protocol pin rc.3 in `protocol-consumer.lock.json`. **No FV release digest, adapter version or `rn.fv*` id exists.** |
| Fixtures | Protocol `examples/fileverse-portable-asset/generate.ts` (synthetic portal `0x…0f1e01`, fresh keys per run); Frontera `packages/sovereign-receiver-verification/__tests__/{document,status}-fixtures.ts`, `tests/fixtures/fv-p4c2a-sqlite-status-history/chain.json`. |
| Interfaces in scope | None exposed (no HTTP route, CLI or startup composes FV; `dedicated-executor-main.ts` composes nothing). |
| Stated exclusions | "internal and non-operational", "Operational activation: NO-GO" (`docs/integration/FV_AUTH03_IDENTITY_OWNERSHIP.md`), no production bootstrap (`FV_TRUSTED_BOOTSTRAP_RECOVERY.md`); FV-P4D (whole-file rollback) and FV-P5 open. |

## 2. Coverage matrix

| Operation | Enforcement location | Required check (existing) | Validator challenge | Evidence | Credential consequence |
|---|---|---|---|---|---|
| Open / read | **NOT IMPLEMENTED** (decision: `evaluateDocumentUsePolicy` for `aoc.licensing:access` + `checkDocumentUseFreshness`, ceiling 86 400 s) | Eligibility → policy → status freshness | G01, G05, G06, G07 | Signed observation | CR-01/05/06/07 → SR-1 |
| Share | **NOT IMPLEMENTED** (no concept, no code) | — | none possible | — | Must be a declared exclusion |
| Revoke | **NOT IMPLEMENTED as an operation**; revocation via registrant-signed status, verified by `verifySovereignStatus` + high-water mark | Status freshness; `REVOKED`/`WITHDRAWN` verdicts | G02 (status flip on fixture, then retry) | Pre/post observations | CR-02 → SR-1 |
| Export | **NOT IMPLEMENTED** (decision for `soberania.document:export`, ceiling 900 s) | Same pipeline | G01, G04, G05 | Signed observation | CR-01/04/05 → SR-1 |
| Metadata change (modify protected terms) | **NOT IMPLEMENTED** (decision for `soberania.document:modify-protected-terms`; with the owner-approval obligation the result is always `WITHHELD`) | Same pipeline; always withheld | G01 (expect `denied`) | Signed observation | CR-01 → SR-1 |
| Delete / edit content / download | **NOT IMPLEMENTED** | — | — | — | Declared exclusion |
| Direct storage (IPFS / Fileverse storage) | **NOT IMPLEMENTED** | — | G04 once an enforcement point exists | — | CR-04 |

## 3. Implication

A Fileverse integration **cannot be credentialed today**, even synthetically, because there is no
enforcement point to challenge. RN-CONFORM-04 must therefore build a **synthetic reference PEP** in
Frontera that wraps the existing decision pipeline for open/export/modify, plus a deliberately bypassable
variant, before any Fileverse-facing work. Real Fileverse enforcement remains FV-P5 and requires
authorization ([CC-D-12](DECISION_REGISTER.md#cc-d-12)).
