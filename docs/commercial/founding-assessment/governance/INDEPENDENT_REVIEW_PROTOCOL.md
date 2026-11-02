# Independent Review Protocol — Frontera Assurance and `rn.sv` (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — PROPOSED protocol.**
> **No independent reviewer has been identified, engaged or briefed. No
> review has been performed. No finding, opinion, approval, audit or
> certification exists.** Every reviewer field below is intentionally blank.
> Adoption of this protocol is founder decision D-02. Labels: VERIFIED ·
> PROPOSED · PENDING · BLOCKED.

## 1. Purpose and what this review is not

The frozen restriction of `rn.sv@0.1.0` makes **"controlled external review"**
the condition for issuing commercial conclusions. This protocol defines how a
qualified person, independent of the implementation, performs that review.
It is designed so that the reviewer does **not** need the engineering
conversation: [`INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](INDEPENDENT_REVIEW_EVIDENCE_INDEX.md)
is the reviewer's pack.

This review is a **technical and methodology review with a written opinion**. It
is **not**:

- an assurance engagement under a professional standard (for example ISAE 3000
  or AICPA attestation standards). If Republika wants a formal attestation,
  that is a separate engagement with a licensed practitioner under that
  standard, and the scope and opinion form are the practitioner's;
- a certification, accreditation or audit opinion;
- legal advice. Legal questions go to counsel (§10).

Customer-facing language must describe it accordingly ([`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md)).

## 2. Review stages

| Stage | When | Scope | Output |
| --- | --- | --- | --- |
| **R1 — System and methodology review** | Once, **before** any framework authorization (M1) and before `rn.sv@0.2.0` bytes are frozen (methodology part) and again on the frozen digest (confirmation part) | Trust boundaries, security residuals, framework methodology, report and package semantics, B7 options, operator procedures | R1 report with an opinion per area (§11) |
| **R2 — Engagement release review** | For each release under a commercial engagement, **before** the release approval is recorded | Sampled re-performance of control conclusions, evidence relevance, separation of duties by person, disclosure in the draft | R2 note: concur / concur with qualifications / do not concur |
| **R3 — Periodic re-review** | Annually, or on any invalidating event (§12) | Changes since R1; incidents; risk register | R3 report |

Whether R2 is required for every release, or whether the internal approver may
act as the controlled review, is **D-02**. This protocol recommends R2 for at
least the first founding engagement. Note GF-01: report generators v1 and v2
stated that the approver acts as that review. From generator v3
(ASSURE-CLAIMS-01) new reports state instead that internal approval is not an
independent external review and does not remove the restriction; historical
v1/v2 reports keep their wording. D-02 itself remains open.

## 3. Independence criteria

The reviewer **must not**, now or in the 24 months before engagement:

1. be employed by, contracted to or a director of Republika Network or an
   affiliate, other than under this review engagement;
2. have authored, reviewed or approved any code, document or framework content
   in scope (including any `ASSURE-*` mission or PR);
3. hold equity, options, a loan, or any financial interest in Republika whose
   value depends on the review's outcome;
4. be paid a fee contingent on the outcome. A fixed fee is required;
5. have a close family or personal relationship with a Republika founder,
   operator or role holder;
6. be the customer of the engagement under R2, or work for it;
7. be an AI system. An AI tool may assist the reviewer only under §6 and
   cannot hold the reviewer's role or sign.

Independence is **from the implementation and from Republika's commercial
interest**. It is not independence from the framework's subject matter, which
requires expertise.

## 4. Qualifications

Minimum (to be confirmed by FDR when choosing; PROPOSED):

- **Security reviewer (R1 technical):** at least five years of application
  security review or security architecture; can read TypeScript and run Node
  test suites; familiar with digital-signature and custody threat models.
- **Methodology reviewer (R1 methodology, R2):** demonstrable experience
  designing or performing control assessments (for example as a lead auditor
  or assessor for an information-security management system, or as a SOC
  practitioner); understands sampling and evidence sufficiency.
- One person may hold both roles if qualified. Professional credentials are
  recorded as stated by the reviewer and checked by FDR; this protocol does not
  require any specific credential.

## 5. Conflict-of-interest disclosure (to be completed by the reviewer)

