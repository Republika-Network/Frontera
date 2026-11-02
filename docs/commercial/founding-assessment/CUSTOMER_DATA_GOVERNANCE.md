# Founding Assessment — Customer Information Governance (Minimum Policy)

> **STATUS: DRAFT — PROPOSED POLICY, NOT IMPLEMENTED ENFORCEMENT.**
> Subject to review by qualified privacy and legal counsel in each relevant
> jurisdiction. Retention periods are **proposed values requiring approval**.
>
> Each item says what is a **technical control** (the code enforces it today,
> with its source) and what is a **proposed process** (a human must do it; no
> code enforces it). A proposed process is not a control until it is approved,
> assigned to an owner and evidenced.

Legend: **[T]** technical control present on the baseline · **[P]** proposed
process only · **[GAP]** neither exists.

## What the Host stores for an assessment

Read from the code (`assurance-contract.ts`, `sqlite-assurance-store.ts`),
so that the policy applies to real data:

| Data | Where | Notes |
| --- | --- | --- |
| Assessment, scope declaration, results, findings, integrity digests | Assurance Store (`AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH`, SQLite) | Terminal assessments are immutable |
| Evidence **references**: `evidenceReferenceId`, `evidenceType`, `externalId`, `organizationId`, `subjectId`, `digest`, `version`, `occurredAt`, `collectedAt`, supplier claims, `provenance` (`sourceSystem`, `collectedBy`, `chainOfCustodyReference` …), free-form `metadata`, `requirementIds` | Assurance Store | **Not the artifacts.** `metadata`, `provenance.collectedBy` and `externalId` can carry personal data if the operator puts it there |
| Manual reviews: reviewer ID, outcome, **free-text rationale**, cited evidence | Assurance Store (append-only) | Rationale is never disclosed in the report, but it is stored |
| Commercial release records | `assurance_commercial_releases` (append-only, triggers refuse UPDATE and DELETE) | Holds approver ID |
| Operator audit lines | Host log (`enterprise.assurance.operator`: operator ID, operation, IDs, status, error code) | No token, body, evidence, rationale or report content (REL-01D §7, tested) |
| Evidence **artifacts** themselves | **Outside the Host — location undefined** | [GAP] see §8 |

## 1. Lawful authority to provide evidence

- [P] The customer signs an authorization to assess and an evidence
  attestation **before** any evidence is accepted (draft E). It states that
  the customer owns or is entitled to disclose each item, and that disclosure
  to Republika for this purpose is lawful, including any notices or consents
  owed to individuals and any third-party confidentiality obligations.
- [T] None. The Host cannot know whether evidence was lawfully provided.

## 2. Data ownership

- [P] The customer keeps ownership of its evidence and of the facts in the
  report. Republika owns its framework, methodology and report format.
  Licence for the customer to use the report internally (drafts B, D). Terms
  subject to legal review.
- [T] Evidence and assessments are bound to the organization that the
  credential serves (REL-01D tenant scope).

## 3. Confidentiality

- [P] Mutual confidentiality obligations (draft D). Operators work under a
  written confidentiality undertaking.
- [T] Report disclosure model: deny by default. Rationale, evidence metadata,
  locations, supplier identifiers, provenance and tenant identifiers are never
  in the report; risky declared text is withheld (`AOC_ASSURANCE_COMMERCIAL_REPORT.md` §4,
  REP-01 tests).
- [T] Logs carry no evidence, rationale, body or token (REL-01D §7, tested
  with planted markers).
- [T] Every operator response is `Cache-Control: no-store`.
- [GAP] **No encryption at rest** in the Assurance Store. The SQLite file is
  plaintext. Mitigation [P]: an encrypted volume on the Host, and
  encrypted backups.

## 4. Data minimization

- [P] Collect only what a control's evidence requirement needs. Prefer
  references and digests to copies. Prefer redacted samples (draft C).
- [P] Operators must not put personal data into `metadata`, `provenance` or
  review rationale. Use role descriptions, not names.
- [T] The evidence request has a closed field set and a bound of 500
  references per submission (REL-01D §7).

## 5. Allowed and disallowed evidence

- [P] Defined in draft C. Disallowed, at minimum: secrets and credentials;
  special-category personal data; payment card data; health data; personal
  data of individuals not needed for the control; any data the customer is not
  entitled to share; malware or executable content; production database
  exports.
