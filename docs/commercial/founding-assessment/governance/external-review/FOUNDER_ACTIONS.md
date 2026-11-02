# Founder Actions — Before an External Reviewer Can Start (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — every action is
> PENDING.** None of these has been taken. Each requires a human decision that
> engineering and AI agents cannot make. Decision IDs D-xx refer to
> [`../FOUNDER_DECISION_RECORD.md`](../FOUNDER_DECISION_RECORD.md). Roles:
> FDR founder · GOV governance · SEC security · LEG counsel · OPS operations.

## 1. Gaps preventing a reviewer from starting today

| # | Gap | Blocks | Closed by |
| --- | --- | --- | --- |
| GAP-1 | D-02 not decided: no adopted protocol, no decision that an external reviewer will be used | Everything below | A-01 |
| GAP-2 | No reviewer identified, no budget for a fixed fee | Selection, engagement | A-03, A-04 |
| GAP-3 | No contracting entity confirmed (D-09); no engagement-letter or NDA form | Engagement | A-06 |
| GAP-4 | Repository access model for an outside person not decided (the repository may be private) | Reproduction | A-07 |
| GAP-5 | Outreach text and briefing not approved for external use | Contact | A-05 |
| GAP-6 | No GOV, SEC or LEG role holder named — the reviewer has no counterpart for findings or risk treatment | Finding treatment (not the start of review) | A-08 |
| GAP-7 | No SEC-01A design record (GF-05); `CUSTOMER_DATA_GOVERNANCE.md` inconsistent (GF-04) | Not blocking; adds reviewer effort | A-09 (optional) |

GAP-1 to GAP-5 prevent a start. GAP-6 and GAP-7 do not prevent a start, but
they delay what happens after the report.

## 2. Actions

| ID | Action | Who | Depends on | Output (record) | Status |
| --- | --- | --- | --- | --- | --- |
| A-01 | Decide D-02 (who performs the controlled external review; R1 only or R1 + R2) and adopt or amend [`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) | FDR + GOV | — | D-02 decision block completed | PENDING |
| A-02 | Approve or amend [`REVIEWER_STATEMENT_OF_WORK.md`](REVIEWER_STATEMENT_OF_WORK.md), [`REVIEWER_SELECTION_SCORECARD.md`](REVIEWER_SELECTION_SCORECARD.md) and [`REVIEW_ACCEPTANCE_CRITERIA.md`](REVIEW_ACCEPTANCE_CRITERIA.md) | FDR | A-01 | Approval note referencing the commit of these files | PENDING |
| A-03 | Set a budget range for a fixed-fee R1 (the SOW estimate is 6.5–13 reviewer-days; no rate has been researched) | FDR | A-02 | Budget note (off-repo) | PENDING |
| A-04 | Build a candidate long list (sources are FDR's choice) | FDR | A-02 | Off-repo list; no names in the repository | PENDING |
| A-05 | Approve the outreach text, the briefing for external sharing, and **each recipient** before anything is sent | FDR (LEG on NDA timing) | A-02, A-04 | Explicit written approval per recipient | PENDING |
| A-06 | Confirm contracting entity (D-09); instruct LEG to prepare engagement letter and mutual NDA consistent with SOW §15–§16 | FDR + LEG | A-02 | Engagement letter and NDA forms | PENDING — no counsel engaged |
| A-07 | Decide reviewer repository access: time-limited read-only access to the pinned commit, or a source archive of the pinned commit with its SHA-256 | FDR + SEC | A-06 | Access record (who, what, until when) | PENDING |
| A-08 | Name GOV and SEC role holders (SEC ≠ OPS, per SR-04) to receive findings and decide risk treatment | FDR | — | Role register (`../../OPERATOR_ROLES.md` §4) | PENDING |
| A-09 | (Optional, reduces reviewer effort) Commission a short SEC-01A design record (GF-05) and the GF-04 policy correction | FDR → ENG / LEG + OPS | — | Separate missions | PENDING |
| A-10 | Pin the commit for the engagement letter. If newer than `48b90d7`, have engineering re-verify [`REVIEW_EVIDENCE_INDEX.md`](REVIEW_EVIDENCE_INDEX.md) §1 and §7 first | FDR → ENG | A-06 | Pinned SHA in the engagement letter | PENDING |
| A-11 | After engagement: record "Reviewer engaged on `<date>`; declaration reference and SHA-256" in the repository (no other personal data) | FDR | Signed declaration | One-line record | BLOCKED |
| A-12 | On receipt of the report: check validity (acceptance criteria §1), store the signed original off-repo, record its SHA-256, and start the tracker | FDR | Report | Findings template §9.1 record | BLOCKED |

## 3. Decisions that are **not** part of this step

To prevent scope creep, these stay where they are:

- **D-01** (create / authorize `rn.sv@0.2.0`): after the methodology part of R1.
  This package does not create the successor.
- **D-03** (accept B7, A10, credential residuals): after the security part of R1.
- **D-04, D-05, D-08** (retention, custody model, Host isolation): LEG / OPS track.
- **M1–M6** and the commercial decision: **NO-GO** until the procedure in
  [`../COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](../COMMERCIAL_AUTHORIZATION_PROCEDURE.md) completes.

## 4. Minimum path to a started review

A-01 → A-02 → (A-03, A-04 in parallel) → A-05 → A-06 → A-07 → A-10 →
reviewer signs declaration → access granted → WP1 starts.

**FINAL COMMERCIAL DECISION: NO-GO.**