```text
Reviewer name:                         ____________________
Organization (if any):                 ____________________
Qualifications relied on:              ____________________
Relationship with Republika (any, ever): ____________________
Financial interests in Republika:      ____________________
Prior work on Frontera / AOC / rn.sv:  ____________________
Relationship with the engagement customer (R2): ____________________
Fee basis (fixed / other):             ____________________
I confirm the criteria in §3 are met, except as disclosed above.
Signature: ____________________   Date: ____________
Accepted by (FDR): ________________ Date: ____________
```

A disclosed exception is decided by FDR **and** recorded; it is never silently
waived.

## 6. Access

| Item | Access | Condition |
| --- | --- | --- |
| Source code | Read access to `Republika-Network/Frontera` at a **pinned commit** stated in the engagement letter | Under NDA; the commit is the one whose framework digest is under review |
| Build and tests | The reviewer runs them on their own machine (§8) | No Republika machine required |
| Synthetic packages | Generated by the reviewer with the dry-run script | No customer data |
| Customer evidence (R2 only) | Inspected in a customer-controlled session or on the engagement Host, under the engagement's confidentiality terms and with the customer's written consent | Recorded by digest only; no copies leave the session |
| Interviews | Founder, engineering, operators | Notes kept by the reviewer |
| AI assistance | Only tools whose data handling the customer and Republika have approved (`../CUSTOMER_DATA_GOVERNANCE.md` §14); never with customer evidence | The reviewer remains responsible for every statement |

## 7. Scope of review

### 7.1 R1 technical

1. Trust boundaries and residuals: B1–B9 ([`B1_B9_BLOCKER_DISPOSITION.md`](B1_B9_BLOCKER_DISPOSITION.md)),
   A10, credentials, custody, backups, export, Host posture.
2. B7: evaluate [`B7_AUTHENTICITY_OPTIONS.md`](B7_AUTHENTICITY_OPTIONS.md); state
   whether Option A's conditions are adequate for a private pilot.
3. Reproduce the test evidence (§8) and the independent verifier result.
4. Assess the risk register's severities ([`SECURITY_RISK_REGISTER.md`](SECURITY_RISK_REGISTER.md)).
5. Review the delivered package: what a recipient can and cannot conclude.

### 7.2 R1 methodology

1. For each of the ten controls: objective, questions, evidence requirement,
   outcome conditions, limitations and revalidation criterion
   (`rn-sv-framework.ts`, `metadata.controlProfiles`). Are they clear, testable
   from documentary evidence, and free of hidden assumptions?
2. Scoring: weights 0.3/0.2/0.2/0.2/0.1, `unknownPolicy: 'zero'`, blocking SV-06
   and SV-08. Is the score's meaning stated honestly? (Weights are not
   externally validated: `../SERVICE_SPECIFICATION.md` §10.)
3. Scope limitations of the ten controls: what a "sovereignty posture" claim
   does **not** cover (SR-11).
4. Whether the candidate `rn.sv@0.2.0` delta
   ([`RN_SV_0_2_0_CANDIDATE_SPEC.md`](RN_SV_0_2_0_CANDIDATE_SPEC.md)) should
   change any control content before freezing.
