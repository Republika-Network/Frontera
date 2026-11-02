# Reviewer Statement of Work — R1 System and Methodology Review (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — PROPOSED terms, not
> an offer and not a contract.** No reviewer is named; no engagement exists.
> The legal form (engagement letter, NDA, liability, governing law, fee) is for
> counsel (LEG) and the founder (FDR). Effort figures are **estimates, not
> commitments**. Labels: VERIFIED · PROPOSED · PENDING · BLOCKED.

| Field | Value |
| --- | --- |
| Client | Republika Network (contracting entity: **to be confirmed by FDR/LEG — D-09**) |
| Reviewer | `____________________` (real, named, qualified person; filled at engagement) |
| Stage | R1 — system and methodology review ([`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) §2) |
| Pinned commit | `____________________` (proposed: `48b90d734dd0c6b884ce2be3c0d398536353fafb`) |
| Framework digest under review | `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58` (`rn.sv@0.1.0`) |
| Candidate successor reviewed (methodology only) | [`../RN_SV_0_2_0_CANDIDATE_SPEC.md`](../RN_SV_0_2_0_CANDIDATE_SPEC.md) — a document; **no `rn.sv@0.2.0` code or digest exists** |
| Fee basis | Fixed fee, not contingent on outcome (protocol §3.4). Amount: `________` |

## 1. Scope and objectives

**Objective.** Give Republika's founder a written, signed, evidence-cited
opinion on whether the `rn.sv@0.1.0` framework, the Founding Assessment
methodology built on it, and the Frontera Assurance implementation that runs it
are coherent, honestly described and defensible for a **single, private,
internal-use founding engagement**, and what must change before that or before
any wider use.

**The focus question** (answer explicitly in the report):

> *Are the ten controls, their evidence requirements, scoring and limitations
> sufficiently coherent and defensible for the proposed Founding Assessment
> service?*

**In scope:** the areas in §2–§9 below, at the pinned commit, on synthetic data.

**Out of scope:** any real customer engagement (that is R2); legal advice
(LEG); a professional assurance or attestation engagement under any standard
(protocol §1); penetration testing of a deployed Host (none exists); pricing
and commercial terms; code changes. The reviewer may *recommend* any change;
Republika decides and implements.

**This engagement does not authorize anything.** A favourable opinion is an
input to founder decisions D-01, D-02 and D-03 and to risk acceptance (M2). It
is not itself an approval.

## 2. Framework methodology

Review `src/enterprise/assurance/frameworks/rn-sv-framework.ts` (the frozen
definition, including `metadata.controlProfiles`, `reviewOutcomeSemantics`,
`missingEvidenceTreatment`, `manualReviewCondition`) and
[`../../SERVICE_SPECIFICATION.md`](../../SERVICE_SPECIFICATION.md). Assess:

1. Whether each control's objective, questions, evidence requirement, outcome
   conditions, limitations and revalidation criterion are clear, testable from
   documentary evidence, and free of hidden assumptions (protocol §7.2.1).
2. Whether "digital-sovereignty posture" is a defensible name for what the ten
   controls measure, and what the measure does **not** cover (SR-11).
3. Whether a human reviewer applying the profiles to the same evidence would
   reach reproducible conclusions (inter-reviewer consistency risk).

## 3. Ten controls and scoring

| Domain (weight) | Controls | Blocking |
| --- | --- | --- |
| `rn.sv.authority` (0.3) | SV-01 Actor identity and authority · SV-02 Consent and revocation · SV-08 Effective revocation of authority | SV-08 |
| `rn.sv.policy-governance` (0.2) | SV-03 Policy compliance · SV-10 Governance and accountability | — |
| `rn.sv.evidence-traceability` (0.2) | SV-04 Evidence integrity · SV-05 Execution traceability | — |
| `rn.sv.data-boundaries` (0.2) | SV-06 Isolation between organizations · SV-07 Minimal disclosure | SV-06 |
| `rn.sv.remediation` (0.1) | SV-09 Remediation and revalidation | — |

Scoring (`rn.sv.scoring@0.1.0`): pass = 1, partial = 0.5, fail = 0;
`unknownPolicy: 'zero'`, `manualReviewPolicy: 'zero'`,
`blockingRule: 'domain_override'`; implementation in
`src/enterprise/assurance/scoring.ts`. VERIFIED by code reading at baseline.

Assess: whether the weights are justified or should be presented as
unvalidated (they are not externally validated — service spec §10); whether
the score's meaning is stated honestly in the report; and the specific
questions in [`REVIEWER_BRIEFING.md`](REVIEWER_BRIEFING.md) §4 (scoring
questions Q-S1…Q-S3), which are questions for the reviewer, not findings.

## 4. Evidence trust and limitations

Manual evidence is identified by digest and judged by a reviewer; it is never
authenticated (B1, SR-01). Assess whether the "reviewed-evidence, not
verified-evidence" disclosure is adequate; whether the evidence binding
(B8, B9) and the R2 sampling procedure (protocol §7.3) are reasonable per
control; and whether any control's requirement implies verification the
product cannot perform (for example SV-08's witnessed test).

## 5. Reviewer authentication and separation of duties

Static bearer credentials bind reviewer identity and role; separation of duties
holds per credential, not per person (B3, SR-02). Assess the credential model
for a private-network pilot, the credential-register procedure
([`../../OPERATOR_ROLES.md`](../../OPERATOR_ROLES.md) §4), preflight E11/E12, and
whether R-03 (passkey-bound approval, rate limiting) should precede the first
engagement.

## 6. Customer report disclosures

Assess the generator v3 disclosures
(`src/enterprise/assurance/commercial-report-format.ts`,
`DISCLOSURE_WORDING_V3`) and the customer-facing drafts listed in
[`../CUSTOMER_CLAIMS_REVIEW.md`](../CUSTOMER_CLAIMS_REVIEW.md) §7, **from a
methodology standpoint** (does the text say what the system does and no
more?). Legal adequacy is LEG's, not the reviewer's.

## 7. Release integrity and authenticity limitations

Assess [`../B7_AUTHENTICITY_OPTIONS.md`](../B7_AUTHENTICITY_OPTIONS.md). State
whether Option A's conditions (A-1…A-5) are adequate for one private,
internal-use pilot, or name what is missing. Assess A10 (issuer-controlled
custody can be rewritten coherently by its administrator; SR-04). Both are
**OPEN / residual** and reproduced by tests; they are not closed.

## 8. Data protection and operating assumptions

Assess, as security architecture (not legal compliance): engagement isolation,
encryption preflight E13, sealed backups and cross-customer restore refusal
(`scripts/assurance/engagement-ops.mjs`; OPS-02 record), the one-Host-per-
customer model (D-08), and the operating assumptions in
[`../../CUSTOMER_DATA_GOVERNANCE.md`](../../CUSTOMER_DATA_GOVERNANCE.md). Note
its known internal inconsistency (GF-04). **No engagement Host exists**; E13 has
only been run on a development machine, which reports `NOT_ENCRYPTED`.

## 9. Historical compatibility

Assess whether the generator-versioning approach (v1 → v2 → v3, additive;
historical fixtures byte-identical; historical wording labelled by the
verifier, not rewritten) is sound, and whether historical v1/v2 wording
(GF-01) requires any customer-facing correction if a real v1/v2 package were
ever delivered (CLAIMS-01 residual R-C1).

## 10. Expected findings format

Use [`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md). Every finding
cites a file and line, a test name, or a command the reviewer ran with its
output (protocol §8). Results recorded by Republika are not accepted as
evidence without the reviewer's own reproduction.

## 11. Severity classification

Use protocol §9 (Critical / High / Medium / Low-Informational) for security
findings. For methodology, use **Major nonconformity** (a control, scoring
rule or disclosure that would make a customer-facing conclusion misleading or
indefensible) and **Minor nonconformity** (a weakness that does not by itself
make a conclusion misleading). Observations and opportunities for improvement
are recorded separately and carry no severity.

## 12. Required remediation recommendations

For each Critical, High or Major finding the reviewer states a recommendation:
what would have to be true for the finding to be closed, and how the reviewer
would verify it (re-test, code reading, document change). The reviewer does not
decide risk treatment; treatment (accept / mitigate / defer / reject) is the
risk approver's decision (protocol §9).

## 13. Acceptance criteria

See [`REVIEW_ACCEPTANCE_CRITERIA.md`](REVIEW_ACCEPTANCE_CRITERIA.md). In short:
the deliverable is *accepted as a complete review* if it meets the form and
evidence requirements, whatever its conclusion. Acceptance of the deliverable
never means Republika agrees, and an unfavourable conclusion is an acceptable
deliverable.

## 14. Independence and conflicts of interest

The protocol §3 criteria apply. The reviewer completes
[`INDEPENDENCE_DECLARATION_TEMPLATE.md`](INDEPENDENCE_DECLARATION_TEMPLATE.md)
before access is granted, and updates it if anything changes during the
engagement. FDR accepts or refuses disclosed exceptions in writing.

## 15. Confidentiality requirements

- Mutual NDA before source access (form: LEG).
- The reviewer may retain working papers and the signed report; Republika
  receives the signed report and the reproduction log.
- The reviewer's report is **not** published or shown to customers without the
  reviewer's written consent to the exact use and wording (protects the
  reviewer from misrepresentation and Republika from overclaiming — SR-05,
  [`../CUSTOMER_CLAIMS_REVIEW.md`](../CUSTOMER_CLAIMS_REVIEW.md) L2).
