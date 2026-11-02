# Reviewer Selection Scorecard (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — blank scorecard.**
> **No candidate has been identified, contacted, evaluated, engaged or hired.**
> No candidate names appear in this repository; completed scorecards are kept
> off-repo by FDR (they contain personal data). Weights are PROPOSED for FDR to
> confirm. Qualifications baseline: [`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) §4.

## 1. Gate criteria (pass / fail — any fail excludes the candidate)

Scored **before** any qualification scoring, so that a strong candidate with a
conflict is not rationalized in.

| # | Gate | Evidence FDR checks | Pass / Fail |
| --- | --- | --- | --- |
| G1 | Natural person able to sign in their own name; not an AI system | Identity | |
| G2 | Meets protocol §3 independence criteria C1–C7, or every exception is minor, disclosed and would be accepted by FDR in writing | Draft independence declaration | |
| G3 | Accepts a fixed fee not contingent on outcome | Proposal | |
| G4 | Accepts that Republika cannot edit the report and that publication needs their consent | Proposal / call | |
| G5 | Can build and run a Node.js / TypeScript project and its tests on their own machine | Self-statement; may be tested in WP1 | |
| G6 | Will sign an NDA and accept the access boundaries (SOW §16) | Proposal | |
| G7 | Available within the founder's window (D-02) | Proposal | |

## 2. Qualification scoring

Score each dimension 0–3: **0** none · **1** some exposure · **2** demonstrated
professional experience · **3** recognized depth (led comparable work, can
cite engagements). Multiply by weight.

| # | Dimension | What "3" looks like | Weight | Score (0–3) | Weighted |
| --- | --- | --- | --- | --- | --- |
| Q1 | Software security architecture | Has led architecture/security reviews of server applications with persistent stores and HTTP APIs | 3 | | |
| Q2 | Identity and authorization | Has assessed authentication models, bearer credentials, separation of duties and least privilege | 3 | | |
| Q3 | Cryptographic authenticity | Can evaluate signature, timestamp and anchoring options, key custody and revocation (B7) | 2 | | |
| Q4 | Audit or assurance methodology | Has designed or performed control assessments; understands sampling and evidence sufficiency | 3 | | |
| Q5 | Evidence governance | Has worked on chain of custody, evidence integrity, records retention | 2 | | |
| Q6 | Enterprise risk management | Can assess a risk register's severities and acceptance conditions | 1 | | |
| Q7 | AI-agent governance | Understands delegated authority, consent and revocation for automated agents (the subject of SV-01, SV-02, SV-08) | 1 | | |
| | **Maximum** | | **15** | | **/ 45** |

**PROPOSED threshold:** at least 30 / 45, with Q1 + Q2 ≥ 4 and Q4 ≥ 2. If one
person cannot meet it, engage two (security + methodology), each meeting the
gates and the threshold on their own dimensions.

## 3. Independence and conflict-of-interest red flags

Any of these needs FDR's written decision before proceeding (protocol §5):

- Prior paid or unpaid advice to Republika, its founders or its investors.
- Any equity, token, option or advisory-share arrangement with Republika.
- Current engagement with a direct competitor whose position depends on the outcome.
- Personal relationship with FDR or any operator.
- Introduction by someone with a financial interest in a favourable result
  (acceptable only if disclosed and the reviewer otherwise passes G2).
- Proposal to use AI tools on non-public material, or to have the report
  drafted by AI.
- Unwillingness to state what they did not examine.

## 4. Process (PROPOSED)

1. FDR approves this scorecard and the SOW (A-01, A-02 in [`FOUNDER_ACTIONS.md`](FOUNDER_ACTIONS.md)).
2. FDR builds a long list off-repo (sources are FDR's choice).
3. FDR approves the outreach text and each recipient (A-05). **Nothing is sent before that.**
4. Interested candidates receive [`REVIEWER_BRIEFING.md`](REVIEWER_BRIEFING.md) (public, synthetic content only) and a draft independence declaration.
5. Gate check (§1), then qualification scoring (§2), recorded off-repo.
6. FDR selects; LEG prepares engagement letter and NDA; reviewer signs the declaration; access is granted.
7. The repository records only: "Reviewer engaged on `<date>`; declaration reference and SHA-256 `<…>`" — added by FDR, not by an AI agent.

## 5. Blank scorecard record (completed off-repo)

```text
Candidate reference (not a name in this repo):  ____________
Gates G1–G7:      __ __ __ __ __ __ __
Q1–Q7 scores:     __ __ __ __ __ __ __      Weighted total: ____ / 45
Red flags noted:  ______________________________
Decision (proceed / reject / hold) and reason:  ______________________
Scored by (FDR):  ____________   Date: ________
```

**FINAL COMMERCIAL DECISION: NO-GO.**
