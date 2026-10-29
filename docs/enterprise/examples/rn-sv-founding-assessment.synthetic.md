# Republika Sovereignty Assessment — Founding Assessment

> **READY FOR RELEASE.** Every release check passed. Readiness is not release: this document does not state whether it was released. A release is established only by an accompanying release record whose digests match this report’s manifest, confirmed by the issuer’s release custody. Without one, this report is not released.

| Field | Value |
| --- | --- |
| Service | Republika Sovereignty Assessment |
| Assessment | assurance\-assessment\-1 |
| Organization | Meridian Commons Cooperative \(fictional\) |
| System or process | Harborline Member Services Platform \(fictional\) |
| Framework | Republika Sovereignty Assessment \(rn\.sv@0\.1\.0\) |
| Evidence cutoff | 2026\-05\-31T00:00:00\.000Z |
| Issued on | 2026\-06\-01 |
| Classification | CONFIDENTIAL |
| Report version | 1\.0 |
| Report identifier | rn\-sv\-report:assurance\-assessment\-1:v1\.0 |

_This report is not a certification, legal opinion or guarantee. Its conclusions are limited to the declared scope and the evidence cutoff._

## Release readiness

Status: **READY\_FOR\_RELEASE**

| Check | Result | Detail |
| --- | --- | --- |
| scope\_declared | passed | Organization, system, purpose, in\-scope items, exclusions, dependencies and access limitations are declared and cleared for disclosure\. |
| assessment\_completed | passed | The assessment is completed and current\. |
| framework\_exact | passed | rn\.sv@0\.1\.0, definition digest matches\. |
| assessment\_verified | passed | Assessment integrity and structure verify\. |
| finding\_histories\_consistent | passed | Every finding has a complete, intact event history\. |
| control\_coverage | passed | All ten rn\.sv@0\.1\.0 controls were evaluated\. |
| human\_review\_authenticated | passed | Every control was concluded by an authenticated reviewer\. |
| rejected\_evidence\_not\_presented\_as\_verified | passed | No rejected or supplier\-provided reference is presented as Host\-verified\. |
| disclosure\_policy | passed | Only allowlisted fields are disclosed; all declared text was cleared\. |

## 1. Executive summary

Harborline Member Services Platform \(fictional\), operated by Meridian Commons Cooperative \(fictional\), assessed against the ten controls of Republika Sovereignty Assessment \(rn\.sv@0\.1\.0\) with evidence up to 2026\-05\-31T00:00:00\.000Z\.

**Purpose.** Founding assessment of the platform’s digital\-sovereignty posture before onboarding new member organizations\.

**Demonstrated (PASS)**

- SV\-01 Actor identity and authority
- SV\-02 Consent and revocation
- SV\-04 Evidence integrity
- SV\-05 Execution traceability
- SV\-08 Effective revocation of authority

**Partially demonstrated (PARTIAL)**

- SV\-03 Policy compliance
- SV\-10 Governance and accountability

**Observed not satisfied (FAIL)**

- SV\-06 Isolation between organizations

**Not determined — insufficient evidence (UNKNOWN; not a failure)**

- SV\-07 Minimal disclosure
- SV\-09 Remediation and revalidation

**Principal risks**

- SV\-03: Decisions taken outside the declared policy\.
- SV\-06: One organization reading or altering another organization’s data\.
- SV\-10: No one accountable for sovereignty decisions\.

**Priority findings**

- F\-01 \(critical\) — SV\-06 Isolation between organizations

**Recommended next actions**

- F\-01: corrective action for SV\-06 \(Immediate priority\)\.
- F\-02: corrective action for SV\-03 \(Normal priority\)\.
- F\-03: provide evidence for SV\-07 \(Low priority\)\.
- F\-04: provide evidence for SV\-09 \(Low priority\)\.
- F\-05: corrective action for SV\-10 \(Low priority\)\.

## 2. Scope and boundaries

| Field | Value |
| --- | --- |
| Organization | Meridian Commons Cooperative \(fictional\) |
| System or process | Harborline Member Services Platform \(fictional\) |
| Description | A synthetic multi\-tenant platform through which member organizations manage consent, service requests and payouts\. Invented for this example\. |
| Subject type | system |
| Period from | Not specified \(evidence up to the cutoff was considered\) |
| Period to | 2026\-05\-31T00:00:00\.000Z |
| Evidence cutoff | 2026\-05\-31T00:00:00\.000Z |

**In scope**

- Member consent and revocation service
- Request decision and execution pipeline
- Tenant data partitioning
- Partner export interface

**Exclusions**