- [T] Accepted types are limited to `external_artifact_reference` and
  `control_attestation` (framework). Declared text containing URLs, emails,
  credential-like tokens, IPs or instruction-like text is withheld from the
  report (report §4). This is a **second layer**, not a filter on stored data.

## 6. Personally identifiable information

- [P] Default: no PII in evidence. Where a control needs a sample of actions
  by people (SV-01, SV-02), the customer pseudonymizes the actors before
  submission.
- [P] **Reviewer and approver IDs appear verbatim in the report and release
  record.** They must be role-style identifiers, never emails or personal
  names (PILOT-01 §5).
- [T] ASSURE-OPS-01 (R-04): reviewer IDs must be safe public references (no
  email, phone-like digits, whitespace, markup, path or non-ASCII). Enforced
  at Host boot and by every authenticator. An unsafe ID already on a
  historical review is printed as `withheld-reviewer-<hash>` in new reports.
  [P] A well-formed personal name (`jane.doe`) cannot be detected: use
  role-style IDs.
- [P] Privacy notice to operators about the processing of their identifiers.
  Subject to legal review.

## 7. Credentials and secrets

- [T] Reviewer secrets are named by environment variable (`apiKeyEnv`). The
  governed-action file refuses inline secrets. Duplicate secrets across
  credentials refuse boot. Comparison is constant-time (SEC-01B, REL-01D §2).
- [P] **Customer credentials are never requested, accepted or stored.** Any
  received is deleted on discovery and treated as an incident (§12).
- [P] Operator secrets are held by exactly one person, in a password manager
  approved by the security lead, and never in chat, email or tickets. Rotation
  happens at engagement end and on any suspected exposure (runbook §2).

## 8. Storage location and access

- [P] Assurance Store and its backups: on the dedicated Host, on an encrypted
  volume, in a location chosen for the customer (decision D-05).
- [GAP] **Evidence artifacts have no defined store.** Proposal [P]: a
  per-engagement encrypted repository, access limited to the assigned
  reviewer(s), with an access log. Or, preferred, leave artifacts with the
  customer: the reviewer inspects them in a customer-controlled session and
  records only references and digests.
- [T] Network: the Host refuses a network bind without authentication
  (`HOST_UNAUTHENTICATED_NETWORK_BIND`). REL-01D requires loopback or private
  network operation.
- [P] OS and file access to the Host is limited to the custody administrator.

## 9. Organization isolation

- [T] One Host serves one organization. Foreign assessments and releases
  answer as absent (`404`). Foreign evidence is rejected per reference
  (`EVIDENCE_WRONG_TENANT`). A foreign package verifies as
  `RELEASE_NOT_IN_CUSTODY` (REL-01D §3, SEC-01D; tested).
- [P] **One dedicated Host and Assurance Store per customer.** This also makes
  deletion possible (§11), because the store has no per-record delete.

## 10. Retention periods (PROPOSED — require approval)

| Record | Proposed retention | Rationale | Approval |
| --- | --- | --- | --- |
| Evidence artifacts (if Republika holds copies) | Delete within **30 days** after report acceptance | Not needed once conclusions are recorded by digest | LEG + FDR |
| Assurance Store (assessment, references, reviews, release custody) | **Engagement + 3 years**, or the period required by the contract | Needed to answer verification requests and defend conclusions | LEG + FDR |
| Backups of the Assurance Store | Same as the store, rolling. Destroyed with the store | A restore must not resurrect deleted data | LEG + SEC |
| Host operator logs | **1 year** | Incident investigation | SEC |
| Delivered package copy | Same as the store | Re-delivery on request | FDR |

All values are placeholders, pending legal advice on limitation periods and
on the customer's jurisdiction.

## 11. Deletion and customer offboarding

- [T] **No per-record or per-customer delete exists.** The Assurance Store has
  no general update or delete API (`assurance-store.ts`), and release custody
  is append-only by trigger. That is deliberate, for integrity.
- [P] Therefore deletion is **destruction of the customer's dedicated store
  file and every backup of it**, at the end of the agreed retention, plus
  rotation of all of that Host's credentials. It is recorded in a deletion
  certificate (draft I).
- [P] Consequence, disclosed to the customer: after deletion, **verification
  against custody is no longer possible.** Packages then verify only offline
  (integrity, not authenticity). Draft H says so.
