# Republika Sovereignty Founding Assessment — Proposed Service Specification

> **STATUS: DRAFT FOR FOUNDER REVIEW ONLY.** Not an offer, not a price, not a
> contract. It claims no accreditation, approval or customer reference. It
> describes what the current product can support. Wherever this document says
> "will" or "must", read it as *proposed*. Independence and review wording
> corrected by ASSURE-CLAIMS-01 (GF-01, GF-06); subject to qualified legal
> review.

## 1. Purpose and value proposition

**Purpose.** Give an organization a structured, evidence-based assessment of
its **digital-sovereignty posture**, conducted by Republika reviewers, over a
scope it declares. Digital sovereignty here means: who may act, under what consent and
policy; whether records can be trusted and traced; whether organizations stay
isolated and disclosure stays minimal; whether authority can be revoked; and
whether problems are corrected and confirmed. The view is given against the
ten controls of `rn.sv@0.1.0`.

**Value to the customer (proposed claims, each supportable by the product):**

- A structured, repeatable assessment against a **frozen, digest-identified
  framework**. The customer can be told exactly which framework version
  produced the result.
- **Evidence-bound conclusions.** No control is concluded PASS, PARTIAL or
  FAIL without accepted evidence bound to that control (ASSURE-SEC-01A).
- **Honest gaps.** Missing evidence is reported as UNKNOWN (an evidence gap),
  never as a pass and never as a failure.
- **Separation of duties.** A separate authorized Republika approver, who did
  not review any control of that assessment, approves the release. The
  service enforces this per credential; process enforces it per person. This
  is internal approval, not an external or independent review.
- A **verifiable deliverable package.** The customer can check its integrity
  offline and confirm it with the issuer's custody.
- A **remediation roadmap** derived only from findings, with owners and dates
  left to be agreed, never invented.

**Who performs it.** See §1a.

**What it is not.** See §15 and draft G.

## 1a. Roles, independence and what a result means

- **Framework.** Republika authored `rn.sv@0.1.0`. It has not been reviewed
  or approved by any accreditation body or external party.
- **Tooling.** Republika operates the assessment tooling (the Enterprise Host
  and its Assurance service).
- **People.** Republika personnel or authorized contractors perform the
  control reviews, and a separate one approves the release.
- **Independence.** The assessment is independent of the customer's
  organization. It is not independent of the framework author or of the
  tooling operator, both of which are Republika.
- **External review.** No external auditor or independent reviewer has
  reviewed any assessment. One would exist only where a qualified external
  reviewer performs an actual review under a documented engagement, and the
  report would then name that reviewer and scope. Internal release approval
  is never presented as an external review.
- **Commercial authorization.** Whether `rn.sv@0.1.0` may be used
  commercially is a separate governance decision (`governance/`). It does not
  follow from internal review, internal approval or any external review. It
  is currently **restricted**.
- **What PASS means.** A reviewer's conclusion, from accepted customer
  evidence bound to that control, that the control's condition held for the
  sample. It does **not** guarantee that the supplied evidence is authentic,
  complete or representative of the whole system.
- **Boundaries.** Every conclusion is constrained by the declared scope, the
  evidence cut-off and the ten-control set (§4, §5). Nothing outside them is
  assessed.
- **No accreditation or certification** is implied (§15).

## 2. Target customer profile (founding cohort)

Proposed eligibility, to be confirmed by the founder:

- An organization that operates, or is about to operate, automated or
  agent-mediated actions over sensitive assets, and wants an outside view of
  its authority, consent, traceability and isolation controls.
- It can name an **accountable executive sponsor** and a **technical contact**.
- It can supply documentary evidence (policies, configurations, logs, samples)
  that it is **lawfully entitled to share** (draft E).
- It accepts a **point-in-time, sample-based, non-certification** result and a
  founding-cohort engagement whose terms are still being shaped.
- It is a pilot partner willing to give structured feedback.

## 3. Eligible and excluded use cases

| Eligible (proposed) | Excluded |
| --- | --- |
| Baseline posture assessment of a declared system or business process | Certification, attestation or audit opinion of any kind (§15) |
| Internal governance input: a board, risk committee or CISO briefing | Representing the result as regulatory compliance |
| Prioritizing remediation | Pre-transaction due diligence where the counterparty would rely on the report as a warranty |
| Readiness discussion before a formal audit performed by others | Active testing: penetration tests, scanning or any access to customer systems |
| Reassessment of the same scope after remediation | Continuous monitoring and assurance signals (not in the Founding Assessment; ASSURE-SEC-01E residual) |
| | Assessment of a third party's systems the customer is not authorized to assess |
| | Evidence that contains secrets, credentials, special-category personal data or regulated health or payment data (draft C) |
| | Any engagement requiring the Host to be reachable from the public internet |

## 4. Assessment boundaries

- **Scope** is what the customer declares: subject, systems, processes, period
  and exclusions. Declared text is untrusted. The report's disclosure model
  withholds risky text (`AOC_ASSURANCE_COMMERCIAL_REPORT.md` §4).