- Payment processor internals \(third party\)
- Corporate IT and end\-user devices
- Disaster recovery site

**Dependencies**

- Managed identity provider operated by a third party

**Access limitations**

- Evidence was provided by the cooperative; no direct access to production systems was granted\.

**Evidence sources**

- external\_artifact\_reference \(10 reference\(s\)\)

**Activities not performed**

- Active or penetration testing of the assessed systems \(rn\.sv@0\.1\.0 performs no active testing\)\.
- Source code review\.
- On\-site visits\.
- Interviews: none are recorded in the assessment, and none are represented in this report\.
- Independent collection of evidence from the assessed systems: evidence was supplied by the assessed organization\.

## 3. Methodology

- Step 1: Scope declared and fixed in the assessment record before evaluation \(immutable scope\)\.
- Step 2: The ten rn\.sv@0\.1\.0 controls identified for the scope\.
- Step 3: Evidence references collected; each manually supplied reference is bound to the requirement it was offered for\.
- Step 4: Structural and provenance checks available to the Host applied: binding, tenant attribution, digests where present\. Supplier claims of verification are recorded as claims only\.
- Step 5: Each control reviewed by an authenticated reviewer holding the required role; a definitive conclusion must cite evidence accepted for that control\.
- Step 6: Controls evaluated and scored under the framework methodology\.
- Step 7: Findings derived and classified by rule\-based severity\.
- Step 8: Assessment integrity and finding histories verified\.
- Step 9: This report generated deterministically from the verified assessment\.
- Step 10: Release reviewed and approved by an authenticated human approver before delivery\.

Required reviewer role: assure\.reviewer.

Scoring: rn\.sv\.scoring@0\.1\.0: pass = 1, partial = 0\.5, fail = 0; unknown and pending reviews score 0 and stay in the denominator; domain\-weighted; a failed SV\-06 or SV\-08 marks its domain unhealthy\.

## 4. Control coverage

| ID | Control | Domain | Result | Evidence | Findings |
| --- | --- | --- | --- | --- | --- |
| SV\-01 | Actor identity and authority | Authority \& Consent | PASS | E\-08 | — |
| SV\-02 | Consent and revocation | Authority \& Consent | PASS | E\-07 | — |
| SV\-03 | Policy compliance | Policy \& Governance | PARTIAL | E\-03 | F\-02 |
| SV\-04 | Evidence integrity | Evidence \& Traceability | PASS | E\-06, E\-09 | — |
| SV\-05 | Execution traceability | Evidence \& Traceability | PASS | E\-05 | — |
| SV\-06 | Isolation between organizations | Data Boundaries | FAIL | E\-10 | F\-01 |
| SV\-07 | Minimal disclosure | Data Boundaries | UNKNOWN | — | F\-03 |
| SV\-08 | Effective revocation of authority | Authority \& Consent | PASS | E\-04 | — |
| SV\-09 | Remediation and revalidation | Remediation | UNKNOWN | — | F\-04 |
| SV\-10 | Governance and accountability | Policy \& Governance | PARTIAL | E\-01 | F\-05 |

### SV\-01 — Actor identity and authority

**Result: PASS.** The reviewer concluded the control's criteria were met over the reviewed sample: Every sampled privileged action maps to a unique identity holding authority in force at the time\.

Objective: Demonstrate that privileged operations are performed only by identified actors with authority in force\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-08. Findings: none.

**Limitations**

- Sample\-based: conclusions cover the sampled actions only\.
- Legitimate service accounts can look like shared accounts without their inventory\.

### SV\-02 — Consent and revocation

**Result: PASS.** The reviewer concluded the control's criteria were met over the reviewed sample: Every sampled operation relied on consent in force and no operation followed a sampled revocation\.

Objective: Demonstrate that data subjects’ consent decisions are recorded and honored, including withdrawal\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-07. Findings: none.

**Limitations**

- Consent captured outside the system may be invisible to the sample\.

### SV\-03 — Policy compliance

**Result: PARTIAL.** The reviewer concluded the criteria were met only in part over the reviewed sample\.

Objective: Demonstrate that the declared policy is the policy actually applied\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-03. Findings: F\-02.

**Limitations**

- Exceptions approved outside the tooling may appear as inconsistencies\.

Revalidation: A new decision sample under the corrected policy version\.

### SV\-04 — Evidence integrity

**Result: PASS.** The reviewer concluded the control's criteria were met over the reviewed sample: An integrity mechanism covers the critical records and verification succeeds over the sample\.

Objective: Demonstrate that recorded evidence cannot be altered without detection\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-06, E\-09. Findings: none.

**Limitations**

