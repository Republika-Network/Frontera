# RN-CONFORM-06 — GO / NO-GO by Level

**Recommendations only. The founder decides; this document grants nothing.** Machine-readable form:
[`rn-conform-06-readiness-scorecard.json`](rn-conform-06-readiness-scorecard.json).

## Matrix

| Level | Recommended verdict | Decisive reason |
|---|---|---|
| 0 Internal synthetic demonstration | **GO** | Complete, CI-reproducible, no external party |
| 1 External presentation of a synthetic demonstration | **CONDITIONAL** | Allowed once P0-01 and P0-02 land and the disclosures below are used |
| 2 Controlled design-partner pilot (written authorization) | **NO-GO today** · CONDITIONAL path | Needs P1-01..P1-12 and the L2 decisions listed below |
| 3 Public, independently operated validator network | **NO-GO** | No independent operator, transport, custody, public status or anchoring |
| 4 Commercial continuous-conformance / certification service | **NO-GO** | All of L3 plus CC-D-15, SLOs, audit, liability; "certification" naming prohibited |

## Level 0 — Internal synthetic demonstration — **GO**

- **Evidence:** RN-CONFORM-02..05 merged with green CI; demo jobs `rn-conform-04-demo`, `rn-conform-05-demo`;
  historical migration regression `rn-conform-05-v2-migration`.
- **Missing controls:** none for this level.
- **Required approvals:** none beyond existing practice.

## Level 1 — External presentation of a synthetic demonstration — **CONDITIONAL**

- **Evidence:** as L0; RN_CONFORM_04_IMPLEMENTATION.md §14 defines what may be shown.
- **Missing controls:** stale README / XRPL_ANCHORING.md (G-23, G-27); "certification" naming collision (G-26); no
  approved disclosure pack.
- **Security dependencies:** none (no external system is touched).
- **Required approvals:** founder approval of the disclosure pack; legal review of claims (CC-D-15 naming).
- **Mandatory disclosures on every slide/report:** synthetic fixtures; synthetic Republika-controlled operators, not
  independent; no real platform tested; not a certification; no credential is real; timing values are defaults,
  not SLOs; no XRPL transaction exists; **reviews so far are AI reviews only — no human or external security review**;
  **Fileverse has not participated in, authorized or endorsed** anything shown (the PEP is Fileverse-*inspired*).
- **Condition to become GO:** P0-01 and P0-02 merged.

## Level 2 — Controlled design-partner pilot — **NO-GO today; CONDITIONAL path**

- **Evidence:** mechanism complete; reusable custody/transport/backup patterns exist in the repository.
- **Missing controls:** coordinator-level authorization enforcement (G-01), requalification reservation (G-02),
  PILOT designation and staging endpoints (G-16), external custody (G-03/G-04), AUTH-03 humans (G-05), private
  authenticated transport (G-07/G-08), backup/DR/alerting (G-10..G-13), partner executor and enforcement point
  (G-15/G-16), pilot evidence report, egress/SSRF isolation (G-30), hosting baseline (G-31), findings and data
  handling (G-32), stop and rate controls (G-33), pilot profile (G-35), report-misuse controls (G-36), supply chain and
  key ceremony (G-37). Every pilot artefact must disclose staging ≠ production (G-34, THREAT_MODEL T07).
- **Security dependencies:** external human review of the complete pilot composition (P1-09) with no open
  critical/high finding in scope.
- **Required approvals:** CC-D-01 and CC-D-04 (confirmed for PILOT), CC-D-07, CC-D-09, CC-D-10, CC-D-11 (if the
  partner integration pins AOC Protocol packages), CC-D-12 (written authorization, generalized to the chosen partner —
  F-06-9), CC-D-13 (report confidentiality), CC-D-15 pilot terms (no fee), F-06-1 (no credential), F-06-2 (PILOT
  designation), F-06-3 (partner choice), F-06-4 (no anchoring), F-06-5 (external review), F-06-10 (KMS vendor), and
  authorization of each roadmap mission.
- **Condition to become GO:** all P1 items accepted; pilot agreement signed; founder GO recorded for that partner,
  integration version and time window.

## Level 3 — Public, independently operated validator network — **NO-GO**

- **Missing:** contracted independent operators and CC-D-02 decisions; onboarding programme; cross-organization
  transport; HSM custody; public status with abuse controls (CC-D-13); collusion controls (G-28); measured SLOs.
- **Required approvals:** CC-D-02, CC-D-03 (confirmed for production), CC-D-05, CC-D-13 (public status), and an
  external audit.

## Level 4 — Commercial continuous-conformance / certification service — **NO-GO**

- **Missing:** all of L3; CC-D-15 commercial terms, liability, insurance, appeal SLA; accredited audit; independent
  deployment attestation (G-18); unpredictable test environments (G-17).
- **Hard rule:** the service must never be named or marketed as "certification" (CC-D-15); conformance never depends
  on `rn.sv` commercial authorization (CC-D-08). The Founding Assessment NO-GO is unchanged and is a separate track.
