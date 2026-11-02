# Reviewer Briefing — Frontera Assurance and `rn.sv@0.1.0` (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT briefing for a
> prospective reviewer.** It may be shared with a candidate only after FDR
> approves it (A-05 in [`FOUNDER_ACTIONS.md`](FOUNDER_ACTIONS.md)). It contains
> no customer data and no secrets. It describes the system as Republika
> believes it to be; **the reviewer's task is to test that belief, not to adopt
> it.**

## 1. What you would be reviewing, in one paragraph

Republika Network proposes a paid **Founding Assessment**: a human-reviewed
assessment of an organization's "digital-sovereignty posture" against a
ten-control framework, `rn.sv@0.1.0`, which Republika wrote. Evidence is
supplied by the assessed organization. Republika reviewers record a conclusion
per control in the Frontera Enterprise Host; a separate Republika approver
releases a report; the customer receives a package with integrity digests that
an offline verifier can check. The framework itself states that its results
**must not be issued as commercial conclusions without controlled external
review**. You would be that external review at the system and methodology
level (stage R1). Nobody has done this before you; there is no prior opinion.

## 2. What Republika is not claiming

- Not a certification, audit, attestation or accreditation.
- Not that customer evidence is authenticated (it is identified by digest and
  judged by a person).
- Not that the report is externally authenticated: there is **no digital
  signature, timestamp or anchor**, and custody is Republika's own record.
- Not that separation of duties is proven per person: it is enforced per
  credential.
- Not that any commercial use is authorized: the launch decision is **NO-GO**.

## 3. Read first (about two hours)

1. [`REVIEWER_STATEMENT_OF_WORK.md`](REVIEWER_STATEMENT_OF_WORK.md) — scope.
2. `src/enterprise/assurance/frameworks/rn-sv-framework.ts` — the framework (554 lines; the header comment is the design rationale).
3. [`../B1_B9_BLOCKER_DISPOSITION.md`](../B1_B9_BLOCKER_DISPOSITION.md) — the nine known blockers and what remains.
4. [`../B7_AUTHENTICITY_OPTIONS.md`](../B7_AUTHENTICITY_OPTIONS.md) — the open authenticity question.
5. [`REVIEW_EVIDENCE_INDEX.md`](REVIEW_EVIDENCE_INDEX.md) — where everything else is, and how much to trust each item.
6. [`REPRODUCTION_GUIDE.md`](REPRODUCTION_GUIDE.md) — run it yourself.

## 4. Questions Republika cannot answer for itself

These are questions, not findings. They are listed so you can decide whether
they matter; you are free to ignore them or to find others.

**Methodology**

- Q-M1 Is "digital-sovereignty posture" a fair name for what ten controls over
  identity, consent, policy, evidence, isolation, disclosure, revocation,
  remediation and governance measure? What does it omit (SR-11)?
- Q-M2 Can each control's PASS be concluded from **documentary** evidence
  alone, given that evidence is not authenticated (B1)? Which controls need
  corroboration (for example a witnessed test for SV-08)?
- Q-M3 Would two competent reviewers reach the same conclusion on the same
  evidence using `metadata.controlProfiles`?

**Scoring** (observed by code reading in `scoring.ts`; not separately tested
by this mission)

- Q-S1 A failed blocking control (SV-06 or SV-08) sets its domain to
  `unhealthy`, but the overall `normalizedScore` remains a weighted average of
  domain scores. Is that, and its presentation in the report, defensible?
- Q-S2 With `unknownPolicy: 'zero'`, how do unknown controls and wholly
  unscoreable domains affect the overall score and its denominator? Is the
  result explained to the customer?
- Q-S3 Are the domain weights (0.3 / 0.2 / 0.2 / 0.2 / 0.1) justified, or
  should they be presented as unvalidated judgement?

**Security**

- Q-X1 Is the static-credential model acceptable for a single private pilot on
  loopback / SSH tunnel, with a credential register (SR-02)?
- Q-X2 Are B7 Option A measures A-1…A-5 adequate for one internal-use pilot?
- Q-X3 Is the A10 residual (coherent rewrite by the store administrator)
  adequately mitigated by separating SEC and OPS (A-3)?

## 5. The focus question

> *Are the ten controls, their evidence requirements, scoring and limitations
> sufficiently coherent and defensible for the proposed Founding Assessment
> service?*

Please answer it explicitly, with reasons, in your report.

## 6. The successor framework (`rn.sv@0.2.0`)

A successor is **proposed on paper only**
([`../RN_SV_0_2_0_CANDIDATE_SPEC.md`](../RN_SV_0_2_0_CANDIDATE_SPEC.md)). It does
not exist in code, has no digest and is not registered. Republika intends to
freeze its bytes only **after** your methodology review, so your view can shape
it. Please state whether `rn.sv@0.2.0` should:

1. keep the same control methodology;
2. change specific controls (which, and how);
3. change scoring or weights;
4. add disclosure requirements;
5. require signed releases (B7 Option B or C) before use;
6. require enhanced reviewer authentication (for example passkey-bound
   approval and rate limiting, backlog R-03).

## 7. Practicalities

- Your own machine; Linux recommended ([`REPRODUCTION_GUIDE.md`](REPRODUCTION_GUIDE.md) §2).
- Synthetic data only; you generate every package yourself.
- Results Republika recorded are listed for comparison, not as evidence.
- Templates: [`INDEPENDENCE_DECLARATION_TEMPLATE.md`](INDEPENDENCE_DECLARATION_TEMPLATE.md),
  [`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md).
- How your report will be judged complete: [`REVIEW_ACCEPTANCE_CRITERIA.md`](REVIEW_ACCEPTANCE_CRITERIA.md) §1.
  An unfavourable conclusion is a complete review.

**FINAL COMMERCIAL DECISION: NO-GO.**