- **Point in time.** The result describes the evidence as of its collection.
- **Sample-based.** Conclusions cover the sampled actions and artifacts only.
- **No active testing.** `rn.sv@0.1.0` has `automation: 'none'`. Nothing
  connects to customer systems.
- **Customer-supplied evidence.** It is not authenticated by the Host. It is
  identified by digest and judged by a human (blocker B1).
- **One organization per Host.** The Host serves exactly one organization
  (REL-01D §2). A Founding Assessment is proposed to run on a **dedicated
  Host and store per customer** (`CUSTOMER_DATA_GOVERNANCE.md` §9).

## 5. The ten controls

`rn.sv@0.1.0` organizes **ten controls** into **five weighted domains**. The
mission brief's "ten control domains" are, in the framework, ten controls; the
framework's own domains are listed so that the deliverable and the brief stay
consistent.

| Control | Title | Framework domain (weight) | Blocking |
| --- | --- | --- | --- |
| SV-01 | Actor identity and authority | Authority & Consent (0.3) | |
| SV-02 | Consent and revocation | Authority & Consent | |
| SV-08 | Effective revocation of authority | Authority & Consent | **Yes**: FAIL marks the domain unhealthy |
| SV-03 | Policy compliance | Policy & Governance (0.2) | |
| SV-10 | Governance and accountability | Policy & Governance | |
| SV-04 | Evidence integrity | Evidence & Traceability (0.2) | |
| SV-05 | Execution traceability | Evidence & Traceability | |
| SV-06 | Isolation between organizations | Data Boundaries (0.2) | **Yes** |
| SV-07 | Minimal disclosure | Data Boundaries | |
| SV-09 | Remediation and revalidation | Remediation (0.1) | |

Each control's objective, questions, evidence requirement, risk, conditions
for each outcome, limitations and revalidation criteria are in the frozen
definition (`rn-sv-framework.ts`, `metadata.controlProfiles`). This document
does not restate them, so that it cannot drift from the frozen definition.

## 6. Evidence collection model

- One evidence requirement per control (`rn.sv.req.sv-01` … `sv-10`), with
  minimum one item. Accepted types: `external_artifact_reference` and
  `control_attestation`. Each must be organization-bound. Contradictions
  escalate to a human.
- The Host stores **references and metadata**, not the artifacts: identifier,
  type, organization, external identifier, digest, dates, supplier claims,
  provenance and the control binding (`requirementIds`). The artifacts
  themselves are held outside the Host. Where, and for how long, is an
  **open governance item** (`CUSTOMER_DATA_GOVERNANCE.md` §8).
- Evidence is submitted by an operator with `assure.reviewer` through
  `POST /api/assurance/assessments/{id}/evidence` (at most 500 references
  per submission, closed field set, 1 MiB body).
- Every reference must name the control(s) it supports. Unbound evidence is
  rejected (SEC-01C).

## 7. Customer and reviewer responsibilities (summary)

| Customer | Republika (proposed) |
| --- | --- |
| Declares scope and exclusions accurately | Confirms the scope is assessable and within the eligible use cases |
| Confirms in writing its authority to provide each evidence item (draft E) | Accepts only evidence within the guidelines (draft C) |
| Supplies evidence, minimized and redacted | Records evidence references; never stores secrets |
| Names one authoritative artifact when copies conflict | Ends a contradicted attempt and starts a linked new one (REL-01B) |
| Reviews the draft for factual errors in the declared scope only | Reviewer concludes each control; a separate approver releases |
| Verifies the delivered package (draft H) | Answers verification requests from custody |

Detail: draft E (customer) and `OPERATOR_ROLES.md` (Republika).

## 8. Methodology

1. **Scoping.** Agree scope, exclusions, period and sample. Record them in the
   SOW (draft B). Confirm eligibility.
2. **Authorization.** Obtain signed authorization to assess and the evidence
   attestation (draft E). No evidence is accepted before this.
3. **Create** the assessment against `rn.sv@0.1.0` on the customer's
   dedicated Host.
4. **Collect** customer-supplied evidence, each item bound to its control(s).
5. **Review.** For each control, an authenticated reviewer answers the
   control's questions against the accepted, bound evidence, and records
   `pass`, `partial`, `fail` or `insufficient_evidence` with a rationale.
   The rationale is internal and never disclosed in the report.
6. **Contradictions.** A contradicted control is never concluded within the
   attempt. The attempt is ended and a linked new attempt started with an
   authoritative artifact (REL-01B §15).
7. **Evaluate and complete.** Scoring under `rn.sv.scoring@0.1.0`. Completion
   is refused while any review is pending.
8. **Draft** the commercial report. Confirm `READY_FOR_RELEASE`. Read it in
   full against the SOW.
9. **Separate release approval** by a different authorized Republika person
   holding `assure.report-release`, whose credential recorded no review of
   the assessment, into durable custody. Internal approval, not external
   review.