- Integrity is not truthfulness: a record that was false when written verifies as intact\.
- Without signatures, a privileged writer can recompute digests consistently\.

### SV\-05 — Execution traceability

**Result: PASS.** The reviewer concluded the control's criteria were met over the reviewed sample: Each sampled operation is reconstructable from request to observed outcome\.

Objective: Demonstrate that what was authorized can be connected to what actually happened\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-05. Findings: none.

**Limitations**

- Relies on the customer’s logs; log completeness is not independently established\.

### SV\-06 — Isolation between organizations

**Result: FAIL.** The reviewer observed the control not satisfied: A cross\-organization read or write succeeded, or an in\-scope path does not enforce the organization scope\.

Objective: Demonstrate that one organization cannot read or alter another organization’s data\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-10. Findings: F\-01.

**Limitations**

- This framework performs no active testing against customer systems; active testing requires separate written authorization and is out of scope for 0\.1\.0\.
- Legitimate global administrative roles cross organizations by design\.

Revalidation: Re\-execution of the isolation tests after the correction, witnessed or recorded\.

### SV\-07 — Minimal disclosure

**Result: UNKNOWN.** Not determined: the evidence available did not allow a defensible conclusion\. This is an evidence gap, not an observed failure\. Typical cause: No field inventory or samples were provided\.

Objective: Demonstrate that the platform discloses no more than each audience requires\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: none accepted. Findings: F\-03.

**Limitations**

- Field\-level review only; no automated detection of personal data by value\.

Revalidation: A new export sample after the correction\.

### SV\-08 — Effective revocation of authority

**Result: PASS.** The reviewer concluded the control's criteria were met over the reviewed sample: The first attempt after revocation was denied within the documented bound\.

Objective: Demonstrate that revocation is effective in practice, not only recorded\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-04. Findings: none.

**Limitations**

- This framework performs no active testing against customer systems; the test is executed by the customer in staging\.
- Caches with a documented time\-to\-live can delay denial legitimately\.

### SV\-09 — Remediation and revalidation

**Result: UNKNOWN.** Not determined: the evidence available did not allow a defensible conclusion\. This is an evidence gap, not an observed failure\. Typical cause: No tracking records were provided\.

Objective: Demonstrate that the organization corrects issues and confirms the corrections\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: none accepted. Findings: F\-04.

**Limitations**

- On a first assessment there may be no prior findings to sample\.

Revalidation: Review of closures made after the correction date\.

### SV\-10 — Governance and accountability

**Result: PARTIAL.** The reviewer concluded the criteria were met only in part over the reviewed sample\.

Objective: Demonstrate that someone is accountable for sovereignty decisions and that the posture is reviewed\.

Review: authenticated reviewer(s) reviewer\-1, 2026\-06\-01. Reviewer rationale is kept in the assessment record and is not reproduced here.

Evidence: E\-01. Findings: F\-05.

**Limitations**

- Documentary: the existence of a process does not prove its effectiveness\.

Revalidation: Evidence of the next scheduled review after the correction\.

## 5. Results and interpretation

| Measure | Value |
| --- | --- |
| Score \(0–100\) | 60 |
| Methodology | rn\.sv\.scoring@0\.1\.0 |
| Controls evaluated | 10 |
| PASS | 5 |
| PARTIAL | 2 |
| FAIL | 1 |
| UNKNOWN | 2 |
| MANUAL REVIEW REQUIRED | 0 |
| Open findings | 5 |
| Findings recorded after completion \(not part of this report\) | 0 |

The score summarizes this framework’s methodology over the declared scope\. A high score is not demonstrated sovereignty, and an UNKNOWN control lowers the score without being a failure\. Read every control result and its limitations\.

| Domain | Status | Score |
| --- | --- | --- |
| Authority \& Consent | healthy | 100 |
| Data Boundaries | unhealthy | 0 |
| Evidence \& Traceability | healthy | 100 |
| Policy \& Governance | degraded | 50 |
| Remediation | degraded | 0 |

**Blocking risks**

- SV\-06 failed: the Data Boundaries domain is marked unhealthy regardless of its numeric score\.

## 6. Findings

### F\-01 — SV\-06 Isolation between organizations

| Field | Value |
| --- | --- |
| Finding | assurance\-finding\-49 |
| Severity | critical |
| Engine classification | control\_failure |
| Remediation type | Corrective action |
| Status | open |
| Priority | Immediate |
| Evidence | E\-10 |

The reviewer observed the control not satisfied: A cross\-organization read or write succeeded, or an in\-scope path does not enforce the organization scope\.