5. Customer-facing claims ([`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md)), from a methodology standpoint, not a legal one.

### 7.3 R2 sampling procedure (per release)

| Item | Minimum sample |
| --- | --- |
| Blocking controls SV-06 and SV-08 | Always both, whatever their outcome |
| Controls concluded PASS | At least two more, chosen by the reviewer, not by Republika |
| Controls concluded FAIL or PARTIAL | At least one, where any exist |
| UNKNOWN | Confirm the gap is real (evidence absent or insufficient), at least one where any exist |
| Evidence relevance | For each sampled control, every cited reference: is it relevant to the control's question (B8 residual)? |
| Separation of duties by person | Credential register: reviewer and approver credentials belong to different named people (B3 residual) |
| Draft disclosure | The draft's scope, exclusions, limitations and declared text against the SOW |

The reviewer **re-performs** the conclusion from the cited evidence. A
disagreement on a sampled control is recorded with reasons. Republika may
not alter a conclusion to satisfy the reviewer within the attempt: it ends the
attempt and starts a linked new one (REL-01B), or releases with the
reviewer's qualification disclosed (decided by FDR, recorded).

## 8. Evidence and reproducibility requirements

- Every claim in the reviewer's report cites a file and line, a test name, or
  a reproduced command with its output.
- The reviewer reproduces at least: the framework golden digest, the REL-01A
  `A10 KNOWN LIMITATION` test, the PILOT-01 F01 offline test, the REL-01D Host
  pilot P01, and the independent verifier verdict. Commands are in the evidence
  index §3.
- Results recorded by Republika (including by this package) are **not**
  accepted as evidence without reproduction.
- The reviewer records the commit, Node version and OS used.

## 9. Security findings: classification and treatment

| Severity | Meaning | Treatment before authorization |
| --- | --- | --- |
| Critical | A guarantee stated to customers is false, or customer data can be disclosed to an unauthorized party | Must be fixed and re-reviewed |
| High | A material risk not disclosed, or a disclosed risk materially misdescribed | Fixed, or accepted in writing by SEC + FDR with disclosure, and the reviewer states whether they concur |
| Medium | A weakness with a compensating control | Treatment plan with a date |
| Low / Informational | Hardening | Backlog |

Residual-risk treatment: each finding maps to a register entry (new or existing)
with **accept / mitigate / defer / reject**, decided by the risk's approver,
never by the reviewer and never by engineering.

## 10. Where human judgement or legal opinion cannot be replaced by tests

| Question | Why tests cannot answer it | Who answers |
| --- | --- | --- |
| Is customer evidence genuine and complete? | The product only identifies evidence by digest (B1) | Reviewer judgement and sampling; customer attestation (draft E) |
| Is a control conclusion correct? | Correctness is professional judgement over evidence | Reviewer (R2 re-performance) |
| Are the controls and weights an adequate measure of "sovereignty posture"? | A design question | Methodology reviewer (R1) |
| Is a residual risk acceptable? | A business and ethical decision | SEC + FDR (M2) |
| Are two credentials held by two different people? | Software cannot see people | Credential register, reviewer inspection |
| Is the customer-facing wording lawful and not misleading in the relevant jurisdictions? | Legal question | Counsel (LEG) |
| Is the liability allocation, insurance and third-party reliance position acceptable? | Legal and commercial | LEG + FDR |
| Is the evidence lawfully provided (consent, confidentiality, personal data)? | Legal | LEG; customer attestation |
| Is the Host volume actually encrypted on the real engagement machine? | Preflight E13 detects, does not enforce; attestation is not proof | OPS runs E13; SEC witnesses |

## 11. Review report format (R1)

1. Reviewer identification and §5 disclosure (signed).
2. Engagement terms: dates, fixed fee confirmation, pinned commit, framework digest(s) reviewed.
3. Scope performed and any limitation of scope.
4. Reproduction log (§8).
5. Findings, each with severity, evidence, recommendation.
6. Opinion per area, one of: **No objection** · **No objection with conditions** (listed) · **Objection** (reasons):
   - security residuals for a private pilot;
   - B7 Option A adequacy;
   - methodology of the ten controls and scoring;
   - customer-facing claims (methodology view);
   - readiness of the candidate `rn.sv@0.2.0` delta.
7. Statement of what the reviewer did **not** examine.
8. Dated signature.

## 12. Approval or refusal criteria (PROPOSED)

- **R1 is satisfied** only if: no open Critical; every High fixed, or accepted
  by SEC + FDR with the reviewer's stated concurrence; the opinion on security
  residuals and B7 is "No objection" or "No objection with conditions" whose
  conditions are recorded as authorization conditions.
- **R1 is refused** on: any Objection; an independence exception not accepted
  by FDR; a reproduction failure not explained.
- **R2 is satisfied** by "concur" or "concur with qualifications" disclosed in
  the delivered package. "Do not concur" blocks the release until resolved.
- **Re-review (R3) is triggered** by: any change to the framework, generator,
  custody or verifier code; any incident in the register's invalidating
  conditions; a change of operator role holders; 12 months elapsed.

## 13. Sign-off record (blank)

```text
Review stage:            R1 / R2 / R3
Reviewer:                ____________________ (real, named person)
Commit reviewed:         ____________________
Framework digest(s):     ____________________
Opinion:                 ____________________
Conditions:              ____________________
Report reference:        ____________________ (document ID, stored off-repo)
Signature:               ____________________
Date:                    ____________
Received by (FDR):       ____________________ Date: ____________
```

This record is filled in by the reviewer, not by Republika. A copy, or its
reference and digest, is cited in the authorization record
([`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §4).
