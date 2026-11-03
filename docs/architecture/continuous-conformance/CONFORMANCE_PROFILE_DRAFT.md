# Conformance Profile Draft — `rn.conformance.integration@0.1.0` (PROVISIONAL)

> Working identifier only. **Not registered, not frozen, not published.** It is not an Assurance
> framework and must never be loaded into `createAssuranceFrameworkRegistry`. `rn.sv@0.1.0` is unchanged.

## 1. Why a separate profile

`rn.sv@0.1.0` is a point-in-time, human-reviewed **organizational** assessment: ten `manual_review`
controls, no automated criteria, no eligibility profiles, restricted commercial use. A validator cannot
execute it. This profile instead states **machine-checkable properties of one integration version**.
Each rn.sv control was considered as conceptual input:

| rn.sv control | Used here? | How |
|---|---|---|
| SV-01 Actor identity and authority | Yes | CR-01, CR-06 |
| SV-02 Consent and revocation | Yes | CR-02 |
| SV-03 Policy compliance | Partly | CR-08 (policy/adapter digest pinning) |
| SV-04 Evidence integrity | Yes | CR-09 (evidence freshness), signed observations |
| SV-05 Execution traceability | No (human review) | Remains an Assurance concern |
| SV-06 Isolation between organizations | Yes | CR-06 |
| SV-07 Minimal disclosure | Partly | CR-11 (human review) |
| SV-08 Effective revocation of authority | Yes | CR-02, CR-05 |
| SV-09 Remediation and revalidation | Yes | Reinstatement rules (§6) |
| SV-10 Governance and accountability | No (human review) | Assurance / contract |

## 2. Scope

* **Subject:** exactly one `IntegrationVersion` (platform, integration id, version, `integrationDigest`).
* **Covered operations:** those declared in the integration record. For the Fileverse reference:
  `document.open`, `document.export`, `document.modify-protected-terms` (the only actions with code —
  see [FILEVERSE_COVERAGE.md](FILEVERSE_COVERAGE.md)).
* **Declared exclusions** are published in every status assertion. An excluded operation is *not
  covered*, never *passed*.
* **Required SDK capabilities:** fail-closed authorization decision before each covered operation;
  revocation check whose `unknown` blocks (P: `resolveMaterialActionDecision` semantics); policy
  evaluation bound to a signed terms claim (`claimId`, `claimDigest`); status freshness gate.

## 3. Requirements

Type: **M** machine-checkable by validators · **D** deterministic check by the engine (no validator) ·
**H** requires human review. Severity **C** critical (suspension) · **S** significant (finding, suspension
only if unremediated) · **I** informational.

| Id | Requirement | Type | Sev | Challenge | Freshness |
|---|---|---|---|---|---|
| CR-01 | A covered operation without a valid authorization decision is refused. | M | C | G01 | 24 h |
| CR-02 | After effective revocation, the operation is refused within the propagation interval `P_rev` (proposed ≤ 300 s; ≤ the FV export ceiling of 900 s). | M | C | G02 | 24 h |
| CR-03 | Every in-scope interface enforces the same decision (no alternative path). | M | C | G03 | 7 d |
| CR-04 | Protected assets are not retrievable through storage routes that bypass enforcement. | M | C | G04 | 7 d |
| CR-05 | Authorization decisions are not reused beyond freshness ceilings (per-action; FV precedent: access 86 400 s, export/modify 900 s). | M | C | G05 | 24 h |
| CR-06 | A principal of organization A cannot act on resources scoped to organization B. | M | C | G06 | 24 h |
| CR-07 | When the authorization dependency fails, the operation fails closed. | M | C | G07 | 7 d |
| CR-08 | The observed deployment/adapter/policy digest equals the credentialed `integrationDigest` components. | M + D | C | G08 | 24 h |
| CR-09 | Required evidence for every critical requirement is fresher than its window. | D | C | G09 | continuous |
| CR-10 | Independent observations for a control do not conflict. | D | S | G10 | per window |
| CR-11 | Data minimization of evidence packages and denial responses (no protected content leaked in errors). | H | S | — | 90 d |
| CR-12 | SDK version is within the profile's supported range and not downgraded. | D | C | G08 | 24 h |

## 4. Evidence requirements

* Pass for a **critical** requirement requires ≥ `k` conformant observations from validators of ≥ `k`
  distinct operators within one corroboration window (proposed `k = 2`, window 30 min; [CC-D-03](DECISION_REGISTER.md#cc-d-03)).
* Violation is **confirmed** when ≥ `k` distinct-operator validators observe the violation for the same
  `integrationDigest` within the window, **or** when CR-08/CR-12 detect a digest/version mismatch that
  the engine verifies deterministically from signed observations of the same digest by any 2 validators.
* SDK-emitted events may be attached as supporting evidence; they never satisfy a requirement alone.

## 5. Suspension rules

| Rule | Condition | Effect |
|---|---|---|
| SR-1 | Confirmed critical violation (CR-01…CR-08, CR-12) | `ACTIVE → SUSPENDED` immediately, reason `CRITICAL_VIOLATION_CONFIRMED` |
| SR-2 | CR-09 freshness lapses for any critical requirement beyond grace `g` (proposed 6 h) | `ACTIVE → SUSPENDED`, reason `EVIDENCE_STALE` |
| SR-3 | Single uncorroborated violation report | Stay `ACTIVE`; open **investigation**: expedited re-challenge to ≥ `k` other operators within `T_confirm` (proposed 30 min); assertion carries `reasonCode: 'UNDER_INVESTIGATION'` |
| SR-4 | Investigation cannot complete within `T_confirm` because validators are unavailable | `ACTIVE → SUSPENDED`, reason `CORROBORATION_UNAVAILABLE` (fail closed) |
| SR-5 | Profile version retired | `ACTIVE → SUSPENDED`, reason `PROFILE_RETIRED` after published deadline |

## 6. Reinstatement rules

* From `EVIDENCE_STALE`, `CORROBORATION_UNAVAILABLE`, `PROFILE_RETIRED`: automatic once all critical
  requirements have fresh corroborated passes.
* From `CRITICAL_VIOLATION_CONFIRMED`: platform remediation statement + full revalidation of **all**
  critical requirements (not only the failed one) + two-person human approval. Same `credentialId`,
  new `stateVersion`.
* If remediation changes the deployment digest, the old credential stays SUSPENDED and a **new**
  credential is issued for the new `IntegrationVersion` (see [CREDENTIAL_LIFECYCLE.md](CREDENTIAL_LIFECYCLE.md)).

## 7. Versioning

`0.x` profiles may change only by creating a new version. A credential is bound to exactly one profile
version. Profile definitions should be content-addressed (digest) and pinned by the engine, mirroring the
rn.sv golden-digest discipline. The profile's canonical home is an open decision ([CC-D-09](DECISION_REGISTER.md#cc-d-09));
the recommended home is Soberania_Protocol `docs/protocol/profiles/`, next to `DOCUMENT_USE_PROFILE.md`
and `SOVEREIGN_STATUS_PROFILE.md`, with engine-side pinning in Frontera.
