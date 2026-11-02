# Customer-Facing Claims Review (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — SUBJECT TO QUALIFIED
> LEGAL REVIEW.** The proposed wording below is PROPOSED. None of it has been
> reviewed by counsel. The customer-facing drafts in `../drafts/` and the
> report generator are **not** edited by this mission. Labels: VERIFIED ·
> PROPOSED · PENDING · BLOCKED.

## 1. Claims Republika must not make

| # | Prohibited claim | Why | Present today? (VERIFIED by reading) |
| --- | --- | --- | --- |
| C1 | Accredited certification, seal or certificate | No accreditation body has approved the framework, the method or Republika | Not claimed; disclaimed (report L408, draft G §1, service spec §15) |
| C2 | Formal third-party attestation | No independent attestor exists; the R1/R2 review is not an attestation (protocol §1) | Not claimed; but see C7 |
| C3 | Guaranteed compliance with any law, regulation or standard | Not assessed | Disclaimed (draft G §3) |
| C4 | Guaranteed security, or prevention of incidents | No active testing | Disclaimed (draft G §4) |
| C5 | Independent cryptographic authenticity | No signature, timestamp or anchor (B7) | Disclaimed (report cover limitation, draft G §11, verifier verdict) |
| C6 | Authentication of customer-supplied evidence | Evidence is identified by digest only (B1) | Disclaimed (report L406, draft G §6) |
| C7 | Full independence of the assessment | Republika authors the framework, operates the tooling, reviews and approves | **Claimed**: draft A L11 "an independent, evidence-based view"; draft A L25 "Independent sign-off"; draft H L21 "approver, independent of the reviewers"; service spec §1 "independent … view" (GF-06) |
| C8 | That the internal approver is the framework's "controlled review" | Founder decision D-02 is open | **Stated** in every report v2 cover (`commercial-report.ts:787-791`; GF-01) |
| C9 | That the customer can "prove" its posture | The report records a reviewer's conclusions on supplied evidence | **Implied**: draft A L8 headline "…and prove it" |
| C10 | That the score is a benchmark, or comparable across versions or scopes | No benchmark data; version-bound | Disclaimed (service spec §10, draft G §10) |

## 2. What Republika actually evaluates (proposed definition)

> Republika reviewed the evidence your organization supplied for the declared
> scope against the ten controls of `rn.sv@<version>`. For each control, a
> Republika reviewer recorded a conclusion from that evidence, and a second
> Republika person, who reviewed none of the controls, approved the report for
> release. **A PASS means**: the reviewer concluded, from evidence you supplied
> and bound to that control, that the control's stated condition held for the
> sample, as of the evidence cut-off. **It does not mean** that Republika
> verified that the evidence is genuine or complete, tested your systems, or
> certifies anything, or that any party outside Republika examined the result
> [unless an independent review was performed for this release, in which case:
> name the reviewer and the scope of their review].

## 3. Proposed replacement wording (for LEG)

| Location | Current | Proposed |
| --- | --- | --- |
| Draft A L8 headline | "Know who can act on your behalf — and prove it" | "Know who can act on your behalf — and see the evidence for it" |
| Draft A L11; service spec §1 | "an independent, evidence-based view" | "an outside, evidence-based, human-reviewed view" |
| Draft A L25 | "**Independent sign-off**: the person who approves your report did not review its controls." | "**Separate approval**: a second Republika person, who reviewed none of your controls, approves the report before release." |
| Draft H L21 | "A Republika approver, independent of the reviewers, approved this exact content" | "A Republika approver, different from the reviewers, approved this exact content" |
| Report cover commercial-use statement (generator; R-06b or a generator mission, not this one) | "…requires an authenticated human approver to acknowledge that restriction and act as that review…" | Per D-02. If (a): "Release required an authenticated Republika approver's acknowledgement. [The release was also reviewed by <reviewer>, independent of Republika, under <scope>.]" If (b): keep, adding "The approver is a Republika employee or contractor." |
| Draft G (add) | — | "**Who performed this assessment.** Republika wrote the framework, operates the software used, and performed and approved this assessment. It is independent of your organization, not of the framework or the tooling." |
| Draft G (add) | — | "**What is not covered.** Only the ten controls listed. In particular, not: infrastructure or network security testing, availability, supply-chain security, the jurisdictional exposure of your providers, or the behaviour of any AI model." (list to be confirmed in R1) |

## 4. Authenticity sentence (B7, Option A)

> This package is protected by integrity digests so that changes can be
> detected. It is **not digitally signed**. Only Republika can confirm that a
> package is one it issued: confirm the release digest with us over a channel
> different from the one used for delivery, and keep the signed delivery
> confirmation letter. After we delete your records at the end of the agreed
> retention period, we can no longer confirm it.

## 5. Permitted customer description (for the SOW; SR-10)

> "<Customer> was assessed by Republika Network against the `rn.sv@<version>`
> framework (ten controls), for <scope>, with evidence up to <date>. The
> assessment is not a certification or audit."

Any other public reference needs Republika's written consent.

## 6. Claims that require legal approval

| # | Item | Reason |
| --- | --- | --- |
| L1 | Every use of "assessment", "review", "assurance" and "verified" in marketing | Some jurisdictions restrict audit or assurance terms |
| L2 | Any statement about independence, including the §3 wording and an R2 reviewer's naming | Misleading-claims and professional-standards exposure |
| L3 | The authenticity sentence (§4) and the A-2 delivery confirmation letter | Creates an issuer representation |
| L4 | Third-party reliance and the internal-use restriction | Liability allocation |
| L5 | Retention and deletion statements to customers (D-04) | Data-protection law |
| L6 | The permitted customer description and correction rights (§5) | Contract and marketing law |
| L7 | Liability cap, disclaimers, governing law (draft B) | Contract |
| L8 | Privacy notice to operators about reviewer IDs in reports | Personal data |
| L9 | Any naming of a customer as a founding customer or reference | Consent |
