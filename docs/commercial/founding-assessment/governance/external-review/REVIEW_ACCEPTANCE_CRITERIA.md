# Review Acceptance Criteria — When a Delivered R1 Review Counts (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — PROPOSED criteria.**
> Nothing has been delivered or accepted. Adoption is part of founder decision
> D-02. These criteria refine [`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) §12;
> where they conflict, the protocol governs until FDR records otherwise.

Two questions are kept apart:

1. **Is the deliverable a complete, valid review?** (§1) — a question of form,
   independence and evidence. An unfavourable review can be complete.
2. **Is R1 satisfied as a prerequisite for authorization?** (§2) — a question of
   the review's content.

## 1. Deliverable acceptance (validity)

The deliverable is **valid** only if all of the following hold. FDR checks
them and records the result; GOV may check them independently.

| # | Criterion | Check |
| --- | --- | --- |
| V1 | The reviewer is a real, named natural person; the review was not produced or signed by an AI system | Independence declaration Part A, C7 |
| V2 | The independence declaration is signed, dated before access, and every disclosed exception was decided by FDR in writing | Declaration Parts F–G |
| V3 | The fee was fixed and not contingent on outcome | Engagement letter |
| V4 | The report names the pinned commit and framework digest, and they match the engagement letter | Report §1 |
| V5 | The reproduction log covers at least the protocol §8 minimum: golden digest; REL-01A `A10 KNOWN LIMITATION`; PILOT-01 F01 offline test; REL-01D Host pilot P01; the offline verifier verdict | Report §3 |
| V6 | Every finding cites a file:line, test name, or reproduced command output | Report §4–§5 |
| V7 | The focus question and the five per-area opinions are answered explicitly | Report §8.1–§8.2 |
| V8 | The six `rn.sv@0.2.0` questions are answered (an answer may be "no opinion", with reasons) | Report §8.3 |
| V9 | The report states what was not examined | Report §8.4 |
| V10 | The report is signed and dated by the reviewer; Republika made no edit other than the reviewer's own changes after a factual-accuracy check | Report §8.6; correspondence |
| V11 | The signed original is stored off-repo and its SHA-256 recorded | Findings template §9.1 |

A deliverable failing any of V1–V11 is **returned** to the reviewer with the
specific gap. It is not "partially accepted". A failure of V1, V2 or V3 is not
curable by the same reviewer for this engagement.

## 2. R1 satisfied (as a prerequisite)

As protocol §12, made explicit:

| Outcome | Condition | Consequence |
| --- | --- | --- |
| **R1 satisfied** | Valid deliverable; no open Critical security finding; no open Major methodology nonconformity; every High fixed, or accepted by SEC + FDR with the reviewer's stated concurrence; the opinions on "security residuals" and "B7 Option A" are *No objection* or *No objection with conditions* | Conditions become authorization conditions in the approval record. D-01.1 and D-03 may then be decided |
| **R1 satisfied with follow-up** | As above, but with Minor nonconformities or Medium findings whose treatment plan has a date | Same, plus remediation verification by the reviewer before the date |
| **R1 not satisfied** | Any *Objection*; an open Critical or Major; a High neither fixed nor concurred; a reproduction failure the reviewer could not explain | Remediate; then a follow-up review by the same or another qualified, independent reviewer |
| **R1 refused** | Invalid deliverable (§1) not cured; independence exception refused | A new reviewer is selected |

**What R1 satisfied does not do.** It does not authorize commercial use, accept
any risk, create `rn.sv@0.2.0`, approve customer wording (LEG), or replace R2
for the first engagement. It is one input among M1–M6
([`../../ASSURE_COMMERCIAL_GO_NO_GO.md`](../../ASSURE_COMMERCIAL_GO_NO_GO.md) §3).

## 3. Remediation verification

- The reviewer verifies remediation of each Critical, High and Major finding,
  by the method they stated in the report.
- Verification is recorded by the reviewer (dated, signed note or e-mail
  quoted verbatim) and referenced in the tracker; engineering never self-closes
  ([`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md) §9.4).
- A remediation that changes the framework, generator, custody or verifier
  code also triggers the R3 conditions of protocol §12.

## 4. Withdrawal and invalidation

The review stops counting (and any authorization relying on it is suspended,
[`../COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](../COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §5) if:
the reviewer withdraws or qualifies the opinion; an undisclosed conflict is
found; Republika is found to have altered the report; the pinned commit is not
the one deployed for the engagement; or 12 months pass without R3.

## 5. Customer-facing use of the review

None by default. Any mention of the review to a customer or third party needs
(a) the reviewer's written consent to the exact wording, (b) LEG approval
([`../CUSTOMER_CLAIMS_REVIEW.md`](../CUSTOMER_CLAIMS_REVIEW.md) L2), and (c) a
statement of what the review covered and that it was not an audit,
certification or attestation.

**FINAL COMMERCIAL DECISION: NO-GO.**