Risk: One organization reading or altering another organization’s data\.

Recommendation: Enforce the tenant scope on every read and write path and cover it with automated isolation tests\.

Closure criterion: Re\-execution of the isolation tests after the correction, witnessed or recorded\.

### F\-02 — SV\-03 Policy compliance

| Field | Value |
| --- | --- |
| Finding | assurance\-finding\-48 |
| Severity | medium |
| Engine classification | evidence\_gap |
| Remediation type | Corrective action |
| Status | open |
| Priority | Normal |
| Evidence | E\-03 |

The reviewer concluded the criteria were met only in part over the reviewed sample\.

Risk: Decisions taken outside the declared policy\.

Recommendation: Version the policy, record which version each decision used, and route exceptions through an attributable approval\.

Closure criterion: A new decision sample under the corrected policy version\.

### F\-03 — SV\-07 Minimal disclosure

| Field | Value |
| --- | --- |
| Finding | assurance\-finding\-50 |
| Severity | low |
| Engine classification | evidence\_gap |
| Remediation type | Provide evidence |
| Status | open |
| Priority | Low |
| Evidence | — |

Not determined: the evidence available did not allow a defensible conclusion\. This is an evidence gap, not an observed failure\. Typical cause: No field inventory or samples were provided\.

Recommendation: Provide the evidence the control requires so it can be concluded\. If a gap is then confirmed: Define per\-audience disclosure profiles and strip every field an audience does not need\.

Closure criterion: A new export sample after the correction\.

### F\-04 — SV\-09 Remediation and revalidation

| Field | Value |
| --- | --- |
| Finding | assurance\-finding\-51 |
| Severity | low |
| Engine classification | evidence\_gap |
| Remediation type | Provide evidence |
| Status | open |
| Priority | Low |
| Evidence | — |

Not determined: the evidence available did not allow a defensible conclusion\. This is an evidence gap, not an observed failure\. Typical cause: No tracking records were provided\.

Recommendation: Provide the evidence the control requires so it can be concluded\. If a gap is then confirmed: Track findings to closure with evidence, and close only after a later check confirms the fix\.

Closure criterion: Review of closures made after the correction date\.

### F\-05 — SV\-10 Governance and accountability

| Field | Value |
| --- | --- |
| Finding | assurance\-finding\-52 |
| Severity | low |
| Engine classification | evidence\_gap |
| Remediation type | Corrective action |
| Status | open |
| Priority | Low |
| Evidence | E\-01 |

The reviewer concluded the criteria were met only in part over the reviewed sample\.

Risk: No one accountable for sovereignty decisions\.

Recommendation: Name accountable owners, document responsibilities, and review the sovereignty posture on a fixed cadence\.

Closure criterion: Evidence of the next scheduled review after the correction\.

## 7. Remediation roadmap

| \# | Finding | Control | Severity | Type | Priority | Owner | Target date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | F\-01 | SV\-06 | critical | Corrective action | Immediate | To be agreed with customer | To be agreed with customer |
| 2 | F\-02 | SV\-03 | medium | Corrective action | Normal | To be agreed with customer | To be agreed with customer |
| 3 | F\-03 | SV\-07 | low | Provide evidence | Low | To be agreed with customer | To be agreed with customer |
| 4 | F\-04 | SV\-09 | low | Provide evidence | Low | To be agreed with customer | To be agreed with customer |
| 5 | F\-05 | SV\-10 | low | Corrective action | Low | To be agreed with customer | To be agreed with customer |

Human\-proposed actions: none\. Every item above is derived by the engine from a finding; any proposal beyond them requires separate human approval and is not part of this report\.

## 8. Evidence register

Evidence is listed under report-local labels. Supplier identifiers, locations and contents are not reproduced; the digest identifies the referenced bytes.

