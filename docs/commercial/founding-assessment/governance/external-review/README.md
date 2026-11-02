# External Review Handoff Package — `rn.sv@0.1.0` and the Founding Assessment (ASSURE-GOV-02)

> **FINAL COMMERCIAL DECISION: NO-GO.**
>
> **STATUS: DRAFT — handoff package, not a review.** This directory prepares
> the work for a qualified human reviewer who is independent of the
> engineering implementation. **No reviewer has been identified, contacted,
> engaged, briefed or paid. No review has been performed. No finding, opinion,
> approval, audit, attestation or certification exists.** Every reviewer field
> in these templates is intentionally blank.
>
> It was prepared by an AI engineering agent at the founder's instruction. An
> AI agent cannot be the reviewer, and nothing an AI agent reproduces is
> independent validation ([`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) §3.7).
> `rn.sv@0.1.0` keeps `commercialUse: restricted`. `rn.sv@0.2.0` does not
> exist and is not created here. Labels: VERIFIED · PROPOSED · PENDING ·
> BLOCKED ([`../GOVERNANCE_READINESS.md`](../GOVERNANCE_READINESS.md)).

## Baseline

| Item | Value | Status |
| --- | --- | --- |
| Repository | `Republika-Network/Frontera` | VERIFIED |
| Baseline commit | `48b90d734dd0c6b884ce2be3c0d398536353fafb` — ASSURE-CLAIMS-01 (#256), 2026-11-02 | VERIFIED (`git merge-base --is-ancestor`; `origin/main` equal to it when branching) |
| Changes on `origin/main` since #256 | None | VERIFIED |
| Open PRs overlapping Assurance | None (#164, #141, #96 are unrelated feature work) | VERIFIED |
| Branch | `docs/assure-gov-02-independent-review-handoff` | VERIFIED |
| Framework | `rn.sv@0.1.0`, golden digest `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58`, `commercialUse.status: 'restricted'` | VERIFIED (test run) |
| Report generator (current) | `aoc.assurance.commercial-report.v3`; v1 and v2 kept for historical reports | VERIFIED (code reading, test run) |

The engagement letter pins the commit actually reviewed. If it differs from
this baseline, [`REVIEW_EVIDENCE_INDEX.md`](REVIEW_EVIDENCE_INDEX.md) §1 must be re-verified
against it before the reviewer starts.

## Contents

| # | Document | Audience | Purpose |
| --- | --- | --- | --- |
| 1 | `README.md` (this) | All | Baseline, contents, how the package fits the governance layers |
| 2 | [`REVIEWER_STATEMENT_OF_WORK.md`](REVIEWER_STATEMENT_OF_WORK.md) | Reviewer, FDR, LEG | Scope, objectives, method, deliverables, effort estimate, sign-off |
| 3 | [`REVIEWER_SELECTION_SCORECARD.md`](REVIEWER_SELECTION_SCORECARD.md) | FDR | How to choose a qualified reviewer; independence gates |
| 4 | [`REVIEWER_BRIEFING.md`](REVIEWER_BRIEFING.md) | Reviewer | Short orientation: what the system is, what to look at first, the focus question |
| 5 | [`REVIEW_EVIDENCE_INDEX.md`](REVIEW_EVIDENCE_INDEX.md) | Reviewer | The evidence bundle at the pinned commit; supersedes the GOV-01 index where they differ |
| 6 | [`REPRODUCTION_GUIDE.md`](REPRODUCTION_GUIDE.md) | Reviewer | Commands, environment assumptions, expected results, Linux vs Windows |
| 7 | [`REVIEW_FINDINGS_TEMPLATE.md`](REVIEW_FINDINGS_TEMPLATE.md) | Reviewer; ENG for tracking | Blank findings and conclusion forms; how engineering tracks without rewriting |
| 8 | [`INDEPENDENCE_DECLARATION_TEMPLATE.md`](INDEPENDENCE_DECLARATION_TEMPLATE.md) | Reviewer, FDR | Blank identity, qualification and conflict-of-interest declaration |
| 9 | [`REVIEW_ACCEPTANCE_CRITERIA.md`](REVIEW_ACCEPTANCE_CRITERIA.md) | FDR, GOV | When a delivered review is accepted, refused or needs follow-up |
| 10 | [`REVIEWER_OUTREACH_DRAFT.md`](REVIEWER_OUTREACH_DRAFT.md) | FDR | Unsent outreach email draft. **Not sent** |
| 11 | [`FOUNDER_ACTIONS.md`](FOUNDER_ACTIONS.md) | FDR | Human decisions and actions required before a reviewer can start |

## How this package relates to the existing governance

This package **operationalizes** [`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md)
(stages R1/R2/R3, independence §3, qualifications §4, severity §9, report
format §11, approval criteria §12). Where the protocol already says something,
these documents link to it and do not restate it. The protocol itself is
PROPOSED; its adoption is founder decision D-02
([`../FOUNDER_DECISION_RECORD.md`](../FOUNDER_DECISION_RECORD.md)).

| Governance layer ([`../GOVERNANCE_READINESS.md`](../GOVERNANCE_READINESS.md) §2) | Effect of this package |
| --- | --- |
| L1 Technical implementation | None. No code changes |
| L2 Independent validation | Prepares it. Still **BLOCKED**: no reviewer exists |
| L3 Security risk acceptance | None. All SR-xx acceptances stay PENDING |
| L4 Framework governance | None. D-01 PENDING; `rn.sv@0.2.0` not created |
| L5 Legal and operational approvals | None. LEG review of this SOW and the outreach is a founder action |
| L6 Commercial authorization | None. **NO-GO** |

## What this package changes

- Adds this directory only, plus one index row in
  [`../../README.md`](../../README.md).
- Does **not** edit the framework, the report generator, the verifier, any
  test, any historical fixture, any customer-facing draft, or any GOV-01 or
  CLAIMS-01 record. Drift found between the GOV-01 evidence index and the
  current code is recorded in [`REVIEW_EVIDENCE_INDEX.md`](REVIEW_EVIDENCE_INDEX.md) §7,
  not silently fixed in the older document.

## Rules that apply to every document here

1. No reviewer identity, credential, approval, finding or conclusion is
   written by Republika or by an AI agent. Those fields are filled only by the
   reviewer (or, for acceptance, by FDR) on the signed original.
2. No communication is sent to any candidate without the founder's explicit
   approval ([`FOUNDER_ACTIONS.md`](FOUNDER_ACTIONS.md) A-05).
3. Synthetic data only. No customer data, bearer secret, private key, backup
   key or unredacted engagement configuration is part of the bundle.
4. All documents remain DRAFT until reviewed and authorized by the named role
   holders. An authorization is valid only as a record under
   [`../COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](../COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §4.

**FINAL COMMERCIAL DECISION: NO-GO.**
