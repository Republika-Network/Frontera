# ASSURE Commercial GO / NO-GO — Founding Assessment Launch Gate

> **FINAL COMMERCIAL DECISION: NO-GO.**
>
> **STATUS: DRAFT (ASSURE-REL-01E; technical rows updated by ASSURE-OPS-01).**
> This gate was set on baseline `5012246c`, 2026-11-01. ASSURE-OPS-01 closed
> technical gaps R-02, R-04 and R-05 only. It changes only through §4. A technical
> PASS never produces a commercial GO. Tests passing are not authorization.

## 1. Rules

- Each gate is **PASS**, **CONDITIONAL** (usable only under the stated
  conditions, each of which needs an approval) or **BLOCKED**.
- Each gate has concrete evidence, an owner role and an approval or corrective
  action.
- **GO requires:** every gate PASS, or CONDITIONAL with its conditions
  approved in writing; **and** the six mandatory approvals in §3 recorded.
  Anything else is NO-GO.
- Owner roles: **FDR** founder or accountable executive · **SEC** security
  lead · **OPS** custody administrator / operations · **GOV** framework
  governance owner · **LEG** qualified legal and privacy counsel · **ENG**
  engineering. No role is assigned to a person yet. That is itself a
  blocker (G-OPS, G-CUST).

## 2. Gates

### G-TECH — Technical readiness (current code and tests)

**Status: CONDITIONAL**