| Ref | Controls | Type | Acceptance | Verification | Date | Digest |
| --- | --- | --- | --- | --- | --- | --- |
| E\-01 | SV\-10 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:179355062ad5d2a3394d87152834c527ba4bc400bc318e3b682052d11b041762 |
| E\-02 | — | external\_artifact\_reference | rejected \(EVIDENCE\_WRONG\_TENANT\) | Supplier\-provided; not verified by the Host | Withheld \(rejected reference\) | — |
| E\-03 | SV\-03 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:46be90290189e99519cba5448d8b5561545bf432a9666d0bb43fb2bc050de58f |
| E\-04 | SV\-08 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:5cf9cc62ac6522b52746b98bcc123747054cf650a2d87c5f241e8aeb7c6ab68b |
| E\-05 | SV\-05 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:e058077adddb1a7caf61517c5cfd4e4a097ca3063fd9c43fde80bb08707ed823 |
| E\-06 | SV\-04 | external\_artifact\_reference | accepted | Supplier\-provided; the supplier claims verification \(claim only, not verified by the Host\) | 2026\-05\-20 | sha256:e764e8c92331dfcc77707f336a9b0f3d21e70b6a241d1be66b6f6eb914492784 |
| E\-07 | SV\-02 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:ebd7362476b30cafd86d505a4b0c2e652c1c5741d321ff1e3e74bf1b091d5bce |
| E\-08 | SV\-01 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:f50f013cc696b11995509438358760a0c78775a196e9910501a034e61109e8e7 |
| E\-09 | SV\-04 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:fb6894abe305cefbcf8bff6bc85a1ee4a1363234d58f5920270398f586a17737 |
| E\-10 | SV\-06 | external\_artifact\_reference | accepted | Supplier\-provided; not verified by the Host | 2026\-05\-20 | sha256:fd11176ab4937a5ce37302c13d0d4ac3e9ccaaa7b28c8967e59fe4263f574141 |

Authenticity: unless marked as verified by a Host mechanism, a reference’s author and truthfulness are not established.

## 9. Limitations and disclaimers

- This is a limited\-scope assessment of the declared scope only; conditions outside it were not examined\.
- Results are point\-in\-time, as of the evidence cutoff, and do not describe the system before or after it\.
- Conclusions depend on the evidence made available; most evidence was supplied by the assessed organization and was not independently authenticated\.
- Every rn\.sv control is concluded by an authenticated human reviewer; the conclusions involve professional judgement\.
- This report is not a certification, accreditation, attestation of compliance, or seal of any kind\.
- This report is not a legal opinion and does not state compliance with any law or regulation\.
- This report does not establish the absence of vulnerabilities, and no security testing was performed against the assessed systems\.
- The score is specific to the rn\.sv@0\.1\.0 framework, its methodology and the declared scope; it is not a general trust or security score\.
- Document digests show that this report has not changed since it was generated; they do not show that the underlying evidence is true, and they are not a digital signature\.

## 10. Revalidation

**Findings to revalidate**

- F\-01
- F\-02
- F\-03
- F\-04
- F\-05

**Controls to re-evaluate**

- SV\-03
- SV\-06
- SV\-07
- SV\-09
- SV\-10

**Evidence required**

- SV\-03: The policy in force with its version history, plus a sample of decisions taken under it\.
- SV\-06: Tenant\-isolation design documentation and the output of isolation tests executed by the customer, witnessed or recorded\.
- SV\-07: A field inventory for the in\-scope exports and APIs, plus sample exports or responses\.
- SV\-09: The finding\-tracking process and closure evidence for previously identified issues\.
- SV\-10: Named accountable owners, a responsibility matrix, review cadence records, and the escalation path\.

**Changes that would invalidate these conclusions**

- Changes to the in\-scope systems, their architecture or their tenancy model\.
- Changes to the authority, consent or revocation mechanisms\.
- A new policy version or a change in how decisions record the policy applied\.
- Changes to logging, record integrity or disclosure profiles\.
- Material incidents affecting the in\-scope systems after the evidence cutoff\.

A revalidation is a new assessment that references assurance\-assessment\-1; this assessment and this report are never modified\.

Not included\. This report describes one point\-in\-time assessment; continuous monitoring is a separate service\.

## 11. Integrity and provenance

| Field | Value |
| --- | --- |
| Assessment | assurance\-assessment\-1 |
| Assessment digest | sha256:7346ed20936b70d1f6516772308c4907617661a0ef9cb6f8b7e63a2cc3899127 |
| Framework | rn\.sv@0\.1\.0 |
| Framework digest | sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58 |
| Generator | aoc\.assurance\.commercial\-report\.v2 |
| Issued on | 2026\-06\-01 |
| Evidence cutoff | 2026\-05\-31T00:00:00\.000Z |
| Authenticated reviewers | reviewer\-1 |
| Framework commercial use | restricted |

The framework definition records commercial use as restricted pending controlled review\. Release of this report requires an authenticated human approver to acknowledge that restriction and act as that review; the release record states whether this happened\.

This document does not record its own release\. A release is a separate record, kept by the issuer, that binds an authenticated human approval to this report’s digests\. Without a matching release record confirmed by the issuer, this report is not released\.

The digests in the manifest show integrity only\. They are not a digital signature, do not provide non\-repudiation, and do not authenticate the evidence\.

The content digest, Markdown digest and manifest digest of this document are recorded in its manifest, not in this text.