- [GAP] A per-customer export or purge tool. Backlog R-08 (it may stay a
  process if one Host per customer is approved).

## 12. Incident handling

- [P] Incidents covered: suspected disclosure of customer evidence or reports;
  credential exposure; receipt of disallowed data; a custody integrity alarm
  (`AUTHORITY_UNAVAILABLE` with `ASSURANCE_INTEGRITY_FAILED`); a `RELEASE_MISMATCH`
  for a circulating package.
- [P] Steps: contain (stop the Host or revoke credentials), preserve logs,
  assess, notify the customer within a contractually agreed time, and notify
  regulators where the law requires it (legal review). Then a post-incident
  review.
- [T] Detection aids: authoritative release verification states; operator
  audit lines; REL-01A §18 failure-response table.
- Link to the generic pilot procedure: `docs/pilot/INCIDENT_TRIAGE.md`.
  Assurance-specific steps are in `OPERATOR_RUNBOOK.md` §16.

## 13. Backup and restore

- [T] `npm run backup:v1` includes `stores/assurance.sqlite`, copied with the
  SQLite online backup API, with a manifest and table counts
  (`AOC_ENTERPRISE_BACKUP_V1.md`). `npm run restore:v1` restores it.
- [T] **Restoring an older backup loses releases made after it.** They then
  read `RELEASE_NOT_IN_CUSTODY` and become re-releasable (REL-01A §12).
- [P] Take a `--cold` backup **immediately after every release** and before
  any upgrade. Encrypt backups. Store them separately from the Host.
- [P] A restore drill before the first customer engagement (G-OPS gate).
- [GAP] Backups are not encrypted by the tool. Encryption must be added by
  the operator.

## 14. Subprocessors and third-party services

- [P] Inventory to complete before launch (decision D-05): hosting provider,
  password manager, the artifact repository (§8), email and file transfer
  used for delivery, and any AI tooling used by operators.
- [P] **Rule: no customer evidence or report content goes into AI assistants
  or third-party tools** that are not on the approved subprocessor list.
- [T] The Host makes no outbound call for Assurance.

## 15. Cross-border data considerations

- [P] Determine the customer's jurisdiction and data-residency requirements
  at scoping. Choose the Host and backup location to match. Use
  transfer mechanisms where required. **Requires legal review.** No position
  is taken here.

## 16. Customer access to reports

- [T] No customer portal or self-service retrieval exists (REL-01D out of
  scope). There is no public report route.
- [P] Delivery: the archive, sent over an agreed encrypted channel to the
  named customer contact. The release digest is confirmed over a **second,
  independent channel** (draft H).

## 17. Verification of delivered records

- [T] Offline: `scripts/assurance/verify-commercial-package.mjs` checks
  integrity and consistency. It reports external authenticity as **NOT
  DEMONSTRATED**.
- [T] Authoritative: `POST /api/assurance/commercial-releases/verify` against
  the issuer's custody (`RELEASE_MATCHES_AUTHORITY`, …).
- [P] The customer cannot call the Host. Republika performs authoritative
  verification on request and answers in writing.

## 18. Human review and approval

- [T] Every control is concluded by an authenticated human reviewer. Release
  requires a different credential holding `assure.report-release`, both
  acknowledgements, and the exact content digest (REL-01D §4–§5).
- [P] Different **people** for review and approval (`OPERATOR_ROLES.md`).
- [P] The approver re-reads scope, exclusions and limitations against the SOW
  and checks declared text for customer-confidential terms
  (`AOC_ASSURANCE_COMMERCIAL_REPORT.md` §10).

## Summary of gaps

| Gap | Severity for a paid engagement | Treatment |
| --- | --- | --- |
| Evidence artifact storage undefined | High | Process decision D-05; optional tooling |
| No encryption at rest (store, backups) | High | Encrypted volume and encrypted backups (process) |
| No per-customer deletion | Medium | One Host per customer + store destruction (process); R-08 |
| Reviewer IDs not validated against emails or names | ~~Medium~~ Low | Closed by ASSURE-OPS-01 except well-formed names (process) |
| Retention values unapproved | High | D-04 |
| Subprocessor inventory absent | High | D-05 |
| Legal basis and cross-border position absent | High | LEG review |
