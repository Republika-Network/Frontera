# [DRAFT G] Limitations and Non-Certification Notice

> **DRAFT — SUBJECT TO QUALIFIED LEGAL REVIEW.** Intended to accompany every
> delivered package and to form part of the SOW. "Who performs the
> assessment" and "What is outside scope" added by ASSURE-CLAIMS-01 (GF-06).

**Please read this notice before relying on the Republika Sovereignty
Assessment report.**

1. **Not a certification.** The report is not a certification, attestation,
   accreditation or seal. No accreditation or certification body has
   approved the framework, the methodology or Republika as an assessor.
2. **Not an audit.** It is not a financial audit and expresses no opinion on
   financial statements or internal control over financial reporting.
3. **Not legal or regulatory compliance.** It is not legal advice and does
   not certify compliance with any law, regulation or standard.
4. **No guarantee of security.** It does not guarantee that you will not
   suffer a cyberattack, breach, outage or other incident. No active testing
   was performed.
5. **No blanket assurance about autonomous agents.** It does not assure the
   safety, correctness or future behaviour of any autonomous agent or other
   system.
6. **Your evidence.** Conclusions rest on evidence you supplied. Republika did
   not authenticate it. If the evidence was inaccurate or incomplete, the
   conclusions may be wrong.
7. **Point in time, sample based.** Results describe the sampled evidence as
   of the evidence cut-off, within the declared scope only.
8. **Human judgement.** Each control was concluded by a human reviewer
   against a fixed framework. Another reviewer could reasonably reach a
   different conclusion on the same evidence.
9. **UNKNOWN is a gap, not a failure.** UNKNOWN means the evidence did not
   allow a defensible conclusion. It scores zero.
10. **The score is not a benchmark.** It is bound to the framework version,
    scope and methodology. A high score does not demonstrate sovereignty and
    is not comparable across versions or scopes.
11. **Authenticity.** The package is integrity-protected but **not digitally
    signed**. Confirm its origin with Republika (see the verification
    instructions). After Republika deletes your records at the end of
    retention, it can no longer confirm the package.
12. **Framework status.** [If `rn.sv@0.1.0`: The framework version used
    records a commercial-use restriction, acknowledged by the approver at
    release. That acknowledgement is an internal approval step; it is not an
    external review and does not lift the restriction.] [If a later version:
    state its authorization reference.]
13. **Use.** The report is for your internal use. [Third-party reliance —
    counsel.]

## Who performs the assessment

Republika Network wrote the `rn.sv` framework, operates the software used to
run the assessment, and conducts and approves the assessment with its own
authorized reviewers and approvers (employees or authorized contractors):

- **Assessment review.** An authenticated Republika reviewer concludes each
  control from the evidence you supplied.
- **Release approval.** A separate authorized Republika approver, who
  recorded none of the control reviews, approves the exact report content
  for release.

Both steps are internal to Republika. The assessment is independent of your
organization; it is **not** independent of the framework author or of the
tooling operator, and no external auditor or independent third party has
reviewed it. If an external review is ever performed for a report, it will be
a separate, documented engagement, and the report or its accompanying
documents will name the reviewer and the scope of that review. Absent that,
assume none occurred.

## What is outside scope

The assessment covers **only** the ten controls of `rn.sv@0.1.0`, for the
scope you declared and the evidence you supplied up to the evidence cut-off:
SV-01 actor identity and authority; SV-02 consent and revocation; SV-03
policy compliance; SV-04 evidence integrity; SV-05 execution traceability;
SV-06 isolation between organizations; SV-07 minimal disclosure; SV-08
effective revocation of authority; SV-09 remediation and revalidation; SV-10
governance and accountability.

It makes no statement, and gives no assurance, about:

- penetration testing or any other active security testing (none is
  performed);
- infrastructure or network security certification;
- regulatory or legal compliance under any law, regulation or standard;
- the security certification of any cloud or hosting provider, or their
  jurisdictional exposure;
- availability, resilience or performance guarantees;
- the correctness, safety or behaviour of any AI model;
- supply-chain security assurance;
- overall immunity to, or prevention of, autonomous-agent failures.