10. **Deliver** the package unchanged, as an archive, with verification
    instructions. The customer verifies it.
11. **Closeout** and deletion (draft I).

## 9. Meaning of the results

| Result | Meaning | Score |
| --- | --- | --- |
| **PASS** | The reviewer concluded, from accepted evidence bound to the control, that the control's satisfied condition holds for the sample | 1 |
| **PARTIAL** | Satisfied in part. The gap is described by the control's risk statement | 0.5 |
| **FAIL** | The reviewer observed the control not satisfied in the sample | 0 |
| **UNKNOWN** | The reviewer could not reach a defensible conclusion from the evidence available (`insufficient_evidence`). An **evidence gap, not a failure**. First recommended action: provide evidence | 0 (stays in the denominator) |

`not_applicable` is excluded from scoring. A FAIL on SV-06 or SV-08 marks its
domain **unhealthy** whatever the numeric score.

## 10. Scoring limitations

- The 0–100 score is bound to the framework, the scope and the methodology
  version. **A high score is not demonstrated sovereignty.**
- UNKNOWN scores zero. A low score can mean missing evidence, not poor
  controls. The report shows UNKNOWN apart from FAIL.
- Domain weights are a framework design choice (0.3 / 0.2 / 0.2 / 0.2 / 0.1)
  and have not been externally validated.
- Scores from different framework versions, or from different scopes, must
  not be compared as if they were the same measurement.
- The score is not a benchmark against other organizations. No benchmark
  data exists.

## 11. Remediation recommendation format

As generated by the report (ASSURE-REP-01): per FAIL or PARTIAL finding, the
control, the risk statement, the framework's remediation guidance, and the
revalidation criterion. **Owner** and **target date** are always `To be agreed
with customer`. For UNKNOWN: "provide evidence", with the control's evidence
requirement. Nothing is invented. Republika does not implement remediation in
the Founding Assessment.

## 12. Deliverables and acceptance criteria

Delivered as one archive, unchanged:

| File | Content |
| --- | --- |
| `report.md` | Human-readable report |
| `report.json` | Canonical content |
| `integrity-manifest.json` | Digests binding the assessment, framework, generator, content and Markdown |
| `release-record.json` | The separate internal release approval: approver, role, acknowledgements, date, digests |
| `limitations.md` | The limitations extract |
| `verification-instructions.md` | How to verify; what *ready*, *released* and *authentic* mean |

Acceptance criteria: draft F.

## 13. Duration assumptions (to validate)

These are **unvalidated planning assumptions**, not commitments. The only
executions so far are synthetic (PILOT-01, REL-01D Stage 5).

| Phase | Assumption | How to validate |
| --- | --- | --- |
| Scoping and authorization | 1–2 weeks elapsed, customer-dependent | First founding engagement |
| Evidence collection | 1–3 weeks elapsed | First founding engagement |
| Review, 10 controls | 3–6 reviewer-days | Time-box and record actuals |
| Contradiction handling, per contradicted control | +1–5 days elapsed | Record actuals |
| Drafting, separate release approval, release | 1–2 approver-days | Record actuals |
| Closeout and deletion | ≤ 1 day effort, after the retention period | Record actuals |

## 14. Rescoring and reassessment policy (proposed)

- A **released report is never edited.** A correction to the declared scope
  is a new `reportVersion`; the earlier version stays in custody.
- A **different conclusion requires a new assessment** (reassessment), never
  an edited one.
- **Reassessment after remediation:** a new attempt against the same
  framework version and scope, with fresh evidence per the control's
  revalidation criterion. It is reported as a new report. Commercial terms
  are decision D-07.
- **Framework version change:** if `rn.sv@0.2.0` is introduced, an existing
  customer is reassessed against it only by a new engagement. Scores are not
  restated across versions.
- **Disputes:** the customer may identify factual errors in the declared scope
  before release. It may not negotiate control conclusions. A disputed
  conclusion after release is handled by a reassessment with new evidence.

## 15. Commercial disclaimers (proposed; subject to legal review)

The Founding Assessment:

- is **not an accredited certification**. No accreditation or certification
  body has approved the framework, the methodology or Republika as an
  assessor;
- is **not a financial audit** and expresses no opinion on financial
  statements or internal control over financial reporting;
- is **not a guarantee against cyberattacks** or any other incident. It
  performs no active testing;
- is **not legal advice, and not a legal or regulatory compliance
  certification** under any law or standard;
- is **not a blanket assurance of the safety of autonomous agents** or of any
  system's future behaviour;
- is **not an independent or external review**: Republika authors the
  framework, operates the tooling, and performs and approves the assessment;
- relies on evidence supplied by the customer, which Republika does not
  authenticate. A PASS is not a guarantee that the evidence is authentic,
  complete or representative;
- is **not digitally signed**: the package's digests show integrity only,
  and its origin is corroborated only by confirming with Republika over a
  separate, trusted channel;
- is point-in-time and sample-based, and bound to the declared scope, the
  framework version and the methodology version.

Full notice: draft G.