- No customer data is in scope for R1.

## 16. Access boundaries

| Granted | Not granted |
| --- | --- |
| Read access to `Republika-Network/Frontera` at the pinned commit | Write access to any Republika repository, branch or CI |
| The documents in this directory and those they link | Any production, engagement or operator credential |
| Synthetic packages the reviewer generates locally | Any customer evidence, store, backup or backup key |
| Interviews with FDR and engineering (notes kept by the reviewer) | Any Republika machine (the reviewer uses their own) |
| AI tools of the reviewer's choice on the **public/synthetic** material only, under protocol §6 | Use of AI tools to author the opinion or sign; the reviewer remains responsible for every statement |

## 17. Expected effort range (ESTIMATE, not a commitment)

| Work package | Estimate (reviewer days) | Basis |
| --- | --- | --- |
| WP1 Onboarding, environment, reproduction (§4 of the evidence index) | 1–2 | ~15 suites plus verifier; bounded commands |
| WP2 Security architecture and residuals (§4, §5, §7, §8) | 2–4 | B1–B9, A10, credentials, custody, backups |
| WP3 Methodology: ten controls, scoring, disclosures (§2, §3, §6) | 2–4 | Framework and service spec reading; scoring questions |
| WP4 Candidate `rn.sv@0.2.0` questions (Phase 7 of the briefing) | 0.5–1 | Document review only |
| WP5 Report drafting, factual-accuracy check, signature | 1–2 | Template provided |
| **Total** | **6.5–13 days** | ASSUMPTION: one reviewer covering both roles; two reviewers increase total effort but may shorten elapsed time |

These figures are an engineering estimate made without consulting any reviewer.
They are not a quote, a budget or a commitment by either party.

## 18. Deliverables and sign-off conditions

| # | Deliverable | Form |
| --- | --- | --- |
| D1 | Signed independence declaration | [`INDEPENDENCE_DECLARATION_TEMPLATE.md`](INDEPENDENCE_DECLARATION_TEMPLATE.md), before access |
| D2 | Reproduction log | Commands, commit, OS, Node version, outputs (protocol §8) |
| D3 | R1 report | Protocol §11 structure; findings per [`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md); explicit answer to the focus question and to the `rn.sv@0.2.0` questions |
| D4 | Sign-off record | Protocol §13, signed and dated by the reviewer |
| D5 | Follow-up statement | What would trigger re-review (R3) and which findings need remediation verification |

**Sign-off conditions.** The reviewer signs only what they performed. A
factual-accuracy check by Republika is permitted (Republika may point out a
factual error; the reviewer decides whether to change anything). Republika may
not edit, summarize in a way that changes meaning, or condition payment on the
report's content. The signed original is stored off-repo; the repository holds
only its reference and SHA-256 digest
([`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md) §9).

**FINAL COMMERCIAL DECISION: NO-GO.**