| Item | Evidence | Result |
| --- | --- | --- |
| Synthetic end-to-end over HTTP on the production-posture Host, restart, independent verification | `assure-rel-01d-host-pilot.test.ts` P01 | PASS |
| Reviewer-only authorization, forged identities, tenant boundary, request hygiene, log and error leakage | `assure-rel-01d-operator-interface.test.ts` (O13 reviewer-only, #8 forged principals, planted-marker leakage) | PASS |
| Separation of duties (per credential) | `assure-rel-01d-operator-interface.test.ts` separation-of-duties cases | PASS — credentials only |
| Concurrency (compare-and-set) | `assure-rel-01d-concurrency.test.ts` | PASS |
| Commercial report generation, disclosure deny-by-default | `assurance-rep-01-commercial-report.test.ts` | PASS |
| Custody, replay, conflict, restart, migration | `assure-rel-01a-durable-release.test.ts` R01–R25 | PASS |
| Framework identity | `assurance-rn-sv-framework.test.ts` golden digest | PASS |
| Historical report compatibility | REL-01C C13, REP-01 historical v1 example | PASS |
| Independent package verifier on a synthetic package | This mission: verdict `PASS (…); external authenticity NOT DEMONSTRATED` | PASS — authenticity not demonstrated |
| SEC-01A/C/E, REL-01B, verification suites | This mission: 114/114 | PASS |
| External authenticity of releases (B7) | No signature or timestamp; A10 pinned as known limitation | **OPEN** |
| Supported package export for real assessments | ASSURE-OPS-01: `GET /api/assurance/commercial-releases/{reportId}/package` from custody v2, verified before return; `materialize-commercial-package.mjs`; Host pilot exports, restarts, re-exports byte-identically and passes the independent verifier (`assure-ops-01-customer-export.test.ts`, `assure-rel-01d-host-pilot.test.ts`) | **CLOSED (R-05)**. Releases kept before ASSURE-OPS-01 are not exportable (by design) |
| Reviews refused after completion | ASSURE-OPS-01: refused at service and store (atomic with the insert); race on two connections tested (`assure-ops-01-terminal-review.test.ts`) | **CLOSED (R-02)** |
| Reviewer-ID format (no emails) | ASSURE-OPS-01: safe-reference policy at Host loader and every authenticator; unsafe historical ids withheld in new reports (`assure-ops-01-reviewer-privacy.test.ts`) | **CLOSED (R-04)**. Names in well-formed tokens remain procedural |

Remaining conditions for G-TECH: acceptance of B7 (no signature), A10
(issuer-controlled custody) and static bearer credentials under M2/D-03, or
R-01/R-03 first. Owner: SEC (acceptance), ENG (R-01, R-03).

### G-OPS — Operational readiness

**Status: BLOCKED**

| Item | Evidence | Result |
| --- | --- | --- |
| Host configuration contract and preflight | `npm run check:host-configuration`; REL-01D §8 | Implemented |
| Named operators (reviewer, approver, custody admin) | None assigned | **BLOCKED** |
| Credential register and issuance procedure | Draft only (`OPERATOR_ROLES.md` §4) | **BLOCKED** until adopted |
| Dedicated private Host with encrypted volume | Not provisioned (and must not be, in this mission) | **BLOCKED** |
| Backup after every release, restore drill | Tooling implemented (`backup:v1`, `restore:v1`); no Assurance drill performed | **BLOCKED** until drilled |
| Incident process | Draft only (`OPERATOR_RUNBOOK.md` §16) | **BLOCKED** until adopted |

Owner: OPS. Approval: FDR adopts the runbook and roles; SEC witnesses a
synthetic restore drill.

### G-INFO — Information governance

**Status: BLOCKED**

| Item | Evidence | Result |
| --- | --- | --- |
| Consent and authority to provide evidence | Draft E only | BLOCKED |
| Evidence artifact storage location | Undefined (`CUSTOMER_DATA_GOVERNANCE.md` §8) | BLOCKED |
| Retention periods | Proposed values only (§10) | BLOCKED (D-04) |
| Deletion | Process only; no per-customer purge (§11) | CONDITIONAL on one Host per customer |
| Encryption at rest | Not provided by the store or the backup tool | BLOCKED until a process is adopted |
| Subprocessor inventory, cross-border position | Absent | BLOCKED (D-05) |
| Report disclosure, log hygiene, tenant isolation | Implemented and tested | PASS |

Owner: LEG + OPS. Approval: LEG reviews and FDR approves the data-governance
policy and the addendum (draft D).

### G-LEGAL — Legal / contractual readiness

**Status: BLOCKED**

| Item | Evidence | Result |
| --- | --- | --- |
| SOW, confidentiality addendum, authorization to assess, non-certification notice | Drafts B, D, E, G only, unreviewed | BLOCKED |
| Liability cap, indemnities, governing law, tax treatment | Placeholders | BLOCKED |
| Insurance (professional indemnity) | Not assessed | BLOCKED |
| Entity that contracts and invoices | Not stated | BLOCKED |

Owner: LEG. Approval: LEG sign-off on each document; FDR execution authority.

### G-FRAMEWORK — Commercial framework authorization

**Status: BLOCKED**

| Item | Evidence | Result |
| --- | --- | --- |
| `rn.sv@0.1.0` `commercialUse` | `restricted` (frozen; golden digest) | BLOCKED |
| Blocker technical closure | 8 of 9 VERIFIED; **B7 OPEN** (`FRAMEWORK_RESTRICTION_DISPOSITION.md`) | Not sufficient on its own |
| Policy acceptance of residuals B1, B3, B7 | None | BLOCKED |
| "Controlled external review" required by the restriction | No external reviewer identified | BLOCKED (D-02) |
| Governed framework version for paid use | Recommended `rn.sv@0.2.0`; not created | BLOCKED (D-01, R-06) |

Owner: GOV + FDR. Approval: a written framework authorization decision
naming the version, the accepted residuals and the conditions.

### G-CUST — Customer readiness

**Status: BLOCKED**

| Item | Evidence | Result |
| --- | --- | --- |
| Scoped pilot customer | None identified | BLOCKED |
| Authorized evidence | None | BLOCKED |
| Named customer contact and sponsor | None | BLOCKED |
| Pricing decision | Worksheet only (draft J) | BLOCKED (D-06) |

Owner: FDR. Approval: a signed SOW and authorization for a named customer.

## 3. Mandatory approvals for GO

| # | Approval | By | Recorded where | Status |
| --- | --- | --- | --- | --- |
| M1 | Framework authorization for a named version (expected `rn.sv@0.2.0`), with accepted residuals | GOV + FDR | Governance record, referenced by the new framework's `commercialUse` | **Missing** |
| M2 | Acceptance of security residuals (static credentials, no signature, credential ≠ person) for a private pilot | SEC + FDR | This repository, PR updating this gate | **Missing** |
| M3 | Data-governance policy, retention values, subprocessors, storage location | LEG + FDR | Approved `CUSTOMER_DATA_GOVERNANCE.md` | **Missing** |
| M4 | Legal review of drafts B, D, E, G, H, I | LEG | Counsel's written sign-off | **Missing** |
| M5 | Operators named, credential register adopted, restore drill witnessed | FDR + SEC + OPS | Credential register (off-repo) + drill record | **Missing** |
| M6 | Pricing and the founding-customer engagement | FDR | Signed SOW | **Missing** |

## 4. How the decision changes

1. Each approval is a **written, dated, attributable** record by the role
   holder. It is not a chat message, not a merged PR by its author alone, not
   a passing CI run.
2. A PR updates this file: it changes the gate statuses, cites each approval
   record by ID, and is approved by FDR **and** by a second role holder.
3. GO is stated only in a dedicated line, *"FINAL COMMERCIAL DECISION: GO for
   <framework version>, <customer>, from <date>"*. It is scoped to one
   framework version and one founding engagement. Any later engagement
   re-runs G-CUST.
4. No automation, test or script may change this decision.

## 5. Scorecard

| Gate | Status | Owner | Next action |
| --- | --- | --- | --- |
| G-TECH | CONDITIONAL | ENG / SEC | R-02, R-04, R-05 closed (ASSURE-OPS-01); accept B7/A10/static credentials under M2, or R-01/R-03 |
| G-OPS | BLOCKED | OPS | Name operators; adopt the register; synthetic restore drill |
| G-INFO | BLOCKED | LEG / OPS | Approve the policy; decide storage, retention, subprocessors |
| G-LEGAL | BLOCKED | LEG | Professional review of drafts |
| G-FRAMEWORK | BLOCKED | GOV / FDR | D-01, D-02; then mission R-06 |
| G-CUST | BLOCKED | FDR | Identify a founding customer; D-06 |
| **Final** | **NO-GO** | FDR | — |
