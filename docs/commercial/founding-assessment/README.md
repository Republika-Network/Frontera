# Republika Sovereignty Founding Assessment — Commercial Readiness Pack (ASSURE-REL-01E)

> **STATUS: DRAFT — FOR FOUNDER REVIEW ONLY. NOT A COMMERCIAL AUTHORIZATION.**
>
> Nothing in this directory authorizes selling, deploying, onboarding a
> customer, handling real customer data or starting a paid assessment.
> `rn.sv@0.1.0` keeps `metadata.commercialUse.status: 'restricted'`. The final
> commercial decision in [`ASSURE_COMMERCIAL_GO_NO_GO.md`](ASSURE_COMMERCIAL_GO_NO_GO.md)
> is **NO-GO** until every mandatory approval named there exists in writing.
>
> Legal, privacy, liability and tax wording in these drafts is placeholder text
> **subject to review by qualified professionals** in the relevant
> jurisdictions. No accreditation, approval or customer reference is claimed.

**Program:** Republika Network · **Product:** Frontera Continuous Sovereignty
Assurance · **Offer:** Republika Sovereignty Assessment · **Framework:**
`rn.sv@0.1.0` · **Baseline:** `origin/main` @ `5012246c` (ASSURE-REL-01D, #248)
· **Prepared:** 2026-11-01

## Contents

| # | Document | What it is | Status |
| --- | --- | --- | --- |
| 1 | [`COMMERCIAL_READINESS_ASSESSMENT.md`](COMMERCIAL_READINESS_ASSESSMENT.md) | The readiness assessment: baseline, REL-01D findings, validation results, residual risks, remediation backlog, founder decisions | DRAFT |
| 2 | [`FRAMEWORK_RESTRICTION_DISPOSITION.md`](FRAMEWORK_RESTRICTION_DISPOSITION.md) | The nine `commercialUse` blockers of `rn.sv@0.1.0`, each with evidence, technical closure vs policy authorization, and the versioning recommendation | DRAFT |
| 3 | [`SERVICE_SPECIFICATION.md`](SERVICE_SPECIFICATION.md) | Proposed Founding Assessment service definition | DRAFT — founder review |
| 4 | [`CUSTOMER_DATA_GOVERNANCE.md`](CUSTOMER_DATA_GOVERNANCE.md) | Minimum customer-data handling policy, each item marked *technical control* vs *proposed process* | DRAFT — privacy/legal review |
| 5 | [`OPERATOR_ROLES.md`](OPERATOR_ROLES.md) | Roles, separation of duties, mapping to authenticated capabilities | DRAFT |
| 6 | [`OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md) | Operator runbook, implemented vs planned steps | DRAFT |
| 7 | [`ASSURE_COMMERCIAL_GO_NO_GO.md`](ASSURE_COMMERCIAL_GO_NO_GO.md) | The launch gate. Final decision: **NO-GO** | DRAFT |
| 8 | [`drafts/`](drafts/) | Customer-facing document drafts A–J | DRAFT — professional review |
| 9 | [`governance/`](governance/GOVERNANCE_READINESS.md) | ASSURE-GOV-01: framework commercial authorization and independent assurance governance package | DRAFT — nothing approved |

### Customer-facing drafts (`drafts/`)

| Ref | Document |
| --- | --- |
| A | [`A_ONE_PAGE_OFFER.md`](drafts/A_ONE_PAGE_OFFER.md) |
| B | [`B_STATEMENT_OF_WORK.md`](drafts/B_STATEMENT_OF_WORK.md) |
| C | [`C_EVIDENCE_SUBMISSION_GUIDELINES.md`](drafts/C_EVIDENCE_SUBMISSION_GUIDELINES.md) |
| D | [`D_CONFIDENTIALITY_DATA_HANDLING_ADDENDUM.md`](drafts/D_CONFIDENTIALITY_DATA_HANDLING_ADDENDUM.md) |
| E | [`E_CUSTOMER_RESPONSIBILITIES_AUTHORIZATION.md`](drafts/E_CUSTOMER_RESPONSIBILITIES_AUTHORIZATION.md) |
| F | [`F_DELIVERABLES_ACCEPTANCE_CHECKLIST.md`](drafts/F_DELIVERABLES_ACCEPTANCE_CHECKLIST.md) |
| G | [`G_LIMITATIONS_NON_CERTIFICATION_NOTICE.md`](drafts/G_LIMITATIONS_NON_CERTIFICATION_NOTICE.md) |
| H | [`H_CUSTOMER_HANDOFF_VERIFICATION.md`](drafts/H_CUSTOMER_HANDOFF_VERIFICATION.md) |
| I | [`I_ENGAGEMENT_CLOSEOUT_DELETION.md`](drafts/I_ENGAGEMENT_CLOSEOUT_DELETION.md) |
| J | [`J_PRICING_PACKAGING_WORKSHEET.md`](drafts/J_PRICING_PACKAGING_WORKSHEET.md) |

## Relationship to existing documents

This pack **references** and does not restate the technical documents. When
they disagree, the code and the technical documents win; raise the
discrepancy.

| Topic | Authoritative source |
| --- | --- |
| Framework definition, golden digest | `src/enterprise/assurance/frameworks/rn-sv-framework.ts`, `src/enterprise/__tests__/assurance-rn-sv-framework.test.ts` |
| Commercial report, disclosure model, integrity | [`docs/enterprise/AOC_ASSURANCE_COMMERCIAL_REPORT.md`](../../enterprise/AOC_ASSURANCE_COMMERCIAL_REPORT.md) |
| Dry run and findings F01–F04 | [`docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md`](../../enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md) |
| Security closures | `docs/security/ASSURE-SEC-01B…01E`, `docs/security/ASSURE-REL-01A…01D` |
| Host operator interface | [`docs/security/ASSURE-REL-01D-OPERATOR-INTERFACE.md`](../../security/ASSURE-REL-01D-OPERATOR-INTERFACE.md) |
| Backup / restore | [`docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`](../../operations/AOC_ENTERPRISE_BACKUP_V1.md), [`docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`](../../operations/AOC_ENTERPRISE_RESTORE_V1.md) |
| Generic Frontera pilot operations (not Assurance-specific) | [`docs/pilot/README.md`](../../pilot/README.md) |
| Customer-claim integrity, report review disclosure (generator v3) | [`docs/security/ASSURE-CLAIMS-01-REPORT-DISCLOSURE-INTEGRITY.md`](../../security/ASSURE-CLAIMS-01-REPORT-DISCLOSURE-INTEGRITY.md) |

## How this pack becomes non-draft

Each document changes from DRAFT only by a reviewed PR that records, in the
document itself, the approver, the date and the approval artifact. The
procedure is in [`ASSURE_COMMERCIAL_GO_NO_GO.md`](ASSURE_COMMERCIAL_GO_NO_GO.md) §4.
