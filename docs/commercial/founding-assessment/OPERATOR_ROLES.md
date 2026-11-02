# Founding Assessment — Operator Roles and Separation of Duties

> **STATUS: DRAFT (ASSURE-REL-01E).** The settings below are **proposed
> private-pilot settings**. They do not authorize changing any live
> environment. No role is filled and no person is named.

## 1. Proposed private-pilot Host settings

| Setting | Proposed value | Effect (implemented, REL-01D §8) |
| --- | --- | --- |
| `AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY` | `true` | Every Assurance write over HTTP requires a reviewer credential. Organization keys, unscoped keys and the system context are refused on writes, finding events, signals and reassessment |
| `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS` | `rn.sv@0.1.0` | Registers the exact frozen framework. An unknown entry refuses boot |
| `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` | `sqlite` | Required for release (durable custody). Otherwise `503 ASSURANCE_STORE_UNAVAILABLE` |
| `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | a path on an encrypted volume | Assurance Store location (default `.data/assurance.sqlite`) |
| `AOC_ENTERPRISE_REQUIRE_AUTH` | `true` | Authentication on the Host API |
| `AOC_ENTERPRISE_HTTP_HOST` | `127.0.0.1`, or a private address behind TLS | REL-01D §9: never the public internet |
| `assuranceReviewers` in the governed-action file | one entry per person (§3) | `{ reviewerId, roles, apiKeyEnv }`. Secret in the named variable |

## 2. Roles

| Role (process) | Responsibility | Technical capability required | Implemented mapping |
| --- | --- | --- | --- |
| **Assessment preparer** | Scoping, SOW, creating the assessment, drafting the report | `assure.reviewer` to create; either role to draft | `POST /api/assurance/assessments` (R); `POST …/{id}/commercial-report/draft` (R or A) |
| **Evidence collector** | Receives evidence per draft C, checks authorization and minimization, submits references | `assure.reviewer` | `POST …/{id}/evidence` (R). **Who submitted is recorded only in the operator log, not in the stored assessment** (REL-01D §10) |
| **Reviewer** | Concludes each control from bound evidence. Ends contradicted attempts | `assure.reviewer` (the control's required role) | `POST /api/assurance/manual-reviews`, `POST …/{id}/evaluate`, `POST …/{id}/terminate` (R) |
| **Release approver** | Independently reads the draft against the SOW and approves the exact content digest | `assure.report-release`, and **no** review recorded on that assessment | `POST …/{id}/commercial-report/release` (A; refused with `separation_of_duties` if the credential reviewed) |
| **Custody administrator** | Host configuration, credential issuance and rotation, backups, restore, store destruction, authoritative verification on request | OS access to the Host; **no Assurance role needed for backup**; a read-capable credential for verification | `npm run check:host-configuration`, `npm run backup:v1`, `npm run restore:v1`; `POST /api/assurance/commercial-releases/verify` (R or A) |
| **Customer contact** (customer side) | Signs authorization, supplies evidence, receives the package, verifies it | **None. No credential is ever issued to a customer** | No customer route exists |

R = reviewer credential with `assure.reviewer`; A = with `assure.report-release`
(REL-01D §3).

## 3. Separation-of-duties rules

**Mandatory (proposed):**

1. **Reviewer ≠ release approver, as people.** The person who records any
   manual review on an assessment never approves its release.
2. **One credential per person.** Never issue two credentials to the same
   person. Never share a credential.
3. **No dual-role credential** for a Founding Assessment Host. Holding both
   roles grants nothing extra (REL-01D §5), but it makes the people check
   harder to audit.
4. **The custody administrator is not the release approver** for the same
   engagement. That keeps the person who can write the store file (REL-01A
   A10) apart from the person who attests the release.
5. **Minimum staffing for a release:** two named people. Preferred: three
   (reviewer, approver, custody administrator).

**What the code enforces vs what it does not:**

| Property | Enforced? | Where |
| --- | --- | --- |
| Approver credential recorded no review of the assessment | **Yes** | `releaseCommercialReport`; refuses with `403 ASSURANCE_REVIEWER_UNAUTHORIZED`, `reason: separation_of_duties` |
| Identity and roles come from the credential, never from the body | **Yes** | SEC-01B, REL-01D §2 |
| Duplicate secrets across credentials | **Yes**, refuses boot | Host configuration |
| Reviewer and approver are **different people** | **No.** Credentials are distinguished, not people | Process (§4) |
| Custody administrator is not the approver | **No** | Process |
| Reviewer IDs are not emails, phone numbers, markup or paths | **Yes** (ASSURE-OPS-01) | Host loader and every authenticator; well-formed names remain process |
| A revoked approver's past releases | Reported as `approverCurrentlyAuthorized: false`, never rewritten | REL-01A §15 |

## 4. Process control against one person holding several credentials

The technical limit: a person holding two credentials defeats the service's
check. The proposed process control:

1. **Credential register** (kept by the custody administrator, reviewed by the
   founder): for each `reviewerId`, the person it is issued to, the role, the
   issue date, the engagement, the secret's custody location, and the
   rotation or revocation date. Store it outside the Host.
2. **Issuance:** the founder approves each issuance in writing. The custody
   administrator generates the secret and transfers it to the holder over an
   approved channel. The holder confirms receipt, and that they hold no other
   credential on that Host.
3. **Pre-release attestation:** before release, the approver signs a one-line
   statement that they recorded no review of the assessment and hold no other
   credential on the Host. The custody administrator cross-checks the register
   against the release record's `approvedBy` and the reviewers listed in the
   assessment.
4. **Post-release audit:** the founder (or an external reviewer, decision
   D-02) checks the register against `GET …/{id}/commercial-releases` and the
   operator log, for each release.
5. **Rotation:** at engagement end, and immediately on any role change,
   departure or suspected exposure. Rotation is a configuration change plus a
   restart.

## 5. Authentication must not be weakened

- Do not disable `AOC_ENTERPRISE_REQUIRE_AUTH` or reviewer-only mode for
  convenience.
- Do not add CORS to the operator routes (REL-01D §7).
- Do not expose the Host publicly to make customer delivery easier.
- Do not use the organization API key for Assurance writes.

## 6. Known technical limits accepted only by explicit decision

| Limit | Decision |
| --- | --- |
| Static bearer secrets, no MFA or passkey for release approval | D-03 |
| No rate limiting on the Host API | D-03 (private network only) |
| Evidence submitter attributed only in the log | D-03; backlog R-07 |
