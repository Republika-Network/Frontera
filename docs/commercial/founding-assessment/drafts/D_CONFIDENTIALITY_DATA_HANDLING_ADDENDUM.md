# [DRAFT D] Confidentiality and Data-Handling Addendum

> **DRAFT — SUBJECT TO QUALIFIED LEGAL AND PRIVACY REVIEW** in each relevant
> jurisdiction. It is not a data-processing agreement until counsel makes it
> one. Retention values are proposals requiring approval (D-04). Bracketed
> text is a placeholder.

## 1. Definitions

"Evidence": material the Customer supplies for the Assessment. "Assessment
Records": the assessment, evidence references and digests, reviews, findings
and release records kept by Republika. "Report": the delivery package.

## 2. Confidentiality

Each party keeps the other's confidential information confidential, uses it
only for the Assessment, and limits access to personnel who need it and are
bound by written confidentiality obligations. [Standard exceptions and term —
counsel.]

## 3. Roles under data-protection law

[Counsel to determine whether Republika acts as processor/service provider or
as an independent controller for each category, and the applicable legal
basis.]

## 4. Data minimization

The Customer supplies only Evidence that meets the Evidence Submission
Guidelines (Draft C). Republika may refuse, and will delete, Evidence outside
them.

## 5. Security measures (as implemented or committed)

Implemented by the product (verifiable in Republika's documentation):

- Each customer is served by a dedicated Host serving only its organization;
  access to another organization's records is refused.
- Every operator is individually authenticated; reviewer and release
  approver are separate credentials, and a reviewer cannot approve.
- Delivered reports exclude reviewer rationale, evidence locations and
  metadata by design.
- Operator logs exclude evidence, rationale, report content and secrets.

Committed by process (not enforced by software):

- Storage on encrypted volumes and encrypted backups [D-05].
- No public network exposure of the assessment Host.
- Different individuals for review and approval.
- No Customer Evidence or Report content is entered into tools not on the
  subprocessor list.

## 6. Storage location and subprocessors

Location: [D-05]. Subprocessors: [list — D-05]. Changes are notified [N days]
in advance.

## 7. Cross-border transfers

[Counsel.]

## 8. Retention and deletion (proposed values)

| Data | Retention |
| --- | --- |
| Evidence copies held by Republika (if any) | Deleted within [30] days of acceptance |
| Assessment Records | [Engagement + 3 years] to support verification and defend conclusions |
| Backups | Same as the Assessment Records; destroyed with them |
| Operator logs | [1 year] |

Because Assessment Records are integrity-protected and cannot be edited, deletion
is by destroying the Customer's dedicated store and all its backups. After
that, Republika can no longer confirm a Report's authenticity.

## 9. Incidents

Republika notifies the Customer of a security incident affecting Customer
data within [N hours] of becoming aware of it, and cooperates on regulator
and individual notifications. [Counsel.]

## 10. Return and certification

On request at closeout, Republika certifies deletion (Draft I).

## 11. Audit

[Counsel: the Customer's right to information about these measures.]
